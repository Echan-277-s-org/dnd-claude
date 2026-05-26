# Multiplayer Architecture — D&D Campaign Assistant

> **Owner:** game-developer (D2)
> **Inputs:** MULTIPLAYER-PRD.md "Decisions that flow forward"; MULTIPLAYER-ORCHESTRATION.md §3.1 D2;
> source files: `src/components/Chat.jsx`, `src/hooks/useSessionPersistence.js`,
> `server/sync-server.mjs`, `src/lib/session.js`
> **Status:** DESIGN-ARC — architecture and phased build plan. No production feature code.

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
  phase,                // "free-roam" | "combat" | "awaiting-dm" | "resolving"
                        // derived from party.isActive flags but stored explicitly for
                        // instant broadcast and for .md resume fidelity
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

Fields excluded from `.md` (and therefore from `toMarkdown` / `fromMarkdown`):
- `connections` — ephemeral presence; meaningless after a restart
- `dmClientId` — ephemeral election result; re-elected per session

`toMarkdown` writes `phase` and `roomCode` as prose metadata lines (non-breaking for v1 readers),
and writes them into the `session` block so `fromMarkdown` can restore them — enabling a `.md`
resume to boot directly into the correct phase state.

`CAMPAIGN_KEYS` gains `sessionId` (already present) — no change needed there.

**Backward-compatibility rule for `deserializeSession`:**

```
if (obj.schemaVersion === 1) {
  // accept it, fill v2 defaults
  return { ...v1Fields, phase: 'free-roam', roomCode: null, turnSequence: 0 }
}
if (obj.schemaVersion === 2) {
  // normal path
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

**Same port, same process.** The HTTP server (`createSyncServer`) already returns an Express
`app`. The multiplayer upgrade attaches `ws` to the same `http.Server` instance returned by
`app.listen(3001)`. No new port; `CLAUDE.md`'s port 3001 assignment is honored. The existing
HTTP REST endpoints (`GET/PUT/DELETE /session/:id`, `GET /sessions`) remain unchanged — they
serve the single-player offline path and the `.md` download button.

**URL scheme:** `ws://<host>:3001/ws`

### 2.2 What replaces `pollSyncSession`

`pollSyncSession` (in `session.js`) is NOT removed — it stays as the offline fallback.
`useSessionPersistence.js` is extended, not replaced:

- When the WebSocket is connected, the 30s poll is **suspended** (the `setInterval` is not
  started while the socket is open). Push events make polling redundant.
- When the WebSocket is disconnected (network hiccup, server restart), the 30s poll
  **resumes automatically** — the app degrades to today's Phase B behavior seamlessly.
- The M7 strictly-newer `adopt()` gate and the `'9999-...'` sentinel are preserved
  unchanged; they guard both the poll path and the WebSocket `session:update` event path.

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

Server → client event types:
- `session:state` — full session snapshot (on join or reconnect)
- `session:update` — incremental: `{ messages, party, phase, turnSequence, savedAt }`
- `dm:delta` — streaming DM response chunk: `{ delta, assistantId, turnSequence }`
- `dm:done` — DM stream complete: `{ fullText, turnSequence }` (triggers structured-block parse)
- `presence:update` — current player list with connection status
- `error` — `{ code, message }` (invalid room, schema mismatch, etc.)

Client → server event types:
- `join` — `{ roomCode, displayName, sessionId, lastTurnSequence }`
- `action` — `{ content, type: "user"|"dice", displayName }` — a player's turn input
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
3. Fires **exactly one** Ollama POST per queued action (using the `OLLAMA_HOST` the server
   already has access to, same environment variable the client currently derives via `getLanHost`)
4. Streams the response back to all clients via `dm:delta` events
5. On stream completion, applies structured-block parsing server-side and broadcasts
   `dm:done` plus `session:update` with the new party/phase state

**The client's `sendMessage` function in `Chat.jsx` is refactored to:**

```javascript
// Before (single-player): direct Ollama fetch
// After (multiplayer): send action to server via WebSocket
wsRef.current.send(JSON.stringify({
  type: 'action',
  roomCode,
  payload: { content: trimmed, type: 'user', displayName: myDisplayName }
}))
// No local isLoading toggle here — the server sends dm:delta events
// which drive the loading state on all clients uniformly
```

