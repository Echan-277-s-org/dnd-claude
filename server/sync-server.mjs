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
import { toMarkdown, fromMarkdown, serializeSession, applyPartyUpdate } from '../src/lib/session.js'
import { getGenre } from '../src/lib/genres.js'

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

// ─── Phase 3: structured-block parser (server copy of Chat.jsx L18-42) ─────────
// The architecture sanctions a verbatim server copy of the small parser so the
// DM proxy applies party/check/verdict blocks identically to the client.
// NOTE: DM_BLOCK_TAGS is the three LLM-owned tags (party/check/verdict). The
// inbound sanitizer below uses the wider BLOCK_TAGS set (includes 'session').
const DM_BLOCK_TAGS = ['party', 'check', 'verdict']
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

          // (3b) Build the user message; record a server-side dice event so a forged
          // verdict.roll (one not matching the real roll) can be discarded later.
          const userMsg = { role: 'user', content, id: randomUUID() }
          if (actionType === 'dice') {
            const parsed = parseDiceContent(payload?.content) ?? {
              die: payload?.die ?? null,
              result: payload?.result != null ? Number(payload.result) : null,
            }
            room.lastDiceEvent = {
              die: parsed.die,
              result: parsed.result,
              turnSequence: room.turnSequence ?? 0,
            }
          }

          // (3c) Assemble the prompt EXACTLY like Chat.jsx#sendMessage.
          const engine = getGenre(room.campaign?.genre).engine
          const systemPrompt = engine.buildSystemPrompt(room.campaign ?? {})
          const baseMessages = room.messages ?? []
          const entities = engine.extractEntities(baseMessages)
          const systemContent = entities.length
            ? `${systemPrompt}\n\n---\nEstablished entities so far (stay consistent with these named NPCs, locations, and items): ${entities.join(', ')}.`
            : systemPrompt

          // Most-recent dice index so pendingCheck folds into the right dice line.
          const lastDiceIdx = (() => {
            for (let i = baseMessages.length - 1; i >= 0; i--) {
              if (baseMessages[i].role === 'dice') return i
            }
            return -1
          })()

          const apiMessages = engine.trimContext([
            ...baseMessages.map((m, i) => {
              if (m.role !== 'dice') return m
              const checkCtx =
                i === lastDiceIdx && pendingCheck
                  ? ` | pending check: ${pendingCheck.skill} DC ${pendingCheck.dc}`
                  : ''
              return { role: 'user', content: `[Dice roll: ${m.die} → ${m.result}${checkCtx}]` }
            }),
            userMsg,
          ])

          // (3d) Validate the model against the allowlist (sec H).
          const model = MODEL_RE.test(String(room.campaign?.model ?? ''))
            ? room.campaign.model
            : DEFAULT_MODEL

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
                num_ctx: 8192,
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
              } catch {
                // incomplete JSON chunk — skip (matches Chat.jsx)
              }
            }
          }

          // ── (4) Stream success: append the user message, parse blocks, persist
          room.messages = [...baseMessages, userMsg]

          // verdict — discard a forged roll that doesn't match the server's record.
          const verdictRaw = extractBlock('verdict', fullText)
          if (verdictRaw?.result === 'PASS' || verdictRaw?.result === 'FAIL') {
            const forged =
              verdictRaw.roll != null &&
              room.lastDiceEvent &&
              verdictRaw.roll !== room.lastDiceEvent.result
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
          }

          // party — apply when present and non-empty.
          const partyRaw = extractBlock('party', fullText)
          if (Array.isArray(partyRaw) && partyRaw.length > 0) {
            room.party = applyPartyUpdate(partyRaw, room.party ?? [])
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
            payload: { fullText, turnSequence: room.turnSequence },
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
          actionQueue: Promise.resolve(), // Phase 2: per-room serialization queue
          dmBusy: false,                   // Phase 3: synchronous single-trigger gate
          lastDiceEvent: null,             // Phase 3: forged-verdict.roll guard
        })
      }
      const room = rooms.get(sessionId)
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

      // (stored was loaded above, before room creation.)

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
