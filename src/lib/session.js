// ─── session.js — one serialize layer, three surfaces ─────────────────────────
// The SAME payload shape feeds localStorage (Phase A), the .md file (Phase A2),
// and the LAN sync server (Phase B). Defined once here so the three surfaces
// can never drift. All functions are pure (no React) and defensive (never throw
// on bad input — return null / a safe default), mirroring the parser in Chat.jsx.
//
// Payload shape (schemaVersion 1):
//   { sessionId, schemaVersion, savedAt,
//     campaign: { name, genre, details, context, model, sessionId },
//     messages: [...], sessionLog: [...], party: [...] }
//
// Excluded by design: `entities` (re-derived via extractEntities — a pure
// function of messages) and `pendingCheck` (session-only; surfaced as a prose
// line by toMarkdown so an LLM still sees it, but never machine-restored in v1).

// Bumped to 3 for per-player character sync (Phase 1): adds `characters` map.
// v1/v2 payloads still load — deserializeSession backfills characters:{} — so the
// .md save/continue contract is preserved.
export const SCHEMA_VERSION = 3

// Phase enum. RESTING phases are the only values ever PERSISTED. The transient
// operational phases ('awaiting-dm' / 'resolving') live only in the sync server's
// in-memory room state; they are coerced to 'free-roam' on every serialize / .md
// write (MC-4). The READ path is lenient (accepts all four) and clamps anything
// else to 'free-roam'.
export const RESTING_PHASES = ['free-roam', 'combat']
const VALID_PHASES = ['free-roam', 'combat', 'awaiting-dm', 'resolving']

