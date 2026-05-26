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

## Post-revision refresh (G2)

> **Owner:** test-automator (G2 — post-review pass)
> **Inputs:** MULTIPLAYER-ARCHITECTURE.md "Revision log (post-review)" (MC-1…MC-9, A…J);
> D3 architecture review + D3b security review findings.
> **Scope:** Amends and extends existing coverage without deleting or renumbering prior sections.
> All new tests are skipped skeletons (same convention as §6). They slot into the same four
> skeleton files and run under `npm test -- --run` with no configuration change.

The following subsections address each item assigned to `test-automator` in the revision log.
Items owned by `websocket-engineer` / `backend-developer` (MC-5, MC-8, MC-9 implementation)
are cross-referenced here but not expanded — those agents own their own test surfaces.

---

### G2.1 MC-1 — `createSyncServer` shape contract (pinning §2.1 harness assumption)

**Architecture ref:** §2.1 (MC-1 refactor).

**What changed in the architecture:** `createSyncServer` is now required to return an
`http.Server` directly (Option A) rather than the Express `app`. The §2.1 test harness
already assumes this shape:

```js
const s = createSyncServer({ sessionsDir: dir }).listen(0, () => resolve(s))
const port = s.address().port       // valid on http.Server, not on Express app
// wsBase derived on the same port — requires a single server handle
```

If `createSyncServer` returned `{ app, server }` (Option B) or the bare `app` (old
behavior), the harness call chain would fail silently at `.listen(0)` (calling
`app.listen` creates an internal `http.Server` whose handle is discarded) and
`httpServer.address()` would return the wrong value.

**New contract test** — add to `server/sync-server.multiplayer.test.mjs`, Phase 1 block,
environment: node-env:

