# Multiplayer QA Plan -- D&D Campaign Assistant

> **Owner:** qa-expert (D2-qa)
> **Inputs:** MULTIPLAYER-ARCHITECTURE.md (revised post-review: section 3.5 Ollama timeout, section 3.6 server-side prompt assembly, section 3.7 mode predicate, section 4.4 action acceptance, section 5.2 connection binding, section 5.4 input validation, section 7 Phase 4 CI smoke, section 8 failure modes F1-F7);
> MULTIPLAYER-PRD.md (section 5 success criteria); MULTIPLAYER-ORCHESTRATION.md section 3.2 + section 5 risk register R1-R5;
> MULTIPLAYER-ARCH-REVIEW.md (MC-1..MC-9, Folding note end of section 4); MULTIPLAYER-SECURITY-REVIEW.md (section 1.1/1.2/1.3/section 5).
> **Status:** DESIGN-ARC -- plan only. No feature code exists. Execute in V2 after G1 clears.
> **Existing test posture:** Vitest (jsdom + one node-env server suite), 274 tests, npm test -- --run.

---

## 1. Acceptance Criteria for the Hybrid Play Model

All criteria are binary pass/fail. Any single FAIL blocks the G3 gate.

### 1.1 Free-Roam Phase

| ID | Criterion | Pass condition | Fail condition |
|----|-----------|---------------|----------------|
| AC-FR-01 | Any connected player can submit an action | Server returns a successful queue entry for every player regardless of connection order | Any player action is rejected with NOT_YOUR_TURN or DM_BUSY when phase is FREE_ROAM |
| AC-FR-02 | All players receive every message | Every session:update or dm:delta broadcast reaches all clients in the room | Any client is missing one or more messages visible to another client after 60 s idle |
| AC-FR-03 | Simultaneous free-roam actions produce exactly one DM response per dequeue | Two actions sent within the race window result in exactly two eventual DM responses (each to a separate queue turn), never merged or garbled | More or fewer Ollama calls than queued actions; merged response text |
| AC-FR-04 | Input is enabled for all players in free-roam | All clients show an enabled textarea with default placeholder | Any client shows disabled input, waiting overlay, or NOT_YOUR_TURN while phase is free-roam |
| AC-FR-05 | Phase broadcast reaches all clients within 500 ms | session:update carrying phase: free-roam reaches all clients within 500 ms of server transition | Any client remains on a non-free-roam phase >500 ms after server sets it |

### 1.2 Combat Phase

| ID | Criterion | Pass condition | Fail condition |
|----|-----------|---------------|----------------|
| AC-CB-01 | Only the active player action is accepted during combat | Server accepts actions only from the player whose displayName case-insensitively matches the party member with isActive: true; all others receive error: NOT_YOUR_TURN | Server accepts an action from a non-active player; or rejects the active player valid action |
| AC-CB-02 | isActive flag propagates to all clients within 500 ms | After the DM session:update sets a new active member, all clients reflect the updated HUD state within 500 ms | Any client shows a stale active-player highlight >500 ms after server update |
| AC-CB-03 | Non-active player input is visually disabled | Clients not matching the active member show a read-only input with waiting placeholder | Non-active client shows an enabled input that would allow text submission |
| AC-CB-04 | Active player input is visually highlighted | The client whose display name matches the active member shows a highlighted, fully-enabled input | Active player client shows disabled or unemphasized input |
| AC-CB-05 | Turn transition completes within 1 second of dm:done | After dm:done and new party block parse, all clients show the updated active member within 1 s | Any client still shows the previous active member input highlight > 1 s after dm:done |
| AC-CB-06 | Combat ends when DM emits all-isActive: false party block | Phase transitions to FREE_ROAM and all clients re-enable their inputs | Phase stays COMBAT after DM broadcasts all-false party block; any client remains locked |
| AC-CB-07 | Non-active dice rolls are local-only until free-roam | A dice roll from a non-active player during combat is NOT forwarded as an action event to the server | Server receives a dice action event from a non-active player during COMBAT phase |

### 1.3 Phase Transition Guards (AWAITING_DM / RESOLVING)

| ID | Criterion | Pass condition | Fail condition |
|----|-----------|---------------|----------------|
| AC-DM-01 | No player action accepted while AWAITING_DM | Server rejects all action events with error: DM_BUSY while phase === awaiting-dm | Server accepts or queues an action that fires a second Ollama call during an in-flight DM response |
| AC-DM-02 | No player action accepted while RESOLVING | Server rejects all action events with error: DM_BUSY while phase === resolving | Any action is accepted during the structured-block parse + persist window |
| AC-DM-03 | RESOLVING phase lasts <200 ms | Time between dm:done broadcast and the subsequent session:update (phase change) is <200 ms | Phase remains RESOLVING > 200 ms (stuck parse or persist lock) |
| AC-DM-04 | Exactly one Ollama call per queued action | Mock-Ollama endpoint receives exactly N calls after N actions are dequeued, each dequeue completing before the next starts | Mock-Ollama receives 0 or >1 calls for a single queued action |

---

## 2. Concurrency Test Scenarios (2-5 Players)

### 2.1 Player Count Boundary Tests

**SCENARIO-CON-01 -- Minimum viable: 2 players, free-roam**
- Automation: YES (two simulated ws clients, node-env)
- Setup: Room with Player A (host) and Player B. Phase FREE_ROAM.
- Steps: A sends an action. B sends an action 200 ms later.
- Expected: Both actions are queued. Exactly two Ollama calls fire sequentially (never concurrent). Both dm:done events reach both clients. Message order is deterministic (A first, then B).
- Pass gate: 0 concurrent Ollama calls; 2 total dm:done events; message count identical on both clients.

**SCENARIO-CON-02 -- Maximum: 5 players, free-roam, all submit simultaneously**
- Automation: YES (five simulated ws clients)
- Setup: 5 clients in the same room. Phase FREE_ROAM.
- Steps: All 5 clients send action events within a 50 ms window.
- Expected: The first action acquires the queue lock and sets phase to awaiting-dm. Subsequent actions either queue (if pre-broadcast) or receive DM_BUSY (if post-broadcast). Zero concurrent Ollama calls. turnSequence advances by exactly 1 per resolved action. No action is silently lost.
- Pass gate: Mock-Ollama call start timestamps are non-overlapping; turnSequence increments monotonically; no client state diverges.

**SCENARIO-CON-03 -- 3-player combat, strict turn rotation**
- Automation: YES (three simulated ws clients)
- Setup: 3 players (A, B, C). DM emits party block with A isActive: true, B and C isActive: false. Phase COMBAT.
- Steps: (1) B attempts action -- expect NOT_YOUR_TURN. (2) C attempts action -- expect NOT_YOUR_TURN. (3) A sends action -- expect acceptance, Ollama fires. (4) dm:done sets B isActive: true, A and C false. (5) A attempts action -- expect NOT_YOUR_TURN. (6) B sends -- expect acceptance.
- Pass gate: Zero unauthorized actions accepted; NOT_YOUR_TURN delivered only to the sender; turn transitions complete within 1 s of dm:done.

**SCENARIO-CON-04 -- 4-player free-roam, message order consistency**
- Automation: YES (four simulated ws clients)
- Setup: 4 clients in free-roam. Each sends one action 50 ms apart (A at t=0, B at t=50, C at t=100, D at t=150).
- Expected: All clients display messages in the same server-stamped order.
- Pass gate: messages array on all four clients is identical (canonical JSON comparison) after all session:update events settle.

### 2.2 Server Action-Queue Ordering

**SCENARIO-CON-05 -- Action queue serialization under load**
- Automation: YES (node-env, mock Ollama with 100 ms latency)
- Setup: 3 clients send actions at t=0, t=10, t=20 ms. Mock Ollama has 100 ms response latency.
- Expected: Ollama call 2 starts only after call 1 dm:done; call 3 starts only after call 2 dm:done. turnSequence advances by 1 each turn.
- Pass gate: Call start timestamps strictly non-overlapping; turnSequence increments by exactly 1 each time.

**SCENARIO-CON-06 -- DM_BUSY rejection preserves client unsent text**
- Automation: YES (jsdom environment, Chat component)
- Setup: Client A is submitting; phase transitions to AWAITING_DM. Client B sends an action and receives DM_BUSY.
- Expected: B input value is unchanged (not cleared) after the error. B can resubmit after phase returns to FREE_ROAM or COMBAT.
- Pass gate: inputValue state on B Chat component unchanged after DM_BUSY; no duplicate action submitted.

---

## 3. Edge Cases

### 3.1 Simultaneous Actions on the Same Combat Turn (maps to F7 / R5)

