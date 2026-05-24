# Party HUD — Agent Coordination Spec

> **Status:** Established 2026-05-24 · Orchestration layer for the 5-worker Party-HUD build.
> **Authority:** This spec governs *who works when, what blocks what, and how agents re-sync*.
> It DEFERS to `PARTY-HUD-GITFLOW.md` for ALL git mechanics (branches, worktrees, merge
> commands, rebase, conflict resolution) and to `PARTY-HUD-PLAN.md` for ALL feature behavior.
> Where this spec references a gate or merge, it is naming the same event the GITFLOW defines —
> not redefining it. If a coordination need appears to differ from GITFLOW, GITFLOW wins and
> the interaction is noted here, never overridden.
>
> **Execution model:** The main Claude is the orchestrator. It spawns worker agents per the
> wave plan below, holds the wave gates, and performs all merges itself (workers commit to
> their own branch; the orchestrator merges). Workers never merge across branches.

---

## 0. Roster & Fixed Assignments (do NOT reassign)

| Worker | Role | Worktree / Branch | Port | Writes |
|--------|------|-------------------|------|--------|
| **llm-architect** | A0 emission prompt; sole owner of prompt text | `dnd-claude-prompt` / `party/prompt` | 5174 | `src/lib/context.js`, `src/lib/context.starwars.js` |
| **react-specialist** | A (state + unified parser) then B/C/D (UI) | `dnd-claude-core` / `party/core` | 5175 | `src/App.jsx`, `src/components/Chat.jsx`, new `PartyStrip.jsx`/`DiceChip.jsx`, `HistoryPanel.jsx`, `src/App.css` |
| **ml-engineer** | qwen2.5 compliance validation vs live Ollama | read-only against a running dev server; **no source writes** | uses 5174 (A0 prompt) | nothing in repo — emits a findings report only |
| **qa-expert** | test strategy / plan | **read-only — cannot write files** | n/a | nothing — emits a test plan only |
| **test-automator** | test code per qa-expert's plan | `dnd-claude-core` / `party/core` | 5175 | `*.test.jsx`, `*.test.js` only |

**Two-writer worktree:** `party/core` is written by BOTH react-specialist (source) and
test-automator (tests). They must never run concurrently on the same checkout — see §4 and §3 Wave 3.

---

## 1. Dependency DAG

Tasks: `A0` (prompt), `A` (state+parser), `B/C/D` (UI), `QWEN` (compliance validation),
`QA-PLAN` (test strategy), `TEST-CODE` (test implementation).

