# Multiplayer Test Automation Design

> **Owner:** test-automator (D2-test)
> **Inputs:** MULTIPLAYER-ARCHITECTURE.md §1.2, §2, §3, §4, §5, §6, §7, §8;
> MULTIPLAYER-PRD.md §5 success criteria; MULTIPLAYER-ORCHESTRATION.md §3.2;
> existing Vitest suite (274 tests, `npm test -- --run`);
> `src/lib/session.test.js`, `server/sync-server.test.mjs`,
> `src/hooks/useSessionPersistence.test.jsx`.
> **Status:** DESIGN-ARC — skeleton files created and confirmed skipped.
> No implementation. Remove `.skip` per phase as V1 code lands.

---

## 1. Test Pyramid for Multiplayer

### 1.1 What belongs in the Vitest unit tier (jsdom or node-env, no sockets)

These are pure function and hook tests. They run in the existing `npm test -- --run`
command, finish in milliseconds, and need no network, no WebSocket, no Ollama process.

| Test subject | Environment | Existing file | New skeleton file |
|---|---|---|---|
| `SCHEMA_VERSION = 2` constant | jsdom | `session.test.js` (extend) | `src/lib/session.multiplayer.test.js` |
| `deserializeSession` v1→v2 backward-compat branch | jsdom | same | same |
| `deserializeSession` v2 native round-trip | jsdom | same | same |
| `toMarkdown` / `fromMarkdown` v2 field round-trips | jsdom | same | same |
| `applyPartyUpdate` as a named export from `session.js` | jsdom | `Chat.test.jsx` (regression mirror) | `src/lib/session.multiplayer.test.js` |
| `makeRoomCode` derivation helper | jsdom | — | `src/lib/session.multiplayer.test.js` |
| `phaseReducer` pure state-machine transitions | jsdom | — | `src/lib/turnStateMachine.test.js` |
| `useWebSocket` connection lifecycle (MockWebSocket) | jsdom | — | `src/hooks/useWebSocket.test.js` |
| `useWebSocket` inbound event routing | jsdom | same | same |
| `useWebSocket` backoff reconnect (fake timers) | jsdom | same | same |
| `useWebSocket` poll-suspend signal | jsdom | same | same |
| M7 gate on WebSocket `session:update` path | jsdom | `useSessionPersistence.test.jsx` (extend) | `src/hooks/useWebSocket.test.js` |

**Why these stay in jsdom / unit:**

- `session.js` is a pure module: all its functions take and return plain data.
  Adding v2 fields does not change that; the round-trip tests remain O(µs).
- `phaseReducer` (if extracted as a standalone export) is a pure transition
  function — no async, no I/O. If the final implementation buries the state
  machine inside `sync-server.mjs` without exporting it, the transition
  assertions move to the Phase 5 describe-block in
  `server/sync-server.multiplayer.test.mjs`.
- `useWebSocket` is tested against a `MockWebSocket` class that replaces
  `global.WebSocket` via `vi.stubGlobal`. No real port, no real server.
  This is the same pattern used for mocking `fetch` in `session.test.js`
  and for mocking `loadSyncSession` / `saveSyncSession` in
  `useSessionPersistence.test.jsx`.

### 1.2 What requires the node-env integration harness (real sockets, real server)

Real-time multi-client behavior cannot be mocked adequately at the unit level
because the correctness property is emergent: "broadcast reaches all connected
clients," "only one Ollama call fires," and "DM_BUSY rejection is sent to the
right sender" require actual TCP connections and message sequencing.

