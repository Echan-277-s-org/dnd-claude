// EX-1 — localStorage cliff (pure, no server, no GPU)
// Synthesizes growing messages arrays representing a 4-player campaign and
// measures the serializeSession → JSON.stringify → byteLength growth curve.
// Confirms the §4.3 linear model and finds the exact turn-count / round-count
// at which the payload crosses the 5,000,000-byte localStorage budget.
//
// Usage: node stress-test/chaos/ex1-localstorage-cliff.mjs

import { serializeSession, makeRoomCode } from '../../src/lib/session.js'
import { randomUUID } from 'node:crypto'

// ─── Campaign fixture (mirrors 4P-PROTOCOL.md §1.4) ─────────────────────────
const SESSION_ID = 'aabbccdd-1234-5678-9abc-aabbccddee00'
const CAMPAIGN = {
  name: 'Ravenmoor Chronicles',
  genre: 'dnd',
  details: 'A 4-player campaign set in the town of Ravenmoor.',
  context: 'The party is investigating the mystery of the Sunstone. Elder Sorcha has tasked them with finding the artifact before the Ash Covenant claims it.',
  model: 'qwen2.5:14b',
  sessionId: SESSION_ID,
}
const ROOM_CODE = makeRoomCode(SESSION_ID)

// ─── Realistic message size constants ────────────────────────────────────────
// From inspection of real qwen2.5:14b DM responses with structured blocks:
//   - DM assistant message: ~800–1400 chars visible text + ~200 bytes party block
//   - User message: ~80–150 chars
//   - Dice message: ~60 chars
//
// We model a round (8 messages) as:
//   4 × user messages  (~110 chars each)
//   3 × DM responses   (~1100 chars each visible + party block ~260 bytes stripped)
//   1 × dice message   (~60 chars)
//
// Note: serializeSession stores stripped assistant content (no structured blocks),
// so DM message size = visible content only (blocks are stripped before store).

const ROSTER = ['Kael', 'Lyra', 'Bron', 'Sora']

// Representative user turns by player (varied to simulate realistic text)
const USER_TURNS = [
  `Kael checks the notice board at The Broken Lantern for any postings about the Sunstone or Elder Sorcha's quest.`,
  `Lyra casts Detect Magic while scanning the market square near the cracked fountain, looking for residual traces of the artifact's power.`,
  `Bron visits Garret Ironhand at the Forge of Embers, asking about any unusual metal work or commissions connected to the Ash Covenant.`,
  `Sora slips into the shadows near the East Gate barracks, keeping watch on Captain Vell's movements while waiting for Mira the Fence to appear.`,
]

// Representative DM response (stripped of structured blocks, ~1100 chars)
function makeDmResponse(turnIndex) {
  const scene = [
    `The notice board at The Broken Lantern is covered with the usual postings — reward notices, missing livestock, a request for a carpenter. But pinned behind a "Lost Cat" notice, Kael spots a small folded note with the wax seal of Elder Sorcha: "Meet me at the old mill at nightfall. Come alone." The tavern is quiet now, only a few patrons nursing their morning ale. The barkeep, a heavyset woman named Hilde, watches you with knowing eyes from behind the counter. The smell of smoke and roasted meat drifts from the kitchen. Dust motes float in the shaft of light from the high window.`,
    `Lyra's Detect Magic reveals a faint residue of transmutation energy near the cracked fountain — old, perhaps weeks past, but unmistakable. The market stalls around her bustle with morning trade: a spice merchant, a cobbler, children chasing a dog between the stalls. No one seems to notice her arcane scrutiny. Near the eastern alley, the magical trace is stronger, a thread leading toward the tannery district. The fountain itself holds no magic; whatever passed through here moved quickly and with purpose. The autumn leaves skitter across the cobblestones.`,
    `Garret Ironhand pauses his hammering when Bron mentions the Ash Covenant — a slight tension in his jaw, quickly masked by a professional smile. "Can't say I know the name," he says, wiping his hands on his leather apron. But his eyes flick to the back room. The Forge of Embers smells of hot metal and coal smoke. Three apprentices work quietly at their stations, heads down. Garret sets down his tongs. "I do my work for honest folk," he says carefully. "If someone asked me to craft something... unusual... I'd say no. That's the truth." He holds your gaze steadily but his knuckles are white around the hammer handle.`,
    `The East Gate barracks is quiet at this hour, two guards playing dice on an overturned barrel. Captain Vell emerges from the guardhouse at the third watch bell, speaking quietly with a cloaked figure Sora doesn't recognize. The exchange is brief — a folded paper passes hands — and the stranger slips out through the postern gate. Vell watches them go, then scans the courtyard with a careful eye before retreating inside. From her vantage point behind the woodpile, Sora catches a glimpse of the stranger's cloak-brooch: a stylized ash tree on a field of grey. The Ash Covenant. Mira hasn't appeared yet but the 12 gold she was paid was clearly for good information.`,
  ][turnIndex % 4]

  return scene + ` The party reconvenes at the agreed meeting point as the afternoon light slants low through the alley. Turn ${turnIndex + 1}.`
}

