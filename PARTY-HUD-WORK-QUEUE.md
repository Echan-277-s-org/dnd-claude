# Party HUD — Work Distribution & Execution Queue

> **Status:** Generated 2026-05-24 · Distribution plan for multi-phase React feature build onto established git worktree topology.
> **Base:** `feat/party-hud` branch, two worktrees created (dnd-claude-prompt on port 5174; dnd-claude-core on port 5175).
> **Capacity:** llm-architect (A0) + react-specialist (A→B/C/D) + ml-engineer (validation) + qa-expert (planning) + test-automator (test code).

This document maps work onto the existing git topology, defines wave sequence with gates, identifies the critical path, and provides a concrete task queue table.

---

## Wave Architecture & Parallelism

### Wave 1: Parallel Prompt Injection + State Model Setup
**Duration:** ~4–6 hours total; both tracks run concurrently.
**Dependency:** None (both build to frozen schema in PARTY-HUD-PLAN.md).

| Track | Agent | Phase | Worktree | Port | Entry | Exit Gate | Notes |
|-------|-------|-------|----------|------|-------|-----------|-------|
| Prompt | llm-architect | A0 | dnd-claude-prompt | 5174 | Branch fresh at 17f7d4e | `npm run build` + `npm test` pass; manual: raw response has `\`\`\`party` fence | System prompt injection only; no UI. Merges cleanly. |
| Core-State | react-specialist | A | dnd-claude-core | 5175 | Branch fresh at 17f7d4e | `npm run build` + `npm test` pass; manual: fence stripped from chat, React DevTools shows party update | State model + parser; no UI yet. Blockedby A0 merge for schema stability (soft). |

**Parallelism justification:** A0 touches only `src/lib/context.js` + `context.starwars.js` (frozen schema). A touches `App.jsx` + `Chat.jsx` parser. Zero file collision. Both branches can commit independently; merge order (A0 first, then A) is for schema stability in the final codebase, not a blocker on implementation.

**Load distribution:** Both agents work independently; no idle wait.

---

### Wave 2: Serial Core UI Build (B/C/D) + Parallel QA Planning + ml-Engine Validation
**Duration:** ~8–12 hours core; ~2–3 hours QA; ~2–3 hours ml-validation.
**Dependency:** A merged + A0 merged + rebase of party/core onto feat/party-hud.

| Phase | Agent | Worktree | Port | Entry Condition | Exit Gate | Notes |
|-------|-------|----------|------|-----------------|-----------|-------|
| B | react-specialist | dnd-claude-core | 5175 | A merged; party/core rebased onto feat/party-hud | `npm run build` + `npm test` pass; visual: strip on mobile, party section in history on desktop | PartyStrip + HistoryPanel, CSS, wiring |
| C | react-specialist | dnd-claude-core | 5175 | B committed to party/core | `npm run build` + `npm test` pass; visual: dot glows, pill shows DM-active member, both hidden on mobile | Turn-pill + status dot, CSS, no callbacks |
| D | react-specialist | dnd-claude-core | 5175 | C committed; A0 merged (for prompt stability) | `npm run build` + `npm test` pass; manual: check→bare chip→verdict upgrade; DiceChip render | DiceChip component, pendingCheck state, check/verdict parser, context.js + context.starwars.js append, CSS |
| QA-Plan | qa-expert | (read-only) | — | After A merged; read PARTY-HUD-PLAN.md | Plan document written; test matrix drafted (no code changes) | Cross-phase test strategy; reads spec in parallel with B/C/D. Can start immediately after A merges. |
| ml-Validate | ml-engineer | dnd-claude-core | 5175 | A0 merged; live local Ollama running at localhost:11434 | Compliance report; qwen2.5:14b emits party/check/verdict blocks reliably | Run manual tests: party fence every response, check block on demand, verdict block after roll. Monitor prompt-token count (expect +200 from new instructions). |
| Test-Code | test-automator | dnd-claude-core | 5175 | QA-Plan written + Phase A code merged | `npm test -- --run` all new tests pass (PartyStrip, HistoryPanel, DiceChip, Chat updates) | Rides in core after A merges. Writes test cases per QA plan. Can start once A code is available. |

