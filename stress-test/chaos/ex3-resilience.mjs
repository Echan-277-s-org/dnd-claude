// EX-3 — resilience (stub Ollama, no real GPU)
// Ports used: 3011 (stub), 3012 (sync-A), 3013 (sync-BC)
// NEVER touches port 3001 (live GPU run).
//
// EX-3a: Error/recovery — stub returns HTTP 503 → same catch block as timeout.
//         Verify dm:done{error:true}, phase resets, turnSeq NOT incremented,
//         dmBusy cleared so next action succeeds.
//
// EX-3b: Forged verdict.roll — stub emits verdict.roll≠actual_dice_result.
//         Verify server rejects (dice message verdict stays null).
//         Positive control: stub emits verdict.roll===actual → verdict applied.
//
// EX-3c: DM_BUSY / RATE_LIMITED — burst actions on one connection.
//         Verify correct codes and room consistent afterwards.
//
// Usage: node stress-test/chaos/ex3-resilience.mjs

import http from 'node:http'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { createSyncServer } from '../../server/sync-server.mjs'
import { makeRoomCode } from '../../src/lib/session.js'
import { mkdir, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const STUB_PORT    = 3011
const SYNC_PORT_A  = 3012
const SYNC_PORT_BC = 3013
const SESSIONS_DIR = path.join(__dirname, 'ex3-sessions-tmp')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Ollama stub ──────────────────────────────────────────────────────────────
const stub = { mode: 'fast', forgedRoll: null }

// Use tagged template literal to build backtick-fenced blocks correctly
function makeNDJSON(text, partyArr, verdictObj) {
  const lines = []
  // Text in chunks
  const chunks = text.match(/.{1,50}/g) ?? [text]
  for (const c of chunks) {
    lines.push(JSON.stringify({ message: { content: c }, done: false }))
  }
  // Party block — backticks embedded directly in this .mjs file (not shell)
  if (partyArr) {
    const block = '```party\n' + JSON.stringify(partyArr) + '\n```'
    lines.push(JSON.stringify({ message: { content: '\n' + block }, done: false }))
  }
  // Verdict block
  if (verdictObj) {
    const block = '```verdict\n' + JSON.stringify(verdictObj) + '\n```'
    lines.push(JSON.stringify({ message: { content: '\n' + block }, done: false }))
  }
  lines.push(JSON.stringify({
    done: true, eval_count: 100, eval_duration: 1e9,
    prompt_eval_count: 50, total_duration: 1.2e9,
  }))
  return lines.join('\n') + '\n'
}

const PARTY_4 = [
  { name: 'Kael', role: 'Fighter', hpPct: 100, isActive: false },
  { name: 'Lyra', role: 'Wizard',  hpPct: 100, isActive: false },
  { name: 'Bron', role: 'Cleric',  hpPct: 100, isActive: false },
  { name: 'Sora', role: 'Rogue',   hpPct: 100, isActive: false },
]

const stubServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      if (stub.mode === 'error503') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'model overloaded' }))
        return
      }
      if (stub.mode === 'forged') {
        const vObj = { skill: 'STEALTH', dc: 15, roll: stub.forgedRoll, result: 'PASS' }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        res.end(makeNDJSON('The rogue slips through the shadows.', PARTY_4, vObj))
        return
      }
      // 'fast' mode — no verdict block
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.end(makeNDJSON('The party advances through Ravenmoor.', PARTY_4, null))
    })
    return
  }
  res.writeHead(404); res.end()
})

// ─── WS client ────────────────────────────────────────────────────────────────
// makeClient: returns a client with waitForAfter(idx, pred, ms) that only
// considers messages received AFTER index idx. This avoids matching stale messages.
function makeClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    const msgs = []
    const waiters = []

    function dispatch(msg, idx) {
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i]
        if (idx >= w.fromIdx && w.pred(msg)) {
          clearTimeout(w.timer)
          waiters.splice(i, 1)
          w.res(msg)
          return
        }
      }
    }

    ws.on('open', () => {
      resolve({
        ws, msgs,
        send(obj) { ws.send(JSON.stringify(obj)) },
        // Wait for a message arriving at position >= fromIdx matching pred
        waitForAfter(fromIdx, pred, ms = 12000) {
          // Check already-received messages at or after fromIdx
          for (let i = fromIdx; i < msgs.length; i++) {
            if (pred(msgs[i])) return Promise.resolve(msgs[i])
          }
          return new Promise((res2, rej2) => {
            const w = { fromIdx, pred, res: res2, rej: rej2 }
            w.timer = setTimeout(() => {
              const i = waiters.indexOf(w)
              if (i >= 0) waiters.splice(i, 1)
              rej2(new Error(`waitForAfter timeout (${ms}ms) fromIdx=${fromIdx}`))
            }, ms)
            waiters.push(w)
          })
        },
        close() { try { ws.close() } catch {} },
      })
    })
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw)
        const idx = msgs.length
        msgs.push(msg)
        dispatch(msg, idx)
      } catch {}
    })
    ws.on('error', reject)
  })
}

