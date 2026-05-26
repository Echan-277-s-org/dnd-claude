// @vitest-environment node
//
// Multiplayer sync-server integration tests — Phases 1–3 gate
//
// Phase 1 tests are ACTIVE. Later phases remain .skip until their server work lands.
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
import WebSocket from 'ws'
import http from 'node:http'
import { createSyncServer } from './sync-server.mjs'

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Spin up the multiplayer sync server against a temp sessions dir.
 * Returns { base, wsBase, server, dir }.
 */
async function startTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dnd-mp-'))
  const httpServer = await new Promise(resolve => {
    const s = createSyncServer({ sessionsDir: dir }).listen(0, () => resolve(s))
  })
  const port = httpServer.address().port
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    server: httpServer,
    dir,
  }
}

/**
 * Connect a simulated WebSocket client and wait for the first message.
 * Returns { ws, firstMessage }.
 *
 * @param {string} wsBase - e.g. 'ws://127.0.0.1:12345'
 * @param {object} joinPayload - fields merged into the join message
 * @param {object} [wsOptions] - extra options forwarded to the ws constructor (e.g. { headers })
 */
async function connectClient(wsBase, joinPayload, wsOptions = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`, wsOptions)
    const timer = setTimeout(() => reject(new Error('connectClient timed out')), 5000)
    ws.once('error', err => { clearTimeout(timer); reject(err) })
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'join', ...joinPayload }))
    })
    ws.once('message', data => {
      clearTimeout(timer)
      resolve({ ws, firstMessage: JSON.parse(data) })
    })
  })
}

/**
 * Collect the next N WebSocket messages from a client.
 */
function collectMessages(ws, n, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => reject(new Error(`collectMessages timed out waiting for ${n} messages (got ${msgs.length})`)), timeoutMs)
    ws.on('message', data => {
      msgs.push(JSON.parse(data))
      if (msgs.length >= n) {
        clearTimeout(timer)
        resolve(msgs)
      }
    })
  })
}

/**
 * Wait for a WebSocket connection to fully close (upgrade rejected).
 * Returns the HTTP status code written in the rejection response, or null.
 */
async function tryConnect(wsBase, joinPayload, wsOptions = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${wsBase}/ws`, wsOptions)
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'join', ...joinPayload }))
      ws.once('message', data => resolve({ opened: true, firstMessage: JSON.parse(data) }))
    })
    ws.once('error', () => resolve({ opened: false }))
    ws.once('close', (code, reason) => resolve({ opened: false, code, reason: reason?.toString() }))
    setTimeout(() => resolve({ opened: false, timedOut: true }), 3000)
  })
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const ROOM_CODE = 'dnd-a1b2c3d4'
const SESSION_ID = 'a1b2c3d4-0000-0000-0000-000000000000'

const baseJoin = {
  roomCode: ROOM_CODE,
  sessionId: SESSION_ID,
  displayName: 'Alex',
  lastTurnSequence: 0,
}

// ─── Phase 1 — WebSocket transport ────────────────────────────────────────────