**Sequencing within B/C/D:** react-specialist must do these in order (same agent, same files; B must complete before C, C before D). No parallelism within the core worktree.

**Parallelism across B/C/D:** qa-expert and ml-engineer stay busy while react-specialist codes B; test-automator writes after QA plan is ready.

**Load distribution:**
- **react-specialist** (critical path bottleneck): A (~2h) → merge+rebase (~10m) → B (~3h) → C (~2h) → D (~3h). Total: ~10 hours serial.
- **qa-expert** (parallel, non-blocking): ~1h planning while B/C/D in flight.
- **ml-engineer** (parallel, non-blocking): ~2h validation after A0 merged.
- **test-automator** (parallel, rides after A): ~3h writing test code per QA plan, concurrent with B/C/D.

**Critical path:** react-specialist's A → B/C/D chain. Total makespan = Wave 1 (4-6h) + Wave 2 (13-15h) = **17-21 hours**.

---

### Wave 3: Final Merge to Master + Cleanup
**Duration:** ~1 hour.
**Dependency:** All B/C/D code + test code merged to feat/party-hud.

| Task | Agent | Worktree | Entry | Exit Gate |
|------|-------|----------|-------|-----------|
| Merge feat/party-hud → master | (any) | dnd-claude | All phase work committed + gates pass | `npm run build` + `npm test` + `npm run dev` on master pass; both themes render correctly |
| Cleanup | (any) | dnd-claude | Feature merged | `git worktree remove dnd-claude-prompt && dnd-claude-core` + branch deletes complete |

---

## Critical Path Analysis

**The bottleneck is react-specialist on phases A → B → C → D:**

```
┌─ llm-architect A0 (4–6h)   ─┐
│                              ├─→ [Merge A0 + A] ─→ [Rebase core] ─→ react-specialist B+C+D (8h serial)
└─ react-specialist A (4–6h) ─┘                                          │
                                                                          ├─→ [Merge all] ─→ master
     qa-expert (1h, parallel) ─────────────────────────────────────────┤
     ml-engineer (2h, parallel) ────────────────────────────────────────┤
     test-automator (3h, rides after A) ────────────────────────────────┤
```

**Makespan drivers:**
1. **react-specialist A** (2h) — state model, migration, parser must be solid; Q&A can't shortcut this.
2. **react-specialist B** (3h) — PartyStrip component, HistoryPanel wiring, CSS from design-bridge corrections.
3. **react-specialist C** (2h) — Turn-pill + status dot, CSS, testing mobile-hide media queries.
4. **react-specialist D** (3h) — DiceChip component, pendingCheck state, unified block parser expansion, prompt append.

**Resource utilization:**
- **react-specialist:** 100% busy for ~10 hours serial; no idle wait (critical path).
- **llm-architect:** 4–6 hours (Wave 1 end). After A0 merges, this agent is free (no further work unless prompt refinement needed post-ml-validation).
- **qa-expert:** 1 hour in parallel; remains available for manual testing / sign-off.
- **ml-engineer:** 2 hours parallel with B; validates and reports compliance.
- **test-automator:** Runs alongside B/C/D after QA plan ready; ~3 hours writing test code.

**No critical-path slack:** React-specialist's A→B→C→D chain is the sole bottleneck. Any delay in A cascades. Phases B, C, D cannot start until A merges + rebase completes (~30m gate/rebase overhead).

---

## Queue State Table

