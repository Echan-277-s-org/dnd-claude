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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
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
 * Mock Ollama — a local HTTP server on a random port that answers POST /api/chat
 * with deterministic NDJSON chunks (the `stream: true` wire format). Records the
 * number of POSTs (getCallCount) and the last captured request body so prompt
 * assembly can be asserted. The sync server is pointed at it via OLLAMA_HOST.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.chunks] — content deltas to stream back, one NDJSON line each
 * @param {boolean} [opts.hang] — if true, never finish the response (timeout test)
 */
async function startMockOllama({ chunks, hang = false } = {}) {
  let callCount = 0
  let lastBody = null
  const deltas = chunks ?? [
    'The tavern falls quiet as you enter. ',
    'A hooded figure watches from the corner.',
    // Trailing structured blocks the server must parse + strip.
    '\n```party\n[{"name":"Aelis","role":"Ranger","hpPct":90,"isActive":false}]\n```',
  ]

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) {
      res.statusCode = 404
      res.end()
      return
    }
    callCount += 1
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      try { lastBody = JSON.parse(raw) } catch { lastBody = raw }
      if (hang) {
        // Never write/end — the server's AbortController must time out.
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      // Stream one NDJSON object per delta, then a final done:true line.
      for (const delta of deltas) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: delta }, done: false }) + '\n')
      }
      res.write(JSON.stringify({ done: true }) + '\n')
      res.end()
    })
  })

  // Track open sockets so a hung request can't block server.close() in afterEach.
  const sockets = new Set()
  server.on('connection', s => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    server,
    host: `127.0.0.1:${port}`,
    getCallCount: () => callCount,
    getLastBody: () => lastBody,
    destroy: () => { for (const s of sockets) s.destroy() },
  }
}

/**
 * Remove a temp dir, retrying on Windows ENOTEMPTY/EBUSY (a just-renamed .md file
 * can briefly hold a handle after the atomic write).
 */
async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === 4) return // give up silently — it's a temp dir
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

/**
 * Collect WS messages until a predicate matches one, or time out.
 * Resolves with the matching message.
 */
function waitForMessage(ws, predicate, timeoutMs = 95000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error('waitForMessage timed out'))
    }, timeoutMs)
    function onMsg(data) {
      let parsed
      try { parsed = JSON.parse(data) } catch { return }
      if (predicate(parsed)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(parsed)
      }
    }
    ws.on('message', onMsg)
  })
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

