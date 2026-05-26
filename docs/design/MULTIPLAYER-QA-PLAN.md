# Multiplayer QA Plan -- D&D Campaign Assistant

> **Owner:** qa-expert (D2-qa)
> **Inputs:** MULTIPLAYER-ARCHITECTURE.md (section 4 state machine, section 7 phased build, section 8 failure modes F1-F7);
> MULTIPLAYER-PRD.md (section 5 success criteria); MULTIPLAYER-ORCHESTRATION.md section 3.2 + section 5 risk register R1-R5.
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

## References

- MULTIPLAYER-ARCHITECTURE.md (H:Claudednd-claudedocsdesign) -- section 4 (state machine), section 7 (phases), section 8 (failure modes)
- MULTIPLAYER-PRD.md (H:Claudednd-claudedocsdesign) -- section 5 (success criteria)
- MULTIPLAYER-ORCHESTRATION.md (H:Claudednd-claudedocsdesign) -- section 3.2 (test-readiness work order), section 5 (risk register)
- sync-server.test.mjs (H:Claudednd-claudeserver) -- existing node-env server test pattern to extend
- session.test.js (H:Claudednd-claudesrclib) -- existing schema/round-trip unit tests to extend
- useSessionPersistence.test.jsx (H:Claudednd-claudesrchooks) -- existing hook tests for M7 gate coverage