async function joinRoom(client, { roomCode, sessionId, displayName, char }) {
  const before = client.msgs.length
  client.send({
    type: 'join', roomCode, sessionId, displayName, lastTurnSequence: 0,
    joinCharacter: char ?? {
      name: displayName, race: 'Human', charClass: 'Fighter',
      abilities: { STR: 16, DEX: 12, CON: 15, INT: 10, WIS: 11, CHA: 12 },
      ac: 18, hpMax: 30,
    },
  })
  return client.waitForAfter(before, m => m.type === 'session:state', 5000)
}

// doAction: send one action, return the dm:done + resting session:update (or error).
// Uses index watermarks to never re-match old messages.
async function doAction(client, roomCode, content, timeoutMs = 18000) {
  const watermark = client.msgs.length

  client.send({
    type: 'action', roomCode,
    payload: { type: 'user', content, pendingCheck: null },
  })

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`doAction timeout (${timeoutMs}ms)`)), timeoutMs)

    let dmDoneIdx = -1

    function tryResolve() {
      // Check for error at or after watermark
      for (let i = watermark; i < client.msgs.length; i++) {
        const m = client.msgs[i]
        if (m.type === 'error') {
          clearTimeout(deadline)
          resolve({ errorCode: m.payload?.code })
          return
        }
        if (m.type === 'dm:done' && dmDoneIdx < 0) {
          dmDoneIdx = i
        }
        if (dmDoneIdx >= 0 && m.type === 'session:update') {
          const p = m.payload?.phase
          if (p && p !== 'awaiting-dm') {
            clearTimeout(deadline)
            resolve({
              dmPayload: client.msgs[dmDoneIdx].payload,
              phaseAfter: p,
              turnSeqAfter: m.payload?.turnSequence,
              messages: m.payload?.messages,
              dmIdx: dmDoneIdx,
              updateIdx: i,
            })
            return
          }
        }
      }
    }

    // Poll every 50ms
    const interval = setInterval(() => {
      tryResolve()
    }, 50)

    // Also hook into future messages via a waiter that just calls tryResolve
    const poller = { fromIdx: watermark, pred: () => { tryResolve(); return false }, res: () => {}, rej: () => {} }
    // We don't use the waiter mechanism here — pure polling is simpler and safe
    // Override: register a general waiter that triggers on every new message
    // Actually, polling at 50ms is fast enough. Clear on resolve.
    const origClear = clearTimeout.bind(null, deadline)
    const wrappedResolve = (v) => { clearInterval(interval); resolve(v) }
    const wrappedReject  = (e) => { clearInterval(interval); reject(e) }

    // Re-register deadline with interval-clearing
    deadline._ex3_interval = interval
  })
}

// Simpler doAction that doesn't have the clearTimeout complexity
async function sendAndWait(client, roomCode, content, timeoutMs = 18000) {
  const watermark = client.msgs.length

  client.send({
    type: 'action', roomCode,
    payload: { type: 'user', content, pendingCheck: null },
  })

  const deadline = Date.now() + timeoutMs
  let dmDoneIdx = -1

  while (Date.now() < deadline) {
    // Check for error
    for (let i = watermark; i < client.msgs.length; i++) {
      const m = client.msgs[i]
      if (m.type === 'error') return { errorCode: m.payload?.code }
      if (m.type === 'dm:done' && dmDoneIdx < 0) dmDoneIdx = i
      if (dmDoneIdx >= 0 && m.type === 'session:update' && m.payload?.phase !== 'awaiting-dm') {
        return {
          dmPayload: client.msgs[dmDoneIdx].payload,
          phaseAfter: m.payload?.phase,
          turnSeqAfter: m.payload?.turnSequence,
          messages: m.payload?.messages,
        }
      }
    }
    await sleep(30)
  }
  throw new Error(`sendAndWait timeout after ${timeoutMs}ms`)
}