// WRITE-path coercion — only resting phases are ever serialized / written to .md.
function restingPhase(phase) {
  return RESTING_PHASES.includes(phase) ? phase : 'free-roam'
}
// READ-path coercion — accept any valid phase; clamp a truly-invalid string.
function readPhase(phase) {
  return VALID_PHASES.includes(phase) ? phase : 'free-roam'
}
// Coerce to a finite integer turn counter, defaulting to 0.
function readTurnSequence(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

// Derive a stable, human-readable room code from a sessionId (first 8 hex chars).
// e.g. 'a1b2c3d4-e5f6-…' → 'dnd-a1b2c3d4'. 1:1 with sessionId; a display alias only
// — the .md store and sessionPath() are ALWAYS keyed by the full sessionId (sec I).
export function makeRoomCode(sessionId) {
  return 'dnd-' + String(sessionId ?? '').replace(/-/g, '').slice(0, 8)
}

// Reconcile incoming LLM party data with existing IDs so React keys stay stable.
// Matches by normalized (lowercased/trimmed) name. New members get a UUID.
// Guards every field defensively; zero-member arrays must be rejected BEFORE calling.
// Moved here from Chat.jsx (Phase 0) so the client AND the server-side DM proxy
// share one implementation — no behavior change.
export function applyPartyUpdate(rawArray, existing) {
  const prev = Array.isArray(existing) ? existing : []
  return (Array.isArray(rawArray) ? rawArray : []).map(raw => {
    const normalizedName = String(raw?.name ?? '').trim().toLowerCase()
    const found = prev.find(
      e => String(e?.name ?? '').trim().toLowerCase() === normalizedName
    )

    // Normalize conditions: coerce to array, trim each entry, drop empties,
    // cap at 10 entries, cap each entry at 64 chars, default [].
    // Source: raw (DM-emitted) takes precedence over found (existing row).
    // When raw.conditions is absent/null/non-array, preserve found.conditions
    // (so a DM response that omits the field does not wipe active conditions).
    const rawConditions = raw?.conditions
    let conditions
    if (Array.isArray(rawConditions)) {
      conditions = rawConditions
        .map(c => String(c ?? '').trim().slice(0, 64))
        .filter(c => c.length > 0)
        .slice(0, 10)
    } else {
      // DM omitted conditions field — preserve whatever was there before
      conditions = Array.isArray(found?.conditions) ? found.conditions : []
    }

    return {
      id: found?.id ?? crypto.randomUUID(),
      name: String(raw?.name ?? '').trim() || 'Unknown',
      role: String(raw?.role ?? '').trim() || '',
      hpPct: Math.max(0, Math.min(100, Math.round(Number(raw?.hpPct) || 0))),
      isActive: Boolean(raw?.isActive),
      conditions,
    }
  })
}

// Campaign fields that travel with a session. Anything outside this list
// (e.g. transient UI flags) is intentionally dropped.
const CAMPAIGN_KEYS = ['name', 'genre', 'details', 'context', 'model', 'sessionId']

// ─── LAN host helper (DRY — replaces inline window.location.hostname) ─────────
// Used for both the Ollama host (Chat.jsx) and the sync server. Falls back to
// localhost when there is no window (tests / SSR).
export function getLanHost(port) {
  const host =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : 'localhost'
  return port != null ? `${host}:${port}` : host
}

function pickCampaign(campaign) {
  const c = campaign ?? {}
  const out = {}
  for (const k of CAMPAIGN_KEYS) {
    if (c[k] != null) out[k] = c[k]
  }
  return out
}

// ─── SyncedCharacter helpers ──────────────────────────────────────────────────
// The STATIC subset of a character that rides the `characters` map.
// Mutable state (hpCurrent / isActive / conditions) lives in the party rows.

// Normalize a raw SyncedCharacter object. Accepts any object; strips unknown
// keys; returns a well-typed SyncedCharacter or null if input is unusable.
// Never throws.
function normalizeSyncedCharacter(raw) {
  if (!raw || typeof raw !== 'object') return null
  const abilities = raw.abilities && typeof raw.abilities === 'object'
    ? {
        STR: Number(raw.abilities.STR) || 10,
        DEX: Number(raw.abilities.DEX) || 10,
        CON: Number(raw.abilities.CON) || 10,
        INT: Number(raw.abilities.INT) || 10,
        WIS: Number(raw.abilities.WIS) || 10,
        CHA: Number(raw.abilities.CHA) || 10,
      }
    : { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }
  return {
    name: String(raw.name ?? 'Adventurer'),
    race: String(raw.race ?? 'Human'),
    charClass: String(raw.charClass ?? 'Fighter'),
    abilities,
    ac: Number(raw.ac) || 10,
    hpMax: Number(raw.hpMax) || 10,
  }
}

// Reserved JS prototype keys. Assigning one of these as a property key on an
// ordinary object mutates the prototype chain instead of adding an own property.
// CHANGE 2c: pickCharacters skips these keys so a malicious .md/PUT body with a
// '__proto__' key cannot pollute Object.prototype. The output uses a null-prototype
// object for the same reason (JSON.stringify serializes it correctly).
const RESERVED_CHAR_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Normalize the characters map from a raw payload.
// Returns {} when absent/invalid; otherwise maps each entry through
// normalizeSyncedCharacter (dropping any entries that come back null).
function pickCharacters(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  // Null-prototype object: assignment of a reserved key is always a plain own-property.
  const out = Object.create(null)
  for (const [key, val] of Object.entries(raw)) {
    // Skip reserved prototype-polluting keys.
    if (RESERVED_CHAR_KEYS.has(String(key).toLowerCase())) continue
    const norm = normalizeSyncedCharacter(val)
    if (norm) out[key] = norm
  }
  return out
}

// ─── Character extractor (for the .md-import UI path) ────────────────────────
// Given a parsed payload (or raw markdown text) and an entered displayName,
// returns a SyncedCharacter with this precedence:
//   (1) characters[displayName] if present
//   (2) else the first characters entry
//   (3) else derive from the first party row (name/role→charClass, defaults)
// Returns null gracefully on malformed/blockless input — never throws.
export function extractCharacterFromPayload(input, displayName) {
  try {
    // Accept a markdown string or an already-parsed payload.
    const payload = typeof input === 'string' ? fromMarkdown(input) : (input ?? null)
    if (!payload || typeof payload !== 'object') return null

    const chars = payload.characters
    const hasChars = chars && typeof chars === 'object' && !Array.isArray(chars)

    // Precedence (1): exact displayName match.
    if (hasChars && displayName != null && chars[displayName]) {
      const c = normalizeSyncedCharacter(chars[displayName])
      if (c) return c
    }

    // Precedence (2): first characters entry.
    if (hasChars) {
      const entries = Object.values(chars)
      if (entries.length > 0) {
        const c = normalizeSyncedCharacter(entries[0])
        if (c) return c
      }
    }

    // Precedence (3): derive from first party row.
    const party = Array.isArray(payload.party) ? payload.party : []
    if (party.length > 0) {
      const row = party[0]
      return {
        name: String(row.name ?? 'Adventurer'),
        race: 'Human',
        charClass: String(row.role ?? 'Fighter'),
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        ac: 10,
        hpMax: 10,
      }
    }

    return null
  } catch {
    return null
  }
}

// ─── Single-character export (.md) ───────────────────────────────────────────
// Serialize ONE player character to a self-contained, LLM-loadable Markdown file
// that ROUND-TRIPS with extractCharacterFromPayload: it wraps the character in a
// minimal session payload (party row + characters map) and runs it through the
// canonical toMarkdown, so the resulting ```session block carries the character
// under `characters[<name>]`. Re-importing the file via the wizard's ".md" path
// (extractCharacterFromPayload → fromMarkdown → deserializeSession) recovers the
// SAME SyncedCharacter (precedence 1 by name, precedence 2 as the sole entry).
//
// Only the STATIC SyncedCharacter subset round-trips (name/race/charClass/
// abilities/ac/hpMax) — that is exactly the subset extractCharacterFromPayload
// returns and the wizard consumes. Live state (hpCurrent/conditions/initiative/
// speed) is intentionally not part of the import contract.
export function characterToMarkdown(character, opts = {}) {
  const synced = normalizeSyncedCharacter(character)
  const hpPct =
    character && Number(character.hpMax) > 0
      ? Math.max(0, Math.min(100, Math.round((Number(character.hpCurrent) / Number(character.hpMax)) * 100)))
      : 100
  const payload = {
    campaign: {
      name: opts.campaignName || `${synced.name} — Character`,
      genre: opts.genre || 'dnd',
    },
    // A single party row so a blockless-fallback reader still sees the character,
    // and so deriveRecap/partyTable render something sensible in the prose.
    party: [
      {
        id: 'export-0',
        name: synced.name,
        role: synced.charClass,
        hpPct,
        isActive: true,
        conditions: Array.isArray(character?.conditions) ? character.conditions : [],
      },
    ],
    // The authoritative round-trip carrier: keyed by the character's own name so
    // extractCharacterFromPayload's precedence-1 (displayName match) and
    // precedence-2 (first entry) both resolve to this character.
    characters: { [synced.name]: synced },
  }
  return toMarkdown(serializeSession(payload), null)
}

// Sanitize a character name into a safe download filename stem.
// e.g. "Tharivol Q'tar!" → "Tharivol-Qtar". Falls back to 'character'.
export function characterFileName(character) {
  const raw = String(character?.name ?? '').trim()
  const slug = raw
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return `${slug || 'character'}.md`
}

// ─── DM prompt player-summary helpers (Phase 4) ──────────────────────────────
// These are pure helpers shared by the client (Chat.jsx → context.js call site)
// and the server (sync-server.mjs → context.js call site, Phase 5). Exporting
// from session.js keeps them co-located with the characters-map data they consume.

// Format an ability-score modifier with explicit sign, matching the formula in
// CharacterPanel.jsx line 14–16.
export function fmtMod(score) {
  const mod = Math.floor((score - 10) / 2)
  return mod >= 0 ? `+${mod}` : `${mod}`
}

// Render the bounded "Player Characters:" section that gets injected into the
// system prompt. Enforces the hard contract from the refactor plan:
//   - Max 5 players (extra entries silently dropped via slice — by design)
//   - ALL players within the 1–5 range are ALWAYS included (never silently dropped)
//   - Total section (header + all player lines) <= 1000 characters
//   - A single pathologically long line is truncated at LINE_MAX chars, but the
//     player is never omitted entirely
// Budget rationale: worst-case 5 players × ~160 chars/line + 20-char header ≈ 820;
// 1000 gives ~180 chars of headroom for long names/conditions while remaining
// negligible in a system-prompt context (a few hundred extra tokens at most).
// Format per line: "name (Class Race): STR s(±m), DEX s(±m), … ; AC a, HP cur/max"
// Conditions appended when present, e.g. "  [Poisoned, Frightened]".
// Returns '' for empty/null players (so the byte-identical invariant holds).
export function buildPlayerSection(players) {
  if (!players?.length) return ''
  const capped = players.slice(0, 5)
  const HEADER = '\nPlayer Characters:\n'
  const BUDGET = 1000
  const LINE_MAX = 200 // guard against a single pathological line (e.g. 64-char name)

  const lines = capped.map(p => {
    const ab = p.abilities ?? {}
    const stats = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
      .map(k => `${k} ${ab[k] ?? 10}(${fmtMod(ab[k] ?? 10)})`)
      .join(', ')
    const conds = Array.isArray(p.conditions) && p.conditions.length > 0
      ? `  [${p.conditions.join(', ')}]`
      : ''
    const line = `${p.name} (${p.charClass} ${p.race}): ${stats}; AC ${p.ac ?? 10}, HP ${p.hpCurrent ?? p.hpMax ?? 10}/${p.hpMax ?? 10}${conds}`
    // Truncate an individual line that is absurdly long, but never drop the player.
    return line.length > LINE_MAX ? line.slice(0, LINE_MAX) : line
  })

  // All players within the 1–5 cap are always included. The section is naturally
  // bounded because each line is capped at LINE_MAX and there are at most 5 lines.
  return HEADER + lines.join('\n')
}

// Build a PlayerEntry[] from the characters map and current party array.
// Pure, defensive, never throws. Returns [] when characters is empty/absent.
// Match characters to party rows by normalized name (lowercased/trimmed) —
// the same normalization used by applyPartyUpdate.
// Sorting preserves DM-defined party-row order; unmapped characters append last.
export function buildPlayersForPrompt(characters, party) {
  if (!characters || typeof characters !== 'object' || Array.isArray(characters)) return []
  const entries = Object.entries(characters)
  if (entries.length === 0) return []

  const partyArr = Array.isArray(party) ? party : []

  // Build a lookup: normalized name → party row
  const rowByName = new Map()
  for (const row of partyArr) {
    const key = String(row?.name ?? '').trim().toLowerCase()
    if (key) rowByName.set(key, row)
  }

  // Build a PlayerEntry for each character, matched to their party row.
  // Defensively handles null/undefined char values.
  function makeEntry([, char]) {
    const safeChar = char && typeof char === 'object' ? char : {}
    const normalizedCharName = String(safeChar?.name ?? '').trim().toLowerCase()
    const row = rowByName.get(normalizedCharName) ?? null
    const hpMax = Number(safeChar?.hpMax) || 10
    const hpPct = row != null ? Math.max(0, Math.min(100, Number(row?.hpPct) || 0)) : 100
    return {
      name: safeChar.name ?? 'Adventurer',
      race: safeChar.race ?? 'Human',
      charClass: safeChar.charClass ?? 'Fighter',
      abilities: safeChar.abilities ?? { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
      ac: safeChar.ac ?? 10,
      hpMax,
      hpCurrent: Math.round(hpPct / 100 * hpMax),
      conditions: Array.isArray(row?.conditions) ? row.conditions : [],
    }
  }

  // Sort by party-row order first (characters with a matching row come in DM order),
  // then unmapped characters appended in their iteration order.
  const mapped = []
  const unmapped = []
  for (const entry of entries) {
    const [, char] = entry
    const key = String(char?.name ?? '').trim().toLowerCase()
    if (rowByName.has(key)) {
      mapped.push({ entry, rowIdx: partyArr.findIndex(r => String(r?.name ?? '').trim().toLowerCase() === key) })
    } else {
      unmapped.push(makeEntry(entry))
    }
  }
  mapped.sort((a, b) => a.rowIdx - b.rowIdx)
  return [...mapped.map(({ entry }) => makeEntry(entry)), ...unmapped]
}

// ─── serialize / deserialize — the canonical payload ──────────────────────────

// Build a payload from live app state. `savedAt` may be supplied (server-stamped)
// or defaults to now. `sessionId` comes from the campaign (minted at setup).
// v2 fields (roomCode / phase / turnSequence) may be supplied either inside
// `state` or via the third `opts` arg (opts wins). They are always carried in the
// output so the HTTP PUT path can't silently strip them (MC-3). `phase` is
// coerced to a resting phase on write (MC-4); transient phases never persist.
// v3 adds `characters: { [displayName]: SyncedCharacter }` (default {}).
export function serializeSession(state, savedAt, opts = {}) {
  const s = state ?? {}
  const o = opts ?? {}
  const { campaign, messages, sessionLog, party } = s
  return {
    sessionId: campaign?.sessionId ?? null,
    schemaVersion: SCHEMA_VERSION,
    savedAt: savedAt ?? new Date().toISOString(),
    campaign: pickCampaign(campaign),
    messages: Array.isArray(messages) ? messages : [],
    sessionLog: Array.isArray(sessionLog) ? sessionLog : [],
    party: Array.isArray(party) ? party : [],
    roomCode: o.roomCode ?? s.roomCode ?? null,
    phase: restingPhase(o.phase ?? s.phase),
    turnSequence: readTurnSequence(o.turnSequence ?? s.turnSequence),
    characters: pickCharacters(o.characters ?? s.characters),
  }
}

// Parse a stored payload (string or object) back into a normalized payload.
// Returns null on any failure or an incompatible schemaVersion — callers keep
// their last-known state (same contract as the structured-block parser).
// Accepts v1, v2, AND v3 payloads. v1/v2 backfill `characters: {}`. Any other
// version → null (unchanged contract). v1/v2 .md files therefore still load.
export function deserializeSession(raw) {
  if (raw == null) return null
  let obj
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  // Accept v1 / v2 / v3; v1 and v2 are auto-upgraded (backfill characters:{}).
  if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2 && obj.schemaVersion !== 3) return null
  return {
    sessionId: obj.sessionId ?? obj.campaign?.sessionId ?? null,
    schemaVersion: SCHEMA_VERSION,
    savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : null,
    campaign: pickCampaign(obj.campaign),
    messages: Array.isArray(obj.messages) ? obj.messages : [],
    sessionLog: Array.isArray(obj.sessionLog) ? obj.sessionLog : [],
    party: Array.isArray(obj.party) ? obj.party : [],
    roomCode: typeof obj.roomCode === 'string' ? obj.roomCode : null,
    phase: readPhase(obj.phase),
    turnSequence: readTurnSequence(obj.turnSequence),
    // v1/v2 payloads backfill to {}; v3 carries the map if present.
    characters: pickCharacters(obj.characters),
  }
}

// ─── Dice-chip hydration guard (H4) ──────────────────────────────────────────
// A saved session naturally ends on an unresolved roll. On restore that bare
// dice chip would be the verdict parser's "most-recent dice with verdict==null"
// target, so the NEXT turn's verdict block would stamp PASS/FAIL onto an old,
// unrelated roll (often scrolled off-screen — invisible corruption). Mark every
// restored bare dice message `orphaned` so the parser skips it; fresh in-session
// rolls have no flag and resolve normally. Pure, reused by both restore surfaces
// (Chat.jsx hydrate + useSessionPersistence adopt).
export function markOrphanedDice(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map(m =>
    m?.role === 'dice' && m.verdict == null ? { ...m, orphaned: true } : m
  )
}

// ─── Markdown (Phase A2) — self-contained, LLM-loadable handoff ───────────────

// A short slug for filenames (campaign name → kebab). Display/label only.
export function campaignToSessionId(name) {
  return (
    String(name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'session'
  )
}

// Suggested download filename for a save, e.g. "jaycen-hawke-2026-05-25.md".
export function sessionFileName(campaign, savedAt) {
  const date = (savedAt ?? new Date().toISOString()).slice(0, 10)
  return `${campaignToSessionId(campaign?.name)}-${date}.md`
}

// First 1–3 sentences of the latest GM line — the "where we are" recap.
function deriveRecap(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.content && !m.error) {
      const text = m.content.replace(/\s+/g, ' ').trim()
      const sentences = text.match(/[^.!?]+[.!?]+/g)
      const recap = sentences ? sentences.slice(0, 2).join(' ').trim() : text
      return recap.length > 400 ? recap.slice(0, 397) + '…' : recap
    }
  }
  return '_(No narration yet — the session is just beginning.)_'
}