**SCENARIO-EDGE-01 -- Two players send within 10 ms in combat**
- Automation: YES (two ws clients with synchronized sends)
- Setup: Phase COMBAT, Player A is active. Player B (non-active) also sends within a 10 ms window.
- Expected: B action rejected with NOT_YOUR_TURN. A action accepted. Exactly one Ollama call. turnSequence delta = 1.
- Pass gate: Mock-Ollama call count = 1; turnSequence delta = 1; B receives error: NOT_YOUR_TURN.

**SCENARIO-EDGE-02 -- Race between two FREE_ROAM actions and phase broadcast (maps to F1)**
- Automation: YES
- Setup: Phase FREE_ROAM. A and B send within 5 ms. Phase-change broadcast may not reach B before B sends.
- Expected: Exactly one action accepted and fires Ollama. The other receives DM_BUSY. No duplicate Ollama call. turnSequence delta = 1.
- Pass gate: Mock-Ollama call count = 1; DM_BUSY errors = 1; turnSequence delta = 1.

### 3.2 Mid-Combat Disconnect (maps to F3 / R4)

**SCENARIO-EDGE-03 -- Active player disconnects during their combat turn**
- Automation: PARTIAL (server-side automatable via ws.terminate(); UI verification needs multi-device)
- Setup: Phase COMBAT, Player A is active. WebSocket is forcibly closed via ws.terminate().
- Expected: Server fires close event, removes A from connections, broadcasts presence:update. Phase remains COMBAT with A still isActive: true (DM owns party). Other clients remain responsive with inputs disabled. No server crash.
- Verification note: Session stall is expected v1 behavior (PRD 3.4). Verify it is a recoverable stall, not a crash.
- Pass gate: Server process alive; remaining clients receive presence:update; no error broadcast; room in-memory state intact.

**SCENARIO-EDGE-04 -- Active player disconnects and auto-reconnects**
- Automation: YES (reconnect via new ws connection with same displayName/roomCode)
- Setup: Same as EDGE-03. After 3 s, player A reconnects.
- Expected: Server re-adds A via name-match. Server sends session:state (full snapshot). Client restores COMBAT phase with A as active. A can submit an action. presence:update shows A reconnected.
- Pass gate: A receives session:state; input re-enabled; no message duplication; turnSequence unchanged from rejoin.

### 3.3 Rejoin Restoring Authoritative Phase

**SCENARIO-EDGE-05 -- Client rejoins after missing 2 turns (maps to F2 / F4)**
- Automation: YES
- Setup: 3-player session at turnSequence = 5. Player B WebSocket drops. During absence 2 more turns complete (turnSequence = 7). B reconnects with lastTurnSequence: 5.
- Expected: Server detects gap (5 < 7) and sends full session:state. B adopt() runs (server savedAt > local; adopts). B message list shows 2 missed DM responses. Party reflects turn 7.
- Pass gate: B messages count matches A and C; B party matches server; turnSequence on B = 7; no message duplication.

**SCENARIO-EDGE-06 -- Server restart restores phase from .md (maps to F6)**
- Automation: PARTIAL (server restart via server.close() + re-createSyncServer in-process; state verification automated)
- Setup: Session in COMBAT phase at turnSequence = 3. Server is closed and restarted.
- Expected: Clients detect close and begin exponential backoff reconnect. Server re-reads .md (persisted phase: combat, turnSequence: 3). Clients reconnect and receive session:state with phase: combat and turnSequence: 3. Action queue restarts empty.
- Pass gate: All clients show phase = combat after reconnect; turnSequence = 3; no DM auto-fire; no client stuck in FREE_ROAM.

### 3.4 DM Mid-Stream: Action Arriving During AWAITING_DM / RESOLVING (maps to F1 / R1)

**SCENARIO-EDGE-07 -- Action sent by any player while DM stream is in-flight**
- Automation: YES (mock Ollama with 500 ms latency)
- Setup: DM stream active. Phase AWAITING_DM. Three clients each attempt to send an action.
- Expected: All three receive DM_BUSY immediately. Zero additional Ollama calls. In-flight stream completes normally. turnSequence advances by 1 (original action only).
- Pass gate: Mock-Ollama call count = 1 (the original); 3 DM_BUSY errors delivered; turnSequence delta = 1.

**SCENARIO-EDGE-08 -- Action sent during RESOLVING phase (<200 ms window)**
- Automation: YES (artificial delay injected into parse/persist path)
- Setup: dm:done fired; server in RESOLVING phase (block parse + .md write in progress). Action sent during this window.
- Expected: DM_BUSY returned. Parse and persist complete. Phase transitions to FREE_ROAM or COMBAT normally.
- Pass gate: Action is rejected; no data corruption in .md store; phase transition completes; next action after phase change is accepted.

### 3.5 Ollama Failure Mid-Turn (maps to F5)

**SCENARIO-EDGE-09 -- Ollama crashes mid-stream**
- Automation: YES (mock Ollama that closes its connection at 50% of a response)
- Setup: Server begins streaming a DM response. Mock Ollama drops connection mid-stream.
- Expected: Server catches the stream error. Broadcasts dm:done with { error: true, partial: text-so-far }. All clients display partial response with error indicator. Phase resets to pre-action state. turnSequence does NOT increment. Queue lock is released. Next player action is accepted normally.
- Pass gate: phase reverts; turnSequence unchanged; next action succeeds within 5 s; no unhandled rejection on server; .md contains only last complete turn state.

**SCENARIO-EDGE-10 -- Ollama unavailable at action dispatch (connection refused)**
- Automation: YES (no mock Ollama listening)
- Setup: Player sends an action. Server attempts Ollama call but Ollama is not running.
- Expected: Server fetch throws a connection error. Server broadcasts dm:done with error: true. Phase resets. Queue lock released. Clients receive a clean error without crashing.
- Pass gate: Server continues serving WebSocket connections after the error; next player action attempt can be made.

### 3.6 Server Restart with Live Room (maps to F6)

**SCENARIO-EDGE-11 -- Server restart mid-DM stream (in-flight response lost)**
- Automation: PARTIAL (server close during active Ollama stream; client-side verification automated)
- Setup: DM stream in progress at turnSequence = 4. Server closed before dm:done fires. Partial dm:delta events already broadcast.
- Expected: In-flight Ollama call is abandoned. Clients detect close and begin backoff reconnect. Server restarts, re-reads .md (last persisted state = turn 3, turnSequence = 3). Clients reconnect and receive session:state with turnSequence = 3. Client adopt() accepts server state. Partial DM message is discarded. Next action succeeds.
- Pass gate: All clients show turnSequence = 3 (not 4); partial message not visible; next turn succeeds; no message duplication.

**SCENARIO-EDGE-12 -- Server restart when room is idle**
- Automation: YES (in-process server.close() + createSyncServer restart)
- Setup: 3-player session, no active Ollama call. Server restarts. All clients reconnect.
- Expected: Full session:state served from .md. Game resumes. No data loss. turnSequence unchanged.
- Pass gate: Client states after reconnect are equivalent to pre-restart state across messages, party, phase, turnSequence.

### 3.7 Mid-Combat Arrival

**SCENARIO-EDGE-13 -- Late-joining player during active combat**
- Automation: PARTIAL (join flow automated; DM narrative for party addition needs manual validation)
- Setup: 2-player session in COMBAT phase at turnSequence = 5. Third player joins with a new display name not in the party array.
- Expected: Server accepts the join (pending state). New client receives session:state with phase: combat. Input is disabled (not active member, not in party). presence:update shows 3 connected players. No disruption to the ongoing combat turn.
- Pass gate: Combat turnSequence unchanged; existing clients unaffected; new client shows combat HUD with input disabled.

---

## 4. Quality Gates

All gates must pass before G3 sign-off. Thresholds are bound directly to PRD section 5 success criteria.

### QG-01 -- Join Time (PRD 5.1: join under 3 s)

- **Metric:** Elapsed time from WebSocket join message sent to session:state fully received.
- **Threshold:** p95 under 3000 ms on a local LAN.
- **Measurement:** Automated in SCENARIO-CON-01 through CON-04; timestamp join send and session:state receipt.
- **Pass:** p95 under 3000 ms across 20 test runs with 2-5 clients.
- **Fail:** Any run where session:state is not received within 3000 ms; or any client not fully hydrated.

### QG-02 -- Message Propagation (PRD 5.1: propagation under 500 ms)

- **Metric:** Time from a client sending an action event to all other clients receiving the first dm:delta.
- **Threshold:** p99 under 500 ms on LAN.
- **Measurement:** Automated in SCENARIO-CON-01, SCENARIO-CON-04.
- **Pass:** p99 under 500 ms across all 2-5 player scenarios.
- **Fail:** Any client where the first dm:delta arrives more than 500 ms after the action was sent.

### QG-03 -- Turn-State Sync (PRD 5.1: isActive flip under 500 ms)