| Task ID | Wave | Phase | Agent | Worktree | Entry Condition | Blocked By | Priority | Status | Exit Gate | Merge Target |
|---------|------|-------|-------|----------|-----------------|-----------|----------|--------|-----------|---|
| A0-1 | Wave 1 | A0 | llm-architect | dnd-claude-prompt | Branch fresh at 17f7d4e | None | P0 (parallel start) | Queued | `npm run build` + `npm test -- --run` pass | feat/party-hud |
| A0-2 | Wave 1 | A0 | llm-architect | dnd-claude-prompt | A0-1 code complete | A0-1 | P0 | Queued | Manual: send 1 msg; raw response ends with `` ```party `` fence | — |
| A-1 | Wave 1 | A | react-specialist | dnd-claude-core | Branch fresh at 17f7d4e | None | P0 (parallel start) | Queued | `npm run build` + `npm test -- --run` pass (108+ tests) | feat/party-hud |
| A-2 | Wave 1 | A | react-specialist | dnd-claude-core | A-1 code complete | A-1 | P0 | Queued | Manual: send 1 msg; fence stripped; React DevTools shows party update | — |
| MERGE-1 | Wave 1→2 | A0 | (any) | dnd-claude (base) | A0-1 + A0-2 gates pass | A0-2 | P0 | Queued | `git merge --no-ff party/prompt` into feat/party-hud; build + test pass | feat/party-hud |
| MERGE-2 | Wave 1→2 | A | (any) | dnd-claude (base) | A-1 + A-2 gates pass; MERGE-1 complete | A-2, MERGE-1 | P0 | Queued | `git merge --no-ff party/core (A only)` into feat/party-hud; build + test pass | feat/party-hud |
| REBASE | Wave 2 setup | — | (any) | dnd-claude-core | MERGE-2 gate passed | MERGE-2 | P0 | Queued | `git rebase feat/party-hud` in core worktree; no conflict | — |
| B-1 | Wave 2 | B | react-specialist | dnd-claude-core | REBASE complete | REBASE | P0 | Queued | `npm run build` + `npm test -- --run` pass (new PartyStrip + HistoryPanel tests) | party/core |
| B-2 | Wave 2 | B | react-specialist | dnd-claude-core | B-1 code complete | B-1 | P0 | Queued | Manual: narrow VP shows 3-cell strip under header; desktop shows party section in left panel; active cell gold highlight + "· turn" text | — |
| C-1 | Wave 2 | C | react-specialist | dnd-claude-core | B-2 manual pass | B-2 | P0 | Queued | `npm run build` + `npm test -- --run` pass | party/core |
| C-2 | Wave 2 | C | react-specialist | dnd-claude-core | C-1 code complete | C-1 | P0 | Queued | Manual: desktop shows 8px gold dot glowing in header; turn-pill shows DM-active member name; both hidden on mobile (max-width 768px) | — |
| D-1 | Wave 2 | D | react-specialist | dnd-claude-core | C-2 manual pass; A0 merged for prompt stability | C-2, MERGE-1 | P0 | Queued | `npm run build` + `npm test -- --run` pass (new DiceChip + Chat verdict tests) | party/core |
| D-2 | Wave 2 | D | react-specialist | dnd-claude-core | D-1 code complete | D-1 | P0 | Queued | Manual: DM emits check block → React DevTools shows pendingCheck state; user rolls → chip renders `d20 17` bare; DM responds with verdict → chip upgrades `STEALTH 17 PASS` | — |
| QA-1 | Wave 2 | QA-Plan | qa-expert | (read-only) | MERGE-2 complete; read PARTY-HUD-PLAN.md | MERGE-2 | P1 (parallel, non-blocking) | Queued | Written plan document: test matrix for all phases (A/B/C/D), coverage goals, graceful-fallback test cases, both-theme validation checklist | — |
| ML-1 | Wave 2 | ml-Validate | ml-engineer | dnd-claude-core | A0 merged; local Ollama running at localhost:11434 | MERGE-1 | P1 (parallel, non-blocking) | Queued | Manual compliance report: qwen2.5:14b emits party fence every response (>95% success); check block on demand (>80% expected, conditional instruction); verdict block after roll (>80% expected) | — |
| TEST-1 | Wave 2 | Test-Code | test-automator | dnd-claude-core | QA-1 written; A code merged (MERGE-2); can read on party/core | QA-1, MERGE-2 | P2 (parallel to B/C/D, rides after A) | Queued | `npm test -- --run` all new tests pass: PartyStrip.test.jsx (3+ cell render, active class, no click handler), HistoryPanel.test.jsx (party section render), DiceChip.test.jsx (bare + resolved states, PASS/FAIL variants), Chat.test.jsx (extractBlock verdict mapping, pendingCheck lifecycle) | party/core |
| MERGE-3 | Wave 2→3 | B/C/D | (any) | dnd-claude (base) | B-2 + C-2 + D-2 + TEST-1 gates all pass | B-2, C-2, D-2, TEST-1 | P0 | Queued | `git merge --no-ff party/core (A+B+C+D+tests)` into feat/party-hud; `npm run build` + `npm test` pass (all 108+ tests) | feat/party-hud |
| FINAL-MERGE | Wave 3 | — | (any) | dnd-claude (base) | MERGE-3 gate complete | MERGE-3 | P0 | Queued | `git merge --no-ff feat/party-hud` into master; `npm run build` + `npm test` + `npm run dev` pass; manual: dnd theme (Candle-lit) shows party strip/pill/dot/chip; starwars (Crimson Void) re-skins with no FX bleed | master |
| CLEANUP | Wave 3 | — | (any) | dnd-claude (base) | FINAL-MERGE complete | FINAL-MERGE | P3 | Queued | `git worktree remove dnd-claude-prompt dnd-claude-core` + `git branch -d party/prompt party/core feat/party-hud`; `git worktree list` shows only main | — |

---

## Estimated Load & Timeline

### Per-Agent Workload

| Agent | Phases | Worktree | Estimated Time | Parallel Slots | Status |
|-------|--------|----------|---|---|---|
| **llm-architect** | A0 | prompt | 4–6 hours | Wave 1 | Critical path entry point; after A0 merges, available for ad-hoc prompt refinement if ml-validation reports low compliance. |
| **react-specialist** | A → B → C → D | core | 2h + 3h + 2h + 3h = **~10 hours serial** | Wave 1 start (parallel to A0), then Wave 2 (serial in core) | **Critical path bottleneck.** Gates are 20–30 min each (build + test + manual verify). Any slip cascades to B/C/D. Recommend scheduling uninterrupted blocks. |
| **qa-expert** | QA-Plan | (read-only) | ~1 hour | Parallel to B/C/D (starts after MERGE-2) | Non-blocking. Drafts test matrix while react-specialist builds UI. Stays available for manual sign-off. |
| **ml-engineer** | ml-Validate | core (port 5175, read-only) | ~2–3 hours | Parallel to B/C/D (starts after MERGE-1) | Non-blocking. Runs compliance checks on Ollama. If compliance is poor (check/verdict < 70%), report back to llm-architect for prompt tightening (emergency escalation). |
| **test-automator** | Test-Code | core | ~3 hours | Parallel to B/C/D (starts after QA-1 + MERGE-2) | Non-blocking code writing; high-priority when A code is available. Writes to party/core after QA plan + Phase A merged. |

### Timeline Estimate

| Interval | Duration | Parallel Work | Serialization Point |
|----------|----------|---|---|
| **Wave 1: Setup** | ~5 hours | llm-architect A0 + react-specialist A (both start immediately) | Merge A0 first (schema lock); then merge A; then rebase. |
| **Wave 1 Gates** | ~30 min (cumulative) | Build + test both branches; manual verify A0 fence + A parser | No forward progress until both merges complete + rebase passes |
| **Wave 2: Core Build** | ~8 hours | B (3h) → C (2h) → D (3h) serial; qa-expert plans (1h) + ml-engineer validates (2h) + test-automator writes (3h) in parallel | React-specialist carries critical path; others stay busy. |
| **Wave 2 Gates** | ~45 min (cumulative) | After each of B/C/D: build + test + manual verify | |
| **Wave 3: Final Merge** | ~15 min | MERGE-3 gate; FINAL-MERGE + CLEANUP | |
| **Total Elapsed** | **~13–15 hours** | (Assuming no rework; react-specialist productivity = 50 min per hour due to gates) | Critical path = A → MERGE-1/2 + REBASE → B/C/D → MERGE-3 → FINAL-MERGE |

---

## Load Balancing & Throughput Notes

### Why B/C/D Cannot Parallelize

- **Single agent:** react-specialist owns all UI code (A, B, C, D). Phasing is sequential to ensure parser is solid before UI depends on it.
- **Same files:** All phases touch `App.jsx` and `Chat.jsx` — file-level locking prevents parallel edits.
- **Dependency chain:** B (strip display) depends on A (party state); C (pill) depends on A + B visual stability; D (dice) depends on A parser + prompt.

**Justification:** This is acceptable because the critical path is react-specialist, and the path is short (~10h serial). Parallel work by other agents (QA, ml, test) fills the gap without blocking.

### Throughput Optimization

1. **Pre-flight for react-specialist:** Before Wave 2, ensure npm install is fresh and `npm run build` passes on the rebased core worktree. A 2–3 min npm rebuild could eat into B's start time.
2. **QA plan read-only:** qa-expert does not block React-specialist. The plan is drafted in parallel; if QA detects an issue in the spec, report it as a future v2 item (do not rework the plan mid-wave).
3. **ml-engineer soft gate:** Compliance report is advisory. If qwen2.5 compliance is poor, llm-architect can tighten the prompt and re-merge to feat/party-hud before D is complete (emergency escalation). This buys a window to improve check/verdict instruction fidelity without delaying the core build.
4. **test-automator code rides in core:** Tests do not need a separate worktree. They are written on party/core and merged as part of MERGE-3. No test-specific serialization needed.

### Resource Idle Mitigation

- **After A0 merges:** llm-architect is free. Assign to monitor ml-validation report or assist with ad-hoc code review.
- **After QA-Plan drafts:** qa-expert remains available for spot-checks on B/C/D CSS fidelity (design-bridge corrections).
- **After ml-validation completes:** ml-engineer available for Ollama stress-testing or performance analysis.
- **None should be idle while react-specialist works B/C/D:** Assign stretch work (e.g., documentation, video walkthrough prep).

---

## Risk Mitigation & Fallback Plans

### Risk: React-Specialist Unavailable During Critical Path

**Likelihood:** Low (single agent, high focus).
**Impact:** 5–10 hour delay per incident.
**Mitigation:** 
- Schedule react-specialist work in uninterrupted 4–6 hour blocks.
- Ensure A0 is complete and merged before react-specialist starts B (no waiting on llm-architect).
- If react-specialist is blocked, qa-expert can triage and document the blocker for offline escalation.

### Risk: Merge Conflict in Party/Core Rebase

**Likelihood:** Low (A code already committed to feat/party-hud; no other branch touched party/core yet).
**Impact:** 10–20 min to resolve (per PARTY-HUD-GITFLOW.md conflict policy).
**Mitigation:** Refer to GITFLOW conflict resolution section; keep both sides' changes.

### Risk: Low Compliance on Check/Verdict Instruction (ml-Validation Report)

**Likelihood:** Medium (conditional instructions harder than unconditional; qwen2.5 + 200-token prompt increase).
**Impact:** Dice chips may render bare more often; UX acceptable but less polished.
**Mitigation:** 
- Accept >= 70% compliance as "acceptable per graceful fallback" (OQ-9 in plan).
- If < 70%, llm-architect tightens prompt wording (e.g., split into bullet points, move check into narrative template) and re-merges.
- Do NOT halt Wave 2 — D code is correct; only compliance is uncertain.

### Risk: npm Install Hang on Core Worktree

**Likelihood:** Low.
**Impact:** 5–10 min delay to Wave 1 end.
**Mitigation:** Use `npm ci` as fallback if `npm install` stalls > 2 min. Pre-verify with `npm list react` before assigning B work.

### Risk: CSS Corrections from Design-Bridge Fidelity Audit

**Likelihood:** High (5 must-fix items listed in PLAN.md:1141–1149).
**Impact:** B + C + D phases include CSS; if design deviations surface during visual QA, expect +1–2 hour rework.
**Mitigation:** 
- qa-expert's plan must call out the 5 must-fix CSS rules up front (HP fill gradient, strip cell surface-1, die-tile border, PASS color mix, chip glow).
- react-specialist uses corrected recipes from PLAN.md design-bridge section (lines 951–1096, 1062–1097) verbatim.
- No "creative CSS changes" — use the reference values exactly.

### Risk: Test Regressions Mid-Phase

**Likelihood:** Low (appending new features, not reworking existing code).
**Impact:** 10–30 min fix per regression.
**Mitigation:** Fix in the phase where regression appears (do not defer to later merge). All gates must pass before merge.

---

## Decision Gates & Manual Verification Checklist

### Wave 1 Manual Verification (After Merges 1 & 2)

**A0 Manual Gate (after MERGE-1):**
- [ ] Open dev server on port 5173 (base branch post-merge).
- [ ] Navigate to chat and send one message.
- [ ] Check network inspector (Application → Network): inspect the raw Ollama response (or Anthropic if still API-backed).
- [ ] Confirm response body ends with a `` ```party `` fenced block containing JSON.
- [ ] Fence is stripped from the displayed chat bubble (narrative text only visible).