Single-player mode: when the WebSocket is disconnected or the client is alone in a room,
the `sendMessage` path falls back to the direct Ollama fetch (today's behavior). The
"am I the only client?" check is: `connectionCount === 1` received in the last `presence:update`,
OR the WebSocket is not connected. This keeps single-player fully functional with no code removal.

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
2. Applies `applyPartyUpdate` server-side (the same pure function, imported into the server)
3. Sets `phase` based on the new party state:
   - Any member with `isActive: true` → `"combat"`
   - All members `isActive: false` → `"free-roam"`
4. Increments `turnSequence`
5. Persists the updated session to the `.md` store (`toMarkdown` + atomic temp+rename)
6. Broadcasts `dm:done` and `session:update` to all clients

### 3.5 Ollama connection reuse

The server opens one Ollama stream per room action, sequentially. No connection pool is needed
for 2–5 players on a LAN — Ollama processes one request at a time anyway (single-threaded
inference). The per-room action queue enforces this naturally.

---

## 4. Turn/Initiative State Machine

### 4.1 State names and definitions

```
FREE_ROAM        — default; any player may submit an action; no turn enforcement
AWAITING_DM      — server is calling Ollama; no player input accepted; all clients locked
RESOLVING        — DM stream complete; server is parsing structured blocks and persisting;
                   lasts <200ms; no player input
COMBAT           — a party member has isActive:true; only that player's input accepted
```

### 4.2 State transition diagram

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                                                         │
                  ▼                                                         │
           ┌────────────┐    any player action received                    │
           │            │ ─────────────────────────────► ┌──────────────┐  │
           │ FREE_ROAM  │                                 │              │  │
           │            │ ◄──── phase reset by DM ─────── │ AWAITING_DM  │  │
           └────────────┘    (party block: all isActive   │              │  │
                │             false or omitted)           └──────────────┘  │
                │                                                ▼          │
                │                                         ┌──────────────┐  │
                │                                         │  RESOLVING   │  │
                │                                         │ (<200ms)     │  │
                │                                         └──────────────┘  │
                │                                                │          │
                │                              party block: one  │          │
                │                              isActive=true ────┼──────►   │
                │                                                │   ┌──────────┐
                │                              party block: all  │   │          │
                │                              isActive=false ───┼──►│  COMBAT  │
                │             active player    or omitted        │   │          │
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
| RESOLVING | structured blocks parsed + persisted | FREE_ROAM or COMBAT | based on party isActive |
| COMBAT | active player `action` received | AWAITING_DM | sender must match active member name |
| COMBAT | non-active player `action` received | COMBAT | rejected with `error: NOT_YOUR_TURN` |
| any | server restart / reconnect | (current phase from .md) | |

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

Server-side enforcement (clients reinforce visually but are not trusted alone):

| Phase | Who can act | Server action on unauthorized input |
|-------|-------------|-------------------------------------|
| FREE_ROAM | Any connected player | Accept; queue behind any in-flight DM call |
| AWAITING_DM | Nobody | Return `error: DM_BUSY` to sender |
| RESOLVING | Nobody | Return `error: DM_BUSY` to sender |
| COMBAT | Player whose `displayName` case-insensitively matches the `isActive` member | Accept and queue; return `error: NOT_YOUR_TURN` to any other sender |

Client-side enforcement (UI layer):
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

Join URL format: `http://<LAN-IP>:5173?room=dnd-a1b2c3d4`

When a client opens this URL, `App.jsx` reads the `?room` query parameter and prefills the
join screen with the room code, so the player only needs to type their display name.

### 5.2 Player → connection → party slot binding

The join flow is a WebSocket handshake after the HTTP page loads:

```
Client                                    Server
  │                                         │
  │── ws://host:3001/ws ──────────────────► │  (WebSocket upgrade)
  │                                         │
  │── { type:"join",                        │
  │     roomCode:"dnd-a1b2c3d4",           │
  │     displayName:"Alex",                │
  │     sessionId:"uuid...",               │
  │     lastTurnSequence: 0 } ────────────► │
  │                                         │  1. Validate roomCode → sessionId
  │                                         │  2. Load session from .md store
  │                                         │  3. Name-match against party array
  │                                         │     (same applyPartyUpdate logic)
  │                                         │  4. Add to in-memory connections map
  │                                         │  5. Broadcast presence:update to all
  │                                         │
  │◄── { type:"session:state",              │
  │      payload: fullSession } ───────────│
  │                                         │
  │◄── { type:"presence:update",            │
  │      payload: [{ displayName, status }] }│
```

The server's in-memory connections map per room:

```javascript
// server-side pseudocode (in-memory; not persisted)
rooms.get(roomCode) = {
  sessionId: "uuid...",
  clients: Map<ws, { displayName, partyId, connectedAt }>,
  actionQueue: Promise,   // the withLock chain for DM trigger serialization
  phase: "free-roam",     // authoritative phase
  turnSequence: 7,        // current turn counter
}
```

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
1. Re-adds the connection to `rooms[roomCode].clients` with the same `partyId` (name-match)
2. If `lastTurnSequence < server.turnSequence`, sends a full `session:state` snapshot
3. Otherwise sends the incremental state since the client's last turn
4. Broadcasts `presence:update` to show the player is back

Rejoin is silent and automatic — no prompt, no confirmation, no draft recovery (acceptable
per PRD). The server-authoritative session state ensures no stale data.

**Orphaned rooms:** When all clients disconnect from a room, the server keeps the room's
`.md` file but can garbage-collect the in-memory entry after 30 minutes of inactivity.
The `GET /sessions` endpoint remains available for future reconnects.

### 5.4 LAN trust boundary (R4)

No auth tokens, no passwords. Clients on the same LAN that know the room code can join
with any display name. Trust is physical (home network). The host ejects unwanted players
by restarting the session (clear session → new `sessionId` + new room code). A "kick"
button is deferred to v2.

Input validation on the server:
- `roomCode` must match `ID_RE` (existing regex in `sync-server.mjs`)
- `displayName` is trimmed, max 64 characters, must be non-empty
- `action.content` is trimmed, max 4096 characters, HTML-stripped (existing defensive posture)
- `turnSequence` from clients is informational only — the server never trusts client turn counts

---

## 6. Migration Path from Current LWW Sync Layer

The migration is additive and gated per phase so single-player never regresses.

### 6.1 Current state (today)

- `useSessionPersistence.js`: 30s poll, handoff-first LWW, M7 gate, `9999` sentinel
- `sync-server.mjs`: HTTP REST only (`GET/PUT/DELETE /session/:id`, `GET /sessions`)
- `Chat.jsx`: direct `fetch` to Ollama on every send
- `.md` store: `server/sessions/` folder of `toMarkdown` files

### 6.2 Migration steps

**Step 1 — WebSocket endpoint added to sync server (non-breaking)**

Add the `ws` package to `server/sync-server.mjs`. Attach a WebSocket server to the same
`http.Server` at `/ws`. The existing HTTP routes are unchanged. No client code changes yet.
Single-player sessions continue to work exactly as today — they never connect to `/ws`.

Touches: `server/sync-server.mjs`, `package.json` (add `ws`)

**Step 2 — Server-side Ollama proxy added (non-breaking)**

Add the DM trigger logic to the sync server: per-room action queue, `withLock`-style
Promise chain, Ollama fetch (server-side), `dm:delta` / `dm:done` broadcast, server-side
`applyPartyUpdate` and structured-block parse.

Add `applyPartyUpdate` (currently in `Chat.jsx`) as a pure function exported from
`src/lib/session.js` so both the client and server can import it without duplication.

`SCHEMA_VERSION` bumped from 1 to 2. `deserializeSession` gains the v1-compatibility branch.
`toMarkdown` / `fromMarkdown` gain `phase`, `roomCode`, `turnSequence` in the `session` block.

Touches: `server/sync-server.mjs`, `src/lib/session.js`

**Step 3 — Client WebSocket layer added to `useSessionPersistence.js`**

Add a WebSocket connection manager. When the socket is open:
- Suspend the 30s poll (`pollSyncSession`)
- Route `session:update` and `dm:delta` events through the existing `adopt()` path
  (M7 gate applies identically — `payload.savedAt > local` is still the condition)
- The `onNewSession` / `9999` sentinel logic is unchanged

The 30s poll auto-resumes when the socket closes. This is purely additive — single-player
clients that never connect a WebSocket run the poll path as before.

Touches: `src/hooks/useSessionPersistence.js`

**Step 4 — `Chat.jsx` refactored to multiplayer mode**

`sendMessage` becomes mode-aware:
- **Multiplayer mode** (WebSocket connected + `connectionCount > 1`): send `action` event
  over WebSocket; remove local Ollama fetch; receive DM response via `dm:delta` events
- **Single-player mode** (WebSocket disconnected OR alone in room): existing direct Ollama
  fetch, unchanged code path

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

The M7 gate in `adopt()` and the 409 staleness check in `sync-server.mjs` are preserved
unchanged and continue to govern the single-player offline path. In multiplayer mode they
serve as a last-resort conflict guard:
- A client that has been offline and rejoins receives a `session:state` event; the `adopt()`
  gate accepts it because the server's `savedAt` is newer than local.
- A concurrent PUT from an offline client (if somehow submitted) still hits the 409 guard;
  the WebSocket push reconciles the client immediately after.
- The `9999` sentinel is still written by `onNewSession` — it blocks resurrection via the
  WebSocket `session:update` path just as it blocks the poll path today.

### 6.3 `.md` save/continue preservation (R3)

The `.md` store is **not replaced** at any migration step:

- `server/sessions/<sessionId>.md` is still written on every `dm:done` event (same atomic
  temp+rename, same `toMarkdown` function, same folder)
- The "Save session (.md)" button in `Chat.jsx` (`handleSaveSession`) is unchanged —
  it serializes local state to a Markdown blob for download
- `fromMarkdown` still boots the app directly into play when a file with a `session` block
  is loaded on the setup screen
- A `.md` file saved during a multiplayer session includes `roomCode`, `phase`, and
  `turnSequence` in the `session` block; when loaded as single-player, these fields are
  ignored gracefully (the app starts in free-roam, which is correct)

The only new behavior: `toMarkdown` includes the two new persisted fields (`phase`,
`roomCode`) as a comment line in the metadata header and in the `session` block. The prose
section is unchanged. An LLM loading the file sees no difference.

---

## 7. Phased Build Plan

Each phase is independently shippable, has a defined test surface, and does not break any
prior phase. The phase list is ordered for the D3 reviewer and for the V1 implementation
agents named in MULTIPLAYER-ORCHESTRATION.md §6.

### Phase 0 — Schema and payload extension (foundation; no user-visible change)

**Goal:** Bump `SCHEMA_VERSION` to 2, add v2 fields, prove backward compat.

Files touched:
- `src/lib/session.js` — `SCHEMA_VERSION = 2`, `deserializeSession` v1-compat branch,
  `toMarkdown`/`fromMarkdown` write/read `phase`/`roomCode`/`turnSequence`,
  export `applyPartyUpdate` (moved from `Chat.jsx`)
- `src/components/Chat.jsx` — import `applyPartyUpdate` from `session.js` instead of
  defining it locally

Test surface: existing Vitest schema tests, plus new unit tests for v1→v2 deserialization
and `toMarkdown`/`fromMarkdown` round-trips with v2 fields. All 274 existing tests must
remain green.

Agent: `react-specialist` (session.js is pure JS; `test-automator` writes new schema tests)

### Phase 1 — WebSocket transport spike (server + stub client)

**Goal:** Add `/ws` endpoint to the sync server. Prove connection, keepalive, and
reconnect work on LAN. No multiplayer game logic yet.

Files touched:
- `server/sync-server.mjs` — attach `ws.WebSocketServer` to the `http.Server`; handle
  `ping/pong`; per-room `clients` Map; `join` message accepted and echoed back as
  `session:state` (serves current `.md` content, no action queue yet)
- `package.json` — add `ws` dependency
- New `src/hooks/useWebSocket.js` — connection manager: connect on mount, exponential
  backoff reconnect, `send()` helper, event emitter interface

Test surface: integration test with two simulated `ws` clients connecting to a test server
instance, verifying `join` → `session:state` roundtrip. Node-env test environment.

Agent: `websocket-engineer`

### Phase 2 — Server-authoritative state + broadcast

**Goal:** Server becomes the write path for party/message/phase state. All connected
clients receive `session:update` when the state changes (but Ollama is still called by the
client in this phase — a placeholder `action:echo` handler is used).

Files touched:
- `server/sync-server.mjs` — per-room action queue (`withLock` pattern), `action:echo`
  broadcasts received messages back to all clients in the room as `session:update`;
  `phase` and `turnSequence` managed server-side
- `src/hooks/useSessionPersistence.js` — WebSocket event handler added; `session:update`
  and `session:state` routed through `adopt()` (M7 gate active); 30s poll suspended while
  socket open

Test surface: two simulated clients in the same room — client A sends a message, client B
receives `session:update`. Phase field syncs. Reconnect test: client drops and rejoins,
receives current state.

Agent: `websocket-engineer` + `backend-developer`

### Phase 3 — Single DM trigger (server-side Ollama proxy)

**Goal:** Server calls Ollama. Client `sendMessage` path is refactored to send `action`
over WebSocket in multiplayer mode. DM double-trigger becomes structurally impossible.

Files touched:
- `server/sync-server.mjs` — server-side Ollama fetch, `dm:delta` broadcast, `dm:done`
  handler with structured-block parse (`extractBlock`, `applyPartyUpdate` imported from
  `src/lib/session.js`), `.md` store write on `dm:done`, `phase` updated from party block,
  `turnSequence` incremented
- `src/components/Chat.jsx` — `sendMessage` becomes mode-aware: WebSocket `action` send
  in multiplayer mode, existing fetch in single-player mode; `dm:delta` events drive
  `isLoading` and message accumulation

Test surface: single simulated client sends `action`, verifies exactly one Ollama call is
made (mock Ollama endpoint), exactly one `dm:done` is broadcast, `.md` file is written,
`turnSequence` advances. Two clients simultaneously send `action` — verify only one Ollama
call fires and the second is queued.

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
  display name; `PartyStrip` and `HistoryPanel` receive `connections` (presence) data

Test surface: two browser windows on the same LAN open the same room code, both see the
other's messages in real time. Latency measurement: message appears on client B within 500ms
of client A sending.

Agent: `react-specialist` (client UI) + `websocket-engineer` (room join) +
`frontend-developer` (setup screen join flow)

### Phase 5 — Combat turn enforcement

**Goal:** `phase === "combat"` enforced on server and client. Only the active player's
input is accepted. Combat HUD active.

Files touched:
- `server/sync-server.mjs` — `action` handler checks `phase` and `displayName` vs active
  member; rejects non-active with `error: NOT_YOUR_TURN`
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
- `src/hooks/useSessionPersistence.js` — reconnect triggers `join` with `lastTurnSequence`
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

Test surface: run entire existing Vitest suite. Load a v1 `.md` file — verify it opens in
free-roam with no errors. Save a v2 session as `.md` — verify it loads on a fresh client.
Single-player session: disconnect WebSocket, verify 30s poll resumes, verify M7 gate still
blocks stale adoption.

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

**Mitigation:** The M7 strictly-newer gate in `adopt()` is preserved. On reconnect, the
server sends `session:state` with its `savedAt`. If `payload.savedAt > local`, the client
adopts the server state. The offline turn is discarded (same behavior as today's Phase B).

**Residual risk:** The offline client's action is lost. This is the same trade-off as today's
single-player Phase B LWW — it is documented in the PRD as acceptable ("handoff-first"). In
multiplayer, the DM has presumably already responded to another player's action while the
offline client was gone, so discarding the stale action is correct behavior.

**Chaos target:** Drop client's WebSocket, have it play a turn via the local path, reconnect,
assert the server state wins and no split-brain display.

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

**Residual risk:** There is a window between the gap detection and the resync where a client
might show a stale active player. This window is bounded by one round-trip on the LAN
(<50ms) and is not visible to users. The "wrong" client trying to act during this window
would receive `error: NOT_YOUR_TURN` from the server and would be corrected by the
incoming `session:state`.

**Chaos target:** Drop one `session:update` event (simulate packet loss by discarding it
in the WebSocket middleware), verify the client detects the gap and resyncs, verify
`isActive` converges within 500ms.

### F5 — Ollama mid-stream failure

**Scenario:** The Ollama process crashes or the connection is dropped while the server is
reading the response stream.

**Mitigation:** The server's Ollama fetch is wrapped in a try/catch. On error mid-stream,
the server broadcasts `dm:done` with `{ error: true, partial: fullTextSoFar }`. Clients
display the partial content as an error message (same `error: true` flag as the current
single-player path in `Chat.jsx`). The `phase` is reset to its pre-action state (the
action queue lock is released), and the DM's turn is considered failed — no `turnSequence`
increment, no `.md` write.

**Residual risk:** The partial DM response is displayed but not persisted. Players see a
truncated message. The DM can ask Ollama to retry (by the host resubmitting the triggering
action). This is the same failure mode as today in single-player; multiplayer does not
make it worse.

**Chaos target:** Kill the Ollama process mid-stream; verify all clients receive the error
message; verify `phase` resets to pre-action; verify `turnSequence` did not advance;
verify the next player action triggers a fresh Ollama call successfully.

### F6 — Server restart with live sessions

**Scenario:** The sync server process restarts while players are connected.

**Mitigation:** All in-memory room state (`rooms` Map, connection entries, action queue) is
lost. Clients detect the WebSocket close event and begin exponential backoff reconnect.
On reconnect, clients send `join` with `lastTurnSequence`. The server re-reads the `.md`
file from disk (last persisted state), reconstructs the room, and sends a full `session:state`.
The in-memory action queue restarts empty. The `phase` is restored from the `.md` `phase` field.

**Residual risk:** Any DM response that was in-flight when the server restarted is lost
(the Ollama call is abandoned). Players see the partial response (if any) that was already
broadcast via `dm:delta`, but it is not persisted. The last clean turn's state is fully
restored from the `.md` file. This is the same recovery point as today's Phase B offline
mode.

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

**Residual risk:** The second player receives an error and must resubmit manually. This is
a deliberate UX trade-off — automatic queuing of rejected actions would require the client
to speculatively hold and re-send, which adds complexity without clear benefit on a 2–5
player LAN session.

**Chaos target:** Two clients send `action` within 10ms of each other in free-roam mode;
assert exactly one succeeds, the other receives `error: DM_BUSY`; assert the DM responds
to exactly one; assert `turnSequence` advances by exactly 1.

---

## Decisions That Flow Forward

This section is the crisp handoff for D3 architect-reviewer and the three test-readiness
agents. All items are decision-dense and unambiguous.

### Transport

**Choice:** WebSocket (`ws` package) on port 3001, same process as the existing Express
sync server. Attach to the same `http.Server` at path `/ws`.

**Rationale:** The <500ms propagation target is unreachable with the 30s poll. SSE is
one-way; WebSocket handles bidirectional player-action + server-push in one connection.
Port 3001 is already allocated; no new port.

**Fallback:** 30s `pollSyncSession` auto-resumes when WebSocket is disconnected. No code
removal from `useSessionPersistence.js`.

### DM trigger / election mechanism

**Mechanism:** Server-side Ollama proxy. No client calls Ollama in multiplayer mode.

**Election:** None needed — the server is the sole DM trigger. Per-room action queue
(Promise chain using the existing `withLock` pattern) serializes all player actions.

**Guard:** `phase === "awaiting-dm"` is set server-side before calling Ollama and broadcast
immediately. Actions received while this phase is active are rejected with `DM_BUSY`.
This makes double-trigger structurally impossible.

**Single-player fallback:** Client calls Ollama directly when WebSocket is disconnected or
connection count is 1. No code removal from `Chat.jsx`.

### State-machine state names and transitions

States: `FREE_ROAM`, `AWAITING_DM`, `RESOLVING`, `COMBAT`

Transitions:
- `FREE_ROAM` + player action → `AWAITING_DM`
- `COMBAT` + active-player action → `AWAITING_DM`
- `COMBAT` + non-active-player action → `COMBAT` (rejected: `NOT_YOUR_TURN`)
- `AWAITING_DM` + Ollama stream done → `RESOLVING`
- `RESOLVING` + blocks parsed + persisted → `FREE_ROAM` (all isActive false) or `COMBAT` (one isActive true)
- `AWAITING_DM` / `RESOLVING` + any player action → `AWAITING_DM` (rejected: `DM_BUSY`)
- Any state + reconnect → current phase from `.md` store (server authoritative)

### New/changed `session.js` fields and schema version

`SCHEMA_VERSION` bumped from **1 → 2**.

New fields in the payload:
- `roomCode` — string | null — human-readable room alias; persisted to `.md`
- `phase` — `"free-roam" | "combat" | "awaiting-dm" | "resolving"` — persisted to `.md`
- `turnSequence` — number (integer) — persisted to `.md`

Server-only in-memory fields (NOT in `.md`):
- `connections` — per-room client map
- `dmClientId` — current DM trigger holder (null; server owns the trigger)

Backward compatibility: `deserializeSession` accepts `schemaVersion === 1` and fills
`{ phase: 'free-roam', roomCode: null, turnSequence: 0 }`. `schemaVersion !== 1 && !== 2`
returns `null` (existing behavior).

`applyPartyUpdate` moves from `Chat.jsx` to `src/lib/session.js` as a named export
(same pure function, no behavior change).

### Phased build plan phase list

| Phase | Description | Key files touched |
|-------|-------------|-------------------|
| 0 | Schema + payload extension, `applyPartyUpdate` moved | `src/lib/session.js`, `src/components/Chat.jsx` |
| 1 | WebSocket transport spike (server endpoint + client hook) | `server/sync-server.mjs`, `src/hooks/useWebSocket.js`, `package.json` |
| 2 | Server-authoritative state + broadcast | `server/sync-server.mjs`, `src/hooks/useSessionPersistence.js` |
| 3 | Single DM trigger (server-side Ollama proxy) | `server/sync-server.mjs`, `src/components/Chat.jsx` |
| 4 | Free-roam multi-client (join flow, presence, messages) | `src/App.jsx`, `src/components/ApiKeySetup.jsx`, `src/components/Chat.jsx`, `src/hooks/useWebSocket.js` |
| 5 | Combat turn enforcement (phase gating, combat HUD) | `server/sync-server.mjs`, `src/components/Chat.jsx`, `src/components/PartyStrip.jsx`, `src/components/HistoryPanel.jsx` |
| 6 | Presence, disconnect, rejoin, orphaned room GC | `server/sync-server.mjs`, `src/hooks/useSessionPersistence.js`, `src/components/Chat.jsx` |
| 7 | Migration cutover + backward-compat verification | `src/hooks/useSessionPersistence.js`, `server/sync-server.mjs`, test suite |

Each phase is independently deployable and maps to a distinct test surface callable by
`npm test -- --run` (unit/integration) and the chaos experiments documented in D2.8.

---

## References

- `docs/design/MULTIPLAYER-PRD.md` — product decisions, success criteria, `.md` preservation constraint
- `docs/design/MULTIPLAYER-ORCHESTRATION.md` — work order (§3.1 D2), risk register (§5)
- `src/components/Chat.jsx` — `applyPartyUpdate`, `sendMessage`, structured-block parser, `isLoading` lifecycle
- `src/hooks/useSessionPersistence.js` — M7 gate, `adopt()`, 30s poll, `9999` sentinel, `onNewSession`
- `server/sync-server.mjs` — `withLock`, atomic write, 409 LWW, HTTP endpoints
- `src/lib/session.js` — `SCHEMA_VERSION`, `serializeSession`/`deserializeSession`, `toMarkdown`/`fromMarkdown`, `getLanHost`
- `docs/design/CROSS-DEVICE-SYNC-EVALUATION.md` — M1–M6 constraints that carry forward
- Memory: `md-save-continue-requirement.md` — hard override requiring `.md` save/continue survival