// sendDice: send a dice action and wait for dm:done + resting update.
async function sendDice(client, roomCode, roll, pendingCheck, timeoutMs = 18000) {
  const watermark = client.msgs.length

  client.send({
    type: 'action', roomCode,
    payload: {
      type: 'dice',
      content: `[Dice roll: d20 → ${roll}]`,  // → character
      pendingCheck,
    },
  })

  const deadline = Date.now() + timeoutMs
  let dmDoneIdx = -1

  while (Date.now() < deadline) {
    for (let i = watermark; i < client.msgs.length; i++) {
      const m = client.msgs[i]
      if (m.type === 'error') return { errorCode: m.payload?.code }
      if (m.type === 'dm:done' && dmDoneIdx < 0) dmDoneIdx = i
      if (dmDoneIdx >= 0 && m.type === 'session:update' && m.payload?.phase !== 'awaiting-dm') {
        return {
          dmPayload: client.msgs[dmDoneIdx].payload,
          phaseAfter: m.payload?.phase,
          turnSeqAfter: m.payload?.turnSequence,
          messages: m.payload?.messages,
        }
      }
    }
    await sleep(30)
  }
  throw new Error(`sendDice timeout after ${timeoutMs}ms`)
}

// ─── Startup ──────────────────────────────────────────────────────────────────
await mkdir(SESSIONS_DIR, { recursive: true })
process.env.OLLAMA_HOST = `http://localhost:${STUB_PORT}`

await new Promise(r => stubServer.listen(STUB_PORT, r))
console.log(`Stub Ollama on ${STUB_PORT}`)

const syncA  = createSyncServer({ sessionsDir: SESSIONS_DIR, roomGcMs: 5000 })
const syncBC = createSyncServer({ sessionsDir: SESSIONS_DIR, roomGcMs: 5000 })
await new Promise(r => syncA.listen(SYNC_PORT_A, r))
await new Promise(r => syncBC.listen(SYNC_PORT_BC, r))
console.log(`Sync-A on ${SYNC_PORT_A}, Sync-BC on ${SYNC_PORT_BC}`)

const results = {
  experiment: 'EX-3',
  description: 'resilience (stub Ollama, no GPU)',
  stub_port: STUB_PORT,
  sync_ports: [SYNC_PORT_A, SYNC_PORT_BC],
  ex3a_timeout_recovery: null,
  ex3b_forged_verdict: null,
  ex3c_burst_gates: null,
}

// ─────────────────────────────────────────────────────────────────────────────
// EX-3a: HTTP 503 error → catch block → dm:done{error:true} + phase reset
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== EX-3a: Error / Recovery (HTTP 503) ===')

stub.mode = 'fast'
const SID_A = randomUUID()
const cA = await makeClient(SYNC_PORT_A)
await joinRoom(cA, { roomCode: makeRoomCode(SID_A), sessionId: SID_A, displayName: 'Kael' })

// Smoke turn
const smoke = await sendAndWait(cA, makeRoomCode(SID_A), 'Kael scans the tavern.')
console.log(`  Smoke OK. phase=${smoke.phaseAfter} seq=${smoke.turnSeqAfter}`)
const seqBeforeError = smoke.turnSeqAfter ?? 1

// Wait > ACTION_MIN_INTERVAL_MS (500ms) between actions on the same connection
await sleep(600)

// Fault injection: 503 from stub
stub.mode = 'error503'
console.log('  Injecting 503 fault...')

// Record watermark BEFORE sending — guaranteed to be before any error-path messages
const errorWatermark = cA.msgs.length

cA.send({
  type: 'action', roomCode: makeRoomCode(SID_A),
  payload: { type: 'user', content: 'Kael tries the locked door.', pendingCheck: null },
})

// Poll for dm:done with error:true from the watermark — simple polling avoids race
let ex3a_dmDone = null, ex3a_dmError = false, ex3a_phase = null, ex3a_seq = null
const t3a_start = Date.now()
const t3a_deadline = t3a_start + 10000

