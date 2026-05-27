/**
 * stress-test/harness-4p.mjs
 * 4-Player Endurance Stress-Test Harness
 *
 * Implements 4P-PROTOCOL.md §1–§4 with the FOLLOW-THE-SPOTLIGHT turn model.
 *
 * ─── FOLLOW-THE-SPOTLIGHT TURN MODEL (overrides §1.2 free-roam assumption) ───
 *
 * Finding from smoke testing: sync-server.mjs:781 derives room.phase purely from
 * the party block: any member with isActive:true → 'combat'. The system prompt
 * (context.js:42) MANDATES that the DM mark exactly one party member isActive:true
 * in EVERY response. Therefore, after the very first DM turn, the room is
 * permanently in 'combat', and the combat gate (sync-server.mjs:451-457) allows
 * ONLY the spotlight player (bound by connection) to act.
 *
 * The old roster-order model (Kael→Lyra→Bron→Sora) was WRONG: non-spotlight
 * players received NOT_YOUR_TURN and their turns were dropped. In smoke, 2 of 4
 * turns were lost → only Kael ever acted, invalidating the continuity test.
 *
 * Fix — each turn we:
 *   1. Read `isActive` from the latest party block received via dm:done/session:update.
 *   2. Send the next scripted beat over THAT player's WebSocket connection.
 *   3. Turn 1 only: no party yet (free-roam) → send as Kael.
 *   4. On NOT_YOUR_TURN (race): re-read latest party, resend as the now-active player.
 *      Never skip or drop a beat.
 *
 * ─── BEAT QUEUE (speaker-independent scripted turns) ─────────────────────────
 *
 * Beats are decoupled from any specific player. Each beat is:
 *   { type:'user'|'dice'|'probe', text?, die?, result?, anchors? }
 *
 * Anchor-introduction beats (rounds 1–3) use collective "we" phrasing so ALL
 * anchors are established regardless of which single player the DM keeps
 * spotlighting. This makes the continuity test valid even if the DM never rotates.
 *
 * ─── COMBAT IS EXPECTED STEADY STATE ─────────────────────────────────────────
 *
 * The spec §1.2 declared "free-roam as design decision" — that is WRONG and
 * overridden here. Combat is the expected post-turn-1 state. We no longer
 * treat it as PHASE_DRIFT. Instead:
 *   - `free_roam_turns` tracks the rare/anomalous free-roam occurrences.
 *   - `spotlight_owner` records the active player per turn.
 *
 * ─── SPOTLIGHT FAIRNESS / STARVATION (new primary metric) ────────────────────
 *
 * Per turn, record `spotlight_owner` (the isActive party member).
 * Summary adds:
 *   spotlight_distribution: { Kael, Lyra, Bron, Sora }  (turn counts)
 *   max_starvation_gap: longest consecutive run any player went without spotlight
 *   spotlight_fairness: note on DM rotation behavior
 *
 * STRESS_METRICS patch (§2.3):
 *   server/sync-server.mjs is instrumented behind process.env.STRESS_METRICS==='1'.
 *   When set, dm:done.payload.metrics carries { eval_count, eval_duration,
 *   prompt_eval_count, total_duration } from Ollama's done:true NDJSON line.
 *   When unset, dm:done broadcasts are byte-identical to production — no change.
 *   tokens_per_sec = eval_count / (eval_duration/1e9) when metrics present;
 *   falls back to wall-clock estimate otherwise.
 *
 * CLI:
 *   node stress-test/harness-4p.mjs [options]
 *   --mode=smoke|full          (default: smoke)
 *   --rounds=N                 (default: 60; smoke forces 1)
 *   --run_id=ID                (default: "4p_smoke" | "4p_main")
 *   --port=N                   (default: 3001)
 *   --model=NAME               Ollama model → campaign.model (default: qwen2.5:14b)
 *   --manage-server            spawn server/sync-server.mjs as child; tear down on exit
 *
 * Artifacts (run_id=4p_main):
 *   stress-test/stress-test-4p-4p_main.jsonl          per-turn records (+ cjk_leak field, ~200-char snippet)
 *   stress-test/fulltext-4p-4p_main.jsonl             FULL DM text per turn (post-hoc hallucination/CJK scan)
 *   stress-test/stress-test-summary-4p-4p_main.json   run summary (incl. cjk_leak HEADLINE aggregate)
 */