- **Metric:** Time from dm:done broadcast to all clients reflecting the updated isActive state in their HUD.
- **Threshold:** p99 under 500 ms.
- **Measurement:** Automated in SCENARIO-CON-03, SCENARIO-EDGE-01.
- **Pass:** All clients show updated active member within 500 ms in all test runs.
- **Fail:** Any client shows stale isActive more than 500 ms after dm:done.

### QG-04 -- Zero DM Double-Output (PRD 5.2: zero instances)

- **Metric:** Count of concurrent (overlapping) Ollama calls within a single room across all test scenarios.
- **Threshold:** 0 concurrent calls permitted.
- **Measurement:** Mock-Ollama request counter in SCENARIO-CON-02, SCENARIO-EDGE-01, EDGE-02, EDGE-07, EDGE-09.
- **Pass:** Zero overlapping Ollama calls in every scenario.
- **Fail:** Any scenario where mock-Ollama receives two calls whose time windows overlap.

### QG-05 -- Party State Convergence (PRD 5.2: convergence within 60 s)

- **Metric:** Diff between all clients party arrays after 60 s of no new updates.
- **Threshold:** Zero diff (all clients identical).
- **Measurement:** Automated across all multi-client scenarios. After each final turn, wait 65 s then compare.
- **Pass:** All clients party arrays (canonical JSON) are identical.
- **Fail:** Any two clients with differing party arrays after 60 s quiet period.

### QG-06 -- Combat Turn Transition (PRD 5.3: under 1 s after dm:done)

- **Metric:** Time from dm:done reception to UI rendering the new active player input as enabled.
- **Threshold:** under 1000 ms.
- **Measurement:** Automated in SCENARIO-CON-03, SCENARIO-EDGE-01, SCENARIO-EDGE-04.
- **Pass:** All clients transition input enabled/disabled state within 1000 ms of dm:done.
- **Fail:** Any client still displaying the previous active player input as enabled more than 1000 ms after dm:done.

### QG-07 -- .md Round-Trip Fidelity (PRD 5.4 / R3)

- **Metric:** Fields preserved through toMarkdown -> fromMarkdown -> deserializeSession.
- **Threshold:** Lossless round-trip for all persisted fields including v2 fields (phase, roomCode, turnSequence). Ephemeral fields (connections, dmClientId) must NOT appear in the .md.
- **Measurement:** Unit tests in src/lib/session.test.js (SCENARIO-COMPAT-01 through COMPAT-05).
- **Pass:** Deserialized payload equals serialized input for all persisted fields across v1 and v2 payloads.
- **Fail:** Any field mismatch; null returned; schema version rejection; ephemeral field in .md output.

### QG-08 -- Single-Player Regression (PRD 5.6 / R2)

- **Metric:** Count of Vitest test failures in the full 274-test suite after multiplayer code is merged.
- **Threshold:** Zero regressions (274 tests remain green; test count must not decrease).
- **Measurement:** npm test -- --run after V1. Verify: localStorage path, 30s poll resumption, M7 gate, 9999 sentinel, direct Ollama fetch when connectionCount equals 1.
- **Pass:** Exit code 0; all 274 pre-existing tests green; no new SKIP or TODO masking failures.
- **Fail:** Any pre-existing test fails; any previously-passing test now skipped without justification.

### QG-09 -- No Split-Brain After Reconnect (PRD 5.2)

- **Metric:** State diff between a reconnected client and the server authoritative state after session:state adoption.
- **Threshold:** Zero diff.
- **Measurement:** Automated in SCENARIO-EDGE-05.
- **Pass:** Client state equals server state within one RTT after session:state adoption.
- **Fail:** Any field where client retains a value from before the disconnect rather than the server current value.

### QG-10 -- Server Failure Recovery (PRD 5.4)

- **Metric:** Client state after server restart compared to last persisted .md state; time to re-sync.
- **Threshold:** Re-sync within 60 s; state matches last .md-persisted turn.
- **Measurement:** Automated in SCENARIO-EDGE-12, SCENARIO-EDGE-11.
- **Pass:** All clients re-sync to the last .md state within 60 s; no data loss for completed turns; partial in-flight turn discarded.
- **Fail:** Any client remains disconnected more than 60 s after server restart; any completed turn data missing.

### QG-11 -- Input Validation and Error Silence (PRD 5.5)

- **Metric:** Count of unhandled exceptions, process crashes, or user-visible cryptic errors on malformed WebSocket messages.
- **Threshold:** Zero crashes; zero unhandled rejections; zero raw stack traces in UI.
- **Measurement:** Automated -- send malformed JSON, oversized payloads, invalid roomCode, empty displayName, spoofed turnSequence, unknown message types.
- **Pass:** Server stays alive; clients receive at most a clean error envelope; no UI crash; no React error boundary trigger.
- **Fail:** Server process exits; unhandledRejection fires; React error boundary catches a thrown error from WebSocket handling.

---

## 5. Traceability Map

### 5.1 PRD Section 5 Success Criteria -- QA Scenarios

| PRD Criterion | Quality Gate | Primary Scenarios | Supplementary Scenarios |
|---------------|-------------|-------------------|-------------------------|
| Join under 3 s (5.1) | QG-01 | SCENARIO-CON-01, CON-04 | SCENARIO-EDGE-05, EDGE-06 |
| Rejoin under 3 s (5.1) | QG-01 | SCENARIO-EDGE-04, EDGE-05 | SCENARIO-EDGE-06 |
| Message propagation under 500 ms (5.1) | QG-02 | SCENARIO-CON-01, CON-04 | SCENARIO-CON-05 |
| Turn-state sync under 500 ms (5.1) | QG-03 | SCENARIO-CON-03, EDGE-01 | SCENARIO-EDGE-04 |
| No DM double-output (5.2) | QG-04 | SCENARIO-EDGE-01, EDGE-02, EDGE-07 | SCENARIO-CON-02, CON-05 |
| Message order preserved (5.2) | QG-04, QG-05 | SCENARIO-CON-04 | SCENARIO-CON-01, CON-05 |
| Party state convergence 60 s (5.2) | QG-05 | All multi-client scenarios | -- |
| No split-brain (5.2) | QG-09 | SCENARIO-EDGE-05, EDGE-11 | SCENARIO-EDGE-06 |
| 2-5 concurrent players (5.3) | QG-01, QG-02, QG-03 | SCENARIO-CON-02, CON-03, CON-04 | SCENARIO-EDGE-13 |
| Simultaneous actions queued (5.3) | QG-04 | SCENARIO-EDGE-02, CON-05 | SCENARIO-CON-02 |
| Combat turn transition under 1 s (5.3) | QG-06 | SCENARIO-CON-03, EDGE-01 | SCENARIO-EDGE-04 |
| .md save/continue unbroken (5.4) | QG-07 | SCENARIO-COMPAT-01 through COMPAT-06 | SCENARIO-EDGE-06, EDGE-11 |
| Disconnect recovery (5.4) | QG-09, QG-10 | SCENARIO-EDGE-03, EDGE-04, EDGE-05 | SCENARIO-EDGE-11 |
| Server failure to localStorage (5.4) | QG-10 | SCENARIO-EDGE-06, EDGE-11, EDGE-12 | -- |
| Join flow under 30 s UX (5.5) | QG-01 | SCENARIO-MANUAL-01 | -- |
| Combat clarity UX (5.5) | AC-CB-03, AC-CB-04 | SCENARIO-MANUAL-02 | SCENARIO-CON-03 |
| Error silence (5.5) | QG-11 | SCENARIO-EDGE-09, EDGE-10 | SCENARIO-EDGE-07 |
| Single-player survival (5.6) | QG-08 | SCENARIO-COMPAT-07 through COMPAT-09 | Full 274-test suite |
| .md handoff across versions (5.6) | QG-07 | SCENARIO-COMPAT-01 through COMPAT-06 | -- |

### 5.2 Architecture Section 8 Failure Modes -- QA Scenarios

| Failure Mode | Architecture Mitigation | QA Scenarios | Quality Gate |
|-------------|------------------------|--------------|-------------|
| F1 -- DM double-trigger | Per-room action queue (Promise chain) + DM_BUSY rejection | SCENARIO-EDGE-02, EDGE-07, CON-02 | QG-04 |
| F2 -- Split-brain state | M7 strictly-newer adopt() gate; server-authoritative session:state on reconnect | SCENARIO-EDGE-05, EDGE-11 | QG-09 |
| F3 -- Dropped / rejoin player | close event handler; presence:update; backoff reconnect; join with lastTurnSequence | SCENARIO-EDGE-03, EDGE-04 | QG-10 |
| F4 -- Combat-turn desync | turnSequence gap detection -> full session:state resync | SCENARIO-EDGE-04, EDGE-05 | QG-03, QG-09 |
| F5 -- Ollama mid-stream failure | try/catch on Ollama fetch; dm:done { error: true }; phase reset; lock release | SCENARIO-EDGE-09, EDGE-10 | QG-11, QG-08 |
| F6 -- Server restart with live sessions | Exponential backoff reconnect; .md store survives restart; join re-reads .md | SCENARIO-EDGE-06, EDGE-11, EDGE-12 | QG-10, QG-07 |
| F7 -- Two players on same combat turn | Server checks phase + displayName match before accepting; NOT_YOUR_TURN on invalid sender | SCENARIO-EDGE-01, SCENARIO-CON-03 | QG-04, QG-03 |