function partyTable(party) {
  if (!party?.length) return '_(No party members tracked.)_'
  const rows = party.map(
    m =>
      `| ${m.name || '—'} | ${m.role || '—'} | ${m.hpPct == null ? '—' : m.hpPct + '%'} | ${m.isActive ? '▶' : ''} |`
  )
  return ['| Name | Role | HP | Turn |', '|------|------|----|------|', ...rows].join('\n')
}

function transcript(messages) {
  const lines = messages
    .map(m => {
      if (m.role === 'user') return `**You:** ${m.content}`
      if (m.role === 'assistant') {
        if (!m.content) return null
        return `**GM:** ${m.content}`
      }
      if (m.role === 'dice') {
        const base = `> 🎲 ${m.die} → ${m.result}`
        if (m.check && m.verdict) return `${base} · ${m.check} → **${m.verdict}**`
        return base
      }
      return null
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n\n') : '_(No messages yet.)_'
}

// Render a human-readable ```characters block for the prose section of the .md.
// One line per player. Returns an empty string when there are no characters.
function charactersSection(characters) {
  if (!characters || typeof characters !== 'object') return ''
  const entries = Object.entries(characters)
  if (entries.length === 0) return ''
  const lines = entries.map(([displayName, c]) => {
    const ab = c.abilities
      ? `STR ${c.abilities.STR} DEX ${c.abilities.DEX} CON ${c.abilities.CON} INT ${c.abilities.INT} WIS ${c.abilities.WIS} CHA ${c.abilities.CHA}`
      : 'no abilities'
    return `| ${displayName} | ${c.name || '—'} | ${c.race || '—'} | ${c.charClass || '—'} | ${ab} | AC ${c.ac ?? '—'} | HP max ${c.hpMax ?? '—'} |`
  })
  return [
    '\n## Player Characters',
    '| Player | Name | Race | Class | Abilities | AC | HP Max |',
    '|--------|------|------|-------|-----------|-------|--------|',
    ...lines,
  ].join('\n')
}

// Render a payload as a self-contained Markdown handoff. The prose is a complete
// DM brief; the trailing ```session fence is the lossless machine payload.
// `pendingCheck` (session-only) is accepted purely to surface it as a prose line.
// v3: carries `characters` in the authoritative session block AND emits an
// informational ```characters section in the prose for human readability.
export function toMarkdown(payload, pendingCheck) {
  const p = payload ?? {}
  const c = p.campaign ?? {}
  const chars = pickCharacters(p.characters)
  const meta = [
    `saved ${p.savedAt ?? new Date().toISOString()}`,
    `genre: ${c.genre ?? '—'}`,
    `model: ${c.model ?? '—'}`,
    `sessionId: ${p.sessionId ?? c.sessionId ?? '—'}`,
    `phase: ${restingPhase(p.phase)}`,
    `roomCode: ${p.roomCode ?? '—'}`,
  ].join(' · ')

  const notesRef = c.name
    ? ` Pair this with the campaign notes (\`campaigns/${campaignToSessionId(c.name)}.md\`).`
    : ''

  const pendingLine =
    pendingCheck?.skill && pendingCheck?.dc != null
      ? `\n**Pending check:** ${pendingCheck.skill} DC ${pendingCheck.dc}\n`
      : ''

  const block = JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      sessionId: p.sessionId ?? c.sessionId ?? null,
      savedAt: p.savedAt ?? new Date().toISOString(),
      campaign: pickCampaign(c),
      messages: p.messages ?? [],
      sessionLog: p.sessionLog ?? [],
      party: p.party ?? [],
      roomCode: p.roomCode ?? null,
      phase: restingPhase(p.phase),
      turnSequence: readTurnSequence(p.turnSequence),
      characters: chars,
    },
    null,
    2
  )

  const charSection = charactersSection(chars)

  return `# Session — ${c.name || 'Untitled Campaign'}
<!-- ${meta} -->

## Continue from here
You are the Game Master. Below is the story so far and the current state — pick up as DM from the last line.${notesRef}

## Where we are
${deriveRecap(p.messages ?? [])}

## Party
${partyTable(p.party ?? [])}
${pendingLine}
## Transcript
${transcript(p.messages ?? [])}
${charSection ? charSection + '\n' : ''}
\`\`\`session
${block}
\`\`\`
`
}