// Party block (4 members, typical size ~260 bytes in the stored messages)
// This represents what's in room.messages after a DM turn
function makePartyBlock(turnIndex) {
  return [
    { id: 'id-kael', name: 'Kael', role: 'Fighter', hpPct: 100, isActive: false, conditions: [] },
    { id: 'id-lyra', name: 'Lyra', role: 'Wizard', hpPct: 100, isActive: false, conditions: [] },
    { id: 'id-bron', name: 'Bron', role: 'Cleric', hpPct: 100, isActive: false, conditions: [] },
    { id: 'id-sora', name: 'Sora', role: 'Rogue', hpPct: 100, isActive: false, conditions: [] },
  ]
}

// Characters map (static, ~300 bytes)
const CHARACTERS = {
  Kael: { name: 'Kael', race: 'Human', charClass: 'Fighter', abilities: { STR: 16, DEX: 12, CON: 15, INT: 10, WIS: 11, CHA: 12 }, ac: 18, hpMax: 30 },
  Lyra: { name: 'Lyra', race: 'Elf', charClass: 'Wizard', abilities: { STR: 8, DEX: 14, CON: 12, INT: 17, WIS: 13, CHA: 11 }, ac: 12, hpMax: 18 },
  Bron: { name: 'Bron', race: 'Dwarf', charClass: 'Cleric', abilities: { STR: 14, DEX: 10, CON: 14, INT: 11, WIS: 16, CHA: 12 }, ac: 16, hpMax: 26 },
  Sora: { name: 'Sora', race: 'Halfling', charClass: 'Rogue', abilities: { STR: 10, DEX: 17, CON: 12, INT: 13, WIS: 12, CHA: 13 }, ac: 14, hpMax: 22 },
}

// ─── Message factory ─────────────────────────────────────────────────────────
// One round = 4 user turns + 4 DM turns = 8 messages total.
// Every other round adds one dice message (replaces one user turn in the count).
// We model this as approximately 8 messages per round with the realistic sizes above.

function buildMessages(targetTurns) {
  // targetTurns = number of complete DM turns (each DM turn appends 1 user/dice + 1 assistant)
  const messages = []
  let dmTurnIdx = 0

  for (let t = 0; t < targetTurns; t++) {
    const player = ROSTER[t % 4]
    const roundNum = Math.floor(t / 4)

    // Every 7th turn is a dice turn (roughly 1 per 2 rounds × 4 players)
    const isDice = (t % 7 === 3)

    if (isDice) {
      messages.push({
        role: 'dice',
        die: 'd20',
        result: Math.floor(Math.random() * 20) + 1,
        id: randomUUID(),
        senderName: player,
        check: 'STEALTH',
        verdict: 'PASS',
      })
    } else {
      messages.push({
        role: 'user',
        content: `${player}: ${USER_TURNS[t % USER_TURNS.length]}`,
        id: randomUUID(),
        senderName: player,
      })
    }

    // DM response (assistant)
    messages.push({
      role: 'assistant',
      content: makeDmResponse(dmTurnIdx),
      id: randomUUID(),
    })
    dmTurnIdx++
  }

  return messages
}

// ─── Measurement loop ─────────────────────────────────────────────────────────
const LS_BUDGET = 5_000_000 // bytes — localStorage cap per spec
const SAMPLE_TURNS = [10, 20, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 500, 600, 700, 800, 1000, 1200, 1500, 2000]

console.log('EX-1: localStorage cliff experiment')
console.log('=====================================')
console.log(`Budget: ${LS_BUDGET.toLocaleString()} bytes (5 MB localStorage cap)`)
console.log('')

const results = []

for (const turns of SAMPLE_TURNS) {
  const messages = buildMessages(turns)
  const party = makePartyBlock(turns)
  const savedAt = new Date().toISOString()

  const payload = serializeSession(
    {
      campaign: CAMPAIGN,
      messages,
      sessionLog: [],
      party,
      roomCode: ROOM_CODE,
      phase: 'free-roam',
      turnSequence: turns,
      characters: CHARACTERS,
    },
    savedAt
  )

  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  const rounds = Math.ceil(turns / 4)

  results.push({ turns, rounds, bytes, messages: messages.length })
}

// ─── Linear regression to find bytes/turn slope ─────────────────────────────
// We use the first two points to find the intercept (baseline) and then
// a least-squares fit on all points to find the slope.
function linearFit(xs, ys) {
  const n = xs.length
  const sumX = xs.reduce((a, b) => a + b, 0)
  const sumY = ys.reduce((a, b) => a + b, 0)
  const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0)
  const sumX2 = xs.reduce((s, x) => s + x * x, 0)
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  const intercept = (sumY - slope * sumX) / n
  return { slope, intercept }
}

