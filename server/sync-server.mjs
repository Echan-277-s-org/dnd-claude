// ─── LAN sync server (Phase B) ────────────────────────────────────────────────
// A dumb persistence relay for cross-device handoff over the home LAN. It stores
// each session as a `.md` file (the same self-contained, LLM-loadable format the
// app saves) by reusing the ONE serialize layer in src/lib/session.js — so the
// server's store is itself a folder of resumable handoffs, no second format.
//
// Implements all 6 MUST-FIX from docs/design/CROSS-DEVICE-SYNC-EVALUATION.md §2:
//   M1 stable id (the client sends campaign.sessionId as :id — never a name slug)
//   M2 campaign travels in the payload (handled by the serialize layer)
//   M3 CORS + OPTIONS preflight
//   M4 path-traversal guard on :id
//   M5 atomic writes (temp+rename) + per-session lock + server-stamped savedAt
//   M6 is a client concern (persist per turn) — see useSessionPersistence.js
//
// Phase 1 multiplayer additions (MULTIPLAYER-ARCHITECTURE.md §2.1):
//   MC-1: createSyncServer now returns http.Server (not the express app).
//   D:   WS upgrade origin allowlist via WS_ALLOWED_ORIGINS env var.
//   F:   maxPayload 65536, try/catch on all WS handlers, socket+server error handlers.
//   J:   NAME_TAKEN guard per active connection.
//   B:   displayName sanitization.
//
// No auth / plain http: acceptable on a trusted LAN (backend-developer NICE tier).

import express from 'express'
import cors from 'cors'
import http from 'node:http'
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { toMarkdown, fromMarkdown, serializeSession, applyPartyUpdate, buildPlayersForPrompt, numCtxForModel } from '../src/lib/session.js'
import { getGenre } from '../src/lib/genres.js'
import { isActiveTurn } from '../src/lib/turnStateMachine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.resolve(__dirname, 'sessions')
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

// ─── Phase 3: server-side DM proxy constants (MULTIPLAYER-ARCHITECTURE.md §3) ──
// MC-8: bounded timeout on every Ollama fetch/stream so a hung model can't wedge
// a room in 'awaiting-dm' indefinitely (chaos EX-3C). 90s is generous for a slow
// local model on a LAN.
const OLLAMA_TIMEOUT_MS = 90_000
// Default model when campaign.model is absent or fails the allowlist (sec H).
const DEFAULT_MODEL = 'qwen2.5:14b'
// Model-name allowlist (sec H) — an arbitrary string could be used to probe/abuse
// the Ollama API. Mirrors the pattern called out in §3.2.
const MODEL_RE = /^[a-zA-Z0-9._:-]{1,64}$/
// Per-connection min interval between actions (sec G), to throttle spam queuing.
const ACTION_MIN_INTERVAL_MS = 500
// Allowlist for a dice token ('d4'..'d100') — guards the regex-fallback path in the
// dice handler so a forged payload.die can't be stored or reach the Ollama prompt (H1).
const DIE_RE = /^d\d{1,3}$/i

// ─── Phase 3: structured-block parser (server copy of Chat.jsx L18-42) ─────────
// The architecture sanctions a verbatim server copy of the small parser so the
// DM proxy applies party/check/verdict blocks identically to the client.
// NOTE: DM_BLOCK_TAGS is the LLM-owned tags (party/check/verdict/facts). The
// inbound sanitizer below uses the wider BLOCK_TAGS set (includes 'session').
const DM_BLOCK_TAGS = ['party', 'check', 'verdict', 'facts']
const DM_STRIP_RE = new RegExp('```(?:' + DM_BLOCK_TAGS.join('|') + ')[\\s\\S]*?```', 'g')

function stripStructuredBlocks(text) {
  return String(text ?? '').replace(DM_STRIP_RE, '').trimEnd()
}

// Parameterised extractor — returns parsed JSON or null (never throws).
function extractBlock(tag, text) {
  const re = new RegExp('```' + tag + '\\s*([\\s\\S]*?)```')
  const match = String(text ?? '').match(re)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim())
  } catch {
    return null // malformed JSON → ignore, keep last-known state
  }
}

// ─── Fix #3: facts accumulator helpers (Contract B) ──────────────────────────
// Mirror of the client-side helpers in Chat.jsx — kept in sync manually.
// Merge a new facts array into an existing list (keyed by `k`).
// Latest value wins; entries over the cap of 12 are evicted oldest-first.
const SERVER_FACTS_CAP = 20

function mergeFacts(existing, incoming) {
  if (!Array.isArray(incoming)) return existing
  const entries = [...existing]
  for (const item of incoming) {
    if (!item || typeof item.k !== 'string' || typeof item.v !== 'string') continue
    const k = item.k.trim()
    const v = item.v.trim()
    if (!k) continue
    const idx = entries.findIndex(e => e.k === k)
    if (idx !== -1) {
      entries[idx] = { k, v }
    } else {
      entries.push({ k, v })
    }
  }
  return entries.length > SERVER_FACTS_CAP ? entries.slice(entries.length - SERVER_FACTS_CAP) : entries
}

function factsDigestLine(facts) {
  if (!facts || facts.length === 0) return ''
  return 'Established facts: ' + facts.map(e => `${e.k}=${e.v}`).join('; ') + '.'
}

// ─── Fix #5: Anchor joined-PC names against DM confabulation ─────────────────
//
// Problem (measured, round 13 of 4p_main): the DM emitted a party block renaming
// the joined PC "Kael" to "Aelis" (PARTY_SHRINK event_flag). The confabulation
// mechanism is identical to the one that erased "Garret Ironhand's Forge of
// Embers" — the DM produces a plausible-sounding replacement without realising
// the name belongs to a real player.
//
// Root cause: applyPartyUpdate resolves identity by name-match (normalized
// lowercased string). When the DM renames "Kael" → "Aelis" the name-match
// finds NO existing entry, so a brand-new party row is generated (new UUID,
// resetting per-member identity) and the "Kael" row silently disappears.
// This breaks:
//   (a) immersion: the player sees their character renamed mid-session,
//   (b) ID stability (EX-2b): the name-match loses the existing UUID, and
//   (c) the spotlight tracker: "Kael" is gone from room.party and the fairness
//       guard can no longer route isActive back to that player.
//
// Fix: after applyPartyUpdate produces the new party array, validate it against
// the canonical joined-PC roster (ground truth = room.characters keys, which are
// the exact displayNames every player submitted at join time and which the server
// stores in sanitizeCharacter — never touched by the DM). For each joined PC name
// that is absent from the new party but was present in the old party at the same
// index, restore the canonical name on that position's row (keeping all other
// DM-emitted fields: hpPct, isActive, conditions, role).
//
// Canonical roster source — room.characters:
//   • Keyed by the exact displayName submitted at join (before normalization).
//   • Populated for every player who ever joined; not modifiable by the DM.
//   • More stable than room.clients (which drops entries on rejoin/cleanup).
//   • Covers disconnected-but-not-yet-rejoined players (their character persists).
//
// Rename-detection rule (same-membership, same-index, joined-PC disappears):
//   For each joined PC name missing from the new party:
//     1. Find its old index in the previous party (room.party before this turn).
//     2. If the new party has an entry at that same index whose name is NOT a
//        joined PC name — that entry is the confabulated rename placeholder.
//     3. Restore the canonical PC name on that entry; preserve all other DM fields.
//
// Invariants:
//   • N=1 / no joined roster: guard is a no-op — behavior byte-identical to today.
//   • Legitimate NPC/companion rows (name not in the joined roster) are untouched.
//   • Party membership count is unchanged (no entries added or removed).
//   • applyPartyUpdate's UUID-by-name-match already ran; after correction the
//     corrected name IS the canonical name so the ID assigned in the NEXT turn
//     will match correctly again (ID stability restored from this turn forward).
//   • Phase derivation (isActive → combat) and applySpotlightFairness both operate
//     on the already-corrected party.
//
/**
 * After applyPartyUpdate has run, correct any DM-confabulated renames of joined
 * PCs back to their canonical displayName.
 *
 * The function mutates `newParty` in place and returns it.  No-op when:
 *   - room.characters is empty (no joined roster → single-player / N=1).
 *   - No joined PC name is missing from newParty.
 *   - The same-index slot in newParty is also a joined PC name (legitimate swap).
 *
 * @param {Array}  newParty  — result of applyPartyUpdate(partyRaw, room.party)
 * @param {Array}  oldParty  — room.party BEFORE this turn (snapshot, not mutated)
 * @param {object} characters — room.characters (Map<displayName, character>)
 * @returns {Array} newParty (same reference, mutated in place)
 */
