# Multiplayer Architecture — D&D Campaign Assistant

> **Owner:** game-developer (D2)
> **Inputs:** MULTIPLAYER-PRD.md "Decisions that flow forward"; MULTIPLAYER-ORCHESTRATION.md §3.1 D2;
> source files: `src/components/Chat.jsx`, `src/hooks/useSessionPersistence.js`,
> `server/sync-server.mjs`, `src/lib/session.js`
> **Status:** DESIGN-ARC (revised post-review) — architecture and phased build plan. No production feature code.
> **Last revised:** post D3 architecture review (MC-1…MC-9) + D3b security review (A…J).

---

## Revision log (post-review)

The following items from the D3 architecture review (MC-1…MC-9) and D3b security review (A…J) are
addressed in this revision. Each entry names the section(s) where the change landed.

| Item | Description | Addressed in |
|------|-------------|--------------|
| MC-1 | `createSyncServer` returns `http.Server`, not Express `app`; name the refactor | §2.1 |
| MC-2 | Server-side prompt assembly must reproduce `buildSystemPrompt`/`extractEntities`/`trimContext`/dice-fold/`pendingCheck`; not a thin fetch | §3.2, §3.6 (new) |
| MC-3 | `serializeSession` must carry v2 fields (`roomCode`, `phase`, `turnSequence`) so HTTP PUT does not silently strip them | §1.2 |
| MC-4 | Sanitize transient phases (`awaiting-dm`/`resolving`) on persist and load | §1.2, §4.1 |
| MC-5 | Define the single-player ↔ multiplayer mode predicate precisely at startup/leave boundaries | §3.2, §3.7 (new) |
| MC-6 | Reframe live adopt/convergence gate around `turnSequence`; resolve inconsistency between F4 gap-resync and M7 adopt | §2.2, §8 F2/F4 |
| MC-7 | Specify how `9999` sentinel is reset under server-push (currently goes permanently deaf) | §2.2 |
| MC-8 | Add bounded server-side Ollama request/stream timeout (~90 s) | §3.5, §8 F5 |
| MC-9 | Add CI upper-bound latency smoke to phased plan / test surface | §7 Phase 4 |
| A | Server strips `BLOCK_TAGS` fences from inbound `action.content`; validate `verdict.roll` vs server-recorded dice | §3.6, §5.4 |
| B | Multiplayer strings render as React text nodes only; server sanitizes/caps `displayName`; `parseMarkdown` escape-first preserved | §5.4 |
| C | Turn authorization uses connection-bound join identity; per-message `displayName` ignored | §3.6, §4.4, §5.2 |
| D | WS upgrade origin allowlist (`verifyClient`/`handleUpgrade`); HTTP CORS `origin:true` does NOT cover WS | §2.1 |
| E | Ollama timeout (= MC-8) — cross-referenced | §3.5 |
| F | Strict WS inbound schema validation; `maxPayload` ~64 KB; try/catch every handler + socket/server `error` handlers | §2.4, §5.4 |
| G | Per-connection action rate limit (≤1 in-flight + min interval); server prompt assembly carries `trimContext` + Ollama `options` | §3.6, §5.4 |
| H | Ollama URL from `OLLAMA_HOST` only; validate `campaign.model` | §3.2, §3.5 |
| I | `.md` store keyed by full `sessionId`; `roomCode → sessionId` resolved before `sessionPath` | §5.1, §6.3 |
| J | Reject second live connection claiming a `displayName` already bound to an active connection (`NAME_TAKEN`) | §5.2 |

**Deferred items:** see §9 "Accepted/deferred risks (LAN-trust v1)" — a summary of the security
review's deferred list and the internet-exposure guardrails that are explicitly out of scope for v1.

---

## 1. Shared-Session State Model

### 1.1 Authority decision: server-authoritative

The authoritative session lives on the **sync server**, not in a leader client. Rationale:

- The sync server already holds the canonical copy as a `.md` file (Phase B); the only new
  requirement is that it broadcasts changes to all connected clients in real time rather than
  waiting for them to poll.
- A leader-client model would require electing a leader on join, handling leader departure
  (cascading hand-off), and every non-leader becoming a passive receiver with no persistent
  anchor — more failure surface than the server-authoritative approach on a home LAN where
  the sync server process is trivially kept alive.
- Single-player sessions already rely on server authority (Phase B's load-on-mount adopts
  the server copy). Multiplayer extends this with a push channel; the authority location
  does not change.
- The `.md` store (required by R3) only works naturally if the server remains the writer;
  no client can be trusted to produce the canonical file that other clients and human readers load.

The server is authoritative for: the `messages` array, `party` state, `sessionLog`, and the
new multiplayer-specific fields below. The Ollama call lives on the server as the DM trigger
(see §3). Clients are rendered views; they push inputs and receive state.

### 1.2 Payload extension — extend, do not fork

The existing `session.js` payload (schemaVersion 1) is extended with new optional fields.
`deserializeSession` remains backward-compatible: v1 `.md` files load fine because all new
fields default gracefully when absent.

**Bump to `SCHEMA_VERSION = 2`.**

New top-level fields on the serialized payload:

```
{
  // --- existing v1 fields (unchanged) ---
  sessionId,
  schemaVersion,        // bumped to 2
  savedAt,
  campaign,
  messages,
  sessionLog,
  party,

  // --- new v2 fields (all optional; v1 callers that omit them get safe defaults) ---
  roomCode,             // string — human-readable alias of sessionId (e.g. "dnd-a1b2c")
                        // derived once from sessionId, stable for session lifetime
  phase,                // "free-roam" | "combat"
                        // ONLY resting phases are ever persisted (see phase-sanitize rule below).
                        // "awaiting-dm" and "resolving" are transient and MUST NOT appear
                        // in a serialized payload or .md file.
  connections,          // array — present/absence registry, NOT persisted to .md
                        // server-only in-memory; omitted from toMarkdown / fromMarkdown
  turnSequence,         // number — monotonically increasing turn counter;
                        // the server increments it when the DM trigger fires;
                        // clients use it to detect missed updates and request a resync
  dmClientId,           // string | null — the connection id of the current DM trigger
                        // holder; null = no active trigger; server-only in-memory
                        // NOT persisted to .md (trigger is re-elected on next player join)
}
```

**Phase-sanitize rule (MC-4):** `awaiting-dm` and `resolving` are operational transient phases
that exist only in the server's in-memory room state. They MUST NOT be written to `.md` or to
the serialized payload. On every `.md` write (and on `serializeSession` for HTTP PUT):

```javascript
// Normalize to the last resting phase before serializing.
const safePhase = ['free-roam', 'combat'].includes(phase) ? phase : 'free-roam'
```

On `.md` load via `fromMarkdown` / `deserializeSession`: any `phase` value that is not
`"free-roam"` or `"combat"` is coerced to `"free-roam"`. This closes chaos experiment EX-9
(`.md` saved mid-stream inheriting `awaiting-dm`) at the design level.

Fields excluded from `.md` (and therefore from `toMarkdown` / `fromMarkdown`):
- `connections` — ephemeral presence; meaningless after a restart
- `dmClientId` — ephemeral election result; re-elected per session

`toMarkdown` writes `phase` and `roomCode` as prose metadata lines (non-breaking for v1 readers),
and writes them into the `session` block so `fromMarkdown` can restore them — enabling a `.md`
resume to boot directly into the correct phase state. Only resting phases are written (per the
phase-sanitize rule above).

**`serializeSession` write-path extension (MC-3):** `serializeSession` today hard-drops
everything outside `{campaign, messages, sessionLog, party}`. It MUST be extended to carry
the v2 fields so the HTTP PUT path does not silently strip them:

```javascript
export function serializeSession(state, savedAt) {
  const { campaign, messages, sessionLog, party, roomCode, phase, turnSequence } = state ?? {}
  const safePhase = ['free-roam', 'combat'].includes(phase) ? phase : 'free-roam'
  return {
    sessionId: campaign?.sessionId ?? null,
    schemaVersion: SCHEMA_VERSION,          // = 2
    savedAt: savedAt ?? new Date().toISOString(),
    campaign: pickCampaign(campaign),
    messages: Array.isArray(messages) ? messages : [],
    sessionLog: Array.isArray(sessionLog) ? sessionLog : [],
    party: Array.isArray(party) ? party : [],
    roomCode: roomCode ?? null,
    phase: safePhase,
    turnSequence: typeof turnSequence === 'number' ? turnSequence : 0,
  }
}
```

Without this change, every HTTP PUT from the sync server (which rebuilds the payload through
`serializeSession`) would strip `phase`/`roomCode`/`turnSequence` even though `deserializeSession`
can accept them — a write-path/read-path asymmetry.

**Backward-compatibility rule for `deserializeSession`:**

```javascript
if (obj.schemaVersion === 1) {
  // accept it, fill v2 defaults
  return { ...v1Fields, phase: 'free-roam', roomCode: null, turnSequence: 0 }
}
if (obj.schemaVersion === 2) {
  // normal path — coerce phase to resting if needed
  const phase = ['free-roam', 'combat'].includes(obj.phase) ? obj.phase : 'free-roam'
  return { ...v2Fields, phase }
}
// any other version → return null (existing behavior)
```

This means the existing Vitest suite (274 tests) continues to pass without modification;
v1 `.md` files load into v2 sessions in free-roam phase with turnSequence 0.

---

## 2. Transport Choice

### 2.1 Decision: WebSocket on port 3001 (same process, same port as HTTP)

The 30s `pollSyncSession` interval in `useSessionPersistence.js` is designed for
"one device at a time; simultaneous co-play out of scope." It cannot meet the <500ms propagation
and <500ms turn-state-sync targets without being reduced to sub-second intervals, which would
generate excessive HTTP overhead across 2–5 clients hitting a local Node server.

**WebSocket wins over SSE and polling:**

| Criterion | 30s Poll | SSE | WebSocket |
|-----------|----------|-----|-----------|
| Propagation latency | ~30s avg | <100ms | <50ms |
| Server → client push | No | Yes (one-way) | Yes (bidirectional) |
| Client → server messages | HTTP PUT each time | Separate HTTP | Same connection |
| Reconnect semantics | Trivial (next poll) | Browser auto-reconnect | Manual but simple |
| Node/Express fit | Trivial | Simple | `ws` package, well-supported |
| LAN bandwidth overhead | Low | Low | Lowest |
| Meets <500ms target | No | Yes | Yes |