describe('Phase 1 — WebSocket /ws endpoint', () => {
  let ctx

  beforeAll(async () => {
    ctx = await startTestServer()
  })
  afterAll(async () => {
    await new Promise(r => ctx.server.close(r))
    await rm(ctx.dir, { recursive: true, force: true })
  })

  it('upgrades HTTP to WebSocket at /ws', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    // Server should send session:state as the first response to join.
    expect(firstMessage).toBeDefined()
    ws.close()
  })

  it('join → session:state response contains the current session snapshot', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    expect(firstMessage.type).toBe('session:state')
    expect(firstMessage.payload).toHaveProperty('messages')
    expect(firstMessage.payload).toHaveProperty('party')
    expect(firstMessage.payload.roomCode).toBe(ROOM_CODE)
    ws.close()
  })

  it('session:state payload includes phase and turnSequence', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    expect(firstMessage.type).toBe('session:state')
    expect(firstMessage.payload).toHaveProperty('phase')
    expect(firstMessage.payload).toHaveProperty('turnSequence')
    expect(['free-roam', 'combat']).toContain(firstMessage.payload.phase)
    expect(typeof firstMessage.payload.turnSequence).toBe('number')
    ws.close()
  })

  it('server responds to ping with pong', async () => {
    const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // Collect next message after joining (presence:update) then send ping.
    // We need to wait for any post-join messages first, then send ping.
    await new Promise(r => setTimeout(r, 50))
    const pongPromise = new Promise(r => ws.once('message', d => r(JSON.parse(d))))
    ws.send(JSON.stringify({ type: 'ping', roomCode: ROOM_CODE }))
    const pong = await pongPromise
    expect(pong.type).toBe('pong')
    ws.close()
  })

  it('rejects a join with an invalid roomCode', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      ...baseJoin, roomCode: '../../evil'
    })
    expect(firstMessage.type).toBe('error')
    expect(firstMessage.payload.code).toMatch(/invalid/i)
    ws.close()
  })

  it('rejects a join with an invalid sessionId', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      ...baseJoin, sessionId: '../../bad-session'
    })
    expect(firstMessage.type).toBe('error')
    expect(firstMessage.payload.code).toMatch(/invalid/i)
    ws.close()
  })

  it('rejects a join with an empty displayName', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      ...baseJoin, displayName: ''
    })
    expect(firstMessage.type).toBe('error')
    expect(firstMessage.payload.code).toBe('invalid_name')
    ws.close()
  })

  it('rejects a join with a displayName that sanitizes to empty (only control chars)', async () => {
    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      ...baseJoin, displayName: '\x00\x01\x02'
    })
    expect(firstMessage.type).toBe('error')
    expect(firstMessage.payload.code).toBe('invalid_name')
    ws.close()
  })

  it('NAME_TAKEN: second join with same displayName (active connection) is rejected', async () => {
    const SESSION = 'b2c3d4e5-0000-0000-0000-000000000001'
    const ROOM = 'dnd-b2c3d4e5'
    const joinOpts = { roomCode: ROOM, sessionId: SESSION, displayName: 'Jordan', lastTurnSequence: 0 }

    const { ws: ws1, firstMessage: msg1 } = await connectClient(ctx.wsBase, joinOpts)
    expect(msg1.type).toBe('session:state') // first join succeeds

    // Second client tries to join with the same displayName while ws1 is still open.
    const { ws: ws2, firstMessage: msg2 } = await connectClient(ctx.wsBase, joinOpts)
    expect(msg2.type).toBe('error')
    expect(msg2.payload.code).toBe('NAME_TAKEN')

    ws1.close()
    ws2.close()
  })

  it('NAME_TAKEN check is case-insensitive', async () => {
    const SESSION = 'c3d4e5f6-0000-0000-0000-000000000002'
    const ROOM = 'dnd-c3d4e5f6'

    const { ws: ws1 } = await connectClient(ctx.wsBase, {
      roomCode: ROOM, sessionId: SESSION, displayName: 'Morgan', lastTurnSequence: 0
    })

    const { ws: ws2, firstMessage: msg2 } = await connectClient(ctx.wsBase, {
      roomCode: ROOM, sessionId: SESSION, displayName: 'morgan', lastTurnSequence: 0
    })
    expect(msg2.type).toBe('error')
    expect(msg2.payload.code).toBe('NAME_TAKEN')

    ws1.close()
    ws2.close()
  })

  it('origin allowlist: connection from a disallowed Origin header is rejected at upgrade', async () => {
    // When the ws client provides a disallowed Origin header, the server MUST
    // respond 403 Forbidden and close the socket before the WebSocket handshake
    // completes. The ws library surfaces this as an 'error' or 'close' event
    // (never as 'open').
    const result = await tryConnect(
      ctx.wsBase,
      baseJoin,
      { headers: { Origin: 'http://evil.example.com' } }
    )
    // Connection must NOT succeed (open must not fire).
    expect(result.opened).toBe(false)
  })

  it('connection without Origin header (test harness / non-browser) is accepted', async () => {
    // No Origin header — used by Node test harness and direct LAN clients.
    // The ws package does not send an Origin header by default.
    const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    expect(firstMessage.type).toBe('session:state')
    ws.close()
  })

  it('unknown message type is dropped (no error response, no crash)', async () => {
    const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // Collect any pending post-join messages first.
    await new Promise(r => setTimeout(r, 50))

    let gotUnexpected = false
    ws.on('message', () => { gotUnexpected = true })
    ws.send(JSON.stringify({ type: 'unknown_future_type', roomCode: ROOM_CODE }))

    // Wait briefly — server should NOT respond to unknown type.
    await new Promise(r => setTimeout(r, 100))
    expect(gotUnexpected).toBe(false)
    ws.close()
  })

  it('malformed JSON frame is handled gracefully (server replies with bad_message error)', async () => {
    const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // Drain any post-join messages.
    await new Promise(r => setTimeout(r, 50))

    const errorPromise = new Promise(r => ws.once('message', d => r(JSON.parse(d))))
    ws.send('not valid json {{{')
    const errMsg = await errorPromise
    expect(errMsg.type).toBe('error')
    expect(errMsg.payload.code).toBe('bad_message')
    ws.close()
  })

  it('presence:update is broadcast to existing clients when a new client joins', async () => {
    const SESSION = 'd4e5f6a7-0000-0000-0000-000000000003'
    const ROOM = 'dnd-d4e5f6a7'

    // First client joins.
    const { ws: ws1 } = await connectClient(ctx.wsBase, {
      roomCode: ROOM, sessionId: SESSION, displayName: 'Riley', lastTurnSequence: 0
    })

    // Set up to collect the next message ws1 receives.
    const presencePromise = new Promise(r => ws1.once('message', d => r(JSON.parse(d))))

    // Second client joins — should trigger a presence:update to ws1.
    const { ws: ws2 } = await connectClient(ctx.wsBase, {
      roomCode: ROOM, sessionId: SESSION, displayName: 'Sam', lastTurnSequence: 0
    })

    const presence = await presencePromise
    expect(presence.type).toBe('presence:update')
    expect(Array.isArray(presence.payload)).toBe(true)
    const names = presence.payload.map(p => p.displayName)
    expect(names).toContain('Riley')
    expect(names).toContain('Sam')

    ws1.close()
    ws2.close()
  })

  it('sessionPath invariant: no .md file is ever named by roomCode (only by sessionId)', async () => {
    const SESSION = 'e5f6a7b8-0000-0000-0000-000000000004'
    const ROOM = 'dnd-e5f6a7b8'

    const { ws } = await connectClient(ctx.wsBase, {
      roomCode: ROOM, sessionId: SESSION, displayName: 'Avery', lastTurnSequence: 0
    })
    ws.close()

    // Wait briefly for any async file operations.
    await new Promise(r => setTimeout(r, 100))

    // No file should be named by roomCode.
    const files = await readdir(ctx.dir).catch(() => [])
    const roomCodeFiles = files.filter(f => f.includes(ROOM))
    expect(roomCodeFiles).toHaveLength(0)
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

  it('exactly one Ollama POST fires for one player action', async () => {})
  it('dm:delta events are broadcast with delta content and turnSequence', async () => {})
  it('dm:done is broadcast with fullText and advances turnSequence by 1', async () => {})
  it('.md file is written to disk after dm:done', async () => {})
  it('second concurrent action is queued: only one Ollama call fires, other gets DM_BUSY', async () => {})
  it('DM_BUSY error is returned to the sender when phase is awaiting-dm', async () => {})
})