export function anchorJoinedPCNames(newParty, oldParty, characters) {
  // ── 0. Guard: no roster ⇒ single-player / unregistered room — no-op. ────────
  if (!characters || typeof characters !== 'object' || Array.isArray(characters)) return newParty
  if (!Array.isArray(newParty) || !Array.isArray(oldParty)) return newParty

  // Build the canonical joined-PC set (normalized key → original casing).
  const rosterEntries = Object.keys(characters)
  if (rosterEntries.length === 0) return newParty // no joined players → no-op

  const rosterLower = new Map()
  for (const name of rosterEntries) {
    rosterLower.set(name.trim().toLowerCase(), name.trim())
  }

  // ── 1. Find which joined PCs are missing from newParty. ──────────────────────
  const newPartyNamesLower = new Set(
    newParty.map(m => String(m?.name ?? '').trim().toLowerCase())
  )
  const missingPCs = [] // { canonicalName, normalizedKey, oldIndex }
  for (const [normalizedKey, canonicalName] of rosterLower) {
    if (newPartyNamesLower.has(normalizedKey)) continue // still present — fine
    // Missing PC: find its old index.
    const oldIndex = oldParty.findIndex(
      m => String(m?.name ?? '').trim().toLowerCase() === normalizedKey
    )
    if (oldIndex === -1) continue // wasn't in the old party either → not a rename
    missingPCs.push({ canonicalName, normalizedKey, oldIndex })
  }

  if (missingPCs.length === 0) return newParty // nothing missing → no-op

  // ── 2. For each missing PC, correct the same-index slot if it is a non-PC name.
  for (const { canonicalName, normalizedKey, oldIndex } of missingPCs) {
    // The confabulated entry would be at the same position in newParty.
    if (oldIndex >= newParty.length) continue // party shrank past this index — skip
    const slot = newParty[oldIndex]
    if (!slot) continue
    const slotNameLower = String(slot.name ?? '').trim().toLowerCase()
    // Only correct if the slot holds a name that is NOT a joined PC name.
    // If the slot is already a different joined PC, don't overwrite them.
    if (rosterLower.has(slotNameLower)) continue // legitimate same-slot PC — skip
    // Restore the canonical name; all other DM-emitted fields are kept as-is.
    newParty[oldIndex] = { ...slot, name: canonicalName }
    // Remove from the set so the phase/fairness guard sees the correct name.
    newPartyNamesLower.delete(slotNameLower)
    newPartyNamesLower.add(normalizedKey)
  }

  return newParty
}

// ─── Fix #4: Spotlight fairness / starvation guard ────────────────────────────
//
// Problem (measured): in a 4-player session the DM parked isActive on Lyra 37/78
// turns (47%); Bron had a max starvation gap of 50 turns and was locked out of
// combat-phase turns entirely. Root cause: the combat turn gate lets ONLY the
// isActive player act, so when the DM doesn't rotate isActive, three players are
// blocked indefinitely.
//
// Policy (deterministic, server-side):
//
//   K = SPOTLIGHT_MAX_STREAK = 3
//     Maximum number of consecutive DM turns a single player may hold isActive.
//     Rationale: 3 gives enough room for a multi-step combat sequence (3 DM
//     responses, e.g. attack → reaction → resolve) without locking others out.
//     At N=4, K=3 bounds the worst-case starvation gap at K*N = 12 turns —
//     well below the observed 50-turn gap.
//
//   Starvation threshold = K * max(party.length, 1)
//     If a joined player has not acted in this many consecutive DM turns they are
//     considered maximally starved.  Dynamic: scales with the live party size so
//     it is proportional for N=2 (threshold=6) through N=5 (threshold=15).
//
// Two-site implementation:
//
//   (a) Combat turn gate (~L474): before returning NOT_YOUR_TURN, check whether
//       the requesting player is maximally starved AND has a joined connection.
//       If so, allow the action to proceed — the starvation overrides the lock.
//       Normal case (non-starved, non-active player): returns NOT_YOUR_TURN as
//       before. Single-player: N=1, threshold=3, gap never exceeds 3 in practice.
//
//   (b) Party-apply region (~L816): after applyPartyUpdate (which applies the DM's
//       party block), call applySpotlightFairness(room, actingPlayerName).
//       That function:
//         1. Records the acting player's turn participation in room.spotlight.
//         2. Checks whether the new isActive player has exceeded K consecutive turns.
//         3. If monopolization detected AND at least one joined player is more starved,
//            rotate room.party's isActive to the most-starved joined player.
//       When N=1 or the guard does not trigger, party state is unchanged (no-op).
//
// Broadcast / wire shape: the corrected room.party is sent in the existing
// session:update broadcast (no new fields, no wire changes). STRESS_METRICS-
// unset payloads remain byte-identical to pre-change when the guard does not
// fire (no monopolization, normal balanced play).

export const SPOTLIGHT_MAX_STREAK = 3

/**
 * Return the normalized (lowercased, trimmed) display names of all joined
 * players who currently have an OPEN connection in `room`.
 *
 * @param {object} room
 * @returns {Set<string>}
 */
function joinedPlayerNamesLower(room) {
  const names = new Set()
  for (const [ws, info] of room.clients) {
    if (ws.readyState === ws.OPEN && info.displayName) {
      names.add(info.displayName.trim().toLowerCase())
    }
  }
  return names
}

/**
 * Return the display name (original casing) of the current isActive party member,
 * or null when no member is active.
 *
 * @param {Array} party
 * @returns {string|null}
 */
function activePartyMemberName(party) {
  if (!Array.isArray(party)) return null
  return party.find(m => m.isActive)?.name ?? null
}

/**
 * Apply the spotlight fairness guard after the DM's party block has been applied.
 *
 * Updates room.spotlight and room.activePlayerStreak, and may rotate isActive in
 * room.party to a more-starved joined player when monopolization is detected.
 *
 * No-op when:
 *   - N=1 (single player, no rotation candidates).
 *   - Balanced play (streak ≤ K and no player is maximally starved by the current active).
 *   - No joined player is more-starved than the current active player.
 *
 * @param {object} room          — mutated in place (room.party, room.spotlight,
 *                                 room.activePlayerStreak)
 * @param {string|null} actingPlayerName  — displayName of the player whose action
 *                                          just triggered the DM (may be null)
 */
export function applySpotlightFairness(room, actingPlayerName) {
  const currentSeq = room.turnSequence ?? 0
  const joined = joinedPlayerNamesLower(room)
  const partySize = Math.max(1, room.party?.length ?? 0)

  // ── 1. Record the acting player's participation. ──────────────────────────
  if (actingPlayerName) {
    const key = actingPlayerName.trim().toLowerCase()
    if (!room.spotlight) room.spotlight = new Map()
    const entry = room.spotlight.get(key) ?? { turnCount: 0, lastActedTurnSeq: 0 }
    entry.turnCount += 1
    entry.lastActedTurnSeq = currentSeq
    room.spotlight.set(key, entry)
  }

  // ── 2. Identify the current isActive member and update the streak. ────────
  const activeName = activePartyMemberName(room.party ?? [])
  if (!activeName) {
    // No active player → free-roam; reset streak.
    if (room.activePlayerStreak) room.activePlayerStreak = { name: null, count: 0 }
    return
  }

  const activeKey = activeName.trim().toLowerCase()
  if (!room.activePlayerStreak) room.activePlayerStreak = { name: null, count: 0 }

  if (room.activePlayerStreak.name === activeKey) {
    room.activePlayerStreak.count += 1
  } else {
    room.activePlayerStreak = { name: activeKey, count: 1 }
  }

  // ── 3. Check for monopolization (streak > K). ─────────────────────────────
  // Only rotate when N > 1 (guard is a no-op for single-player rooms).
  if (joined.size <= 1) return

  const thresholdGap = SPOTLIGHT_MAX_STREAK * partySize
  const streakExceeded = room.activePlayerStreak.count > SPOTLIGHT_MAX_STREAK

  if (!streakExceeded) {
    // No monopolization — check whether any joined player is maximally starved
    // by the CURRENT active player holding focus.  If not, nothing to do.
    // We still do the starvation rotation check to handle cases where the DM
    // emits the same active player but a different party member has been starved
    // past the threshold by the active streak not yet crossing K+1.
    const someoneMaximallyStarved = Array.from(joined).some(nameKey => {
      if (nameKey === activeKey) return false
      const entry = room.spotlight?.get(nameKey)
      const gap = currentSeq - (entry?.lastActedTurnSeq ?? 0)
      return gap > thresholdGap
    })
    if (!someoneMaximallyStarved) return
  }

  // ── 4. Find the most-starved joined player (excluding the current active). ─
  let mostStarvedName = null
  let maxGap = -1

  for (const nameKey of joined) {
    if (nameKey === activeKey) continue
    const entry = room.spotlight?.get(nameKey)
    const gap = currentSeq - (entry?.lastActedTurnSeq ?? 0)
    if (gap > maxGap) {
      maxGap = gap
      mostStarvedName = nameKey
    }
  }

  if (!mostStarvedName) return

  // ── 5. Rotate isActive to the most-starved joined player. ─────────────────
  // Find the party member whose name matches the most-starved key (case-insensitive).
  // If no party member matches that name, fall back: set no one isActive (free-roam).
  const targetEntry = room.party.find(
    m => String(m.name ?? '').trim().toLowerCase() === mostStarvedName
  )

  room.party = room.party.map(m => ({
    ...m,
    isActive: targetEntry
      ? String(m.name ?? '').trim().toLowerCase() === mostStarvedName
      : false,
  }))

  // Reset streak to 1 for the newly spotlit player (they just became active).
  room.activePlayerStreak = { name: mostStarvedName, count: 1 }
}