```
                         feat/party-hud @ 17f7d4e (base, plan committed)
                                        │
            ┌───────────────────────────┴───────────────────────────┐
            │ WAVE 1 (parallel)                                       │
            ▼                                                         ▼
  ┌───────────────────┐                                   ┌────────────────────┐
  │ A0  llm-architect │                                   │ A  react-specialist│
  │ prompt worktree   │                                   │ core worktree      │
  │ context.js(+sw)   │                                   │ App.jsx + Chat.jsx │
  │ emits `party`     │                                   │ parses `party`     │
  └─────────┬─────────┘                                   └─────────┬──────────┘
            │ (also enables ↓)                                      │
            ▼                                                       │
  ┌───────────────────┐                                            │
  │ QWEN ml-engineer  │  needs A0's prompt live in Ollama          │
  │ compliance check  │  ── findings may force a re-sync (§5) ──▶  │ (feeds back to A0,
  │ read-only         │     never edits the prompt directly        │  not to A directly)
  └─────────┬─────────┘                                            │
            │                                                      │
   ── GATE: A0 manual "fence in raw Ollama response" ──            │
            │                                                      │
            ▼ MERGE 1 (party/prompt → feat/party-hud)              ▼ MERGE 2 (party/core[A] → feat/party-hud)
            └───────────────────────┬──────────────────────────────┘
                                    │  (GITFLOW: Merge 1 BEFORE Merge 2; A0 lands first so
                                    │   B/C/D's Phase-D prompt edits ride on A0's prompt text)
                                    ▼
                       feat/party-hud now has A0 + A
                                    │
                       rebase party/core onto feat/party-hud (GITFLOW Wave 2 step)
                                    │
            ┌───────────────────────┴───────────────────────┐
            │ WAVE 2                                          │  WAVE 1.5 (parallel, off-critical-path)
            ▼ (serial within core)                           ▼
  ┌──────────────────────────────────┐            ┌────────────────────────┐
  │ B → C → D  react-specialist       │            │ QA-PLAN  qa-expert     │
  │ B: PartyStrip + HistoryPanel + CSS│            │ read PLAN + design-    │
  │ C: turn-pill + status dot         │            │ bridge audit; produce  │
  │ D: DiceChip + check/verdict wiring│            │ test plan for A,B,C,D  │
  │    + Phase-D prompt edits*        │            └───────────┬────────────┘
  └─────────────────┬─────────────────┘                        │
                    │                                           │ QA-PLAN may start any
                    │ * Phase-D edits context.js/.starwars.js   │ time after PLAN is read
                    │   check/verdict text. GITFLOW assigns     │ (no code dependency);
                    │   these to party/core (NOT a 2nd prompt   │ MUST finish before TEST-CODE.
                    │   merge). See §4 hazard note.             │
                    ▼ MERGE 3 (party/core[A+B+C+D] → feat/party-hud)
                    │
                    ▼ WAVE 3
        ┌────────────────────────────┐
        │ TEST-CODE  test-automator   │  needs: D code committed + QA-PLAN delivered
        │ rides in core worktree      │
        │ writes *.test.jsx/.js only  │
        └─────────────┬──────────────┘
                      │ commit onto party/core; re-merge tests
                      ▼
            feat/party-hud (feature complete, all gates green)
                      │
                      ▼ FINAL MERGE (feat/party-hud → master)
```

### Blocking edges (the hard ones)

| Edge | Type | Why |
|------|------|-----|
| `A0 → QWEN` | hard | ml-engineer needs the A0 prompt live in Ollama to validate compliance. |
| `A0 → MERGE 1`, `A → MERGE 2`, `MERGE 1 → MERGE 2` | hard (GITFLOW) | A0 lands before A; A lands before B/C/D rebase. Order fixed by GITFLOW. |
| `MERGE 2 → rebase → B/C/D` | hard | B/C/D edit the SAME `App.jsx`/`Chat.jsx` that A wrote; they must build on merged A. |
| `B → C → D` | hard (serial) | same agent, same files (`Chat.jsx`, `App.css`); no intra-core parallelism. |
| `A0 → D (Phase-D prompt text)` | soft/contract | D appends check/verdict prompt text that must be *consistent* with A0's party text and the frozen schema (§2). D edits land via party/core per GITFLOW, not a 2nd prompt merge. |
| `QWEN → A0 / parser` | conditional | Only fires if compliance is poor → triggers re-sync (§5), which updates BOTH prompt and parser. |
| `D code + QA-PLAN → TEST-CODE` | hard | test-automator needs the components to exist and the plan to test against. |
| `QA-PLAN` is parallel | none on critical path | qa-expert can plan from PLAN.md the moment Wave 1 starts; only TEST-CODE depends on it. |

### Non-blocking / parallel opportunities

- `A0 ∥ A` (Wave 1) — disjoint files, disjoint worktrees.
- `QA-PLAN ∥ everything` until TEST-CODE — read-only planning, no code dependency.
- `QWEN ∥ A` — once A0 is testable in the prompt worktree (5174), ml-engineer can validate
  while react-specialist still builds Phase A. QWEN does NOT block Merge 1 unless it surfaces
  a schema-breaking finding (§5).

---

