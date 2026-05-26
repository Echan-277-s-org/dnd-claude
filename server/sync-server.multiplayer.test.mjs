// @vitest-environment node
//
// Multiplayer sync-server integration tests — Phases 1–3 gate
//
// ALL TESTS ARE SKIPPED. No implementation exists yet.
// Remove .skip per-describe block as each phase's server work lands.
//
// Test surface addressed:
//   Phase 1 — WebSocket transport: /ws endpoint, join → session:state, ping/pong
//   Phase 2 — Server-authoritative state: action:echo, session:update broadcast,
//              reconnect with lastTurnSequence, 30s poll suspension (server side)
//   Phase 3 — Single DM trigger: mock-Ollama one-call guarantee, DM_BUSY rejection,
//              concurrent-action queue serialization, dm:done broadcast, .md write,
//              turnSequence advance
//   Phase 5 — Turn enforcement: NOT_YOUR_TURN rejection, active-player acceptance
//   Phase 6 — Disconnect/rejoin: presence:update, state resync, orphaned room GC
//
// Mock-Ollama design (see MULTIPLAYER-TEST-AUTOMATION.md §2):
//   A local HTTP server on a random port returns deterministic NDJSON chunks.
//   Set OLLAMA_HOST env var to point the sync server at the mock before each test.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §2, §3, §4, §5, §6, §7
//   MULTIPLAYER-TEST-AUTOMATION.md §2 (multi-client harness)

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// import WebSocket from 'ws'
// import http from 'node:http'
// import { createSyncServer } from './sync-server.mjs'

// ─── helpers (typed but not executed until .skip is removed) ──────────────────

// /**
//  * Spin up the multiplayer sync server against a temp sessions dir and a
//  * mock-Ollama HTTP server. Returns { base, wsBase, mockOllama, server, dir }.
//  */
// async function startTestServer(ollamaChunks = DEFAULT_CHUNKS) {
//   const dir = await mkdtemp(path.join(tmpdir(), 'dnd-mp-'))
//   const mockOllama = await startMockOllama(ollamaChunks)
//   process.env.OLLAMA_HOST = `127.0.0.1:${mockOllama.port}`
//   const httpServer = await new Promise(resolve => {
//     const s = createSyncServer({ sessionsDir: dir }).listen(0, () => resolve(s))
//   })
//   const port = httpServer.address().port
//   return {
//     base: `http://127.0.0.1:${port}`,
//     wsBase: `ws://127.0.0.1:${port}`,
//     mockOllama,
//     server: httpServer,
//     dir,
//   }
// }

// /**
//  * Connect a simulated WebSocket client and wait for the first message.
//  * Returns { ws, firstMessage }.
//  */
// async function connectClient(wsBase, joinPayload) {
//   return new Promise((resolve, reject) => {
//     const ws = new WebSocket(`${wsBase}/ws`)
//     ws.once('error', reject)
//     ws.once('open', () => {
//       ws.send(JSON.stringify({ type: 'join', ...joinPayload }))
//     })
//     ws.once('message', data => {
//       resolve({ ws, firstMessage: JSON.parse(data) })
//     })
//   })
// }

// /**
//  * Collect the next N WebSocket messages from a client.
//  */
// function collectMessages(ws, n) {
//   return new Promise(resolve => {
//     const msgs = []
//     ws.on('message', data => {
//       msgs.push(JSON.parse(data))
//       if (msgs.length >= n) resolve(msgs)
//     })
//   })
// }

// /**
//  * Start a mock-Ollama HTTP server that returns a deterministic NDJSON stream.
//  * `chunks` is an array of strings; each is emitted as one content delta.
//  */
// async function startMockOllama(chunks) {
//   let callCount = 0
//   const s = http.createServer((req, res) => {
//     if (req.method === 'POST' && req.url === '/api/chat') {
//       callCount++
//       res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
//       let i = 0
//       const interval = setInterval(() => {
//         if (i < chunks.length) {
//           res.write(JSON.stringify({ message: { content: chunks[i++] } }) + '\n')
//         } else {
//           res.write(JSON.stringify({ done: true }) + '\n')
//           res.end()
//           clearInterval(interval)
//         }
//       }, 10)
//     }
//   })
//   await new Promise(r => s.listen(0, r))
//   return { server: s, port: s.address().port, getCallCount: () => callCount }
// }