/**
 * Return true when `playerName` (the displayName of an action sender) is maximally
 * starved and should be allowed to bypass the combat turn gate.
 *
 * Conditions:
 *   - The player has a joined (OPEN) connection in the room.
 *   - Their starvation gap (currentTurnSeq − lastActedTurnSeq) exceeds the
 *     dynamic threshold (K * partySize).
 *   - The room has more than one joined player (single-player is always unaffected).
 *
 * @param {string} playerName
 * @param {object} room
 * @returns {boolean}
 */
export function isMaximallyStarved(playerName, room) {
  if (!playerName) return false
  const joined = joinedPlayerNamesLower(room)
  if (joined.size <= 1) return false // single-player: guard is a no-op

  const key = playerName.trim().toLowerCase()
  if (!joined.has(key)) return false // not currently joined

  const partySize = Math.max(1, room.party?.length ?? 0)
  const thresholdGap = SPOTLIGHT_MAX_STREAK * partySize
  const currentSeq = room.turnSequence ?? 0
  const entry = room.spotlight?.get(key)
  const gap = currentSeq - (entry?.lastActedTurnSeq ?? 0)
  return gap > thresholdGap
}

// Resolve the Ollama base URL from the SERVER environment ONLY (sec H). Never
// derived from any client field. Accepts a bare host[:port] or a full URL.
function ollamaBaseUrl() {
  const env = process.env.OLLAMA_HOST
  if (!env) return 'http://localhost:11434'
  return env.includes('://') ? env : `http://${env}`
}

// ─── Origin allowlist for WS upgrades (security item D) ───────────────────────
// Configured via WS_ALLOWED_ORIGINS (comma-split). An empty/absent Origin header
// is always allowed (test harness + non-browser LAN clients).
function buildAllowedOrigins() {
  const env = process.env.WS_ALLOWED_ORIGINS
  if (env && env.trim()) {
    return env.split(',').map(s => s.trim()).filter(Boolean)
  }
  return ['http://localhost:5173']
}