```js
// TODO: remove .skip when Phase 1 lands
describe.skip('MC-1 — createSyncServer returns http.Server (Option A shape)', () => {
  it('createSyncServer() returns an object with a .listen() method (http.Server duck-type)', () => {
    // const result = createSyncServer({ sessionsDir: '/tmp/test-mc1' })
    // expect(typeof result.listen).toBe('function')
    // // Confirm it is NOT the Express app shape (which has .use, .get, .post but no .address pre-listen)
    // expect(typeof result.address).toBe('function')
  })

  it('.listen(0) then .address().port returns a non-zero integer (ephemeral port)', async () => {
    // const dir = await mkdtemp(path.join(tmpdir(), 'mc1-'))
    // const server = createSyncServer({ sessionsDir: dir })
    // await new Promise(r => server.listen(0, r))
    // const port = server.address().port
    // expect(typeof port).toBe('number')
    // expect(port).toBeGreaterThan(0)
    // server.close()
    // await rm(dir, { recursive: true, force: true })
  })

  it('a wsBase derived from .address().port connects to the same server that serves HTTP', async () => {
    // This is the §2.1 harness round-trip: confirm HTTP and WS share a port.
    // const dir = await mkdtemp(path.join(tmpdir(), 'mc1-ws-'))
    // const server = createSyncServer({ sessionsDir: dir })
    // await new Promise(r => server.listen(0, r))
    // const port = server.address().port
    // const res = await fetch(`http://127.0.0.1:${port}/sessions`)
    // expect(res.status).toBe(200)   // HTTP endpoint reachable on same port
    // server.close()
    // await rm(dir, { recursive: true, force: true })
  })
})
```

**Cross-link:** The Phase 1 describe block in `sync-server.multiplayer.test.mjs` already
calls `createSyncServer({ sessionsDir: dir }).listen(0, ...)`. This new sub-describe
makes the shape assumption explicit and machine-checkable before any WebSocket tests run,
so a regression in the return type produces an immediate, named failure rather than a
confusing downstream error.

---

### G2.2 MC-3 — v2 write-path round-trip (`serializeSession` carries v2 fields)

**Architecture ref:** §1.2 (MC-3 `serializeSession` write-path extension).

**What changed in the architecture:** Before this fix, `serializeSession` hard-dropped
everything outside `{campaign, messages, sessionLog, party}`. A HTTP PUT from the sync
server (which rebuilds via `serializeSession`) would silently strip `phase`, `roomCode`,
and `turnSequence` — write-path/read-path asymmetry. The revised `serializeSession`
now carries all three v2 fields with phase-sanitize applied.

**Two test surfaces:**

**Surface A — unit test directly on `serializeSession`** (add to
`src/lib/session.multiplayer.test.js`, jsdom, Phase 0 block):

```js
// TODO: remove .skip when Phase 0 lands
describe.skip('MC-3 — serializeSession carries v2 fields (write-path extension)', () => {
  it('serializeSession output includes roomCode, phase, and turnSequence', () => {
    // const state = {
    //   campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //   roomCode: 'dnd-a1b2c3d4', phase: 'combat', turnSequence: 5,
    // }
    // const result = serializeSession(state, '2026-05-25T12:00:00.000Z')
    // expect(result.roomCode).toBe('dnd-a1b2c3d4')
    // expect(result.phase).toBe('combat')
    // expect(result.turnSequence).toBe(5)
    // expect(result.schemaVersion).toBe(2)
  })

  it('serializeSession → deserializeSession round-trip preserves v2 fields', () => {
    // const state = {
    //   campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //   roomCode: 'dnd-a1b2c3d4', phase: 'combat', turnSequence: 7,
    // }
    // const serialized = serializeSession(state, '2026-05-25T12:00:00.000Z')
    // const back = deserializeSession(JSON.stringify(serialized))
    // expect(back.roomCode).toBe('dnd-a1b2c3d4')
    // expect(back.phase).toBe('combat')
    // expect(back.turnSequence).toBe(7)
  })

  it('serializeSession does not strip v2 fields when called by the HTTP PUT path', () => {
    // Regression guard: prior to MC-3, PUT from the server ran state through
    // serializeSession and silently dropped roomCode/phase/turnSequence.
    // The write path must carry them so GET round-trips faithfully.
    // const full = serializeSession(
    //   { campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //     roomCode: 'dnd-b2c3d4e5', phase: 'free-roam', turnSequence: 12 },
    //   new Date().toISOString()
    // )
    // expect(Object.keys(full)).toEqual(
    //   expect.arrayContaining(['roomCode', 'phase', 'turnSequence'])
    // )
  })
})
```

**Surface B — HTTP PUT → GET round-trip at the server level** (add to
`server/sync-server.multiplayer.test.mjs`, Phase 7 block). The Phase 7 stub
`'PUT a v2 payload → 200; GET returns it with v2 fields intact'` already covers
this conceptually. This G2 item makes that assertion concrete and cross-links to
the `serializeSession` unit test, so the coverage chain is explicit:

- `serializeSession` carries the fields (unit, §5.4 / G2.2A)
- HTTP PUT uses `serializeSession` → GET restores via `toMarkdown`/`fromMarkdown` (integration, §5.4)

No new integration test is added — the Phase 7 stub is the correct location. The
G2 addition is the unit-level `serializeSession` test above and this cross-link.

---

### G2.3 MC-4 — Phase-sanitize on both write and load paths

**Architecture ref:** §1.2 (MC-4 phase-sanitize rule), §4.1.

**What changed in the architecture:** `awaiting-dm` and `resolving` are transient
in-memory phases. They must never appear in a serialized payload or `.md` file. The
phase-sanitize rule (`const safePhase = ['free-roam', 'combat'].includes(phase) ? phase : 'free-roam'`)
applies on every `serializeSession` call and on every `deserializeSession` / `fromMarkdown`
load. This closes chaos experiment EX-9 (`.md` saved mid-stream inheriting `awaiting-dm`).

**New unit tests** — add to `src/lib/session.multiplayer.test.js`, Phase 0 block, jsdom:

```js
// TODO: remove .skip when Phase 0 lands
describe.skip('MC-4 — phase-sanitize on serialize and load paths', () => {
  // --- serialize path ---
  it('serializeSession coerces "awaiting-dm" to "free-roam" on write', () => {
    // const state = {
    //   campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //   phase: 'awaiting-dm', roomCode: 'dnd-x', turnSequence: 3,
    // }
    // const result = serializeSession(state, new Date().toISOString())
    // expect(result.phase).toBe('free-roam')
  })

  it('serializeSession coerces "resolving" to "free-roam" on write', () => {
    // const state = {
    //   campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //   phase: 'resolving', roomCode: 'dnd-x', turnSequence: 3,
    // }
    // const result = serializeSession(state, new Date().toISOString())
    // expect(result.phase).toBe('free-roam')
  })

  it('serializeSession preserves "free-roam" and "combat" (resting phases) unchanged', () => {
    // for (const phase of ['free-roam', 'combat']) {
    //   const result = serializeSession(
    //     { campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [], phase },
    //     new Date().toISOString()
    //   )
    //   expect(result.phase).toBe(phase)
    // }
  })

  // --- deserialize / load path ---
  it('deserializeSession coerces "awaiting-dm" to "free-roam" on load', () => {
    // const raw = JSON.stringify({
    //   schemaVersion: 2, sessionId: V2_SESSION_ID, savedAt: '2026-05-25T12:00:00.000Z',
    //   campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //   phase: 'awaiting-dm', roomCode: 'dnd-x', turnSequence: 2,
    // })
    // const result = deserializeSession(raw)
    // expect(result.phase).toBe('free-roam')
  })

  it('deserializeSession coerces "resolving" to "free-roam" on load', () => {
    // const raw = JSON.stringify({
    //   schemaVersion: 2, sessionId: V2_SESSION_ID, savedAt: '2026-05-25T12:00:00.000Z',
    //   campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //   phase: 'resolving', roomCode: 'dnd-x', turnSequence: 2,
    // })
    // const result = deserializeSession(raw)
    // expect(result.phase).toBe('free-roam')
  })

  // --- .md load path ---
  it('fromMarkdown coerces "awaiting-dm" to "free-roam" (EX-9 closure)', () => {
    // Simulate a .md file that was saved mid-stream with a transient phase.
    // const p = serializeSession(
    //   { campaign: V2_CAMPAIGN, messages: [], sessionLog: [], party: [],
    //     phase: 'awaiting-dm', roomCode: 'dnd-x', turnSequence: 1 },
    //   new Date().toISOString()
    // )
    // But serializeSession already coerces, so manually craft a .md with the raw transient string:
    // const md = 'phase: awaiting-dm\n\n```session\n' +
    //   JSON.stringify({ ...p, phase: 'awaiting-dm' }) + '\n```'
    // const result = fromMarkdown(md)
    // expect(result.phase).toBe('free-roam')
  })
})
```

**CI environment:** jsdom. No I/O. These are pure-function assertions that run in
under 1 ms each.

---

### G2.4 MC-6 — `turnSequence` gate for live adopt (same-millisecond `savedAt` tie)

**Architecture ref:** §2.2 (MC-6 dual-authority adopt gate).

**What changed in the architecture:** The existing M7 adopt gate uses strictly-greater
`savedAt` for the poll path. In multiplayer, consecutive DM turns can occur within the
same millisecond, making the strict-greater check reject the second update. The revised
adopt gate for the **WebSocket path** uses `turnSequence > localTurnSequence` as the
primary check, with `savedAt > local` as a fallback tie-break. The poll path is unchanged.

This supersedes the §5.5 description of the M7 gate on the WebSocket path. The §5.5
table is retained but the assertion form changes — add the following note to the existing
§5.5 text and add the concrete tests below.

**New tests** — add to `src/hooks/useWebSocket.test.js`, jsdom (extend the existing
`'M7 gate on session:update path'` describe block):

```js
// TODO: remove .skip when Phase 2 lands
describe.skip('MC-6 — turnSequence gate on live adopt (dual-authority)', () => {
  it('session:update with higher turnSequence IS adopted even with same-millisecond savedAt', async () => {
    // const onSessionUpdate = vi.fn()
    // // Set up hook with localTurnSequence = 5, lastSavedAt = T
    // // Receive session:update with turnSequence = 6, savedAt = T (same millisecond)
    // // Hook must adopt because turnSequence advanced.
    // // const { result } = renderHook(() =>
    // //   useWebSocket({ ..., onSessionUpdate, initialTurnSequence: 5, initialSavedAt: 'T' })
    // // )
    // // await act(async () => {})
    // // const ws = MockWebSocket.instances[0]
    // // act(() => ws.receive({
    // //   type: 'session:update',
    // //   payload: { turnSequence: 6, savedAt: 'T', messages: [], party: [], phase: 'free-roam' }
    // // }))
    // // expect(onSessionUpdate).toHaveBeenCalledTimes(1)
  })

  it('session:update with lower turnSequence and lower savedAt is rejected', async () => {
    // // localTurnSequence = 5, lastSavedAt = T2
    // // Receive: turnSequence = 3, savedAt = T1 (both lower) → must NOT adopt
    // // expect(onSessionUpdate).not.toHaveBeenCalled()
  })

  it('session:update with lower turnSequence but higher savedAt IS adopted (savedAt fallback)', async () => {
    // // Edge case: turnSequence can go backwards if server resets (restart scenario).
    // // savedAt = T2 > localSavedAt = T1 → adopt despite lower sequence.
    // // expect(onSessionUpdate).toHaveBeenCalledTimes(1)
  })

  it('a gap-triggered resync (session:state with turnSequence = local + n) is accepted', async () => {
    // // localTurnSequence = 3; server sends session:state with turnSequence = 7 (gap of 4).
    // // This is the F4 resync scenario: the client detects a gap and requests state;
    // // the gate must accept it because 7 > 3.
    // // const onSessionState = vi.fn()
    // // act(() => ws.receive({
    // //   type: 'session:state',
    // //   payload: { turnSequence: 7, savedAt: '2026-05-25T12:00:00.001Z', ... }
    // // }))
    // // expect(onSessionState).toHaveBeenCalledTimes(1)
  })

  it('poll-path adopt still uses strict-greater savedAt (M7 unaffected)', async () => {
    // // This is a regression guard: the dual-authority gate must NOT apply to the
    // // poll path. The existing useSessionPersistence.test.jsx M7 tests cover this;
    // // this comment cross-links them for traceability.
    // // No new assertion here — see useSessionPersistence.test.jsx 'M7 gate' describe.
  })
})
```

**Cross-link:** Existing §5.5 table row "WebSocket `session:update`" in
`useWebSocket.test.js` is updated: the assertion form shifts from
`payload.savedAt > local` to `turnSequence > local || savedAt > local`. The poll-path
row in `useSessionPersistence.test.jsx` is unchanged.

---

### G2.5 MC-7 — Sentinel reset under server-push (permanent-deaf prevention)

**Architecture ref:** §2.2 (MC-7 `9999` sentinel reset rule).

**What changed in the architecture:** In multiplayer, after `onNewSession` sets
`lastSavedAt.current = '9999-...'`, the client issues no PUT. Without a reset
mechanism, the sentinel makes the client deaf to all server pushes forever. The fix:
when a `session:state` event arrives on (re)join, `onSessionState` resets both
`lastSavedAt.current` and `localTurnSequence.current` unconditionally. Additionally,
`onNewSession` now also sets `localTurnSequence.current = -1` so the next
`session:state` for the new room (sequence ≥ 0) passes the `seqNewer` check.

**New unit/integration tests** — add to `src/hooks/useWebSocket.test.js`, jsdom:

```js
// TODO: remove .skip when Phase 2 lands
describe.skip('MC-7 — sentinel reset under server-push (no permanent deafness)', () => {
  it('after onNewSession sets the 9999 sentinel, a fresh session:state on join clears it', async () => {
    // Sequence:
    //   1. Hook mounts; onNewSession is called → lastSavedAt = '9999-...'
    //   2. Server sends session:state (new room) with savedAt = '2026-05-25T...' and turnSequence = 0
    //   3. Hook must adopt (sentinel is reset; it is NOT a poll-path resurrection)
    // const onSessionState = vi.fn()
    // // Simulate onNewSession effect: hook's lastSavedAt.current = '9999-12-31T23:59:59.999Z'
    // //   and localTurnSequence.current = -1
    // // Then receive session:state with turnSequence = 0, savedAt = '2026-05-25T12:00:00.000Z'
    // // seqNewer check: 0 > -1 → true → adopt
    // // expect(onSessionState).toHaveBeenCalledTimes(1)
  })

  it('localTurnSequence = -1 sentinel means any real server push (sequence >= 0) is accepted', async () => {
    // The -1 sentinel is set by onNewSession alongside the 9999 savedAt sentinel.
    // A session:state with turnSequence = 0 satisfies seqNewer (0 > -1).
    // A session:update with turnSequence = 0 also satisfies it.
    // // expect(onSessionState).toHaveBeenCalledTimes(1)
  })

  it('after session:state on join, subsequent server pushes are adopted normally', async () => {
    // Regression: after the sentinel is cleared, the client must not re-apply the
    // 9999 sentinel on the next server push. Verify three consecutive session:update
    // events with turnSequence 1, 2, 3 are all adopted.
    // const onSessionUpdate = vi.fn()
    // // After join (sentinel cleared), receive turnSequence 1, 2, 3 in sequence.
    // // expect(onSessionUpdate).toHaveBeenCalledTimes(3)
  })

  it('the 9999 sentinel still blocks poll-path resurrection (original M7 behavior preserved)', async () => {
    // After onNewSession:
    //   poll path: savedAt = '9999-...' blocks adoption of any poll response with savedAt < 9999
    //   WS path:   session:state resets the sentinel
    // This test covers the poll-path side; the WS side is covered above.
    // See existing useSessionPersistence.test.jsx 'resurrection guard' test for the full path.
    // No new assertion — cross-link only.
  })
})
```

**Integration complement** — add to `server/sync-server.multiplayer.test.mjs`, Phase 2 block, node-env:

```js
// TODO: remove .skip when Phase 2 lands
describe.skip('MC-7 — server sends session:state on (re)join that resets client sentinel', () => {
  it('session:state on join carries non-9999 savedAt and real turnSequence (server side)', async () => {
    // This confirms the server-side half: the session:state payload the server emits
    // on join has a real savedAt (not '9999-...') and a real turnSequence (>= 0).
    // The client-side sentinel reset is triggered by this payload.
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    // expect(firstMessage.type).toBe('session:state')
    // const { savedAt, turnSequence } = firstMessage.payload
    // expect(savedAt).not.toBe('9999-12-31T23:59:59.999Z')
    // expect(typeof turnSequence).toBe('number')
    // expect(turnSequence).toBeGreaterThanOrEqual(0)
    // ws.close()
  })
})
```

---

### G2.6 MC-2 — Server-side prompt assembly contract seam

**Architecture ref:** §3.6 (MC-2 full prompt assembly pipeline), §2.4 (action envelope
with `pendingCheck`).

**What changed in the architecture:** The server-side DM call is not a thin Ollama
fetch. It must reproduce the full `Chat.jsx#sendMessage` pipeline: `buildSystemPrompt`,
`extractEntities`, `trimContext`, dice-message transform with `pendingCheck` folding,
and the Ollama `options` block. This is a contract seam test — it does not assert
Ollama behavior, only that the assembled request message array has the correct shape.