const DEFAULT_CHUNKS = ['The ', 'doors ', 'groan.']
const ROOM_CODE = 'dnd-a1b2c3d4'
const SESSION_ID = 'a1b2c3d4-0000-0000-0000-000000000000'

const baseJoin = {
  roomCode: ROOM_CODE,
  sessionId: SESSION_ID,
  displayName: 'Alex',
  lastTurnSequence: 0,
}

// ─── Phase 1 — WebSocket transport ────────────────────────────────────────────

describe.skip('Phase 1 — WebSocket /ws endpoint', () => {
  let ctx

  beforeAll(async () => {
    // ctx = await startTestServer()
  })
  afterAll(async () => {
    // ctx.server.close()
    // ctx.mockOllama.server.close()
    // await rm(ctx.dir, { recursive: true, force: true })
  })

  it('upgrades HTTP to WebSocket at /ws', async () => {
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    // expect(ws.readyState).toBe(WebSocket.OPEN)
    // ws.close()
  })

  it('join → session:state response contains the current session snapshot', async () => {
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    // expect(firstMessage.type).toBe('session:state')
    // expect(firstMessage.payload).toHaveProperty('messages')
    // expect(firstMessage.payload).toHaveProperty('party')
    // expect(firstMessage.payload.roomCode).toBe(ROOM_CODE)
    // ws.close()
  })

  it('server responds to ping with pong', async () => {
    // const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // const pongPromise = new Promise(r => ws.once('message', d => r(JSON.parse(d))))
    // ws.send(JSON.stringify({ type: 'ping', roomCode: ROOM_CODE }))
    // const pong = await pongPromise
    // expect(pong.type).toBe('pong')
    // ws.close()
  })

  it('rejects a join with an invalid roomCode (400 error message)', async () => {
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, {
    //   ...baseJoin, roomCode: '../../evil'
    // })
    // expect(firstMessage.type).toBe('error')
    // expect(firstMessage.payload.code).toMatch(/invalid/i)
    // ws.close()
  })

  it('rejects a join with an empty displayName (400 error message)', async () => {
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, {
    //   ...baseJoin, displayName: ''
    // })
    // expect(firstMessage.type).toBe('error')
    // ws.close()
  })
})

// ─── Phase 2 — Server-authoritative state + broadcast ─────────────────────────

describe.skip('Phase 2 — session:update broadcast to all clients', () => {
  let ctx, clientA, clientB

  beforeAll(async () => {
    // ctx = await startTestServer()
  })
  afterAll(async () => {
    // clientA?.ws.close(); clientB?.ws.close()
    // ctx.server.close()
    // ctx.mockOllama.server.close()
    // await rm(ctx.dir, { recursive: true, force: true })
  })

  it('client B receives session:update when client A sends an action (echo path)', async () => {
    // clientA = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Alex' })
    // clientB = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Jordan' })
    // const updatePromise = collectMessages(clientB.ws, 1)
    // clientA.ws.send(JSON.stringify({
    //   type: 'action',
    //   roomCode: ROOM_CODE,
    //   payload: { content: 'I look around.', type: 'user', displayName: 'Alex' }
    // }))
    // const [update] = await updatePromise
    // expect(update.type).toBe('session:update')
    // expect(update.payload.messages.length).toBeGreaterThan(0)
  })

  it('phase field is included in every session:update', async () => {
    // clientA = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Alex' })
    // const updatePromise = collectMessages(clientA.ws, 1)
    // clientA.ws.send(JSON.stringify({
    //   type: 'action',
    //   roomCode: ROOM_CODE,
    //   payload: { content: 'Test action', type: 'user', displayName: 'Alex' }
    // }))
    // const [update] = await updatePromise
    // expect(update.payload).toHaveProperty('phase')
    // expect(['free-roam', 'combat', 'awaiting-dm', 'resolving']).toContain(update.payload.phase)
  })

  it('reconnecting client with stale lastTurnSequence receives session:state (not delta)', async () => {
    // clientA = await connectClient(ctx.wsBase, {
    //   ...baseJoin, displayName: 'Alex', lastTurnSequence: 0
    // })
    // expect(clientA.firstMessage.type).toBe('session:state')
    // // Advance the server's turnSequence by completing a DM turn, then reconnect with old seq
    // // ...
    // const staleClient = await connectClient(ctx.wsBase, {
    //   ...baseJoin, displayName: 'Alex', lastTurnSequence: 0
    // })
    // expect(staleClient.firstMessage.type).toBe('session:state') // full snapshot, not delta
    // staleClient.ws.close()
  })
})

// ─── Phase 3 — Single DM trigger / mock-Ollama guarantee ──────────────────────

describe.skip('Phase 3 — exactly one Ollama call per action', () => {
  let ctx

  beforeEach(async () => {
    // ctx = await startTestServer()
  })
  afterEach(async () => {
    // ctx.server.close()
    // ctx.mockOllama.server.close()
    // await rm(ctx.dir, { recursive: true, force: true })
  })

  it('exactly one Ollama POST fires for one player action', async () => {
    // const client = await connectClient(ctx.wsBase, baseJoin)
    // const donePromise = collectMessages(client.ws, /* dm:delta count + 1 for dm:done */ 4)
    // client.ws.send(JSON.stringify({
    //   type: 'action',
    //   roomCode: ROOM_CODE,
    //   payload: { content: 'I enter the tavern.', type: 'user', displayName: 'Alex' }
    // }))
    // await donePromise
    // expect(ctx.mockOllama.getCallCount()).toBe(1)
    // client.ws.close()
  })

  it('dm:delta events are broadcast with delta content and turnSequence', async () => {
    // const client = await connectClient(ctx.wsBase, baseJoin)
    // const msgs = await collectMessages(client.ws, DEFAULT_CHUNKS.length + 1)
    // client.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Go!', type: 'user', displayName: 'Alex' }
    // }))
    // // ...
    // const deltas = msgs.filter(m => m.type === 'dm:delta')
    // expect(deltas.length).toBe(DEFAULT_CHUNKS.length)
    // deltas.forEach(d => {
    //   expect(d.payload).toHaveProperty('delta')
    //   expect(d.payload).toHaveProperty('turnSequence')
    // })
  })

  it('dm:done is broadcast with fullText and advances turnSequence by 1', async () => {
    // const client = await connectClient(ctx.wsBase, baseJoin)
    // const initialSeq = client.firstMessage.payload.turnSequence ?? 0
    // client.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Act.', type: 'user', displayName: 'Alex' }
    // }))
    // const msgs = await collectMessages(client.ws, 10)
    // const done = msgs.find(m => m.type === 'dm:done')
    // expect(done).toBeDefined()
    // expect(done.payload.turnSequence).toBe(initialSeq + 1)
    // expect(done.payload.fullText).toBe(DEFAULT_CHUNKS.join(''))
    // client.ws.close()
  })

  it('.md file is written to disk after dm:done', async () => {
    // const client = await connectClient(ctx.wsBase, baseJoin)
    // client.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Act.', type: 'user', displayName: 'Alex' }
    // }))
    // await collectMessages(client.ws, 10) // wait for dm:done
    // const files = await readdir(ctx.dir)
    // expect(files.some(f => f.endsWith('.md'))).toBe(true)
    // client.ws.close()
  })

  it('second concurrent action is queued: only one Ollama call fires, other gets DM_BUSY', async () => {
    // const clientA = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Alex' })
    // const clientB = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Jordan' })
    // // Fire both actions before phase=awaiting-dm has propagated
    // clientA.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'First action', type: 'user', displayName: 'Alex' }
    // }))
    // clientB.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Simultaneous action', type: 'user', displayName: 'Jordan' }
    // }))
    // // Wait for all messages to settle
    // await new Promise(r => setTimeout(r, 500))
    // expect(ctx.mockOllama.getCallCount()).toBe(1)
    // clientA.ws.close(); clientB.ws.close()
  })

  it('DM_BUSY error is returned to the sender when phase is awaiting-dm', async () => {
    // const clientA = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Alex' })
    // // Trigger a DM call from clientA
    // clientA.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'First', type: 'user', displayName: 'Alex' }
    // }))
    // // Immediately send from clientA again (should hit awaiting-dm phase)
    // clientA.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Double send', type: 'user', displayName: 'Alex' }
    // }))
    // const msgs = await collectMessages(clientA.ws, 5)
    // const error = msgs.find(m => m.type === 'error' && m.payload?.code === 'DM_BUSY')
    // expect(error).toBeDefined()
    // clientA.ws.close()
  })
})

// ─── Phase 5 — Combat turn enforcement ────────────────────────────────────────

describe.skip('Phase 5 — NOT_YOUR_TURN and active-player enforcement', () => {
  // Requires the server to be in phase=combat with one isActive member.
  // Setup: PUT a session into the store with phase=combat, party[0].isActive=true,
  //        party[1].isActive=false, then connect two clients.

  it('active player action is accepted in combat phase', () => {
    // Theron (isActive=true) sends action → no error
  })

  it('non-active player action is rejected with NOT_YOUR_TURN', () => {
    // Wren (isActive=false) sends action → error: NOT_YOUR_TURN
  })

  it('any player action is rejected with DM_BUSY in awaiting-dm phase', () => {
    // phase=awaiting-dm → error: DM_BUSY for all senders
  })

  it('after dm:done with all isActive=false, all players can act (free-roam restored)', () => {
    // Mock Ollama returns a party block with all isActive:false.
    // After dm:done, both clients should be able to send without error.
  })

  it('turnSequence advances by exactly 1 per completed DM turn', () => {
    // Verify turnSequence in dm:done payload increments monotonically.
  })

  it('two clients acting within 10ms in free-roam: exactly one succeeds, one gets DM_BUSY', () => {
    // F7 chaos scenario from architecture §8
    // Same as the concurrent-action test above but asserts turnSequence advances by 1.
  })
})

// ─── Phase 6 — Presence, disconnect, rejoin ────────────────────────────────────

describe.skip('Phase 6 — disconnect detection and rejoin', () => {
  it('server broadcasts presence:update when a client disconnects', () => {
    // clientB connects, then closes. clientA should receive presence:update.
  })

  it('rejoining client with same displayName receives full session:state when lastTurnSequence is stale', () => {
    // Simulate a turn, disconnect, reconnect with lastTurnSequence=0.
  })

  it('DM stream completes and is persisted even when the triggering client disconnects mid-stream', () => {
    // clientA triggers DM, then closes WebSocket before dm:done.
    // Verify clientB receives dm:done and the .md file is written.
  })

  it('server does not crash or deadlock when the active combat player disconnects', () => {
    // F3 scenario: active player in combat closes connection.
    // Server should stay alive; other clients remain in valid COMBAT phase.
  })

  it('orphaned room is garbage-collected from memory after 30 minutes of inactivity', () => {
    // Use fake timers. Advance 31 minutes. Verify in-memory rooms Map no longer
    // holds the room entry (but the .md file persists on disk).
  })
})

// ─── Phase 7 — Migration cutover / backward-compat ────────────────────────────

describe.skip('Phase 7 — HTTP endpoints still pass against updated schema (R2 regression)', () => {
  let ctx

  beforeAll(async () => {
    // ctx = await startTestServer()
  })
  afterAll(async () => {
    // ctx.server.close()
    // ctx.mockOllama.server.close()
    // await rm(ctx.dir, { recursive: true, force: true })
  })

  it('PUT a v2 payload → 200; GET returns it with v2 fields intact', () => {
    // Send a payload with phase, roomCode, turnSequence.
    // GET back and verify the fields survive the .md round-trip.
  })

  it('PUT a v1-shaped payload (no phase/roomCode/turnSequence) → 200; GET returns v2 defaults', () => {
    // A v1 client PUT still works; the server fills defaults on read.
  })

  it('409 LWW guard still applies to concurrent PUTs in v2 schema', () => {
    // Same as existing M5 test but with v2 payload shape.
  })

  it('single-player session (one connected client) is indistinguishable from today', () => {
    // Connect one client, send an action, verify the full cycle:
    // action → dm:delta stream → dm:done → session:update → .md write.
    // No DM_BUSY, no NOT_YOUR_TURN errors.
  })

  it('M7 strictly-newer gate still blocks stale adoption on the WebSocket session:update path', () => {
    // Client has local savedAt T2. Server sends session:update with T1.
    // Client adopt() must reject it (savedAt T1 < T2).
    // This is a client-side test; see useWebSocket.multiplayer.test.jsx for the full path.
    // Here we verify the server does not gate on this — it is a client responsibility.
  })
})