// ─── displayName sanitization (security item B) ───────────────────────────────
// CHANGE 2a: After sanitizing, reject names that are reserved JS prototype keys.
// A player named '__proto__' would cause room.characters['__proto__'] = … to
// reassign Object.prototype instead of adding an own property — the entry would
// silently vanish from snapshots and re-run on every rejoin. Returning '' causes
// the join handler to reject with 'invalid_name'.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function sanitizeDisplayName(s) {
  const sanitized = String(s ?? '')
    .trim()
    .replace(/[<>&"']/g, '')
    // Strip Unicode control characters (category Cc)
    .replace(/\p{Cc}/gu, '')
    .slice(0, 64)
  // Reject reserved prototype-polluting identifiers (case-insensitive).
  if (RESERVED_KEYS.has(sanitized.toLowerCase())) return ''
  return sanitized
}

// ─── Character sanitization (Phase 1 — security item for join handler) ────────
// Mirrors sanitizeDisplayName / sanitizeActionContent: strip dangerous chars,
// enforce field-level bounds, allowlist only the named fields.
// null/undefined → DEFAULT_CHARACTER (server-side safe default).
// This function is defined at module scope (not inside createSyncServer) so it
// can be unit-tested by importing directly from the module.

// Server-side default for a SyncedCharacter (synced-subset fields only; mirrors
// the client DEFAULT_CHARACTER in src/App.jsx but excludes hpCurrent/initiative/
// speed/conditions — those are mutable and ride the party rows).
export const DEFAULT_CHARACTER = {
  name: 'Adventurer',
  race: 'Human',
  charClass: 'Fighter',
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  ac: 15,
  hpMax: 20,
}

// Strip [<>&"'] and Unicode control chars from a string; cap to maxLen.
function sanitizeStr(s, maxLen) {
  return String(s ?? '')
    .trim()
    .replace(/[<>&"']/g, '')
    .replace(/\p{Cc}/gu, '')
    .slice(0, maxLen)
}

// Clamp an integer to [lo, hi]. NaN / non-finite → fallback.
// Numeric values outside [lo, hi] are clamped to the nearest bound, so e.g.
// STR:999 → 20 and STR:1 → 3. Only NaN/non-numeric → fallback.
function clampInt(v, lo, hi, fallback) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

// Range-check an integer; NaN / non-finite / out-of-range → fallback.
// Unlike clampInt, values outside [lo, hi] return the fallback rather than
// being clamped to the nearest bound. Used for AC and hpMax per the spec.
function rangeInt(v, lo, hi, fallback) {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n < lo || n > hi) return fallback
  return n
}

export function sanitizeCharacter(raw) {
  if (raw == null) return { ...DEFAULT_CHARACTER }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_CHARACTER }

  const rawAb = raw.abilities && typeof raw.abilities === 'object' ? raw.abilities : {}

  return {
    // String fields: strip injection chars, cap lengths.
    name:      sanitizeStr(raw.name,      64) || DEFAULT_CHARACTER.name,
    race:      sanitizeStr(raw.race,      32) || DEFAULT_CHARACTER.race,
    charClass: sanitizeStr(raw.charClass, 32) || DEFAULT_CHARACTER.charClass,
    // Ability scores: integers in [3, 20]; NaN/out-of-range → 10.
    abilities: {
      STR: clampInt(rawAb.STR, 3, 20, 10),
      DEX: clampInt(rawAb.DEX, 3, 20, 10),
      CON: clampInt(rawAb.CON, 3, 20, 10),
      INT: clampInt(rawAb.INT, 3, 20, 10),
      WIS: clampInt(rawAb.WIS, 3, 20, 10),
      CHA: clampInt(rawAb.CHA, 3, 20, 10),
    },
    // AC: integer in [5, 30]; else 10 (out-of-range → fallback, not clamp).
    ac:    rangeInt(raw.ac,    5,   30,  10),
    // hpMax: integer in [1, 999]; else 10 (out-of-range → fallback, not clamp).
    hpMax: rangeInt(raw.hpMax, 1,  999,  10),
    // hpCurrent: when supplied (optional field for mutable state), clamp to [0, hpMax].
    // Phase 1 defines it here for completeness per spec; Phase 2 (websocket-engineer)
    // wires it into the join handler.
    ...(raw.hpCurrent !== undefined ? {
      hpCurrent: clampInt(
        raw.hpCurrent,
        0,
        rangeInt(raw.hpMax, 1, 999, 10),
        0
      )
    } : {}),
    // ALLOWLIST: any keys not in the above list are silently dropped.
  }
}

export function createSyncServer({ sessionsDir = DEFAULT_DIR, roomGcMs = 30 * 60 * 1000 } = {}) {
  // M4 — resolve a path-safe filename for an id, or null if it escapes the dir.
  function sessionPath(id) {
    if (!ID_RE.test(String(id ?? ''))) return null
    const p = path.resolve(sessionsDir, `${id}.md`)
    if (path.dirname(p) !== path.resolve(sessionsDir)) return null
    return p
  }

  async function readStored(id) {
    const p = sessionPath(id)
    if (!p) return null
    try {
      // Single async read (no existsSync TOCTOU, no event-loop block in the
      // /sessions loop): ENOENT → missing; any other read/parse error → missing.
      return fromMarkdown(await readFile(p, 'utf8'))
    } catch {
      return null // missing / corrupt / unreadable → treat as missing
    }
  }

  // M5 — serialize writes per id so two concurrent PUTs can't both pass the
  // staleness check and clobber (TOCTOU). Each id has a tail promise we chain on.
  const locks = new Map()
  function withLock(id, fn) {
    const prev = locks.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const guarded = next.catch(() => {})
    locks.set(id, guarded)
    // Drop the entry once this tail settles IF nothing newer chained on after us,
    // so the Map can't grow unbounded over long uptime (many distinct ids).
    guarded.then(() => {
      if (locks.get(id) === guarded) locks.delete(id)
    })
    return next
  }

  const app = express()
  app.use(cors({ origin: true })) // M3 — reflect origin + answer OPTIONS preflight
  app.use(express.json({ limit: '12mb' }))

  // Slugs + savedAt for a future "continue session" picker.
  app.get('/sessions', async (_req, res) => {
    try {
      const files = await readdir(sessionsDir)
      const out = []
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const p = await readStored(f.slice(0, -3))
        if (p) out.push({ sessionId: p.sessionId, name: p.campaign?.name ?? '', savedAt: p.savedAt })
      }
      res.json(out)
    } catch {
      res.json([])
    }
  })

  app.get('/session/:id', async (req, res) => {
    const id = req.params.id
    if (!sessionPath(id)) return res.status(400).json({ error: 'invalid id' })
    const stored = await readStored(id)
    if (!stored) return res.status(404).json({ error: 'not found' })
    // ?since=<ISO> — skip shipping the full history when unchanged (perf).
    if (req.query.since && stored.savedAt === req.query.since) return res.status(304).end()
    res.json(stored)
  })

  app.put('/session/:id', (req, res, next) => {
    const id = req.params.id
    if (!sessionPath(id)) return res.status(400).json({ error: 'invalid id' })
    const body = req.body
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid body' })

    return withLock(id, async () => {
      const stored = await readStored(id)
      // Staleness (LWW): the client must base its write on the stored savedAt.
      // A mismatch means someone else wrote since → 409, no clobber (M5).
      if (stored?.savedAt && body.savedAt !== stored.savedAt) {
        res.status(409).json({ savedAt: stored.savedAt })
        return
      }
      const savedAt = new Date().toISOString() // server-stamped (clock-skew safe)
      // CHANGE 1 (M1): sanitize every character in the PUT body through sanitizeCharacter
      // so the HTTP PUT path enforces the same bounds as the WS join path (strip injection
      // chars, cap string lengths, clamp abilities, range-check ac/hpMax).
      // Skip reserved prototype keys (__proto__/constructor/prototype) to prevent pollution.
      // When body.characters is absent, pass undefined so serializeSession/pickCharacters
      // yields {} as before (no fabrication).
      let sanitizedCharacters
      if (body.characters != null && typeof body.characters === 'object' && !Array.isArray(body.characters)) {
        sanitizedCharacters = {}
        for (const [key, val] of Object.entries(body.characters)) {
          if (RESERVED_KEYS.has(String(key).toLowerCase())) continue
          sanitizedCharacters[key] = sanitizeCharacter(val)
        }
      }
      // undefined when body.characters absent → serializeSession/pickCharacters produces {}

      const payload = serializeSession(
        {
          // sessionId is taken from the path (already validated), never trusted from body.
          campaign: { ...(body.campaign ?? {}), sessionId: id },
          messages: body.messages,
          sessionLog: body.sessionLog,
          party: body.party,
          // MC-3: carry v2 fields from the body so HTTP PUT does not silently strip them.
          // serializeSession coerces transient phases to resting on write (MC-4) and
          // defaults any absent field to safe values, so v1-shaped bodies work unchanged.
          roomCode: body.roomCode ?? null,
          phase: body.phase,
          turnSequence: body.turnSequence,
          // M1: forward sanitized v3 characters map.
          characters: sanitizedCharacters,
        },
        savedAt
      )
      const p = sessionPath(id)
      const tmp = `${p}.${randomUUID()}.tmp`
      await writeFile(tmp, toMarkdown(payload), 'utf8')
      await rename(tmp, p) // atomic swap — a crash never leaves a half-written file
      res.json({ savedAt })
    }).catch(next)
  })

  // handleNewSession server-clear (SHOULD-FIX, cheap to include).
  app.delete('/session/:id', (req, res, next) => {
    const id = req.params.id
    const p = sessionPath(id)
    if (!p) return res.status(400).json({ error: 'invalid id' })
    return withLock(id, async () => {
      try {
        await unlink(p)
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err // already gone is success; other errors bubble
      }
      res.status(204).end()
    }).catch(next)
  })

  // Error middleware last — bad JSON from express.json(), write failures, etc.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return
    const bad = err?.type === 'entity.parse.failed' || err?.status === 400
    res.status(bad ? 400 : 500).json({ error: bad ? 'invalid JSON' : 'server error' })
  })

  // ─── MC-1: wrap in http.Server so WS can share the same port ────────────────
  const server = http.createServer(app)

  // ─── Phase 1 & 2: WebSocket /ws endpoint ─────────────────────────────────────
  // Per-room in-memory state (keyed by sessionId — never roomCode, per sec item I).
  // { sessionId, roomCode, clients: Map<ws, {displayName, partyId, connectedAt}>,
  //   phase: 'free-roam', turnSequence: 0, messages: [], party: [],
  //   actionQueue: Promise }  ← Phase 2: per-room serialization queue
  const rooms = new Map()

  // ─── Phase 2: per-room action queue (withLock pattern) ───────────────────────
  // Appends fn to the tail of the room's Promise chain so concurrent actions
  // execute strictly in order. Mirrors the HTTP PUT withLock pattern.
  function withRoomLock(room, fn) {
    const prev = room.actionQueue ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const guarded = next.catch(() => {})
    room.actionQueue = guarded
    return next
  }

  // ─── Phase 2: sanitize/cap action content (security item A) ──────────────────
  const BLOCK_TAGS = ['party', 'check', 'verdict', 'session']
  const STRIP_RE = new RegExp('```(?:' + BLOCK_TAGS.join('|') + ')[\\s\\S]*?```', 'g')
  function sanitizeActionContent(content) {
    return String(content ?? '').replace(STRIP_RE, '').trim().slice(0, 4096)
  }

  // ─── Phase 3: persist the room to its .md handoff (atomic temp+rename) ───────
  // serializeSession carries v2 fields and phase-sanitizes (transient → resting).
  async function persistRoom(room) {
    const p = sessionPath(room.sessionId)
    if (!p) return
    const savedAt = new Date().toISOString()
    const payload = serializeSession(
      {
        campaign: { ...(room.campaign ?? {}), sessionId: room.sessionId },
        messages: room.messages ?? [],
        sessionLog: room.sessionLog ?? [],
        party: room.party ?? [],
        roomCode: room.roomCode,
        phase: room.phase,
        turnSequence: room.turnSequence,
        characters: room.characters ?? {},
      },
      savedAt
    )
    const tmp = `${p}.${randomUUID()}.tmp`
    await writeFile(tmp, toMarkdown(payload), 'utf8')
    await rename(tmp, p) // atomic swap — a crash never leaves a half-written file
    return savedAt
  }

  // Parse a `die → result` pair out of a dice action's content if not given
  // structurally. Matches the `[Dice roll: d20 → 17]` shape AND a bare `d20 → 17`.
  function parseDiceContent(content) {
    const m = String(content ?? '').match(/(d\d+)\s*(?:→|->)\s*(\d+)/i)
    if (!m) return null
    return { die: m[1].toLowerCase(), result: Number(m[2]) }
  }

  // ─── Phase 3: real server-side DM trigger (replaces the Phase 2 echo) ────────
  async function handleAction(ws, msg) {
    // Track whether THIS invocation acquired the connection's in-flight flag so the
    // finally only releases what it took (a rejected DM_BUSY action must NOT clear
    // the flag of the in-progress action on the same connection).
    let acquiredConn = null
    try {
      const { roomCode, payload } = msg ?? {}
      const content = sanitizeActionContent(payload?.content)

      // Look up the room by scanning for this ws in all rooms.
      let room = null
      for (const [, r] of rooms) {
        if (r.clients.has(ws)) { room = r; break }
      }
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'not_in_room' } }))
        return
      }

      // Validate roomCode matches the found room.
      if (room.roomCode !== roomCode && room.sessionId !== roomCode) {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'invalid_room' } }))
        return
      }

      // Reject empty content.
      if (!content) {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'empty_action' } }))
        return
      }

      const conn = room.clients.get(ws)

      // ── (0) Phase 5: combat turn enforcement (MULTIPLAYER-ARCHITECTURE.md §4.4) ──
      // If the room is in combat, only the connection-bound active player may act.
      // Connection-bound displayName from room.clients.get(ws) — never from payload
      // (security item C: per-message displayName is ignored for authorization).
      // This check fires BEFORE the DM_BUSY gate so a non-active player gets the
      // correct NOT_YOUR_TURN error (not DM_BUSY) even when the room is resting.
      if (room.phase === 'combat') {
        const connectionDisplayName = room.clients.get(ws)?.displayName ?? ''
        if (!isActiveTurn(connectionDisplayName, room.party ?? [])) {
          // Fix #4: starvation override — a maximally-starved joined player may act
          // even when not currently isActive. This breaks indefinite combat lockout
          // caused by the DM parking isActive on one player for > K * partySize turns.
          // Normal case (non-starved, non-active player): returns NOT_YOUR_TURN as
          // before.  Single-player (N=1): isMaximallyStarved always returns false, so
          // behaviour is unchanged.
          if (!isMaximallyStarved(connectionDisplayName, room)) {
            ws.send(JSON.stringify({ type: 'error', payload: { code: 'NOT_YOUR_TURN' } }))
            return
          }
          // Starved player is allowed through — the party-apply region will rotate
          // isActive toward them when the DM's response is processed.
        }
      }

      // ── (1) Per-connection rate limit + DM-busy gate (sec G) ──────────────────
      // Reject (do NOT enqueue) when: this connection already has an action in
      // flight, the room is mid-DM (awaiting-dm/resolving), or the connection is
      // firing faster than the min interval. The DM_BUSY signal goes to the SENDER
      // only; clients re-enable input on the next phase change to a resting phase.
      const now = Date.now()
      // room.dmBusy is a SYNCHRONOUS gate: it is set true here (before the async
      // withRoomLock enqueue) so two actions arriving in the same tick can't both
      // pass. room.phase flips to 'awaiting-dm' inside the lock and is the gate for
      // actions arriving after the phase broadcast; dmBusy covers the race window
      // between enqueue and the in-lock phase flip. Either being set → DM_BUSY.
      if (
        conn?.inFlight ||
        room.dmBusy === true ||
        room.phase === 'awaiting-dm' ||
        room.phase === 'resolving'
      ) {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'DM_BUSY' } }))
        return
      }
      if (conn && now - conn.lastActionAt < ACTION_MIN_INTERVAL_MS) {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'RATE_LIMITED' } }))
        return
      }
      room.dmBusy = true
      if (conn) {
        conn.inFlight = true
        conn.lastActionAt = now
        acquiredConn = conn
      }

      // Capture the pendingCheck travelling with this action (session-only, §3.6).
      const rawPending = payload?.pendingCheck
      const pendingCheck =
        rawPending?.skill && rawPending?.dc != null
          ? { skill: String(rawPending.skill).toUpperCase(), dc: Number(rawPending.dc) }
          : null
      const actionType = payload?.type === 'dice' ? 'dice' : 'user'

      // ── (3) Serialize within the room's action queue (structural single-trigger)
      await withRoomLock(room, async () => {
        // The resting phase to restore on error (free-roam or combat). Captured
        // BEFORE we flip to awaiting-dm (MC-8 / §3.5 step 3).
        const restingPhase =
          room.phase === 'combat' ? 'combat' : 'free-roam'

        let fullText = ''
        const assistantId = randomUUID()
        const abortController = new AbortController()
        const timeoutHandle = setTimeout(() => abortController.abort(), OLLAMA_TIMEOUT_MS)

        try {
          // (3a) Lock all clients: enter awaiting-dm and broadcast the phase.
          room.phase = 'awaiting-dm'
          broadcast(room, {
            type: 'session:update',
            roomCode: room.roomCode,
            payload: {
              messages: room.messages ?? [],
              party: room.party ?? [],
              phase: room.phase,
              turnSequence: room.turnSequence ?? 0,
              savedAt: new Date().toISOString(),
            },
          })

          // (3b) Build the stored message and record the server-side dice event when needed.
          // CHANGE 4: stamp senderName so every client (and .md reload) knows who spoke.
          // The field is set from the server-bound conn.displayName (never from payload).
          //
          // For a dice action: the STORED message is role:'dice' (not role:'user') so that
          // every client renders a DiceChip and the verdict block can resolve it.  The
          // parsed die/result are computed once and reused for both lastDiceEvent and the
          // stored message.  For a plain user action the stored message remains role:'user'.
          let storedMsg
          if (actionType === 'dice') {
            const parsed = parseDiceContent(payload?.content) ?? {
              die: payload?.die ?? null,
              result: payload?.result != null ? Number(payload.result) : null,
            }
            // H1: parseDiceContent already constrains the die token, but the regex-fallback
            // path trusts raw payload.die/result. Validate both against an allowlist before
            // they can be stored, broadcast, or interpolated into the Ollama prompt — an
            // unparsed die like '```party …' would otherwise inject prompt structure
            // (the same surface STRIP_RE closes on the content path). A non-dNN die / a
            // non-finite result is dropped to null (renders harmlessly, never injects).
            const die = DIE_RE.test(String(parsed.die ?? ''))
              ? String(parsed.die).toLowerCase()
              : null
            const result = Number.isFinite(Number(parsed.result)) ? Number(parsed.result) : null
            room.lastDiceEvent = {
              die,
              result,
              turnSequence: room.turnSequence ?? 0,
            }
            storedMsg = {
              role: 'dice',
              die,
              result,
              id: randomUUID(),
              senderName: conn?.displayName ?? null,
            }
          } else {
            storedMsg = {
              role: 'user',
              content,
              id: randomUUID(),
              senderName: conn?.displayName ?? null,
            }
          }
          // Keep a local alias for user messages so the existing Ollama-prompt code below
          // can refer to `userMsg` without needing to be restructured.
          const userMsg = actionType === 'dice' ? null : storedMsg

          // (3c) Assemble the prompt EXACTLY like Chat.jsx#sendMessage.
          const engine = getGenre(room.campaign?.genre).engine
          const systemPrompt = engine.buildSystemPrompt({
            ...(room.campaign ?? {}),
            players: buildPlayersForPrompt(room.characters ?? {}, room.party ?? []),
          })
          const baseMessages = room.messages ?? []
          const entities = engine.extractEntities(baseMessages)
          // Fix #3 (Contract B): inject facts digest immediately after the entities line.
          // ONLY when room.facts is non-empty — empty ⇒ systemContent byte-identical to today.
          const factsLine = factsDigestLine(room.facts ?? [])
          const systemContent = entities.length
            ? `${systemPrompt}\n\n---\nEstablished entities so far (stay consistent with these named NPCs, locations, and items): ${entities.join(', ')}.${factsLine ? '\n' + factsLine : ''}`
            : (factsLine ? `${systemPrompt}\n\n---\n${factsLine}` : systemPrompt)

          // Most-recent dice index so pendingCheck folds into the right dice line in the
          // historical baseMessages.  When the CURRENT action is itself a dice action, the
          // current roll is the intended pendingCheck target and is appended separately below,
          // so we suppress the historical fold (set to -1) to avoid double-applying
          // pendingCheck to a prior (already resolved/orphaned) dice message.
          const lastDiceIdx = actionType === 'dice' ? -1 : (() => {
            for (let i = baseMessages.length - 1; i >= 0; i--) {
              if (baseMessages[i].role === 'dice') return i
            }
            return -1
          })()

          // CHANGE 5: prefix user messages with the speaker name so the DM knows who is
          // speaking in multi-player sessions. Applied ONLY to the Ollama prompt, NOT to
          // the stored room.messages content (which must stay clean).
          //
          // INVARIANT: when NO message has a senderName (single-player-style room), the
          // assembled prompt is byte-identical to the pre-change shape. The prefix is
          // guarded on senderName presence so this always holds.
          // Dice-derived prompt lines ([Dice roll: …]) are never prefixed — they have no sender.
          const hasSender = !!conn?.displayName
          const prefixContent = (senderName, rawContent) =>
            senderName ? `${senderName}: ${rawContent}` : rawContent

          // Fix #1: scale the recent window with the room's player count so each
          // of N humans keeps roughly single-player history parity (Contract A §9).
          // Prefer the roster size (room.party); before the DM emits a party block
          // it can be empty, so fall back to the count of currently-OPEN connections
          // (room.clients keeps disconnected entries for presence history, so we
          // filter to OPEN to avoid over-counting). Defaults to 1 ⇒ N=1 invariant.
          const openClientCount = Array.from(room.clients.keys()).filter(
            ws => ws.readyState === ws.OPEN,
          ).length
          const playerCount = Math.max(1, room.party?.length || openClientCount || 1)

          // (3d) Validate the model against the allowlist (sec H).
          const model = MODEL_RE.test(String(room.campaign?.model ?? ''))
            ? room.campaign.model
            : DEFAULT_MODEL
          const numCtx = numCtxForModel(model)

          const apiMessages = engine.trimContext([
            ...baseMessages.map((m, i) => {
              if (m.role === 'dice') {
                // Historical dice messages: fold pendingCheck only at lastDiceIdx, which is
                // -1 for a dice action (the current roll is appended separately below and is
                // the real pendingCheck target). So this historical fold only ever fires for a
                // NON-dice (user) action whose turn references a prior dice line.
                const checkCtx =
                  i === lastDiceIdx && pendingCheck
                    ? ` | pending check: ${pendingCheck.skill} DC ${pendingCheck.dc}`
                    : ''
                return { role: 'user', content: `[Dice roll: ${m.die} → ${m.result}${checkCtx}]` }
              }
              // For historical user messages: prefix when they carry senderName.
              // Messages without senderName (legacy / single-player-origin) pass through unchanged.
              if (m.role === 'user' && m.senderName) {
                return { ...m, content: prefixContent(m.senderName, m.content) }
              }
              return m
            }),
            // Append the current action for Ollama.
            // Dice action: send as the canonical [Dice roll: dN → r] text line (with pendingCheck
            // fold applied to THIS roll).  The senderName-prefix is intentionally omitted for dice
            // lines (they have no speaker; the line format is its own attribution — CHANGE 5 invariant).
            // User action: prefix with the speaker name as before (CHANGE 5).
            actionType === 'dice'
              ? (() => {
                  const checkCtx = pendingCheck
                    ? ` | pending check: ${pendingCheck.skill} DC ${pendingCheck.dc}`
                    : ''
                  return { role: 'user', content: `[Dice roll: ${storedMsg.die} → ${storedMsg.result}${checkCtx}]` }
                })()
              : hasSender
                ? { ...userMsg, content: prefixContent(conn.displayName, content) }
                : userMsg,
          ], { playerCount, numCtx, systemContent })

          // (3e) Ollama URL from the SERVER env ONLY — never any client field.
          const base = ollamaBaseUrl()

          const response = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abortController.signal,
            body: JSON.stringify({
              model,
              stream: true,
              messages: [{ role: 'system', content: systemContent }, ...apiMessages],
              options: {
                num_ctx: numCtx,
                num_predict: 900,
                temperature: 0.8,
                top_p: 0.9,
                top_k: 40,
                repeat_penalty: 1.15,
                repeat_last_n: 256,
              },
            }),
          })

          if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw new Error(`Ollama ${response.status}: ${body}`)
          }

          // (3f) Read the NDJSON stream; fan out each delta as dm:delta.
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          const nextSeq = (room.turnSequence ?? 0) + 1

          // [STRESS_METRICS] Test-only instrumentation — captured only when
          // STRESS_METRICS=1. Zero impact on production broadcasts when unset.
          let _smEvalCount = 0, _smEvalDuration = 0, _smPromptEvalCount = 0, _smTotalDuration = 0

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.trim()) continue
              try {
                const event = JSON.parse(line)
                const delta = event.message?.content
                if (delta) {
                  fullText += delta
                  broadcast(room, {
                    type: 'dm:delta',
                    roomCode: room.roomCode,
                    payload: { delta, assistantId, turnSequence: nextSeq },
                  })
                }
                // [STRESS_METRICS] Capture Ollama performance fields from the
                // done:true line. Additive only; never changes the delta broadcasts.
                if (event.done && process.env.STRESS_METRICS === '1') {
                  _smEvalCount       = event.eval_count        ?? 0
                  _smEvalDuration    = event.eval_duration     ?? 0
                  _smPromptEvalCount = event.prompt_eval_count ?? 0
                  _smTotalDuration   = event.total_duration    ?? 0
                }
              } catch {
                // incomplete JSON chunk — skip (matches Chat.jsx)
              }
            }
          }

          // ── (4) Stream success: append the stored message (role:'dice' or role:'user'),
          // parse blocks, persist.  The verdict block below searches room.messages for the
          // most-recent unresolved role:'dice' message — for a dice action that is the one
          // we just appended here, so verdict resolution works in the same turn.
          room.messages = [...baseMessages, storedMsg]

          // verdict — discard a forged roll that doesn't match the server's record.
          // CHANGE 3 (L2): tighter forgery check with two invariants:
          //   (a) A verdict that carries a `roll` field but has NO corresponding
          //       server-recorded dice event (room.lastDiceEvent === null) is forged —
          //       there is nothing to validate it against, so it is always rejected.
          //   (a') A dice event recorded on an EARLIER turn (left uncleared because that
          //       turn produced no verdict) is stale: a verdict may only validate against
          //       a roll recorded in the CURRENT turn. lastDiceEvent.turnSequence is
          //       stamped (step 3b) with the pre-increment room.turnSequence, which still
          //       equals room.turnSequence here (the counter is bumped further below), so
          //       a current-turn roll matches and any prior-turn roll does not.
          //   (b) After verdict resolution (applied or rejected), clear lastDiceEvent
          //       so a later turn's verdict cannot reuse a stale dice-event record.
          //       Recording for the NEXT turn happens in step 3b (start of action),
          //       so clearing here at end-of-verdict is safe.
          const verdictRaw = extractBlock('verdict', fullText)
          if (verdictRaw?.result === 'PASS' || verdictRaw?.result === 'FAIL') {
            const forged =
              verdictRaw.roll != null && (
                // (a) No dice event recorded for this turn → always forged.
                !room.lastDiceEvent ||
                // (a') Dice event is from a prior turn (stale) → forged.
                room.lastDiceEvent.turnSequence !== (room.turnSequence ?? 0) ||
                // Original check: roll mismatch against the recorded dice result.
                verdictRaw.roll !== room.lastDiceEvent.result
              )
            if (!forged) {
              // Resolve the most-recent unresolved, non-orphaned dice message.
              const idx = [...room.messages]
                .map((m, i) => ({ m, i }))
                .reverse()
                .find(({ m }) => m.role === 'dice' && m.verdict == null && !m.orphaned)?.i
              if (idx != null) {
                room.messages = room.messages.map((m, i) =>
                  i === idx
                    ? { ...m, check: verdictRaw.skill, verdict: verdictRaw.result }
                    : m
                )
              }
            }
            // (b) Clear the dice event record after verdict resolution so it cannot be
            // reused by a subsequent turn's verdict. The next action will re-record if
            // a dice roll occurs (step 3b above).
            room.lastDiceEvent = null
          }

          // party — apply when present and non-empty.
          const partyRaw = extractBlock('party', fullText)
          if (Array.isArray(partyRaw) && partyRaw.length > 0) {
            // Snapshot the old party BEFORE applyPartyUpdate so anchorJoinedPCNames
            // can compare old vs new positions to detect same-slot renames.
            const partyBeforeUpdate = room.party ?? []
            room.party = applyPartyUpdate(partyRaw, partyBeforeUpdate)

            // Fix #5: anchor joined-PC names against DM confabulation.
            // Runs AFTER applyPartyUpdate (which resolves IDs by name-match) so the
            // raw DM block is already normalized, and BEFORE applySpotlightFairness
            // so the fairness guard operates on the already-corrected party.
            // No-op when room.characters is empty (N=1 / unregistered) — behavior
            // is byte-identical to pre-change for single-player sessions.
            anchorJoinedPCNames(room.party, partyBeforeUpdate, room.characters ?? {})
          }

          // Fix #4: apply spotlight fairness guard AFTER the DM's party block has
          // been absorbed (and Fix #5 has corrected any confabulated PC renames)
          // but BEFORE the phase is derived from the new isActive.
          // This may rotate room.party's isActive to a more-starved joined player
          // when monopolization is detected (streak > K).  No-op for N=1 or when
          // balanced play makes the guard not trigger.
          applySpotlightFairness(room, conn?.displayName ?? null)

          // facts — Fix #3 (Contract B): merge into room.facts accumulator.
          // Defensive: malformed / non-array / absent → keep last-known, no throw.
          const factsRaw = extractBlock('facts', fullText)
          if (Array.isArray(factsRaw)) {
            room.facts = mergeFacts(room.facts ?? [], factsRaw)
          }

          // Phase from the new party state (any isActive → combat, else free-roam).
          room.phase = (room.party ?? []).some(m => m.isActive) ? 'combat' : 'free-roam'

          // Append the assistant message (display text — structured blocks stripped).
          room.messages = [
            ...room.messages,
            { role: 'assistant', content: stripStructuredBlocks(fullText), id: assistantId },
          ]

          // Advance the turn counter (server is the only writer).
          room.turnSequence = (room.turnSequence ?? 0) + 1

          // Persist the .md handoff (atomic) before broadcasting done.
          const savedAt = await persistRoom(room)

          broadcast(room, {
            type: 'dm:done',
            roomCode: room.roomCode,
            // [STRESS_METRICS] When STRESS_METRICS=1, attach Ollama perf fields
            // captured from the done:true NDJSON line. When unset this spread is
            // an empty object, so the payload is byte-identical to production.
            payload: {
              fullText,
              turnSequence: room.turnSequence,
              ...(process.env.STRESS_METRICS === '1' ? {
                metrics: {
                  eval_count:        _smEvalCount,
                  eval_duration:     _smEvalDuration,
                  prompt_eval_count: _smPromptEvalCount,
                  total_duration:    _smTotalDuration,
                },
              } : {}),
            },
          })
          broadcast(room, {
            type: 'session:update',
            roomCode: room.roomCode,
            payload: {
              messages: room.messages,
              party: room.party ?? [],
              phase: room.phase,
              turnSequence: room.turnSequence,
              savedAt: savedAt ?? new Date().toISOString(),
              // [STRESS_METRICS] Optional heap proxy — additive, flag-gated.
              ...(process.env.STRESS_METRICS === '1' ? {
                heapUsedBytes: process.memoryUsage().heapUsed,
              } : {}),
            },
          })
        } catch (err) {
          // ── (5) Error/timeout: broadcast done{error}, reset phase, no turn bump,
          // no .md write. The queue lock releases when this async fn returns.
          // eslint-disable-next-line no-console
          console.error('[ws] DM trigger error:', err?.message ?? err)
          room.phase = restingPhase
          broadcast(room, {
            type: 'dm:done',
            roomCode: room.roomCode,
            payload: { error: true, partial: fullText },
          })
          broadcast(room, {
            type: 'session:update',
            roomCode: room.roomCode,
            payload: {
              messages: room.messages ?? [],
              party: room.party ?? [],
              phase: room.phase,
              turnSequence: room.turnSequence ?? 0,
              savedAt: new Date().toISOString(),
            },
          })
        } finally {
          clearTimeout(timeoutHandle)
          // Release the synchronous busy gate so the next queued/incoming action
          // can fire. (room.phase is already a resting phase at this point.)
          room.dmBusy = false
        }
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws] handleAction error:', err?.message ?? err)
    } finally {
      // Clear the in-flight flag ONLY if this invocation acquired it (i.e. it
      // actually ran the DM trigger). A rejected DM_BUSY/RATE_LIMITED action never
      // set acquiredConn, so it cannot clear the flag of the running action.
      if (acquiredConn) acquiredConn.inFlight = false
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })

  // Catch-all WS server errors (e.g. listen failures) — never let them crash the process.
  wss.on('error', err => {
    // eslint-disable-next-line no-console
    console.error('[wss] server error:', err?.message ?? err)
  })

  // Build the presence array for a room from its current clients map.
  // Phase 6: clients whose socket is not OPEN are shown as 'disconnected'
  // (their entry remains in the map so presence history is preserved until GC).
  function presenceList(room) {
    return Array.from(room.clients.entries()).map(([ws, c]) => ({
      displayName: c.displayName,
      status: ws.readyState === ws.OPEN ? 'connected' : 'disconnected',
    }))
  }

  // Broadcast a JSON message to every client in a room.
  function broadcast(room, msg) {
    const data = JSON.stringify(msg)
    for (const [ws] of room.clients) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(data)
      } catch {
        // best-effort — ignore send failures to individual clients
      }
    }
  }

  // ─── WS upgrade filter (security item D) ──────────────────────────────────
  server.on('upgrade', (req, socket, head) => {
    const allowed = buildAllowedOrigins()
    const origin = req.headers.origin ?? ''
    // Allow empty/absent Origin (test harness, curl, non-browser LAN clients)
    // and any explicitly listed origin.
    const originOk = origin === '' || allowed.some(o => origin === o)
    if (!originOk) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    if (req.url === '/ws') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    } else {
      // Unknown WS path — reject cleanly.
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    }
  })

  // ─── WS connection handler ─────────────────────────────────────────────────
  wss.on('connection', ws => {
    // Per-socket error handler — prevents one bad socket crashing the server.
    ws.on('error', err => {
      // eslint-disable-next-line no-console
      console.error('[ws] socket error:', err?.message ?? err)
    })

    ws.on('message', data => {
      // Wrap entire handler in try/catch so a malformed message never crashes.
      try {
        let msg
        try {
          msg = JSON.parse(data)
        } catch {
          ws.send(JSON.stringify({ type: 'error', payload: { code: 'bad_message' } }))
          return
        }

        const { type } = msg ?? {}

        // ─── type allowlist (security item F) ───────────────────────────────
        if (!['join', 'action', 'ping'].includes(type)) {
          // Unknown type — drop silently (don't send error; avoid info leakage).
          return
        }

        // ─── ping / pong ─────────────────────────────────────────────────────
        if (type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }

        // ─── join ─────────────────────────────────────────────────────────────
        if (type === 'join') {
          handleJoin(ws, msg)
          return
        }

        // ─── action (Phase 2: echo path; Phase 3 replaces with Ollama) ─────
        if (type === 'action') {
          handleAction(ws, msg)
          return
        }

      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ws] message handler error:', err?.message ?? err)
      }
    })

    ws.on('close', () => {
      try {
        handleClose(ws)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ws] close handler error:', err?.message ?? err)
      }
    })
  })

  // ─── join handler ──────────────────────────────────────────────────────────
  async function handleJoin(ws, msg) {
    try {
      const { roomCode, sessionId, displayName: rawDisplayName, lastTurnSequence, joinCharacter } = msg ?? {}

      // Validate roomCode (must also be a valid ID_RE string — it's the primary key
      // users type, but the .md store uses sessionId; both must pass ID_RE).
      if (!ID_RE.test(String(roomCode ?? ''))) {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { code: 'invalid_room', message: 'roomCode failed validation' },
        }))
        return
      }

      // Validate sessionId (the .md store key — must pass ID_RE).
      if (!ID_RE.test(String(sessionId ?? ''))) {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { code: 'invalid_room', message: 'sessionId failed validation' },
        }))
        return
      }

      // Sanitize + validate displayName (security item B).
      const displayName = sanitizeDisplayName(rawDisplayName)
      if (!displayName) {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { code: 'invalid_name', message: 'displayName must be non-empty after sanitization' },
        }))
        return
      }

      // Load any stored session up-front so a FIRST join hydrates the room from
      // the .md store (campaign + messages + party + phase + turnSequence). Phase 3
      // needs room.campaign for prompt assembly and room.sessionLog for the .md write.
      const stored = await readStored(sessionId)

      // Ensure room exists in-memory (keyed by sessionId per sec item I).
      if (!rooms.has(sessionId)) {
        rooms.set(sessionId, {
          sessionId,
          roomCode,
          clients: new Map(),
          phase: stored?.phase ?? 'free-roam',
          turnSequence: stored?.turnSequence ?? 0,
          messages: stored?.messages ?? [],   // Phase 2: in-memory message history
          party: stored?.party ?? [],          // Phase 2: in-memory party state
          // Phase 3: campaign + sessionLog needed for prompt assembly and .md write.
          // Default campaign to {} so getGenre(undefined) → dnd (Phase 3 step 6).
          campaign: stored?.campaign ?? {},
          sessionLog: stored?.sessionLog ?? [],
          // Phase 2 (mp-character-sync): per-player static character map.
          // Keyed by displayName; populated on join from joinCharacter. Restored
          // from .md on first join when stored?.characters is present.
          // CHANGE 2b: use a null-prototype object so assignment of a reserved key
          // (__proto__/constructor/prototype) is a plain own-property write, never
          // a prototype mutation. Spread into { ...room.characters } for snapshots
          // still serializes correctly (JSON.stringify handles null-proto objects).
          characters: Object.assign(
            Object.create(null),
            stored?.characters && typeof stored.characters === 'object'
              ? stored.characters
              : {}
          ),
          actionQueue: Promise.resolve(), // Phase 2: per-room serialization queue
          dmBusy: false,                   // Phase 3: synchronous single-trigger gate
          lastDiceEvent: null,             // Phase 3: forged-verdict.roll guard
          gcTimer: null,                   // Phase 6: orphaned-room GC timer
          facts: [],                       // Fix #3: accumulated numeric/transactional facts
          // Fix #4: spotlight fairness state.
          //   spotlight: Map<normalizedName, { turnCount, lastActedTurnSeq }>
          //   activePlayerStreak: { name: normalizedName|null, count: number }
          spotlight: new Map(),            // Fix #4: per-player turn participation tracker
          activePlayerStreak: { name: null, count: 0 }, // Fix #4: consecutive-active streak
        })
      }
      const room = rooms.get(sessionId)

      // Phase 6: any join (new or rejoin) cancels a pending orphaned-room GC.
      if (room.gcTimer != null) {
        clearTimeout(room.gcTimer)
        room.gcTimer = null
      }

      // Backfill campaign/sessionLog on a pre-existing room when the .md store has
      // them but the room (created by an earlier empty join) does not.
      if ((!room.campaign || Object.keys(room.campaign).length === 0) && stored?.campaign) {
        room.campaign = stored.campaign
      }
      if ((!room.sessionLog || room.sessionLog.length === 0) && stored?.sessionLog?.length) {
        room.sessionLog = stored.sessionLog
      }
      if (!room.campaign) room.campaign = {}
      if (!room.sessionLog) room.sessionLog = []

      // NAME_TAKEN: check if displayName (trimmed, lowercased) is already bound
      // to an OPEN connection in this room (security item J).
      // Phase 6 rejoin: a CLOSED socket with that name is NOT blocking — the slot
      // is vacant. Only an OPEN connection with the same name blocks.
      const normalizedName = displayName.trim().toLowerCase()
      for (const [existingWs, info] of room.clients) {
        if (
          info.displayName.trim().toLowerCase() === normalizedName &&
          existingWs.readyState === existingWs.OPEN &&
          existingWs !== ws
        ) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { code: 'NAME_TAKEN', message: 'A player with that name is already connected' },
          }))
          return
        }
      }

      // Phase 6 rejoin: if there is a CLOSED socket entry for this displayName,
      // remove it so the rejoining client's new socket takes over the slot cleanly.
      for (const [existingWs, info] of room.clients) {
        if (
          info.displayName.trim().toLowerCase() === normalizedName &&
          existingWs.readyState !== existingWs.OPEN &&
          existingWs !== ws
        ) {
          room.clients.delete(existingWs)
          break
        }
      }

      // (stored was loaded above, before room creation.)

      // ─── mp-character-sync: store joinCharacter for this player ───────────────
      // Rejoin path: if this displayName already has a stored character (from the
      // initial join or a prior session loaded from .md), preserve it — do NOT
      // overwrite with the reconnecting client's joinCharacter. The static character
      // is stable for the session.
      // New join path: sanitize joinCharacter (server-authoritative) and store it.
      const hasExistingCharacter = Object.prototype.hasOwnProperty.call(
        room.characters ?? {}, displayName
      )
      if (!hasExistingCharacter) {
        // sanitizeCharacter returns DEFAULT_CHARACTER for null/invalid input.
        room.characters[displayName] = sanitizeCharacter(joinCharacter ?? null)
      }
      // room.characters is now guaranteed to be initialized (set on room creation).
      // Use a null-prototype map for the fallback too, so a reserved key could never
      // pollute even if this defensive branch ever runs (consistency with creation).
      if (!room.characters) room.characters = Object.create(null)

      // Build the snapshot payload. Use stored data when available; fall back to
      // safe defaults so the first join creates an empty room without writing a .md.
      const snapshot = {
        messages: stored?.messages ?? [],
        party: stored?.party ?? [],
        phase: stored?.phase ?? 'free-roam',
        turnSequence: stored?.turnSequence ?? 0,
        roomCode,
        savedAt: stored?.savedAt ?? null,
        campaign: stored?.campaign ?? null,
        // Include the full characters map so late joiners learn everyone's sheet (G-C7).
        characters: { ...room.characters },
      }

      // Resolve partyId by name-match against the stored party array.
      const partyId = (() => {
        if (!stored?.party?.length) return null
        const match = stored.party.find(
          m => String(m?.name ?? '').trim().toLowerCase() === normalizedName
        )
        return match?.id ?? null
      })()

      // Bind this ws → connection info in the room's clients map.
      // Phase 3: inFlight (sec G — at most one in-flight action per connection) and
      // lastActionAt (min-interval throttle) live on the per-connection record.
      room.clients.set(ws, {
        displayName,
        partyId,
        connectedAt: new Date().toISOString(),
        inFlight: false,
        lastActionAt: 0,
      })

      // Update room's turnSequence/phase/messages/party from stored data if
      // this is the first join (or if stored is newer than in-memory).
      if (stored?.turnSequence != null && stored.turnSequence > room.turnSequence) {
        room.turnSequence = stored.turnSequence
        // Also restore messages/party from the stored .md when loading fresh.
        if (!room.messages?.length && stored.messages?.length) {
          room.messages = stored.messages
        }
        if (!room.party?.length && stored.party?.length) {
          room.party = stored.party
        }
      }
      if (stored?.phase) room.phase = stored.phase

      // Phase 2 reconnect: if joining client's lastTurnSequence is stale
      // (< room.turnSequence), always send a full session:state with current in-memory
      // state (which may be more up-to-date than the stored .md). This matches the
      // architecture §2.2 / §5.3 reconnect behavior.
      const inMemorySnapshot = {
        messages: room.messages ?? snapshot.messages,
        party: room.party ?? snapshot.party,
        phase: room.phase,
        turnSequence: room.turnSequence,
        roomCode,
        savedAt: snapshot.savedAt,
        campaign: snapshot.campaign,
        // Always use the current in-memory characters map (most up-to-date).
        characters: { ...room.characters },
      }
      const sendSnapshot = typeof lastTurnSequence === 'number' && lastTurnSequence < room.turnSequence
        ? inMemorySnapshot
        : snapshot

      // Send session:state to the joining client.
      ws.send(JSON.stringify({ type: 'session:state', roomCode, payload: sendSnapshot }))

      // G-C7: when a NEW player joins (not a rejoin), existing clients must learn
      // the joiner's character. Broadcast session:state with the updated characters
      // map to all OTHER connected clients so they are consistent.
      // The joiner already received their session:state above.
      if (!hasExistingCharacter) {
        const fullSnapshot = {
          ...inMemorySnapshot,
          characters: { ...room.characters },
        }
        const data = JSON.stringify({ type: 'session:state', roomCode, payload: fullSnapshot })
        for (const [clientWs] of room.clients) {
          if (clientWs !== ws && clientWs.readyState === clientWs.OPEN) {
            try { clientWs.send(data) } catch { /* best-effort */ }
          }
        }
      }

      // Broadcast presence:update to all clients in the room (including the new joiner).
      broadcast(room, {
        type: 'presence:update',
        payload: presenceList(room),
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws] handleJoin error:', err?.message ?? err)
    }
  }

  // ─── close handler ─────────────────────────────────────────────────────────
  // Phase 6: keep the CLOSED socket entry in room.clients so presenceList() can
  // show it as 'disconnected'. Broadcast the updated list to remaining OPEN clients.
  // If ALL sockets are now closed, schedule orphaned-room GC after roomGcMs.
  // The DM stream in progress (if any) is NOT affected — it runs inside withRoomLock
  // and will broadcast dm:done + session:update to whoever is still OPEN when it ends.
  function handleClose(ws) {
    for (const [, room] of rooms) {
      if (room.clients.has(ws)) {
        // Do NOT delete the entry — keep it as 'disconnected' for presence display
        // and for the NAME_TAKEN rejoin check (a CLOSED socket = vacant slot).

        // Broadcast updated presence (shows the departed player as 'disconnected').
        broadcast(room, {
          type: 'presence:update',
          payload: presenceList(room),
        })

        // If no OPEN connections remain, schedule orphaned-room GC.
        const hasOpenClients = Array.from(room.clients.keys()).some(
          cws => cws.readyState === cws.OPEN
        )
        if (!hasOpenClients && roomGcMs > 0) {
          // Cancel any already-pending timer first (shouldn't happen, but safe).
          if (room.gcTimer != null) clearTimeout(room.gcTimer)
          room.gcTimer = setTimeout(() => {
            // Only remove if no one rejoined in the meantime.
            const stillNoOpen = Array.from(room.clients.keys()).every(
              cws => cws.readyState !== cws.OPEN
            )
            if (stillNoOpen) {
              rooms.delete(room.sessionId)
            }
          }, roomGcMs)
        }

        break
      }
    }
  }

  return server
}

// Start only when run directly (not when imported by tests).
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const PORT = process.env.SYNC_PORT || 3001
  await mkdir(DEFAULT_DIR, { recursive: true })
  createSyncServer().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`dnd-claude sync server listening on http://0.0.0.0:${PORT}`)
  })
}
