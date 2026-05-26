# Multiplayer Chaos Plan — D&D Campaign Assistant

> **Owner:** chaos-engineer (D2-chaos)
> **Inputs:** `MULTIPLAYER-ARCHITECTURE.md` §8 (F1–F7 failure modes), §3 (server-side Ollama proxy,
> per-room action queue), §2 (WebSocket on :3001, reconnect/backoff), §4 (turn state machine);
> `MULTIPLAYER-ORCHESTRATION.md` §5 risk register (R1–R5); `MULTIPLAYER-PRD.md` §5 success criteria.
> **Status:** DESIGN-ARC — experiment designs only. No experiment runs until V2 (post-G1 + post-V1).
> **Environment:** LAN dev only. All experiments use throwaway test sessions/rooms. No production
> sessions, no WAN, no real user data.

---

## 0. Scope and Safety Constraints

Every experiment in this plan operates under the following non-negotiable constraints:

**Blast-radius boundaries:**
- All experiments use test-only `sessionId` values prefixed `chaos-test-` so they are
  trivially distinguishable from real sessions at any point in the run.
- The `server/sessions/` directory is snapshotted before each experiment run
  (`sessions-snapshot-<timestamp>/`). Rollback = delete the modified test `.md` file or restore
  from snapshot.
- No experiment modifies or reads any session file whose `sessionId` does not start with
  `chaos-test-`. The injection scripts enforce this with a guard check before any write.
- All destructive injections (process kill, network block) use OS-level scoping to the
  local Node/Ollama processes only — not host firewall rules that could affect other LAN devices.

**Rollback guarantee (<30 s):**
- Every injection that kills a process uses a wrapper that captures the PID and restarts
  the process automatically after the observation window, or on the experimenter pressing
  `Ctrl+C`. Max observation window before auto-restart: 30 s unless the test explicitly
  requires a longer window (noted per experiment).

**Steady-state verification:**
- Before any experiment, run the steady-state probe (see §0.2) and confirm it passes.
  A failed probe means the system is already degraded — do not inject.

**No customer impact statement:**
- This is a home-LAN dev app with no external users. "Customer impact" = a real campaign session
  belonging to the host. Protection = chaos-test session isolation above.

### 0.1 Steady-State Definition (System-Wide)

The system is healthy when ALL of the following hold simultaneously:

| Signal | Healthy value | How to measure |
|--------|---------------|----------------|
| WebSocket connections | All clients report `readyState === 1` (OPEN) | `useWebSocket.js` connection state |
| Phase | `free-roam` or `combat` (never stuck in `awaiting-dm` > 60 s) | Server room state `/debug/room/:id` endpoint (add in test build) |
| `turnSequence` | Identical across all connected clients | Logged in `session:update` events; compare via test harness |
| `.md` file on disk | Present, parseable by `fromMarkdown`, `schemaVersion === 2` | `readStored(id)` in test assertion |
| Ollama reachable | HTTP 200 from `GET http://localhost:11434/api/tags` within 2 s | Probe script |
| Single-player fallback | Direct Ollama fetch path responds correctly when WS is down | Existing 274-test suite green |

### 0.2 Steady-State Probe (run before every experiment)

```javascript
// tests/chaos/probes/steady-state.mjs
// Run: node tests/chaos/probes/steady-state.mjs <roomCode>
// Exit 0 = healthy; exit 1 = degraded (do not inject)
```

The probe:
1. `GET /sessions` — confirms sync server is up and returns a valid JSON array.
2. Opens a WebSocket to `ws://localhost:3001/ws` and sends a `join` for the chaos test room.
3. Asserts `session:state` event arrives within 2 s and `turnSequence` is a non-negative integer.
4. Closes cleanly.
5. Checks Ollama via `GET http://localhost:11434/api/tags` — expects HTTP 200 within 2 s.

---

## 1. Prioritized Run Order

Highest-risk first, based on novelty of the failure mode relative to existing single-player
safeguards and severity of potential state corruption:

| Priority | Experiment | Mapped Risk | Rationale |
|----------|-----------|-------------|-----------|
| 1 | EX-1 DM double-trigger (R1) | R1 | Central architectural guarantee; any flaw = garbled game state for all clients |
| 2 | EX-3 Ollama unavailable mid-turn | R1, R5 | Wedged `awaiting-dm` phase blocks all players; no existing mitigation in single-player path for server-side proxy failure |
| 3 | EX-5 Server restart with live session | R3, R2 | `.md` recovery path is the single durability guarantee; must be verified before combat scenarios |
| 4 | EX-2 Dropped WebSocket / network partition | R2, R5 | M7 gate and `9999` sentinel carry over from Phase B but have not been exercised with WebSocket reconnect path |
| 5 | EX-4 Two players acting on the same combat turn | R5 | Narrower blast radius; server-side guard is clear, but race window needs timing-precise injection |
| 6 | EX-6 turnSequence gap / missed update (F4) | R5 | Desync is transient and self-correcting; run after core combat path is validated |
| 7 | EX-7 Active-player disconnect during combat (F3) | R4 | Session stall is documented v1 behavior; run last to verify no deadlock/crash |