while (Date.now() < t3a_deadline) {
  await sleep(30)
  // Scan from watermark for dm:done
  for (let i = errorWatermark; i < cA.msgs.length; i++) {
    const m = cA.msgs[i]
    if (m.type === 'dm:done' && !ex3a_dmDone) {
      ex3a_dmDone = m
      ex3a_dmError = m.payload?.error === true
      console.log(`  dm:done at idx=${i}: error=${m.payload?.error} partial="${JSON.stringify(m.payload?.partial ?? '').slice(0,40)}"`)
    }
    if (ex3a_dmDone && m.type === 'session:update' && m.payload?.phase) {
      ex3a_phase = m.payload.phase
      ex3a_seq   = m.payload.turnSequence
      console.log(`  session:update at idx=${i}: phase=${ex3a_phase} seq=${ex3a_seq}`)
      break
    }
  }
  if (ex3a_phase !== null) break
}
if (!ex3a_dmDone) {
  console.log(`  Timeout waiting for dm:done. msgs from watermark:`, cA.msgs.slice(errorWatermark).map(m => m.type + (m.payload?.error ? '{err}':'') + (m.payload?.phase ? '{ph:'+m.payload.phase+'}':'')))
}

// Recovery check: restore fast, wait > ACTION_MIN_INTERVAL_MS, send new action
stub.mode = 'fast'
await sleep(600)
console.log('  Verifying room is unblocked...')
const recovery = await sendAndWait(cA, makeRoomCode(SID_A), 'Kael checks the notice board.')
console.log(`  Recovery: errorCode=${recovery.errorCode ?? 'none'} phase=${recovery.phaseAfter} seq=${recovery.turnSeqAfter}`)
cA.close()

const ex3a = {
  dm_done_error_emitted:    ex3a_dmError,
  phase_reset_to_resting:   ex3a_phase !== undefined && ex3a_phase !== 'awaiting-dm',
  phase_after:              ex3a_phase,
  turn_seq_not_incremented: ex3a_seq !== undefined && ex3a_seq === seqBeforeError,
  seq_before:               seqBeforeError,
  seq_after:                ex3a_seq,
  room_unblocked:           !recovery.errorCode,
  recovery_phase:           recovery.phaseAfter,
}
const ex3a_pass = ex3a.dm_done_error_emitted && ex3a.phase_reset_to_resting
               && ex3a.turn_seq_not_incremented && ex3a.room_unblocked
results.ex3a_timeout_recovery = { ...ex3a, verdict: ex3a_pass ? 'PASS' : 'FAIL' }

console.log('\nEX-3a results:')
console.log(`  dm:done{error:true} emitted:      ${ex3a.dm_done_error_emitted}`)
console.log(`  phase reset to resting:           ${ex3a.phase_reset_to_resting} (${ex3a.phase_after})`)
console.log(`  turnSeq not incremented:          ${ex3a.turn_seq_not_incremented} (${seqBeforeError} → ${ex3a_seq})`)
console.log(`  room unblocked after error:       ${ex3a.room_unblocked}`)
console.log(`  VERDICT: ${results.ex3a_timeout_recovery.verdict}`)

// ─────────────────────────────────────────────────────────────────────────────
// EX-3b: Forged verdict.roll
// Dice action: server records lastDiceEvent{die:'d20', result:ACTUAL, turnSeq:N}
// Forged stub: returns verdict.roll = ACTUAL+6  → forged=true → verdict not applied
// Positive ctrl: returns verdict.roll = ACTUAL  → forged=false → verdict PASS applied
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== EX-3b: Forged verdict.roll ===')

stub.mode = 'fast'
const SID_B = randomUUID()
const cB = await makeClient(SYNC_PORT_BC)
await joinRoom(cB, {
  roomCode: makeRoomCode(SID_B), sessionId: SID_B, displayName: 'Sora',
  char: { name: 'Sora', race: 'Halfling', charClass: 'Rogue',
          abilities: { STR: 10, DEX: 17, CON: 12, INT: 13, WIS: 12, CHA: 13 },
          ac: 14, hpMax: 22 },
})

// ── Forged turn ───────────────────────────────────────────────────────────────
const ACTUAL = 11
stub.mode = 'forged'
stub.forgedRoll = ACTUAL + 6   // 17 — mismatch with actual roll of 11

console.log(`  Forged test: dice d20 → ${ACTUAL} | stub verdict.roll = ${stub.forgedRoll}`)
const forgedTurn = await sendDice(cB, makeRoomCode(SID_B), ACTUAL, { skill: 'STEALTH', dc: 15 })
console.log(`  forgedTurn: phase=${forgedTurn.phaseAfter} seq=${forgedTurn.turnSeqAfter}`)

const forgedMsgs = forgedTurn.messages ?? []
const diceMsg1 = [...forgedMsgs].reverse().find(m => m.role === 'dice' && m.result === ACTUAL)
console.log(`  Dice msg (roll=${ACTUAL}): verdict=${diceMsg1?.verdict ?? 'null'}`)

