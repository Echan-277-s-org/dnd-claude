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
import { toMarkdown, fromMarkdown, serializeSession } from '../src/lib/session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.resolve(__dirname, 'sessions')
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

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
function sanitizeDisplayName(s) {
  return String(s ?? '')
    .trim()
    .replace(/[<>&"']/g, '')
    // Strip Unicode control characters (category Cc)
    .replace(/\p{Cc}/gu, '')
    .slice(0, 64)
}

export function createSyncServer({ sessionsDir = DEFAULT_DIR } = {}) {
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
      const payload = serializeSession(
        {
          // sessionId is taken from the path (already validated), never trusted from body.
          campaign: { ...(body.campaign ?? {}), sessionId: id },
          messages: body.messages,
          sessionLog: body.sessionLog,
          party: body.party,
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

  // ─── Phase 2: handle an inbound action message ───────────────────────────────
  async function handleAction(ws, msg) {
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

      // Serialize within the room's action queue.
      await withRoomLock(room, async () => {
        const savedAt = new Date().toISOString()

        // Echo path (Phase 2 placeholder — Phase 3 replaces with Ollama call).
        // Append the user message to the room's in-memory messages array.
        const userMsg = { role: 'user', content, id: randomUUID() }
        room.messages = [...(room.messages ?? []), userMsg]

        // Increment turn counter.
        room.turnSequence = (room.turnSequence ?? 0) + 1

        // Broadcast session:update to ALL clients in the room (including sender).
        broadcast(room, {
          type: 'session:update',
          roomCode: room.roomCode,
          payload: {
            messages: room.messages,
            party: room.party ?? [],
            phase: room.phase ?? 'free-roam',
            turnSequence: room.turnSequence,
            savedAt,
          },
        })
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws] handleAction error:', err?.message ?? err)
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 })

  // Catch-all WS server errors (e.g. listen failures) — never let them crash the process.
  wss.on('error', err => {
    // eslint-disable-next-line no-console
    console.error('[wss] server error:', err?.message ?? err)
  })

  // Build the presence array for a room from its current clients map.
  function presenceList(room) {
    return Array.from(room.clients.values()).map(c => ({
      displayName: c.displayName,
      status: 'connected',
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
      const { roomCode, sessionId, displayName: rawDisplayName, lastTurnSequence } = msg ?? {}

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

      // Ensure room exists in-memory (keyed by sessionId per sec item I).
      if (!rooms.has(sessionId)) {
        rooms.set(sessionId, {
          sessionId,
          roomCode,
          clients: new Map(),
          phase: 'free-roam',
          turnSequence: 0,
          messages: [],   // Phase 2: in-memory message history
          party: [],      // Phase 2: in-memory party state
          actionQueue: Promise.resolve(), // Phase 2: per-room serialization queue
        })
      }
      const room = rooms.get(sessionId)

      // NAME_TAKEN: check if displayName (trimmed, lowercased) is already bound
      // to an OPEN connection in this room (security item J).
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

      // Load any stored session (reads from .md, never keyed by roomCode).
      const stored = await readStored(sessionId)

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
      room.clients.set(ws, { displayName, partyId, connectedAt: new Date().toISOString() })

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
      }
      const sendSnapshot = typeof lastTurnSequence === 'number' && lastTurnSequence < room.turnSequence
        ? inMemorySnapshot
        : snapshot

      // Send session:state to the joining client.
      ws.send(JSON.stringify({ type: 'session:state', roomCode, payload: sendSnapshot }))

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
  function handleClose(ws) {
    for (const [sessionId, room] of rooms) {
      if (room.clients.has(ws)) {
        room.clients.delete(ws)
        // Broadcast updated presence to remaining clients.
        if (room.clients.size > 0) {
          broadcast(room, {
            type: 'presence:update',
            payload: presenceList(room),
          })
        }
        // Optionally clean up empty rooms (keep them in-memory until Phase 6 GC).
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