describe('Phase 2 — session:update broadcast to all clients', () => {
  let ctx
  let prevOllamaHost

  // Use distinct session/room IDs to avoid cross-test state collisions.
  const P2_SESSION = 'f6a7b8c9-0000-0000-0000-000000000010'
  const P2_ROOM = 'dnd-f6a7b8c9'
  const p2Join = { roomCode: P2_ROOM, sessionId: P2_SESSION, lastTurnSequence: 0 }

  beforeAll(async () => {
    // Phase 3 replaced the echo handler with a real DM trigger, so a player action
    // now drives a (mock) Ollama call. The session:update that carries the user
    // message + advanced turnSequence is the FINAL one, after dm:done. Point the
    // server at a deterministic mock so these broadcast assertions still hold.
    prevOllamaHost = process.env.OLLAMA_HOST
    ctx = await startTestServer()
    ctx.mockOllama = await startMockOllama({ chunks: ['The DM responds.'] })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
  })
  afterAll(async () => {
    if (prevOllamaHost === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prevOllamaHost
    await new Promise(r => ctx.server.close(r))
    ctx.mockOllama.destroy()
    await new Promise(r => ctx.mockOllama.server.close(r))
    await cleanupDir(ctx.dir)
  })

  it('client B receives session:update with the user message when client A acts', async () => {
    const clientA = await connectClient(ctx.wsBase, { ...p2Join, displayName: 'Alex' })
    expect(clientA.firstMessage.type).toBe('session:state')

    const clientB = await connectClient(ctx.wsBase, { ...p2Join, displayName: 'Jordan' })
    expect(clientB.firstMessage.type).toBe('session:state')

    // Send action from A — B should receive a session:update that (eventually,
    // after dm:done) carries A's user message.
    const updatePromiseB = waitForMessage(
      clientB.ws,
      m => m.type === 'session:update' &&
        m.payload.messages.some(x => x.content === 'I look around the tavern.')
    )
    clientA.ws.send(JSON.stringify({
      type: 'action',
      roomCode: P2_ROOM,
      payload: { content: 'I look around the tavern.', type: 'user' },
    }))

    const updateB = await updatePromiseB
    expect(updateB.type).toBe('session:update')
    expect(updateB.payload.messages.length).toBeGreaterThan(0)
    expect(updateB.payload.messages.some(m => m.content === 'I look around the tavern.')).toBe(true)

    clientA.ws.close()
    clientB.ws.close()
  })

  it('phase field is included in every session:update', async () => {
    const P2B_SESSION = 'a7b8c9d0-0000-0000-0000-000000000011'
    const P2B_ROOM = 'dnd-a7b8c9d0'
    const clientA = await connectClient(ctx.wsBase, {
      roomCode: P2B_ROOM, sessionId: P2B_SESSION, displayName: 'Alex', lastTurnSequence: 0,
    })
    expect(clientA.firstMessage.type).toBe('session:state')

    // The FIRST session:update is the awaiting-dm phase lock; assert it carries phase.
    const found = waitForMessage(clientA.ws, m => m.type === 'session:update')

    clientA.ws.send(JSON.stringify({
      type: 'action',
      roomCode: P2B_ROOM,
      payload: { content: 'Test action', type: 'user' },
    }))

    const update = await found
    expect(update.payload).toHaveProperty('phase')
    expect(['free-roam', 'combat', 'awaiting-dm', 'resolving']).toContain(update.payload.phase)

    // Drain to dm:done so the room returns to a resting phase before the next test.
    await waitForMessage(clientA.ws, m => m.type === 'dm:done')
    clientA.ws.close()
  })

  it('reconnecting client with stale lastTurnSequence receives session:state (not delta)', async () => {
    const P2C_SESSION = 'b8c9d0e1-0000-0000-0000-000000000012'
    const P2C_ROOM = 'dnd-b8c9d0e1'

    // First client joins and sends an action to advance turnSequence.
    const clientA = await connectClient(ctx.wsBase, {
      roomCode: P2C_ROOM, sessionId: P2C_SESSION, displayName: 'Alex', lastTurnSequence: 0,
    })
    expect(clientA.firstMessage.type).toBe('session:state')
    const initialSeq = clientA.firstMessage.payload.turnSequence

    // Send an action and wait for the FINAL session:update (after dm:done) that
    // carries the advanced turnSequence.
    const donePromise = waitForMessage(clientA.ws, m => m.type === 'dm:done')
    clientA.ws.send(JSON.stringify({
      type: 'action',
      roomCode: P2C_ROOM,
      payload: { content: 'I advance the turn.', type: 'user' },
    }))
    const doneMsg = await donePromise
    const advancedSeq = doneMsg.payload.turnSequence
    expect(advancedSeq).toBeGreaterThan(initialSeq)
    clientA.ws.close()

    // Now reconnect with the stale lastTurnSequence (0 < advancedSeq).
    const staleClient = await connectClient(ctx.wsBase, {
      roomCode: P2C_ROOM, sessionId: P2C_SESSION, displayName: 'Alex', lastTurnSequence: 0,
    })
    // Server must send session:state (full snapshot) because lastTurnSequence < turnSequence.
    expect(staleClient.firstMessage.type).toBe('session:state')
    // The snapshot's turnSequence must be at least the advanced value.
    expect(staleClient.firstMessage.payload.turnSequence).toBeGreaterThanOrEqual(advancedSeq)
    staleClient.ws.close()
  })
})

// ─── Phase 3 — Single DM trigger / mock-Ollama guarantee ──────────────────────

describe('Phase 3 — exactly one Ollama call per action', () => {
  let ctx
  let prevOllamaHost

  // Distinct session/room per test to avoid cross-test in-memory room collisions.
  let seq = 0
  function freshIds() {
    seq += 1
    const hex = String(seq).padStart(8, '0')
    return { sessionId: `${hex}-0000-0000-0000-000000000300`, roomCode: `dnd-${hex}` }
  }

  beforeEach(async () => {
    prevOllamaHost = process.env.OLLAMA_HOST
    ctx = await startTestServer()
  })
  afterEach(async () => {
    if (prevOllamaHost === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prevOllamaHost
    await new Promise(r => ctx.server.close(r))
    if (ctx.mockOllama) {
      ctx.mockOllama.destroy() // force-close any hung sockets before close()
      await new Promise(r => ctx.mockOllama.server.close(r))
    }
    await cleanupDir(ctx.dir)
  })

  it('exactly one Ollama POST fires for one player action', async () => {
    ctx.mockOllama = await startMockOllama()
    process.env.OLLAMA_HOST = ctx.mockOllama.host
    const { sessionId, roomCode } = freshIds()

    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })
    expect(firstMessage.type).toBe('session:state')

    const done = waitForMessage(ws, m => m.type === 'dm:done')
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'I enter the tavern.', type: 'user' },
    }))
    await done

    expect(ctx.mockOllama.getCallCount()).toBe(1)
    // The server-assembled request must carry the full prompt-assembly pipeline.
    const body = ctx.mockOllama.getLastBody()
    expect(body.stream).toBe(true)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toMatch(/Dungeon Master/i) // buildSystemPrompt
    expect(body.messages.some(m => m.content === 'I enter the tavern.')).toBe(true)
    expect(body.options).toMatchObject({
      num_ctx: 8192, num_predict: 900, temperature: 0.8,
      top_p: 0.9, top_k: 40, repeat_penalty: 1.15, repeat_last_n: 256,
    })
    ws.close()
  })

  it('dm:delta events are broadcast with delta content and turnSequence', async () => {
    ctx.mockOllama = await startMockOllama({ chunks: ['Hello ', 'world.'] })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
    const { sessionId, roomCode } = freshIds()

    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })
    const baseSeq = firstMessage.payload.turnSequence

    const delta = waitForMessage(ws, m => m.type === 'dm:delta')
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Speak.', type: 'user' },
    }))
    const d = await delta
    expect(typeof d.payload.delta).toBe('string')
    expect(d.payload.delta.length).toBeGreaterThan(0)
    expect(d.payload.turnSequence).toBe(baseSeq + 1)
    expect(typeof d.payload.assistantId).toBe('string')
    ws.close()
  })

  it('dm:done is broadcast with fullText and advances turnSequence by 1', async () => {
    ctx.mockOllama = await startMockOllama({ chunks: ['A complete reply.'] })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
    const { sessionId, roomCode } = freshIds()

    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })
    const baseSeq = firstMessage.payload.turnSequence

    const done = waitForMessage(ws, m => m.type === 'dm:done')
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Go.', type: 'user' },
    }))
    const d = await done
    expect(d.payload.error).toBeUndefined()
    expect(d.payload.fullText).toContain('A complete reply.')
    expect(d.payload.turnSequence).toBe(baseSeq + 1)
    ws.close()
  })

  it('.md file is written to disk after dm:done', async () => {
    ctx.mockOllama = await startMockOllama({ chunks: ['Persisted narration.'] })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
    const { sessionId, roomCode } = freshIds()

    const { ws } = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })

    const done = waitForMessage(ws, m => m.type === 'dm:done')
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Write it down.', type: 'user' },
    }))
    await done
    // Give the atomic rename a beat to settle on disk.
    await new Promise(r => setTimeout(r, 50))

    const files = await readdir(ctx.dir)
    // The .md MUST be named by sessionId, never roomCode (sec I).
    expect(files).toContain(`${sessionId}.md`)
    expect(files.some(f => f.includes(roomCode))).toBe(false)
    ws.close()
  })

  it('second concurrent action is queued: only one Ollama call fires, other gets DM_BUSY', async () => {
    ctx.mockOllama = await startMockOllama({ chunks: ['One DM reply.'] })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
    const { sessionId, roomCode } = freshIds()

    const a = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })
    const b = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Jordan', lastTurnSequence: 0,
    })

    // B watches for an error (expects DM_BUSY); A watches for dm:done.
    const bError = waitForMessage(b.ws, m => m.type === 'error', 5000)
    const aDone = waitForMessage(a.ws, m => m.type === 'dm:done')

    // Fire both in the same tick — A enters the queue, B should be rejected.
    a.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'A acts.', type: 'user' },
    }))
    b.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'B acts.', type: 'user' },
    }))

    const err = await bError
    expect(err.payload.code).toBe('DM_BUSY')
    await aDone

    // Exactly one Ollama POST despite two concurrent actions.
    expect(ctx.mockOllama.getCallCount()).toBe(1)
    a.ws.close()
    b.ws.close()
  })

  it('DM_BUSY error is returned to the sender when phase is awaiting-dm', async () => {
    // Hang the mock so the room stays in awaiting-dm; a second action from the
    // SAME connection while busy must be rejected with DM_BUSY.
    ctx.mockOllama = await startMockOllama({ hang: true })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
    const { sessionId, roomCode } = freshIds()

    const { ws, firstMessage } = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })
    expect(firstMessage.type).toBe('session:state')

    // First action — kicks off the (hanging) DM call, room → awaiting-dm.
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'First action.', type: 'user' },
    }))
    // Wait for the awaiting-dm phase broadcast so the room is provably busy.
    await waitForMessage(ws, m => m.type === 'session:update' && m.payload.phase === 'awaiting-dm', 5000)

    // Second action while busy — must come back DM_BUSY (not enqueued, no 2nd call).
    const busy = waitForMessage(ws, m => m.type === 'error', 5000)
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Second action.', type: 'user' },
    }))
    const err = await busy
    expect(err.payload.code).toBe('DM_BUSY')
    expect(ctx.mockOllama.getCallCount()).toBe(1)
    ws.close()
  })
})