---

## 2. Automation vs Manual Multi-Device Classification

| Experiment | Can be automated in test-automator harness? | Notes |
|------------|---------------------------------------------|-------|
| EX-1 | Yes — fully | Two programmatic WS clients, mock Ollama endpoint |
| EX-2 | Partial — WS close is automatable; true network partition needs OS-level `netsh advfirewall` or a proxy intercept | Manual multi-device for the full partition scenario |
| EX-3 | Yes — fully | Kill Ollama PID or point server at a mock that hangs |
| EX-4 | Yes — fully | Three programmatic WS clients; timing controlled via `setTimeout` |
| EX-5 | Partial — process kill is automatable; multi-device reconnect observation benefits from a second physical device | Single-machine is sufficient for correctness; multi-device for UX timing |
| EX-6 | Yes — fully | Inject a packet-drop shim in the Node WS event emitter at test time |
| EX-7 | Yes — fully | WS client `ws.terminate()` after combat phase detected |

The multi-client harness runs a real `sync-server.mjs` instance on a test port (`:3099` to avoid
colliding with the development server), using a temp `sessions/` directory that is wiped between
runs. Ollama is replaced with a controllable mock that can: respond normally, hang indefinitely,
return a 503, or simulate a mid-stream abort.

---

## 3. Experiments

---

### EX-1 — DM Double-Trigger

**Maps to:** F1 (architecture §8), R1 (risk register)

**Failure mode being probed:**
Two clients submit `action` events in the narrow race window before the server's `awaiting-dm`
phase broadcast has reached both clients, resulting in two concurrent Ollama calls and potentially
two independent DM responses merged into the message log.

**Steady-state hypothesis:**
The server's per-room Promise-chain action queue (`withLock` pattern, §3.3) serializes all
incoming `action` events. Exactly one Ollama call fires per player-turn cycle. The `turnSequence`
counter advances by exactly 1. Both clients see the same single DM response. The second action
receives `error: DM_BUSY` and is preserved on the sender's client for resubmission.

Measurable signals:
- Mock Ollama call count for the room = 1.
- `dm:done` events received by both clients = 1.
- `turnSequence` on both clients after the turn = N+1 (not N+2).
- No duplicate assistant messages in either client's message log.

**Injection method:**
```
Test harness (Node, 2 programmatic ws clients A and B):
1. Both clients join the same chaos-test room in FREE_ROAM phase.
2. Both clients send an `action` event within the same JavaScript event loop tick
   (Promise.all + zero delay), simulating the minimum possible race window.
3. Repeat with 10 ms, 50 ms, 100 ms delays between sends to cover the realistic
   LAN propagation window.
4. The mock Ollama endpoint records every call with a timestamp and streams a
   fixed short response (avoids real inference latency).
```

**Expected behavior / assertions:**
1. Mock Ollama call count = 1 across all timing variants (0 ms through 100 ms delay).
2. Client A or B (whichever the queue dequeued first) receives `dm:done` once.
3. The other client receives `error: { code: "DM_BUSY" }` for its action.
4. The error client's input content is NOT cleared (client preserves it).
5. After `dm:done`, `turnSequence` on both clients = initial + 1.
6. `session:update` broadcast contains one new assistant message, matching the mock
   Ollama response exactly.
7. The `.md` file on disk contains exactly one new assistant message entry.

**Abort conditions:**
- Mock Ollama call count > 1: abort immediately. This is the critical failure.
  Capture the `ws` event log, the Promise-chain state at time of the double call,
  and the `phase` field at the moment each call was made.
- Either client crashes (unhandled exception in the test harness): abort and capture stack trace.
- The room's `phase` is stuck in `awaiting-dm` > 10 s after the mock Ollama completes: abort.

**Blast-radius limits:**
- Test room `chaos-test-ex1-<timestamp>` only.
- Mock Ollama never communicates with the real Ollama process.
- `sessions/` temp directory is wiped after the run.
- No filesystem writes outside the temp `sessions/` directory.

---

### EX-2 — Dropped WebSocket / Network Partition

**Maps to:** F2 (architecture §8), R2, R5 (risk register)

**Failure mode being probed:**
A client's WebSocket connection drops mid-session. The client falls back to the 30s poll path,
potentially writes a local action to localStorage, then reconnects. The server has progressed
(one or more turns by other players). The M7 strictly-newer gate must prevent the stale local
state from overwriting the authoritative server state. No split-brain display after reconnect.