## 2. Frozen Handoff Contract (IMMUTABLE)

This is the binding interface between **llm-architect** (emits) and **react-specialist**
(parses). It is reproduced **VERBATIM** from `PARTY-HUD-PLAN.md` §2. **Neither agent may
change any tag name, key name, type, or casing unilaterally.** A producer/consumer mismatch
here is the single highest-risk failure in the whole build, because the two sides live in
different worktrees and merge at different gates.

### 2.1 The three block tags

| Tag | Payload | When emitted |
|-----|---------|--------------|
| `party` | JSON array of `PartyMember` | Every response |
| `check` | JSON object `{skill, dc}` | When the DM requests a skill check |
| `verdict` | JSON object `{skill, dc, roll, result}` | After a roll is submitted with a pending check |

### 2.2 Wire format (fenced code blocks, placed at END of response)

````
```party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true}]
```

```check
{"skill":"STEALTH","dc":15}
```

```verdict
{"skill":"STEALTH","dc":15,"roll":17,"result":"FAIL"}
```
````

### 2.3 Exact JSON shapes

```ts
type PartyMember = {
  id: string           // UUID; assigned by the parser on first appearance, stable thereafter
  name: string         // display name as the LLM emits it
  role: string         // class/role label (e.g. "Ranger", "Jedi")
  hpPct: number        // 0–100 integer
  isActive: boolean    // true = this member's turn / currently spotlit
}
```

- `party` block payload: a JSON **array** of objects with keys
  `name (string)`, `role (string)`, `hpPct (integer 0–100)`, `isActive (boolean — exactly one true)`.
  NOTE: `id` is **NOT** emitted by the LLM — the parser assigns it (`applyPartyUpdate`). The
  prompt must NOT instruct the model to emit `id`.
- `check` block payload: `{"skill": <UPPERCASE string>, "dc": <integer>}`.
- `verdict` block payload: `{"skill": <string>, "dc": <integer>, "roll": <integer>, "result": "PASS" | "FAIL"}`.
  `result` is **exactly** the string `"PASS"` or `"FAIL"`.

### 2.4 Producer obligations (llm-architect, in the system prompt)

- Append a `party` fence to **EVERY** response (unconditional). If composition unchanged, re-emit same values.
- Append a `check` fence **only** when calling for a roll (conditional).
- Append a `verdict` fence after judging a submitted roll; echo `skill`, `dc`, `roll`; `result` is `"PASS"`/`"FAIL"`.
- Do not explain any block; the app strips them. Place blocks at the end.
- Identical text appended to BOTH `context.js` and `context.starwars.js`.

### 2.5 Consumer obligations (react-specialist, in Chat.jsx)

- Strip ALL three tags from displayed text via the unified `stripStructuredBlocks`
  (`BLOCK_TAGS = ['party','check','verdict']`).
- Extract via `extractBlock(tag, text)`; apply all three in the `finally` block after the stream closes.
- Defensive parsing per PLAN §2c (`applyPartyUpdate`, clamps, `Boolean()` coercion, `try/catch` → keep last-known).
- Tags, key names, and the `"PASS"`/`"FAIL"` literals must match §2.1–2.3 exactly.

### 2.6 Change-control rule (THE re-sync trigger)

> **Any change to a tag name, a JSON key, a type, the `"PASS"`/`"FAIL"` literals, or the
> emit conditions requires a coordinated re-sync that updates the PROMPT and the PARSER
> TOGETHER, in the same wave, before any gate that depends on the changed block passes.**

- ml-engineer may **propose** schema/prompt tweaks from compliance findings. Such proposals
  route **BACK through llm-architect / `party/prompt`** — ml-engineer never edits the prompt,
  and never edits the parser. (See §5.)
- If a tweak is only to *wording/phrasing* of the prompt (not the schema), it can land as a
  prompt-only re-sync (party/prompt) without touching the parser — but llm-architect must
  confirm the emitted shape is byte-identical to §2.3 afterward.