// ─── Phase 4 — Free-roam multi-client (MC-9 latency smoke) ───────────────────
//
// MC-9: CI upper-bound latency smoke test — two WS clients in one room; client A
// sends an action (with mock Ollama); assert client B receives the resulting
// session:update/dm:done within < 2000ms (CI-safe upper bound per §7 Phase 4).
//
// This describe is NOT skipped — it is part of the Phase 4 gate.

describe('Phase 4 — MC-9 latency smoke: cross-client session:update < 2000ms', () => {
  let ctx
  let prevOllamaHost

  let p4seq = 0
  function freshIds() {
    p4seq += 1
    const hex = String(p4seq).padStart(8, '0')
    return { sessionId: `${hex}-0000-0000-0000-000000000400`, roomCode: `dnd-p4${hex}` }
  }

  beforeEach(async () => {
    prevOllamaHost = process.env.OLLAMA_HOST
    ctx = await startTestServer()
    ctx.mockOllama = await startMockOllama({ chunks: ['The wind picks up.'] })
    process.env.OLLAMA_HOST = ctx.mockOllama.host
  })
  afterEach(async () => {
    if (prevOllamaHost === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prevOllamaHost
    await new Promise(r => ctx.server.close(r))
    ctx.mockOllama.destroy()
    await new Promise(r => ctx.mockOllama.server.close(r))
    await cleanupDir(ctx.dir)
  })

  it('MC-9: client B receives dm:done within 2000ms of client A sending an action', async () => {
    const { sessionId, roomCode } = freshIds()

    const clientA = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'PlayerA', lastTurnSequence: 0,
    })
    expect(clientA.firstMessage.type).toBe('session:state')

    const clientB = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'PlayerB', lastTurnSequence: 0,
    })
    expect(clientB.firstMessage.type).toBe('session:state')

    // Record time immediately before client A sends the action.
    const t0 = Date.now()

    // Client B waits for dm:done (which arrives after dm:delta stream).
    const bDone = waitForMessage(clientB.ws, m => m.type === 'dm:done', 2000)

    // Client A fires the action.
    clientA.ws.send(JSON.stringify({
      type: 'action',
      roomCode,
      payload: { content: 'I look around.', type: 'user' },
    }))

    // Assert B receives dm:done within 2000ms.
    const done = await bDone
    const elapsed = Date.now() - t0
    expect(done.type).toBe('dm:done')
    expect(elapsed).toBeLessThan(2000)

    clientA.ws.close()
    clientB.ws.close()
  })

  it('MC-9: client B receives session:update with the DM message within 2000ms', async () => {
    const { sessionId, roomCode } = freshIds()

    const clientA = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'PlayerA', lastTurnSequence: 0,
    })
    const clientB = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'PlayerB', lastTurnSequence: 0,
    })

    const t0 = Date.now()

    // Wait for the FINAL session:update (after dm:done) that includes the assistant message.
    const bUpdate = waitForMessage(
      clientB.ws,
      m => m.type === 'session:update' &&
        Array.isArray(m.payload?.messages) &&
        m.payload.messages.some(x => x.role === 'assistant'),
      2000
    )

    clientA.ws.send(JSON.stringify({
      type: 'action',
      roomCode,
      payload: { content: 'Describe the scene.', type: 'user' },
    }))

    const update = await bUpdate
    const elapsed = Date.now() - t0
    expect(update.payload.messages.some(m => m.role === 'assistant')).toBe(true)
    expect(elapsed).toBeLessThan(2000)

    clientA.ws.close()
    clientB.ws.close()
  })

  it('MC-9: both clients receive dm:delta events during streaming', async () => {
    const { sessionId, roomCode } = freshIds()

    const clientA = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'PlayerA', lastTurnSequence: 0,
    })
    const clientB = await connectClient(ctx.wsBase, {
      roomCode, sessionId, displayName: 'PlayerB', lastTurnSequence: 0,
    })

    const aDelta = waitForMessage(clientA.ws, m => m.type === 'dm:delta', 2000)
    const bDelta = waitForMessage(clientB.ws, m => m.type === 'dm:delta', 2000)

    clientA.ws.send(JSON.stringify({
      type: 'action',
      roomCode,
      payload: { content: 'What do you see?', type: 'user' },
    }))

    const [a, b] = await Promise.all([aDelta, bDelta])
    expect(a.type).toBe('dm:delta')
    expect(b.type).toBe('dm:delta')
    // Both should carry the same assistantId (same DM streaming turn).
    expect(a.payload.assistantId).toBe(b.payload.assistantId)

    clientA.ws.close()
    clientB.ws.close()
  })
})