### 5.3 Risk Register R1-R5 -- QA Scenarios

| Risk | Primary Verification | QA Scenarios |
|------|---------------------|--------------|
| R1 -- DM double-trigger / concurrency | QG-04 | SCENARIO-EDGE-01, EDGE-02, EDGE-07, CON-02 |
| R2 -- Sync-layer migration | QG-08 | SCENARIO-COMPAT-07 through COMPAT-09; full 274-test run |
| R3 -- .md handoff preservation | QG-07 | SCENARIO-COMPAT-01 through COMPAT-06 |
| R4 -- LAN-only / no-auth security | QG-11 | SCENARIO-EDGE-13 (name collision); SCENARIO-MANUAL-03 |
| R5 -- Combat-turn desync | QG-03, QG-06 | SCENARIO-EDGE-01, SCENARIO-CON-03, SCENARIO-EDGE-04 |

---

## 6. Backward-Compatibility and .md Preservation Tests

These scenarios verify multiplayer v1 does not regress single-player or break .md save/continue (R3, PRD 5.6, ORCHESTRATION section 1 non-goal).

### 6.1 Schema Version Backward Compatibility

**SCENARIO-COMPAT-01 -- v1 .md file loads in v2 app**
- Automation: YES (unit test; extend src/lib/session.test.js)
- Input: A v1 serialized payload (schemaVersion: 1; no phase, roomCode, turnSequence fields).
- Action: Call deserializeSession(v1Payload).
- Expected: Returns a valid payload with phase: free-roam, roomCode: null, turnSequence: 0 (v1-compat defaults).
- Pass gate: No null return; no thrown error; all v1 fields preserved verbatim; v2 defaults correctly filled.

**SCENARIO-COMPAT-02 -- v2 payload round-trips through toMarkdown/fromMarkdown**
- Automation: YES (unit test)
- Input: A v2 serialized payload with phase: combat, roomCode: dnd-a1b2c3d4, turnSequence: 7.
- Action: toMarkdown(payload) -> fromMarkdown(mdString) -> deserializeSession(result.session).
- Expected: phase, roomCode, turnSequence are preserved in the session block and correctly restored.
- Pass gate: Restored payload equals input on all persisted fields.

**SCENARIO-COMPAT-03 -- v2 .md loaded by single-player client**
- Automation: YES (unit test + jsdom integration)
- Input: A .md file saved from a multiplayer session (contains phase: combat, roomCode: dnd-a1b2c3d4, turnSequence: 7).
- Action: Single-player client loads the file via the setup screen Load .md file path.
- Expected: App boots into play. phase gracefully defaults to free-roam for single-player mode. roomCode is present as metadata but does not trigger a WebSocket connection attempt. turnSequence is loaded but the polling path resumes from current savedAt.
- Pass gate: App renders Chat component with restored session; no WebSocket connection initiated in single-player mode; no thrown error.

**SCENARIO-COMPAT-04 -- v1 .md saved from single-player loads in multiplayer session**
- Automation: YES (unit test + jsdom)
- Input: A v1 .md file (no phase/roomCode fields in the session block).
- Action: Host loads the .md on the multiplayer setup screen.
- Expected: fromMarkdown returns the session with v1-compat defaults. App launches normally. If a second player joins, the server accepts the session and broadcasts state.
- Pass gate: deserializeSession returns non-null; session opens in free-roam; no schema-version error.

**SCENARIO-COMPAT-05 -- toMarkdown does NOT write ephemeral fields**
- Automation: YES (unit test)
- Input: A v2 payload that includes connections: [...] and dmClientId: ws-xyz (as if serialized from server in-memory state).
- Action: toMarkdown(payload). Parse the output for the strings connections and dmClientId.
- Expected: Neither field appears anywhere in the .md output.
- Pass gate: md output does not include connections or dmClientId as keys.

**SCENARIO-COMPAT-06 -- Multiplayer session .md is loadable from a different machine**
- Automation: PARTIAL (file creation automated; cross-machine load is manual/multi-device)
- Setup: Host saves a .md during a multiplayer session. File is transferred to a second machine. Second machine loads the .md on a fresh browser session.
- Expected: Second machine boots into play with all messages, party state, and turnSequence intact. The roomCode does not trigger an automatic WebSocket join. Host can start a new room with the restored session.
- Pass gate: Session restored correctly; no automatic WebSocket join on file load; host can proceed to play.

### 6.2 Single-Player Regression Scenarios

**SCENARIO-COMPAT-07 -- Single-player: WebSocket unavailable, poll path resumes**
- Automation: YES (node-env; useSessionPersistence hook test)
- Setup: No WebSocket server accepting connections. Client starts a fresh session.
- Expected: WebSocket connection attempt fails. Client falls back to 30s pollSyncSession. Session persists to localStorage. M7 gate and 9999 sentinel are unchanged.
- Pass gate: pollSyncSession interval is started after WebSocket close/error; localStorage is updated on session save; no React error thrown.

**SCENARIO-COMPAT-08 -- Single-player connectionCount equals 1: direct Ollama fetch is used**
- Automation: YES (jsdom; mock WebSocket emitting presence:update with count: 1)
- Setup: Client is connected to WebSocket but is the only client in the room.
- Expected: sendMessage uses the direct Ollama fetch (existing single-player code path), not the WebSocket action event path.
- Pass gate: Mock-Ollama endpoint receives the POST request directly; WebSocket send is NOT called with { type: action }.

**SCENARIO-COMPAT-09 -- Full 274-test suite passes after V1 merge**
- Automation: YES (npm test -- --run)
- Setup: Run the full test suite after V1 implementation is merged.
- Expected: Exit code 0; 274+ tests pass (count may increase with new multiplayer tests; must not decrease).
- Pass gate: Zero failing tests; zero previously-passing tests now skipped or pending without justification; no new unexpected console.error output.

---

## 7. Manual / Multi-Device Verification Scenarios

These scenarios require real network hardware, multiple physical devices, or human subjective assessment.

**SCENARIO-MANUAL-01 -- First-join UX: room code + name flow under 30 s**
- Devices: Host laptop + joining laptop/tablet on the same LAN.
- Steps: Host creates a session and shares the room code or URL. Joining player enters room code + display name and presses join. Timer runs from room code communicated to joining player sees the party strip with their character listed.
- Pass gate: under 30 s elapsed; joining player sees at least 2 messages from the existing log; party strip shows the joining player character name.

**SCENARIO-MANUAL-02 -- Combat HUD clarity: non-active player understands whose turn it is**
- Devices: 3 physical devices on the same LAN.
- Steps: DM triggers combat. A person unfamiliar with the app looks at each non-active client screen without any explanation.
- Pass gate: That person correctly identifies whose turn it is within 10 s of looking at the screen.

**SCENARIO-MANUAL-03 -- Name collision: two players join with the same display name**
- Devices: 2 physical devices.
- Steps: Player A joins as Theron. Player B joins as Theron (same name, same room).
- Expected: Both clients claim the same party slot (LAN-trust model, per PRD section 2.3). No crash. Both client actions are accepted as Theron. No server rejection of either join.
- Pass gate: Session does not crash; server accepts both joins; no error broadcast.

**SCENARIO-MANUAL-04 -- LAN latency measurement on real hardware**
- Devices: 2 physical devices on the same LAN (one wired, one Wi-Fi if possible).
- Steps: Send 20 actions from one device. Measure time from action send to first dm:delta arrival on the second device using browser DevTools Network panel timestamps. Record Ollama response latency separately and subtract it.
- Pass gate: p95 WebSocket propagation latency (excluding Ollama inference time) under 500 ms on real hardware.

---

## 8. Automation Classification Summary

| Category | Count | Automatable in Vitest / Node-env | Manual / Multi-Device |
|----------|-------|----------------------------------|-----------------------|
| Acceptance criteria (section 1) | 18 items | 16 (server-side + React state checks) | 2 (visual/subjective UI) |
| Concurrency scenarios (section 2) | 6 scenarios | 6 | 0 |
| Edge cases (section 3) | 13 scenarios | 9 (fully automatable) | 4 (partial: process restart or multi-device) |
| Quality gates (section 4) | 11 gates | 10 | 1 (MANUAL-04 for real-hardware p95) |
| Backward-compat / .md (section 6) | 9 scenarios | 7 | 2 |
| Manual verification (section 7) | 4 scenarios | 0 | 4 |
| **Total** | **~61** | **~48 (79%)** | **~13 (21%)** |