**Steady-state hypothesis:**
On WebSocket close, `useSessionPersistence.js` resumes the 30s `pollSyncSession` interval
(degraded single-player mode). On reconnect, the client sends `join` with `lastTurnSequence`.
If the server's `turnSequence` > client's, the server sends `session:state`. The M7 gate
(`payload.savedAt > max(localStorage.savedAt, lastSavedAt.current)`) accepts the server state.
The client display converges to the server's authoritative session within one round-trip (<50 ms on LAN).
No stale messages are shown; no offline-written local action appears in the DM's log.

Measurable signals:
- After reconnect: client's displayed `turnSequence` = server's `turnSequence`.
- Client's message log = server's message log (count and order).
- `phase` on client = `phase` on server.
- No message duplication in the client's message log.

**Injection method — two scenarios:**

_Scenario A (programmatic WS close — automatable):_
```
1. Client A and Client B join the chaos-test room.
2. Client A sends action, DM responds (turn N → N+1).
3. Call ws.close() on Client A's WebSocket programmatically.
4. While Client A is disconnected:
   a. Client B sends another action. DM responds (turn N+1 → N+2).
   b. Wait for the 30s poll cycle to fire on Client A (or advance the clock
      using sinon/fake timers in the test harness to skip waiting).
5. Re-open Client A's WebSocket (reconnect).
6. Assert Client A's state converges to turnSequence = N+2.
```

_Scenario B (OS-level network partition — manual multi-device):_
```
1. Two physical devices on LAN. Client A on Device 1, Client B on Device 2.
2. Device 1's Wi-Fi is disabled mid-session (manual: toggle Wi-Fi off).
3. Client B plays a turn while Device 1 is offline.
4. Device 1's Wi-Fi is re-enabled.
5. Observe Client A's reconnect behavior (WebSocket reconnect + join + session:state).
6. Assert same convergence as Scenario A.
```

**Expected behavior / assertions:**
1. Within 1 s of WS close, Client A's `useWebSocket.js` starts exponential backoff.
2. Client A's 30s poll resumes and does NOT advance its `turnSequence` past the server's
   (M7 gate blocks any stale PUT from overwriting the server).
3. On reconnect, Client A sends `join` with its last known `lastTurnSequence` (= N+1).
4. Server responds with full `session:state` (because N+1 < server's N+2).
5. Client A's `adopt()` gate accepts the state (server `savedAt` > local `savedAt`).
6. Client A displays the same message count and `turnSequence` as Client B.
7. If Client A had an un-submitted action in its input box, it is preserved (not cleared).
8. No message appears on Client A that does not also appear on Client B.

**Abort conditions:**
- Client A shows a message that Client B does not show after convergence (split-brain): abort.
  Capture both clients' message arrays and `turnSequence` values.
- Client A's `adopt()` gate incorrectly rejects the server state (logged as a warning):
  abort and inspect the `savedAt` comparison logic.
- The `9999` sentinel is incorrectly triggered on a live session (blocking all future
  `session:state` adoption): abort immediately. This would indicate the sentinel logic
  has a regression.

**Blast-radius limits:**
- Test room `chaos-test-ex2-<timestamp>` only.
- Scenario B's Wi-Fi toggle affects only the test device; no other LAN devices are impacted.
- The `sessions/` temp directory is wiped after the run.

---

### EX-3 — Ollama Unavailable Mid-Turn

**Maps to:** F5 (architecture §8), R1

**Failure mode being probed:**
The sync server has received a player `action`, set `phase = awaiting-dm`, and begun the
server-side Ollama fetch. The Ollama process becomes unavailable (crash, timeout, or ECONNREFUSED)
before the stream completes. The room must not be permanently wedged in `awaiting-dm`. All
clients must be notified. The single-player fallback path (direct client Ollama fetch when
WebSocket is down) must be unaffected.

**Steady-state hypothesis:**
The server's Ollama fetch is wrapped in a try/catch (§3.2). On error mid-stream, the server:
(a) broadcasts `dm:done` with `{ error: true, partial: fullTextSoFar }` to all clients;
(b) releases the per-room action queue lock;
(c) resets `phase` to the pre-action value (`free-roam` or `combat`, whichever it was before);
(d) does NOT increment `turnSequence`;
(e) does NOT write to the `.md` store.
Clients display the partial content as an error message. The next player action successfully
triggers a new Ollama call.

Measurable signals:
- `phase` returns to `free-roam` (or `combat`) within 2 s of the Ollama failure.
- `turnSequence` does not advance.
- `.md` file's last `turnSequence` = the value before the failed turn.
- All clients receive `dm:done` with `error: true`.
- The subsequent action from any client triggers exactly one new Ollama call (recovery).

**Injection method — three sub-scenarios:**

_3A: ECONNREFUSED (Ollama not running):_
```
1. Client joins the chaos-test room. Verify steady state.
2. Stop the Ollama process (Windows: taskkill /IM ollama.exe /F).
3. Client sends an action.
4. The server's fetch to Ollama hits ECONNREFUSED immediately.
5. Observe error propagation to the client.
6. Restart Ollama.
7. Client sends a second action. Assert clean recovery.
```

_3B: Mid-stream abort (Ollama crashes after partial response):_
```
1. Use mock Ollama that streams 3 delta chunks then abruptly closes the connection
   (Node's http.Server calls socket.destroy() after 3 chunks).
2. Client sends an action.
3. Server receives partial text, then stream error.
4. Assert partial text is surfaced as error and phase resets.
```

_3C: Timeout (Ollama hangs, never responds):_
```
1. Use mock Ollama that accepts the connection but never sends any data
   (socket open, no response).
2. The server must have a request timeout guard (recommended: 90 s on LAN;
   this experiment verifies the guard fires if Ollama stalls).
3. If no timeout guard exists, this experiment will reveal a permanent wedge
   (abort condition).
4. Assert phase resets after timeout fires.
```

**Expected behavior / assertions:**
1. For all sub-scenarios: `phase` is not `awaiting-dm` more than `max(timeout, 2s after error)`.
2. Both clients receive `{ type: "dm:done", payload: { error: true, partial: "..." } }`.
3. The partial text visible in the client's message log is marked as an error (not a normal
   assistant message).