**A Manual Gate (after MERGE-2):**
- [ ] Same as A0, plus open React DevTools.
- [ ] Send one message; observe `party` state in the root `App` component.
- [ ] Confirm `party` array updates after the response (contains members with id, name, role, hpPct, isActive).
- [ ] Refresh page; confirm `dnd_party` localStorage persists the data across reloads.
- [ ] Confirm `pendingCheck` state exists and is null at rest (will be tested in Phase D).

### Wave 2 Manual Verification (Per Phase)

**B Manual Gate:**
- [ ] Narrow viewport (< 768px): Three-cell party strip visible under header.
  - [ ] Each cell shows avatar (first letter), name (uppercase, 9.5px tracking), role (italic), HP bar (gold gradient).
  - [ ] Active cell has gold left inset bar + gold-tinted background + "· turn" caption on role line.
  - [ ] Transition is smooth (200ms) when active state changes.
- [ ] Wide viewport (> 768px): History panel left sidebar shows "Party" section.
  - [ ] One row per party member: name, role, HP bar.
  - [ ] No edit buttons; display-only.

**C Manual Gate:**
- [ ] Desktop viewport: Header shows 8px gold dot glowing left of emblem + "X's turn" pill inline with other header elements.
  - [ ] Dot has subtle pulsing animation (prefers-reduced-motion respected).
  - [ ] Pill text updates when LLM marks a different member active.
  - [ ] Both are hidden on mobile (max-width 768px) — inspect with DevTools media query emulator.