SSE would require a separate HTTP POST channel for client-to-server messages (player actions),
meaning two parallel connections per client; WebSocket consolidates both directions. For a
home LAN game where every client is on the same switch, full-duplex WebSocket with the `ws`
package is the right call.

**Same port, same process — `createSyncServer` refactor (MC-1):**

Today `createSyncServer()` in `server/sync-server.mjs` returns the Express `app` (line 152:
`return app`). The `isMain` block calls `app.listen(PORT)` and discards the return value.
The `ws.WebSocketServer({ server })` pattern requires a handle to the `http.Server` — which
today no caller holds.

The required refactor: `createSyncServer` creates and returns the `http.Server` explicitly
rather than letting `app.listen()` create it internally. Two acceptable shapes:

```javascript
// Option A — return the http.Server directly (preferred; matches test harness assumption)
import http from 'node:http'

export function createSyncServer({ sessionsDir = DEFAULT_DIR } = {}) {
  const app = express()
  // ... all routes + middleware ...
  const server = http.createServer(app)
  return server    // callers do: const s = createSyncServer(); s.listen(3001)
}

// Option B — return { app, server } tuple
export function createSyncServer({ sessionsDir = DEFAULT_DIR } = {}) {
  const app = express()
  const server = http.createServer(app)
  return { app, server }
}
```

Option A (returning `server` directly) is preferred because it matches the shape the
`MULTIPLAYER-TEST-AUTOMATION.md` §2.1 test harness already presumes:
`createSyncServer({ sessionsDir }).listen(0)` → `httpServer.address().port` → derive `wsBase`
on the same port.

The `isMain` entry point is updated accordingly:
```javascript
if (isMain) {
  const PORT = process.env.SYNC_PORT || 3001
  await mkdir(DEFAULT_DIR, { recursive: true })
  createSyncServer().listen(PORT, () => { /* log */ })
}
```

The existing HTTP REST endpoints (`GET/PUT/DELETE /session/:id`, `GET /sessions`) remain
unchanged — they serve the single-player offline path and the `.md` download button.

**WS upgrade origin allowlist (security item D):**

HTTP `cors({ origin: true })` reflects any origin for fetch/XHR requests but is **not
consulted during a WebSocket upgrade** — `ws` enforces no origin policy by default. A page
on any origin that can reach `:3001` can open a WS connection regardless of CORS headers.

The server MUST add an explicit upgrade filter:

```javascript
// In createSyncServer, after attaching ws.WebSocketServer:
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? ''
  const allowed = ALLOWED_ORIGINS  // e.g. ['http://localhost:5173', `http://${LAN_IP}:5173`]
  if (!allowed.some(o => origin === o || origin === '')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  if (req.url === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
```

`ALLOWED_ORIGINS` is configured from an env var (e.g. `WS_ALLOWED_ORIGINS`) with a sensible
LAN default. An empty `origin` header (direct connection, not a browser cross-site request)
is allowed to support the test harness and non-browser clients on the home LAN.

**URL scheme:** `ws://<host>:3001/ws`

### 2.2 What replaces `pollSyncSession` — and convergence gate changes (MC-6, MC-7)

`pollSyncSession` (in `session.js`) is NOT removed — it stays as the offline fallback.
`useSessionPersistence.js` is extended, not replaced.

**Two-authority convergence problem (MC-6):**

The existing M7 `adopt()` gate uses a **strictly-greater `savedAt` string comparison** for
its convergence check. This was designed for single-player where the server writes every 30s,
making same-millisecond writes practically impossible. In multiplayer, all `dm:done` writes
happen server-side in rapid succession (fast model, shared LAN) — two consecutive turns can
produce equal `savedAt` timestamps. The strictly-greater check would reject the second update
on every client, causing a silent desync.

The F4 gap-resync mechanism (§8 F4) already uses `turnSequence` as the convergence authority,
creating an inconsistency: `turnSequence` governs the desync recovery path while `savedAt`
governs the initial adopt path.

**Resolution — dual-authority adopt gate:**

For **live multiplayer** (`session:update` / `session:state` events from WebSocket), the
adopt condition changes to:

```javascript
function adopt(payload, source) {
  // source: 'ws' | 'poll'
  if (source === 'ws') {
    // Prefer turnSequence for live push; savedAt is a fallback tie-break.
    const seqNewer = typeof payload.turnSequence === 'number'
      && payload.turnSequence > (localTurnSequence.current ?? -1)
    const timeNewer = payload.savedAt && payload.savedAt > (localSavedAt() ?? '')
    if (!seqNewer && !timeNewer) return
  } else {
    // Poll path: preserve existing M7 strictly-greater savedAt gate (no change).
    const local = max(localSavedAt(), lastSavedAt.current)
    if (local && !(payload.savedAt && payload.savedAt > local)) { ... return }
  }
  // ... apply state ...
  lastSavedAt.current = payload.savedAt ?? null
  localTurnSequence.current = payload.turnSequence ?? localTurnSequence.current
}
```

The poll path preserves the existing M7/LWW behavior exactly — single-player sessions are
unaffected. The WebSocket path admits updates when `turnSequence` advances OR `savedAt` is
strictly newer, so same-millisecond writes no longer tie out.

`localTurnSequence` is a new `useRef` alongside `lastSavedAt`, initialized from the
persisted session on mount (0 if the session is new or v1).

**`9999` sentinel reset under server-push (MC-7):**

In single-player, `onNewSession` sets `lastSavedAt.current = '9999-...'` to block
resurrection of the cleared session. The sentinel is cleared on the first real turn because
the client's own PUT rebases `lastSavedAt` on the server's post-DELETE stamp.

In multiplayer, the **client issues no PUT** — the server writes on every `dm:done`. Without
a reset mechanism, the sentinel makes the client permanently deaf to all server pushes after
a session clear.

**Reset rule:** When the client receives a `session:state` event from the server on (re)join
— or when `onNewSession` transitions to a newly-created room — the `join` flow authoritative
resets both `lastSavedAt.current` and `localTurnSequence.current`:

```javascript
// In the ws 'session:state' handler:
function onSessionState(payload) {
  // A session:state on join always supersedes any sentinel — it's the server's
  // definitive current state for this room, not a stale poll from the old session.
  lastSavedAt.current = payload.savedAt ?? null
  localTurnSequence.current = payload.turnSequence ?? 0
  // Now apply (no gate check — session:state is authoritative on join).
  applyStateLocally(payload)
}
```

And in `onNewSession` (for the transition to a brand-new room):
```javascript
const onNewSession = useCallback(() => {
  deleteSyncSession(id)
  lastSavedAt.current = '9999-12-31T23:59:59.999Z'  // blocks poll resurrection (unchanged)
  localTurnSequence.current = -1  // sentinel: any real server push (sequence >= 0) supersedes
}, [id])
```

The `localTurnSequence = -1` sentinel means the next `session:state` received for the new
room (sequence 0) passes the `seqNewer` check (`0 > -1`), clearing the deaf state.

**When WebSocket is connected:** the 30s poll is **suspended** (the `setInterval` is not
started while the socket is open). Push events make polling redundant.

**When WebSocket is disconnected:** the 30s poll **resumes automatically** — the app degrades
to today's Phase B behavior seamlessly. The M7 strictly-newer `adopt()` gate and the `'9999...'`
sentinel are preserved unchanged for the poll path.

### 2.3 Reconnect and backoff

WebSocket reconnect follows an exponential backoff with jitter:

```
attempts: 0 → 1s, 1 → 2s, 2 → 4s, 3 → 8s, 4 → 15s, cap at 30s
jitter: ±20% of the wait to prevent thundering-herd on server restart
```

On reconnect the client sends a `join` message immediately (see §5). The server responds
with the current full session state (or the diff since the client's last `turnSequence`).
This covers the "server restarts with live sessions" failure mode: the server re-reads the
`.md` file on the next client join and serves fresh state.

### 2.4 Message envelope (wire format)

All WebSocket messages are JSON. Top-level structure:

```json
{ "type": "<message-type>", "roomCode": "<id>", "payload": { ... } }
```

**Strict inbound validation (security item F):**

Every inbound WS frame is validated before processing:
- `JSON.parse` wrapped in try/catch; malformed → drop frame + send `error` response
- `type` must be in the known allowlist (`join`, `action`, `ping`); unknown → drop
- `roomCode` must pass `ID_RE` (`/^[A-Za-z0-9_-]{1,128}$/`)
- `displayName` bounded strings: trimmed, max 64 chars, stripped of control chars + `<`/`>`/`&`
- `action.content` trimmed, max 4096 chars
- `ws` `maxPayload` set to **64 KB** (`new WebSocketServer({ server, maxPayload: 65536 })`)
- Every WS event handler is wrapped in try/catch; each socket gets an `error` event handler;
  the WS server itself gets an `error` event handler — so one bad message cannot crash all rooms

Server → client event types:
- `session:state` — full session snapshot (on join or reconnect)
- `session:update` — incremental: `{ messages, party, phase, turnSequence, savedAt }`
- `dm:delta` — streaming DM response chunk: `{ delta, assistantId, turnSequence }`
- `dm:done` — DM stream complete: `{ fullText, turnSequence, error? }` (triggers structured-block parse)
- `presence:update` — current player list with connection status
- `error` — `{ code, message }` (invalid room, schema mismatch, `DM_BUSY`, `NOT_YOUR_TURN`,
  `NAME_TAKEN`, `RATE_LIMITED`, etc.)

Client → server event types:
- `join` — `{ roomCode, displayName, sessionId, lastTurnSequence }`
- `action` — `{ content, type: "user"|"dice", pendingCheck? }` — a player's turn input.
  NOTE: `displayName` is NOT included here; the server uses the connection-bound identity (item C).
  `pendingCheck` is the session-only `{ skill, dc }` object if one is active on the sending client
  (see §3.6 for how the server uses it).
- `ping` — keepalive (every 20s); server responds `pong`

---

## 3. Single Serialized AI-DM Trigger

This is the central architectural question (R1). The solution is **server-side DM execution**.

### 3.1 The problem with the current design

`Chat.jsx` line 221 calls `fetch(\`http://${ollamaHost}/api/chat\`, ...)` directly from the
browser. In a multiplayer session each client has this code path active. If any client
submits a player action, it would trigger its own Ollama call — so N clients could produce
N independent DM responses to the same action. This must be made **structurally impossible**,
not just guarded by a flag.

### 3.2 Solution: server-side Ollama proxy

The sync server becomes a **DM orchestrator**. It:

1. Receives player `action` events via WebSocket
2. Serializes them into a per-room action queue
3. Fires **exactly one** Ollama POST per queued action — using `OLLAMA_HOST` from the
   server environment (`process.env.OLLAMA_HOST`), **never** from any client-supplied field
   (security item H). The client never controls which Ollama instance is called.
4. Streams the response back to all clients via `dm:delta` events
5. On stream completion, applies structured-block parsing server-side and broadcasts
   `dm:done` plus `session:update` with the new party/phase state

**Ollama URL invariant (security item H):** The Ollama base URL is read exclusively from
`process.env.OLLAMA_HOST` (default `http://localhost:11434`) on the server. It is never
derived from `join`/`action` payloads or any client field. `campaign.model` travels in the
session payload; the server validates it against an allowlist of known model name patterns
(e.g. `/^[a-zA-Z0-9._:-]{1,64}$/`) before passing to Ollama — an arbitrary string in `model`
could be used to probe or abuse the Ollama API.

**The client's `sendMessage` function in `Chat.jsx` is refactored to:**

```javascript
// Before (single-player): direct Ollama fetch
// After (multiplayer): send action to server via WebSocket
wsRef.current.send(JSON.stringify({
  type: 'action',
  roomCode,
  payload: {
    content: trimmed,
    type: 'user',
    pendingCheck: pendingCheck ?? null,  // session-only; travels with the action (see §3.6)
    // displayName is intentionally omitted here — server uses connection-bound identity
  }
}))
// No local isLoading toggle here — the server sends dm:delta events
// which drive the loading state on all clients uniformly
```

Single-player mode: when the WebSocket is disconnected or the server declares the client
is alone (see §3.7 for the precise predicate), the `sendMessage` path falls back to the
direct Ollama fetch (today's behavior). This keeps single-player fully functional.

### 3.3 Structural impossibility of double-trigger

Double-trigger prevention is architectural, not runtime-flag-based:

1. Only the **server** holds the Ollama credentials and makes the fetch. No client has a code
   path that calls Ollama in multiplayer mode.
2. The server uses a **per-room action queue** (a `Promise` chain, same pattern as the existing
   `withLock` in `sync-server.mjs`). A new action appended while the DM is responding is
   queued, not immediately executed — it fires after the current Ollama stream completes and
   `dm:done` is broadcast.
3. The room's `phase` is set to `awaiting-dm` the moment an action is dequeued and Ollama
   is called. Any further `action` events received while `phase === "awaiting-dm"` are
   **rejected** at the server with `{ type: "error", code: "DM_BUSY" }` — the client
   re-enables input only when it receives the next `phase` change to `free-roam` or `combat`.
4. The `turnSequence` counter increments only on the server, only when the DM finishes.
   Clients that somehow get out of sync will resync to the correct sequence on the next
   `session:state` or `session:update`.

### 3.4 Streaming fan-out

The server reads Ollama's `stream: true` NDJSON response with Node's `fetch` (Node 18+) or
the `node-fetch` package. Each `event.message.content` delta is immediately broadcast as:

```json
{ "type": "dm:delta", "payload": { "delta": "...", "assistantId": "uuid", "turnSequence": 7 } }
```

All connected clients in the room receive this event. Each client accumulates deltas into
the assistant message with the matching `assistantId` — the same logic as the current
`fullText += delta` loop in `Chat.jsx`, but now driven by WebSocket events rather than a
local ReadableStream. The `stripStructuredBlocks` display filter runs on the client exactly
as today.

On stream end, the server:
1. Runs `extractBlock('party', fullText)`, `extractBlock('check', ...)`, `extractBlock('verdict', ...)`
2. Validates `verdict.roll` against the server's recorded dice event for this turn (see §3.6)
3. Applies `applyPartyUpdate` server-side (the same pure function, imported into the server)
4. Sets `phase` based on the new party state:
   - Any member with `isActive: true` → `"combat"`
   - All members `isActive: false` → `"free-roam"`
5. Increments `turnSequence`
6. Persists the updated session to the `.md` store (`toMarkdown` + atomic temp+rename),
   using the phase-sanitize rule (only resting phases written)
7. Broadcasts `dm:done` and `session:update` to all clients

### 3.5 Ollama connection reuse and timeout (MC-8, security item E)

The server opens one Ollama stream per room action, sequentially. No connection pool is needed
for 2–5 players on a LAN — Ollama processes one request at a time anyway (single-threaded
inference). The per-room action queue enforces this naturally.

**Server-side Ollama timeout (MC-8):** A hung Ollama process (EX-3C scenario) would wedge
the room in `awaiting-dm` indefinitely with no recovery short of a server restart. The server
MUST apply a bounded timeout to every Ollama fetch/stream:

```javascript
// In the per-room DM trigger, before calling Ollama:
const OLLAMA_TIMEOUT_MS = 90_000  // 90 seconds — generous for a slow local model

const abortController = new AbortController()
const timeoutHandle = setTimeout(() => abortController.abort(), OLLAMA_TIMEOUT_MS)

try {
  const response = await fetch(ollamaUrl, { ..., signal: abortController.signal })
  // ... stream ...
} catch (err) {
  // Covers: AbortError (timeout), ECONNREFUSED, mid-stream abort
  broadcastToDone({ error: true, partial: fullText })
  resetPhaseToPreAction()      // reset to 'free-roam' or 'combat' (the pre-action resting phase)
  releaseLock()                // the per-room queue lock is released
  // turnSequence is NOT incremented; no .md write
} finally {
  clearTimeout(timeoutHandle)
}
```

On expiry the server:
1. Aborts the Ollama fetch via `AbortController`
2. Broadcasts `dm:done { error: true, partial: fullTextSoFar }` to all clients
3. Resets `phase` to the resting phase it had before the action (`free-roam` or `combat`)
4. Releases the per-room queue lock so the next queued action can fire
5. Does NOT increment `turnSequence`; does NOT write to `.md`

Clients display the partial content as an error message (same `error: true` flag handling
as today's single-player path in `Chat.jsx`). The DM can retry by resubmitting the action.

### 3.6 Server-side prompt assembly (MC-2, security items A, G)

The server-side DM call is **not a thin fetch**. `Chat.jsx#sendMessage` assembles the
request through a pipeline that must be reproduced server-side. Leaving any step out produces
wrong or insecure behavior.

**Full prompt assembly pipeline (server must reproduce all of these):**

```
1. buildSystemPrompt(campaign)
   — from the genre engine: getGenre(campaign.genre).engine.buildSystemPrompt
   — the genre engines (src/lib/context.js, src/lib/context.starwars.js) are pure ESM;
     they are importable by the server the same way session.js is already imported.
   — server import: import { getGenre } from '../src/lib/genres.js'

2. extractEntities(messages)
   — from the genre engine: getGenre(campaign.genre).engine.extractEntities
   — appended to the system prompt for continuity (same pattern as Chat.jsx lines 194–198)

3. dice-message → text transform + pendingCheck folding
   — each dice message is replaced with: [Dice roll: ${die} → ${result}${checkCtx}]
   — pendingCheck travels from the acting client in the action envelope (§2.4):
       { type: 'action', payload: { content, type, pendingCheck: { skill, dc } | null } }
   — the server folds it into the most-recent dice line exactly as Chat.jsx lines 182–192

4. trimContext([...allMessages + userMsg])
   — from the genre engine: getGenre(campaign.genre).engine.trimContext
   — bounds the context window; the server MUST apply it (security item G)

5. Ollama options block (security item G)
   — must match the client values to preserve inference quality:
       { num_ctx: 8192, num_predict: 900, temperature: 0.8, top_p: 0.9,
         top_k: 40, repeat_penalty: 1.15, repeat_last_n: 256 }
   — model: validated campaign.model || 'qwen2.5:14b'
```

**pendingCheck transport:** `pendingCheck` is session-only state in the acting client — it
is never machine-restored from `.md` (by design; see `session.js` header comment). The only
way the server can know the active `pendingCheck` is if the acting client includes it in the
`action` envelope. The client sends `pendingCheck: pendingCheck ?? null` with every action.
The server uses it for the dice-line fold for that turn only; it is not stored server-side
between turns (it is ephemeral per-action context, not persistent session state).

This design preserves the "no client controls the system prompt" invariant (item R4 trust
boundary): the client does NOT send a pre-built system prompt — it sends only its
`pendingCheck` value, which the server incorporates into a server-assembled prompt. A
malicious client sending a false `pendingCheck` can at worst affect its own dice context
for one turn; it cannot inject arbitrary system-prompt content.

**Inbound block-strip (security item A):** Before adding any inbound `action.content` to the
conversation, the server strips `BLOCK_TAGS` fences using the same `STRIP_RE` pattern as
`Chat.jsx` (L23):

```javascript
const STRIP_RE = new RegExp('```(?:' + BLOCK_TAGS.join('|') + ')[\\s\\S]*?```', 'g')
function sanitizeActionContent(content) {
  return String(content ?? '').replace(STRIP_RE, '').trim().slice(0, 4096)
}
```

This prevents a player from smuggling `party`/`verdict`/`check` blocks through chat to forge
game state. Defense-in-depth: the server validates DM-output `verdict.roll` against a
server-recorded dice event — when the acting client sends a `{ type: 'dice' }` action, the
server records `{ die, result, turnSequence }` and later checks that `verdict.roll` equals
the recorded `result` for that turn. A verdict with no matching server-recorded dice roll is
discarded.

**Per-connection action rate limit (security item G):** The server enforces:
- At most **1 in-flight action** per connection (while waiting for `dm:done`, further `action`
  events from the same connection return `RATE_LIMITED`)
- A minimum interval between actions per connection (e.g. 500ms) to prevent spam queuing
  in free-roam phase

### 3.7 Single-player ↔ multiplayer mode predicate (MC-5)

The mode-selection predicate ("use client-side Ollama fetch" vs "send action to server via WS")
must be unambiguous at all boundary conditions. Naive predicates like `connectionCount === 1`
have startup windows (WS connected but no `presence:update` yet) and leave windows (a player
leaves but the count hasn't updated) where two code paths might both execute.

**Authoritative mode predicate:**

```javascript
// In Chat.jsx / useWebSocket.js — the canonical mode check
function isMultiplayerMode() {
  // MULTIPLAYER iff: WebSocket is in OPEN state AND the server has confirmed
  // the room has been joined (i.e. we received at least one session:state).
  return wsState === WS_OPEN && roomJoined === true
}
```

Where `roomJoined` is a ref set to `true` only when the client receives its first
`session:state` event from the server (not on WS open, not on `presence:update`).
It is reset to `false` on WS close, on explicit `leave`, and on `onNewSession`.

**Mode-flip safety invariant:** A turn MUST NOT be executed by both the client-side Ollama
fetch AND the server proxy. This is guaranteed because:
1. `roomJoined` is `false` until `session:state` arrives; any action sent before that goes
   through the single-player path (which is correct — the room isn't confirmed yet).
2. On WS close, `roomJoined` is reset to `false` synchronously in the `close` handler before
   any user input is processed; the mode flips to single-player cleanly.
3. The server's per-room action queue is the structural guard — even if a client somehow
   sends both a WS `action` and a direct Ollama call, the WS action lands in the server queue
   and the client-side call is independent; but the client's `sendMessage` in multiplayer
   mode does NOT call Ollama — it only sends over WS. There is no code path that does both.

**QA scenario (new):** Add a chaos/edge test for the mode boundary: connect WS, submit an
action before `session:state` arrives (should use single-player path), then receive
`session:state` and submit again (should use multiplayer path). Verify no double-call.

---

## 4. Turn/Initiative State Machine

### 4.1 State names and definitions

```
FREE_ROAM        — resting phase; any player may submit an action; no turn enforcement
AWAITING_DM      — TRANSIENT: server is calling Ollama; no player input accepted; all clients locked
                   NEVER persisted to .md or serialized payload
RESOLVING        — TRANSIENT: DM stream complete; server is parsing structured blocks and persisting;
                   lasts <200ms; no player input
                   NEVER persisted to .md or serialized payload
COMBAT           — resting phase; a party member has isActive:true; only that player's input accepted
```

Only `FREE_ROAM` and `COMBAT` are **resting phases** — valid values for the persisted `phase`
field. `AWAITING_DM` and `RESOLVING` exist only in the server's in-memory room state and in
the phase broadcast for client UI purposes; they are coerced to `FREE_ROAM` on any `.md` write
or `serializeSession` call (the phase-sanitize rule from §1.2).

### 4.2 State transition diagram

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                                                         │
                  ▼                                                         │
           ┌────────────┐    any player action received                    │
           │            │ ─────────────────────────────► ┌──────────────┐  │
           │ FREE_ROAM  │                                 │              │  │
           │            │ ◄──── phase reset by DM ─────── │ AWAITING_DM  │  │
           └────────────┘    (party block: all isActive   │  (transient) │  │
                │             false or omitted)           └──────────────┘  │
                │                                                ▼          │
                │                                         ┌──────────────┐  │
                │                                         │  RESOLVING   │  │
                │                                         │ (transient)  │  │
                │                                         │ (<200ms)     │  │
                │                                         └──────────────┘  │
                │                                                │          │
                │                              party block: one  │          │
                │                              isActive=true ────┼──────►   │
                │                                                │   ┌──────────┐
                │                              party block: all  │   │          │
                │                              isActive=false ───┼──►│  COMBAT  │
                │             active player    or omitted        │   │ (resting)│
                │             submits action ◄──────────────────►│   └──────────┘
                │                                                │       │
                └────────────────────────────────────────────────┘       │
                         active player action                            │
                         ────────────────────────────────────────────────┘
                         → AWAITING_DM
```

Simplified transitions table:

| From | Event | To | Guard |
|------|-------|----|-------|
| FREE_ROAM | player `action` received | AWAITING_DM | phase becomes awaiting |
| AWAITING_DM | Ollama stream starts | AWAITING_DM | no change |
| AWAITING_DM | Ollama stream done | RESOLVING | |
| AWAITING_DM | Ollama timeout (~90s) | FREE_ROAM or COMBAT | reset to pre-action resting phase |
| RESOLVING | structured blocks parsed + persisted | FREE_ROAM or COMBAT | based on party isActive |
| COMBAT | active player `action` received | AWAITING_DM | sender must match connection-bound identity for active member |
| COMBAT | non-active player `action` received | COMBAT | rejected with `error: NOT_YOUR_TURN` |
| any | server restart / reconnect | (current resting phase from .md) | always a resting phase |

### 4.3 How `isActive` and the `party` block drive phase

The DM (Ollama) is the sole authority on phase transitions — it emits `party` blocks.
The server reads them; the clients render them. No client logic computes phase independently.

- `party` block present, at least one member `isActive: true` → server sets `phase = "combat"`
- `party` block present, all `isActive: false` → server sets `phase = "free-roam"`
- `party` block absent → phase unchanged (server keeps whatever it was)

The `phase` field is broadcast in every `session:update`. The client uses it for:
- Input enable/disable logic (see §4.4)
- Combat HUD visibility (turn-pill, PartyStrip combat overlay)
- `isActive` highlighting in `HistoryPanel` and `PartyStrip`

### 4.4 Player action acceptance per phase

Server-side enforcement uses **connection-bound identity** (security item C): the server
ignores any `displayName` in the message payload and uses `clients.get(ws).displayName`
(the identity bound at join time). This closes the "spoofed membership" vulnerability where
a client sends an `action` with any `displayName`, including the active combatant's.

| Phase | Who can act | Server action on unauthorized input |
|-------|-------------|-------------------------------------|
| FREE_ROAM | Any connected player | Accept; queue behind any in-flight DM call |
| AWAITING_DM | Nobody | Return `error: DM_BUSY` to sender |
| RESOLVING | Nobody | Return `error: DM_BUSY` to sender |
| COMBAT | Player whose connection-bound `displayName` case-insensitively matches the `isActive` member | Accept and queue; return `error: NOT_YOUR_TURN` to any other sender |

Client-side enforcement (UI layer — reinforces server but is NOT the authority):
- `phase === "awaiting-dm"` or `phase === "resolving"` → all inputs disabled, typing indicator shown
- `phase === "combat"` and the local player is not the active member → input disabled, shows
  "Waiting for [name]'s action..." placeholder
- `phase === "combat"` and the local player IS the active member → input enabled, highlighted
- `phase === "free-roam"` → all inputs enabled

Dice rolls: a dice roll in combat by a non-active player is allowed (the DiceRoller emits a
local message type `"dice"`) but only the active player's dice rolls are forwarded as `action`
events to the server. Non-active dice rolls are purely local until free-roam resumes.

---

## 5. Identity / Room Implementation

### 5.1 Room code derivation

The `roomCode` is derived from `sessionId` at session creation time in `App.jsx`:

```javascript
// Pseudocode — App.jsx loadSessionId extension
function makeRoomCode(sessionId) {
  // Take the first 8 hex chars of the UUID (already 128-bit random),
  // prefix with "dnd-" for human recognition.
  // e.g. "a1b2c3d4" → "dnd-a1b2c3d4"
  return 'dnd-' + sessionId.replace(/-/g, '').slice(0, 8)
}
```

The room code is stable for the session lifetime. It maps 1:1 to `sessionId`. The sync server
indexes rooms by `sessionId`; the room code is a display alias the client resolves on join by
querying `GET /sessions` or embedding the `sessionId` in the join URL parameter.

**`.md` store path-safety invariant (security item I):** The `.md` store is always keyed by
the full `sessionId` (UUID format, passes `ID_RE`), never by `roomCode`. The `roomCode` is
resolved to `sessionId` at the point of room creation (client-side) or via `GET /sessions`
lookup (join flow), and `sessionId` is what the server passes to `sessionPath()`. No code
path should produce a file named `${roomCode}.md`. Every new WebSocket endpoint and HTTP
route that handles a room identifier must route through `sessionPath(sessionId)` / `ID_RE`
before touching the filesystem. This invariant must be enforced by a test:

```javascript
// test: joining by roomCode resolves to sessionId before any sessionPath call
// Verify: no file named like 'dnd-a1b2c3d4.md' is ever created; only 'uuid.md' files
```

Join URL format: `http://<LAN-IP>:5173?room=dnd-a1b2c3d4`

When a client opens this URL, `App.jsx` reads the `?room` query parameter and prefills the
join screen with the room code, so the player only needs to type their display name.

### 5.2 Player → connection → party slot binding

The join flow is a WebSocket handshake after the HTTP page loads:

```
Client                                    Server
  │                                         │
  │── ws://host:3001/ws ──────────────────► │  (WebSocket upgrade — origin checked)
  │                                         │
  │── { type:"join",                        │
  │     roomCode:"dnd-a1b2c3d4",           │
  │     displayName:"Alex",                │
  │     sessionId:"uuid...",               │
  │     lastTurnSequence: 0 } ────────────► │
  │                                         │  1. Validate roomCode → sessionId (ID_RE)
  │                                         │  2. Validate displayName (trim, ≤64, strip ctrl+HTML)
  │                                         │  3. Check NAME_TAKEN: if displayName already bound
  │                                         │     to a live connection → error: NAME_TAKEN
  │                                         │  4. Load session from .md store
  │                                         │  5. Name-match against party array
  │                                         │     (same applyPartyUpdate logic)
  │                                         │  6. Add to in-memory connections map
  │                                         │     (bind displayName to this ws connection)
  │                                         │  7. Broadcast presence:update to all
  │                                         │
  │◄── { type:"session:state",              │
  │      payload: fullSession } ───────────│
  │                                         │
  │◄── { type:"presence:update",            │
  │      payload: [{ displayName, status }] }│
```

**`NAME_TAKEN` guard (security item J):** Before completing a join, the server checks whether
`displayName` (after normalization: trimmed, lowercased) is already bound to an **active**
(non-closed) connection in the room. If so, reject with `{ type: "error", code: "NAME_TAKEN" }`.
The player must choose a different display name. This prevents impersonation of an active
player by a second connection.

The "rejoin-claims-disconnected-slot" case is different: if the bound connection's socket is
in `CLOSED` state, the name is available for the rejoining client to claim (the slot is vacant).

The server's in-memory connections map per room:

```javascript
// server-side pseudocode (in-memory; not persisted)
rooms.get(roomCode) = {
  sessionId: "uuid...",
  clients: Map<ws, { displayName, partyId, connectedAt }>,
  actionQueue: Promise,   // the withLock chain for DM trigger serialization
  phase: "free-roam",     // authoritative phase (always a resting phase in memory during idle)
  turnSequence: 7,        // current turn counter
  lastDiceEvent: null,    // { die, result, turnSequence } — for verdict.roll validation
}
```

**`displayName` sanitization (security item B):** On join, `displayName` is sanitized
server-side before being stored in the connections map and before being broadcast in
`presence:update`:
```javascript
const sanitizeDisplayName = (s) =>
  String(s ?? '').trim().replace(/[<>&"']/g, '').replace(/\p{Cc}/gu, '').slice(0, 64)
```

This prevents stored XSS from reaching other clients' UIs when display names are broadcast.
On the client side, all multiplayer-introduced strings (display names, party names, presence
labels) MUST render as React text nodes (`{name}`) — never via `dangerouslySetInnerHTML` or
string HTML concatenation. The existing `parseMarkdown` escape-first ordering (L64–67 in
`Chat.jsx`) is preserved.

The `partyId` in the connections map is resolved by name-match at join time. If no match
(new player), `partyId` is `null` until the DM includes them in a `party` block.

### 5.3 Presence / disconnect / rejoin signaling

**Disconnect detection:** The `ws` library fires a `close` event. On client disconnect:
1. Server removes the entry from `rooms[roomCode].clients`
2. Broadcasts `presence:update` to remaining clients
3. Does NOT modify the `party` array (party is DM-owned; the DM narrates departures)
4. If the disconnected client was mid-action (i.e. `phase === "awaiting-dm"` triggered by
   them), the DM call continues — Ollama is already running. The result is broadcast to
   remaining clients and persisted normally.

**Rejoin:** The client reconnects via WebSocket and sends a `join` message with the same
`displayName` and `roomCode`. The server:
1. Name-match check: finds the existing slot with a closed socket → allows the claim
2. Re-adds the connection to `rooms[roomCode].clients` with the same `partyId`
3. If `lastTurnSequence < server.turnSequence`, sends a full `session:state` snapshot
   (which resets the client's `lastSavedAt` and `localTurnSequence` — see §2.2 sentinel reset)
4. Otherwise sends the incremental state since the client's last turn
5. Broadcasts `presence:update` to show the player is back

Rejoin is silent and automatic — no prompt, no confirmation, no draft recovery (acceptable
per PRD). The server-authoritative session state ensures no stale data.

**Orphaned rooms:** When all clients disconnect from a room, the server keeps the room's
`.md` file but can garbage-collect the in-memory entry after 30 minutes of inactivity.
The `GET /sessions` endpoint remains available for future reconnects.

### 5.4 Input validation summary

Server-side validation for all multiplayer-introduced inputs:

| Input | Validation rule |
|-------|-----------------|
| `roomCode` (join/action) | `ID_RE` (`/^[A-Za-z0-9_-]{1,128}$/`) |
| `displayName` (join) | trim + strip control chars + `<>&"'` + max 64 chars + non-empty |
| `action.content` | strip `BLOCK_TAGS` fences (STRIP_RE) + max 4096 chars + trim |
| `action.pendingCheck` | `{ skill: string ≤64, dc: integer 1–40 }` or null; other shapes → null |
| `turnSequence` (from clients) | informational only — server never trusts client turn counts |
| `campaign.model` | allowlist pattern `/^[a-zA-Z0-9._:-]{1,64}$/`; invalid → default model |
| WS frame size | `maxPayload: 65536` (64 KB); frames exceeding this are dropped by `ws` |
| Message type | allowlist: `join`, `action`, `ping`; unknown types → drop frame |

### 5.5 LAN trust boundary (R4)

No auth tokens, no passwords. Clients on the same LAN that know the room code can join
with any display name. Trust is physical (home network). The host ejects unwanted players
by restarting the session (clear session → new `sessionId` + new room code). A "kick"
button is deferred to v2.

The `NAME_TAKEN` guard (§5.2) prevents live impersonation. The per-message `displayName`
is ignored for authorization (§4.4, §3.6). These are the cheap security wins that apply
regardless of internet exposure; the remaining trust-boundary items are in §9.

---

## 6. Migration Path from Current LWW Sync Layer

The migration is additive and gated per phase so single-player never regresses.

### 6.1 Current state (today)

- `useSessionPersistence.js`: 30s poll, handoff-first LWW, M7 gate (strict-greater `savedAt`),
  `9999` sentinel
- `sync-server.mjs`: HTTP REST only (`GET/PUT/DELETE /session/:id`, `GET /sessions`)
- `Chat.jsx`: direct `fetch` to Ollama on every send
- `.md` store: `server/sessions/` folder of `toMarkdown` files

### 6.2 Migration steps

**Step 1 — WebSocket endpoint added to sync server (non-breaking)**

Add the `ws` package to `server/sync-server.mjs`. Refactor `createSyncServer` to create and
return the `http.Server` explicitly (see §2.1 MC-1 refactor). Attach a WebSocket server at
`/ws` with `noServer: true` and the upgrade origin allowlist. The existing HTTP routes are
unchanged. No client code changes yet. Single-player sessions continue to work exactly as
today — they never connect to `/ws`.

Touches: `server/sync-server.mjs`, `package.json` (add `ws`)

**Step 2 — Server-side Ollama proxy added (non-breaking)**

Add the DM trigger logic to the sync server: per-room action queue, `withLock`-style
Promise chain, Ollama fetch (server-side using `OLLAMA_HOST` env var), Ollama timeout
(AbortController, 90s), `dm:delta` / `dm:done` broadcast, server-side prompt assembly
(importing genre engines + `applyPartyUpdate` + `trimContext` from `src/lib/`), inbound
`action.content` block-strip, `verdict.roll` server-side validation, per-connection rate
limit, server-side structured-block parse.

Add `applyPartyUpdate` (currently in `Chat.jsx`) as a pure function exported from
`src/lib/session.js` so both the client and server can import it without duplication.

`SCHEMA_VERSION` bumped from 1 to 2. `serializeSession` gains v2 fields with phase-sanitize.
`deserializeSession` gains the v1-compatibility branch with phase-sanitize coercion.
`toMarkdown` / `fromMarkdown` gain `phase`, `roomCode`, `turnSequence` in the `session` block.

Touches: `server/sync-server.mjs`, `src/lib/session.js`

**Step 3 — Client WebSocket layer added to `useSessionPersistence.js`**

Add a WebSocket connection manager. When the socket is open and `roomJoined` is true
(received first `session:state`):
- Suspend the 30s poll (`pollSyncSession`)
- Route `session:update` and `dm:delta` events through the revised `adopt()` path
  (dual-authority gate: `turnSequence > local` OR `savedAt > local`)
- `session:state` on join resets `lastSavedAt.current` and `localTurnSequence.current`
  authoritatively (sentinel reset for MC-7)
- The `onNewSession` / `9999` sentinel logic is updated: `localTurnSequence.current = -1`
  so the next `session:state` for the new room passes the `seqNewer` check

The 30s poll auto-resumes when the socket closes. This is purely additive — single-player
clients that never connect a WebSocket run the poll path as before, with the M7 gate unchanged.

Touches: `src/hooks/useSessionPersistence.js`

**Step 4 — `Chat.jsx` refactored to multiplayer mode**

`sendMessage` becomes mode-aware using the `isMultiplayerMode()` predicate (§3.7):
- **Multiplayer mode** (`wsState === WS_OPEN && roomJoined === true`): send `action` event
  over WebSocket (including `pendingCheck` field); remove local Ollama fetch; receive DM
  response via `dm:delta` events
- **Single-player mode** (not multiplayer): existing direct Ollama fetch, unchanged code path

The `isLoading` state is now driven by `dm:delta` / `dm:done` events in multiplayer mode
rather than the local fetch lifecycle. Input enforcement (`disabled` prop on the textarea)
is driven by the `phase` field from the server.

Touches: `src/components/Chat.jsx`

**Step 5 — Room/join UI added to `App.jsx` and `ApiKeySetup.jsx`**

- Setup screen gains a "Join existing session" path (room code input + display name)
- New session path gains a "Share this room code" display after campaign creation
- `App.jsx` gains a `roomCode` state field and the `?room=` URL parameter reader

Touches: `src/App.jsx`, `src/components/ApiKeySetup.jsx`

**Step 6 — M7 gate, LWW 409 logic in migration**

The M7 gate in `adopt()` (poll path: strict-greater `savedAt`) and the 409 staleness check
in `sync-server.mjs` are preserved unchanged for the single-player offline path. In
multiplayer mode they serve as follows:
- The dual-authority gate (§2.2) governs live WS pushes; the M7 gate governs poll-path
  adoption during offline degradation
- A client that has been offline and rejoins receives a `session:state` event; `onSessionState`
  resets the sentinel and applies unconditionally
- A concurrent PUT from an offline client still hits the 409 guard; the WebSocket push
  reconciles the client immediately after
- The `9999` sentinel is still written by `onNewSession` — updated to also set
  `localTurnSequence.current = -1` so the next `session:state` for the new room clears it

### 6.3 `.md` save/continue preservation (R3)

The `.md` store is **not replaced** at any migration step:

- `server/sessions/<sessionId>.md` is still written on every `dm:done` event (same atomic
  temp+rename, same `toMarkdown` function, same folder)
- The "Save session (.md)" button in `Chat.jsx` (`handleSaveSession`) is unchanged —
  it serializes local state to a Markdown blob for download
- `fromMarkdown` still boots the app directly into play when a file with a `session` block
  is loaded on the setup screen
- A `.md` file saved during a multiplayer session includes `roomCode`, `phase` (resting
  phases only), and `turnSequence` in the `session` block; when loaded as single-player,
  these fields are accepted gracefully (the app starts in the correct resting phase, or
  `free-roam` if coercion was needed)

**Path-safety:** All server writes use `sessionPath(sessionId)` — the full UUID, not the
room code. `roomCode → sessionId` is always resolved before any filesystem operation (§5.1).

---

## 7. Phased Build Plan

Each phase is independently shippable, has a defined test surface, and does not break any
prior phase. The phase list is ordered for the D3 reviewer and for the V1 implementation
agents named in MULTIPLAYER-ORCHESTRATION.md §6.

### Phase 0 — Schema and payload extension (foundation; no user-visible change)

**Goal:** Bump `SCHEMA_VERSION` to 2, add v2 fields with phase-sanitize, prove backward compat.

Files touched:
- `src/lib/session.js` — `SCHEMA_VERSION = 2`, `serializeSession` gains v2 fields + phase-sanitize,
  `deserializeSession` v1-compat branch + phase-coerce, `toMarkdown`/`fromMarkdown` write/read
  `phase`/`roomCode`/`turnSequence`, export `applyPartyUpdate` (moved from `Chat.jsx`)
- `src/components/Chat.jsx` — import `applyPartyUpdate` from `session.js` instead of
  defining it locally

Test surface: existing Vitest schema tests, plus new unit tests for:
- v1→v2 deserialization with v2 defaults
- `serializeSession` round-trip preserves v2 fields (closes MC-3 write-path gap)
- `toMarkdown`/`fromMarkdown` round-trips with v2 fields
- phase-sanitize: `awaiting-dm`/`resolving` coerced to `free-roam` on serialize/deserialize
- HTTP PUT v2 payload → GET round-trip preserves v2 fields (TEST-AUTOMATION §5.4)
- All 274 existing tests must remain green.

Agent: `react-specialist` (session.js is pure JS; `test-automator` writes new schema tests)

### Phase 1 — WebSocket transport spike (server + stub client)

**Goal:** Add `/ws` endpoint to the sync server with origin allowlist. Prove connection,
keepalive, and reconnect work on LAN. No multiplayer game logic yet.

Files touched:
- `server/sync-server.mjs` — refactor `createSyncServer` to return `http.Server`;
  attach `ws.WebSocketServer` (`noServer: true`) with upgrade origin allowlist;
  handle `ping/pong`; per-room `clients` Map; `join` message validated (ID_RE, displayName
  sanitize, NAME_TAKEN check) and echoed back as `session:state`; WS `maxPayload: 65536`;
  try/catch on all handlers; socket + server `error` handlers
- `package.json` — add `ws` dependency
- New `src/hooks/useWebSocket.js` — connection manager: connect on mount, exponential
  backoff reconnect, `send()` helper, event emitter interface, `roomJoined` state

Test surface:
- Two simulated `ws` clients connecting to a test server instance, verifying `join` → `session:state` roundtrip
- NAME_TAKEN rejection when a second connection claims an active display name
- Origin allowlist: connection from disallowed origin is rejected with 403
- `maxPayload`: oversized frame is dropped
- Node-env test environment

Agent: `websocket-engineer`

### Phase 2 — Server-authoritative state + broadcast

**Goal:** Server becomes the write path for party/message/phase state. All connected
clients receive `session:update` when the state changes (but Ollama is still called by the
client in this phase — a placeholder `action:echo` handler is used).

Files touched:
- `server/sync-server.mjs` — per-room action queue (`withLock` pattern), `action:echo`
  broadcasts received messages back to all clients in the room as `session:update`;
  `phase` and `turnSequence` managed server-side; `session:state` on join resets sentinel
- `src/hooks/useSessionPersistence.js` — WebSocket event handler added; dual-authority
  `adopt()` gate (turnSequence OR savedAt); `session:state` resets `lastSavedAt` +
  `localTurnSequence`; 30s poll suspended while socket open + `roomJoined`; `onNewSession`
  sets `localTurnSequence.current = -1`

Test surface: two simulated clients in the same room — client A sends a message, client B
receives `session:update`. Phase field syncs. Reconnect test: client drops and rejoins,
receives current state. Sentinel test: `onNewSession` followed by `session:state` for new
room is adopted correctly (no deafness).

Agent: `websocket-engineer` + `backend-developer`

### Phase 3 — Single DM trigger (server-side Ollama proxy)

**Goal:** Server calls Ollama. Client `sendMessage` path is refactored to send `action`
over WebSocket in multiplayer mode. DM double-trigger becomes structurally impossible.

Files touched:
- `server/sync-server.mjs` — server-side Ollama fetch using `OLLAMA_HOST` env var;
  Ollama timeout (AbortController, 90s, resets phase + releases lock + broadcasts error);
  prompt assembly (imports genre engines: `getGenre`, `buildSystemPrompt`, `extractEntities`,
  `trimContext`); dice-message transform + `pendingCheck` folding from `action` envelope;
  inbound `action.content` block-strip (STRIP_RE); `verdict.roll` server-side validation
  vs `lastDiceEvent`; per-connection rate limit; `dm:delta` broadcast; `dm:done` handler
  with structured-block parse; phase-sanitize on `.md` write; `turnSequence` incremented;
  model allowlist validation; `campaign.model` validation
- `src/components/Chat.jsx` — `sendMessage` becomes mode-aware (`isMultiplayerMode()`
  predicate, §3.7); WS `action` send includes `pendingCheck`; `dm:delta` events drive
  `isLoading` and message accumulation in multiplayer mode

Test surface:
- Single simulated client sends `action`, verifies exactly one Ollama call made (mock),
  exactly one `dm:done` broadcast, `.md` file written, `turnSequence` advances
- Two clients simultaneously send `action` — verify only one Ollama call fires, second is queued
- Ollama timeout test: hang mock Ollama, verify `dm:done {error:true}` broadcast after 90s,
  `phase` reset, `turnSequence` unchanged, next action succeeds (chaos EX-3C)
- Block-strip test: `action.content` containing a `party` fence must not alter broadcast party state
- `verdict.roll` validation: a forged verdict with no matching server-recorded dice roll is discarded
- `campaign.model` with invalid characters is rejected/defaulted
- Prompt assembly: verify `buildSystemPrompt`, `extractEntities`, `trimContext`, Ollama options
  block all appear in the server-assembled request (mock Ollama captures request body)
- Mode boundary: WS connected but `roomJoined` false → single-player path used; after
  `session:state` → multiplayer path used; no double-call

Agent: `llm-architect` + `backend-developer`

### Phase 4 — Free-roam multi-client (first playable multiplayer)

**Goal:** Two or more clients share a room and play in free-roam mode. All messages
appear on all clients. No turn enforcement yet.

Files touched:
- `src/App.jsx` — `?room=` URL parameter reader, `roomCode` state, room display
- `src/components/ApiKeySetup.jsx` — "Join existing session" flow (room code + display
  name input), "Share room code" display after session create
- `src/hooks/useWebSocket.js` — full join flow, `presence:update` handling
- `src/components/Chat.jsx` — `displayName` prop added; player messages labeled with
  display name as React text nodes; `PartyStrip` and `HistoryPanel` receive `connections`
  (presence) data; all MP strings rendered via React text nodes only (no `dangerouslySetInnerHTML`)

Test surface:
- Two browser windows on the same LAN open the same room code, both see the other's messages
  in real time
- Latency smoke (MC-9): message propagation on loopback < 2000ms (CI-safe upper bound); manual
  run targets <500ms on real LAN hardware (QA MANUAL-04)
- XSS guard: `displayName` containing `<script>` or `<img onerror=...>` renders as escaped
  text in all clients (no execution)

Agent: `react-specialist` (client UI) + `websocket-engineer` (room join) +
`frontend-developer` (setup screen join flow)

### Phase 5 — Combat turn enforcement

**Goal:** `phase === "combat"` enforced on server and client. Only the active player's
input is accepted. Combat HUD active.

Files touched:
- `server/sync-server.mjs` — `action` handler checks `phase` and connection-bound
  `displayName` vs active member; rejects non-active with `error: NOT_YOUR_TURN`
- `src/components/Chat.jsx` — input `disabled` driven by `phase` + `myDisplayName` vs
  active member; "Waiting for [name]..." placeholder
- `src/components/PartyStrip.jsx` — combat overlay (active cell highlighted, others dimmed)
- `src/components/HistoryPanel.jsx` — turn-order section during combat phase

Test surface: three clients in a room, server puts one in combat with `isActive:true`. Verify
the other two receive `error: NOT_YOUR_TURN`. Verify the active player's action is accepted.
Verify that on `dm:done` with a new active member, the turn passes and the new active client
can send. Verify that on free-roam restore, all inputs enable.

Agent: `react-specialist` (client enforcement + HUD) + `backend-developer` (server enforcement)

### Phase 6 — Presence, disconnect, and rejoin

**Goal:** Connection lifecycle is complete. Disconnect detection, `presence:update`
broadcast, rejoin with state sync, orphaned room cleanup.

Files touched:
- `server/sync-server.mjs` — `close` event handler, `presence:update` broadcast,
  30-minute orphaned room GC (in-memory only; `.md` file persists)
- `src/hooks/useSessionPersistence.js` — reconnect triggers `join` with `lastTurnSequence`;
  `session:state` on rejoin clears sentinel unconditionally
- `src/components/Chat.jsx` / UI — presence indicators (connected/disconnected player dots)

Test surface: client disconnects mid-session, rejoins, receives correct state. Client
disconnects during DM response — verify DM stream completes and persists, other clients
unaffected. Server restarts — clients reconnect within backoff window, receive fresh state.

Agent: `websocket-engineer` + `react-specialist`

### Phase 7 — Migration cutover and backward-compat verification

**Goal:** Single-player sessions work identically to pre-multiplayer. v1 `.md` files load
correctly as v2 sessions. The M7 gate and 409 logic are regression-tested.

Files touched:
- `src/hooks/useSessionPersistence.js` — final integration of WebSocket + poll fallback
- `server/sync-server.mjs` — HTTP endpoints regression-tested against updated schema
- Test suite — full 274-test run green; new integration tests for single-player path

Test surface:
- Run entire existing Vitest suite green
- Load a v1 `.md` file — verify it opens in free-roam with no errors
- Save a v2 session as `.md` — verify it loads on a fresh client
- Single-player session: disconnect WebSocket, verify 30s poll resumes, verify M7 gate still
  blocks stale adoption
- `sessionPath` invariant test: no `.md` file named by `roomCode` ever created (only by `sessionId`)
- Verify full HTTP PUT v2 round-trip: `serializeSession` preserves `phase`/`roomCode`/`turnSequence`

Agent: `test-automator` + `react-specialist`

---

## 8. Failure-Mode Pre-Analysis

This section is the target list for the architect-reviewer (D3) and chaos-engineer. Each
failure mode is stated precisely with the mitigation and its residual risk.

### F1 — DM double-trigger (R1)

**Scenario:** Two clients both submit actions before the `phase` transitions to `awaiting-dm`
(race window between an action being sent and the broadcast of the phase change reaching
all clients).

**Mitigation:** The per-room action queue on the server is a `Promise` chain (same `withLock`
pattern as the HTTP PUT lock). The queue enforces strict serialization — the second action
is not dequeued until `dm:done` is broadcast. The `awaiting-dm` phase broadcast happens
inside the lock, before Ollama is called, so any client that receives it will disable input.

**Residual risk:** A client on a very slow connection might enqueue an action just as the
phase changes. The server will receive the action while `phase === "awaiting-dm"` and return
`error: DM_BUSY`. The client re-enables input on the next `session:update`. No duplicate
Ollama call. No message loss — the action is returned to the client to resubmit.

**Chaos target:** Send two simultaneous WebSocket `action` events from two clients; assert
exactly one Ollama call, exactly one `dm:done`, both clients see a coherent turn.

### F2 — Split-brain state (R2)

**Scenario:** A client plays a turn while offline (WebSocket disconnected, 30s poll path
active), writes to localStorage, then reconnects. The server has a newer version.

**Mitigation:** On reconnect, the server sends `session:state` with its current `turnSequence`
and `savedAt`. The `onSessionState` handler resets `lastSavedAt.current` and
`localTurnSequence.current` authoritatively and applies the server state unconditionally.
The offline turn is discarded (same behavior as today's Phase B LWW — documented as
acceptable in the PRD as "handoff-first"). The dual-authority adopt gate (§2.2) ensures
that while in the poll-path degraded mode, the M7 strict-greater `savedAt` check still
prevents a stale server copy from overwriting a newer offline turn.

**Residual risk:** The offline client's action is lost. In multiplayer, the DM has presumably
already responded to another player's action while the offline client was gone, so discarding
the stale action is correct behavior.

**Chaos target:** Drop client's WebSocket, have it play a turn via the local path, reconnect,
assert the server state wins and no split-brain display. Verify same-millisecond `savedAt`
tie is broken by `turnSequence` (the dual-authority gate accepts it).

### F3 — Dropped or rejoining player (R4)

**Scenario:** A player disconnects mid-combat when they are the active player. The DM is
waiting for their action. Other players are blocked.

**Mitigation:** V1 has no auto-bump. The social expectation (per PRD) is that the host
narrates the missing player's action. The DM can submit a narrative action that progresses
the turn. V2 adds an AFK timeout and auto-bump.

**Residual risk:** The session stalls until the host intervenes. On a home LAN with 2–5
known players, this is acceptable for v1. If the disconnected player's client auto-reconnects
(backoff loop), they rejoin and their input is re-enabled in <30 seconds without host action.

**Chaos target:** Kill the active player's connection during combat; verify the session does
not crash or enter a deadlock; verify the other clients remain in valid `COMBAT` phase;
verify the disconnected client can rejoin and resume.

### F4 — Combat-turn desync (R5)

**Scenario:** Two clients show different `isActive` states (one shows player A active,
another shows player B active) due to a missed WebSocket event.

**Mitigation:** The `turnSequence` counter is included in every `session:update`. A client
that receives a `turnSequence` that is not `localTurnSequence + 1` (gap detected) requests
a full `session:state` resync from the server. The server is always the authority; the
resync eliminates the desync.

The dual-authority adopt gate (§2.2) ensures the `session:state` resync itself is accepted
when `turnSequence > localTurnSequence` — the same authority the gap detection keyed on,
now consistent. (Under the old `savedAt`-only gate, a gap-triggered resync could itself be
rejected if it arrived within the same millisecond as the previous update.)

**Residual risk:** There is a window between the gap detection and the resync where a client
might show a stale active player. This window is bounded by one round-trip on the LAN
(<50ms) and is not visible to users. The "wrong" client trying to act during this window
would receive `error: NOT_YOUR_TURN` from the server (using connection-bound identity) and
would be corrected by the incoming `session:state`.

**Chaos target:** Drop one `session:update` event (simulate packet loss by discarding it
in the WebSocket middleware), verify the client detects the gap and resyncs, verify
`isActive` converges within 500ms.

### F5 — Ollama mid-stream failure or timeout

**Scenario A:** The Ollama process crashes or the connection is dropped while the server is
reading the response stream. **Scenario B:** Ollama hangs indefinitely with no response
(EX-3C).

**Mitigation:** The server's Ollama fetch is wrapped in a try/catch and an AbortController
with a 90-second timeout (§3.5). On any error (including timeout):
1. The server broadcasts `dm:done { error: true, partial: fullTextSoFar }` to all clients
2. `phase` is reset to the pre-action resting phase (the state before the action was dequeued)
3. The per-room queue lock is released — the next queued action can fire
4. `turnSequence` is NOT incremented; no `.md` write
5. Clients display the partial content as an error message

This closes chaos EX-3C at the design level. Before this fix, a hung Ollama process would
wedge the room indefinitely.

**Residual risk (scenario A):** The partial DM response is displayed but not persisted. Players
see a truncated message. The DM can ask Ollama to retry (by the host resubmitting the
triggering action). This is the same failure mode as today in single-player; multiplayer does
not make it worse.

**Chaos target:** Kill the Ollama process mid-stream; verify all clients receive the error
message; verify `phase` resets to pre-action; verify `turnSequence` did not advance.
Hang Ollama mock (EX-3C): verify room is NOT permanently wedged; verify `dm:done {error:true}`
fires within 91s; verify next action succeeds.

### F6 — Server restart with live sessions

**Scenario:** The sync server process restarts while players are connected.

**Mitigation:** All in-memory room state (`rooms` Map, connection entries, action queue) is
lost. Clients detect the WebSocket close event and begin exponential backoff reconnect.
On reconnect, clients send `join` with `lastTurnSequence`. The server re-reads the `.md`
file from disk (last persisted state), reconstructs the room, and sends a full `session:state`.
The in-memory action queue restarts empty. The `phase` is restored from the `.md` `phase` field
(always a resting phase, per the phase-sanitize rule).

**Residual risk:** Any DM response that was in-flight when the server restarted is lost
(the Ollama call is abandoned). Players see the partial response (if any) that was already
broadcast via `dm:delta`, but it is not persisted. The last clean turn's state is fully
restored from the `.md` file.

**Chaos target:** Kill the server process mid-DM-stream; verify clients reconnect within
backoff; verify they receive the last persisted session state; verify the next action
succeeds; verify message count matches the last persisted turn.

### F7 — Two players acting on the same combat turn (R5)

**Scenario:** In the race window before `phase = "awaiting-dm"` reaches all clients,
two players both hit send.

**Mitigation:** See F1. The first action acquires the queue lock and sets `phase` to
`awaiting-dm`. The second action arrives at the server while `phase === "awaiting-dm"` and
is rejected with `error: DM_BUSY`. The second player's input text is preserved on their
client (not cleared) so they can resubmit on the next free-roam or their next combat turn.
Turn authorization uses connection-bound identity (§4.4), not the per-message `displayName`.

**Residual risk:** The second player receives an error and must resubmit manually. This is
a deliberate UX trade-off — automatic queuing of rejected actions would require the client
to speculatively hold and re-send, which adds complexity without clear benefit on a 2–5
player LAN session.

**Chaos target:** Two clients send `action` within 10ms of each other in free-roam mode;
assert exactly one succeeds, the other receives `error: DM_BUSY`; assert the DM responds
to exactly one; assert `turnSequence` advances by exactly 1.

---

## 9. Accepted/Deferred Risks (LAN-trust v1)

This section summarizes the security review's deferred items and the explicit out-of-scope
boundaries, so the user knows what is intentionally not addressed in v1.

**Accepted LAN risks (known, documented, not fixed in v1):**

| Risk | Why accepted | Mitigation / note |
|------|-------------|-------------------|
| Slot hijack on rejoin — any client on the LAN can join as a party member's name if their connection is closed | Intended LAN social mechanic; NAME_TAKEN guard prevents live impersonation of an active connection | Restart session to eject; v2 adds kick/host privilege |
| No host/kick privilege in v1 | Restart to eject a disruptive player; complexity vs. benefit on a 2–5 person home LAN | Deferred to v2 |
| Room exhaustion / unbounded in-memory rooms | Pre-existing Phase B property; `join` should not create a room (only HTTP PUT creates a `.md`); 30-min GC on inactive rooms | Document a practical room ceiling; block-G1 only under internet exposure |
| Unbounded `.md` growth (messages array) | Pre-existing Phase B property; 12 MB PUT is the practical ceiling | Document a per-session message cap recommendation |
| Room code (32-bit) not a secret; `/sessions` enumerates all stored sessions | Fine on a trusted LAN where all players are known | Document that room codes are not access control; never expose raw `/sessions` to the internet |
| Shared-context narrative prompt injection ("ignore previous instructions…") | Inherent to a shared LLM; inbound block-strip (item A) addresses the most dangerous variant | Server prepends a fixed in-fiction framing reminder; residual injection potential documented |
| Per-IP join rate limit absent | Not needed on a home LAN; trivially brute-forced on the internet | Block-G1 only under internet exposure |

**Internet-exposure guardrails — these items are EXPLICITLY OUT OF SCOPE for v1 and block-G1
only if raw internet exposure (non-Tailscale) becomes a product feature:**

1. Real authentication on `:3001` HTTP + WS (currently: none; trusted LAN only)
2. Per-IP rate limiting on `join` + `action` (currently: per-connection only)
3. Gate `GET /sessions` and `DELETE /session/:id` behind auth (currently: open on LAN)
4. Higher-entropy room codes or access tokens (currently: 32-bit room code)
5. Full internet-exposure hardening for the WS channel as a public real-time injection surface

**Tailscale is the only documented and safe WAN path.** The README already warns (L188–205)
that exposing `:3001`/`:11434` publicly lets anyone read/overwrite/delete sessions and abuse
the GPU. Multiplayer widens this by adding a persistent scriptable push channel and a
server-side Ollama proxy. The Tailscale path (encrypted, authenticated mesh) avoids all of
the above by not exposing ports publicly. If raw port-forwarding of `:3001`/`:11434` ever
becomes a product feature, all items in this list promote to block-G1.

---

## Decisions That Flow Forward

This section is the crisp handoff for D3 architect-reviewer and the three test-readiness
agents. All items are decision-dense and unambiguous.

### Transport

**Choice:** WebSocket (`ws` package) on port 3001, same process as the existing Express
sync server. `createSyncServer` refactored to create and return `http.Server` explicitly
(not `app`). `ws.WebSocketServer` attached with `noServer: true` + upgrade origin allowlist.
`maxPayload: 65536` (64 KB). All WS handlers try/catch'd; socket + server `error` handlers.

**Rationale:** The <500ms propagation target is unreachable with the 30s poll. SSE is
one-way; WebSocket handles bidirectional player-action + server-push in one connection.
Port 3001 is already allocated; no new port.

**Fallback:** 30s `pollSyncSession` auto-resumes when WebSocket is disconnected (or
`roomJoined` is false). No code removal from `useSessionPersistence.js`.

### DM trigger / election mechanism

**Mechanism:** Server-side Ollama proxy. No client calls Ollama in multiplayer mode.
Ollama URL from `OLLAMA_HOST` server env var only. `campaign.model` validated allowlist.

**Election:** None needed — the server is the sole DM trigger. Per-room action queue
(Promise chain using the existing `withLock` pattern) serializes all player actions.

**Guard:** `phase === "awaiting-dm"` is set server-side before calling Ollama and broadcast
immediately. Actions received while this phase is active are rejected with `DM_BUSY`.
This makes double-trigger structurally impossible.

**Timeout:** AbortController with 90-second timeout on every Ollama fetch. On expiry:
abort, release lock, reset phase to pre-action resting phase, broadcast `dm:done {error:true}`.
`turnSequence` not incremented; no `.md` write.

**Single-player fallback:** Client calls Ollama directly when `!isMultiplayerMode()`
(`wsState !== WS_OPEN || !roomJoined`). No code removal from `Chat.jsx`.

### Prompt assembly (server-side — not a thin fetch)

The server reproduces the full `Chat.jsx#sendMessage` pipeline:
1. `buildSystemPrompt(campaign)` — from genre engine via `getGenre(campaign.genre)`
2. `extractEntities(messages)` — appended to system prompt
3. Dice-message → text transform + `pendingCheck` folding — `pendingCheck` travels from
   client in the `action` envelope (`pendingCheck: { skill, dc } | null`)
4. `trimContext([...messages + userMsg])` — context window bound
5. Ollama `options` block — matches client values (`num_ctx: 8192`, `num_predict: 900`, etc.)

**Inbound security:** `action.content` stripped of `BLOCK_TAGS` fences before adding to
conversation. DM-output `verdict.roll` validated against server-recorded dice event.
Per-connection: ≤1 in-flight action + minimum interval enforced.

### Convergence gate (dual-authority)

**Live WS path:** admit `session:update` / `session:state` when
`turnSequence > localTurnSequence.current` OR `savedAt > local`. `turnSequence` is the
primary authority for live multiplayer; `savedAt` is a fallback tie-break.

**Poll path (offline/degraded):** preserve existing M7 strictly-greater `savedAt` gate.
No change to single-player behavior.

**`session:state` on join/rejoin:** always resets `lastSavedAt.current` and
`localTurnSequence.current` authoritatively (unconditional — `session:state` is the server's
definitive view).

**`9999` sentinel / `onNewSession`:** sentinel is still written for poll-path resurrection
blocking. Added: `localTurnSequence.current = -1` so the next `session:state` for the new
room (sequence ≥ 0) passes the `seqNewer` check and breaks the deaf state.

### State-machine state names and transitions

Resting (persisted) phases: `FREE_ROAM`, `COMBAT`
Transient (in-memory only) phases: `AWAITING_DM`, `RESOLVING`
Phase-sanitize rule: any non-resting phase is coerced to `free-roam` on serialization/load.

Transitions:
- `FREE_ROAM` + player action → `AWAITING_DM`
- `COMBAT` + active-player action → `AWAITING_DM`
- `COMBAT` + non-active-player action → `COMBAT` (rejected: `NOT_YOUR_TURN`)
- `AWAITING_DM` + Ollama stream done → `RESOLVING`
- `AWAITING_DM` + Ollama timeout (90s) → pre-action resting phase (reset)
- `RESOLVING` + blocks parsed + persisted → `FREE_ROAM` (all isActive false) or `COMBAT` (one isActive true)
- `AWAITING_DM` / `RESOLVING` + any player action → rejected: `DM_BUSY`
- Any state + reconnect → current resting phase from `.md` store (always a resting phase)

Turn authorization: connection-bound `displayName` (set at join). Per-message `displayName`
is ignored.

### New/changed `session.js` fields and schema version

`SCHEMA_VERSION` bumped from **1 → 2**.

New fields in the serialized payload (carried by both `serializeSession` and `toMarkdown`):
- `roomCode` — string | null — human-readable room alias; persisted to `.md`
- `phase` — `"free-roam" | "combat"` — **resting phases only**; coerced on write and read
- `turnSequence` — number (integer) — persisted to `.md`

Server-only in-memory fields (NOT in `.md`):
- `connections` — per-room client map
- `dmClientId` — current DM trigger holder (null; server owns the trigger)

Backward compatibility: `deserializeSession` accepts `schemaVersion === 1` and fills
`{ phase: 'free-roam', roomCode: null, turnSequence: 0 }`. `schemaVersion !== 1 && !== 2`
returns `null` (existing behavior). `serializeSession` now carries v2 fields so HTTP PUT
does not strip them.

`applyPartyUpdate` moves from `Chat.jsx` to `src/lib/session.js` as a named export
(same pure function, no behavior change).

### Phased build plan phase list

| Phase | Description | Key files touched |
|-------|-------------|-------------------|
| 0 | Schema + payload extension, `applyPartyUpdate` moved, v2 field round-trip tests | `src/lib/session.js`, `src/components/Chat.jsx` |
| 1 | WebSocket transport spike (server refactor + origin allowlist + NAME_TAKEN + client hook) | `server/sync-server.mjs`, `src/hooks/useWebSocket.js`, `package.json` |
| 2 | Server-authoritative state + broadcast; dual-authority adopt gate; sentinel reset | `server/sync-server.mjs`, `src/hooks/useSessionPersistence.js` |
| 3 | Single DM trigger: server-side Ollama proxy, full prompt assembly, timeout, block-strip, rate limit | `server/sync-server.mjs`, `src/components/Chat.jsx` |
| 4 | Free-roam multi-client (join flow, presence, messages, CI latency smoke) | `src/App.jsx`, `src/components/ApiKeySetup.jsx`, `src/components/Chat.jsx`, `src/hooks/useWebSocket.js` |
| 5 | Combat turn enforcement (phase gating, connection-bound identity, combat HUD) | `server/sync-server.mjs`, `src/components/Chat.jsx`, `src/components/PartyStrip.jsx`, `src/components/HistoryPanel.jsx` |
| 6 | Presence, disconnect, rejoin, orphaned room GC | `server/sync-server.mjs`, `src/hooks/useSessionPersistence.js`, `src/components/Chat.jsx` |
| 7 | Migration cutover + backward-compat verification + sessionId path-safety test | `src/hooks/useSessionPersistence.js`, `server/sync-server.mjs`, test suite |

Each phase is independently deployable and maps to a distinct test surface callable by
`npm test -- --run` (unit/integration) and the chaos experiments documented in D2.8.

---

## References

- `docs/design/MULTIPLAYER-PRD.md` — product decisions, success criteria, `.md` preservation constraint
- `docs/design/MULTIPLAYER-ORCHESTRATION.md` — work order (§3.1 D2), risk register (§5)
- `docs/design/MULTIPLAYER-ARCH-REVIEW.md` — D3 architect review (MC-1…MC-9, APPROVE-WITH-CHANGES)
- `docs/design/MULTIPLAYER-SECURITY-REVIEW.md` — D3b security review (items A…J + deferred list)
- `src/components/Chat.jsx` — `applyPartyUpdate`, `sendMessage`, structured-block parser,
  `isLoading` lifecycle, `BLOCK_TAGS`/`STRIP_RE`, `pendingCheck` dice-folding, `parseMarkdown`
- `src/hooks/useSessionPersistence.js` — M7 gate, `adopt()`, 30s poll, `9999` sentinel, `onNewSession`
- `server/sync-server.mjs` — `withLock`, atomic write, 409 LWW, HTTP endpoints, `createSyncServer`
- `src/lib/session.js` — `SCHEMA_VERSION`, `serializeSession`/`deserializeSession`, `toMarkdown`/`fromMarkdown`, `getLanHost`
- `src/lib/genres.js` / `src/lib/context.js` / `src/lib/context.starwars.js` — genre engines (`buildSystemPrompt`/`extractEntities`/`trimContext`) the server-side DM call imports
- `docs/design/CROSS-DEVICE-SYNC-EVALUATION.md` — M1–M6 constraints that carry forward
- Memory: `md-save-continue-requirement.md` — hard override requiring `.md` save/continue survival