### Handoff to test-automator

The 48 automatable scenarios require:

1. **Multi-client WebSocket test harness** (Node-env): 2-5 simulated ws clients connecting to a real createSyncServer test instance. Extend the existing pattern in server/sync-server.test.mjs (which already uses a temp dir, listen(0), beforeAll/afterAll lifecycle).
2. **Mock Ollama endpoint** (Node HTTP server): configurable response latency, mid-stream connection-drop injection, and a call counter that records start/end timestamps for overlap detection.
3. **session.test.js extensions**: v1 to v2 deserializeSession compat tests (COMPAT-01 through COMPAT-05).
4. **useSessionPersistence.test.jsx extensions**: WebSocket-suspended-poll behavior and adopt() under WS events (COMPAT-07, COMPAT-08).
5. **Server-restart helper**: Use server.close() + re-createSyncServer in-process for EDGE-06, EDGE-11, EDGE-12 -- avoids OS-level signal handling and keeps tests CI-safe on Windows.

All new tests must run under npm test -- --run (Vitest, no watch). The @vitest-environment node pragma is already established in sync-server.test.mjs and must be applied to any new multi-client harness files.

---

## 9. Phase-by-Phase Test Readiness Mapping

| Build Phase | Phase Goal | QA Gate Scenarios | Must Pass Before Proceeding |
|-------------|-----------|-------------------|---------------------------|
| Phase 0 -- Schema extension | v2 fields, v1 compat | COMPAT-01 through COMPAT-05; QG-07; full 274-test suite (QG-08) | QG-07, QG-08 |
| Phase 1 -- WebSocket transport spike | /ws endpoint, join to session:state | SCENARIO-CON-01 (2-client basic); EDGE-12 (idle restart) | AC-FR-05 (phase broadcast); QG-01 (join latency) |
| Phase 2 -- Server-authoritative state | session:update broadcast; M7 gate via WS | SCENARIO-CON-01, EDGE-05 (reconnect adopt) | QG-09 (no split-brain) |
| Phase 3 -- Single DM trigger | Server-side Ollama; queue serialization | SCENARIO-EDGE-07 (DM_BUSY), CON-05 (queue ordering), EDGE-09 (Ollama failure) | QG-04 (zero double-output); QG-11 |
| Phase 4 -- Free-roam multi-client | All-player input; message sync | SCENARIO-CON-01 through CON-04; COMPAT-07, COMPAT-08 | QG-02 (propagation); QG-05 (convergence); QG-08 |
| Phase 5 -- Combat enforcement | NOT_YOUR_TURN; isActive HUD | SCENARIO-CON-03; EDGE-01, EDGE-02 | AC-CB-01 through AC-CB-07; QG-03; QG-06 |
| Phase 6 -- Presence / disconnect / rejoin | Disconnect detection; backoff; presence | SCENARIO-EDGE-03, EDGE-04, EDGE-11, EDGE-12 | QG-10; MANUAL-01 |
| Phase 7 -- Migration cutover | Single-player identical; .md round-trip | COMPAT-06 through COMPAT-09; full 274-test suite | QG-07; QG-08; QG-09 |

---

## 10. Exit Criteria for G3

The G3 post-validation gate passes when ALL of the following hold:

1. All 11 quality gates (QG-01 through QG-11) are at or within their stated thresholds.
2. All 18 acceptance criteria (AC-FR-01 through AC-DM-04) have a recorded PASS verdict.
3. All 48 automatable scenarios produce green test runs in CI (npm test -- --run exits 0).
4. All 4 manual scenarios (MANUAL-01 through MANUAL-04) have a documented human-verified PASS from at least one real-device run.
5. Zero open critical or high severity defects.
6. SCENARIO-COMPAT-09 specifically: 274+ tests pass with zero regressions.

Any single FAIL triggers defect filing and routes the fix to the implementing code agent for re-run of the impacted scenarios only (not the full suite, unless the fix touches cross-cutting code such as session.js or sync-server.mjs).

---

---

## Post-revision refresh (G2)

This section was added after the D3 architecture review (MC-1..MC-9) and D3b security review (items A..J) were folded into `docs/design/MULTIPLAYER-ARCHITECTURE.md`. It records new and amended QA coverage for the items owned by the QA expert: MC-2, MC-5, MC-8, MC-9, and security items A, B, C, I, J. Existing scenarios (sections 1-10 above) are not deleted or renumbered; cross-links to them are noted inline.

Each subsection follows the same scenario format used throughout: Automation classification, Setup, Steps/Expected, Pass gate, and a Traceability line tying the scenario to its MC/security item and to the PRD success criterion or risk it covers.

---

### G2.1 MC-2 -- Server-side prompt-assembly fidelity

**Revised architecture reference:** section 3.6 (new section). The server-side DM call must reproduce the full `Chat.jsx#sendMessage` pipeline: `buildSystemPrompt(campaign)` via `getGenre(campaign.genre).engine`, `extractEntities(messages)`, the dice-message-to-text transform with `pendingCheck` folding from the `action` envelope, `trimContext([...messages + userMsg])`, and the Ollama `options` block (`num_ctx: 8192`, `num_predict: 900`, `temperature: 0.8`, `top_p: 0.9`, `top_k: 40`, `repeat_penalty: 1.15`, `repeat_last_n: 256`) plus validated `campaign.model`. Leaving any step out produces wrong inference quality or unbounded context growth (security item G).

**Quality gate (new): QG-12 -- Prompt-assembly equivalence**

- **Metric:** The server-assembled Ollama request body as captured by mock-Ollama must contain (a) a system prompt identical to what `buildSystemPrompt(campaign)` + `extractEntities(messages)` would produce for the same session, (b) a messages array whose context-window length is bounded by `trimContext` (no more than the window cap), and (c) an `options` object matching the five values listed above.
- **Threshold:** Zero divergence between server-assembled prompt and a reference prompt assembled by the same genre engine on the same session state. Context window must not exceed the `trimContext` ceiling even when session messages exceed it.
- **Measurement:** SCENARIO-G2-MC2-01 and SCENARIO-G2-MC2-02 below (node-env, mock-Ollama captures full request body).
- **Pass:** Server request body matches reference prompt exactly; trimmed message count equals `trimContext` output length; Ollama `options` block is present with all five values; `model` passes the allowlist pattern.
- **Fail:** Server omits `buildSystemPrompt`, `extractEntities`, or `trimContext`; context window grows unbounded with session length; `options` block absent or partial; invalid `model` string reaches Ollama.
- **Traceability:** MC-2 (arch review section 1.3, section 2.1); security item G (security review section 2.1); PRD 5.2 (no garbled DM output); R1 (DM correctness under load).

**SCENARIO-G2-MC2-01 -- Server prompt matches client-side reference assembly**
- Automation: YES (node-env; mock-Ollama captures full POST body)
- Setup: A two-player room with a known session state: `campaign.genre = 'dnd'`, five messages including two dice messages, one `pendingCheck: { skill: 'Stealth', dc: 14 }` active on the acting client.
- Steps: (1) Client sends an action event with content 'I try to sneak past the guard' and `pendingCheck: { skill: 'Stealth', dc: 14 }`. (2) Mock-Ollama captures the request body. (3) Reference: call `buildSystemPrompt(campaign)` + `extractEntities(messages)` + dice-text transform + `trimContext` locally with the same inputs.
- Expected: The captured `messages` array from mock-Ollama matches the reference array. The `system` string matches. The `pendingCheck` context appears in the most-recent dice line. The `options` object contains all five values.
- Pass gate: Deep equality between captured and reference `messages`; `system` strings identical; `options` keys and values match; `pendingCheck` folded correctly into dice line text.
- Traceability: MC-2; security item G; PRD 5.2; `src/lib/context.js` `buildSystemPrompt`/`extractEntities`/`trimContext`; `src/lib/genres.js` `getGenre`.

**SCENARIO-G2-MC2-02 -- Context window bounded when session exceeds trimContext ceiling**
- Automation: YES (node-env; mock-Ollama captures full POST body)
- Setup: A room whose session has 60 messages (well above the `trimContext` ceiling of 4 system + 18 recent). `campaign.genre = 'dnd'`.
- Steps: (1) Client sends an action. (2) Mock-Ollama captures the request body.
- Expected: The `messages` array in the captured body contains at most the `trimContext` output length. The total does not grow proportionally with session length.
- Pass gate: `messages.length` in captured body equals `trimContext` output for the same inputs; no unbounded growth across 10 repeated sends as the session grows.
- Traceability: MC-2; security item G (section 2.1 "unbounded prompt size / compute DoS"); PRD 5.2 (no latency cliff); `src/lib/context.js` `trimContext`.

