# 4-Player Endurance Protocol: "How Long Can a 4-Player Campaign Run Before It Degrades?"

**Target app:** `H:\Claude\dnd-claude\` — React+Vite D&D Assistant, **full multiplayer server path**
**Server under test:** `server/sync-server.mjs` (`createSyncServer`) driven via **real WebSocket clients**
**Model:** `qwen2.5:14b` via the SERVER-side Ollama proxy (`OLLAMA_HOST`, default `http://localhost:11434`)
**Hardware:** RTX 3070-class, 8GB VRAM, 16GB RAM, **single GPU → all Ollama-bound work serializes**
**Extends:** `stress-test/PROTOCOL.md` (reuse its anchor roster, category model, substring scoring). This document is the multiplayer superset; where it is silent, PROTOCOL.md governs.

---

## 0. The Question, Made Precise

`trimContext` caps the prompt at **22 messages** (`pinned=4 + recent=18`) regardless of campaign length (`src/lib/context.js` L334-337). Compute per DM turn is therefore **bounded and flat** — "how long" is **NOT** a throughput-ceiling question. The real ceilings, in priority order:

1. **Continuity quality (primary).** 4 players share ONE 18-message recent window. Each player's own turns scroll out of the window ~4× faster than single-player, so an individual player's established facts drift in far fewer *rounds*. Category-B (entity-digest-only) recall is the canary.
2. **localStorage quota (secondary).** `serializeSession` (`src/lib/session.js` L332-349) persists the FULL message history. The serialized byte size grows linearly with rounds; a real browser caps `dnd_session` at ~5 MB → eventual `QuotaExceededError`. The harness measures the proxy bytes per round.
3. **Server room memory (secondary).** The in-memory `rooms` Map holds `room.messages` = full untrimmed history per room (`sync-server.mjs` L714, L772-775). Grows linearly; measured as a proxy for long-uptime server RSS.

The deliverable answer is a single **headline number of rounds** plus the **limiting factor** that produced it (§4.6).

---

## 1. The 4-Player Round Model

### 1.1 Definitions (bookkeeping — implement exactly)

- **Player.** One simulated WS client with a distinct `displayName`. Roster (fixed):
  `Kael` (Fighter), `Lyra` (Wizard), `Bron` (Cleric), `Sora` (Rogue).
- **Turn.** One `action` WS message from one player → exactly one server-side DM response (`dm:delta*` then `dm:done`). The harness sends a turn only after the previous turn's `dm:done` (or `dm:done{error}`) arrives — actions are strictly serialized to respect the single GPU and the server's `dmBusy`/`actionQueue` gate.
- **Round.** Exactly **4 player turns** in fixed roster order `Kael → Lyra → Bron → Sora`, plus the 4 DM responses they trigger. `round = ceil(turnIndex / 4)`; `turnInRound = ((turnIndex - 1) % 4) + 1`. The acting player of turn `t` is `ROSTER[(t-1) % 4]`.
- **Dice turn.** A turn whose `action` payload is `{ type:'dice', content:'[Dice roll: dN → r]' }`. The server stores it as `role:'dice'` and records `room.lastDiceEvent` (L549-560). Dice turns still occupy a turn slot, still trigger a DM response, still advance `turnSequence`. They count toward the round.
- **Probe turn.** A normal `type:'user'` action whose content is an out-of-character recall question. It occupies a real turn slot (advances history + trim window) and is scored. Probes are owned by a specific player (the one whose roster slot the probe lands on) so attribution is realistic.
- **`turnSequence`.** Server-authoritative monotonic counter (`sync-server.mjs` L778). Incremented by exactly 1 per successful DM turn; NOT incremented on a `dm:done{error}` turn. This is the harness's freshness proxy and round-boundary check.

### 1.2 Party block & `isActive` cycling

The DM is required to emit a `party` block every response (`context.js` L42). The room phase is derived purely from it: any member with `isActive:true` → `combat`, else `free-roam` (`sync-server.mjs` L769). In `combat`, ONLY the connection-bound active player may act; a non-active player's action is rejected with `NOT_YOUR_TURN` (L451-457).