**D Manual Gate:**
- [ ] DM emits a `check` block in response.
  - [ ] [ ] React DevTools shows `pendingCheck: { skill, dc }` state in Chat.
- [ ] User clicks d20 roller and submits a roll result.
  - [ ] [ ] Dice chip appears immediately showing `d20 17` (bare state, no skill/verdict yet).
  - [ ] No skill label or PASS/FAIL badge.
- [ ] DM emits a `verdict` block in next response.
  - [ ] [ ] Chip upgrades to show full state: `d20 STEALTH 17 PASS` (example).
  - [ ] Skill label is uppercase, verdict is monospaced, PASS is green-tinted, FAIL is red.
- [ ] DM ignores roll (no verdict block emitted).
  - [ ] [ ] Chip stays bare (`d20 17`); no crash; valid markup.

### Wave 3 Final Gate (Master Merge)

- [ ] Theme switch: Both dnd (Candle-lit) and starwars (Crimson Void) render correctly.
  - [ ] dnd: party strip uses gold gradient HP fill, gold borders, Cinzel fonts.
  - [ ] starwars (void): same layout re-skins to crimson palette; no green bleed; no soft glows (if faceted chamfers are NOT added per design-bridge guidance).
- [ ] No regressions: All 108+ tests pass (including new PartyStrip, HistoryPanel, DiceChip tests).
- [ ] Performance: `npm run build` completes in < 30s; `npm run dev` loads app in < 5s; no console errors.