| Test subject | Environment | Skeleton file |
|---|---|---|
| `/ws` endpoint upgrade, join → `session:state` | node-env | `server/sync-server.multiplayer.test.mjs` |
| Two-client broadcast: A sends, B receives `session:update` | node-env | same |
| Reconnect with stale `lastTurnSequence` → full `session:state` | node-env | same |
| Exactly one mock-Ollama call per action (Phase 3 guarantee) | node-env | same |
| `dm:delta` fan-out to all clients | node-env | same |
| `dm:done` increments `turnSequence` by exactly 1 | node-env | same |
| `.md` file written after `dm:done` | node-env | same |
| Concurrent actions → one succeeds, one gets `DM_BUSY` | node-env | same |
| `NOT_YOUR_TURN` rejection in combat phase | node-env | same |
| Active player accepted in combat phase | node-env | same |
| Combat → free-roam on `dm:done` with all `isActive: false` | node-env | same |
| Disconnect → `presence:update` broadcast | node-env | same |
| Rejoin after disconnect → `session:state` resync | node-env | same |
| DM stream completes after triggering client disconnects | node-env | same |
| Active combat player disconnects → server stays alive | node-env | same |
| Orphaned room GC after 30 min inactivity (fake timers) | node-env | same |
| HTTP PUT v2 payload → GET round-trip preserves v2 fields | node-env | same |
| HTTP PUT v1-shaped payload → GET returns v2 defaults | node-env | same |
| 409 LWW guard with v2 payload shape (R2 regression) | node-env | same |
| Single-player one-client session indistinguishable from today | node-env | same |

**Why these must be node-env (not jsdom):**

The `ws` package creates real OS-level TCP sockets. The `http.Server` returned by
`createSyncServer().listen(0)` binds a port. Neither works in jsdom. The existing
`server/sync-server.test.mjs` already carries `// @vitest-environment node` and
uses this exact pattern (`listen(0)` for an ephemeral port, `mkdtemp` for an
isolated sessions directory, `fetch` from Node 18+). All new integration tests
follow the same harness.

### 1.3 What stays out of automated tests (manual / chaos tier)

- **Latency measurement** (< 500 ms propagation, < 3 s join time): timing asserts
  are inherently flaky on CI runners with variable load. These are acceptance
  criteria validated by the chaos-engineer with controlled LAN hardware
  per `MULTIPLAYER-CHAOS-PLAN.md`.
- **Visual HUD correctness** (turn-pill animation, PartyStrip combat overlay):
  these are CSS + React rendering concerns. Covered by manual review during
  Phase 5 (combat HUD) and by the `ui-ux-tester` agent after V1.
- **Ollama model behavior** (does the LLM actually emit a valid `party` block):
  model compliance is validated by the `ml-engineer` per
  `PARTY-HUD-QWEN-VALIDATION.md`. The automated tests use mock Ollama responses
  with deterministic content; they do not rely on a real Ollama instance.
- **Cross-browser / cross-device propagation**: manual LAN play test per PRD
  §5.1 after V1 ships.

---

## 2. Multi-Client Harness Design

### 2.1 Server fixture

Every node-env integration test that needs WebSocket clients uses this fixture
pattern, mirroring the existing `sync-server.test.mjs` structure:

```js
// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import http from 'node:http'
import { createSyncServer } from './sync-server.mjs'

async function startTestServer(ollamaChunks = ['The ', 'doors ', 'groan.']) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dnd-mp-'))
  const mockOllama = await startMockOllama(ollamaChunks)
  process.env.OLLAMA_HOST = `127.0.0.1:${mockOllama.port}`
  const httpServer = await new Promise(resolve => {
    const s = createSyncServer({ sessionsDir: dir }).listen(0, () => resolve(s))
  })
  const port = httpServer.address().port
  return {
    base:      `http://127.0.0.1:${port}`,
    wsBase:    `ws://127.0.0.1:${port}`,
    mockOllama,
    server:    httpServer,
    dir,
  }
}
```

Key design choices:

- **Port 0** — the OS assigns an ephemeral port; tests never collide, never need
  port cleanup.
- **`mkdtemp` isolated dir** — each test suite (`beforeAll`) gets its own temp
  directory; `afterAll` removes it. This mirrors `sync-server.test.mjs` exactly.
- **`beforeEach` clears sessions** — the existing suite already does
  `for (const f of await readdir(dir)) await rm(...)` to isolate test cases.
  Integration tests that need a clean room use the same pattern.
- **Ephemeral `listen(0)` + `server.close(r)` in `afterAll`** — ports are released
  immediately; no lingering handles that would cause Vitest to warn.

### 2.2 Simulated clients

```js
function connectClient(wsBase, joinPayload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`)
    ws.once('error', reject)
    ws.once('open', () => ws.send(JSON.stringify({ type: 'join', ...joinPayload })))
    ws.once('message', data => resolve({ ws, firstMessage: JSON.parse(data) }))
  })
}

function collectMessages(ws, n) {
  return new Promise(resolve => {
    const msgs = []
    ws.on('message', data => {
      msgs.push(JSON.parse(data))
      if (msgs.length >= n) resolve(msgs)
    })
  })
}
```

For tests that need to assert **broadcast ordering** across N clients, each client
calls `collectMessages` concurrently before any action is sent:

```js
const [msgsA, msgsB] = await Promise.all([
  collectMessages(clientA.ws, 4),
  collectMessages(clientB.ws, 4),
])
clientA.ws.send(JSON.stringify({ type: 'action', ... }))
// Both arrays settle in order; compare turnSequence fields to verify ordering.
```

This approach avoids time-based waits (`setTimeout`) that cause flakiness on
slow CI runners. The `collectMessages` promise resolves only when the exact count
arrives, so the test has no race between assertion and delivery.

### 2.3 Mock-Ollama server

```js
async function startMockOllama(chunks) {
  let callCount = 0
  const s = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/chat') {
      callCount++
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      let i = 0
      const iv = setInterval(() => {
        if (i < chunks.length) {
          res.write(JSON.stringify({ message: { content: chunks[i++] } }) + '\n')
        } else {
          res.write(JSON.stringify({ done: true }) + '\n')
          res.end()
          clearInterval(iv)
        }
      }, 10)
    }
  })
  await new Promise(r => s.listen(0, r))
  return { server: s, port: s.address().port, getCallCount: () => callCount }
}
```

Design rationale:

- **Deterministic, offline.** No real Ollama process is needed. CI runners have
  no GPU and cannot run Ollama. The mock returns a fixed array of content chunks,
  giving tests full control over what `fullText` the server assembles.
- **`callCount` counter.** The single-DM-trigger guarantee (R1, Phase 3) is
  asserted as `expect(mockOllama.getCallCount()).toBe(1)`. This is the only
  way to definitively prove "exactly one Ollama call fired."
- **Configurable chunks with embedded party blocks.** Tests that exercise the
  structured-block parse path supply a `chunks` array whose final element is a
  JSON `party` block fence:
  ```js
  const combatChunks = [
    'The goblin strikes!\n\n',
    '```party\n[{"name":"Theron","role":"Paladin","hpPct":70,"isActive":true}]\n```',
  ]
  ```
  This lets Phase 5 tests (combat turn enforcement) verify the server correctly
  transitions phase to `combat` after `dm:done` — without requiring the real
  LLM to produce the block.
- **`OLLAMA_HOST` env var.** The sync server reads `process.env.OLLAMA_HOST` to
  know where to POST. Setting it to `127.0.0.1:<mockPort>` before
  `createSyncServer()` is called means no code change is needed in the server
  to support test injection.

### 2.4 Single-DM-trigger assertion

The critical guarantee from architecture §3.3 is structural, not behavioral. The
automated assertion that makes it machine-verifiable is:

```js
// Fire two concurrent actions from two clients
clientA.ws.send(JSON.stringify({ type: 'action', ... }))
clientB.ws.send(JSON.stringify({ type: 'action', ... }))

// Wait long enough for all I/O to settle (both actions + dm:done)
await new Promise(r => setTimeout(r, 500))

// Only one Ollama call must have occurred
expect(ctx.mockOllama.getCallCount()).toBe(1)
```

The 500 ms wait is unavoidable here because we are asserting a negative (no
second call). For all other tests `collectMessages(ws, n)` is used instead of
`setTimeout` to avoid flakiness. The 500 ms floor is conservative on a loopback
socket; a well-implemented server will complete both actions in < 50 ms.

### 2.5 `NOT_YOUR_TURN` and `DM_BUSY` rejection assertions

Both error types are returned as WebSocket messages of type `error`:

```json
{ "type": "error", "payload": { "code": "NOT_YOUR_TURN", "message": "..." } }
```

The test pattern is:

```js
// Collect messages from the non-active sender (may include session:state + error)
const msgs = await collectMessages(clientB.ws, 5)
const error = msgs.find(m => m.type === 'error' && m.payload?.code === 'NOT_YOUR_TURN')
expect(error).toBeDefined()
// Also assert the active player's client did NOT receive an error
const activeErrors = await /* ... */
expect(activeErrors.filter(m => m.type === 'error')).toHaveLength(0)
```

---

## 3. Coverage Mapped to the 8 Build Phases

### Phase 0 — Schema and payload extension

**Gate condition:** All Phase 0 tests pass. All 274 existing tests remain green.

**Tests that gate Phase 0:**

| Test | File | Description |
|---|---|---|
| `SCHEMA_VERSION equals 2` | `session.multiplayer.test.js` | Constant value assertion |
| `deserializeSession v1→v2: fills phase/roomCode/turnSequence defaults` | same | Backward-compat branch |
| `deserializeSession v1→v2: preserves all v1 fields` | same | No data loss on upgrade |
| `deserializeSession v1→v2: does not mutate input object` | same | Purity |
| `deserializeSession v2 native round-trip` | same | Normal path |
| `deserializeSession: invalid phase clamped to free-roam` | same | Defensive |
| `toMarkdown writes phase and roomCode as prose metadata lines` | same | .md readability |
| `fromMarkdown(toMarkdown(v2)) restores v2 fields losslessly` | same | R3 contract |
| `v1 .md file loads with v2 defaults (no phase/roomCode in block)` | same | R2 + R3 regression |
| `connections and dmClientId NOT written to .md block` | same | Ephemeral fields excluded |
| `makeRoomCode derives stable dnd- prefix code` | same | Room code spec |
| `applyPartyUpdate is a named export from session.js` | same | Move verification |
| `applyPartyUpdate: preserves existing id on name-match` | same | Regression vs Chat.jsx inline |
| `applyPartyUpdate: assigns new UUID for unmatched name` | same | Regression |
| `applyPartyUpdate: clamps hpPct to [0,100]` | same | Regression |
| `applyPartyUpdate: defaults missing fields defensively` | same | Regression |
| Entire existing `session.test.js` suite (274 tests) | existing | No regression |

### Phase 1 — WebSocket transport spike

**Gate condition:** Phase 1 tests pass. Phase 0 tests still green.

**Tests that gate Phase 1:**

| Test | File | Description |
|---|---|---|
| HTTP upgrades to WebSocket at /ws | `sync-server.multiplayer.test.mjs` | Endpoint exists |
| `join` → `session:state` response contains session snapshot | same | Join flow |
| `session:state` payload includes `roomCode` | same | v2 field in wire format |
| `ping` → `pong` keepalive | same | Keepalive protocol |
| Invalid `roomCode` → `error` message | same | Input validation |
| Empty `displayName` → `error` message | same | Input validation |
| `useWebSocket` connects to `/ws` on mount | `useWebSocket.test.js` | Hook behaviour |
| `useWebSocket` sends `join` on open with correct fields | same | Join handshake |
| `useWebSocket` exposes reactive `readyState` | same | State exposure |
| `useWebSocket` `send()` helper wraps JSON | same | API surface |
| `useWebSocket` reconnects after `close` event | same | Backoff trigger |
| `useWebSocket` signals `shouldPoll=true` when socket closed | same | Poll resume |
| `useWebSocket` signals `shouldPoll=false` when socket open | same | Poll suspend |

### Phase 2 — Server-authoritative state and broadcast

**Gate condition:** Phase 2 tests pass. Phase 0–1 tests still green.

**Tests that gate Phase 2:**

| Test | File | Description |
|---|---|---|
| Client B receives `session:update` when client A sends action | `sync-server.multiplayer.test.mjs` | Broadcast |
| `phase` field present in every `session:update` | same | Phase sync |
| Reconnect with stale `lastTurnSequence` → full `session:state` | same | Resync |
| `useWebSocket` routes `session:state` to `onSessionState` callback | `useWebSocket.test.js` | Event routing |
| `useWebSocket` silently ignores malformed JSON messages | same | Defensive |
| M7 gate applies on `session:update` path | `useWebSocket.test.js` | M7 preservation |
| `9999` sentinel still blocks resurrection via `session:update` | same | Resurrection guard |

### Phase 3 — Single DM trigger (server-side Ollama proxy)

**Gate condition:** Phase 3 tests pass. All prior phase tests still green.

**Tests that gate Phase 3:**

| Test | File | Description |
|---|---|---|
| Exactly one mock-Ollama POST for one action | `sync-server.multiplayer.test.mjs` | R1 guarantee |
| `dm:delta` events broadcast with `delta` and `turnSequence` | same | Stream fan-out |
| `dm:done` broadcast with `fullText` and `turnSequence` advanced by 1 | same | Turn increment |
| `.md` file written after `dm:done` | same | R3 persistence |
| Concurrent actions: one succeeds, other gets `DM_BUSY` | same | Queue serialization |
| `DM_BUSY` sent to second sender while `phase === awaiting-dm` | same | Phase gate |
| `phaseReducer: FREE_ROAM + action → AWAITING_DM` | `turnStateMachine.test.js` | Reducer |
| `phaseReducer: AWAITING_DM + dm:done + all isActive:false → FREE_ROAM` | same | Reducer |
| `phaseReducer: AWAITING_DM + dm:done + one isActive:true → COMBAT` | same | Reducer |

### Phase 4 — Free-roam multi-client

**Gate condition:** Phase 4 is primarily a UI + join-flow phase. Automated coverage
focuses on the join handshake (already covered in Phase 1/2 tests) and the
`presence:update` broadcast on new client join.

| Test | File | Description |
|---|---|---|
| Second client joining same room triggers `presence:update` to first client | `sync-server.multiplayer.test.mjs` | Presence on join |
| `presence:update` payload lists both display names | same | Presence data |
| Messages from client A appear in client B's `session:update.messages` | same | Free-roam play |

### Phase 5 — Combat turn enforcement

**Gate condition:** Phase 5 tests pass. All prior phase tests still green.

**Tests that gate Phase 5:**

| Test | File | Description |
|---|---|---|
| Active player action accepted in combat phase | `sync-server.multiplayer.test.mjs` | Turn acceptance |
| Non-active player action rejected with `NOT_YOUR_TURN` | same | Turn rejection |
| Any player rejected with `DM_BUSY` in `awaiting-dm` | same | Phase gate |
| `dm:done` with all `isActive:false` → free-roam restored | same | Phase exit |
| `turnSequence` advances by exactly 1 per completed DM turn | same | Monotonic counter |
| Two clients act within 10 ms in free-roam: one `DM_BUSY` (F7) | same | Chaos scenario |
| `phaseReducer: COMBAT + active player → AWAITING_DM` | `turnStateMachine.test.js` | Reducer |
| `phaseReducer: COMBAT + non-active player → NOT_YOUR_TURN` | same | Reducer |
| `phaseReducer: COMBAT + dm:done + new active member → COMBAT` | same | Turn-pass |
| Active player case-insensitive name match | `turnStateMachine.test.js` | Name normalization |

### Phase 6 — Presence, disconnect, rejoin

**Gate condition:** Phase 6 tests pass. All prior phase tests still green.

**Tests that gate Phase 6:**

| Test | File | Description |
|---|---|---|
| Client disconnect → `presence:update` broadcast to remaining clients | `sync-server.multiplayer.test.mjs` | Disconnect signal |
| Rejoin with same `displayName` → correct `session:state` received | same | Rejoin |
| DM stream completes after triggering client disconnects | same | F3 scenario |
| Server does not crash when active combat player disconnects | same | F3 stability |
| Orphaned room GC after 30-min inactivity (fake timers) | same | Memory cleanup |
| `useWebSocket` sends `join` with correct `lastTurnSequence` on reconnect | `useWebSocket.test.js` | Reconnect message |

### Phase 7 — Migration cutover and backward-compat verification

**Gate condition:** All 274 original tests still pass. New multiplayer tests all pass.
v1 `.md` files load correctly in the v2 runtime.

**Tests that gate Phase 7:**

| Test | File | Description |
|---|---|---|
| Entire original Vitest suite (274 tests) | existing | No regression |
| HTTP PUT v2 payload → GET round-trip preserves v2 fields | `sync-server.multiplayer.test.mjs` | HTTP+v2 compat |
| HTTP PUT v1-shaped payload → GET returns v2 defaults | same | HTTP+v1 compat |
| 409 LWW guard applies to v2 payload (M5 regression) | same | LWW preserved |
| Single-player one-client session indistinguishable from today | same | SP survival |
| M7 gate still blocks stale adoption (poll path, existing test) | `useSessionPersistence.test.jsx` | M7 preserved |
| v1 `.md` file `fromMarkdown` returns v2 defaults (Phase 0 test) | `session.multiplayer.test.js` | R2+R3 regression |
| v2 `.md` file loads in single-player (Phase 0 test) | same | R3 single-player |

---

## 4. CI Integration

### 4.1 How new suites slot into `npm test -- --run`

The existing command is `vitest run` (alias `npm test -- --run`). Vitest discovers
all files matching `**/*.test.{js,mjs,jsx,ts,tsx}`. No configuration change is
needed: the four skeleton files are already discovered and produce 83 skipped
tests (confirmed: `Tests 274 passed | 83 skipped`). As `.skip` prefixes are
removed during V1 implementation, the tests automatically become active.

The only configuration addition needed is to ensure the node-env skeleton file
`server/sync-server.multiplayer.test.mjs` uses the `// @vitest-environment node`
pragma (already present), matching the pattern of the existing
`server/sync-server.test.mjs`.

### 4.2 jsdom vs node-env split

| File | Vitest environment | Rationale |
|---|---|---|
| `src/lib/session.test.js` | jsdom (default) | Pure module, `window` mock needed for `getLanHost` |
| `src/lib/session.multiplayer.test.js` | jsdom (default) | Same module; `window` consistency |
| `src/lib/turnStateMachine.test.js` | jsdom (default) | Pure reducer; no Node-only APIs |
| `src/hooks/useWebSocket.test.js` | jsdom (default) | React hook + `vi.stubGlobal('WebSocket', ...)` |
| `src/hooks/useSessionPersistence.test.jsx` | jsdom (default) | React hook; existing environment |
| `server/sync-server.test.mjs` | node-env (pragma) | Real HTTP server, `fs/promises`, no DOM |
| `server/sync-server.multiplayer.test.mjs` | node-env (pragma) | Real WebSocket server + mock Ollama HTTP |

The vite.config.js `test.environment: 'jsdom'` default is correct for client
code. Node-env tests override it per-file with `// @vitest-environment node`.
No global environment change is needed.

### 4.3 Keeping the run deterministic and offline

Four constraints ensure `npm test -- --run` never makes external network calls:

1. **Mock Ollama.** Every node-env integration test that exercises the DM trigger
   uses `startMockOllama()` and sets `process.env.OLLAMA_HOST` to the mock's
   local port before `createSyncServer()` is called. No test ever points at a
   real Ollama process or `11434`.

2. **Mocked `fetch` in jsdom tests.** Unit tests for `session.js` sync API calls
   use `vi.stubGlobal('fetch', vi.fn())` (existing pattern in `session.test.js`).
   Tests for `useWebSocket` use `vi.stubGlobal('WebSocket', MockWebSocket)`.
   No real TCP connection is opened.

3. **Ephemeral temp directories.** `mkdtemp` writes to the OS temp folder, not
   to `server/sessions/` (which is gitignored but could affect developer
   state). Each test suite's sessions dir is destroyed in `afterAll`.

4. **No timing-dependent tests (except fake-timer tests).** `collectMessages(ws, n)`
   resolves on count, not on time. The only `setTimeout`-based wait is the
   500 ms concurrent-action race window test (§2.4); this is an explicit
   and documented exception. All backoff tests use `vi.useFakeTimers()`.

### 4.4 Execution time budget

The existing suite completes in ~2.3 s. The new tests add:

- Unit tier (jsdom): ~0.5 s — pure function assertions, no I/O
- Integration tier (node-env): ~5–8 s — includes WebSocket setup/teardown per
  describe block, mock Ollama I/O, and the 500 ms race window test

Target: full suite (274 + all multiplayer) finishes in < 15 s on a developer
machine. The 30-minute CI budget is not approached.

### 4.5 `ws` package dependency

The integration tests import `WebSocket` from the `ws` package (already a
dependency of `sync-server.mjs` after Phase 1 lands). No additional test-only
dependency is needed. In jsdom tests, `ws` is not imported; the `MockWebSocket`
class is a plain `EventTarget` subclass.

---

## 5. Schema and Contract Regression Tests

### 5.1 v2 payload → `.md` → v2 payload (toMarkdown/fromMarkdown contract)

The core R3 regression test is the `fromMarkdown(toMarkdown(v2)) === v2` round-trip
in `session.multiplayer.test.js`. It covers all v2 fields:

```
{ sessionId, schemaVersion:2, savedAt, campaign, messages, sessionLog, party,
  roomCode, phase, turnSequence }
```

The test asserts structural equality, not string equality, so formatting changes
to the prose sections do not break it.

### 5.2 v1 `.md` file loads with v2 defaults (R2 backward-compat)

The test constructs a v1 `.md` file using the v1 `toMarkdown` output (via the
existing `session.test.js` fixtures, which produce schemaVersion: 1 payloads).
Feeding that file into the v2 `fromMarkdown` must produce:

```js
{
  schemaVersion: 2,
  phase: 'free-roam',
  roomCode: null,
  turnSequence: 0,
  // ... all other v1 fields preserved
}
```

This is the contract that allows existing `.md` saves from pre-multiplayer
sessions to be loaded in the v2 runtime without user action.

### 5.3 Ephemeral fields excluded from `.md` (connections, dmClientId)

A test constructs a v2 payload that includes `connections` and `dmClientId` (as
if the server had assembled it from in-memory state), passes it to `toMarkdown`,
and asserts neither field appears anywhere in the Markdown string. This prevents
a server-side bug where ephemeral state leaks into the persisted file and
confuses a future reader or `fromMarkdown` call.

### 5.4 HTTP endpoint contract with v2 schema (server-level)

In `sync-server.multiplayer.test.mjs` Phase 7 block:

- PUT a v2 payload (with `phase`, `roomCode`, `turnSequence`). GET back.
  Assert the fields survive the `toMarkdown` → `fromMarkdown` round-trip on disk.
- PUT a v1-shaped payload (no `phase`, no `roomCode`). GET back.
  Assert `phase === 'free-roam'`, `roomCode === null`, `turnSequence === 0`.

These tests are the machine-checkable version of the PRD §5.6 success criterion
"`.md` load/save round-trip identical."

### 5.5 M7 gate on both sync paths

The M7 strictly-newer gate is exercised on two paths in v2:

| Path | Test file | Test description |
|---|---|---|
| 30s poll (`pollSyncSession`) | `useSessionPersistence.test.jsx` | Existing tests — no change needed |
| WebSocket `session:update` | `useWebSocket.test.js` | New: stale `savedAt` in `session:update` → not adopted |

Both use the same assertion form: `expect(setMessages).not.toHaveBeenCalled()`
when the incoming `savedAt` is not strictly greater than the local stamp.

The `9999-12-31T23:59:59.999Z` sentinel test is mirrored for the WebSocket path
in `useWebSocket.test.js` (describe block "M7 gate on session:update path") to
prove the resurrection guard is intact on the new event pathway.

---

## 6. Skeleton Test Files

### 6.1 Files created

Four skeleton files were created alongside existing test files:

| File | Tests | Phase gates | Environment |
|---|---|---|---|
| `src/lib/session.multiplayer.test.js` | 33 | Phase 0, Phase 7 | jsdom |
| `server/sync-server.multiplayer.test.mjs` | 30 | Phases 1–3, 5–7 | node-env |
| `src/hooks/useWebSocket.test.js` | 15 | Phases 1–2 | jsdom |
| `src/lib/turnStateMachine.test.js` | 13 | Phases 3–5 | jsdom |

All test bodies are commented out. Every `describe` block carries `.skip`.
The files are valid JavaScript; no parse errors, no import side-effects.

### 6.2 Suite verification after skeleton addition

Running `npm test -- --run` after adding the skeletons:

```
Test Files  12 passed | 4 skipped (16)
     Tests  274 passed | 83 skipped (357)
```

The 274 previously-passing tests are unaffected. Zero failures.

### 6.3 How to activate a skeleton

When Phase N implementation lands:

1. Open the skeleton file for that phase.
2. Remove the `.skip` from the relevant `describe.skip(...)` block.
3. Uncomment the import statements at the top of the file.
4. Uncomment the assertion bodies inside each `it(...)`.
5. Run `npm test -- --run` and fix any failures before committing.

Each skeleton file's describe blocks correspond 1:1 to the architecture phases
in §7 of `MULTIPLAYER-ARCHITECTURE.md`, so the mapping from "phase is done" to
"these tests must pass" is unambiguous.

---

## 7. Unit vs Integration Split Summary

| Tier | Count (planned) | Speed | Network | Files |
|---|---|---|---|---|
| Unit (jsdom) | ~61 | < 1 s | None (stubbed) | `session.multiplayer.test.js`, `useWebSocket.test.js`, `turnStateMachine.test.js` |
| Integration (node-env) | ~30 | 5–8 s | Loopback only (mock Ollama, real WebSocket on 127.0.0.1) | `sync-server.multiplayer.test.mjs` |
| Existing (274 tests) | 274 | ~2.3 s | None | All 12 existing files |
| **Total (V2 target)** | **~365** | **< 15 s** | **Offline** | 16 files |

The boundary rule is: **if the test requires a real TCP socket or real file I/O,
it belongs in node-env.** Everything else — pure functions, React hooks, protocol
parsing, state-machine transitions — belongs in jsdom where it runs faster and
with no OS-level teardown cost.

---

## References

- `MULTIPLAYER-ARCHITECTURE.md` — §1.2 (v2 schema fields), §2 (WebSocket wire
  format + message types), §3 (single DM trigger), §4 (phase state machine),
  §5 (room/identity), §6 (migration), §7 (8-phase plan), §8 (failure modes)
- `MULTIPLAYER-PRD.md` — §5 success criteria (the behavioral assertions these
  tests make machine-checkable)
- `MULTIPLAYER-ORCHESTRATION.md` — §3.2 (test-automator scope and deliverables)
- `src/lib/session.test.js` — existing unit test patterns for `session.js`
- `server/sync-server.test.mjs` — existing node-env integration test patterns
  (ephemeral port, temp dir, `withLock` concurrency test)
- `src/hooks/useSessionPersistence.test.jsx` — existing hook test patterns
  (mocked sync API, M7 gate tests, sentinel resurrection guard)
- `vite.config.js` — `test.environment: 'jsdom'` default; node-env per-file override