**Design decision — run in `free-roam` for the endurance run.** Because the DM's `isActive` assignment is non-deterministic, forcing strict combat turn-order would create spurious `NOT_YOUR_TURN` rejections that confound the continuity measurement. The scripted player actions are all exploration/social/skill actions that keep the party out of combat; the expected steady state is `free-roam` (no member `isActive`), where any player may act in roster order. The harness MUST:
- Assert `phase === 'free-roam'` in each `session:update`/`dm:done`. If the DM enters `combat` (sets an `isActive`), log a `PHASE_DRIFT` event with round/turn, and on the NEXT turn, if the active player is NOT the roster's scheduled player, the harness sends the action AS the active player (read from the party block) for that one turn, then resumes roster order. This keeps the run alive without masking the event.
- Maintain a **4-member party expectation**: every `party` block parsed from `dm:done` should contain all 4 roster names. Log a `PARTY_SHRINK` event whenever fewer than 4 distinct roster names appear (a continuity-degradation signal in its own right).

### 1.3 Join model

All 4 clients join ONE room before turn 1:
- `sessionId` = a fixed UUID minted once per run (e.g. `crypto.randomUUID()`), reused by all 4 clients.
- `roomCode` = `makeRoomCode(sessionId)` (`session.js` L45) — all clients send the same code.
- Each client sends its own `displayName` and a distinct `joinCharacter` (SyncedCharacter; see §1.4). Join order is roster order. The harness awaits each client's `session:state` before sending the next join, and awaits the final `presence:update` showing 4 `connected` clients before turn 1.

### 1.4 Join characters (drive `buildPlayerSection`)

Each client sends a `joinCharacter` so the server's prompt carries a real "Player Characters:" section (`session.js` L242-265, capped at 5 players / 1000 bytes; 4 players fits comfortably). Fixed sheets:

| displayName | name | class | race | AC | hpMax | notable abilities |
|-------------|------|-------|------|----|-------|-------------------|
| Kael | Kael | Fighter | Human | 18 | 30 | STR 16, CON 15 |
| Lyra | Lyra | Wizard | Elf | 12 | 18 | INT 17, DEX 14 |
| Bron | Bron | Cleric | Dwarf | 16 | 26 | WIS 16, CON 14 |
| Sora | Sora | Rogue | Halfling | 14 | 22 | DEX 17, CHA 13 |

These names MUST match the party-block names the DM is steered to use (the scripted turns name them), so `buildPlayersForPrompt` (`session.js` L272-321) matches characters → party rows by normalized name.

---

## 2. MP-Server Simulation Contract

### 2.1 Wire protocol (exact sequence — mirror `useWebSocket.js`)

The harness clients speak the EXACT client→server wire shape (`useWebSocket.js` L113-123):

**Join (per client, once):**
```json
{ "type":"join", "roomCode":"dnd-xxxxxxxx", "sessionId":"<uuid>",
  "displayName":"Kael", "lastTurnSequence":0, "joinCharacter":{...} }
```
Wait for `session:state` (full snapshot) addressed to this socket, and for `presence:update` listing all joined clients.

**Action (one per turn):**
```json
{ "type":"action", "roomCode":"dnd-xxxxxxxx",
  "payload":{ "type":"user", "content":"<turn text>", "pendingCheck":null } }
```
Dice turn payload:
```json
{ "type":"action", "roomCode":"dnd-xxxxxxxx",
  "payload":{ "type":"dice", "content":"[Dice roll: d20 → 14]" } }
```
`pendingCheck` (when a prior DM `check` block requested a roll) is `{ "skill":"STEALTH", "dc":15 }` on the dice turn that answers it (folded into the prompt at L616-639).

**Consume (per turn, until `dm:done`):**
- `session:update` with `phase:'awaiting-dm'` (the lock broadcast, L513-523) — record as the DM-start marker.
- zero or more `dm:delta` `{ delta, assistantId, turnSequence }` — accumulate `fullText` (this is the un-stripped text incl. structured blocks; the harness parses party/check/verdict from it identically to the server for cross-checking, but SCORING uses the same `fullText`).
- `dm:done` `{ fullText, turnSequence }` (success) OR `{ error:true, partial }` (failure).
- final `session:update` with the resting phase + new `turnSequence` + full `messages`/`party` (L788-798). Use THIS message's `messages` array length and `party` for memory/round bookkeeping.