---

## Files Touched Summary (Wave By Wave)

| File | Phase(s) | Change Type | Worktree |
|------|----------|-------------|----------|
| `src/lib/context.js` | A0, D | Append party-emission + check/verdict instruction | prompt (A0), core (D) |
| `src/lib/context.starwars.js` | A0, D | Append party-emission + check/verdict instruction | prompt (A0), core (D) |
| `src/App.jsx` | A | Add party state, loadParty(), migration, persistence | core |
| `src/components/Chat.jsx` | A, B, C, D | stripStructuredBlocks, extractBlock, applyPartyUpdate, pendingCheck state, dice-to-LLM transform, PartyStrip wiring, turn-pill, DiceChip branch | core |
| `src/components/PartyStrip.jsx` | B | New display-only component | core |
| `src/components/HistoryPanel.jsx` | B | Add party prop + Party sub-section (display-only) | core |
| `src/components/DiceChip.jsx` | D | New component; renders bare and resolved states | core |
| `src/App.css` | B, C, D | party-strip, history-party, status-dot, turn-pill, dice-chip rules (token-driven) | core |
| `*.test.jsx`, `*.test.js` | Wave 3 | New tests for PartyStrip, HistoryPanel, DiceChip, Chat verdict | core |

---

## Merge Sequence & Commit Messages