4. `turnSequence` on both clients = pre-failure value.
5. After Ollama recovery (3A, 3C), a new action from any client completes a full turn
   (mock Ollama call count = 1, `turnSequence` advances by 1).
6. The `.md` file does not contain the failed partial response.

**Abort conditions (critical):**
- `phase` remains `awaiting-dm` for > 90 s after Ollama fails: this is the permanent-wedge
  failure. Abort immediately. This is the most dangerous failure mode in this experiment.
  Record whether a timeout guard exists in the implementation.
- Any client shows a JavaScript error / uncaught exception in the browser console.
- The action queue lock is not released (evidenced by subsequent actions also being rejected
  with `DM_BUSY` indefinitely).

**Blast-radius limits:**
- Test room `chaos-test-ex3-<timestamp>` only.
- Sub-scenario 3A kills the real Ollama process. If the host is using Ollama for other
  purposes, wait for the experiment window (Ollama is restarted within 30 s by the
  wrapper script).
- The mock Ollama for 3B and 3C runs on port `:11435` (not the real Ollama port) to
  avoid disrupting real sessions. The server's `OLLAMA_HOST` environment variable is
  overridden for the test server instance only.

**Additional note — single-player fallback:**
After sub-scenario 3A (Ollama kill + restart), verify that a client in single-player mode
(WebSocket disconnected, `connectionCount === 1`) can still call Ollama directly. This
confirms that the server-side Ollama dependency does not silently break the fallback path.

---

### EX-4 — Two Players Acting on the Same Combat Turn

**Maps to:** F7 (architecture §8), R5 (risk register)

**Failure mode being probed:**
In COMBAT phase with Player A as the active member (`isActive: true`), non-active Player B
submits an `action` event. The server must reject it with `error: NOT_YOUR_TURN` without
modifying the `phase`, `turnSequence`, or the active player state. Player A's subsequent
valid action must succeed. Additionally, the edge case where both Player A and Player B
submit simultaneously (same-tick race) must not produce two Ollama calls.

**Steady-state hypothesis:**
The server's `action` handler (§4.4) checks `phase === "combat"` and verifies
`sender.displayName` case-insensitively matches the `isActive` party member. Non-matching
senders receive `error: NOT_YOUR_TURN`. The `isActive` state remains unchanged. The
`turnSequence` does not advance. After the rejection, Player A submits a valid action; the
DM responds; `turnSequence` advances by 1; the new `party` block designates the next active
player correctly on all clients.

Measurable signals:
- `error: NOT_YOUR_TURN` received by the non-active client.
- `phase` = `combat` on all clients after the rejection.
- `isActive` flags unchanged after the rejection.
- `turnSequence` unchanged after the rejection.
- After Player A's valid action: `turnSequence` = N+1, new `isActive` member matches mock
  Ollama's party block response.

**Injection method:**
```
Test harness (Node, 3 programmatic ws clients: A = active player, B = non-active, C = observer):
1. All three clients join chaos-test room.
2. Seed the room state to COMBAT phase with A.displayName matching the isActive party member.
   (Done via a direct .md write to the test sessions directory using serializeSession +
   toMarkdown, with phase: 'combat' and one party member isActive: true matching A's name.)
3. Client B sends an action. Assert NOT_YOUR_TURN error.
4. Client C (observer) confirms phase and isActive are unchanged via session:update.
5. Simultaneously (same event loop tick): Client B and Client A both send actions.
   Assert: A's action is accepted (or queued), B's action is rejected NOT_YOUR_TURN.
   Assert: exactly one Ollama call fires (A's action).
6. Mock Ollama responds with a party block passing isActive to C's display name.
7. Assert: C's client's input becomes enabled after dm:done.
8. Assert: A's client's input becomes disabled (no longer active turn).
9. Assert: B's client remains disabled (not their turn).
```