// ── Positive control ──────────────────────────────────────────────────────────
// Wait > ACTION_MIN_INTERVAL_MS before next action on same connection
await sleep(600)
const ACTUAL2 = 16
stub.mode = 'forged'
stub.forgedRoll = ACTUAL2   // matching → not forged → verdict PASS should apply

console.log(`  Positive ctrl: dice d20 → ${ACTUAL2} | stub verdict.roll = ${stub.forgedRoll} (MATCH)`)
const posTurn = await sendDice(cB, makeRoomCode(SID_B), ACTUAL2, { skill: 'STEALTH', dc: 15 })
console.log(`  posTurn: phase=${posTurn.phaseAfter} seq=${posTurn.turnSeqAfter}`)

const posMsgs = posTurn.messages ?? []
const diceMsg2 = [...posMsgs].reverse().find(m => m.role === 'dice' && m.result === ACTUAL2)
console.log(`  Dice msg (roll=${ACTUAL2}): verdict=${diceMsg2?.verdict ?? 'null'}`)

stub.mode = 'fast'
cB.close()

const ex3b_forged_rejected  = diceMsg1 != null && (diceMsg1.verdict == null || diceMsg1.verdict === undefined)
const ex3b_correct_applied  = diceMsg2 != null && diceMsg2.verdict === 'PASS'
const ex3b = {
  actual_roll: ACTUAL, forged_roll: ACTUAL + 6,
  verdict_after_forgery: diceMsg1?.verdict ?? null,
  forged_rejected: ex3b_forged_rejected,
  positive_roll: ACTUAL2, positive_verdict: diceMsg2?.verdict ?? null,
  correct_applied: ex3b_correct_applied,
}
const ex3b_pass = ex3b.forged_rejected && ex3b.correct_applied
results.ex3b_forged_verdict = { ...ex3b, verdict: ex3b_pass ? 'PASS' : 'FAIL' }

console.log('\nEX-3b results:')
console.log(`  Forged verdict rejected (verdict=null): ${ex3b.forged_rejected}`)
console.log(`  Correct verdict applied (verdict=PASS):  ${ex3b.correct_applied}`)
console.log(`  VERDICT: ${results.ex3b_forged_verdict.verdict}`)

// ─────────────────────────────────────────────────────────────────────────────
// EX-3c: DM_BUSY / RATE_LIMITED burst
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== EX-3c: DM_BUSY / RATE_LIMITED burst ===')

stub.mode = 'fast'
const SID_C1 = randomUUID()
const cC1 = await makeClient(SYNC_PORT_BC)
await joinRoom(cC1, { roomCode: makeRoomCode(SID_C1), sessionId: SID_C1, displayName: 'Kael' })
await sleep(100)

const burstErrors = []
cC1.ws.on('message', raw => {
  try { const m = JSON.parse(raw); if (m.type === 'error') burstErrors.push(m.payload?.code) } catch {}
})

// Test 3c-1: burst on one connection (actions 2+3 arrive within 30ms → DM_BUSY)
console.log('  3c-1: burst actions (2+3 within 30ms of action 1) → expect DM_BUSY/RATE_LIMITED')

cC1.send({ type: 'action', roomCode: makeRoomCode(SID_C1),
           payload: { type: 'user', content: 'Kael charges forward.' } })
await sleep(30)
cC1.send({ type: 'action', roomCode: makeRoomCode(SID_C1),
           payload: { type: 'user', content: 'Kael also checks the door.' } })
await sleep(30)
cC1.send({ type: 'action', roomCode: makeRoomCode(SID_C1),
           payload: { type: 'user', content: 'Kael does a third thing.' } })

// Wait for action 1 to complete
let a1done = null, a1update = null
const burstWatermark = cC1.msgs.length - 3  // roughly before our sends
try {
  // Since we already sent, the messages may arrive out of order.
  // Wait for dm:done and then the resting session:update.
  a1done = await cC1.waitForAfter(0, m => m.type === 'dm:done', 12000)
  const doneIdx = cC1.msgs.indexOf(a1done)
  a1update = await cC1.waitForAfter(doneIdx + 1,
    m => m.type === 'session:update' && m.payload?.phase !== 'awaiting-dm',
    5000
  )
} catch (e) { console.log(`  Burst wait error: ${e.message}`) }
await sleep(200)

