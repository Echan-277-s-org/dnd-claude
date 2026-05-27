# CONTINUITY-FIX-PLAN — 4-Player Endurance Remediation

*Workflow-orchestration spec. Single source of truth for the multi-agent-coordinator + task-distributor and the 6 worker agents. This document sequences the work; it does not implement it. Repo: `H:\Claude\dnd-claude`, branch `test/4-player-endurance-stress`, Windows/PowerShell.*

---

## 1. Diagnosis (settled — do not re-litigate)

A full-fidelity 4-player endurance run (`4p_main`, 20 rounds / 78 turns, `stop_reason=B_COLLAPSE`) against the real `server/sync-server.mjs` established that **continuity is the only binding constraint**. Every other dimension passes with massive headroom:

| Dimension | Ceiling | Headroom vs continuity | Code change needed |
|-----------|---------|------------------------|--------------------|
| **Continuity** (category-B recall < 0.50 sustained) | **round ~16** | — (binds first) | **YES — all 5 fixes** |
| localStorage (5 MB) | ~745 rounds | 47× | none |
| Server room memory (65 MB) | ~9,638 rounds | 602× | none |
| Hard failure (timeout / ctx overflow) | never fired | ∞ | none |
| Resilience (timeout recovery, forged-verdict reject, burst gates) | all PASS | — | none |

**Why continuity binds first.** `trimContext` caps every Ollama prompt at 22 messages (`pinned=4 + recent=18`) regardless of campaign length — this is exactly what makes compute flat (tok/s slope −0.16/round, R²=0.03) and storage the only thing that grows. But that 18-message recent window is **shared across all 4 players**. A 4-player round is ~8 messages, so the window holds only ~2.25 rounds; each player's own facts evict ~4× faster (by round) than single-player. The only thing between an evicted fact and confabulation is the entity digest — which silently dropped the very anchors this test introduced:

- **"Garret Ironhand's Forge of Embers"** — a 5-word bold span, rejected by `extractEntities` (`context.js:218`, `words.length > 4`), so **never indexed**. After it scrolled out of the recent window (~round 5) the DM confabulated "Eldric Ironhand"/"Smithy's Forge", which then accrued its own frequency count and permanently blocked recovery.
- **"12 gold"** — numeric/transactional facts have **no digest path at all**.
- **Spotlight starvation** — the DM concentrated turns (Lyra 47%, Bron 9%, 50-turn gap for Bron); combat phase locks non-spotlit players out entirely, and low-spotlight players' facts re-mention less, so they evict first.
- **PC-name confabulation** — at round 13 the DM renamed Kael → "Aelis" in the party block (the same mechanism that erased Garret, applied to a player character).

The 5 fixes below all target continuity + 4-player fairness. No performance/storage/resilience work is in scope.

---

## 2. The 5 fixes (file map confirmed against current source)

| # | Fix | Owner agent | Files touched | Confirmed locations |
|---|-----|-------------|---------------|---------------------|
| 1 | Scale `recent` window with player count | `llm-architect` | `src/lib/context.js` (trimContext), `src/components/Chat.jsx` (call site), `server/sync-server.mjs` (call site) | trimContext = `context.js:334`; Chat call site `Chat.jsx:447`; server call site `sync-server.mjs:609`. starwars **re-exports** trimContext (`context.starwars.js:12`) → single source, no fork edit. |
| 2 | `extractEntities` possessive/compound split | `ai-engineer` | `src/lib/context.js`, `src/lib/context.starwars.js` | `looksLikeEntity`/`extractEntities` in `context.js:~180–299`; starwars **forks** its own copy (~L228+) → **must edit BOTH**, kept behaviorally in sync. |
| 3 | Structured `facts` block for numeric/transactional facts | `prompt-engineer` | `src/lib/context.js` (prompt), `src/lib/context.starwars.js` (prompt), `src/components/Chat.jsx` (parser + digest), `server/sync-server.mjs` (digest) | `buildSystemPrompt` in both engines; parser in Chat.jsx alongside party/check/verdict; digest injection at `Chat.jsx:460` and `sync-server.mjs:581` systemContent assembly. |
| 4 | Spotlight rotation / starvation guard | `reinforcement-learning-engineer` | `server/sync-server.mjs` | combat turn gate `sync-server.mjs:451–453`; informed by spotlight metrics (Bron 9%, 50-turn gap). |
| 5 | Anchor PC roster vs confabulation | `machine-learning-engineer` | `server/sync-server.mjs` | party-block apply `sync-server.mjs:777` (`applyPartyUpdate`); validate against joined roster (`room.party` names / `buildPlayersForPrompt`). |