// Extract & parse the ```session block from a Markdown file. Returns a
// normalized payload (via deserializeSession) or null if the file has no valid
// block — letting "Load .md file" fall back to today's prose→context behavior.
export function fromMarkdown(text) {
  if (typeof text !== 'string') return null
  const match = text.match(/```session\s*([\s\S]*?)```/)
  if (!match) return null
  return deserializeSession(match[1].trim())
}

// ─── Sync API (Phase B) — talks to the LAN sync server ────────────────────────
// All network calls are wrapped so a down/unreachable server degrades gracefully
// (returns null / a status object) rather than throwing — the app stays usable
// on localStorage + .md alone.

const SYNC_PORT = 3001

function syncUrl(path) {
  return `http://${getLanHost(SYNC_PORT)}${path}`
}

const safeId = id => /^[A-Za-z0-9_-]{1,128}$/.test(String(id ?? ''))

// Fetch a session by id. Returns the payload, or null (404 / network error /
// invalid id). Pass `since` (ISO) to short-circuit when unchanged → returns
// { unchanged: true } so the poller can skip a redundant overwrite.
export async function loadSyncSession(id, since) {
  if (!safeId(id)) return null
  try {
    const qs = since ? `?since=${encodeURIComponent(since)}` : ''
    const res = await fetch(syncUrl(`/session/${id}${qs}`))
    if (res.status === 304) return { unchanged: true }
    if (!res.ok) return null
    return deserializeSession(await res.json())
  } catch {
    return null // server down — caller keeps local state
  }
}