- If a tweak changes the *shape* (e.g. renaming `hpPct`→`hp`, or `result` casing), BOTH sides
  change in lockstep. Because A0 (prompt) and A (parser) merge at different gates, a post-Merge-2
  shape change means re-opening BOTH branches — costly, hence the freeze.

---

## 3. Sync Points / Wave Gates

Each gate is the convergence of parallel work onto a single pass/fail check, and each maps
to a GITFLOW merge. Gate command set (from PLAN §6 "Verification Summary" and GITFLOW
"Verification Gates"): `npm run build` (clean), `npm test -- --run` (~108 tests + new),
`npm run dev` (loads, both genres), plus the phase-specific manual check.

| Gate | Converges | Pass criteria | GITFLOW merge it gates |
|------|-----------|---------------|------------------------|
| **G-A0** | A0 alone (prompt worktree, 5174) | `npm run build` + `npm test -- --run` green (adjust any exact-string prompt assertions); **manual: a `party` fence appears at the end of the raw Ollama response** | Merge 1: `party/prompt → feat/party-hud` |
| **G-QWEN** | A0 + live Ollama (ml-engineer) | Compliance report delivered: % party-fence presence, JSON validity, check/verdict fidelity. **Advisory gate** — does not block Merge 1 unless it finds a schema break (then §5). | Informs whether Merge 1 proceeds clean or triggers a prompt re-sync first |
| **G-A** | A alone (core worktree, 5175) | `npm run build` + `npm test -- --run` green; **manual: fence absent from chat bubble; React DevTools shows `party` state updates after a DM response** | Merge 2: `party/core (Phase A) → feat/party-hud` |
| **G-INT-A** | A0+A together on feat/party-hud | After Merge 2: `npm run build` + `npm test -- --run` on the integrated base (port 5173). This is the FIRST point producer+consumer run together — the contract is exercised end-to-end here. | Precondition for the party/core rebase + Wave 2 start |
| **G-BCD** | B+C+D serial in core (rebased) | `npm run build` + `npm test -- --run` green (new PartyStrip/DiceChip/HistoryPanel tests); **manual: strip on narrow viewport; turn-pill+dot desktop-only; dice chip bare→resolved** | Merge 3: `party/core (A+B+C+D) → feat/party-hud` |
| **G-TEST** | TEST-CODE in core | `npm test -- --run` — all tests pass (the full ~108 + all new) | Re-merge of test tranche into feat/party-hud |
| **G-FINAL** | whole feature | `npm run build` + `npm test -- --run` + `npm run dev`; both themes render (dnd Candle-lit, starwars Crimson Void, no FX bleed) | Final merge: `feat/party-hud → master` |

**Within-Wave-2 micro-gates:** B, C, D each have their own `build`+`test` checkpoint (PLAN §6
phase gates). They are serial commits on `party/core`; a phase that fails its checkpoint is
fixed in that phase's commit before the next phase starts (GITFLOW Risk #3 — never defer).
Only the rolled-up **G-BCD** gates Merge 3.

**Ordering invariant (from GITFLOW, do not reorder):** G-A0/Merge 1 strictly precedes
Merge 2, which precedes the rebase, which precedes Wave 2. The Phase-D prompt edits ride on
`party/core` (so they sit on top of the already-merged A0 prompt text) — there is no second
`party/prompt` merge in the normal path.

---

## 4. Shared-File Conflict Map