**New contract test** — add to `server/sync-server.multiplayer.test.mjs`, Phase 3 block,
node-env. The mock-Ollama server is extended to capture the full request body:

```js
// TODO: remove .skip when Phase 3 lands
describe.skip('MC-2 — server-side prompt assembly contract (not Ollama behavior)', () => {
  // Extended mock-Ollama that captures the request body for inspection.
  // async function startCapturingMockOllama(chunks) {
  //   let lastRequestBody = null
  //   const s = http.createServer((req, res) => {
  //     if (req.method === 'POST' && req.url === '/api/chat') {
  //       let body = ''
  //       req.on('data', d => { body += d })
  //       req.on('end', () => {
  //         lastRequestBody = JSON.parse(body)
  //         res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
  //         for (const chunk of chunks) {
  //           res.write(JSON.stringify({ message: { content: chunk } }) + '\n')
  //         }
  //         res.write(JSON.stringify({ done: true }) + '\n')
  //         res.end()
  //       })
  //     }
  //   })
  //   await new Promise(r => s.listen(0, r))
  //   return { server: s, port: s.address().port, getLastBody: () => lastRequestBody }
  // }

  it('the Ollama request contains a system message (buildSystemPrompt output)', async () => {
    // const mock = await startCapturingMockOllama(DEFAULT_CHUNKS)
    // process.env.OLLAMA_HOST = `127.0.0.1:${mock.port}`
    // const dir = await mkdtemp(path.join(tmpdir(), 'mc2-'))
    // const server = createSyncServer({ sessionsDir: dir }).listen(0, ...)
    // const client = await connectClient(wsBase, baseJoin)
    // client.ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'I enter the tavern.', type: 'user', pendingCheck: null }
    // }))
    // await collectMessages(client.ws, 10) // wait for dm:done
    // const body = mock.getLastBody()
    // // The first message must be a system message (buildSystemPrompt output)
    // expect(body.messages[0].role).toBe('system')
    // expect(body.messages[0].content).toMatch(/dungeon master|DM|GM/i)
    // server.close(); mock.server.close()
    // await rm(dir, { recursive: true, force: true })
  })

  it('the Ollama request includes extractEntities output appended to the system message', async () => {
    // // With messages that contain NPC names in bold (e.g. **Warden Strix**),
    // // the assembled system message should include the entity list from extractEntities().
    // // body.messages[0].content should contain something like "Known entities:" or the NPC name.
    // // This validates extractEntities is called and folded in (same as Chat.jsx lines 194–198).
  })

  it('a dice action with pendingCheck folds the skill/dc into the assembled message text', async () => {
    // // Client sends: { type: 'action', payload: { content: '[dice]', type: 'dice',
    // //   pendingCheck: { skill: 'Perception', dc: 15 } } }
    // // The assembled messages must contain a line like: [Dice roll: d20 → N (Perception DC 15)]
    // // body.messages must include this as a user-role message content.
  })

  it('trimContext is applied: the assembled messages array length is bounded', async () => {
    // // Seed the session with more messages than trimContext allows (e.g. 100 messages).
    // // After assembly, body.messages.length must be <= the trimContext ceiling.
    // // This validates trimContext is called with the combined array.
  })

  it('the Ollama options block matches the client values (num_ctx, num_predict, etc.)', async () => {
    // const body = mock.getLastBody()
    // expect(body.options).toMatchObject({
    //   num_ctx: 8192, num_predict: 900,
    //   temperature: 0.8, top_p: 0.9, top_k: 40,
    //   repeat_penalty: 1.15, repeat_last_n: 256,
    // })
  })

  it('getGenre is called with campaign.genre and buildSystemPrompt is from the genre engine', async () => {
    // // For a starwars genre campaign, the system prompt must match the starwars engine output.
    // // Use a session with genre: 'starwars' and verify the system message differs from dnd.
    // // body.messages[0].content should contain 'Game Master' (starwars gmName), not 'Dungeon Master'.
  })
})
```