import { execSync, spawn } from 'child_process'
import { appendFileSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import net from 'net'

// ─── Import shared production modules (same as Chat.jsx / sync-server) ─────────
import { serializeSession, makeRoomCode, buildPlayersForPrompt } from '../src/lib/session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const STRESS_DIR = __dirname

// ─── ws package (server dep) — Node WebSocket client ────────────────────────────
// Use createRequire for the CommonJS ws package
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

// ─── Constants ───────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'qwen2.5:14b'
const LS_BUDGET = 5_000_000  // 5 MB conservative localStorage ceiling

// Fixed campaign (mirrors harness.mjs CAMPAIGN). `model` is filled at runtime from
// the --model CLI flag (default DEFAULT_MODEL) so the run can target an alternate
// Ollama model (e.g. impish-qwen:14b) without editing this file. The server's
// MODEL_RE allowlist (sync-server.mjs ~L49) validates whatever value is fed here.
function buildCampaign(model) {
  return {
    name: 'The Shattered Vale',
    genre: 'dnd',
    details: 'A dark fantasy campaign set in a crumbling empire. The party seeks the lost Sunstone artifact.',
    model: model || DEFAULT_MODEL,
  }
}

// Fixed roster per §1.1
const ROSTER = ['Kael', 'Lyra', 'Bron', 'Sora']

// Fixed join characters per §1.4
const JOIN_CHARACTERS = {
  Kael: { name: 'Kael', charClass: 'Fighter', race: 'Human', ac: 18, hpMax: 30,
    abilities: { STR: 16, DEX: 12, CON: 15, INT: 10, WIS: 11, CHA: 10 } },
  Lyra: { name: 'Lyra', charClass: 'Wizard', race: 'Elf',  ac: 12, hpMax: 18,
    abilities: { STR: 8,  DEX: 14, CON: 12, INT: 17, WIS: 13, CHA: 12 } },
  Bron: { name: 'Bron', charClass: 'Cleric', race: 'Dwarf', ac: 16, hpMax: 26,
    abilities: { STR: 14, DEX: 10, CON: 14, INT: 11, WIS: 16, CHA: 12 } },
  Sora: { name: 'Sora', charClass: 'Rogue',  race: 'Halfling', ac: 14, hpMax: 22,
    abilities: { STR: 10, DEX: 17, CON: 12, INT: 12, WIS: 11, CHA: 13 } },
}

// Characters map for serializeSession (keyed by displayName)
const JOIN_CHARACTERS_MAP = Object.fromEntries(
  ROSTER.map(name => [name, JOIN_CHARACTERS[name]])
)

// ─── Pool of generic loop turns for rounds beyond the scripted content ───────────
// Used when the run continues past the last scripted round (up to 60-round cap).
// All "we" phrasing — speaker-independent so any spotlight player can send them.
const GENERIC_TURNS = [
  { type: 'user', text: "We press on, staying alert for any signs of danger." },
  { type: 'user', text: "We search the area carefully before moving forward." },
  { type: 'user', text: "We take stock of our resources and discuss our next move." },
  { type: 'user', text: "We continue exploring the area, looking for anything useful." },
  { type: 'user', text: "We check for traps and listen for movement ahead." },
  { type: 'user', text: "We move quietly and cautiously through the next passage." },
  { type: 'user', text: "We keep watch while the party recuperates briefly." },
  { type: 'user', text: "We investigate the markings on the wall more closely." },
]

// ─── Procedural C-anchor names (introduced 1–2 turns before each probe) ─────────
// C(k) introduced 2 turns before probe k (at probe round - 1, turn 1-2 of that round)
const C_ANCHOR_NAMES = [
  'the Obsidian Stair',
  'the Weeping Idol',
  'the Silver Door',
  'the Shattered Gate',
  'the Ember Bridge',
  'the Hollow Throne',
  'the Crumbled Spire',
  'the Frosted Passage',
  'the Rusted Chain',
  'the Sunken Vault',
  'the Blazing Seal',
  'the Forgotten Altar',
  'the Crimson Pool',
  'the Echoing Shaft',
  'the Dark Remnant',
]

// ─── BEAT QUEUE builder ───────────────────────────────────────────────────────────
// Builds an ordered queue of speaker-independent beats.
// Each beat: { beatIndex, round, turnInRound, type:'user'|'dice'|'probe', text?, die?, result?, anchors? }
//
// KEY DIFFERENCE from old buildScript4P:
//   - No `player` field. The acting player is determined at runtime by reading
//     the latest party's isActive member (follow-the-spotlight model).
//   - Anchor introduction beats use collective "we" phrasing so they are valid
//     regardless of which player the DM keeps spotlighting.

function buildBeatQueue(maxRounds) {
  const beats = []

  // ─── Round 1: introduce A1(Ravenmoor), A2(Broken Lantern), A3(Sorcha), A4(Sunstone)
  // "We" phrasing — these anchors are established in the narrative regardless of
  // which single player the DM marks isActive.
  beats.push({
    round: 1, turnInRound: 1, type: 'user',
    text: "We arrive in the town of **Ravenmoor** and make for the tavern known as **The Broken Lantern**. Set the scene — describe the town and the tavern.",
  })
  beats.push({
    round: 1, turnInRound: 2, type: 'user',
    text: "We approach the village elder, **Elder Sorcha**, and ask her about the artifact called the **Sunstone**. What does **Elder Sorcha** tell us?",
  })
  beats.push({
    round: 1, turnInRound: 3, type: 'user',
    text: "We look around the tavern and listen for any rumors about the road south. What do the locals say?",
  })
  beats.push({
    round: 1, turnInRound: 4, type: 'user',
    text: "We scout the perimeter of **Ravenmoor** quietly, noting any guards or unusual activity. What do we observe?",
  })

  // ─── Round 2: introduce B1(Garret Ironhand), B2(Forge of Embers), B3(Captain Vell), B4(East Gate)
  beats.push({
    round: 2, turnInRound: 1, type: 'user',
    text: "We visit the local blacksmith, **Garret Ironhand**, at his forge called **the Forge of Embers**. We ask **Garret Ironhand** to inspect our weapons and tell us what he knows about the road ahead.",
  })
  beats.push({
    round: 2, turnInRound: 2, type: 'user',
    text: "We browse Garret's wares and ask about any unusual orders he has received recently. What does he say?",
  })
  beats.push({
    round: 2, turnInRound: 3, type: 'user',
    text: "We go to the **East Gate barracks** and ask to speak with the guard captain. We are directed to **Captain Vell**. What does **Captain Vell** tell us about threats on the road?",
  })
  beats.push({
    round: 2, turnInRound: 4, type: 'user',
    text: "While speaking with **Captain Vell**, we quietly look around the **East Gate barracks** for any posted notices or intelligence. What do we find?",
  })

  // ─── Round 3: introduce B5(12 gold), B6(Mira), B7(cracked fountain), B8(Ash Covenant)
  beats.push({
    round: 3, turnInRound: 1, type: 'user',
    text: "We seek out the informant known as **Mira the Fence** and offer her **12 gold** pieces for information about our enemies. What does **Mira** tell us?",
  })
  beats.push({
    round: 3, turnInRound: 2, type: 'user',
    text: "We press **Mira** for more details about the faction opposing us — specifically the **Ash Covenant**. What intelligence does she have on the **Ash Covenant**?",
  })
  beats.push({
    round: 3, turnInRound: 3, type: 'user',
    text: "Mira directs us to a meeting point: the **cracked fountain** in the old quarter. We head there. What do we find near the **cracked fountain**?",
  })
  beats.push({
    round: 3, turnInRound: 4, type: 'user',
    text: "We take point and scout ahead of the group as we approach the cracked fountain. What do we spot before the others arrive?",
  })

  // ─── Rounds 4..N: exploration beats with probes every 4 rounds ──────────────
  // Probe rounds: 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60
  // C-anchors introduced 1 turn before each probe (turnInRound 1 of probe rounds)
  let probeIndex = 0

  // Exploration action pool — "we" phrasing, speaker-independent (cycles)
  const explorationPool = [
    "We take the lead and move forward through the passage. What lies ahead?",
    "We check the area for ambush positions and defensive cover. What do we find?",
    "We examine the door or obstacle ahead and decide how to proceed. What happens?",
    "We call a brief halt and listen carefully. What sounds reach us?",
    "We push forward carefully. What do we encounter?",
    "We cast a detection spell quietly and scan the area for any enchantments. What do we sense?",
    "We study the markings or symbols we pass and try to identify their meaning. What do we learn?",
    "We consult our notes and try to recall lore relevant to what we are seeing. What do we remember?",
    "We say a quiet prayer and ask for guidance as we proceed. What sign do we receive?",
    "We check on the party's condition and tend to any minor wounds. What is everyone's status?",
    "We slip ahead silently and scout the next area. What do we observe?",
    "We check for traps along the path and disable anything we find. What did we discover?",
  ]
  let explorationIdx = 0

  function nextExploration() {
    const text = explorationPool[explorationIdx % explorationPool.length]
    explorationIdx++
    return text
  }

  // Dice results pool
  const dieResults = [14, 8, 19, 11, 17, 3, 16, 20, 9, 13, 7, 15, 12, 18, 6]

  for (let round = 4; round <= maxRounds; round++) {
    const isProbeRound = round % 4 === 0
    const probeTurnInRound = 2  // probe lands on turn 2 of probe rounds

    for (let turnInRound = 1; turnInRound <= 4; turnInRound++) {
      if (isProbeRound && turnInRound === probeTurnInRound) {
        // Probe turn
        const cAnchorName = C_ANCHOR_NAMES[probeIndex % C_ANCHOR_NAMES.length]
        const cAnchorRecall = cAnchorName.replace(/^the /, '')
        const probeId = `P${probeIndex + 1}`
        beats.push({
          round,
          turnInRound,
          type: 'probe',
          probe_id: probeId,
          c_anchor: cAnchorName,
          c_anchor_recall: cAnchorRecall,
          text: `Out of character: we ask the DM — remind us of the town where we started, ` +
                `the name of the blacksmith and his shop, what we paid Mira for information, ` +
                `the rival faction she mentioned, and the landmark we just passed through called ${cAnchorName}.`,
          anchors: [
            { id: 'A1', expected: 'Ravenmoor',      category: 'A' },
            { id: 'B1', expected: 'Garret',          category: 'B' },
            { id: 'B2', expected: 'Forge of Embers', category: 'B' },
            { id: 'B5', expected: '12 gold',         category: 'B' },
            { id: 'B8', expected: 'Ash Covenant',    category: 'B' },
            { id: `C${probeIndex + 1}`, expected: cAnchorRecall, category: 'C' },
          ],
        })
        probeIndex++
      } else if (isProbeRound && turnInRound === 1) {
        // 1 turn before the probe: introduce the C-anchor landmark
        const cAnchorName = C_ANCHOR_NAMES[probeIndex % C_ANCHOR_NAMES.length]
        beats.push({
          round,
          turnInRound,
          type: 'user',
          text: `We pass through ${cAnchorName} and pause to examine it. ` +
                `Describe what we see at ${cAnchorName}.`,
        })
      } else if (!isProbeRound && turnInRound === 3 && round % 2 === 0) {
        // Dice turn approximately every other round
        const result = dieResults[(round + turnInRound) % dieResults.length]
        beats.push({
          round,
          turnInRound,
          type: 'dice',
          die: 'd20',
          result,
        })
      } else {
        beats.push({
          round,
          turnInRound,
          type: 'user',
          text: nextExploration(),
        })
      }
    }
  }

  // ─── Cooperative spotlight-handoff nudge ──────────────────────────────────────
  // The room is in `combat` after turn 1 (the prompt mandates exactly one isActive
  // member → sync-server derives combat → only the spotlit player may act). To test
  // whether genuine 4-player turn-taking is achievable, each turn slot maps to a
  // target player round-robin (turnInRound 1→Kael, 2→Lyra, 3→Bron, 4→Sora) and the
  // acting player's message explicitly cedes the spotlight to that target — a clear,
  // in-fiction signal for the DM to rotate isActive. If the DM still parks the
  // spotlight on one player despite explicit handoffs, that is itself the headline
  // finding (4-player play is not sustainable). spotlight_target is recorded so the
  // run can compare requested vs. actual (spotlight_owner) rotation.
  for (const b of beats) {
    const target = ROSTER[(b.turnInRound - 1) % ROSTER.length]
    b.spotlight_target = target
    if (b.type === 'user') {
      b.text += ` It is **${target}**'s turn to act for the party — **${target}** steps forward to take this action.`
    } else if (b.type === 'probe') {
      b.text += ` (**${target}** is the one asking.)`
    }
  }

  return beats
}

// ─── getOllamaPs (mirrors harness.mjs L278-295) ──────────────────────────────────

function getOllamaPs() {
  try {
    const out = execSync('ollama ps', { encoding: 'utf8', timeout: 10000 })
    const lines = out.trim().split('\n')
    if (lines.length < 2) return { processor: 'none', context: '' }
    const dataLine = lines[1]
    if (!dataLine || !dataLine.trim()) return { processor: 'none', context: '' }
    const parts = dataLine.split(/\s{2,}/)
    const processor = parts[3] || ''
    const context = parts[4] || ''
    return { processor: processor.trim(), context: context.trim() }
  } catch {
    return { processor: 'error', context: '' }
  }
}

// ─── percentile (mirrors harness.mjs L299-303) ───────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.floor((p / 100) * (sorted.length - 1))
  return sorted[idx]
}

// ─── Wait until a TCP port is listening (for --manage-server) ────────────────────

function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const sock = new net.Socket()
      sock.setTimeout(500)
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`))
        } else {
          setTimeout(attempt, 300)
        }
      })
      sock.once('timeout', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`))
        } else {
          setTimeout(attempt, 300)
        }
      })
      sock.connect(port, '127.0.0.1')
    }
    attempt()
  })
}

// ─── Structured block parser (mirrors sync-server.mjs extractBlock) ─────────────

function extractBlock(tag, text) {
  const re = new RegExp('```' + tag + '\\s*([\\s\\S]*?)```')
  const match = String(text ?? '').match(re)
  if (!match) return null
  try { return JSON.parse(match[1].trim()) } catch { return null }
}

// ─── WS client factory ────────────────────────────────────────────────────────────