**Amendment to existing coverage:** SCENARIO-EDGE-09 and SCENARIO-EDGE-10 (section 3.5) already cover the error-path side of the server DM call. QG-12 above covers the happy-path correctness of the prompt content. The Phase 3 test surface in section 9 should now include SCENARIO-G2-MC2-01 as a must-pass before Phase 4 proceeds.

---

### G2.2 MC-5 -- Single-player to multiplayer mode boundary

The authoritative mode predicate is `wsState === WS_OPEN && roomJoined === true`, where `roomJoined` is set to `true` only on receipt of the first `session:state` event and reset to `false` on WS close, explicit `leave`, or `onNewSession` (revised architecture section 3.7). This closes the two boundary windows identified by the D3 review: (a) WS connected but no `session:state` yet, and (b) second player leaves and `presence:update` count has not yet propagated.

**Quality gate (new): QG-13 -- No dual-path execution across mode flip**

- **Metric:** Count of turns where both the client-side `fetch` to Ollama and a server-side WS `action` are dispatched for the same user input event.
- **Threshold:** Zero dual-path executions across all mode-flip boundary scenarios.
- **Measurement:** SCENARIO-G2-MC5-01 and SCENARIO-G2-MC5-02 below.
- **Pass:** Every user input produces exactly one Ollama call regardless of the mode at input time; the path (client-direct vs server-proxy) is determined by `roomJoined` at the instant of submission, not by `connectionCount` or `wsState` alone.
- **Fail:** Any test run where mock-Ollama receives a direct browser POST and the server also dispatches a WS action for the same turn; or where `turnSequence` advances on the server for a turn the client also processed locally.
- **Traceability:** MC-5 (arch review section 2.2, D3 Folding note); PRD 5.2 (no garbled DM output, no duplicate DM response); R1 (DM double-trigger prevention).

**SCENARIO-G2-MC5-01 -- Action submitted before session:state arrives uses single-player path**
- Automation: YES (jsdom; mock WS that delays `session:state` by 500 ms after the WS `open` event)
- Setup: Client connects a WebSocket. WS `open` fires but `session:state` has not yet arrived (`roomJoined = false`). User submits an action immediately.
- Steps: (1) WS open fires. (2) User input submitted at t+10 ms. (3) `session:state` arrives at t+500 ms.
- Expected: The action submitted at t+10 ms uses the direct Ollama fetch path (single-player). No `{ type: 'action' }` WS message is sent. After `session:state` arrives, subsequent actions use the WS path.
- Pass gate: Mock-Ollama endpoint receives the direct POST; WS `send` is NOT called with `{ type: 'action' }` for the pre-`session:state` submission; after `session:state`, the next submission goes over WS only.
- Traceability: MC-5; section 3.7 `roomJoined` predicate; PRD 5.2; R1.

**SCENARIO-G2-MC5-02 -- Action submitted after second player leaves but before presence:update uses correct path**
- Automation: YES (node-env; two ws clients; second client disconnects; first client submits action before receiving presence:update)
- Setup: Two-player room. Player B disconnects. Player A submits an action within the window before A's client processes the `presence:update` showing count = 1.
- Steps: (1) B's WS is closed server-side via `ws.terminate()`. (2) A sends an action before receiving `presence:update`. (3) Verify which path is used.
- Expected: Because `roomJoined` is still `true` on A's client (WS remains open and A has received `session:state`), A's action goes through the WS server-proxy path. No direct Ollama call from A's browser. No dual-path execution.
- Pass gate: Server receives and processes the WS `action`; mock-Ollama is called by the server exactly once; no direct browser POST to mock-Ollama; `turnSequence` increments by 1 on the server.
- Traceability: MC-5; section 3.7 `roomJoined` reset rule (reset on WS close, NOT on `presence:update`); PRD 5.2; R1.

**Amendment to existing coverage:** SCENARIO-COMPAT-07 and COMPAT-08 (section 6.2) cover the case where the WS is fully disconnected or never connected. The two scenarios above fill the gap at the predicate boundary where `wsState === OPEN` but `roomJoined` is in a transient state. The Phase 3 test surface in section 9 should include SCENARIO-G2-MC5-01 and SCENARIO-G2-MC5-02 as must-pass items before Phase 4.

---

### G2.3 MC-8 -- Ollama hung-stream timeout and recovery

Every server-side Ollama fetch is wrapped in an `AbortController` with a 90-second timeout (revised architecture section 3.5). On expiry: abort the stream, broadcast `dm:done { error: true, partial: fullTextSoFar }`, reset `phase` to the pre-action resting phase, release the per-room queue lock, do NOT increment `turnSequence`, do NOT write to `.md`. This closes chaos experiment EX-3C at the design level.

**Amendment to existing edge cases:** SCENARIO-EDGE-09 covers mid-stream abort (Ollama drops the connection). SCENARIO-EDGE-10 covers connection refused. Neither covers the hung-stream case where the connection stays open but no data arrives. The following scenario fills that gap.

**SCENARIO-G2-MC8-01 -- Ollama hangs indefinitely; room recovers after timeout**
- Automation: YES (node-env; mock Ollama that accepts the connection and holds it open without sending any data)
- Setup: A two-player room in FREE_ROAM. Mock Ollama is configured to accept the POST and hold the connection open indefinitely (no data, no close).
- Steps: (1) Player A sends an action. (2) Server calls mock Ollama; stream begins but no data arrives. (3) Server's AbortController timeout fires. (4) Verify broadcast and state.
- Expected: Server aborts the fetch after the timeout. Broadcasts `dm:done { error: true }` to all clients (no partial text since no data was received). `phase` resets to `free-roam`. Per-room queue lock is released. `turnSequence` is unchanged. No `.md` write occurs for this turn. Player A can immediately resubmit; a new Ollama call fires.
- Pass gate: `dm:done { error: true }` received by both clients within (timeout + 5 s) of action submission; `phase` is `free-roam` after recovery; `turnSequence` delta = 0; mock-Ollama receives exactly one call (the hung one); a second action after recovery fires exactly one new call; no `awaiting-dm` wedge persists; no `.md` file modified for the hung turn.
- Note on CI timing: `OLLAMA_TIMEOUT_MS` should be injectable as an environment constant (default 90,000 ms; overridable to e.g. 2,000 ms in test environments) so this scenario does not introduce a 90-second wall-clock wait in `npm test -- --run`.
- Traceability: MC-8 (arch review section 3.5 must-change; chaos EX-3C); security item E (security review section 2.3 "Queue-wedge: one stalling client freezes the whole room"); PRD 5.4 (server failure recovery); F5 failure mode (section 8 F5 Scenario B).

**Amendment to QG-11:** QG-11's measurement list should include SCENARIO-G2-MC8-01. The hung-stream path was not previously covered by SCENARIO-EDGE-09 or SCENARIO-EDGE-10. The Phase 3 test surface in section 9 should add SCENARIO-G2-MC8-01 as a must-pass before Phase 4.

---

### G2.4 MC-9 -- CI latency smoke (upper-bound propagation gate)

The D3 review's Folding note (end of section 4 of the arch review) requires a CI-side upper-bound smoke so a gross regression is caught automatically, distinct from the precise manual measurement (SCENARIO-MANUAL-04 / QG-02). The architecture section 7 Phase 4 names this as a test surface requirement.

**Quality gate (new): QG-14 -- CI propagation smoke**

- **Metric:** Time from a client sending an `action` event to all other clients in the same room receiving the first `dm:delta`, measured on loopback (`localhost`).
- **Threshold:** p95 under 2000 ms on loopback in the CI/test environment. (This is a generous bound to avoid false positives from test infrastructure variance; the precise 500 ms target lives in QG-02/MANUAL-04 on real LAN hardware.)
- **Measurement:** SCENARIO-G2-MC9-01 below. Run as part of the Phase 4 test surface under `npm test -- --run`.
- **Pass:** p95 propagation on loopback is under 2000 ms across 10 test iterations; no single iteration exceeds 5000 ms.
- **Fail:** Any iteration where the first `dm:delta` on a second client arrives more than 2000 ms after the action was sent on loopback, indicating a gross regression in the WebSocket broadcast path.
- **Relationship to existing gates:** QG-02 (500 ms, real LAN hardware, MANUAL-04) remains the authoritative production quality threshold. QG-14 is a regression backstop only; passing QG-14 does not imply QG-02 passes. Both must pass for G3.
- **Traceability:** MC-9 (arch review section 3, D3 Folding note); PRD 5.1 (propagation under 500 ms -- CI smoke catches gross regressions before manual validation).