| File | Writer(s) | Phase / Worktree | Risk | Mitigation |
|------|-----------|------------------|------|------------|
| `src/lib/context.js` | **llm-architect** (A0 party text) THEN **react-specialist** (D check/verdict text) | A0 in `party/prompt`; D in `party/core` | **HAZARD** — two different agents in two different worktrees edit the same file at different waves. ml-engineer ALSO reads this prompt (never writes). | A0 text merges to feat/party-hud first (Merge 1). Core rebases onto that, so when D appends the check/verdict paragraph it sits on top of A0's party paragraph — append-only, no overlap. ml-engineer is read-only here. The frozen contract (§2) keeps both paragraphs schema-consistent. |
| `src/lib/context.starwars.js` | same as above | same | same HAZARD | same mitigation; both files get identical appends per PLAN §2b. |
| `src/App.jsx` | **react-specialist** only | A (state) then B (pass party prop) | LOW — same agent, sequential, same worktree | Serial within core; A→B→C→D never overlap in time. Safe reuse. |
| `src/components/Chat.jsx` | **react-specialist** only | A (parser) then B (wire PartyStrip/HistoryPanel) then C (turn-pill) then D (DiceChip + check/verdict apply) | LOW — same agent, sequential | Heaviest-touched file; touched in all of A,B,C,D but always by one agent in strict order. Safe. |
| `src/components/PartyStrip.jsx` | react-specialist | B (new) | none | new file |
| `src/components/HistoryPanel.jsx` | react-specialist | B | none | single-writer |
| `src/components/DiceChip.jsx` | react-specialist | D (new) | none | new file |
| `src/App.css` | react-specialist | B, C, D (append-only) | LOW (intra-branch) | Append-only rule (THEMING-WORKTREE-PLAN EOF rule); single writer. GITFLOW notes possible merge conflict only if two branches append — they don't here. |
| `*.test.jsx` / `*.test.js` | **test-automator** only | Wave 3, `party/core` | MEDIUM — same worktree as react-specialist's source | Serialize: TEST-CODE runs AFTER D is committed and react-specialist is done in core. Never run react-specialist and test-automator concurrently on the same checkout. |

**Two flagged hazards, restated:**
1. **`context.js` A0/D + ml-engineer hazard** — the prompt file is written by two agents
   (A0 then D) across two waves and read by a third (ml-engineer). Safe ONLY because the
   edits are append-only and A0 merges before core rebases. The schema freeze (§2.6) is what
   prevents A0's party text and D's check/verdict text from drifting apart.
2. **`Chat.jsx`/`App.jsx` A↔B/C/D reuse** — same files reused across phases but always the
   SAME agent (react-specialist) in strict serial order in ONE worktree. **Safe** — no
   cross-agent contention, no concurrent writers.

---

## 5. Re-sync / Failure Protocol

### 5.1 Model won't comply with the schema (the contract ripple)

Symptom: ml-engineer (G-QWEN) reports the model omits/mis-emits a block, or emits a shape
that violates §2.3 (wrong key, wrong casing, `id` present, `result` not PASS/FAIL).