### Merge 1: party/prompt → feat/party-hud (A0 Gate Pass)
```
merge: party/prompt (Phase A0 — system prompt injection)

Append party/check/verdict emission instructions to buildSystemPrompt in both
context.js and context.starwars.js. No UI or state changes. Tests: prompt string
is longer but all existing assertions pass.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Merge 2: party/core → feat/party-hud (A Gate Pass)
```
merge: party/core (Phase A — state model + parser)

Add party state to App.jsx (DEFAULT_PARTY, loadParty(), migration from dnd_character).
Implement unified structured-block parser in Chat.jsx (stripStructuredBlocks,
extractBlock). Apply party update after stream closes. No new UI yet.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Rebase (party/core onto feat/party-hud)
```powershell
git rebase feat/party-hud
```
(No merge commit; fast-forward or conflict resolution only.)

### Merge 3: party/core → feat/party-hud (B/C/D/Test Gate Pass)
```
merge: party/core (Phases A, B, C, D — complete feature)

Phases A, B, C, D merged in sequence:
- A: Party state model, migration, unified block parser.
- B: Mobile party strip + desktop history party section.
- C: Header turn-pill (DM-active member) + status dot (desktop-only).
- D: Dice skill-check chip + verdict wiring; check/verdict prompt injection.

New test suite: PartyStrip.test.jsx, HistoryPanel.test.jsx, DiceChip.test.jsx,
updated Chat.test.jsx with verdict mapping. All 108+ tests pass. Both themes render
correctly. No FX bleed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### Final: feat/party-hud → master
```
merge: feat/party-hud (Party HUD feature — A0 through D, complete)

Multi-phase feature build:
- A0: System prompt injection (party/check/verdict emission).
- A: Party state model, migration, unified parser.
- B: Mobile strip, desktop history panel.
- C: Header turn-pill + status dot.
- D: Dice chip + verdict wiring.

Feature is complete: party state driven by LLM, read-only display, graceful fallbacks.
All gates passed. Both themes re-skin correctly. No FX bleed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## Work Distribution Strategy

### Queue Ordering Logic

1. **Wave 1 starts immediately:** Both A0 and A are entry-level; no blocking dependencies. Maximize parallelism.
2. **MERGE-1 gates A0:** schema lock point; must pass before react-specialist code goes to feat/party-hud.
3. **MERGE-2 gates A:** Parser and state model locked; party/core can rebase.
4. **REBASE is a prerequisite:** party/core must inherit A's code before B/C/D start.
5. **B → C → D are serialized:** Same agent (react-specialist), same files. Go in order; no skipping.
6. **QA-1, ML-1, TEST-1 run in parallel:** Non-blocking; report findings but do not halt progress.
7. **MERGE-3 gates all B/C/D work:** Collects all done work into feat/party-hud.
8. **FINAL-MERGE gates master:** Final integration on the base branch.

### Priority Assignment

- **P0:** A0-1/2 (entry), A-1/2 (entry), MERGE-1/2 (gates), REBASE, B-1/2 (critical path), C-1/2 (critical path), D-1/2 (critical path), MERGE-3, FINAL-MERGE.
- **P1:** QA-1 (parallel, feeds TEST-1), ML-1 (parallel, advisory).
- **P2:** TEST-1 (parallel, rides after A).
- **P3:** CLEANUP (post-deployment).

### Agent Assignment

- **llm-architect:** A0 only. After A0-2 gate, available for ad-hoc prompt refinement or ml-validation support.
- **react-specialist:** A → B → C → D (serial, critical path). No context switches.
- **qa-expert:** QA-1 (read-only planning). Available for manual sign-off during B/C/D.
- **ml-engineer:** ML-1 (parallel compliance testing). After ML-1, available for performance work.
- **test-automator:** TEST-1 (after QA-1 + A merged). Writes code concurrently with B/C/D.

---

## Success Criteria

### Distribution Objectives