**SCENARIO-G2-MC9-01 -- CI propagation smoke: loopback under 2 s**
- Automation: YES (node-env; two simulated ws clients on loopback; mock-Ollama with 0 ms latency)
- Setup: Two ws clients connected to a test server instance on `listen(0)`. Mock Ollama responds immediately with a short `dm:delta` then `dm:done`. Ten iterations.
- Steps: For each of 10 iterations: (1) Record timestamp t0. (2) Client A sends an `action` event. (3) Record timestamp t1 on Client B when it receives the first `dm:delta`. (4) Compute `t1 - t0`.
- Expected: All 10 `t1 - t0` values are under 2000 ms. p95 is under 2000 ms.
- Pass gate: `max(t1 - t0)` under 5000 ms; p95 under 2000 ms; no test iteration times out.
- Note: Mock-Ollama latency is set to 0 ms so the measurement isolates WS fan-out, not inference time.
- Traceability: MC-9; QG-14; PRD 5.1; section 7 Phase 4 test surface.

**Amendment to section 9:** The Phase 4 row's "QA Gate Scenarios" column should now include SCENARIO-G2-MC9-01 and QG-14 as must-pass items before Phase 5 proceeds.

---
### G2.5 Security A -- Forged-block rejection

The server strips `BLOCK_TAGS` fences from inbound `action.content` using `sanitizeActionContent` (applying `STRIP_RE`, the same pattern as `Chat.jsx` L23) before adding the content to the conversation (revised architecture section 3.6, security item A). The server also validates `verdict.roll` against the server-recorded `lastDiceEvent` for the turn; a verdict with no matching server-recorded dice roll is discarded (section 5.4).

**SCENARIO-G2-SEC-A-01 -- Forged party block in action content is stripped and does not alter party state**
- Automation: YES (node-env; mock-Ollama; two ws clients)
- Setup: A two-player room in FREE_ROAM with a known party state: `[{ name: 'Asha', hpPct: 100, isActive: false }]`.
- Steps: (1) Client A sends an action whose `content` field contains a `party` fence with forged data (e.g., `hpPct: 0, isActive: true`). (2) Mock-Ollama returns a normal narrative response with no structured blocks. (3) Check the broadcast `session:update` party state on Client B.
- Expected: The server strips the `party` fence from `action.content` before adding it to the conversation. Mock-Ollama never sees the fence text. The `session:update` broadcast after `dm:done` reflects the party state from the DM's response (unchanged, since mock-Ollama emitted no party block).
- Pass gate: Party state on all clients after the turn equals pre-turn state; `hpPct` for 'Asha' remains 100; `isActive` remains false; mock-Ollama's captured request body does not contain the `party` fence text.
- Traceability: Security item A (security review section 1.1 "Fenced-JSON injection"); section 3.6 `sanitizeActionContent`; PRD 5.2 (no garbled party state); R4 (LAN-only trust boundary).

**SCENARIO-G2-SEC-A-02 -- Forged verdict block does not auto-pass a skill check**
- Automation: YES (node-env; mock-Ollama)
- Setup: A room where no dice action has been sent this turn (`lastDiceEvent = null` on the server).
- Steps: (1) Client A sends an action whose `content` field contains a `verdict` fence claiming a PASS result. (2) Mock-Ollama returns a narrative response that also includes a `verdict` block with the same content. (3) Check whether the `dm:done` processing applies the verdict.
- Expected: The server strips the fence from `action.content`. For the DM-emitted verdict block, the server checks `verdict.roll` against `lastDiceEvent`. Since no dice action was sent this turn, `lastDiceEvent` is null and the verdict is discarded. No PASS verdict is applied to any dice chip.
- Pass gate: No `verdict` update broadcast to clients; no check auto-passes without a matching server-recorded dice event.
- Traceability: Security item A (defense-in-depth: `verdict.roll` validation); section 3.6 `lastDiceEvent` cross-check; PRD 5.2; `server/sync-server.mjs` `lastDiceEvent` field.

**Amendment to QG-11:** The measurement list for QG-11 should include the assertion that action content containing a `party` fence must not alter broadcast/persisted party state. SCENARIO-G2-SEC-A-01 is the authoritative scenario for this assertion.

---

### G2.6 Security B -- XSS prevention for multiplayer strings