const dmBusyCount      = burstErrors.filter(e => e === 'DM_BUSY').length
const rateLimitedCount = burstErrors.filter(e => e === 'RATE_LIMITED').length
console.log(`  DM_BUSY=${dmBusyCount}, RATE_LIMITED=${rateLimitedCount}`)
console.log(`  Action 1 dm:done: ${a1done ? 'yes' : 'no'} error=${a1done?.payload?.error}`)
console.log(`  Room phase: ${a1update?.payload?.phase}, seq: ${a1update?.payload?.turnSequence}`)

// Test 3c-2: RATE_LIMITED on a fresh connection/room
console.log('  3c-2: RATE_LIMITED gate (50ms between actions on same connection)')
const SID_C2 = randomUUID()
const cC2 = await makeClient(SYNC_PORT_BC)
await joinRoom(cC2, { roomCode: makeRoomCode(SID_C2), sessionId: SID_C2, displayName: 'Lyra' })
await sleep(100)

const rlErrors = []
cC2.ws.on('message', raw => {
  try { const m = JSON.parse(raw); if (m.type === 'error') rlErrors.push(m.payload?.code) } catch {}
})

// Action A: completes normally
const actionA = await sendAndWait(cC2, makeRoomCode(SID_C2), 'Lyra casts detect magic.')
console.log(`  Action A done: phase=${actionA.phaseAfter} seq=${actionA.turnSeqAfter}`)

// Action B: 50ms later — RATE_LIMITED (conn.lastActionAt was just set by action A)
await sleep(50)
cC2.send({ type: 'action', roomCode: makeRoomCode(SID_C2),
           payload: { type: 'user', content: 'Lyra reads the scroll.' } })
await sleep(300)
const rlFired = rlErrors.filter(e => e === 'RATE_LIMITED').length > 0
console.log(`  RATE_LIMITED after 50ms: ${rlFired} (errors: ${JSON.stringify(rlErrors)})`)

// Post-RATE_LIMITED recovery: wait > 500ms and send action C
await sleep(600)
const actionC = await sendAndWait(cC2, makeRoomCode(SID_C2), 'Lyra studies the ancient map.')
console.log(`  Post-RATE_LIMITED (>500ms wait): errorCode=${actionC.errorCode ?? 'none'} phase=${actionC.phaseAfter}`)

cC1.close(); cC2.close()

const totalRejections   = dmBusyCount + rateLimitedCount
const roomConsistent    = a1update?.payload?.phase !== undefined && a1update?.payload?.phase !== 'awaiting-dm'
const postRLRecovered   = !actionC.errorCode

const ex3c = {
  dm_busy_count: dmBusyCount, rate_limited_count: rateLimitedCount,
  total_burst_rejections: totalRejections,
  action1_completed: a1done != null && !a1done?.payload?.error,
  room_phase_after_burst: a1update?.payload?.phase,
  room_consistent: roomConsistent,
  rate_limited_gate_fires: rlFired,
  post_rate_limited_recovery: postRLRecovered,
}
const ex3c_pass = totalRejections >= 2 && roomConsistent && rlFired && postRLRecovered
results.ex3c_burst_gates = { ...ex3c, verdict: ex3c_pass ? 'PASS' : 'FAIL' }

console.log('\nEX-3c results:')
console.log(`  Burst rejections (DM_BUSY+RATE_LIMITED): ${totalRejections}`)
console.log(`  Action 1 completed cleanly:              ${ex3c.action1_completed}`)
console.log(`  Room consistent after burst:             ${roomConsistent} (${a1update?.payload?.phase})`)
console.log(`  RATE_LIMITED gate fires:                 ${rlFired}`)
console.log(`  Post-RATE_LIMITED recovery:              ${postRLRecovered}`)
console.log(`  VERDICT: ${results.ex3c_burst_gates.verdict}`)

// ─── Cleanup ──────────────────────────────────────────────────────────────────
console.log('\nShutting down...')
await new Promise(r => syncA.close(r))
await new Promise(r => syncBC.close(r))
await new Promise(r => stubServer.close(r))
await rm(SESSIONS_DIR, { recursive: true, force: true })
console.log('Done.')

console.log('\n=== EX-3 FINAL SUMMARY ===')
console.log(`EX-3a (error/recovery): ${results.ex3a_timeout_recovery.verdict}`)
console.log(`EX-3b (forged verdict): ${results.ex3b_forged_verdict.verdict}`)
console.log(`EX-3c (burst gates):    ${results.ex3c_burst_gates.verdict}`)

writeFileSync(path.join(__dirname, 'ex3-results.json'), JSON.stringify(results, null, 2), 'utf8')
console.log('\nResults written to stress-test/chaos/ex3-results.json')
process.exit(0)