// ─── Phase 5 — Combat turn enforcement ────────────────────────────────────────

describe.skip('Phase 5 — NOT_YOUR_TURN and active-player enforcement', () => {
  it('active player action is accepted in combat phase', () => {})
  it('non-active player action is rejected with NOT_YOUR_TURN', () => {})
  it('any player action is rejected with DM_BUSY in awaiting-dm phase', () => {})
  it('after dm:done with all isActive=false, all players can act (free-roam restored)', () => {})
  it('turnSequence advances by exactly 1 per completed DM turn', () => {})
  it('two clients acting within 10ms in free-roam: exactly one succeeds, one gets DM_BUSY', () => {})
})

// ─── Phase 6 — Presence, disconnect, rejoin ────────────────────────────────────

describe.skip('Phase 6 — disconnect detection and rejoin', () => {
  it('server broadcasts presence:update when a client disconnects', () => {})
  it('rejoining client with same displayName receives full session:state when lastTurnSequence is stale', () => {})
  it('DM stream completes and is persisted even when the triggering client disconnects mid-stream', () => {})
  it('server does not crash or deadlock when the active combat player disconnects', () => {})
  it('orphaned room is garbage-collected from memory after 30 minutes of inactivity', () => {})
})

// ─── Phase 7 — Migration cutover / backward-compat ────────────────────────────

describe.skip('Phase 7 — HTTP endpoints still pass against updated schema (R2 regression)', () => {
  let ctx

  beforeAll(async () => {})
  afterAll(async () => {})

  it('PUT a v2 payload → 200; GET returns it with v2 fields intact', () => {})
  it('PUT a v1-shaped payload (no phase/roomCode/turnSequence) → 200; GET returns v2 defaults', () => {})
  it('409 LWW guard still applies to concurrent PUTs in v2 schema', () => {})
  it('single-player session (one connected client) is indistinguishable from today', () => {})
  it('M7 strictly-newer gate still blocks stale adoption on the WebSocket session:update path', () => {})
})