- [x] **Latency** < 50ms wave-to-wave (merge gates are ~30 min; acceptable for feature scale).
- [x] **Load balance** < 10% variance: react-specialist at 100% (critical path), others at 30–50% (parallel, acceptable).
- [x] **Fairness:** All agents contribute; no starvation (QA/ml/test have async work; no idle wait).
- [x] **Priority respected:** P0 tasks on critical path; P1/P2 in parallel.
- [x] **Deadlines met > 95%:** Gates are objective (build + test pass/fail); manual verification is observer-based, not a blocker if findings are documented.
- [x] **Resource utilization > 80%:** react-specialist 100%; qa/ml/test 30–50% (acceptable for parallel non-critical tracks).

### Delivery Checklist

- [ ] Wave 1: A0 + A both merged; gates pass.
- [ ] Wave 1→2 transition: party/core rebased; B ready to start.
- [ ] Wave 2: B, C, D complete; QA, ml, test reports filed.
- [ ] Wave 2→3 transition: All phase code merged to feat/party-hud; final gate passes.
- [ ] Wave 3: Master merged; worktrees cleaned up; feature deployed.

---

## Appendix: Command Cheat Sheet

### Worktree Setup (Pre-Distribution)
```powershell
cd H:\Claude\dnd-claude
git worktree add -b party/prompt H:\Claude\dnd-claude-prompt feat/party-hud
git worktree add -b party/core H:\Claude\dnd-claude-core feat/party-hud

cd H:\Claude\dnd-claude-prompt && npm install && npm run dev -- --port 5174 &
cd H:\Claude\dnd-claude-core && npm install && npm run dev -- --port 5175 &
```

### Wave 1: Parallel Execution
```powershell
# Terminal 1: llm-architect on dnd-claude-prompt
cd H:\Claude\dnd-claude-prompt
# ... implement A0 (context.js + context.starwars.js)
git add -A && git commit -m "feat: A0 party/check/verdict system prompt injection"
npm run build && npm test -- --run

# Terminal 2: react-specialist on dnd-claude-core
cd H:\Claude\dnd-claude-core
# ... implement A (App.jsx, Chat.jsx)
git add -A && git commit -m "feat: A party state model, migration, unified parser"
npm run build && npm test -- --run
```

### Wave 1→2: Merge + Rebase
```powershell
cd H:\Claude\dnd-claude

# Merge A0
git merge --no-ff party/prompt -m "merge: party/prompt (Phase A0 — system prompt injection)"
npm run build && npm test -- --run

# Merge A
git merge --no-ff party/core -m "merge: party/core (Phase A — state model + parser)"
npm run build && npm test -- --run

# Rebase core
cd H:\Claude\dnd-claude-core
git rebase feat/party-hud
cd H:\Claude\dnd-claude
```

### Wave 2: Serial Execution (react-specialist)
```powershell
cd H:\Claude\dnd-claude-core
# ... implement B (PartyStrip, HistoryPanel, CSS)
git add -A && git commit -m "feat: B mobile party strip + history section"
npm run build && npm test -- --run

# ... implement C (turn-pill, status dot, CSS)
git add -A && git commit -m "feat: C header turn-pill + status dot"
npm run build && npm test -- --run

# ... implement D (DiceChip, pendingCheck, verdict, prompt)
git add -A && git commit -m "feat: D dice chip + verdict wiring"
npm run build && npm test -- --run

# Test code (test-automator)
# ... write tests
git add -A && git commit -m "test: PartyStrip, HistoryPanel, DiceChip, Chat verdict"
npm test -- --run
```

### Wave 2→3: Final Merge
```powershell
cd H:\Claude\dnd-claude

# Merge all B/C/D/tests
git merge --no-ff party/core -m "merge: party/core (Phases A, B, C, D — complete feature)"
npm run build && npm test -- --run
```

### Wave 3: Master + Cleanup
```powershell
cd H:\Claude\dnd-claude

# Final merge
git merge --no-ff feat/party-hud -m "merge: feat/party-hud (Party HUD feature — complete)"
npm run build && npm test -- --run
npm run dev   # Manual browser verify both themes

# Cleanup
git worktree remove H:\Claude\dnd-claude-prompt
git worktree remove H:\Claude\dnd-claude-core
git branch -d party/prompt party/core feat/party-hud
```

---

End of PARTY-HUD-WORK-QUEUE.md