**Environment:** node-env (real server, capturing mock-Ollama HTTP, real file I/O).
**File:** `server/sync-server.multiplayer.test.mjs` (Phase 3 block).
**What is NOT asserted:** actual LLM response quality, model inference, streaming content.
The mock returns `DEFAULT_CHUNKS`; the test only inspects the *request* shape.

---

### G2.7 Security D — WS upgrade origin allowlist

**Architecture ref:** §2.1 (security item D), "WS upgrade origin allowlist."

**What changed in the architecture:** HTTP `cors({ origin: true })` reflects any origin
for fetch/XHR but is not consulted during a WebSocket upgrade. The server must add an
explicit `server.on('upgrade', ...)` handler that checks `req.headers.origin` against
`ALLOWED_ORIGINS` and destroys the socket with `HTTP/1.1 403 Forbidden` if the origin
is not in the list. An empty `origin` header (direct connection / test harness / non-browser)
is explicitly allowed.

**New integration tests** — add to `server/sync-server.multiplayer.test.mjs`, Phase 1
block, node-env:

```js
// TODO: remove .skip when Phase 1 lands
describe.skip('Security D — WS upgrade origin allowlist', () => {
  it('WS upgrade from an allowed origin (empty origin = direct connection) succeeds', async () => {
    // The standard test-harness `new WebSocket(url)` from node has no `origin` header.
    // An empty/absent origin must be allowed (per §2.1 ALLOWED_ORIGINS rule).
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    // expect(firstMessage.type).toBe('session:state')  // upgrade succeeded
    // ws.close()
  })

  it('WS upgrade from a disallowed non-empty origin is rejected with 403', async () => {
    // // A browser-originated WS request from a foreign origin must be blocked.
    // // Simulate by sending a raw HTTP upgrade request with Origin: http://evil.example.com
    // const net = require('node:net')
    // const socket = net.connect(ctx.port, '127.0.0.1')
    // socket.write(
    //   'GET /ws HTTP/1.1\r\n' +
    //   `Host: 127.0.0.1:${ctx.port}\r\n` +
    //   'Upgrade: websocket\r\n' +
    //   'Connection: Upgrade\r\n' +
    //   'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    //   'Sec-WebSocket-Version: 13\r\n' +
    //   'Origin: http://evil.example.com\r\n\r\n'
    // )
    // const response = await new Promise(resolve => socket.once('data', d => resolve(d.toString())))
    // expect(response).toMatch(/^HTTP\/1\.1 403/)
    // socket.destroy()
  })

  it('HTTP CORS does NOT gate the WS path — HTTP endpoints are accessible from any origin', async () => {
    // // The cors({ origin: true }) middleware allows any fetch/XHR. Confirm /sessions
    // // responds 200 regardless of Origin. This validates the WS allowlist is WS-only.
    // const res = await fetch(`${ctx.base}/sessions`, {
    //   headers: { 'Origin': 'http://evil.example.com' }
    // })
    // expect(res.status).toBe(200)
  })
})
```