**Ping:** send `{ "type":"ping" }` on a 20s heartbeat per idle client to keep sockets healthy; expect `pong`.

### 2.2 Turn pacing vs. server gates

- The harness sends the next action ONLY after the prior turn's terminal `dm:done`. This guarantees no `DM_BUSY` (L470-478) under normal flow.
- Between consecutive actions on the SAME connection, wait `> ACTION_MIN_INTERVAL_MS` (500 ms, L51/L479-482). Since roster order rotates clients each turn, the same client only acts every 4th turn — naturally far over 500 ms — but the harness MUST still enforce a `>= 600 ms` guard before re-using a connection to be safe.
- If a `RATE_LIMITED` or `DM_BUSY` error arrives, the harness logs it (`SERVER_REJECT` event), waits 1 s, and retries the SAME action once. A second rejection is a hard failure (§3.2).

### 2.3 Extracting per-DM-turn performance metrics — **RECOMMENDED APPROACH**

**Problem:** PROTOCOL.md §4 reads `eval_count`/`eval_duration`/`total_duration` from Ollama's final `done:true` NDJSON line. But in the MP path, the SERVER calls Ollama (L654-708) and **discards** those fields — it only forwards `delta` text in `dm:delta` and `fullText` in `dm:done`. The harness (a WS client) never sees Ollama's metrics.

**Three options evaluated:**

| Option | Fidelity | Effort | Verdict |
|--------|----------|--------|---------|
| (A) Wall-clock only: time from `awaiting-dm` `session:update` → `dm:done`, divide by a token estimate | Low — no true `eval_count`; token est. is noisy | Trivial | Reject as sole source |
| (B) **Instrument the server** behind an env flag to capture Ollama's `done` line and forward `eval_count`/`eval_duration`/`total_duration` inside `dm:done.payload.metrics` | **High — exact same numbers as PROTOCOL.md, measured where Ollama actually runs** | Small, additive, flag-gated | **RECOMMEND** |
| (C) Harness opens its own parallel Ollama connection to re-measure | Wrong — different prompt/timing, double GPU load | Medium | Reject |

**RECOMMENDATION: Option B + wall-clock as a cross-check.**

Add a flag-gated, **non-default, test-only** instrumentation patch to `sync-server.mjs` that is OFF in production:

1. Gate on `process.env.STRESS_METRICS === '1'`.
2. In the NDJSON read loop (L685-708), when `event.done` is true, capture `event.eval_count`, `event.eval_duration`, `event.prompt_eval_count`, `event.total_duration` into local vars.
3. In the success `dm:done` broadcast (L783-787), when the flag is set, add `payload.metrics = { eval_count, eval_duration, prompt_eval_count, total_duration }`.

This is a 3-line additive change, broadcast-shape-compatible (existing clients ignore an extra field), and OFF unless the harness sets the env var. The harness reads `dm:done.payload.metrics` when present; ALWAYS also records wall-clock (`awaiting-dm` start → `dm:done`) as `wall_ms` for cross-validation and as the fallback when metrics are absent.

Test-automator MUST implement this patch as part of Phase 1 and document it in the harness header. `tokens_per_sec = eval_count / (eval_duration/1e9)`; `prompt_eval_ms = (total_duration - eval_duration)/1e6`. Because compute is flat (§0), the metric of interest is *stability across rounds* (does tok/s sag as `num_ctx:8192` fills?), not a 4096-vs-8192 comparison.

### 2.4 Server room-memory growth (proxy for long-uptime RSS)

The harness CANNOT read the server's heap directly without instrumentation. Use these proxies, captured per round:

- **`room_messages_count`** — length of the `messages` array in the final `session:update` of each round (this IS `room.messages`). Grows by ~2 per turn (user/dice + assistant) ≈ ~8/round.
- **`room_messages_bytes`** — `Buffer.byteLength(JSON.stringify(messages))` of that array. This is the direct in-memory history footprint.
- **Optional high-fidelity:** under the same `STRESS_METRICS` flag, have the server append `payload.heapUsedBytes = process.memoryUsage().heapUsed` to each round-final `session:update`. Record it as `server_heap_bytes` when present. (Additive, flag-gated, ignored by prod clients.)