- **Classify the fix:**
  - **Wording-only** (model needs clearer instruction, shape unchanged): re-sync is
    PROMPT-ONLY. ml-engineer hands findings to llm-architect → llm-architect edits
    `party/prompt` → re-run G-A0 (+ re-validate with ml-engineer) → re-merge (Merge 1).
    Parser untouched. llm-architect confirms emitted shape still matches §2.3.
  - **Shape change** (a key/type/literal must change, or graceful-fallback can't absorb it):
    this trips §2.6. BOTH the prompt (llm-architect/`party/prompt`) AND the parser
    (react-specialist/`Chat.jsx` `BLOCK_TAGS`/`extractBlock`/`applyPartyUpdate`) change in
    the SAME wave. Orchestrator pauses dependent merges until both are ready, then merges
    prompt first, then parser — preserving the G-A0→G-A order.
- **ml-engineer never edits code.** All proposals route back through llm-architect (prompt)
  and, if shape-affecting, the orchestrator tasks react-specialist with the matching parser change.
- **Default disposition:** PLAN §2d/§OQ-9 say imperfect compliance for the conditional
  `check`/`verdict` is acceptable — graceful fallback keeps chips bare. So most QWEN findings
  are "tighten wording, accept residual non-compliance," NOT a shape change. Reserve the
  lockstep shape re-sync for genuine contract breaks.

### 5.2 A gate fails mid-wave

- **G-A0 / G-A fail (build or test):** the owning agent fixes in-place on their branch
  before any merge. No merge occurs on a red gate (GITFLOW Risk #3). If failure is an
  exact-string prompt assertion (expected for A0), update the expected value in the same commit.
- **A B/C/D micro-gate fails:** fix within that phase's commit before starting the next
  phase. Do not advance the serial B→C→D chain past a red checkpoint.
- **G-INT-A fails (A0+A together, post-Merge-2):** this is a CONTRACT failure — producer and
  consumer disagree at runtime (e.g., fence not stripped, party state never updates). Treat
  as §5.1 shape/wording triage: determine whether the prompt emits what the parser expects
  per §2.3. Fix on the originating branch; because both are already merged, this means a
  follow-up commit to feat/party-hud (or re-opening the relevant branch) — exactly the
  expensive path the freeze exists to avoid.
- **G-TEST fails:** if a test exposes a real bug, route the fix to react-specialist (source)
  or llm-architect (prompt) per the file owner in §4; test-automator only changes tests if
  the test itself is wrong. Re-run G-TEST.

### 5.3 Merge conflict at a gate

- **Defer entirely to GITFLOW "Conflict Resolution Policy."** Expected conflicts are
  `App.css` (append-both, EOF rule) and rarely `App.jsx`/`Chat.jsx` (interleave both logical
  changes, delete neither). The orchestrator resolves, `git add`, `git commit` the in-progress
  merge.
- **Coordination addendum:** if a conflict in `context.js`/`context.starwars.js` appears at
  Merge 3 (because D appended check/verdict text), it means the rebase onto merged-A0 did not
  take cleanly. Resolution MUST preserve BOTH the A0 party paragraph and the D check/verdict
  paragraph (append-both), and llm-architect should sanity-check the merged prompt still
  matches §2.4. Do NOT drop either paragraph to "resolve" the conflict.
- After any conflict resolution, re-run the full gate command set before declaring the merge passed.

### 5.4 Escalation / pause authority

The orchestrator (main Claude) may pause a wave at any gate. Triggers to pause:
- G-QWEN reports a shape break (→ §5.1 lockstep).
- Any gate red after one in-place fix attempt by the owning agent.
- A merge conflict touching the frozen-contract files (`context.*`, parser in `Chat.jsx`).
On pause, no new agent is spawned and no merge runs until the blocking item is resolved on its branch.

---

## 6. Spawn Plan (orchestrator quick-reference)

1. **Wave 1:** spawn **llm-architect** (A0, prompt worktree) and **react-specialist** (A, core
   worktree) in PARALLEL. Spawn **qa-expert** (QA-PLAN, read-only) in parallel too — it has no
   code dependency. When A0 is testable on 5174, spawn **ml-engineer** (QWEN) against it.
2. **Gate G-A0** → Merge 1. **Gate G-A** → Merge 2. (Order fixed.) Then **G-INT-A**.
3. Rebase `party/core` per GITFLOW.
4. **Wave 2:** spawn **react-specialist** for B→C→D (serial, single agent). Hold each phase
   micro-gate; roll up to **G-BCD** → Merge 3.
5. **Wave 3:** with D committed and QA-PLAN in hand, spawn **test-automator** (TEST-CODE,
   core worktree, tests only). **G-TEST** → re-merge.
6. **G-FINAL** → final merge to master (GITFLOW). Then GITFLOW cleanup (remove worktrees,
   delete branches).

Brief every agent with: their worktree path + branch + port, the exact files they may write
(§0), the relevant PLAN sections, and — for llm-architect and react-specialist — the frozen
contract (§2) as their immutable interface.

---

End of PARTY-HUD-COORDINATION.md