// ─── Phase 5 — Combat turn enforcement ────────────────────────────────────────

describe('Phase 5 — NOT_YOUR_TURN and active-player enforcement', () => {
  let ctx
  let prevOllamaHost

  // Unique session IDs per-test to avoid cross-test room state collisions.
  let p5seq = 0
  function freshIds() {
    p5seq += 1
    const hex = String(p5seq).padStart(8, '0')
    return { sessionId: `${hex}-0000-0000-0000-000000000500`, roomCode: `dnd-p5${hex}` }
  }

  // Start a mock Ollama that emits a party block putting `activePlayerName`
  // into isActive:true. Returns the mock so the test can swap it out.
  async function startCombatOllama(activePlayerName) {
    const partyBlock = JSON.stringify([
      { name: activePlayerName, role: 'Fighter', hpPct: 90, isActive: true },
      { name: 'Wren', role: 'Rogue', hpPct: 80, isActive: false },
    ])
    return startMockOllama({
      chunks: [
        'Combat begins! ',
        `\n\`\`\`party\n${partyBlock}\n\`\`\``,
      ],
    })
  }

  // Start a mock Ollama that returns all-inactive party (→ free-roam).
  async function startFreeRoamOllama() {
    const partyBlock = JSON.stringify([
      { name: 'Theron', role: 'Fighter', hpPct: 90, isActive: false },
      { name: 'Wren', role: 'Rogue', hpPct: 80, isActive: false },
    ])
    return startMockOllama({
      chunks: [
        'Peace restored. ',
        `\n\`\`\`party\n${partyBlock}\n\`\`\``,
      ],
    })
  }

  // Cleanly swap the mock Ollama within a test. Destroys the old one and
  // returns the new one (already set in ctx.mockOllama and OLLAMA_HOST).
  async function swapMock(newMock) {
    if (ctx.mockOllama) {
      ctx.mockOllama.destroy()
      await new Promise(r => ctx.mockOllama.server.close(r))
    }
    ctx.mockOllama = newMock
    process.env.OLLAMA_HOST = newMock.host
  }

  // Track open clients so we can force-terminate them in afterEach.
  // A test that fails mid-stream leaves live WS connections that block server.close().
  const openClients = new Set()

  async function p5Connect(wsBase, joinPayload) {
    const result = await connectClient(wsBase, joinPayload)
    openClients.add(result.ws)
    return result
  }

  beforeEach(async () => {
    prevOllamaHost = process.env.OLLAMA_HOST
    ctx = await startTestServer()
    openClients.clear()
  })
  afterEach(async () => {
    // Force-terminate any clients the test left open (avoids server.close() stall).
    for (const ws of openClients) {
      try { ws.terminate() } catch { /* already gone */ }
    }
    openClients.clear()
    if (prevOllamaHost === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prevOllamaHost
    // closeAllConnections() (Node 18.2+) forcibly kills open keep-alive sockets.
    if (typeof ctx.server.closeAllConnections === 'function') {
      ctx.server.closeAllConnections()
    }
    await new Promise(r => ctx.server.close(r))
    if (ctx.mockOllama) {
      try { ctx.mockOllama.destroy() } catch { /* already destroyed */ }
      await new Promise(r => ctx.mockOllama.server.close(r)).catch(() => {})
    }
    await cleanupDir(ctx.dir)
  }, 15000)

  it('active player action is accepted in combat phase', async () => {
    // Strategy: only Theron joins the room (no Wren, keeps it simple). Theron acts
    // once with the combat mock → room enters combat with Theron as active player.
    // Then Theron acts again → should be accepted (not NOT_YOUR_TURN) → dm:done fires.
    await swapMock(await startCombatOllama('Theron'))
    const { sessionId, roomCode } = freshIds()

    const theron = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Theron', lastTurnSequence: 0,
    })
    expect(theron.firstMessage.type).toBe('session:state')

    // Step 1: Trigger a free-roam action.
    // Listen for dm:done THEN the final session:update (which carries phase:combat).
    const done1 = waitForMessage(theron.ws, m => m.type === 'dm:done', 10000)
    const combat1 = waitForMessage(
      theron.ws,
      m => m.type === 'session:update' && m.payload.phase === 'combat',
      10000
    )
    theron.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Attack!', type: 'user' },
    }))
    await done1   // wait for dm:done first
    await combat1 // then wait for the combat session:update (already queued or arriving next)

    // Step 2: swap to a simple mock (no party block → phase computed from unchanged party).
    await swapMock(await startMockOllama({ chunks: ['Theron strikes!'] }))

    // Step 3: Wait min-interval, then Theron acts in combat — should be ACCEPTED.
    await new Promise(r => setTimeout(r, 600))
    const done2 = waitForMessage(theron.ws, m => m.type === 'dm:done', 10000)
    theron.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'I strike the goblin.', type: 'user' },
    }))
    const result = await done2
    // dm:done with no error → action was accepted (not NOT_YOUR_TURN).
    expect(result.payload.error).toBeUndefined()

    theron.ws.close()
  }, 30000)

  it('non-active player action is rejected with NOT_YOUR_TURN', async () => {
    // Get the room into combat with Theron as the active player.
    await swapMock(await startCombatOllama('Theron'))
    const { sessionId, roomCode } = freshIds()

    const theron = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Theron', lastTurnSequence: 0,
    })
    const wren = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Wren', lastTurnSequence: 0,
    })

    // Set up listener before sending.
    const combatPhasePromise = waitForMessage(
      wren.ws,
      m => m.type === 'session:update' && m.payload.phase === 'combat',
      10000
    )
    theron.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Start combat!', type: 'user' },
    }))
    await combatPhasePromise

    // Wren (NOT the active player) tries to act — must be rejected with NOT_YOUR_TURN.
    const notYourTurn = waitForMessage(wren.ws, m => m.type === 'error', 3000)
    wren.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'I also attack!', type: 'user' },
    }))
    const err = await notYourTurn
    expect(err.type).toBe('error')
    expect(err.payload.code).toBe('NOT_YOUR_TURN')

    theron.ws.close()
    wren.ws.close()
  }, 20000)

  it('any player action is rejected with DM_BUSY in awaiting-dm phase', async () => {
    // Hang mock: the room gets stuck in awaiting-dm.
    await swapMock(await startMockOllama({ hang: true }))
    const { sessionId, roomCode } = freshIds()

    const theron = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Theron', lastTurnSequence: 0,
    })
    const wren = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Wren', lastTurnSequence: 0,
    })

    // Set up listener before sending.
    const awaitingDmPromise = waitForMessage(
      theron.ws,
      m => m.type === 'session:update' && m.payload.phase === 'awaiting-dm',
      5000
    )
    theron.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'First.', type: 'user' },
    }))
    await awaitingDmPromise

    // Wren tries to act while the room is awaiting-dm → DM_BUSY.
    const wrenError = waitForMessage(wren.ws, m => m.type === 'error', 3000)
    wren.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Wren acts.', type: 'user' },
    }))
    const err = await wrenError
    expect(err.payload.code).toBe('DM_BUSY')

    theron.ws.close()
    wren.ws.close()
  }, 15000)

  it('after dm:done with all isActive=false, all players can act (free-roam restored)', async () => {
    // Step 1: Emit a party block with all isActive:false → free-roam.
    await swapMock(await startFreeRoamOllama())
    const { sessionId, roomCode } = freshIds()

    const theron = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Theron', lastTurnSequence: 0,
    })
    const wren = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Wren', lastTurnSequence: 0,
    })

    // Theron fires the first action; mock returns free-roam party.
    const freeRoamPromise = waitForMessage(
      wren.ws,
      m => m.type === 'session:update' && m.payload.phase === 'free-roam',
      10000
    )
    theron.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Peace.', type: 'user' },
    }))
    await freeRoamPromise

    // Step 2: swap to a fresh mock for Wren's turn.
    await swapMock(await startMockOllama({ chunks: ['Wren acts freely.'] }))

    // Wren acts — should be accepted (free-roam, no turn restriction).
    const done2 = waitForMessage(wren.ws, m => m.type === 'dm:done', 10000)
    wren.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Wren acts freely.', type: 'user' },
    }))
    const result = await done2
    expect(result.payload.error).toBeUndefined()

    theron.ws.close()
    wren.ws.close()
  }, 30000)

  it('turnSequence advances by exactly 1 per completed DM turn', async () => {
    await swapMock(await startMockOllama({ chunks: ['Turn done.'] }))
    const { sessionId, roomCode } = freshIds()

    const { ws, firstMessage } = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alex', lastTurnSequence: 0,
    })
    const initialSeq = firstMessage.payload.turnSequence

    // First turn.
    const done1 = waitForMessage(ws, m => m.type === 'dm:done', 10000)
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Turn 1.', type: 'user' },
    }))
    const d1 = await done1
    expect(d1.payload.turnSequence).toBe(initialSeq + 1)

    // Swap mock for the second turn.
    await swapMock(await startMockOllama({ chunks: ['Turn 2 done.'] }))

    // Wait for the ACTION_MIN_INTERVAL_MS (500ms) to pass before acting again.
    await new Promise(r => setTimeout(r, 600))

    const done2 = waitForMessage(ws, m => m.type === 'dm:done', 10000)
    ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'Turn 2.', type: 'user' },
    }))
    const d2 = await done2
    expect(d2.payload.turnSequence).toBe(initialSeq + 2)

    ws.close()
  }, 20000)

  it('two clients acting within ~10ms in free-roam: exactly one succeeds, one gets DM_BUSY', async () => {
    await swapMock(await startMockOllama({ chunks: ['One DM reply.'] }))
    const { sessionId, roomCode } = freshIds()

    const a = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Alpha', lastTurnSequence: 0,
    })
    const b = await p5Connect(ctx.wsBase, {
      roomCode, sessionId, displayName: 'Beta', lastTurnSequence: 0,
    })

    // Set up listeners BEFORE sending both actions in the same tick.
    const aError = waitForMessage(a.ws, m => m.type === 'error', 5000)
    const bError = waitForMessage(b.ws, m => m.type === 'error', 5000)
    const aDone = waitForMessage(a.ws, m => m.type === 'dm:done', 10000)
    const bDone = waitForMessage(b.ws, m => m.type === 'dm:done', 10000)

    // Fire both in the same synchronous tick.
    a.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'A acts.', type: 'user' },
    }))
    b.ws.send(JSON.stringify({
      type: 'action', roomCode, payload: { content: 'B acts.', type: 'user' },
    }))

    // One of {a,b} gets DM_BUSY; the other gets dm:done.
    // Collect whichever error or done arrives first.
    const firstOutcome = await Promise.race([
      aError.then(e => ({ who: 'a', type: 'error', code: e.payload.code })),
      bError.then(e => ({ who: 'b', type: 'error', code: e.payload.code })),
      aDone.then(d => ({ who: 'a', type: 'done', seq: d.payload.turnSequence })),
      bDone.then(d => ({ who: 'b', type: 'done', seq: d.payload.turnSequence })),
    ])

    if (firstOutcome.type === 'error') {
      // The first resolved was a DM_BUSY — valid.
      expect(firstOutcome.code).toBe('DM_BUSY')
      // The other connection should get dm:done.
      const otherDone = firstOutcome.who === 'a' ? bDone : aDone
      await otherDone
    } else {
      // The first resolved was dm:done. The other should get DM_BUSY.
      const otherError = firstOutcome.who === 'a' ? bError : aError
      const err = await otherError
      expect(err.payload.code).toBe('DM_BUSY')
    }

    // Exactly one Ollama POST fired despite two concurrent actions.
    expect(ctx.mockOllama.getCallCount()).toBe(1)

    a.ws.close()
    b.ws.close()
  }, 20000)
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