### 2.5 localStorage-quota proxy (`serializeSession` bytes per round)

Per round, the harness reconstructs the client persistence payload and measures it — this is the SAME object `useSessionPersistence` would write to `dnd_session`:
```js
import { serializeSession } from '../src/lib/session.js'
const payload = serializeSession({
  campaign: { ...CAMPAIGN, sessionId },
  messages: lastSessionUpdate.messages,
  sessionLog: [],                       // app derives this; size-negligible here
  party: lastSessionUpdate.party,
  roomCode, phase: lastSessionUpdate.phase, turnSequence: lastSessionUpdate.turnSequence,
  characters: joinCharactersMap,
}, lastSessionUpdate.savedAt)
const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')   // == localStorage cost
```
Record `persist_bytes` per round. The localStorage budget is **`LS_BUDGET = 5_000_000` bytes** (conservative real-browser `dnd_session` ceiling; `QuotaExceededError` is the app's documented trim-and-retry trigger). `turns_to_ls_cap` is extrapolated in §4.3.

---

## 3. Run-to-Failure Policy

### 3.1 Target & cadence

- **Target: 40+ rounds = 160+ player turns** (4 turns/round). The harness keeps running past 40 if no stop condition fires, up to a hard cap of **60 rounds (240 turns)** to bound wall-time.
- **Probe cadence:** a scored probe every **4 rounds** (every 16 turns), starting at round 4, plus a final probe at the last round. Each probe is owned by the roster player whose slot it lands on. Probes test a mix of A (pinned), B (digest-only), and C (recent) anchors so the A≥B and C≥B health relations (PROTOCOL.md §4) can be evaluated round-over-round.
- The opening rounds 1–3 introduce the anchor roster (§3.3) before the first probe.

### 3.2 Stop conditions

The run halts at the FIRST of:

**Soft stop — continuity collapse (the "how long" answer for the primary ceiling):**
- `category_B_accuracy` (running, across all probes scored so far) `< 0.50` AND it stays `< 0.50` for **two consecutive probes** (sustained). Record `rounds_to_B_collapse = round of the first of the two probes`. This is the canonical degradation point (PROTOCOL.md §4 "degraded when category_B_accuracy < 0.50"), hardened with a 2-probe sustain to reject a single noisy probe.

**Hard stops — record the failure mode and halt immediately:**
- **Ollama timeout** — `dm:done{error:true}` whose wall time ≈ `OLLAMA_TIMEOUT_MS` (90 s, L44). Record `OLLAMA_TIMEOUT` + round.
- **num_ctx overflow** — server logs/streams an Ollama error indicating context overflow at `num_ctx:8192`, surfaced as `dm:done{error:true}` with a non-timeout wall time. (Note: trim caps the prompt, so overflow is unlikely; if it appears it is a finding.) Record `NUM_CTX_OVERFLOW` + round + the partial text.
- **Server error** — any `dm:done{error:true}` not classified above, OR a WS close that does not recover within the reconnect window, OR two consecutive `SERVER_REJECT` on the same action (§2.2). Record `SERVER_ERROR` + round + detail.
- **Persistence-size cap** — `persist_bytes >= LS_BUDGET` (5 MB). Record `LOCALSTORAGE_CAP` + round. (Expected only at very high round counts; usually extrapolated rather than reached.)

On a hard stop the harness flushes the JSONL, writes the summary with `stop_reason`, and exits non-zero.

### 3.3 Anchor roster (4-player adaptation of PROTOCOL.md §2)

Each anchor is **introduced and owned by a specific player** (named in that player's scripted turn so the DM bolds it and `extractEntities` captures it). Categories carry over from PROTOCOL.md: A = pinned-opener (survives in `messages[0..3]`), B = digest-only (survives ONLY via `extractEntities`, max=50), C = recent-window.

| ID | Cat | Owner | Fact | Recall string | Introduced (round) |
|----|-----|-------|------|---------------|--------------------|
| A1 | A | Kael | Town: **Ravenmoor** | `Ravenmoor` | R1 |
| A2 | A | Kael | Tavern: **The Broken Lantern** | `Broken Lantern` | R1 |
| A3 | A | Lyra | Quest giver: **Elder Sorcha** | `Sorcha` | R1 |
| A4 | A | Lyra | Artifact: the **Sunstone** | `Sunstone` | R1 |
| B1 | B | Bron | Blacksmith: **Garret Ironhand** | `Garret` | R2 |
| B2 | B | Bron | Shop: **the Forge of Embers** | `Forge of Embers` | R2 |
| B3 | B | Sora | Guard captain: **Captain Vell** | `Vell` | R2 |
| B4 | B | Sora | Guard post: **East Gate barracks** | `East Gate` | R2 |
| B5 | B | Kael | Price paid Mira: **12 gold** | `12 gold` | R3 |
| B6 | B | Lyra | Informant: **Mira the Fence** | `Mira` | R3 |
| B7 | B | Bron | Landmark: the **cracked fountain** | `cracked fountain` | R3 |
| B8 | B | Sora | Rival faction: the **Ash Covenant** | `Ash Covenant` | R3 |

**Per-player ownership matters:** B5 (owned by Kael) failing while B6 (Lyra) holds tells us whether drift is uniform or whether a specific player's facts evict first under the shared window. Track `category_B_accuracy_by_owner` (§4).

Late C-anchors are introduced fresh near each probe so a recent-window control is always available:
| ID | Cat | Owner | Fact | Recall string | Introduced |
|----|-----|-------|------|---------------|------------|
| C(k) | C | rotating | A scene-local landmark/creature named in the turn 1–2 turns before probe `k` | (string) | probe-1−round |

The harness generates C-anchors procedurally: 1–2 turns before each scored probe, the scheduled player names a fresh bolded entity (e.g. "the **Obsidian Stair**"), and the probe tests it as the C control for that probe.

### 3.4 Probe content & scoring

Probe text is out-of-character (PROTOCOL.md style), e.g.:
> "Out of character, **<owner>** asks: remind us — what is the blacksmith's name and his shop, and what did we pay Mira?"

Scoring is unchanged from PROTOCOL.md §4: case-insensitive substring match of each anchor's recall string in the probe's `fullText` → PASS(1)/FAIL(0). Per-anchor results roll up to `probe_accuracy`, `category_accuracy[A|B|C]`, `category_B_accuracy_by_owner`, and `drift_onset` (earliest anchor that flips from a prior PASS to FAIL; report anchor, owner, round, and round-distance from introduction).

### 3.5 Scripted campaign

The harness ships a `SCRIPT_4P` array of `{ round, turnInRound, player, type:'user'|'dice'|'probe', text|die/result, anchors? }`. Rounds 1–3 introduce anchors (§3.3). Rounds 4..N are exploration/social/skill beats (mirroring PROTOCOL.md T10–T58 in tone) with a dice turn roughly every other round and a scored probe every 4th round. The script is deterministic and parameterized by target round count; beyond the last scripted round (if the run continues to the 60-round cap), the harness loops a small pool of generic continue-exploring turns so it can run to failure without authoring 240 unique lines.

---

## 4. Metrics & the "How Long" Criteria

### 4.1 Continuity (primary ceiling)

- `category_accuracy[A|B|C]` cumulative and per-probe.
- `rounds_to_drift_onset` — round of the first anchor PASS→FAIL flip.
- `rounds_to_B_collapse` — round at which the sustained B<0.50 soft-stop fires (§3.2). **This is the primary headline number.**
- `category_B_accuracy_by_owner{Kael,Lyra,Bron,Sora}` — exposes per-player eviction asymmetry.
- `phase_drift_events`, `party_shrink_events` — secondary continuity signals.

### 4.2 Throughput stability (sanity, NOT a ceiling)

- Per non-probe turn: `tokens_per_sec` (from `dm:done.metrics` when present, else wall-clock estimate), `prompt_eval_ms`, `wall_ms`.
- Per-run: mean / p25 / p75 / p95 tok/s, and a **sag check** — linear-fit slope of tok/s vs. round. A significantly negative slope at `num_ctx:8192` is a finding (prompt grows toward the 22-message cap, then plateaus).
- CPU offload: every 10th turn shell `ollama ps` (reuse `getOllamaPs()` from `harness.mjs` L278-295); record first turn CPU involvement appears.

### 4.3 localStorage ceiling (secondary)

- `persist_bytes` per round (§2.5). Fit `bytes_per_round` (linear slope, ignoring the constant campaign/character overhead).
- `turns_to_localStorage_cap = 4 × ceil((LS_BUDGET − intercept) / bytes_per_round)` extrapolated, reported as both rounds and turns. Flag if the actual run reaches the cap (rare).

### 4.4 Server-memory ceiling (secondary)

- `room_messages_count`, `room_messages_bytes` per round; `server_heap_bytes` when instrumented.
- `server_bytes_per_round` (linear slope). Report rounds-to-1GB as an order-of-magnitude reference; the server has no hard cap, so this is informational unless heap growth is super-linear (would indicate a leak — a finding for chaos-engineer).

### 4.5 Per-turn JSONL line (written incrementally, no batching)

Each turn appends one line to `stress-test-4p-<run_id>.jsonl` with at least:
```
run_id, round, turn_in_round, turn_index, player, action_type,
is_probe, probe_id, anchors_tested[], anchors_passed[],
turn_sequence, phase_after, party_names[], party_active[],
tokens_per_sec, eval_count, eval_duration_ns, total_duration_ns,
wall_ms, ollama_processor, entity_digest_string, entity_digest_length,
room_messages_count, room_messages_bytes, persist_bytes, server_heap_bytes,
response_snippet (first 200 chars), event_flags[] (PHASE_DRIFT|PARTY_SHRINK|SERVER_REJECT|...)
```

### 4.6 The limiting-factor decision rule (the definitive answer)

Compute the round at which EACH ceiling is hit (measured or extrapolated):
- `R_continuity = rounds_to_B_collapse` (measured; `null` if B never collapsed within the cap).
- `R_localstorage = turns_to_localStorage_cap / 4` (extrapolated).
- `R_server = rounds_to_server_mem_threshold` (extrapolated; only if a threshold is breached or growth is super-linear).
- `R_hardfail = round of any hard stop` (measured; `null` if none).

```
limiting_factor = argmin over the non-null { R_continuity, R_localstorage, R_server, R_hardfail }
headline_rounds = that minimum
```
Decision text:
- If `R_continuity` is the min → **"A 4-player campaign degrades on CONTINUITY at ~R_continuity rounds (~4×R_continuity player turns); category-B recall collapses below 0.50 while localStorage/memory have ample headroom."** This is the EXPECTED outcome given §0.
- If `R_localstorage` or `R_server` is the min → report the resource ceiling and the round, and note continuity was still healthy (B ≥ 0.50) at that point.
- If a hard fail fired first → report the failure mode as the binding constraint and flag it for remediation.

Always report ALL four numbers so the reader sees the headroom between ceilings, not just the binding one.

---

## 5. Agent Sequencing & Handoff Contract

Orchestrate via the coordinator/distributor layer (per project policy). Ollama-bound work serializes on the single GPU; non-GPU work parallelizes.

### Phase 1 — Build (test-automator)
**Reads:** this file, `harness.mjs` (structure to mirror), `sync-server.mjs`, `context.js`, `session.js`, `useWebSocket.js`, `turnStateMachine.js`.
**Writes:**
- `stress-test/harness-4p.mjs` — the 4-client WS harness implementing §1–§4. Imports `serializeSession`, `makeRoomCode`, `buildPlayersForPrompt` from `../src/lib/session.js` and reuses `getOllamaPs`/`percentile` patterns from `harness.mjs`. Uses the `ws` package (already a server dep) for Node WebSocket clients. CLI: `--mode=smoke|full`, `--rounds=N`, `--run_id=ID`.
- The flag-gated `STRESS_METRICS` instrumentation patch in `server/sync-server.mjs` (§2.3 + §2.4 optional heap line), OFF by default, documented in the harness header.
- A **smoke mode** (1 round = 4 turns + 1 forced probe) that validates: 4 clients join & get `session:state`; an `action` round-trips through `dm:delta`→`dm:done`; `dm:done.metrics` present when `STRESS_METRICS=1`; party block parses with 4 names; `persist_bytes` computes; `room_messages_bytes` grows; ≥1 anchor recalled. Halt + report if any check fails (mirrors PROTOCOL.md §6 gate).
**Hands off:** confirmation that smoke passes against a locally-running `npm run sync` (with `STRESS_METRICS=1`, `OLLAMA_HOST` set) and that the harness writes the JSONL/summary file shapes below. **No full run yet.**

### Phase 2 — Execute & analyze
Step 2a — **single authoritative long run** (whoever holds the GPU; coordinator-gated so nothing else hits Ollama):
- Start `server/sync-server.mjs` with `STRESS_METRICS=1`, `OLLAMA_HOST` pointing at the resident model, `SYNC_PORT=3001`.
- Run `node stress-test/harness-4p.mjs --mode=full --rounds=60 --run_id=4p_main`.
- **Writes (the SHARED artifacts):** `stress-test/stress-test-4p-4p_main.jsonl` and `stress-test/stress-test-summary-4p-4p_main.json` (full schema in §6 of `harness.mjs` style, extended with the §4 metrics + `stop_reason` + the four `R_*` ceiling values + `limiting_factor` + `headline_rounds`).

Step 2b — analysis, in parallel (both read-only on the shared artifacts; no GPU):
- **performance-engineer** — reads `stress-test-4p-4p_main.jsonl` + summary. Writes `stress-test/PERF-4P-ANALYSIS.md`: tok/s stability/sag, prompt_eval trend, CPU-offload turn, the §4.3 localStorage and §4.4 server-memory slopes + extrapolated ceilings, and which (if any) resource ceiling binds before continuity.
- **qa-expert** — reads the SAME `stress-test-4p-4p_main.jsonl` + summary. Writes `stress-test/QA-4P-CONTINUITY.md`: per-probe and per-category accuracy curves, `drift_onset`, `rounds_to_B_collapse`, per-owner B asymmetry, phase/party-shrink events, and a judgement on whether the soft-stop fired legitimately (not a scoring artifact).

Step 2c — **chaos-engineer**, fully parallel with 2a (NO GPU — pure unit/serialization experiments):
- Reads `session.js`, `sync-server.mjs`, this file. Writes `stress-test/CHAOS-4P-EXPERIMENTS.md` + any small scratch scripts under `stress-test/chaos/`.
- EX-1 **localStorage cliff:** synthesize growing `messages` arrays, run `serializeSession`→`JSON.stringify`→`byteLength`, confirm the §4.3 linear model and find the exact message-count at 5 MB (independent of the live run).
- EX-2 **server-memory model:** drive `applyPartyUpdate` + message accumulation in isolation to confirm `room.messages` growth is linear (no quadratic/leak), and stress the `withRoomLock`/`locks` Map cleanup for unbounded growth over long uptime.
- EX-3 **resilience:** Ollama-timeout simulation against a stub `OLLAMA_HOST` (verify `dm:done{error}` + phase reset, no wedged `awaiting-dm`); a forged-verdict.roll rejection check; a `DM_BUSY`/`RATE_LIMITED` race under burst actions on one connection. (All use a stub/echo Ollama, never the real GPU.)

### Phase 3 — Synthesis (knowledge-synthesizer, then auditor — in that order per project policy)
**Reads:** the JSONL + summary + `PERF-4P-ANALYSIS.md` + `QA-4P-CONTINUITY.md` + `CHAOS-4P-EXPERIMENTS.md`.
**Writes:** `stress-test/4-PLAYER-ENDURANCE-REPORT.md` (§6). The auditor then verifies every number in the report traces to a line in the shared JSONL or a named analysis file (no un-sourced claims).

### File ownership (no two agents write the same file)
| File | Writer | Readers |
|------|--------|---------|
| `harness-4p.mjs`, `sync-server.mjs` patch | test-automator | Phase 2a runner |
| `stress-test-4p-4p_main.jsonl` / `-summary-4p-4p_main.json` | Phase 2a run | performance-engineer, qa-expert, knowledge-synthesizer, auditor |
| `PERF-4P-ANALYSIS.md` | performance-engineer | knowledge-synthesizer |
| `QA-4P-CONTINUITY.md` | qa-expert | knowledge-synthesizer |
| `CHAOS-4P-EXPERIMENTS.md` + `chaos/*` | chaos-engineer | knowledge-synthesizer |
| `4-PLAYER-ENDURANCE-REPORT.md` | knowledge-synthesizer | auditor, user |

---

## 6. Synthesis Report Format — `4-PLAYER-ENDURANCE-REPORT.md`

```
# 4-Player D&D Campaign Endurance — Report

## Headline
A 4-player campaign degrades after ~<headline_rounds> rounds (~<4×headline_rounds> player turns).
Limiting factor: <continuity | localStorage | server-memory | hard-failure:<mode>>.
Run: <run_id>, <total_rounds> rounds / <total_turns> turns, stop_reason=<...>, wall <Xm>.

## Per-Dimension Ceilings (all four, with headroom)
| Dimension      | Ceiling (rounds) | Ceiling (turns) | Measured/Extrapolated | Evidence |
|----------------|------------------|-----------------|-----------------------|----------|
| Continuity (B<0.5 sustained) | R_continuity | 4×       | measured     | QA-4P-CONTINUITY.md |
| localStorage (5MB)           | R_localstorage|          | extrapolated | PERF-4P-ANALYSIS.md / CHAOS EX-1 |
| Server memory                | R_server      |          | extrapolated | PERF-4P-ANALYSIS.md / CHAOS EX-2 |
| Hard failure                 | R_hardfail    |          | measured     | jsonl stop line |

## Continuity Detail
- Category accuracy curve A/B/C by probe (table).
- drift_onset: anchor, owner, round, round-distance.
- Per-owner B asymmetry (which player's facts evicted first, and why — shared 18-msg window math).
- phase_drift / party_shrink counts.

## Throughput & Resources
- tok/s mean/p25/p75/p95 + sag slope; CPU-offload turn (if any).
- localStorage bytes/round + the 5MB extrapolation.
- server room-memory bytes/round (+ heap if instrumented); leak verdict from CHAOS EX-2.

## Resilience (CHAOS)
- Ollama-timeout / phase-reset behavior; forged-verdict rejection; DM_BUSY/RATE_LIMITED under burst.

## Why Continuity Binds First (the §0 thesis, confirmed or refuted by data)
One paragraph tying the headline to the 22-message trim cap shared across 4 players.

## Recommendations
- Concrete, prioritized (e.g. per-player pinned slots; raise extractEntities max; bump recent window for N>1 players; localStorage rotation/compaction at K turns; server room-history compaction).
- Each recommendation cites the dimension it relieves and the round-gain it would buy.
```

---

## 7. Boundary Conditions to Verify Explicitly
1. **Trim shared-window math:** with 4 players, a given player's turn is evicted from the 18-message recent window after ~`(18 / 2)` total turns ≈ ~4–5 of that player's own turns. Log, per anchor, the round at which its source message leaves the trim window (compute from `room.messages` length, since trim fires at >22).
2. **Empty digest at start:** rounds 1's first turns have few/no assistant messages → digest empty → prompt omits the digest suffix (matches `entities.length` guard, `sync-server.mjs` L581-583). Verify.
3. **Dice attribution:** dice turns store `role:'dice'` with `senderName` (L554-560) and are NOT scored; they advance `turnSequence` and history. Verify they don't pollute the entity digest.
4. **Phase invariant:** assert `phase` in every round-final `session:update` is a resting phase; transient `awaiting-dm` only appears in the lock broadcast (§1.2 / §2.1).
5. **Single-trigger gate:** confirm no `DM_BUSY` under serialized pacing; confirm the 4-player roster naturally exceeds `ACTION_MIN_INTERVAL_MS` per connection (§2.2).
6. **Metrics flag isolation:** with `STRESS_METRICS` unset, `dm:done` is byte-identical to production (the instrumentation must be invisible to prod clients).
```