**Expected behavior / assertions:**
1. `error: { code: "NOT_YOUR_TURN" }` delivered to Client B in steps 3 and 5.
2. Client B's input content is NOT cleared on the rejection.
3. `phase`, `turnSequence`, `party[].isActive` are identical on all three clients before and
   after the rejection (no state drift from a rejected action).
4. In step 5 (simultaneous A+B submit): exactly one Ollama call fires (A's action processed,
   B's rejected immediately without entering the queue).
5. After mock Ollama responds (step 6): `turnSequence` = N+1 on all clients.
6. Client C's input becomes enabled (reflects new `isActive: true` for C's character).
7. Client A's input shows "Waiting for [C's name]'s action..." placeholder.

**Abort conditions:**
- Client B's rejected action reaches Ollama (mock call count includes B's content): abort.
  This would indicate the `NOT_YOUR_TURN` check is being applied after the queue rather
  than before it.
- `isActive` flags diverge across clients after any rejection: abort (split-brain).
- `phase` unexpectedly transitions to `free-roam` or `awaiting-dm` after a rejected action:
  abort.

**Blast-radius limits:**
- Test room `chaos-test-ex4-<timestamp>` only.
- Party state seeded via direct `.md` file write — no live game is modified.
- Mock Ollama on `:11435`, not the real Ollama process.

---

### EX-5 — Server Restart with a Live Session

**Maps to:** F6 (architecture §8), R3, R2

**Failure mode being probed:**
The sync server process (`sync-server.mjs`) restarts while one or more clients are connected
to an active room. All in-memory state (rooms Map, connections, action queue) is lost. Clients
detect the WebSocket close and begin exponential backoff reconnect. On reconnect they send
`join` with their `lastTurnSequence`. The server re-reads the `.md` file and reconstructs
the room. The clients receive `session:state` with the last persisted state. The `phase` field
in the `.md` file determines the restored phase. This is the primary durability guarantee
(R3 — `.md` preservation).

**Steady-state hypothesis:**
After server restart and client reconnect:
- All clients' `turnSequence` = the `turnSequence` in the `.md` file (last successful turn).
- `phase` on all clients = `phase` stored in the `.md` file.
- `party` state on all clients = `party` stored in the `.md` file.
- Message log on all clients = messages stored in the `.md` file.
- Any turn that was in-flight (mid-stream `dm:delta`) when the server restarted is LOST
  (not persisted, not replayed). This is expected and documented behavior.
- The next player action after reconnect succeeds (action queue is empty and functional).

Measurable signals:
- Reconnect completes within the backoff window (max 30 s + jitter per §2.3).
- `session:state` event received by all clients after reconnect.
- `turnSequence` on clients after reconnect = `turnSequence` in the `.md` file.
- The test action after recovery produces `dm:done` and advances `turnSequence` by 1.

**Injection method — two sub-scenarios:**

_5A: Clean restart (between turns):_
```
1. Client A and Client B join chaos-test room.
2. Play one complete turn (action → dm:done → session:update → .md written).
3. Kill the sync-server process (Windows PowerShell: Stop-Process -Name node -Id <PID>).
   Use the specific PID captured at startup to avoid killing unrelated Node processes.
4. Observe: both clients' WebSocket fires onclose; backoff begins.
5. Restart sync-server: npm run sync (or node server/sync-server.mjs).
6. Observe: clients reconnect (first attempt at 1s ± jitter).
7. Assert steady-state signals above.
8. Client A sends a new action; assert full turn cycle completes.
```

_5B: Restart mid-DM-stream (most destructive):_
```
1. Client A joins chaos-test room.
2. Client A sends an action.
3. Mock Ollama begins streaming (slow drip: one chunk per 500 ms).
4. After 3 chunks, kill the sync-server process.
5. Observe: client received some dm:delta events but not dm:done.
6. Restart sync-server.
7. Observe reconnect and session:state.
8. Assert: client's message log = last .md-persisted state (the in-flight partial response
   is NOT present).
9. Assert: turnSequence on client = last persisted turnSequence (not advanced).
10. Client sends a new action; assert clean turn cycle.
```

**Expected behavior / assertions:**
1. Both sub-scenarios: reconnect occurs within 30 s (backoff cap per architecture).
2. `session:state` is delivered with the last `.md`-persisted content.
3. 5B specifically: the partial DM text from before the kill is NOT in the restored
   message log. The client may have displayed it transiently; after reconnect it is gone.
4. In 5B: `turnSequence` on the client after reconnect = the value before the killed turn
   (NOT the would-be-advanced value).
5. First action after recovery: exactly one Ollama call, `dm:done` broadcast, `turnSequence` N+1,
   `.md` file updated.
6. The `.md` file is a valid `fromMarkdown`-parseable document at every stage (before kill,
   after restart, and after the recovery turn).