const xs = results.map(r => r.turns)
const ys = results.map(r => r.bytes)
const { slope: bytesPerTurn, intercept } = linearFit(xs, ys)
const bytesPerRound = bytesPerTurn * 4 // 4 turns per round (each turn = 2 messages)
const bytesPerMessage = bytesPerTurn / 2 // approx (user + assistant per turn)

// Find exact turn where budget is crossed
const turnsToCliff = Math.ceil((LS_BUDGET - intercept) / bytesPerTurn)
const roundsToCliff = Math.ceil(turnsToCliff / 4)

// Also find the actual crossover point in our sample data
let actualCrossover = null
for (const r of results) {
  if (r.bytes >= LS_BUDGET) {
    actualCrossover = r
    break
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────
console.log('Sample measurements:')
console.log('Turns | Rounds | Messages | Payload bytes  | bytes/turn')
console.log('------|--------|----------|----------------|----------')
for (const r of results) {
  const bpt = r.turns > 0 ? Math.round(r.bytes / r.turns) : '—'
  const overBudget = r.bytes >= LS_BUDGET ? ' *** OVER BUDGET ***' : ''
  console.log(
    `${String(r.turns).padStart(5)} | ${String(r.rounds).padStart(6)} | ${String(r.messages).padStart(8)} | ${String(r.bytes).padStart(14)} | ${String(bpt).padStart(10)}${overBudget}`
  )
}

console.log('')
console.log('Linear model (least-squares fit):')
console.log(`  bytes/turn:       ${bytesPerTurn.toFixed(1)}`)
console.log(`  bytes/round:      ${bytesPerRound.toFixed(1)}   (4 turns per round)`)
console.log(`  bytes/message:    ${bytesPerMessage.toFixed(1)}  (2 messages per turn: user + assistant)`)
console.log(`  baseline (y0):    ${intercept.toFixed(0)} bytes`)
console.log('')
console.log('localStorage cliff:')
console.log(`  Budget:           ${LS_BUDGET.toLocaleString()} bytes`)
console.log(`  Extrapolated:     ${turnsToCliff} turns = ${roundsToCliff} rounds`)
console.log(`  At cliff:         ~${(intercept + bytesPerTurn * turnsToCliff).toFixed(0)} bytes (linear fit)`)
if (actualCrossover) {
  console.log(`  Actual crossover: ${actualCrossover.turns} turns = ${actualCrossover.rounds} rounds (first sample over budget)`)
} else {
  console.log(`  Actual crossover: not reached in sample range (max ${SAMPLE_TURNS.at(-1)} turns)`)
}

// ─── Linearity verification: check R² ────────────────────────────────────────
const yMean = ys.reduce((a, b) => a + b, 0) / ys.length
const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0)
const ssRes = xs.reduce((s, x, i) => s + (ys[i] - (intercept + bytesPerTurn * x)) ** 2, 0)
const rSquared = 1 - ssRes / ssTot

console.log('')
console.log('Linearity check:')
console.log(`  R² = ${rSquared.toFixed(6)} (1.000 = perfectly linear)`)
if (rSquared > 0.9999) {
  console.log('  VERDICT: Growth is LINEAR (R² > 0.9999). §4.3 model confirmed.')
} else if (rSquared > 0.999) {
  console.log('  VERDICT: Growth is APPROXIMATELY LINEAR (R² > 0.999).')
} else {
  console.log(`  VERDICT: Growth is NON-LINEAR (R² = ${rSquared.toFixed(4)}). INVESTIGATE.`)
}

console.log('')
console.log('Summary:')
console.log(`  bytes/turn:     ${bytesPerTurn.toFixed(1)}`)
console.log(`  bytes/round:    ${bytesPerRound.toFixed(1)}`)
console.log(`  LS cliff:       ${roundsToCliff} rounds (${turnsToCliff} turns)`)
console.log(`  R²:             ${rSquared.toFixed(6)}`)

// ─── Export results as JSON for the report ───────────────────────────────────
const report = {
  experiment: 'EX-1',
  description: 'localStorage cliff (pure, no server)',
  budget_bytes: LS_BUDGET,
  baseline_bytes: Math.round(intercept),
  bytes_per_turn: parseFloat(bytesPerTurn.toFixed(1)),
  bytes_per_round: parseFloat(bytesPerRound.toFixed(1)),
  bytes_per_message: parseFloat(bytesPerMessage.toFixed(1)),
  r_squared: parseFloat(rSquared.toFixed(6)),
  turns_to_cliff: turnsToCliff,
  rounds_to_cliff: roundsToCliff,
  linearity_verdict: rSquared > 0.9999 ? 'LINEAR' : rSquared > 0.999 ? 'APPROX_LINEAR' : 'NON_LINEAR',
  samples: results,
}

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const __dirname1 = path.dirname(fileURLToPath(import.meta.url))
writeFileSync(
  path.join(__dirname1, 'ex1-results.json'),
  JSON.stringify(report, null, 2),
  'utf8'
)
console.log('')
console.log('Results written to stress-test/chaos/ex1-results.json')