**Environment:** node-env. Uses raw TCP socket for the disallowed-origin test because
the `ws` Node.js client does not set an `Origin` header by default (matching what the
test harness does), so the forbidden-origin case must be crafted at the raw HTTP level.

---

### G2.8 Security F — Inbound WS frame validation

**Architecture ref:** §2.4 (security item F), §5.4 input validation summary.

**What changed in the architecture:** Every inbound WS frame must be validated before
processing: JSON parse in try/catch, unknown `type` dropped, `roomCode` checked against
`ID_RE`, `displayName` bounded, `action.content` max 4096 chars, `maxPayload: 65536`
(64 KB), every handler wrapped in try/catch, socket + server `error` handlers present.

**New integration tests** — add to `server/sync-server.multiplayer.test.mjs`, Phase 1
block, node-env:

```js
// TODO: remove .skip when Phase 1 lands
describe.skip('Security F — inbound WS frame validation', () => {
  it('malformed JSON frame is dropped with an error response, server stays alive', async () => {
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    // const errorPromise = new Promise(resolve =>
    //   ws.once('message', d => resolve(JSON.parse(d)))
    // )
    // ws.send('not json {{{')  // raw malformed text
    // const response = await errorPromise
    // expect(response.type).toBe('error')
    // // Server must still be alive — send a valid ping to confirm
    // const pongPromise = new Promise(r => ws.once('message', d => r(JSON.parse(d))))
    // ws.send(JSON.stringify({ type: 'ping', roomCode: ROOM_CODE }))
    // const pong = await pongPromise
    // expect(pong.type).toBe('pong')
    // ws.close()
  })

  it('unknown message type is dropped silently (no error thrown, no crash)', async () => {
    // const { ws, firstMessage } = await connectClient(ctx.wsBase, baseJoin)
    // ws.send(JSON.stringify({ type: 'delete_all_sessions', roomCode: ROOM_CODE }))
    // // Server should NOT crash. Verify it is still alive with a ping.
    // const pongPromise = new Promise(r => ws.once('message', d => r(JSON.parse(d))))
    // ws.send(JSON.stringify({ type: 'ping', roomCode: ROOM_CODE }))
    // const pong = await pongPromise
    // expect(pong.type).toBe('pong')
    // ws.close()
  })

  it('action.content exceeding 4096 chars is trimmed/rejected before reaching Ollama', async () => {
    // const longContent = 'A'.repeat(5000)
    // const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: longContent, type: 'user', pendingCheck: null }
    // }))
    // // Either: the server trims to 4096 and proceeds, or it sends an error.
    // // Either way, Ollama must NOT receive more than 4096 chars in the user message.
    // // (Verified via the capturing mock-Ollama pattern from G2.6)
    // ws.close()
  })

  it('a frame exceeding maxPayload (64 KB) is dropped by ws library before handler runs', async () => {
    // // The ws library enforces maxPayload: 65536. Sending a 70 KB frame should close
    // // the connection (the ws library emits an 'error' and closes the socket).
    // // This test verifies the server does not crash on oversized frames.
    // const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // const oversize = 'X'.repeat(70_000)
    // ws.send(oversize)
    // // The connection will be closed by the library. Wait for the close event.
    // await new Promise(resolve => ws.once('close', resolve))
    // // Server still alive (other connections unaffected).
    // const client2 = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Jordan' })
    // expect(client2.firstMessage.type).toBe('session:state')
    // client2.ws.close()
  })
})
```