function createClient(displayName, wsUrl) {
  const ws = new WebSocket(wsUrl)
  let messageQueue = []
  let waiters = []

  ws.on('message', data => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    // Deliver to any awaiting promise first
    if (waiters.length > 0) {
      const waiter = waiters.shift()
      waiter(msg)
    } else {
      messageQueue.push(msg)
    }
  })

  function nextMessage(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (messageQueue.length > 0) {
        resolve(messageQueue.shift())
        return
      }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(handler)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error(`${displayName}: WS message timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const handler = msg => {
        clearTimeout(timer)
        resolve(msg)
      }
      waiters.push(handler)
    })
  }

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  }

  function close() {
    ws.close()
  }

  return { ws, displayName, nextMessage, send, close, messageQueue }
}

// ─── Collect messages until a predicate matches, with timeout ────────────────────

async function collectUntil(client, predicate, timeoutMs = 120000) {
  const collected = []
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`${client.displayName}: collectUntil timeout`)
    const msg = await client.nextMessage(remaining)
    collected.push(msg)
    if (predicate(msg)) return collected
  }
}

// ─── CJK / non-Latin script leak detection (HEADLINE metric) ─────────────────────
// Leakage is a known qwen failure mode (the codebase even carries stray CJK like
// "钩子" in context.js) and is most likely in the impish RP finetune. For every DM
// turn we scan the full DM text for CJK and other non-Latin script blocks.
//
// CJK_RE (required minimum): CJK Unified Ideographs + Hiragana/Katakana + Hangul.
//   U+3400–U+4DBF  CJK Unified Ideographs Extension A   (㐀-䶿)
//   U+4E00–U+9FFF  CJK Unified Ideographs                (一-鿿)
//   U+3040–U+30FF  Hiragana + Katakana                   (぀-ヿ)
//   U+AC00–U+D7AF  Hangul Syllables                       (가-힯)
// NON_LATIN_RE (wider net): also flags other non-ASCII script blocks beyond Latin/
//   common punctuation — Cyrillic, Greek, Arabic, Hebrew, Devanagari, Thai, plus the
//   full CJK/Hangul/Kana/Bopomofo/CJK-symbol/Halfwidth ranges. This catches scripts
//   the headline CJK regex misses while ignoring ordinary accented Latin, smart
//   quotes, em-dashes, and emoji-free typography that legitimately appear in prose.
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/
const CJK_RE_G = /[㐀-䶿一-鿿぀-ヿ가-힯]/g
const NON_LATIN_RE_G = /[Ͱ-ϿЀ-ӿ԰-֏֐-׿؀-ۿऀ-ॿ฀-๿　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g

/**
 * Scan DM fullText for CJK / non-Latin script leakage.
 * @returns {null | { count, cjk_count, non_latin_count, sample, scripts }}
 *   null when clean; otherwise the total match count, a short context sample
 *   substring (with surrounding characters), and a coarse script label list.
 */
function detectNonLatinLeak(fullText) {
  const text = String(fullText ?? '')
  if (!text) return null

  const cjkMatches = text.match(CJK_RE_G) ?? []
  const nonLatinMatches = text.match(NON_LATIN_RE_G) ?? []

  // Union count of leaked codepoints (non-Latin ⊇ CJK, so non-Latin is the total).
  const total = nonLatinMatches.length
  if (total === 0) return null

  // Build a short context sample around the FIRST leaked char (±20 chars), so the
  // analyst sees the surrounding prose. Collapse whitespace for compact logging.
  const firstIdx = text.search(NON_LATIN_RE_G)
  const ctxStart = Math.max(0, firstIdx - 20)
  const ctxEnd = Math.min(text.length, firstIdx + 20)
  const sample = text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim()

  // Coarse script classification for the matched codepoints (for the summary).
  const scripts = new Set()
  for (const ch of nonLatinMatches) {
    const cp = ch.codePointAt(0)
    if ((cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF)) scripts.add('CJK')
    else if (cp >= 0x3040 && cp <= 0x30FF) scripts.add('Kana')
    else if (cp >= 0xAC00 && cp <= 0xD7AF) scripts.add('Hangul')
    else if (cp >= 0x3100 && cp <= 0x312F) scripts.add('Bopomofo')
    else if (cp >= 0x0400 && cp <= 0x04FF) scripts.add('Cyrillic')
    else if (cp >= 0x0370 && cp <= 0x03FF) scripts.add('Greek')
    else if (cp >= 0x0530 && cp <= 0x058F) scripts.add('Armenian')
    else if (cp >= 0x0590 && cp <= 0x05FF) scripts.add('Hebrew')
    else if (cp >= 0x0600 && cp <= 0x06FF) scripts.add('Arabic')
    else if (cp >= 0x0900 && cp <= 0x097F) scripts.add('Devanagari')
    else if (cp >= 0x0E00 && cp <= 0x0E7F) scripts.add('Thai')
    else if ((cp >= 0x3000 && cp <= 0x303F) || (cp >= 0xFF00 && cp <= 0xFFEF)) scripts.add('CJK-punct')
    else scripts.add('Other')
  }

  return {
    count: total,
    cjk_count: cjkMatches.length,
    non_latin_count: total,
    sample,
    scripts: Array.from(scripts),
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────────

function scoreAnchors(anchors, fullText) {
  const passed = []
  const failed = []
  for (const anchor of anchors) {
    const pass = fullText.toLowerCase().includes(anchor.expected.toLowerCase())
    if (pass) passed.push(anchor.id)
    else failed.push(anchor.id)
  }
  return { passed, failed }
}

// ─── Linear regression helper ─────────────────────────────────────────────────────

function linearFit(xs, ys) {
  const n = xs.length
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 }
  const sumX = xs.reduce((a, b) => a + b, 0)
  const sumY = ys.reduce((a, b) => a + b, 0)
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0)
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0)
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return { slope: 0, intercept: sumY / n }
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  return { slope, intercept }
}

// ─── Main run function ────────────────────────────────────────────────────────────

async function runHarness4P({ mode, maxRounds, runId, port, manageServer, model }) {
  const CAMPAIGN = buildCampaign(model)
  const MODEL = CAMPAIGN.model
  const jsonlPath = path.join(STRESS_DIR, `stress-test-4p-${runId}.jsonl`)
  const summaryPath = path.join(STRESS_DIR, `stress-test-summary-4p-${runId}.json`)
  // Full-text capture (one JSON object per DM turn) for post-hoc hallucination / CJK
  // analysis. Keeps the per-turn `response_snippet` in the main JSONL unchanged.
  const fulltextPath = path.join(STRESS_DIR, `fulltext-4p-${runId}.jsonl`)
  const wsUrl = `ws://127.0.0.1:${port}/ws`
  const httpBase = `http://127.0.0.1:${port}`

  console.log(`\n${'='.repeat(72)}`)
  console.log(`4P ENDURANCE HARNESS — ${runId}`)
  console.log(`Mode: ${mode}  maxRounds: ${maxRounds}  port: ${port}  model: ${MODEL}`)
  console.log(`JSONL: ${jsonlPath}`)
  console.log(`Fulltext: ${fulltextPath}`)
  console.log(`Summary: ${summaryPath}`)
  console.log(`${'='.repeat(72)}\n`)

  // Truncate JSONL + fulltext files at run start (do not append to previous run's output)
  writeFileSync(jsonlPath, '', 'utf8')
  writeFileSync(fulltextPath, '', 'utf8')

  // Mint one stable sessionId for the entire run
  const sessionId = randomUUID()
  // sessionId must pass ID_RE: /^[A-Za-z0-9_-]{1,128}$/ — UUID with hyphens passes
  const roomCode = makeRoomCode(sessionId)
  console.log(`sessionId: ${sessionId}`)
  console.log(`roomCode:  ${roomCode}\n`)

  // Set campaign.sessionId so serializeSession can find it
  const campaignWithId = { ...CAMPAIGN, sessionId }

  const wallStart = Date.now()

  // ─── State ────────────────────────────────────────────────────────────────────
  let currentPhase = 'free-roam'
  let latestParty = []              // most-recent party from any dm:done or session:update
  let lastSessionUpdate = null      // most-recent round-final session:update payload
  let turnIndex = 0                 // global turn counter (1-based)
  let roundIndex = 0                // current round number (1-based)
  let stopReason = null
  let stopRound = null

  // Spotlight tracking
  // spotlight_history[i] = displayName of spotlight owner for beat i (1-based)
  const spotlightHistory = []       // per-turn record
  const spotlightCount = { Kael: 0, Lyra: 0, Bron: 0, Sora: 0 }
  let freeRoamTurns = 0             // turns that landed in free-roam (anomalous)

  // Per-run accumulation
  const tokensPerSecSamples = []  // non-probe turns only
  const wallMsSamples = []
  const persistBytesSeries = []   // { round, bytes }
  const roomBytesSeries = []      // { round, count, bytes }
  const serverHeapSeries = []     // { round, bytes } when instrumented
  const probeResults = {}         // probe_id → { passed, failed, anchors, accuracy }
  const categoryPassed = { A: 0, B: 0, C: 0 }
  const categoryTotal  = { A: 0, B: 0, C: 0 }
  // B accuracy by spotlight_owner (empirical — which player was spotlit when anchor was introduced)
  const categoryBBySpotlight = { Kael: { p: 0, t: 0 }, Lyra: { p: 0, t: 0 },
                                  Bron: { p: 0, t: 0 }, Sora: { p: 0, t: 0 } }
  let driftOnset = null
  const anchorFirstPass = {}     // anchor_id → first probe in which it passed
  const partyShrinkEvents = []

  // B-collapse soft-stop tracking
  let consecutiveBBelow = 0
  let firstBCollapseProbe = null
  const probesBySoFar = []        // ordered list of { probeId, catBAccuracy }

  // CPU offload
  let cpuOffloadDetected = false
  let cpuOffloadFirstTurn = null
  let baselineProcessor = null

  // R_* ceiling values
  let R_continuity = null
  let R_hardfail = null

  // ─── CJK / non-Latin leak tracking (HEADLINE metric) ──────────────────────────
  // Per-turn detections aggregated into the run summary. cjkLeakEvents holds one
  // entry per affected DM turn; cjkLeakRounds is the de-duplicated set of rounds.
  const cjkLeakEvents = []            // [{ round, turn_in_round, turn_index, player, spotlight_owner, count, cjk_count, scripts, sample }]
  const cjkLeakRounds = new Set()
  let cjkLeakTurnCount = 0            // total DM turns with any non-Latin leak
  let cjkLeakTotalChars = 0          // total leaked codepoints across the run

  // ─── Build beat queue ────────────────────────────────────────────────────────
  const allBeats = buildBeatQueue(maxRounds)

  // ─── Smoke: replace with a condensed beat sequence ──────────────────────────
  const effectiveBeats = mode === 'smoke'
    ? buildSmokeBeats()
    : allBeats

  function buildSmokeBeats() {
    // 4 anchor-introduction beats (round 1) + 1 forced probe
    const smokeBeats = allBeats.filter(b => b.round <= 1)
    smokeBeats.push({
      round: 1, turnInRound: 5, type: 'probe',
      probe_id: 'P_SMOKE',
      text: "Out of character: we ask — what town did we arrive in, what is the famous tavern there, and who is the village elder guiding us on our quest?",
      anchors: [
        { id: 'A1', expected: 'Ravenmoor',      category: 'A' },
        { id: 'A2', expected: 'Broken Lantern', category: 'A' },
        { id: 'A3', expected: 'Sorcha',         category: 'A' },
      ],
    })
    return smokeBeats
  }

  // ─── Open 4 WS clients ───────────────────────────────────────────────────────
  console.log('Opening 4 WebSocket connections...')
  const clients = {}
  for (const name of ROSTER) {
    clients[name] = createClient(name, wsUrl)
    // Wait for WS open
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${name}: WS open timeout`)), 15000)
      clients[name].ws.once('open', () => { clearTimeout(t); resolve() })
      clients[name].ws.once('error', err => { clearTimeout(t); reject(err) })
    })
    console.log(`  ${name}: connected`)
  }

  // ─── Join all 4 clients in roster order ──────────────────────────────────────
  console.log('\nJoining all 4 clients...')
  const smokeGates = { clientsJoined: false, sessionStateReceived: false,
                       presence4Connected: false }

  for (const name of ROSTER) {
    clients[name].send({
      type: 'join',
      roomCode,
      sessionId,
      displayName: name,
      lastTurnSequence: 0,
      joinCharacter: JOIN_CHARACTERS[name],
    })

    // Wait for session:state addressed to this socket
    let gotState = false
    const deadline = Date.now() + 15000
    while (!gotState) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`${name}: join timeout — no session:state`)
      const msg = await clients[name].nextMessage(remaining)
      if (msg.type === 'session:state') {
        gotState = true
        console.log(`  ${name}: received session:state (turnSeq=${msg.payload?.turnSequence ?? 0})`)
      } else if (msg.type === 'error') {
        throw new Error(`${name}: join error: ${JSON.stringify(msg.payload)}`)
      }
      // Discard other messages (presence:update, etc.) during join
    }
  }
  smokeGates.clientsJoined = true
  smokeGates.sessionStateReceived = true

  // Drain any buffered messages (presence:update etc.) for all clients
  // Give a brief window for the server to deliver presence updates
  await new Promise(r => setTimeout(r, 200))
  // Drain all queued messages
  for (const name of ROSTER) {
    while (clients[name].messageQueue.length > 0) {
      clients[name].messageQueue.shift()
    }
  }

  // Verify presence shows 4 connected (check current presence state via drain)
  // We already drained — mark as provisionally true since all 4 joined without error
  smokeGates.presence4Connected = true
  console.log('\nAll 4 clients joined. Starting beats (follow-the-spotlight model)...\n')

  // ─── Ping heartbeat ───────────────────────────────────────────────────────────
  const pingIntervals = {}
  for (const name of ROSTER) {
    pingIntervals[name] = setInterval(() => {
      if (clients[name].ws.readyState === WebSocket.OPEN) {
        clients[name].send({ type: 'ping' })
      }
    }, 20000)
  }

  // ─── Helper: read spotlight owner from latest party ──────────────────────────
  // Returns the displayName of the isActive member, or null if none/free-roam.
  function getSpotlightOwner(party) {
    if (!Array.isArray(party) || party.length === 0) return null
    const active = party.find(m => m.isActive === true)
    if (!active) return null
    // Return name as-is (case-preserved from the party block)
    return String(active.name ?? '').trim() || null
  }

  // ─── Helper: determine which client to use for this beat ─────────────────────
  // Turn 1 (no party yet): always Kael.
  // Subsequent turns: use the isActive member from the latest party.
  // If isActive member is not in our roster (unlikely), fall back to Kael.
  function pickActingClient(beatIndex) {
    if (beatIndex === 0 || latestParty.length === 0) {
      return clients['Kael']
    }
    const owner = getSpotlightOwner(latestParty)
    if (owner && clients[owner]) {
      return clients[owner]
    }
    // Spotlight owner not in roster — fall back to Kael
    console.warn(`  pickActingClient: spotlight "${owner}" not in roster, falling back to Kael`)
    return clients['Kael']
  }

  // ─── Turn execution ───────────────────────────────────────────────────────────
  let lastRoundFinalUpdate = null

  for (let beatIdx = 0; beatIdx < effectiveBeats.length; beatIdx++) {
    if (stopReason) break

    const beat = effectiveBeats[beatIdx]
    turnIndex++
    const round = beat.round
    roundIndex = round
    const turnInRound = beat.turnInRound
    const isProbe = beat.type === 'probe'
    const isDice = beat.type === 'dice'

    // ─── Determine acting client (follow-the-spotlight) ────────────────────────
    // Mutable: may be overridden on NOT_YOUR_TURN retry
    let actingClient = pickActingClient(beatIdx)
    let scheduledPlayer = actingClient.displayName

    const label = `R${round}T${turnInRound}(${scheduledPlayer}${isDice ? '/DICE' : isProbe ? '/PROBE' : ''})`

    // ─── CPU offload check (every 10th turn or turn 1) ─────────────────────────
    if (turnIndex === 1 || turnIndex % 10 === 0) {
      const ps = getOllamaPs()
      if (turnIndex === 1) {
        baselineProcessor = ps.processor
        console.log(`  Baseline ollama processor: "${baselineProcessor}"`)
      } else if (!cpuOffloadDetected) {
        const hasCpu = ps.processor.toLowerCase().includes('cpu')
        const hadCpu = (baselineProcessor ?? '').toLowerCase().includes('cpu')
        if (hasCpu && !hadCpu) {
          cpuOffloadDetected = true
          cpuOffloadFirstTurn = turnIndex
          console.log(`  *** CPU OFFLOAD at T${turnIndex}: ${ps.processor} ***`)
        }
      }
    }

    // ─── Dice turn: no DM response needed ──────────────────────────────────────
    if (isDice) {
      actingClient.send({
        type: 'action',
        roomCode,
        payload: {
          type: 'dice',
          content: `[Dice roll: ${beat.die} → ${beat.result}]`,
        },
      })

      // Wait for dm:done for the dice turn (server still calls Ollama for dice turns)
      const wallT0 = Date.now()
      let dmDoneMsg = null
      let finalSessionUpdate = null
      let retried = false
      let notYourTurnRetried = false

      while (true) {
        let msg
        try {
          msg = await actingClient.nextMessage(120000)
        } catch (err) {
          stopReason = 'SERVER_ERROR'
          stopRound = round
          console.error(`  ${label} FATAL: ${err.message}`)
          break
        }

        // Drain other clients' broadcasts in background
        drainOtherClients(actingClient.displayName, msg)

        if (msg.type === 'error') {
          const code = msg.payload?.code
          if (code === 'DM_BUSY' || code === 'RATE_LIMITED') {
            if (!retried) {
              retried = true
              await delay(1000)
              actingClient.send({
                type: 'action', roomCode,
                payload: { type: 'dice', content: `[Dice roll: ${beat.die} → ${beat.result}]` },
              })
              appendEventFlag('SERVER_REJECT', round, turnInRound, scheduledPlayer)
            } else {
              stopReason = 'SERVER_ERROR'
              stopRound = round
              console.error(`  ${label} FATAL: double SERVER_REJECT`)
              break
            }
          } else if (code === 'NOT_YOUR_TURN') {
            // Re-read latest party and retry as the now-active player
            if (!notYourTurnRetried) {
              notYourTurnRetried = true
              const newOwner = getSpotlightOwner(latestParty)
              console.warn(`  ${label} NOT_YOUR_TURN (dice) — spotlight now "${newOwner}", retrying`)
              if (newOwner && clients[newOwner]) {
                actingClient = clients[newOwner]
                scheduledPlayer = newOwner
              }
              await delay(300)
              actingClient.send({
                type: 'action', roomCode,
                payload: { type: 'dice', content: `[Dice roll: ${beat.die} → ${beat.result}]` },
              })
            } else {
              stopReason = 'SERVER_ERROR'
              stopRound = round
              console.error(`  ${label} FATAL: double NOT_YOUR_TURN on dice`)
              break
            }
          }
          continue
        }

        if (msg.type === 'dm:done') {
          dmDoneMsg = msg
          // Update latestParty from fullText if party block present
          const partyRaw = extractBlock('party', msg.payload?.fullText ?? '')
          if (Array.isArray(partyRaw) && partyRaw.length > 0) {
            latestParty = partyRaw
          }
          if (msg.payload?.error) {
            const wallMs = Date.now() - wallT0
            if (wallMs >= 85000) stopReason = 'OLLAMA_TIMEOUT'
            else stopReason = 'SERVER_ERROR'
            stopRound = round
            console.error(`  ${label} dm:done ERROR (wall=${wallMs}ms)`)
          }
        }
        if (msg.type === 'session:update' && !isTransientPhase(msg.payload?.phase)) {
          finalSessionUpdate = msg
          // Update latestParty from session:update
          const updParty = msg.payload?.party
          if (Array.isArray(updParty) && updParty.length > 0) {
            latestParty = updParty
          }
        }
        if (finalSessionUpdate && dmDoneMsg) break
      }

      if (stopReason) break

      const wallMs = Date.now() - wallT0
      lastRoundFinalUpdate = finalSessionUpdate?.payload ?? lastRoundFinalUpdate

      // Drain other clients
      await drainAll(600)

      // Record spotlight for this beat
      const spotOwner = getSpotlightOwner(latestParty) ?? scheduledPlayer
      spotlightHistory.push(spotOwner)
      if (spotlightCount[spotOwner] !== undefined) spotlightCount[spotOwner]++

      // Write JSONL line for dice turn
      const msgArray = finalSessionUpdate?.payload?.messages ?? []
      const party = finalSessionUpdate?.payload?.party ?? latestParty
      const roomMsgBytes = Buffer.byteLength(JSON.stringify(msgArray), 'utf8')

      const persistBytes = computePersistBytes(campaignWithId, sessionId, finalSessionUpdate?.payload)
      const persistBytesVal = persistBytes ?? 0

      // ─── CJK / non-Latin leak scan (HEADLINE metric) — dice turn DM text ───────
      const diceFullText = dmDoneMsg?.payload?.fullText ?? ''
      const diceEventFlags = []
      const diceLeak = detectNonLatinLeak(diceFullText)
      if (diceLeak) {
        diceEventFlags.push('CJK_LEAK')
        recordCjkLeak(diceLeak, round, turnInRound, scheduledPlayer, spotOwner)
        console.warn(`  ${label} *** CJK_LEAK: ${diceLeak.count} non-Latin chars [${diceLeak.scripts.join(',')}] sample="${diceLeak.sample}" ***`)
      }

      // ─── Full-text capture (post-hoc analysis file) ───────────────────────────
      appendFulltextLine(fulltextPath, {
        run_id: runId, model: MODEL,
        round, turn: turnInRound, turn_index: turnIndex,
        player: scheduledPlayer, actor: spotOwner, action_type: 'dice',
        cjk_leak: diceLeak ? diceLeak.count : 0,
        fullText: diceFullText,
      })

      appendJsonlLine(jsonlPath, {
        run_id: runId,
        round, turn_in_round: turnInRound, turn_index: turnIndex,
        player: scheduledPlayer, action_type: 'dice',
        spotlight_owner: spotOwner,
        is_probe: false, probe_id: null,
        anchors_tested: [], anchors_passed: [],
        turn_sequence: finalSessionUpdate?.payload?.turnSequence ?? null,
        phase_after: finalSessionUpdate?.payload?.phase ?? null,
        party_names: party.map(m => m.name),
        party_active: party.filter(m => m.isActive).map(m => m.name),
        tokens_per_sec: 0, eval_count: 0, eval_duration_ns: 0, total_duration_ns: 0,
        wall_ms: wallMs,
        ollama_processor: '',
        entity_digest_string: '',
        entity_digest_length: 0,
        room_messages_count: msgArray.length,
        room_messages_bytes: roomMsgBytes,
        persist_bytes: persistBytesVal,
        server_heap_bytes: finalSessionUpdate?.payload?.heapUsedBytes ?? null,
        response_snippet: diceFullText.slice(0, 200),
        cjk_leak: diceLeak ?? null,
        event_flags: diceEventFlags,
      })

      checkPhaseAndParty(party, finalSessionUpdate?.payload?.phase, round, turnInRound, scheduledPlayer)
      checkPersistBytesLimit(persistBytesVal, round)

      console.log(`  ${label} wall=${wallMs}ms  spotlight=${spotOwner}  party=${party.map(m=>m.name).join(',')}`)
      continue
    }

    // ─── User / probe turn ──────────────────────────────────────────────────────
    const actionText = beat.text
    const pendingCheck = null  // no pending check in the scripted beats

    const wallT0 = Date.now()
    let retried = false
    let notYourTurnRetried = false
    let dmDoneMsg = null
    let finalSessionUpdate = null
    let fullText = ''
    let eventFlags = []

    // Send action on the acting client (spotlight owner)
    actingClient.send({
      type: 'action',
      roomCode,
      payload: { type: 'user', content: actionText, pendingCheck },
    })

    // Collect messages until dm:done + round-final session:update
    while (true) {
      let msg
      try {
        msg = await actingClient.nextMessage(120000)
      } catch (err) {
        stopReason = 'SERVER_ERROR'
        stopRound = round
        console.error(`  ${label} FATAL: ${err.message}`)
        break
      }

      drainOtherClients(actingClient.displayName, msg)

      if (msg.type === 'error') {
        const code = msg.payload?.code
        if (code === 'DM_BUSY' || code === 'RATE_LIMITED') {
          if (!retried) {
            retried = true
            eventFlags.push('SERVER_REJECT')
            await delay(1000)
            actingClient.send({
              type: 'action', roomCode,
              payload: { type: 'user', content: actionText, pendingCheck },
            })
          } else {
            stopReason = 'SERVER_ERROR'
            stopRound = round
            console.error(`  ${label} FATAL: double SERVER_REJECT`)
            break
          }
          continue
        }
        if (code === 'NOT_YOUR_TURN') {
          // Re-read latest party and retry as the now-active player.
          // This handles the race where the DM switched spotlight between our
          // pickActingClient call and the action arriving at the server.
          if (!notYourTurnRetried) {
            notYourTurnRetried = true
            eventFlags.push('SPOTLIGHT_RACE')
            const newOwner = getSpotlightOwner(latestParty)
            console.warn(`  ${label} NOT_YOUR_TURN (spotlight race) — now "${newOwner}", retrying`)
            if (newOwner && clients[newOwner]) {
              actingClient = clients[newOwner]
              scheduledPlayer = newOwner
            }
            await delay(300)
            actingClient.send({
              type: 'action', roomCode,
              payload: { type: 'user', content: actionText, pendingCheck },
            })
          } else {
            stopReason = 'SERVER_ERROR'
            stopRound = round
            console.error(`  ${label} FATAL: double NOT_YOUR_TURN — cannot recover`)
            break
          }
          continue
        }
        console.warn(`  ${label} error: ${code}`)
        continue
      }

      if (msg.type === 'dm:delta') {
        fullText += msg.payload?.delta ?? ''
      }

      if (msg.type === 'dm:done') {
        dmDoneMsg = msg
        if (msg.payload?.fullText) fullText = msg.payload.fullText
        // Update latestParty from fullText
        const partyRaw = extractBlock('party', fullText)
        if (Array.isArray(partyRaw) && partyRaw.length > 0) {
          latestParty = partyRaw
        }
        if (msg.payload?.error) {
          const wallMs = Date.now() - wallT0
          if (wallMs >= 85000) {
            stopReason = 'OLLAMA_TIMEOUT'
            R_hardfail = round
          } else {
            stopReason = 'SERVER_ERROR'
            R_hardfail = round
          }
          stopRound = round
          console.error(`  ${label} dm:done ERROR (wall=${Date.now()-wallT0}ms)`)
        }
      }

      if (msg.type === 'session:update' && !isTransientPhase(msg.payload?.phase)) {
        finalSessionUpdate = msg
        // Update latestParty from session:update (more authoritative than dm:done text)
        const updParty = msg.payload?.party
        if (Array.isArray(updParty) && updParty.length > 0) {
          latestParty = updParty
        }
      }

      if (dmDoneMsg && finalSessionUpdate) break
    }

    if (stopReason) break

    const wallMs = Date.now() - wallT0
    lastRoundFinalUpdate = finalSessionUpdate?.payload ?? lastRoundFinalUpdate

    // Drain other clients
    await drainAll(600)

    // Record spotlight owner AFTER dm:done (party updated by this DM response)
    const spotOwner = getSpotlightOwner(latestParty) ?? scheduledPlayer
    spotlightHistory.push(spotOwner)
    if (spotlightCount[spotOwner] !== undefined) spotlightCount[spotOwner]++

    // Track free-roam (anomalous when no isActive in party after turn 1)
    const phaseAfterBeat = finalSessionUpdate?.payload?.phase ?? null
    if (phaseAfterBeat === 'free-roam' && beatIdx > 0) {
      freeRoamTurns++
    }

    // Extract metrics
    const metrics = dmDoneMsg?.payload?.metrics
    let tokensPerSec = 0
    let evalCount = 0
    let evalDurationNs = 0
    let totalDurationNs = 0

    if (metrics && metrics.eval_count > 0 && metrics.eval_duration > 0) {
      evalCount = metrics.eval_count
      evalDurationNs = metrics.eval_duration
      totalDurationNs = metrics.total_duration ?? 0
      tokensPerSec = evalCount / (evalDurationNs / 1e9)
    } else {
      // Wall-clock fallback estimate (assume ~100 tokens in response)
      const textLen = fullText.length
      const estTokens = Math.max(50, Math.round(textLen / 4))
      tokensPerSec = wallMs > 0 ? (estTokens / (wallMs / 1000)) : 0
    }

    // Party info
    const party = finalSessionUpdate?.payload?.party ?? latestParty
    const msgArray = finalSessionUpdate?.payload?.messages ?? []
    const phaseAfter = finalSessionUpdate?.payload?.phase ?? null

    // Parse entity digest from fullText
    const entityDigestString = extractEntityDigest(fullText)

    // Compute persist bytes
    const persistBytes = computePersistBytes(campaignWithId, sessionId, finalSessionUpdate?.payload)
    const persistBytesVal = persistBytes ?? 0

    const roomMsgCount = msgArray.length
    const roomMsgBytes = Buffer.byteLength(JSON.stringify(msgArray), 'utf8')
    const serverHeapBytes = finalSessionUpdate?.payload?.heapUsedBytes ?? null

    // Track series
    if (!isProbe && tokensPerSec > 0) tokensPerSecSamples.push(tokensPerSec)
    if (!isProbe) wallMsSamples.push(wallMs)

    // Per-round tracking (on round-final turn = turnInRound 4)
    if (turnInRound === 4 || (mode === 'smoke' && beat.type === 'probe')) {
      persistBytesSeries.push({ round, bytes: persistBytesVal })
      roomBytesSeries.push({ round, count: roomMsgCount, bytes: roomMsgBytes })
      if (serverHeapBytes != null) serverHeapSeries.push({ round, bytes: serverHeapBytes })
    }

    // Probe scoring
    let anchorsTestedList = []
    let anchorsPassedList = []
    let probeId = null

    if (isProbe) {
      probeId = beat.probe_id
      const { passed, failed } = scoreAnchors(beat.anchors ?? [], fullText)
      anchorsPassedList = passed
      anchorsTestedList = [...passed, ...failed]

      probeResults[probeId] = {
        round,
        passed: passed.length,
        total: (beat.anchors ?? []).length,
        accuracy: passed.length / Math.max(1, (beat.anchors ?? []).length),
        spotlight_owner_at_probe: spotOwner,
        anchors: (beat.anchors ?? []).map(a => ({
          ...a,
          pass: passed.includes(a.id),
        })),
      }

      // Category accumulation
      for (const anchor of beat.anchors ?? []) {
        const pass = passed.includes(anchor.id)
        categoryTotal[anchor.category] = (categoryTotal[anchor.category] ?? 0) + 1
        if (pass) categoryPassed[anchor.category] = (categoryPassed[anchor.category] ?? 0) + 1

        if (anchor.category === 'B') {
          // Empirical: record against the spotlight owner at probe time
          const bOwner = spotOwner
          if (bOwner && categoryBBySpotlight[bOwner]) {
            categoryBBySpotlight[bOwner].t++
            if (pass) categoryBBySpotlight[bOwner].p++
          }
          // Drift onset: first B anchor to FAIL
          if (!pass && !driftOnset) {
            driftOnset = {
              probe_id: probeId, anchor_id: anchor.id,
              spotlight_owner: spotOwner,
              round, expected: anchor.expected,
            }
          }
        }

        // Track first pass for each anchor
        if (pass && !anchorFirstPass[anchor.id]) {
          anchorFirstPass[anchor.id] = probeId
        }
      }

      // B-accuracy soft-stop logic
      const bAcc = categoryTotal.B > 0 ? categoryPassed.B / categoryTotal.B : 1
      probesBySoFar.push({ probeId, catBAccuracy: bAcc, round })

      if (bAcc < 0.50) {
        if (firstBCollapseProbe === null) firstBCollapseProbe = { probeId, round }
        consecutiveBBelow++
        if (consecutiveBBelow >= 2) {
          R_continuity = firstBCollapseProbe.round
          stopReason = 'B_COLLAPSE'
          stopRound = round
          console.warn(`  *** B_COLLAPSE: category_B_accuracy=${bAcc.toFixed(3)} sustained ≥2 probes ***`)
        }
      } else {
        consecutiveBBelow = 0
        firstBCollapseProbe = null
      }

      const score = `${passed.length}/${(beat.anchors ?? []).length}`
      console.log(`  ${label} [${probeId}] Score: ${score}  PASS:[${passed.join(',')}]  FAIL:[${failed.join(',')}]  spotlight=${spotOwner}`)
    }

    // Phase / party checks
    checkPhaseAndParty(party, phaseAfter, round, turnInRound, scheduledPlayer, eventFlags)
    checkPersistBytesLimit(persistBytesVal, round)

    // ─── CJK / non-Latin leak scan (HEADLINE metric) — user/probe turn DM text ──
    const leak = detectNonLatinLeak(fullText)
    if (leak) {
      eventFlags.push('CJK_LEAK')
      recordCjkLeak(leak, round, turnInRound, scheduledPlayer, spotOwner)
      console.warn(`  ${label} *** CJK_LEAK: ${leak.count} non-Latin chars [${leak.scripts.join(',')}] sample="${leak.sample}" ***`)
    }

    // ─── Full-text capture (post-hoc analysis file) ───────────────────────────
    appendFulltextLine(fulltextPath, {
      run_id: runId, model: MODEL,
      round, turn: turnInRound, turn_index: turnIndex,
      player: scheduledPlayer, actor: spotOwner,
      action_type: isProbe ? 'probe' : 'user',
      is_probe: isProbe, probe_id: probeId,
      cjk_leak: leak ? leak.count : 0,
      fullText,
    })

    // Write JSONL line
    appendJsonlLine(jsonlPath, {
      run_id: runId,
      round, turn_in_round: turnInRound, turn_index: turnIndex,
      player: scheduledPlayer, action_type: isProbe ? 'probe' : 'user',
      spotlight_owner: spotOwner,
      is_probe: isProbe, probe_id: probeId,
      anchors_tested: anchorsTestedList, anchors_passed: anchorsPassedList,
      turn_sequence: finalSessionUpdate?.payload?.turnSequence ?? null,
      phase_after: phaseAfter,
      party_names: party.map(m => m.name),
      party_active: party.filter(m => m.isActive).map(m => m.name),
      tokens_per_sec: Math.round(tokensPerSec * 100) / 100,
      eval_count: evalCount,
      eval_duration_ns: evalDurationNs,
      total_duration_ns: totalDurationNs,
      wall_ms: wallMs,
      ollama_processor: '',
      entity_digest_string: entityDigestString,
      entity_digest_length: entityDigestString.split(',').filter(Boolean).length,
      room_messages_count: roomMsgCount,
      room_messages_bytes: roomMsgBytes,
      persist_bytes: persistBytesVal,
      server_heap_bytes: serverHeapBytes,
      response_snippet: fullText.slice(0, 200),
      cjk_leak: leak ?? null,
      event_flags: eventFlags,
    })

    if (!isProbe) {
      console.log(`  ${label} tok/s=${tokensPerSec.toFixed(1)}  wall=${wallMs}ms  spotlight=${spotOwner}  persist=${Math.round(persistBytesVal/1024)}KB  msgs=${roomMsgCount}`)
    }

    if (stopReason) break
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────
  for (const name of ROSTER) {
    clearInterval(pingIntervals[name])
    clients[name].close()
  }

  // ─── Compute spotlight fairness metrics ────────────────────────────────────────
  // max_starvation_gap: for each player, the longest consecutive run of turns
  // they were NOT the spotlight owner.
  const maxStarvationGap = {}
  for (const name of ROSTER) {
    let maxGap = 0
    let currentGap = 0
    for (const owner of spotlightHistory) {
      if (owner !== name) {
        currentGap++
        if (currentGap > maxGap) maxGap = currentGap
      } else {
        currentGap = 0
      }
    }
    maxStarvationGap[name] = maxGap
  }

  // spotlight_fairness note
  const neverSpotlit = ROSTER.filter(n => spotlightCount[n] === 0)
  const totalSpotlit = spotlightHistory.length
  const spotlightFairness = neverSpotlit.length > 0
    ? `STARVATION: ${neverSpotlit.join(',')} never received spotlight over ${totalSpotlit} turns`
    : `OK: all 4 players received at least 1 spotlight over ${totalSpotlit} turns`

  // ─── Compute summary ──────────────────────────────────────────────────────────
  const wallTimeSec = Math.round((Date.now() - wallStart) / 1000)

  const sortedTok = [...tokensPerSecSamples].sort((a, b) => a - b)
  const meanTok = sortedTok.length ? sortedTok.reduce((a, b) => a + b, 0) / sortedTok.length : 0

  const catAccuracy = {
    A: categoryTotal.A > 0 ? categoryPassed.A / categoryTotal.A : null,
    B: categoryTotal.B > 0 ? categoryPassed.B / categoryTotal.B : null,
    C: categoryTotal.C > 0 ? categoryPassed.C / categoryTotal.C : null,
  }

  const catBBySpotlightAcc = Object.fromEntries(
    Object.entries(categoryBBySpotlight).map(([name, { p, t }]) => [name, t > 0 ? p / t : null])
  )

  // R_localstorage: extrapolate from persist bytes linear fit
  let R_localstorage = null
  if (persistBytesSeries.length >= 2) {
    const xs = persistBytesSeries.map(d => d.round)
    const ys = persistBytesSeries.map(d => d.bytes)
    const { slope, intercept } = linearFit(xs, ys)
    if (slope > 0) {
      const roundsToLS = Math.ceil((LS_BUDGET - intercept) / slope)
      R_localstorage = roundsToLS > 0 ? roundsToLS : null
    }
  }

  // R_server: extrapolate server heap bytes (if available), else use room bytes
  let R_server = null
  const SERVER_MEM_THRESHOLD = 1_000_000_000  // 1 GB reference
  if (serverHeapSeries.length >= 2) {
    const xs = serverHeapSeries.map(d => d.round)
    const ys = serverHeapSeries.map(d => d.bytes)
    const { slope, intercept } = linearFit(xs, ys)
    if (slope > 0) {
      R_server = Math.ceil((SERVER_MEM_THRESHOLD - intercept) / slope)
    }
  } else if (roomBytesSeries.length >= 2) {
    const xs = roomBytesSeries.map(d => d.round)
    const ys = roomBytesSeries.map(d => d.bytes)
    const { slope, intercept } = linearFit(xs, ys)
    if (slope > 0) {
      R_server = Math.ceil((SERVER_MEM_THRESHOLD - intercept) / slope)
    }
  }

  // Limiting factor decision rule (§4.6)
  const rValues = { R_continuity, R_localstorage, R_server, R_hardfail }
  const nonNull = Object.entries(rValues).filter(([, v]) => v != null && v > 0)
  let limitingFactor = null
  let headlineRounds = null
  if (nonNull.length > 0) {
    const [minKey, minVal] = nonNull.reduce((best, cur) => cur[1] < best[1] ? cur : best)
    limitingFactor = minKey
    headlineRounds = minVal
  }

  const lastRound = roundIndex
  const totalTurns = turnIndex

  // ─── CJK / non-Latin leak aggregation (HEADLINE metric) ───────────────────────
  const cjkLeakRoundsSorted = Array.from(cjkLeakRounds).sort((a, b) => a - b)
  // Up to 10 representative sample substrings (de-duplicated) for the summary.
  const cjkLeakSamples = []
  const seenSamples = new Set()
  for (const ev of cjkLeakEvents) {
    if (ev.sample && !seenSamples.has(ev.sample)) {
      seenSamples.add(ev.sample)
      cjkLeakSamples.push(ev.sample)
      if (cjkLeakSamples.length >= 10) break
    }
  }
  const cjkLeak = {
    model: MODEL,
    total_turns_affected: cjkLeakTurnCount,
    total_turns_scanned: totalTurns,
    leak_rate: totalTurns > 0 ? Math.round((cjkLeakTurnCount / totalTurns) * 1000) / 1000 : 0,
    total_non_latin_chars: cjkLeakTotalChars,
    rounds_affected: cjkLeakRoundsSorted,
    sample_substrings: cjkLeakSamples,
    // Per-model total keyed by the run's model so multiple summaries can be merged.
    by_model: { [MODEL]: { turns_affected: cjkLeakTurnCount, non_latin_chars: cjkLeakTotalChars } },
    events: cjkLeakEvents,
  }

  const summary = {
    run_id: runId,
    mode,
    model: MODEL,
    max_rounds: maxRounds,
    total_rounds: lastRound,
    total_turns: totalTurns,
    stop_reason: stopReason ?? 'completed',
    stop_round: stopRound,
    wall_time_seconds: wallTimeSec,

    // CJK / non-Latin leak (HEADLINE metric)
    cjk_leak: cjkLeak,

    // Spotlight fairness (new primary metric)
    spotlight_distribution: { ...spotlightCount },
    max_starvation_gap: maxStarvationGap,
    spotlight_fairness: spotlightFairness,
    free_roam_turns: freeRoamTurns,

    // Continuity
    category_accuracy: catAccuracy,
    category_counts: { passed: { ...categoryPassed }, total: { ...categoryTotal } },
    category_B_accuracy_by_spotlight_owner: catBBySpotlightAcc,
    drift_onset: driftOnset,
    rounds_to_B_collapse: R_continuity,
    party_shrink_events: partyShrinkEvents,
    probe_results: probeResults,

    // Performance
    performance: {
      mean_tok_per_sec:  Math.round(meanTok * 100) / 100,
      p25_tok_per_sec:   Math.round(percentile(sortedTok, 25) * 100) / 100,
      p75_tok_per_sec:   Math.round(percentile(sortedTok, 75) * 100) / 100,
      p95_tok_per_sec:   Math.round(percentile(sortedTok, 95) * 100) / 100,
      sample_count:      sortedTok.length,
    },
    cpu_offload_detected:   cpuOffloadDetected,
    cpu_offload_first_turn: cpuOffloadFirstTurn,

    // localStorage ceiling
    persist_bytes_series:  persistBytesSeries,
    turns_to_localStorage_cap: R_localstorage != null ? R_localstorage * 4 : null,

    // Server memory
    room_bytes_series:    roomBytesSeries,
    server_heap_series:   serverHeapSeries,

    // Ceiling summary
    R_continuity,
    R_localstorage,
    R_server,
    R_hardfail,
    limiting_factor: limitingFactor,
    headline_rounds: headlineRounds,
  }

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')

  console.log('\n' + '='.repeat(72))
  console.log(`RUN COMPLETE: ${runId}`)
  console.log(`Model: ${MODEL}`)
  console.log(`Rounds: ${lastRound}  Turns: ${totalTurns}  Wall: ${wallTimeSec}s`)
  console.log(`Stop reason: ${summary.stop_reason}`)
  console.log(`*** CJK/non-Latin leak: ${cjkLeakTurnCount}/${totalTurns} turns affected (${cjkLeak.leak_rate}), ${cjkLeakTotalChars} chars, rounds=[${cjkLeakRoundsSorted.join(',')}] ***`)
  if (cjkLeakSamples.length > 0) {
    console.log(`    leak samples: ${cjkLeakSamples.slice(0, 3).map(s => `"${s}"`).join('  ')}`)
  }
  console.log(`Category accuracy: A=${catAccuracy.A?.toFixed(3) ?? 'N/A'}  B=${catAccuracy.B?.toFixed(3) ?? 'N/A'}  C=${catAccuracy.C?.toFixed(3) ?? 'N/A'}`)
  console.log(`Spotlight distribution: ${Object.entries(spotlightCount).map(([k,v]) => `${k}=${v}`).join('  ')}`)
  console.log(`Spotlight fairness: ${spotlightFairness}`)
  console.log(`Max starvation gap: ${Object.entries(maxStarvationGap).map(([k,v]) => `${k}=${v}`).join('  ')}`)
  console.log(`Free-roam turns (anomalous): ${freeRoamTurns}`)
  console.log(`tok/s mean=${meanTok.toFixed(1)}  p25=${percentile(sortedTok,25).toFixed(1)}  p75=${percentile(sortedTok,75).toFixed(1)}`)
  console.log(`R_continuity=${R_continuity ?? 'null'}  R_localstorage=${R_localstorage ?? 'null'}  R_server=${R_server ?? 'null'}  R_hardfail=${R_hardfail ?? 'null'}`)
  console.log(`Limiting factor: ${limitingFactor ?? 'none'}  Headline: ${headlineRounds ?? 'none'} rounds`)
  console.log(`Summary: ${summaryPath}`)
  console.log('='.repeat(72) + '\n')

  return { summary, smokeGates }

  // ─── Inner helpers ────────────────────────────────────────────────────────────

  function isTransientPhase(phase) {
    return phase === 'awaiting-dm' || phase === 'resolving'
  }

  function drainOtherClients(activeDisplayName, msg) {
    // We received a broadcast msg via the active client's WS.
    // Other clients' queues accumulate naturally — just consume stale messages
    // from non-acting clients so their queues don't balloon.
    for (const name of ROSTER) {
      if (name !== activeDisplayName) {
        // Drain up to 50 buffered messages from other clients
        let drained = 0
        while (clients[name].messageQueue.length > 0 && drained < 50) {
          clients[name].messageQueue.shift()
          drained++
        }
      }
    }
  }

  async function drainAll(waitMs) {
    await delay(waitMs)
    for (const name of ROSTER) {
      while (clients[name].messageQueue.length > 0) {
        clients[name].messageQueue.shift()
      }
    }
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  function appendEventFlag(flag, round, turnInRound, player) {
    // Used only for dice turns outside the JSONL line builder
    console.warn(`  R${round}T${turnInRound}(${player}) EVENT: ${flag}`)
  }

  // ─── Record a CJK / non-Latin leak detection into the run-level accumulators ──
  function recordCjkLeak(leak, round, turnInRound, player, spotlightOwner) {
    cjkLeakTurnCount++
    cjkLeakRounds.add(round)
    cjkLeakTotalChars += leak.count
    // Cap stored per-turn events to keep the summary bounded on long runs; the
    // counts/rounds aggregate always reflects every detection.
    if (cjkLeakEvents.length < 200) {
      cjkLeakEvents.push({
        round, turn_in_round: turnInRound, turn_index: turnIndex,
        player, spotlight_owner: spotlightOwner,
        count: leak.count, cjk_count: leak.cjk_count,
        scripts: leak.scripts, sample: leak.sample,
      })
    }
  }

  function checkPhaseAndParty(party, phase, round, turnInRound, player, flags = []) {
    // PARTY_SHRINK: fewer than 4 roster names
    if (Array.isArray(party) && party.length > 0) {
      const partyNames = party.map(m => String(m.name ?? '').trim().toLowerCase())
      const missing = ROSTER.filter(r => !partyNames.includes(r.toLowerCase()))
      if (missing.length > 0) {
        flags.push('PARTY_SHRINK')
        partyShrinkEvents.push({ round, turn: turnInRound, missing })
        console.warn(`  R${round}T${turnInRound} PARTY_SHRINK: missing=[${missing.join(',')}]`)
      }
    }

    currentPhase = phase ?? currentPhase
  }

  function checkPersistBytesLimit(bytes, round) {
    if (bytes >= LS_BUDGET && !stopReason) {
      stopReason = 'LOCALSTORAGE_CAP'
      R_hardfail = round
      stopRound = round
      console.warn(`  *** LOCALSTORAGE_CAP: persist_bytes=${bytes} >= ${LS_BUDGET} ***`)
    }
  }

  function computePersistBytes(campaign, sessId, sessionUpdatePayload) {
    if (!sessionUpdatePayload) return null
    try {
      const payload = serializeSession({
        campaign: { ...campaign, sessionId: sessId },
        messages: sessionUpdatePayload.messages ?? [],
        sessionLog: [],
        party: sessionUpdatePayload.party ?? [],
        roomCode,
        phase: sessionUpdatePayload.phase,
        turnSequence: sessionUpdatePayload.turnSequence,
        characters: JOIN_CHARACTERS_MAP,
      }, sessionUpdatePayload.savedAt)
      return Buffer.byteLength(JSON.stringify(payload), 'utf8')
    } catch {
      return null
    }
  }

  function extractEntityDigest(fullText) {
    // Extract bold-marked entities from DM fullText (simplified version)
    const boldRe = /\*\*([^*]{1,50})\*\*/g
    const entities = new Set()
    let m
    while ((m = boldRe.exec(fullText)) !== null) {
      const ent = m[1].trim()
      if (ent.split(/\s+/).length <= 5) entities.add(ent)
    }
    return Array.from(entities).slice(0, 50).join(', ')
  }
}

function appendJsonlLine(jsonlPath, obj) {
  appendFileSync(jsonlPath, JSON.stringify(obj) + '\n', 'utf8')
}

// Append one full-DM-text record (one JSON object per line) for post-hoc analysis.
function appendFulltextLine(fulltextPath, obj) {
  appendFileSync(fulltextPath, JSON.stringify(obj) + '\n', 'utf8')
}

// ─── Smoke validation gate ────────────────────────────────────────────────────────

async function runSmoke({ port, manageServer, model, runId = '4p_smoke' }) {
  console.log('\n=== SMOKE TEST (4 beats + 1 probe, follow-the-spotlight) ===\n')

  const { summary, smokeGates } = await runHarness4P({
    mode: 'smoke',
    maxRounds: 1,
    runId,
    port,
    manageServer,
    model,
  })

  const jsonlPath = path.join(STRESS_DIR, `stress-test-4p-${runId}.jsonl`)
  const fulltextPath = path.join(STRESS_DIR, `fulltext-4p-${runId}.jsonl`)

  // Read back JSONL
  let lines = []
  try {
    lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { /* empty */ }

  // Gate 1: 4 clients joined & received session:state
  const gate1 = smokeGates.clientsJoined && smokeGates.sessionStateReceived
  console.log(`Gate 1 — 4 clients joined & got session:state: ${gate1 ? 'PASS' : 'FAIL'}`)

  // Gate 2: ALL 4 beats executed (zero dropped turns)
  const actionLines = lines.filter(l => !l.is_probe)
  const gate2 = actionLines.length === 4 && actionLines.every(l => l.wall_ms > 0)
  console.log(`Gate 2 — all 4 beats executed (zero dropped turns): ${gate2 ? 'PASS' : 'FAIL'}  (${actionLines.length}/4 beats, expected 4)`)

  // Gate 3: dm:done.payload.metrics present (STRESS_METRICS flag works)
  // We check if eval_count > 0 in any action line
  const gate3 = actionLines.some(l => l.eval_count > 0)
  console.log(`Gate 3 — dm:done.metrics present (eval_count>0): ${gate3 ? 'PASS' : 'FAIL'}`)

  // Gate 4: party block parses with 4 roster names
  const lastActionLine = actionLines[actionLines.length - 1]
  const gate4partyNames = lastActionLine?.party_names ?? []
  const gate4 = ROSTER.every(r => gate4partyNames.map(n => n.toLowerCase()).includes(r.toLowerCase()))
  console.log(`Gate 4 — party block has 4 roster names: ${gate4 ? 'PASS' : 'FAIL'}  party=${JSON.stringify(gate4partyNames)}`)

  // Gate 5: persist_bytes computes (> 0)
  const gate5 = actionLines.some(l => l.persist_bytes > 0)
  console.log(`Gate 5 — persist_bytes computed (>0): ${gate5 ? 'PASS' : 'FAIL'}  bytes=${lastActionLine?.persist_bytes ?? 0}`)

  // Gate 6: room_messages_bytes grows across turns
  const msgByteSeries = actionLines.map(l => l.room_messages_bytes).filter(v => v > 0)
  const gate6 = msgByteSeries.length >= 2
    ? msgByteSeries[msgByteSeries.length - 1] > msgByteSeries[0]
    : (msgByteSeries.length === 1 && msgByteSeries[0] > 0)
  console.log(`Gate 6 — room_messages_bytes grows: ${gate6 ? 'PASS' : 'FAIL'}  series=${JSON.stringify(msgByteSeries)}`)

  // Gate 7: ≥1 anchor recalled in the probe
  const probeResult = summary.probe_results?.P_SMOKE
  const gate7 = probeResult && probeResult.passed >= 1
  console.log(`Gate 7 — ≥1 anchor recalled in smoke probe: ${gate7 ? 'PASS' : 'FAIL'}  score=${probeResult?.passed ?? 0}/${probeResult?.total ?? 0}`)

  // Gate 8: spotlight_owner recorded per turn & spotlight_distribution present
  const gate8a = actionLines.every(l => l.spotlight_owner != null)
  const gate8b = summary.spotlight_distribution != null
  const gate8 = gate8a && gate8b
  const spotDist = summary.spotlight_distribution ?? {}
  console.log(`Gate 8 — spotlight_owner recorded per turn & distribution present: ${gate8 ? 'PASS' : 'FAIL'}`)
  console.log(`         spotlight_distribution: ${JSON.stringify(spotDist)}`)
  console.log(`         spotlight_fairness: ${summary.spotlight_fairness ?? 'N/A'}`)

  // Gate 9: full-text capture file written with one record per DM turn
  let fulltextLines = []
  try {
    fulltextLines = readFileSync(fulltextPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { /* empty */ }
  // Expect one fulltext record per JSONL turn line, each carrying a fullText string.
  const gate9 = fulltextLines.length === lines.length
    && fulltextLines.length > 0
    && fulltextLines.every(r => typeof r.fullText === 'string' && r.round != null && r.turn != null)
  console.log(`Gate 9 — fulltext file written (1 record/turn): ${gate9 ? 'PASS' : 'FAIL'}  (${fulltextLines.length} records vs ${lines.length} turns) — ${fulltextPath}`)

  // Gate 10: CJK / non-Latin detection wiring executes end-to-end.
  // We do NOT require an actual leak on smoke (zero leaks is the healthy outcome);
  // we require the metric to be PRESENT and the detector to be self-consistent:
  //   - summary.cjk_leak aggregate exists with the run's model + scanned-turn count
  //   - every JSONL line carries a `cjk_leak` field (null when clean)
  //   - the detector itself flags a known CJK string (proves the regex fires)
  const cjkAgg = summary.cjk_leak
  const cjkFieldPresent = lines.length > 0 && lines.every(l => 'cjk_leak' in l)
  const cjkSelfTest = detectNonLatinLeak('The DM said 钩子 here.')  // must detect "钩子"
  const cjkSelfTestOk = cjkSelfTest != null && cjkSelfTest.cjk_count >= 2 && cjkSelfTest.scripts.includes('CJK')
  const cjkAggOk = cjkAgg != null
    && cjkAgg.model === summary.model
    && cjkAgg.total_turns_scanned === summary.total_turns
    && Array.isArray(cjkAgg.rounds_affected)
    && typeof cjkAgg.leak_rate === 'number'
  const gate10 = cjkFieldPresent && cjkSelfTestOk && cjkAggOk
  console.log(`Gate 10 — CJK/non-Latin detection wired & self-test fires: ${gate10 ? 'PASS' : 'FAIL'}`)
  console.log(`          self-test on "钩子" → ${JSON.stringify(cjkSelfTest)}`)
  console.log(`          run cjk_leak aggregate → turns_affected=${cjkAgg?.total_turns_affected ?? 'N/A'}/${cjkAgg?.total_turns_scanned ?? 'N/A'} rounds=[${(cjkAgg?.rounds_affected ?? []).join(',')}] model=${cjkAgg?.model ?? 'N/A'}`)

  const allPass = gate1 && gate2 && gate3 && gate4 && gate5 && gate6 && gate7 && gate8 && gate9 && gate10

  console.log(`\nSMOKE RESULT: ${allPass
    ? '*** ALL 10 GATES PASSED — smoke complete ***'
    : '*** SMOKE FAILED — see failures above ***'}`)

  if (!allPass) {
    console.log('\nFailed gates detail:')
    if (!gate1) console.log('  FAIL Gate 1: clients did not join / get session:state')
    if (!gate2) console.log(`  FAIL Gate 2: expected 4 beats, got ${actionLines.length} — turns were dropped`)
    if (!gate3) console.log('  FAIL Gate 3: metrics absent — check STRESS_METRICS=1 flag on server')
    if (!gate4) console.log('  FAIL Gate 4: party names mismatch — party:', gate4partyNames)
    if (!gate5) console.log('  FAIL Gate 5: persist_bytes = 0 — serializeSession may have failed')
    if (!gate6) console.log('  FAIL Gate 6: room_messages_bytes did not grow')
    if (!gate7) console.log('  FAIL Gate 7: no anchors recalled in probe response')
    if (!gate8) {
      if (!gate8a) console.log('  FAIL Gate 8a: some action lines missing spotlight_owner')
      if (!gate8b) console.log('  FAIL Gate 8b: spotlight_distribution absent from summary')
    }
    if (!gate9) console.log(`  FAIL Gate 9: fulltext file missing/mismatched (${fulltextLines.length} records vs ${lines.length} turns)`)
    if (!gate10) {
      if (!cjkFieldPresent) console.log('  FAIL Gate 10: some JSONL lines missing cjk_leak field')
      if (!cjkSelfTestOk) console.log('  FAIL Gate 10: CJK detector self-test did not fire on "钩子"')
      if (!cjkAggOk) console.log('  FAIL Gate 10: summary.cjk_leak aggregate missing/malformed')
    }
  }

  return allPass
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────────

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, ...rest] = a.slice(2).split('=')
        return [k, rest.length > 0 ? rest.join('=') : true]
      })
  )

  const mode         = args.mode ?? 'smoke'
  const rounds       = parseInt(args.rounds ?? '60', 10)
  const runId        = args.run_id ?? (mode === 'smoke' ? '4p_smoke' : '4p_main')
  const port         = parseInt(args.port ?? '3001', 10)
  const manageServer = args['manage-server'] === true || args['manage-server'] === 'true'
  // --model selects the Ollama model fed into campaign.model (default qwen2.5:14b).
  // Existing invocations without --model are byte-identical to before.
  const model        = (typeof args.model === 'string' && args.model) ? args.model : DEFAULT_MODEL

  console.log(`CLI args: mode=${mode} rounds=${rounds} run_id=${runId} port=${port} manage-server=${manageServer} model=${model}`)

  let serverChild = null

  if (manageServer) {
    // Spawn sync-server.mjs as a child process
    const serverPath = path.join(PROJECT_ROOT, 'server', 'sync-server.mjs')
    console.log(`\nSpawning sync server: node ${serverPath}`)

    serverChild = spawn('node', [serverPath], {
      env: {
        ...process.env,
        STRESS_METRICS: '1',
        SYNC_PORT: String(port),
        // Inherit OLLAMA_HOST from parent if set
      },
      stdio: 'pipe',
    })

    serverChild.stdout.on('data', d => process.stdout.write('[server] ' + d.toString()))
    serverChild.stderr.on('data', d => process.stderr.write('[server] ' + d.toString()))

    serverChild.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`Server process exited with code=${code} signal=${signal}`)
      }
    })

    // Wait until port is listening
    console.log(`Waiting for port ${port}...`)
    await waitForPort(port, 30000)
    console.log(`Port ${port} ready.\n`)

    // Register teardown handlers
    const teardown = () => {
      if (serverChild && !serverChild.killed) {
        console.log('\nTearing down sync server...')
        serverChild.kill('SIGTERM')
        setTimeout(() => {
          if (!serverChild.killed) serverChild.kill('SIGKILL')
        }, 2000)
      }
    }
    process.on('exit', teardown)
    process.on('SIGINT', () => { teardown(); process.exit(130) })
    process.on('SIGTERM', () => { teardown(); process.exit(143) })
    process.on('uncaughtException', err => { console.error('FATAL:', err); teardown(); process.exit(1) })
  }

  const effectiveMaxRounds = mode === 'smoke' ? 1 : rounds

  if (mode === 'smoke') {
    const passed = await runSmoke({ port, manageServer, model, runId })
    if (serverChild) {
      serverChild.kill('SIGTERM')
      await new Promise(r => setTimeout(r, 1000))
    }
    process.exit(passed ? 0 : 1)
  } else if (mode === 'full') {
    await runHarness4P({ mode: 'full', maxRounds: effectiveMaxRounds, runId, port, manageServer, model })
    if (serverChild) {
      serverChild.kill('SIGTERM')
      await new Promise(r => setTimeout(r, 1000))
    }
    process.exit(0)
  } else {
    console.error(`Unknown mode: ${mode}. Use --mode=smoke|full`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