// Push a payload. Returns { ok, savedAt } on success, { conflict: true,
// savedAt } on a 409 stale write, or { ok: false } on network error.
export async function saveSyncSession(payload) {
  const id = payload?.sessionId
  if (!safeId(id)) return { ok: false }
  try {
    const res = await fetch(syncUrl(`/session/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}))
      return { ok: false, conflict: true, savedAt: body.savedAt ?? null }
    }
    if (!res.ok) return { ok: false }
    const body = await res.json().catch(() => ({}))
    return { ok: true, savedAt: body.savedAt ?? null }
  } catch {
    return { ok: false }
  }
}

// Delete a session on the server (called when the user starts a new session, so
// another device's poll can't resurrect the cleared session). Degrades silently
// — a down server just means the stale copy lingers until it's overwritten.
export async function deleteSyncSession(id) {
  if (!safeId(id)) return { ok: false }
  try {
    const res = await fetch(syncUrl(`/session/${id}`), { method: 'DELETE' })
    return { ok: res.ok }
  } catch {
    return { ok: false }
  }
}

// Poll for a newer save every `intervalMs`. Calls onNewer(payload) when the
// server's savedAt advances past `getSavedAt()`. Returns a cleanup function.
export function pollSyncSession(id, getSavedAt, onNewer, intervalMs = 30000) {
  if (!safeId(id)) return () => {}
  let cancelled = false
  const tick = async () => {
    const result = await loadSyncSession(id, getSavedAt())
    if (cancelled || !result || result.unchanged) return
    if (result.savedAt && result.savedAt !== getSavedAt()) onNewer(result)
  }
  const handle = setInterval(tick, intervalMs)
  return () => {
    cancelled = true
    clearInterval(handle)
  }
}