**Environment:** node-env. All tests require a real WebSocket server with `maxPayload`
configured.

---

### G2.9 Security G — Rate limit and compute guardrails

**Architecture ref:** §3.6 (security item G), §5.4 input validation summary.

**What changed in the architecture:** The server enforces per-connection rate limiting:
at most 1 in-flight action while waiting for `dm:done`, and a minimum interval between
actions (e.g. 500 ms) to prevent spam queuing. The server-side prompt assembly also
applies `trimContext` and the Ollama `options` block, keeping context bounded.

**New contract tests** — add to `server/sync-server.multiplayer.test.mjs`, Phase 3
block, node-env:

```js
// TODO: remove .skip when Phase 3 lands
describe.skip('Security G — per-connection rate limit and compute guardrails', () => {
  it('sending two action frames in rapid succession results in RATE_LIMITED on the second', async () => {
    // // The client sends two actions before the first dm:done arrives.
    // // The server's per-connection gate must return RATE_LIMITED (or DM_BUSY) for the second.
    // const { ws } = await connectClient(ctx.wsBase, baseJoin)
    // ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'First action.', type: 'user', pendingCheck: null }
    // }))
    // ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Second action before dm:done.', type: 'user', pendingCheck: null }
    // }))
    // const msgs = await collectMessages(ws, 10)
    // const rateError = msgs.find(
    //   m => m.type === 'error' &&
    //     (m.payload?.code === 'RATE_LIMITED' || m.payload?.code === 'DM_BUSY')
    // )
    // expect(rateError).toBeDefined()
    // // Only one Ollama call must have fired
    // expect(ctx.mockOllama.getCallCount()).toBe(1)
    // ws.close()
  })

  it('action flood from one connection does not prevent other connections from acting', async () => {
    // // ClientA floods; clientB should still be able to get a response.
    // // This ensures the per-connection limit does not block the whole room.
    // const clientA = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Alex' })
    // const clientB = await connectClient(ctx.wsBase, { ...baseJoin, displayName: 'Jordan' })
    // // Flood from clientA
    // for (let i = 0; i < 5; i++) {
    //   clientA.ws.send(JSON.stringify({
    //     type: 'action', roomCode: ROOM_CODE,
    //     payload: { content: `Flood ${i}`, type: 'user', pendingCheck: null }
    //   }))
    // }
    // // Wait for dm:done from the first action
    // const msgs = await collectMessages(clientA.ws, 10)
    // const done = msgs.find(m => m.type === 'dm:done')
    // expect(done).toBeDefined()
    // // ClientB can now act without RATE_LIMITED
    // clientA.ws.close(); clientB.ws.close()
  })

  it('the Ollama request carries trimContext-bounded messages (context window guardrail)', async () => {
    // // Seed the session with many messages, then trigger a DM call.
    // // The capturing mock verifies the assembled messages array is trimmed.
    // // (Full assertion in G2.6 MC-2 tests; cross-linked here for G completeness.)
    // // This test entry documents the security motivation: an unbounded context
    // // could exhaust server memory and spike inference time.
  })
})
```