**Player-count signal (fix #1):** server-side derive from `room.party.length` (or joined client count); client-side from `party.length`/`players.length`. trimContext gains an optional `playerCount` (default 1) so `recent` scales only for N>1.

---

## 3. Workflow DAG

```
                         ┌─────────────────────────────────────────────┐
                         │  context.js LANE   (serialize — file lock)   │
                         │   F1c ──▶ F2c ──▶ F3c                         │
                         │  (recent)  (entity)  (facts prompt)          │
                         └───────────────┬─────────────────────────────┘
                                         │
       ┌────────────────────────────────┤
       │                                 │
       │   ┌──────────────────────────────────────────────────────────┐
       │   │  sync-server.mjs LANE  (serialize — file lock)            │
       │   │   F1s ──▶ F3s ──▶ F4 ──▶ F5                                │
       │   │  (recent) (facts)  (spotlight) (roster)                   │
       │   └───────────────┬──────────────────────────────────────────┘
       │                   │
       │   ┌──────────────────────────────────────────────────────────┐
       │   │  Chat.jsx LANE  (serialize — file lock)                   │
       │   │   F1ch ──▶ F3ch                                           │
       │   │  (recent)  (facts parser+digest)                          │
       │   └───────────────┬──────────────────────────────────────────┘
       │                   │
       │   ┌──────────────────────────────────────────────────────────┐
       │   │  context.starwars.js LANE  (independent file)             │
       │   │   F2sw ──▶ F3sw    (entity fork + facts prompt)           │
       │   └───────────────┬──────────────────────────────────────────┘
       └───────────────────┴──────────┐
                                       ▼
                           ┌────────────────────────┐
                           │  VALIDATION GATE        │
                           │  build → vitest →       │
                           │  stress harness (opt)   │
                           └───────────┬─────────────┘
                                       ▼
                           ┌────────────────────────┐
                           │  PUSH + OPEN PR         │
                           │  (no merge)             │
                           └────────────────────────┘
```

**Node legend (sub-tasks per file lane):**

| Node | Fix | File | Depends on |
|------|-----|------|------------|
| F1c | #1 | context.js — add `playerCount` param to trimContext | — |
| F2c | #2 | context.js — possessive/compound split in `looksLikeEntity`/`extractEntities` | F1c (same file lock) |
| F3c | #3 | context.js — `facts` block in `buildSystemPrompt` | F2c (same file lock) |
| F2sw | #2 | context.starwars.js — mirror entity fork | F2c (logic parity, not file lock) |
| F3sw | #3 | context.starwars.js — `facts` block in `buildSystemPrompt` | F3c (parity), F2sw |
| F1s | #1 | sync-server.mjs — pass playerCount at trimContext call | F1c (API shape) |
| F3s | #3 | sync-server.mjs — `facts` digest injection | F1s (file lock), F3c (block shape) |
| F4 | #4 | sync-server.mjs — spotlight/starvation guard | F3s (file lock) |
| F5 | #5 | sync-server.mjs — roster anchor in party apply | F4 (file lock) |
| F1ch | #1 | Chat.jsx — pass playerCount at trimContext call | F1c (API shape) |
| F3ch | #3 | Chat.jsx — `facts` parser + digest | F1ch (file lock), F3c (block shape) |

**Edges are two kinds:** (a) **file-lock** edges (same file → must serialize to avoid merge conflicts), and (b) **API/parity** edges (one node defines a signature/JSON shape the other consumes → ordering, not exclusion). The DAG has no cycles.

---

## 4. Execution waves (recommended)

The three hot files (`context.js`, `sync-server.mjs`, `Chat.jsx`) each carry multiple fixes and **must be edited serially within the file** — but the four lanes run **in parallel** with each other once their cross-file dependencies are satisfied. Drive this through `multi-agent-coordinator` (the lanes share state: trimContext's signature and the `facts` block shape must be agreed first).

### Wave 0 — Contract freeze (coordinator, before any edit)
Pin two cross-cutting contracts so parallel lanes don't diverge:
1. **trimContext signature**: `trimContext(messages, { pinned = 4, recent = 18, playerCount = 1 } = {})`; for N>1 scale recent (e.g. `recent * playerCount` or `recent + 18*(playerCount-1)`), clamped. **N=1 ⇒ recent stays 18, prompt byte-identical.** (llm-architect proposes exact formula; coordinator ratifies.)
2. **`facts` block shape**: minified fenced ` ```facts ` JSON, e.g. `[{"k":"blacksmith_price","v":"12 gold"}]` — small, append-only, parsed defensively, absent in old responses. (prompt-engineer proposes; coordinator ratifies.)

### Wave 1 — Foundations (parallel across files, serial within)
- **context.js lane (llm-architect → ai-engineer → prompt-engineer, serial):** F1c → F2c → F3c. This is the longest serial chain (3 fixes, one file) and is the **critical path**.
- **context.starwars.js lane (ai-engineer):** F2sw can start as soon as F2c logic is settled (parity copy). Independent file — no contention with context.js lock.

### Wave 2 — Server + client (parallel, gated on Wave-0 contracts + Wave-1 outputs)
- **sync-server.mjs lane (llm-architect → prompt-engineer → reinforcement-learning-engineer → machine-learning-engineer, serial):** F1s → F3s → F4 → F5. Gated on Wave-0 contracts; F3s also needs F3c block shape.
- **Chat.jsx lane (llm-architect → prompt-engineer, serial):** F1ch → F3ch. Gated on Wave-0 contracts; F3ch needs F3c block shape.
- **context.starwars.js facts (prompt-engineer):** F3sw, after F3c + F2sw.

> Practical scheduling: because context.js is the critical path AND fixes #1/#3 define contracts the other lanes consume, run **F1c + F2c first** (sequentially), freeze the trimContext signature and facts shape at Wave 0 using llm-architect's + prompt-engineer's proposals, then **fan out** sync-server.mjs, Chat.jsx, and starwars lanes in parallel while F3c finishes. The task-distributor owns the per-lane queues; the coordinator owns the two contract handshakes.

### Wave 3 — Validation gate (single, after ALL lanes report done)
Run the authorized pipeline once, fail-fast (Section 6). Do **not** start validation until every lane node is complete and merged into the working tree.

### Wave 4 — Push + PR (only if Wave 3 fully green)
Push `test/4-player-endurance-stress`, open PR to `master`. **No merge.**

---

## 5. Per-fix acceptance criteria (testable "done")

**Fix #1 — scale recent with player count**
- trimContext accepts `playerCount` (default 1); N=1 returns the identical slice as before (regression test: `recent=18` unchanged).
- For N>1, recent grows monotonically with N per the ratified formula; bounded (no unbounded prompt — must still respect a sane cap so num_ctx:8192 is never overflowed).
- Both call sites (`Chat.jsx:447`, `sync-server.mjs:609`) pass a correct player count derived from party/roster size.
- starwars path inherits via re-export (no second edit); a test asserts starwars trimContext == dnd trimContext for the same inputs.
- New/updated unit tests for the formula at N=1,2,4,5.

**Fix #2 — extractEntities possessive/compound split**
- "Garret Ironhand's Forge of Embers" indexes as **"Garret Ironhand"** + **"Forge of Embers"** (two entities), not rejected.
- The >4-word rejection (`context.js:218`) no longer silently drops a possessive compound; the split happens before the length gate.
- Existing rejection behavior preserved for true prose (no new false positives — the step-6/7/9 prose/imperative/title-case guards still fire on the split halves).
- **`context.js` and `context.starwars.js` produce identical entity sets for identical inputs** (parity test, since starwars forks). Both files edited.
- Regression: the QA anchor set (Garret, Forge of Embers, Ash Covenant, Ravenmoor, Mira, Captain Vell) extracts as expected.

**Fix #3 — structured `facts` block**
- DM prompt in **both** `buildSystemPrompt` implementations instructs emission of a minified ` ```facts ` block for numeric/transactional facts (prices, counts, dates).
- Parser added in `Chat.jsx` alongside party/check/verdict; defensive (malformed/missing/partial-stream → keep last-known, no throw).
- Facts digest injected into systemContent at **both** `Chat.jsx:460` and `sync-server.mjs:581`.
- "12 gold" survives past round 8 in a digest path (verifiable via harness probe B5 if Ollama reachable; otherwise unit-tested on the parser + injection).
- Backward-compat: a response with **no** `facts` block behaves exactly as today; old v1/v2 session payloads still deserialize. Block stays minified JSON.

**Fix #4 — spotlight rotation / starvation guard**
- Server-side fairness logic added at/around the combat turn gate (`sync-server.mjs:451`): no single player holds `isActive` for > K consecutive turns; under-rotated players get surfaced/un-starved.
- A simulated 4-player sequence shows reduced max-starvation gap vs the 50-turn baseline (testable in a server unit/integration test with stubbed Ollama).
- Does not break the existing combat turn enforcement (the active player still acts; the guard only prevents indefinite monopolization).
- `NOT_YOUR_TURN`/`DM_BUSY` sentinels and turnSequence semantics unchanged.

**Fix #5 — anchor PC roster vs confabulation**
- `applyPartyUpdate` (or its caller at `sync-server.mjs:777`) validates incoming party-block names against the joined roster; a DM renaming Kael→"Aelis" is rejected/corrected (PC name held as ground truth).
- NPC/party rows that are legitimately new are unaffected (the guard targets joined PCs only).
- Party-member ID stability (name-match) preserved — the EX-2b 10,000-iteration invariant still holds.
- Phase derivation (`isActive → combat`) at `sync-server.mjs:781` unchanged.

---

## 6. Global gates — validation checklist (Wave 3)

Apply every item; any unchecked item halts the pipeline.

- [ ] `npm run build` succeeds (Vite production build, no errors).
- [ ] `npm test -- --run` — full Vitest suite green (~800+ tests; the documented `405 passed / 2 skipped` jsdom suite + the node-env server suite — match or exceed the current pass count, zero new failures).
- [ ] **STRESS_METRICS byte-identity:** with `STRESS_METRICS` unset, production server→client broadcasts (`session:state/session:update/dm:delta/dm:done/presence:update`) are byte-identical to pre-change. Instrumentation remains additive and OFF by default.
- [ ] **Single-player invariance (N=1):** `recent` stays 18; the assembled Ollama prompt shape is byte-identical to pre-change (no facts-block injection difference when DM emits none; no senderName prefix). Covered by an explicit N=1 test.
- [ ] **Engine parity:** `context.js` and `context.starwars.js` `extractEntities` return identical sets for identical inputs (the fix-#2 fork stayed in sync).
- [ ] **Block discipline:** all structured blocks (party/check/verdict/**facts**) remain minified JSON; responses omitting the new `facts` block parse cleanly; v1/v2 session payloads still deserialize (`deserializeSession`/`fromMarkdown` backward-compat).
- [ ] **Server-broadcast contract intact:** WS message types and the `{ type, roomCode, payload }` wire shape unchanged; forged-verdict rejection (EX-3b) still passes; no room wedge.
- [ ] **Stress harness (conditional):** if Ollama (`qwen2.5:14b`) is reachable on `:11434`, re-run `stress-test/harness-4p.mjs` and confirm the continuity ceiling moved (B-recall holds past round 16; Bron starvation gap < 50; no Kael→Aelis rename). **If Ollama is NOT reachable, skip this step gracefully — it is not a gate.**

---

## 7. Rollback / decision rule (when to HALT)

**Fail-fast, fail-closed. Stop on the first red and do NOT proceed to push/PR.**

1. **Any lane node fails to apply cleanly** (merge conflict in a serialized file because two agents edited out of order) → halt that lane, re-sequence per the DAG, do not force-merge.
2. **`npm run build` fails** → halt. Return the build error to the owning lane's agent; no further pipeline steps.
3. **Vitest regression** (any previously-passing test now fails, or pass count drops) → halt. Bisect to the offending fix by lane; the owning agent repairs; re-run the **full** suite (not just the changed file).
4. **STRESS_METRICS byte-identity or single-player-invariance gate fails** → halt. These are hard architectural invariants from CLAUDE.md; a violation means the fix changed production behavior and must be reworked, not waived.
5. **Engine-parity gate fails** (context.js vs context.starwars.js diverge) → halt fix #2; the starwars fork was missed or drifted.
6. **Stress harness regresses continuity** (with Ollama reachable: B-collapse still < round 16, OR a new confabulation/rename appears) → halt; the continuity fixes did not achieve their purpose — return to llm-architect/prompt-engineer. Harness *unreachability* is NOT a failure (skip gracefully).
7. **Never merge.** The pipeline ends at "push branch + open PR to master." A human reviews the PR. Per project policy, never push/merge red code.

**Resumption:** after a halt is repaired, re-run from the **validation gate** (Wave 3) in full — do not trust a partial re-run, since fixes share files and the entity/facts/prompt surfaces interact.

---

## 8. Orchestration handoff notes

- Route ALL WebSocket/server edits (fixes #3s, #4, #5 in `sync-server.mjs`) so they respect the single-file serialization; per project memory, WebSocket work goes to websocket-engineer if any socket-protocol change is needed — but these fixes are prompt/state/fairness logic, owned by the agents named in Section 2.
- `multi-agent-coordinator` owns the two Wave-0 contract handshakes (trimContext signature, facts-block shape) and the file-lock serialization within `context.js`, `sync-server.mjs`, and `Chat.jsx`.
- `task-distributor` owns the per-lane queues and parallel fan-out of the four lanes once Wave-0 contracts are frozen.
- Commit messages via temp file + `git commit -F <file>` (no inline multi-line `-m`, no here-strings).

---

## 9. Frozen contracts + handoff protocol (coordinator)

*Authored by `multi-agent-coordinator` at Wave 0, before any source edit. These two contracts are FROZEN — every lane consumes them as written. A lane may NOT silently change a signature or block shape; if a change is needed, it comes back here for re-ratification. Source locations below were re-verified against the live tree (`context.js:334`, `Chat.jsx:447/460`, `sync-server.mjs:581/609`, `context.starwars.js:12` re-export).*

### Contract A — `trimContext` signature (consumed by F1c, F1s, F1ch)

**Frozen exact signature:**

```js
trimContext(messages, { pinned = 4, recent = 18, playerCount = 1 } = {})
```

- **N=1 byte-identity (HARD CLAUDE.md INVARIANT — non-negotiable).** When `playerCount === 1` (and pinned/recent unspecified), the function MUST return a slice byte-identical to today: `pinned=4`, `recent=18`, the same `messages.slice(0, pinned)` + `messages.slice(length - recent)` concatenation, with the same `length <= pinned + recent` short-circuit. The single-player assembled Ollama prompt does not change by one byte. Verified call shape today: `context.js:336`. F1c MUST gate any scaling strictly behind `playerCount > 1`.
- **N>1 scaling — formula slot is `TBD by F1c, ratified here once proposed`.** `recent` grows monotonically with `playerCount` toward per-player history parity, but is CLAMPED by a hard upper cap. F1c (llm-architect) derives and justifies the exact numbers; this section is amended to record the ratified formula before F1s/F1ch consume it.

  **The num_ctx:8192 constraint F1c MUST honor (documented here, not resolved arbitrarily):**
  - The model runs at `num_ctx:8192` tokens. Today's 22-message cap (`pinned 4 + recent 18`) uses ~1.0–1.2s prompt-eval and **never overflowed** in the `4p_main` endurance run — this "flat compute" property (tok/s slope −0.16/round, R²=0.03) is exactly what the reports prize and MUST be preserved.
  - **Naive `recent = 18 × playerCount` is FORBIDDEN** (= 72 messages at N=4, 90 at N=5). At the observed ~877 bytes/message and ~3.3 bytes/token for English prose, 72 messages ≈ 63 KB ≈ ~19,100 tokens of history ALONE — that overflows num_ctx:8192 and destroys flat compute. Rejected by contract.
  - **Budget envelope F1c must size against:** total prompt budget ≈ 8192 tokens ≈ ~27 KB. Subtract the system prompt + entity digest + the new facts digest (Contract B) + the appended current user turn — call the reserved overhead ~2,000–2,500 tokens. That leaves a **history budget of roughly ~5,700–6,200 tokens ≈ ~18,500–20,000 bytes ≈ ~21–23 messages of recent tail**. The recent window (plus pinned 4) must fit inside this at the **worst case (max players = 5)** with headroom — it must NOT be sized for the average case.
  - **Constraints the formula must satisfy (acceptance):** (1) monotonic non-decreasing in `playerCount`; (2) `playerCount === 1 ⇒ recent === 18` exactly; (3) a hard upper cap such that `pinned + recent` at `playerCount = 5` keeps the worst-case full prompt safely within num_ctx:8192 (token-budget-justified, not message-count-guessed); (4) the cap is justified in a code comment citing the ~877 B/msg and ~8192-token budget. A capped-linear or capped-additive shape (e.g. `recent = min(CAP, 18 + k·(playerCount−1))`) is the expected family; F1c picks `k` and `CAP` and shows the worst-case token math.
- **Call-site player-count derivation (frozen for F1s + F1ch):**
  - **Server (F1s, `sync-server.mjs:609`):** derive from roster size — `room.party?.length` (fall back to joined-client/connection count if party is empty). Pass as `{ playerCount }` into the existing options object at the `engine.trimContext([...])` call.
  - **Client (F1ch, `Chat.jsx:447`):** derive from `party.length` (fall back to `players.length`). Single-player has no party/room ⇒ `playerCount` resolves to 1 ⇒ N=1 invariant holds automatically.
  - starwars inherits via the existing re-export (`context.starwars.js:12`) — **no second edit**; a parity test asserts starwars `trimContext` === dnd `trimContext` for identical inputs.

> **RATIFIED FORMULA (F1c proposed, ratified):** `recent = min(CAP, 18 + k·(playerCount − 1))` with **k = 8, CAP = 42**. Yields recent = 18 (N=1) / 26 (N=2) / 34 (N=3) / 42 (N=4, cap) / 42 (N=5, cap) → max 46 messages (4 pinned + 42 recent). k=8 ≈ one 4-player round of messages per extra human (per-player parity); CAP=42 keeps N=5 worst-case prompt inside the ~21–23 effective-message / ~5,700–6,200-token history envelope under num_ctx:8192. N=1 is byte-identical (scaling gated strictly behind `playerCount > 1`). Token math is in the `trimContext` code comment in `src/lib/context.js`. Implemented + tested (818 total tests pass, +9 new trimContext tests). **F1s/F1ch were implemented by F1c in the same pass** — call sites: Chat.jsx `playerCount = roomCode ? max(1, party?.length||players?.length||1) : 1`; sync-server `max(1, room.party?.length || openClientCount || 1)`.

### Contract B — `facts` block shape (consumed by F3c, F3sw, F3s, F3ch)

**Frozen block:** a minified fenced ` ```facts ` block appended by the DM at the end of a response, under the **same discipline** as the existing `party`/`check`/`verdict` blocks: minified JSON, **at most one per response**, **nothing after the final fence**, stripped from the displayed text before render.

**Frozen schema:** a JSON **array** of `{"k":"<short_key>","v":"<value string>"}` objects, capturing numeric / transactional / quantitative facts (prices, counts, dates, quantities, tallies):

```json
[{"k":"blacksmith_price","v":"12 gold"},{"k":"garret_forge","v":"Garret Ironhand's Forge of Embers"}]
```

- `k` — a short, snake_case-ish stable key (the merge key). `v` — a short value string (the fact verbatim, including its unit/qualifier).
- **Bounded:** at most **≤ 12 entries** retained. On parse, **merge by key** (a repeated `k` overwrites its prior `v` — latest wins); when over the cap, evict oldest-by-insertion. This keeps the facts digest small and the prompt overhead in Contract A's reserved budget bounded.
- **Defensive parse (frozen, identical discipline to party/check/verdict):** malformed / missing / partial-stream / non-array / non-object-entry → **keep last-known facts, no throw**. A response with **NO** `facts` block behaves **exactly as today** (backward-compat; old v1/v2 session payloads still deserialize unchanged). `facts` are session-state, not persisted schema-breaking — treat like the entity digest (re-derivable/accumulated, not a required field).
- **Digest injection (frozen sites + format):** inject a short single line into `systemContent`, **only when the facts set is non-empty**, immediately adjacent to the existing "Established entities so far…" line:
  - Format: `Established facts: <k1>=<v1>; <k2>=<v2>; …` (semicolon-joined `k=v` pairs).
  - **Client:** `Chat.jsx:460` — extend the `entities.length ? … : systemPrompt` assembly so a non-empty facts set appends the `Established facts:` line (append after the entities line; when facts empty, the line is omitted and the string is byte-identical to today).
  - **Server:** `sync-server.mjs:581` — same extension on the server-side `systemContent` assembly.
  - **N=1 / no-facts invariance:** when the DM emits no facts block and the set is empty, both injection sites produce a `systemContent` **byte-identical to today** — this protects the single-player-invariance gate (§6) and the STRESS_METRICS byte-identity gate.
- **Prompt instruction (F3c/F3sw):** `buildSystemPrompt` in BOTH engines instructs the DM to append the ` ```facts ` block for numeric/transactional facts, mirroring the existing party/check/verdict instruction wording and the "minified, at most one, nothing after the fence" discipline. Wording kept in parity across `context.js` and `context.starwars.js`.

### Handoff protocol — file-lock serialization (coordinator-owned)

**Conflict-avoidance rule (absolute):** **one writer per file at a time.** An agent MUST NOT begin its node until the prior node on the **same file** has reported COMPLETE to the coordinator. Each agent **re-reads the target file immediately before editing** (the prior node changed it; never edit against a stale read). A node that finds the file changed unexpectedly (out-of-order edit) HALTS and reports per §7 rule 1 — no force-merge.

**Per-file edit order (serialized within file):**

| File | Serial order | Owners |
|------|--------------|--------|
| `src/lib/context.js` | F1c → F2c → F3c | llm-architect → ai-engineer → prompt-engineer |
| `server/sync-server.mjs` | F1s → F3s → F4 → F5 | llm-architect → prompt-engineer → reinforcement-learning-engineer → machine-learning-engineer |
| `src/components/Chat.jsx` | F1ch → F3ch | llm-architect → prompt-engineer |
| `src/lib/context.starwars.js` | F2sw → F3sw | ai-engineer → prompt-engineer *(independent file — parity with context.js, not a lock shared with it)* |

**Cross-file (API/parity) gates layered on top of the file locks:**
- F1s and F1ch MUST NOT start until **Contract A is ratified** (F1c's formula filled in above) — they consume the signature + derivation rule.
- F3s, F3ch, F3sw MUST NOT start until **Contract B is frozen** (above, done) AND F3c has settled the prompt wording (parity source).
- F2sw tracks F2c's entity-split **logic** (parity copy) — different file, so no lock contention, but the logic must match (engine-parity gate, §6).

**Coordinator handshakes still open:** Contract B is frozen as written above (no further proposal needed). Contract A's formula slot remains **TBD pending F1c** — F1s/F1ch are BLOCKED until the "RATIFIED FORMULA" line above is filled in. The coordinator ratifies F1c's proposal in place, then releases the server + client lanes.

---

## 10. Lane allocation & dispatch queues (task-distributor)

This section operationalizes the DAG (§3), contracts (§9), and waves (§4) as concrete dispatch queues. The task-distributor owns per-file lane ordering and parallel coordination across lanes once Wave-0 contracts are frozen.

### 10.1 DAG node → owner → file → predecessors (dispatch table)

| Node | Fix | Owner agent | File | Blocking predecessors | Ready/Blocked at start |
|------|-----|-------------|------|----------------------|----------------------|
| F1c | #1 | llm-architect | `src/lib/context.js` | — | **READY** |
| F2c | #2 | ai-engineer | `src/lib/context.js` | F1c (file lock) | BLOCKED (awaiting F1c done + file release) |
| F3c | #3 | prompt-engineer | `src/lib/context.js` | F2c (file lock) | BLOCKED (awaiting F2c done + file release) |
| F1s | #1 | llm-architect | `server/sync-server.mjs` | **Contract A** (F1c formula, not file lock) | BLOCKED (awaiting Contract A ratified) |
| F3s | #3 | prompt-engineer | `server/sync-server.mjs` | F1s (file lock), **F3c done** (block shape) | BLOCKED (awaiting Contract A + F1s + F3c) |
| F4 | #4 | reinforcement-learning-engineer | `server/sync-server.mjs` | F3s (file lock) | BLOCKED (awaiting F3s done) |
| F5 | #5 | machine-learning-engineer | `server/sync-server.mjs` | F4 (file lock) | BLOCKED (awaiting F4 done) |
| F1ch | #1 | llm-architect | `src/components/Chat.jsx` | **Contract A** (F1c formula) | BLOCKED (awaiting Contract A ratified) |
| F3ch | #3 | prompt-engineer | `src/components/Chat.jsx` | F1ch (file lock), **F3c done** (block shape) | BLOCKED (awaiting F1ch + F3c) |
| F2sw | #2 | ai-engineer | `src/lib/context.starwars.js` | F2c logic (parity, not file lock) | BLOCKED (awaiting F2c settled for entity-split logic) |
| F3sw | #3 | prompt-engineer | `src/lib/context.starwars.js` | F2sw (file lock), **F3c done** (facts block + prompt wording) | BLOCKED (awaiting F2sw + F3c done) |

**Legend:**
- **Blocking predecessors:** nodes that must complete (and in the case of file locks, release the file) before this node can start.
- **File lock:** edges (→) within the same file; one writer at a time per §9. Release happens when the prior agent's node is COMPLETE and they commit/push (or signal ready for merge).
- **Cross-file gates (double-line):** API/parity dependencies. Contract A and Contract B are explicitly listed. F2c→F2sw is logic parity (different file, no lock).
- **Ready/Blocked:** status at the moment Wave 0 contracts are frozen and the task-distributor first allocates queues.

### 10.2 Per-file lane queues (dispatch order within each file)

**CONTEXT.JS LANE (Critical Path — 3-node serial chain)**

| Position | Node | Owner | Status | Unblock trigger |
|----------|------|-------|--------|-----------------|
| 1 (HEAD) | F1c | llm-architect | **READY to dispatch** | — (no blocking deps) |
| 2 | F2c | ai-engineer | QUEUED | F1c COMPLETE + file released |
| 3 | F3c | prompt-engineer | QUEUED | F2c COMPLETE + file released + Contract B frozen (✓ already) |

**SYNC-SERVER.MJS LANE (4-node serial chain, gated on Contract A)**

| Position | Node | Owner | Status | Unblock trigger |
|----------|------|-------|--------|-----------------|
| 1 (HEAD) | F1s | llm-architect | **BLOCKED (Contract A)** | Contract A ratified by coordinator (F1c's formula filled in §9) |
| 2 | F3s | prompt-engineer | QUEUED | F1s COMPLETE + file released + F3c COMPLETE (block shape) |
| 3 | F4 | reinforcement-learning-engineer | QUEUED | F3s COMPLETE + file released |
| 4 | F5 | machine-learning-engineer | QUEUED | F4 COMPLETE + file released |

**CHAT.JSX LANE (2-node serial chain, gated on Contract A)**

| Position | Node | Owner | Status | Unblock trigger |
|----------|------|-------|--------|-----------------|
| 1 (HEAD) | F1ch | llm-architect | **BLOCKED (Contract A)** | Contract A ratified by coordinator (F1c's formula filled in §9) |
| 2 | F3ch | prompt-engineer | QUEUED | F1ch COMPLETE + file released + F3c COMPLETE (block shape) |

**CONTEXT.STARWARS.JS LANE (2-node serial chain, independent file)**

| Position | Node | Owner | Status | Unblock trigger |
|----------|------|-------|--------|-----------------|
| 1 (HEAD) | F2sw | ai-engineer | **BLOCKED (parity)** | F2c COMPLETE (entity-split logic settled, not a file lock) |
| 2 | F3sw | prompt-engineer | QUEUED | F2sw COMPLETE + F3c COMPLETE (facts block + prompt wording) + file released |

### 10.3 Recommended dispatch order (full workflow)

This sequence respects all file locks, cross-file gates, and parallel fan-out. The coordinator ratifies contracts; the task-distributor executes dispatch.

**Pre-dispatch (Coordinator):**
- Freeze Wave-0 contracts (Contract B ✓, Contract A awaits F1c proposal).

**WAVE 1 — CRITICAL PATH (context.js lane, serial)**

1. **Dispatch F1c** (`llm-architect`) — HEAD of context.js lane, zero blocking deps, READY immediately.
   - Action: Edit `context.js:334 trimContext`, add `playerCount` parameter, derive & justify scaling formula.
   - Deliverable: Proposed trimContext signature + formula, commit.
   - Unblock trigger: F1c COMPLETE → coordinator ratifies formula in §9 "RATIFIED FORMULA" slot.

2. **Dispatch F2c** (`ai-engineer`) — after F1c COMPLETE + context.js file released.
   - Action: Edit `context.js:~180–299` `looksLikeEntity`/`extractEntities`, implement possessive/compound split.
   - Deliverable: Entity-split logic & tests, commit.
   - Unblock trigger: F2c COMPLETE → enables F2sw (parity copy) + allows F3c to proceed.

3. **Dispatch F3c** (`prompt-engineer`) — after F2c COMPLETE + context.js file released.
   - Action: Edit `context.js` `buildSystemPrompt`, add `facts` block instruction; finalize prompt wording.
   - Deliverable: `facts` block prompt + wording (canonical for parity), commit.
   - Unblock trigger: F3c COMPLETE → Contract B finalized; unblocks F3s, F3ch, F3sw.

**WAVE 1 parallel branch — starwars parity (independent file, no lock contention, waits on logic only)**

4. **Dispatch F2sw** (`ai-engineer`, parallel to F3c if desired) — after F2c logic settled (not a file lock).
   - Action: Edit `context.starwars.js:~228+` fork `looksLikeEntity`/`extractEntities`, mirror F2c split.
   - Deliverable: Entity-split fork kept in parity, commit.
   - Unblock trigger: F2sw COMPLETE → enables F3sw.

**WAVE 2 — SERVER, CLIENT, STARWARS FACTS (parallel fan-out, gated on Wave-1 outputs + Contract A)**

5. **Dispatch F1s** (`llm-architect`, parallel to F3c) — after **Contract A ratified** + F1c outputs available.
   - Action: Edit `server/sync-server.mjs:609`, pass `{ playerCount }` to `trimContext` call (derive from `room.party?.length`).
   - Deliverable: Server-side playerCount injection, commit.
   - Unblock trigger: F1s COMPLETE → enables F3s.

6. **Dispatch F1ch** (`llm-architect`, parallel to F3c, independent file) — after **Contract A ratified** + F1c outputs available.
   - Action: Edit `src/components/Chat.jsx:447`, pass `{ playerCount }` to `trimContext` call (derive from `party.length`).
   - Deliverable: Client-side playerCount injection, commit.
   - Unblock trigger: F1ch COMPLETE → enables F3ch.

7. **Dispatch F3s** (`prompt-engineer`, after F1s + F3c) — after F1s COMPLETE + F3c COMPLETE + context.js released.
   - Action: Edit `server/sync-server.mjs:581`, inject `facts` digest per Contract B; parse/accumulate facts from DM response.
   - Deliverable: Server-side facts digest + parser, commit.
   - Unblock trigger: F3s COMPLETE → enables F4.

8. **Dispatch F3ch** (`prompt-engineer`, parallel to F4 if desired, after F1ch + F3c) — after F1ch COMPLETE + F3c COMPLETE + Chat.jsx released.
   - Action: Edit `src/components/Chat.jsx:460`, inject `facts` digest per Contract B; parser alongside party/check/verdict.
   - Deliverable: Client-side facts parser + digest, commit.
   - Unblock trigger: F3ch COMPLETE → enables validation.

9. **Dispatch F3sw** (`prompt-engineer`, parallel to F4, after F2sw + F3c) — after F2sw COMPLETE + F3c COMPLETE + context.starwars.js released.
   - Action: Edit `src/lib/context.starwars.js` `buildSystemPrompt`, add `facts` block instruction (mirror F3c wording).
   - Deliverable: Starwars `facts` block prompt, commit.
   - Unblock trigger: F3sw COMPLETE → enables validation.

10. **Dispatch F4** (`reinforcement-learning-engineer`, after F3s) — after F3s COMPLETE + sync-server.mjs released.
    - Action: Edit `server/sync-server.mjs:451–453`, add spotlight/starvation guard to combat turn gate.
    - Deliverable: Combat turn fairness logic + tests, commit.
    - Unblock trigger: F4 COMPLETE → enables F5.

11. **Dispatch F5** (`machine-learning-engineer`, last server edit) — after F4 COMPLETE + sync-server.mjs released.
    - Action: Edit `server/sync-server.mjs:777` `applyPartyUpdate`, validate party-block names against joined roster; anchor PC names.
    - Deliverable: Roster anchor + validation, commit.
    - Unblock trigger: F5 COMPLETE → all 11 nodes done; enables WAVE 3.

**WAVE 3 — VALIDATION GATE (orchestrator-owned, after ALL 11 nodes COMPLETE)**

12. **Dispatch validation** (orchestrator) — after F1c, F2c, F3c, F1s, F3s, F4, F5, F1ch, F3ch, F2sw, F3sw all COMPLETE and merged.
    - Action: Run `npm run build`, `npm test -- --run`, byte-identity checks (STRESS_METRICS, single-player invariance, engine parity), optional stress harness if Ollama reachable.
    - Gating: All 11 nodes in working tree, zero outstanding edits, no merge conflicts.
    - Halt rule per §7 if any check fails.

**WAVE 4 — PUSH + PR (orchestrator-owned, only if Wave 3 fully green)**

13. **Dispatch push + PR** (orchestrator) — after validation COMPLETE (no failures).
    - Action: Push branch `test/4-player-endurance-stress`, open PR to `master`.
    - **NO merge** — a human reviews.

### 10.4 First-wave dispatchable set (initial allocation at Wave-0 contract freeze)

**Immediately dispatchable (zero blocking deps):**
- **F1c** (`llm-architect`, context.js) — critical path head; proposes trimContext formula & justifies per Contract A constraints.

**Dispatchable once Contract A is ratified (F1c's formula filled in §9):**
- **F1s** (`llm-architect`, sync-server.mjs) — server-side playerCount injection.
- **F1ch** (`llm-architect`, Chat.jsx) — client-side playerCount injection.

**Dispatchable after F1c output + F2c logic settled (F2c COMPLETE):**
- **F2c** (`ai-engineer`, context.js) — entity-split fork in dnd engine; queued behind F1c file lock.
- **F2sw** (`ai-engineer`, context.starwars.js) — entity-split fork in starwars engine; independent file (no lock) but waits on F2c logic.

**Unblock triggers for waiting nodes:**

| Waiting node | Blocker | Unblock when | Blocker owner |
|--------------|---------|--------------|----------------|
| F2c | F1c file lock | F1c COMPLETE + file released | llm-architect |
| F1s, F1ch | Contract A | F1c formula ratified by coordinator | coordinator (ratifies F1c proposal) |
| F3c | F2c file lock | F2c COMPLETE + file released | ai-engineer |
| F2sw | F2c logic (parity) | F2c COMPLETE (different file, no lock) | ai-engineer |
| F3s | F1s file lock + F3c done | F1s COMPLETE + F3c COMPLETE | llm-architect + prompt-engineer |
| F3ch | F1ch file lock + F3c done | F1ch COMPLETE + F3c COMPLETE | llm-architect + prompt-engineer |
| F3sw | F2sw file lock + F3c done | F2sw COMPLETE + F3c COMPLETE | ai-engineer + prompt-engineer |
| F4 | F3s file lock | F3s COMPLETE + file released | prompt-engineer |
| F5 | F4 file lock | F4 COMPLETE + file released | reinforcement-learning-engineer |

### 10.5 Validation & PR as final queue entries

After all 11 DAG nodes are COMPLETE and their commits are integrated into the working tree:

- **Validation gate (Wave 3)** is a single orchestrator-owned job that runs the checks in §6 in strict order (fail-fast). This is not a DAG node but a **serial blocking gate**; zero nodes can advance to Wave 4 until it PASSES. Gated by: all 11 nodes done + working tree clean.

- **Push + PR (Wave 4)** is the final queue entry. Executed only if validation fully green. Gated by: validation PASSED. No merge — a human reviews.

- **Rollback rule (§7):** if validation fails at any step, halt the pipeline, do NOT proceed to Wave 4. Return the failure to the owning agent(s); they repair and re-run validation in full once the fix is committed.

---