**Abort conditions:**
- Client never reconnects (no `session:state` received within 60 s after server restart):
  abort. Check that the backoff loop is running and `join` messages are being sent.
- After reconnect, `turnSequence` on the client is HIGHER than the `.md` file's value:
  abort. This would mean the client has accepted a phantom state update.
- In 5B: the partial DM text appears in the client's message log after reconnect AND after
  the recovery action completes: abort (persistence boundary violation — something wrote
  the partial state to the `.md` file).
- The recovery action (step 8 / 10) receives `DM_BUSY` indefinitely: abort. This would
  indicate the action queue lock was not properly reset on restart.

**Blast-radius limits:**
- Process kill targets the specific PID of the test server instance (launched on `:3099`,
  not the dev server on `:3001`). The dev Vite server on `:5173` and real Ollama on `:11434`
  are not affected.
- Test room `chaos-test-ex5-<timestamp>` only.
- `sessions/` temp directory for the test instance is separate from the real `server/sessions/`.

---

### EX-6 — turnSequence Gap / Missed Update (Combat-Turn Desync)

**Maps to:** F4 (architecture §8), R5 (risk register)

**Failure mode being probed:**
A `session:update` event is lost in transit (simulated packet drop or out-of-order delivery).
One client's `turnSequence` falls behind. The client must detect the gap (received
`turnSequence` != `localTurnSequence + 1`), request a full `session:state` resync, and
converge to the correct `isActive` state within 500 ms. During the gap window, a client
showing the wrong active player may attempt to act; this must produce `NOT_YOUR_TURN` and
not corrupt state.

**Steady-state hypothesis:**
A client that receives a `session:update` with `turnSequence` > `localTurnSequence + 1`
detects a gap. It sends a `join` (or a dedicated `resync` message) to request `session:state`.
The server responds with the full current state. All `isActive` flags converge within 500 ms
(one LAN round-trip). The stale client that attempted to act during the gap receives
`NOT_YOUR_TURN` and is not corrupted.

Measurable signals:
- Gap detected (logged by the client's gap-detection logic) within 1 received event of the
  dropped one.
- `session:state` resync received within 100 ms of the resync request (LAN latency).
- `isActive` flags on the lagging client converge to match the other clients within 500 ms.
- `turnSequence` on all clients is identical after convergence.

**Injection method:**
```
Test harness (Node, 2 programmatic ws clients A and B):
1. Both clients join chaos-test room in COMBAT phase (seeded via .md write).
2. Insert a drop shim on Client A's WebSocket event handler:
   - Shim intercepts inbound 'message' events.
   - It silently drops the SECOND session:update event (turnSequence = N+1).
   - It passes all subsequent events normally (N+2, N+3, ...).
3. Client B sends an action. Server broadcasts session:update (N+1).
   - Client A's shim drops this event.
   - Client B receives it normally.
4. Client B sends another action. Server broadcasts session:update (N+2).
   - Client A receives it (shim only dropped N+1).
   - Client A detects gap: received N+2 but expected N+1.
5. Assert Client A sends a resync request.
6. Assert Client A receives session:state with turnSequence = N+2.
7. Assert isActive on Client A = isActive on Client B after convergence.
```

**Expected behavior / assertions:**
1. Client A detects the gap within the same event-loop tick as receiving `turnSequence = N+2`.
2. Client A sends a resync request immediately (no waiting, no retry delay).
3. Server delivers `session:state` within 100 ms.
4. `isActive` and `phase` on Client A converge to match Client B within 500 ms.
5. `turnSequence` on Client A = N+2 after convergence.
6. No corrupted messages (no phantom messages, no missing messages) in Client A's log
   after convergence.

**Abort conditions:**
- Client A does not detect the gap (no resync request sent): abort. The gap-detection
  logic is missing or misconfigured.
- After convergence, `isActive` on Client A differs from Client B: abort (split-brain).
- The resync request triggers a second full game state adoption that overwrites newer local
  state (regression of the M7 gate): abort.

**Blast-radius limits:**
- Drop shim is a test-harness-only code path; it is never compiled into the production
  client bundle. It operates on the in-process WebSocket event emitter.
- Test room `chaos-test-ex6-<timestamp>` only.
- No real Ollama involvement; mock responds with canned party blocks.

---

### EX-7 — Active-Player Disconnect During Combat

**Maps to:** F3 (architecture §8), R4 (risk register)

**Failure mode being probed:**
In COMBAT phase, the active player (whose input is enabled) disconnects (WebSocket closes).
The session is now in a potential stall: `phase = "combat"`, `isActive` flags unchanged,
but the player who is supposed to act is gone. Verify: (a) the session does not crash or
deadlock; (b) remaining clients stay in valid `COMBAT` phase; (c) the disconnected client
can rejoin and resume as the active player.

**Steady-state hypothesis:**
On client disconnect, the server removes the connection from `rooms[roomCode].clients` and
broadcasts `presence:update` (§5.3). The `phase` remains `"combat"` and `isActive` is
unchanged (party is DM-owned; disconnect does not modify game state). Remaining clients
see the disconnected player as offline in the presence list but the combat HUD does not
change. On rejoin, the server sends `session:state` with the current COMBAT phase and the
disconnected player's character still `isActive: true`. The rejoined client's input is
immediately enabled (they are the active player).

Measurable signals:
- `presence:update` broadcast within 1 s of disconnect.
- `phase` = `combat` on remaining clients after disconnect.
- `isActive` flags unchanged on remaining clients after disconnect.
- On rejoin: `session:state` delivered; rejoined client's input is enabled.
- After rejoin, the active player submits an action; full turn cycle completes.

**Injection method:**
```
Test harness (Node, 2 programmatic ws clients: A = active player, B = observer):
1. Both clients join chaos-test room.
2. Seed COMBAT phase with A.displayName as the isActive party member.
3. Call ws.terminate() on Client A's WebSocket (hard close, no graceful shutdown frame).
4. Observe:
   a. Server fires 'close' event on A's socket.
   b. Server broadcasts presence:update to B.
   c. B's presence list shows A as disconnected.
   d. B's phase remains "combat".
   e. B's isActive flags are unchanged.
5. Re-connect Client A (new WebSocket, same displayName, same roomCode).
6. Client A sends join with lastTurnSequence.
7. Server delivers session:state.
8. Assert A's input is enabled (phase = combat, isActive matches A's character).
9. Client A sends an action. Assert full turn cycle completes.
```

**Expected behavior / assertions:**
1. `presence:update` received by Client B within 2 s of A's `ws.terminate()`.
2. Client B's `phase` = `"combat"` and `isActive` flags unchanged after A disconnects.
3. Client B cannot submit an action (not the active player); `NOT_YOUR_TURN` if attempted.
4. Client A reconnects within the backoff window (first attempt at 1 s ± jitter).
5. Server delivers `session:state` to Client A with `phase = "combat"` and A's character
   `isActive: true`.
6. Client A's UI shows its input as enabled.
7. Client A's action completes a full turn (Ollama responds, `dm:done` broadcast, both
   clients receive `session:update`, `turnSequence` advances by 1).