**Environment:** node-env.
**Cross-link to MC-2 (G2.6):** The `trimContext` assertion in the assembled request body
is covered in G2.6 (MC-2 contract seam). Security G's contribution is the rate-limit
enforcement test; the context-window guardrail is the joint responsibility of both.

---

### G2.10 Security H — Model allowlist validation

**Architecture ref:** §3.2, §3.5 (security item H, Ollama URL invariant).

**What changed in the architecture:** `campaign.model` is validated against an allowlist
pattern (`/^[a-zA-Z0-9._:-]{1,64}$/`) before being passed to Ollama. Invalid values
fall back to the default model. The Ollama base URL comes exclusively from
`process.env.OLLAMA_HOST` — never from any client-supplied field.

**New unit tests** — add to `src/lib/session.multiplayer.test.js` or a new
`src/lib/model-validation.test.js` if the allowlist is extracted as a standalone helper.
Preferred location: `session.multiplayer.test.js` (jsdom, Phase 3 block):

```js
// TODO: remove .skip when Phase 3 lands
describe.skip('Security H — campaign.model allowlist validation', () => {
  // If validateModel is exported from session.js or a server utility:
  // import { validateModel } from './session'  OR
  // import { validateModel } from '../../server/sync-server.mjs'

  it('valid model names pass the allowlist', () => {
    // const valid = [
    //   'qwen2.5:14b',
    //   'llama3.2:latest',
    //   'mistral:7b-instruct-v0.3',
    //   'phi3.5',
    //   'openhermes-2.5:latest',
    // ]
    // for (const name of valid) {
    //   expect(validateModel(name)).toBe(name)
    // }
  })

  it('model names with disallowed characters fall back to the default model', () => {
    // const invalid = [
    //   '../../../etc/passwd',
    //   'model; rm -rf /',
    //   'model\x00null',
    //   'a'.repeat(65),          // exceeds 64-char limit
    //   '',                      // empty string
    //   null,
    //   undefined,
    // ]
    // for (const name of invalid) {
    //   expect(validateModel(name)).toBe('qwen2.5:14b')  // or whatever DEFAULT_MODEL is
    // }
  })

  it('model name containing angle brackets or spaces is rejected', () => {
    // expect(validateModel('<script>alert(1)</script>')).toBe('qwen2.5:14b')
    // expect(validateModel('model with spaces')).toBe('qwen2.5:14b')
  })
})
```

**Integration complement** — add to `server/sync-server.multiplayer.test.mjs`, Phase 3
block, node-env:

```js
// TODO: remove .skip when Phase 3 lands
describe.skip('Security H — Ollama URL from OLLAMA_HOST only (server-side enforcement)', () => {
  it('the Ollama request URL is derived from OLLAMA_HOST env var, not from any client field', async () => {
    // // Set OLLAMA_HOST to the mock's address before starting the server.
    // // Verify the server POSTs to the mock, NOT to a client-supplied URL.
    // // (The capturing mock in G2.6 captures the request; if it receives a request,
    // // the URL derivation is from OLLAMA_HOST.)
    // // A malicious client sending { ollamaHost: 'http://attacker.example.com' } in the join
    // // payload must not cause the server to POST anywhere other than OLLAMA_HOST.
    // const { ws } = await connectClient(ctx.wsBase, {
    //   ...baseJoin,
    //   ollamaHost: 'http://attacker.example.com:11434',  // field the server must ignore
    // })
    // ws.send(JSON.stringify({
    //   type: 'action', roomCode: ROOM_CODE,
    //   payload: { content: 'Test.', type: 'user', pendingCheck: null }
    // }))
    // await collectMessages(ws, 5)
    // // Mock received the call → OLLAMA_HOST was used, not the client field
    // expect(ctx.mockOllama.getCallCount()).toBe(1)
    // ws.close()
  })

  it('campaign.model with invalid characters reaches Ollama as the DEFAULT_MODEL, not as the raw input', async () => {
    // // PUT a session with campaign.model = '../../../evil' to the HTTP endpoint.
    // // Connect and trigger a DM action.
    // // The capturing mock inspects body.model: it must NOT be '../../../evil'.
    // // It must be the default model string.
  })
})
```

**Environment:** Security H unit tests run in jsdom (pure function). The Ollama-URL
integration test runs in node-env.

---

### G2.11 CI integration notes (§4 amendments)

The following amendments apply to §4 for the G2 suites. No existing entries are deleted.

**jsdom suites (new tests in G2):**
- G2.2 MC-3 unit (`serializeSession` round-trip) → `src/lib/session.multiplayer.test.js`,
  Phase 0 block, jsdom. Runs in `npm test -- --run` with no configuration change.
- G2.3 MC-4 phase-sanitize unit → same file, same block, jsdom.
- G2.4 MC-6 dual-authority gate → `src/hooks/useWebSocket.test.js`, Phase 2 block, jsdom.
- G2.5 MC-7 sentinel reset → `src/hooks/useWebSocket.test.js`, Phase 2 block, jsdom.
- G2.10 Security H model allowlist → `src/lib/session.multiplayer.test.js` (or a new
  `src/lib/model-validation.test.js`), jsdom, Phase 3 block.

**node-env suites (new tests in G2):**
- G2.1 MC-1 shape contract → `server/sync-server.multiplayer.test.mjs`, Phase 1, node-env.
- G2.6 MC-2 prompt assembly → `server/sync-server.multiplayer.test.mjs`, Phase 3, node-env.
- G2.5 MC-7 server-side complement → `server/sync-server.multiplayer.test.mjs`, Phase 2,
  node-env.
- G2.7 Security D origin allowlist → `server/sync-server.multiplayer.test.mjs`, Phase 1,
  node-env.
- G2.8 Security F inbound validation → `server/sync-server.multiplayer.test.mjs`, Phase 1,
  node-env.
- G2.9 Security G rate limit → `server/sync-server.multiplayer.test.mjs`, Phase 3, node-env.
- G2.10 Security H Ollama-URL enforcement → `server/sync-server.multiplayer.test.mjs`,
  Phase 3, node-env.

**MC-9 loopback smoke** (owned by `websocket-engineer`): the CI upper-bound latency
smoke runs in `npm test -- --run` as a node-env test in
`server/sync-server.multiplayer.test.mjs` Phase 4. The threshold is 2000 ms on loopback
(CI-safe; manual LAN target remains 500 ms per MULTIPLAYER-CHAOS-PLAN.md MANUAL-04).
The test-automator does not own this test body but cross-links it here for completeness.

**Revised test count projection:**

| Tier | Count (planned) | Breakdown |
|---|---|---|
| Unit (jsdom) — existing G1 | ~61 | as before |
| Unit (jsdom) — G2 additions | ~28 | MC-3 (3) + MC-4 (6) + MC-6 (5) + MC-7 (4) + Sec-H unit (3) + MC-1 shape (was node-env; 0 here) |
| Integration (node-env) — existing G1 | ~30 | as before |
| Integration (node-env) — G2 additions | ~24 | MC-1 (3) + MC-2 (6) + MC-7 server (1) + Sec-D (3) + Sec-F (4) + Sec-G (3) + Sec-H integration (2) + MC-6 gap-resync (1) + rate-limit flood (1) |
| Existing (274 tests) | 274 | no change |
| **Total (V2 target after G2)** | **~417** | **< 15 s on developer machine** |

All G2 skeletons run as skipped under `npm test -- --run` immediately. No configuration
change is needed beyond the `.skip` removal process described in §6.3.

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