Server sanitizes `displayName` on join (trim + strip control chars + strip `<>&"'+ max 64 chars) per revised architecture section 5.2 (security item B) and section 5.4. All multiplayer-introduced strings must render as React text nodes only. The existing `parseMarkdown` escape-first ordering (`Chat.jsx` L64-67) is preserved.

**SCENARIO-G2-SEC-B-01 -- Malicious displayName is sanitized server-side before broadcast**
- Automation: YES (node-env; two ws clients)
- Setup: A room with one connected player (Client A).
- Steps: (1) Client B sends a `join` with `displayName: '<img src=x onerror=alert(1)>'`. (2) Server processes the join. (3) Both clients receive `presence:update`.
- Expected: Server sanitizes the `displayName` via `sanitizeDisplayName` before storing in the connections map and before broadcasting. The sanitized name (with `<`, `>`, `&` stripped) appears in the `presence:update` payload, not the raw HTML string.
- Pass gate: `presence:update` payload contains the sanitized display name; raw `<img>` tag not present anywhere in the broadcast payload; server does not crash.
- Traceability: Security item B (security review section 4.3 "Display-name XSS into other clients"); section 5.2 `sanitizeDisplayName`; PRD 5.5 (error silence); R4.

**SCENARIO-G2-SEC-B-02 -- Malicious displayName renders as inert text in all client UIs**
- Automation: YES (jsdom; React rendering test)
- Setup: Inject a `presence:update` event into a mounted `PartyStrip` or `HistoryPanel` component with `displayName: '<script>alert(1)</script>'` in the connections array.
- Steps: (1) Mount the component with mock WS. (2) Dispatch the `presence:update` event. (3) Inspect the rendered DOM.
- Expected: The rendered DOM contains the literal string as a text node, not as a parsed HTML element. No `<script>` tag appears in the DOM tree. React's text node auto-escaping provides the protection; no `dangerouslySetInnerHTML` is used for display names.
- Pass gate: `document.querySelector('script')` returns null after render; no `dangerouslySetInnerHTML` attribute on any element containing the display name.
- Traceability: Security item B; section 5.4 "all multiplayer-introduced strings render as React text nodes only"; `src/components/PartyStrip.jsx`, `src/components/HistoryPanel.jsx`; PRD 5.5.

---
### G2.7 Security C -- Connection-bound identity enforcement

Turn authorization uses `clients.get(ws).displayName` (the identity bound at join), never any `displayName` field in an incoming `action` message (revised architecture section 4.4, security item C). The `action` envelope does not include `displayName` by design (section 2.4).

**SCENARIO-G2-SEC-C-01 -- Spoofed displayName in action payload is ignored; connection-bound identity is used**
- Automation: YES (node-env; two ws clients)
- Setup: A room in COMBAT phase. Client A joined as 'Theron' (connection-bound). `isActive: true` is set for 'Theron' in the party. Client B joined as 'Mira' (connection-bound).
- Steps: (1) Client B crafts a WS message that includes `displayName: 'Theron'` in the `payload` field. (2) Server processes the message.
- Expected: Server ignores any `displayName` in the payload and uses `clients.get(ws).displayName` which is 'Mira'. Since 'Mira' is not the active member, the action is rejected with `{ code: 'NOT_YOUR_TURN' }`. No Ollama call fires.
- Pass gate: Client B receives `error: NOT_YOUR_TURN`; mock-Ollama receives zero calls; `turnSequence` unchanged; Client A unaffected.
- Traceability: Security item C (security review section 1.3 spoofed membership); section 4.4 connection-bound identity; section 3.6 server prompt assembly; PRD 5.3 (combat turns); F7 failure mode.

---

### G2.8 Security J -- NAME_TAKEN guard and rejoin of disconnected slot

The server checks on join whether the normalized `displayName` is already bound to an active (non-closed) connection (revised architecture section 5.2, security item J). If so, it rejects with `{ code: 'NAME_TAKEN' }`. A disconnected slot (CLOSED socket) is available for the rejoining client to claim.

**SCENARIO-G2-SEC-J-01 -- Second live connection claiming an active player's name is rejected**
- Automation: YES (node-env; two ws clients)
- Setup: Client A has joined with `displayName = 'Aldric'` and is connected (socket OPEN).
- Steps: (1) Client B sends a `join` with `displayName = 'Aldric'` to the same room. (2) Server processes the join attempt.
- Expected: Server finds 'Aldric' is already bound to an OPEN socket (Client A). Server rejects with `{ type: 'error', code: 'NAME_TAKEN' }`. Client B does not receive `session:state`. Client A is unaffected.
- Pass gate: Client B receives `{ code: 'NAME_TAKEN' }`; Client B does NOT receive `session:state`; `presence:update` is NOT broadcast for a new join; room `clients` map still has exactly one entry.
- Traceability: Security item J (security review section 1.2 party-slot hijack); section 5.2 `NAME_TAKEN` guard; PRD 5.5 (error silence); R4.

**SCENARIO-G2-SEC-J-02 -- Rejoin of disconnected slot succeeds; NAME_TAKEN is not triggered**
- Automation: YES (node-env; ws client with forced disconnect then reconnect)
- Setup: Client A joins as 'Aldric' and then disconnects (server-side `ws.terminate()`). The connections map entry for 'Aldric' now has a CLOSED socket.
- Steps: (1) Client A reconnects with a new WS and sends a `join` with `displayName = 'Aldric'` and `lastTurnSequence = N`. (2) Server processes the rejoin.
- Expected: Server finds the 'Aldric' slot with a CLOSED socket. The name is NOT rejected as NAME_TAKEN. Server replaces the closed connection, sends `session:state`, and broadcasts `presence:update` showing 'Aldric' reconnected.
- Pass gate: Client A receives `session:state` (not a `NAME_TAKEN` error); `turnSequence` in `session:state` matches the server current value; behavior is consistent with SCENARIO-EDGE-04.
- Traceability: Security item J; section 5.2 rejoin-claims-disconnected-slot case; SCENARIO-EDGE-04 cross-link; PRD 5.4 (disconnect recovery).

---
### G2.9 Security I -- sessionId-keyed .md store; no roomCode-derived filenames

The `.md` store is always keyed by the full `sessionId` (UUID) per revised architecture section 5.1 (security item I) and section 6.3. `roomCode` is resolved to `sessionId` before any `sessionPath()` call. No file named `${roomCode}.md` is ever created.

**SCENARIO-G2-SEC-I-01 -- .md store keyed by sessionId; roomCode never used as filename**
- Automation: YES (node-env; inspect temp sessions directory after join + turn)
- Setup: A test server instance with a temp sessions directory. A client joins with `roomCode = 'dnd-a1b2c3d4'` and a full UUID `sessionId`. After a turn completes and `dm:done` fires, the sessions directory is inspected.
- Steps: (1) Client joins; server processes join. (2) Client sends an action; mock-Ollama responds; `dm:done` fires; server writes `.md`. (3) List all `.md` files in the temp sessions directory.
- Expected: The sessions directory contains exactly one file named by the UUID `sessionId`. No file named `dnd-a1b2c3d4.md` or any `roomCode`-derived name exists.
- Pass gate: `fs.readdirSync(sessionsDir)` returns only UUID-format filenames; no `dnd-*.md` file present; the file's content is valid `toMarkdown` output with the correct `sessionId`.
- Traceability: Security item I (security review section 4.1 room-code-derived filenames); section 5.1 path-safety invariant; section 6.3 path-safety; `server/sync-server.mjs` `sessionPath()` / `ID_RE`; PRD 5.4 (.md round-trip fidelity).

**SCENARIO-G2-SEC-I-02 -- Two rooms with colliding short roomCode prefixes do not cross-read state**
- Automation: YES (node-env; two concurrent room sessions in the same temp directory)
- Setup: Two sessions exist in the temp directory with distinct `sessionId` values but similarly-prefixed `roomCode` values (e.g., both start with 'dnd-aabb').
- Steps: (1) Client for Room X joins using Room X's `roomCode`; server resolves to Room X's `sessionId`. (2) Server reads `sessionPath(sessionId_X)`. (3) Verify the content served is Room X's session, not Room Y's.
- Expected: `sessionPath` is derived from the full `sessionId` resolved at join time. The two rooms' files are distinct. No cross-read occurs regardless of how similar the `roomCode` values are.
- Pass gate: The `session:state` sent to Room X's client contains Room X's `campaign.name` and `messages`; Room Y's data is not present; both `.md` files exist independently in the sessions directory.
- Traceability: Security item I; section 5.1 `roomCode -> sessionId` resolution; section 6.3 path-safety; PRD 5.4; R3 (.md preservation).

---

### G2.10 Traceability supplement for G2 scenarios

The following table maps each new G2 scenario to its originating MC/security item, the revised architecture section, and the PRD success criterion or risk it covers. All new scenarios run under `npm test -- --run` (Vitest, node-env or jsdom as noted) and do not require multi-device hardware.

| Scenario | MC / Security item | Arch section | PRD criterion / Risk |
|----------|-------------------|-------------|----------------------|
| SCENARIO-G2-MC2-01 | MC-2 | section 3.6 | PRD 5.2 (no garbled DM output); R1 |
| SCENARIO-G2-MC2-02 | MC-2; security item G | section 3.6, section 5.4 | PRD 5.2 (no latency cliff); security section 2.1 |
| QG-12 (prompt-assembly equivalence) | MC-2; security item G | section 3.6 | PRD 5.2; R1 |
| SCENARIO-G2-MC5-01 | MC-5 | section 3.7 | PRD 5.2 (no duplicate DM); R1 |
| SCENARIO-G2-MC5-02 | MC-5 | section 3.7 | PRD 5.2; R1 |
| QG-13 (no dual-path execution) | MC-5 | section 3.7 | PRD 5.2; R1 |
| SCENARIO-G2-MC8-01 | MC-8; security item E | section 3.5 | PRD 5.4 (server failure recovery); F5; security section 2.3 |
| SCENARIO-G2-MC9-01 | MC-9 | section 7 Phase 4 | PRD 5.1 (propagation < 500 ms -- CI backstop) |
| QG-14 (CI propagation smoke) | MC-9 | section 7 Phase 4 | PRD 5.1; D3 Folding note |
| SCENARIO-G2-SEC-A-01 | Security item A | section 3.6, section 5.4 | PRD 5.2; R4; security section 1.1 |
| SCENARIO-G2-SEC-A-02 | Security item A | section 3.6 lastDiceEvent | PRD 5.2; security section 1.1 defense-in-depth |
| SCENARIO-G2-SEC-B-01 | Security item B | section 5.2, section 5.4 | PRD 5.5; R4; security section 4.3 |
| SCENARIO-G2-SEC-B-02 | Security item B | section 5.4 React text nodes | PRD 5.5; security section 4.3 |
| SCENARIO-G2-SEC-C-01 | Security item C | section 4.4, section 3.6 | PRD 5.3 (combat turns); F7; security section 1.3 |
| SCENARIO-G2-SEC-J-01 | Security item J | section 5.2 NAME_TAKEN | PRD 5.5; R4; security section 1.2 |
| SCENARIO-G2-SEC-J-02 | Security item J | section 5.2 rejoin | PRD 5.4 (disconnect recovery); EDGE-04 cross-link |
| SCENARIO-G2-SEC-I-01 | Security item I | section 5.1, section 6.3 | PRD 5.4 (.md fidelity); security section 4.1 |
| SCENARIO-G2-SEC-I-02 | Security item I | section 5.1, section 6.3 | PRD 5.4; R3; security section 4.1 |

**Updated automation count for G2:**

| Category | New items | Automatable | Manual / Multi-device |
|----------|-----------|-------------|----------------------|
| New quality gates (QG-12, QG-13, QG-14) | 3 | 3 | 0 |
| New scenarios (G2 section) | 15 | 15 | 0 |
| G2 subtotal | 18 | 18 (100%) | 0 |

Cumulative totals (sections 1-10 plus G2): 14 quality gates (QG-01..QG-14), approximately 63 automatable scenarios, approximately 13 manual / multi-device scenarios, approximately 79 total items.

**G3 exit criteria amendment (amends section 10):** Item 1 extends to "All 14 quality gates (QG-01 through QG-14) are at or within their stated thresholds." Item 3 extends to "All automatable scenarios including G2 produce green test runs in CI." All other G3 exit criteria in section 10 remain unchanged.


## References

- MULTIPLAYER-ARCHITECTURE.md (H:Claudednd-claudedocsdesign) -- section 4 (state machine), section 7 (phases), section 8 (failure modes)
- MULTIPLAYER-PRD.md (H:Claudednd-claudedocsdesign) -- section 5 (success criteria)
- MULTIPLAYER-ORCHESTRATION.md (H:Claudednd-claudedocsdesign) -- section 3.2 (test-readiness work order), section 5 (risk register)
- sync-server.test.mjs (H:Claudednd-claudeserver) -- existing node-env server test pattern to extend
- session.test.js (H:Claudednd-claudesrclib) -- existing schema/round-trip unit tests to extend
- useSessionPersistence.test.jsx (H:Claudednd-claudesrchooks) -- existing hook tests for M7 gate coverage