8. The `.md` file is written after the recovery turn with the updated state.

**Abort conditions:**
- `phase` changes to anything other than `"combat"` when A disconnects (server must not
  auto-reset phase on disconnect): abort.
- Client B's `isActive` flags change when A disconnects: abort (party state must be
  DM-owned only).
- Client A cannot submit an action after rejoin (input remains disabled despite `isActive:
  true` for their character): abort.
- The session enters a permanent deadlock (no action from any client accepted after A
  disconnects and before A rejoins): abort. Document whether a host "advance turn" escape
  hatch is needed for v1.

**Blast-radius limits:**
- `ws.terminate()` targets only the test client's in-process WebSocket, not the OS network
  interface.
- Test room `chaos-test-ex7-<timestamp>` only.
- Mock Ollama on `:11435`.

---

## 4. Extra Experiments from Architecture §8

The five required experiments cover F1, F2, F3, F4, F5, F6, F7 from architecture §8.
Two supplementary experiments address edge cases that the architecture implies but does not
give a dedicated failure-mode entry:

---

### EX-8 — Schema Version Mismatch on Rejoin (R2 supplement)

**Failure mode:** A client that saved a v1 `.md` file (pre-multiplayer, `schemaVersion = 1`)
attempts to join a v2 room by loading that file on the setup screen. The server serves a v2
`session:state`. The client's `deserializeSession` must apply the v1 compat branch and fill
`{ phase: 'free-roam', roomCode: null, turnSequence: 0 }` rather than crashing.

**Maps to:** R2 (sync migration), specifically the v1→v2 `deserializeSession` compat branch
documented in architecture §1.2.

**Steady-state hypothesis:** A client that loads a v1 `.md` and joins a v2 room receives
`session:state` with `schemaVersion: 2`. `deserializeSession` accepts it, fills defaults,
and the client renders normally. No uncaught exception.

**Injection method:** Load an actual v1-format `.md` file (one of the existing test fixtures
from the 274-test suite or from `sessions/` if available) on a test client's setup screen.
Join a chaos-test room seeded with v2 state. Assert the client renders without error.

**Abort conditions:** Any `console.error` or thrown exception during deserialization.

---

### EX-9 — `.md` Save During Active Multiplayer Turn (R3 supplement)

**Failure mode:** The host clicks the "Save session (.md)" button in `Chat.jsx` while
`phase === "awaiting-dm"` (DM is mid-stream). The downloaded file captures a partial state
(messages up to the last `dm:done`, but the current in-flight response is not yet appended).
A later load of that file must restore cleanly without any orphaned `awaiting-dm` phase.

**Maps to:** R3 (`.md` handoff preservation). The architecture states that `connections` and
`dmClientId` are NOT written to `.md` and that `phase` IS written. If `phase = "awaiting-dm"`
is written and then loaded, the client must recover to `free-roam` (since there is no in-flight
Ollama call on a fresh load).

**Steady-state hypothesis:** A `.md` file saved during `awaiting-dm` phase is loaded by a
fresh client and enters `free-roam` phase (not stuck in `awaiting-dm`). The partial DM
response is not present in the loaded message log.

**Injection method:** 
1. Use the slow-drip mock Ollama to hold `awaiting-dm` for 10 s.
2. During that window, trigger `handleSaveSession` programmatically (simulating the button click).
3. Load the downloaded `.md` on a separate test client.
4. Assert loaded `phase` = `free-roam` (even if the file has `phase: "awaiting-dm"` written
   — `fromMarkdown` should override or `App.jsx` must sanitize on load).
5. Assert the client can immediately submit an action.

**Abort conditions:** Loaded client is stuck in `awaiting-dm` with no way to send an action.

---

## 5. Experiment Scaffold Reference

All experiments share the following test infrastructure (to be implemented by `test-automator`
in MULTIPLAYER-TEST-AUTOMATION.md):

**Test server:** A real `sync-server.mjs` instance started on port `:3099` via
`createSyncServer({ sessionsDir: tempDir })` — using the same exported factory already in
the sync server, with a throwaway temp directory per test run.

**Mock Ollama:** A minimal Node HTTP server on `:11435` (or a port injected via environment
variable into the test server) with modes: `normal` (streams a fixed party block response),
`slow-drip` (one chunk per 500 ms), `mid-abort` (3 chunks then `socket.destroy()`),
`hang` (accepts connection, never responds), `error-503` (immediate HTTP 503).

**WS client helper:** A thin wrapper over the Node `ws` package that:
- Exposes `connect(roomCode, displayName, lastTurnSequence)` → sends `join` automatically.
- Exposes `send(action)` for player actions.
- Exposes `terminate()` for hard disconnect.
- Exposes `drop(n)` for the gap-shim (silently drops the nth inbound `session:update`).
- Collects all received events in an ordered array for assertion.

**Session seeder:** A function that writes a pre-crafted `.md` file (produced by
`serializeSession` + `toMarkdown`) directly to the temp `sessionsDir` before the experiment,
allowing arbitrary phase and party state to be injected without requiring a DM turn cycle to
reach the desired state.

**Cleanup hook:** After every experiment: delete all `chaos-test-*` files from the temp
`sessionsDir`; verify no real session files were touched (assert no file in `sessionsDir`
whose name does not start with `chaos-test-`).

---

## 6. Traceability Matrix

| Experiment | Architecture §8 Failure | Risk Register | PRD Success Criterion |
|------------|--------------------------|---------------|----------------------|
| EX-1 DM double-trigger | F1, F7 | R1 | §5.2 No DM double-output; §5.3 Simultaneous actions |
| EX-2 Dropped WS / partition | F2 | R2, R5 | §5.2 No split-brain; §5.4 Disconnect recovery |
| EX-3 Ollama unavailable | F5 | R1 | §5.2 Stability; §5.5 Error handling |
| EX-4 Two players same turn | F7 | R5 | §5.3 Combat turn order; §5.2 No split-brain |
| EX-5 Server restart | F6 | R3, R2 | §5.4 Server failure recovery; §5.4 Session continuity |
| EX-6 turnSequence gap | F4 | R5 | §5.2 Party state convergence; §5.1 Turn-state sync <500ms |
| EX-7 Active-player disconnect | F3 | R4 | §5.4 Disconnect recovery; §5.3 Combat turn order |
| EX-8 Schema v1→v2 mismatch | (implied §1.2) | R2 | §5.6 Backward compatibility |
| EX-9 .md save during awaiting-dm | (implied §6.3) | R3 | §5.4 Session continuity; §5.6 .md handoff |

---

## References

- `docs/design/MULTIPLAYER-ARCHITECTURE.md` — §8 F1–F7, §3.3 double-trigger prevention,
  §2.3 reconnect backoff, §4 state machine, §5.3 disconnect/rejoin signaling, §1.2 schema compat
- `docs/design/MULTIPLAYER-ORCHESTRATION.md` — §5 risk register R1–R5
- `docs/design/MULTIPLAYER-PRD.md` — §5 success criteria (the steady state this plan defends)
- `server/sync-server.mjs` — `withLock` Promise-chain pattern, `fromMarkdown`/`toMarkdown` usage,
  `ID_RE` path-safety guard
- `src/lib/session.js` — `serializeSession`, `toMarkdown`, `fromMarkdown`, M7 `adopt()` gate,
  `9999` sentinel logic
- `src/hooks/useSessionPersistence.js` — 30s poll fallback, `adopt()` M7 gate, WebSocket
  suspension logic (post-implementation)
