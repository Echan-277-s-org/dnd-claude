# Multiplayer Git Workflow

> **Owner:** git-workflow-manager.
> **Audience:** the top-level coordinator, all design-arc and validation-arc agents.
> **Status:** DESIGN-ARC — defines the Git workflow for the phased multiplayer build.

---

## 1. Branch Model

### Decision: Single long-lived integration branch (`feature/multiplayer`)

**Recommendation:** Use **`feature/multiplayer` as the sole long-lived feature branch** for the entire multiplayer effort. **Do NOT create per-phase sub-branches** (`feature/multiplayer-phase1`, etc.). Instead, commit design artifacts and implementation phases directly to `feature/multiplayer` in order, and rebase against `master` as needed to keep the branch current.

**Rationale:**

- **Concurrency safety.** Multiple agents (design-arc: product-manager, game-developer, qa-expert, test-automator, chaos-engineer, architect-reviewer; validation-arc: code agents + qa/test/chaos execution teams) are working *concurrently on the same feature scope*. A per-phase sub-branch strategy would require merging sub-branches back into `feature/multiplayer` at every phase boundary, introducing merge-commit noise and potential conflicts when design artifacts are revised.
- **Linear handoff trail.** The orchestration plan defines strict sequential gates (D1 → D2 → test-readiness agents → D3 → G1 → V1 → V2 → G3). Keeping all work on a single branch makes the handoff history linear and reviewable in a single `git log feature/multiplayer..master`.
- **No "integration branch" problems.** A per-phase sub-branch pattern typically requires a feature-branch merge back (with a merge commit) and conflicts surface only at merge time. By committing to the single branch and rebasing proactively against `master` changes, conflicts are caught early and resolved as they arise.
- **Easier coordinator tracking.** The coordinator can monitor progress by watching `git log feature/multiplayer`, searching for commit prefixes (`docs:`, `feat:`, etc.) and agent names in trailers to see which stage is done.

**Mechanics:**
- The branch `feature/multiplayer` already exists and is checked out.
- All design-arc artifacts (PRD, architecture, review, QA/test/chaos plans) are committed to `feature/multiplayer` with `docs:` prefix.
- All implementation phases (V1, V2 validation) also commit to `feature/multiplayer` with phase-appropriate prefixes (`feat:`, `test:`, etc.).
- Periodically (when `master` advances), rebase `feature/multiplayer` onto `master` using `git rebase master` to keep the branch current and catch conflicts early.
- The final merge to `master` uses a **merge commit** (not squash) to preserve the full feature history *and* the distinct phase artifacts as separate commits, enabling future bisects and blame of design decisions.

---

## 2. Commit Cadence & Conventions

### 2.1 When commits happen

- **Per design artifact.** Each design-arc agent commits their artifact (PRD, architecture, review, QA/test/chaos plan) **once per artifact stage**, not per draft revision. If an architect-reviewer verdict is REVISE and design-arc loops back, the revised `MULTIPLAYER-ARCHITECTURE.md` (with corrections folded in by game-developer) commits as a fresh commit, not an amend.
- **Per implementation phase.** During V1 validation-arc, each phase (transport spike, state machine, identity/rooms, etc., as defined in `MULTIPLAYER-ARCHITECTURE.md` §3.1 D2.7) generates one or more commits per agent's code changes. Squashing small WIP commits within a phase into logical chunks is encouraged; the goal is readability in `git log`, not "one commit per file."
- **Test-automation & chaos execution.** V2 agents (qa-expert, test-automator, chaos-engineer) commit test implementations, results, and verified reports once per execution cycle.

### 2.2 Commit message format

Use **Conventional Commits** style (already in use in this repo; see recent commits). Format:

```
<type>(<scope>): <subject>

<body (optional, multi-line)>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

**Types for this effort:**
- `docs:` — design artifacts (PRD, architecture, review, QA/test/chaos plans), design docs.
- `feat:` — implementation of multiplayer features (during V1 / V2).
- `test:` — test implementations, test infrastructure, chaos experiments.
- `chore:` — tooling, config, or non-functional changes (e.g. branch setup, CI updates).

**Scope:** optional; if used, name the affected subsystem (e.g., `transport`, `state`, `session`, `server`, `ui`).

**Subject:** imperative, present tense (e.g. "add", "update", "fix"), max ~50 chars.

**Body:** wrap at 72 chars. Used for stage name, agent name, and rationale when non-obvious.

**Examples:**

```
docs(multiplayer): add PRD with hybrid play model recommendation

This is the design-arc D1 artifact defining player personas, join/identity,
and the success criteria for the multiplayer feature.

Stage: D1 (product-manager)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

```
docs(multiplayer): add architecture design with phased build plan

Covers shared-state model, transport choice (WebSocket), single-DM-trigger
mechanism, turn/initiative state machine, and the migration path from
LWW to multiplayer. Includes 5-phase implementation plan and failure-mode
pre-analysis.

Stage: D2 (game-developer)
Inputs: MULTIPLAYER-PRD.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

```
feat(multiplayer/transport): implement WebSocket upgrade from sync-server

Replaces 30s-poll with real-time WebSocket transport for multi-client
state sync. Preserves `.md` save/continue and M7 gate semantics.

Phase: V1 Phase 2 (websocket-engineer)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

**Mandatory trailer:** Every commit in this effort MUST end with exactly this line:
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

## 3. Keeping It Mergeable

### 3.1 Rebase discipline

**Strategy: Rebase `feature/multiplayer` onto `master` whenever `master` advances.**

- The design-arc is relatively stable in terms of conflicting file changes (design docs are isolated under `docs/design/`).
- Implementation (V1) may touch source files that other work (bug fixes, unrelated features) also touches on `master`.
- Proactive rebasing catches conflicts early, prevents "surprise merge breakage," and keeps the feature branch history linear and easy to review.

**Procedure (coordinator or delegated agent):**
```bash
cd H:\Claude\dnd-claude
git fetch origin
git rebase origin/master feature/multiplayer
# If conflicts: resolve, git add, git rebase --continue
git log --oneline feature/multiplayer..master  # Verify no gaps
```

**Rebase vs merge:** Merge commits obscure the feature's actual commit sequence and create "merge-commit busywork." Rebase keeps the feature's commits in order, visible in `git log`, and easy to cherry-pick or bisect.

### 3.2 Design-doc conflict prevention

The design-arc produces multiple artifacts in `docs/design/MULTIPLAYER-*.md` concurrently (e.g., game-developer and qa-expert write their own docs in parallel). To avoid conflicts:

1. **Each artifact is a separate file** — no shared markdown or central "design index" (the orchestration plan is the index).
2. **No `git add -A` or `git add .`** — always use explicit `git add <path1> <path2> ...` with only the intended files. This is especially critical when the coordinator commits at gates or phase boundaries, since other agents may be writing files concurrently.
3. **Per-artifact commits** — each agent commits their own artifact file in one commit; no cross-file editing across artifacts.
4. **"Decisions that flow forward" sections in artifacts** — handoff data lives in markdown, not in a shared JSON or config file, so commits are additive and don't re-write each other's content.

### 3.3 Final merge to `master` (post-G3)

**When the user approves merging to `master` (after G3 sign-off):**

```bash
git checkout master
git merge --no-ff feature/multiplayer -m "merge: multiplayer feature (design + phased implementation)"
```

**Rationale for `--no-ff`:**
- Creates a merge commit, preserving the fact that `feature/multiplayer` is a discrete feature.
- Enables `git log --graph` to show the feature branch history separately from mainline.
- Supports future `git bisect` pinpointing which phase introduced a regression.
- Standard Git Flow / team practice.

**Do NOT squash-merge** — the individual phase commits are valuable for understanding what was implemented when and which design decisions drove each phase.

---

## 4. Gate Awareness

### 4.1 G1 — User Approval (Hard pause)

- **Trigger:** D3 verdict is APPROVE or APPROVE-WITH-CHANGES, and all three test-readiness artifacts exist (`MULTIPLAYER-QA-PLAN.md`, `MULTIPLAYER-TEST-AUTOMATION.md`, `MULTIPLAYER-CHAOS-PLAN.md`).
- **Who:** User reviews the compiled design (PRD + architecture + review + QA/test/chaos plans) and approves.
- **Coordinator action:** If approved, proceed to V1. If changes requested, loop the relevant design-arc stage, re-commit to `feature/multiplayer`, and surface the updated design to the user.
- **Branch state:** The entire design arc lives on `feature/multiplayer`; no commits to `master` until G1 clears and V1 completes (via G3).

### 4.2 G2 — Reviewer Verdict (within design arc)

- **Trigger:** D3 (architect-reviewer) completes `MULTIPLAYER-ARCH-REVIEW.md`.
- **Verdict:** APPROVE, APPROVE-WITH-CHANGES, or REVISE.
  - **APPROVE** — proceed to G1.
  - **APPROVE-WITH-CHANGES** — game-developer updates `MULTIPLAYER-ARCHITECTURE.md` with the must-change list folded in; qa/test/chaos agents refresh their plans against the revised architecture; D3 re-runs. New commits to `feature/multiplayer` for the revised architecture and refreshed plans.
  - **REVISE** — game-developer loops back with the feedback, the test-readiness agents refresh, and D3 re-reviews. Same commit strategy as APPROVE-WITH-CHANGES.
- **Branch state:** All G2 iterations remain on `feature/multiplayer`; no merges or pushes.

### 4.3 G3 — Post-Validation (after V1 & V2)

- **Trigger:** V1 implementation is complete, and V2 agents have executed their plans.
- **Sign-off:** qa-expert quality gates pass, chaos-engineer hypotheses hold, test-automator suite is green in CI.
- **Coordinator action:** If G3 passes, the feature is approved for merge to `master`. User reviews G3 sign-off and approves the merge. If G3 fails, file defects, route fixes to the implementing agent, re-run the failing V2 tasks only.
- **Branch state:** Still on `feature/multiplayer` until user approval to merge.

---

## 5. Coordinator Commit Runbook

This section is for the top-level coordinator to follow when committing checkpoint artifacts at key gates.

### 5.1 At design-arc artifact completion (D1, D2, D2-qa, D2-test, D2-chaos, D3)

**Precondition:** Agent has written the artifact file and submitted it for review (or it is final for the gate).

**Steps:**
1. **Verify the file exists and is complete:**
   ```bash
   cd H:\Claude\dnd-claude
   ls -la docs/design/MULTIPLAYER-<ARTIFACT>.md
   ```
2. **Stage ONLY the artifact file:**
   ```bash
   git add docs/design/MULTIPLAYER-<ARTIFACT>.md
   ```
3. **Verify staging:**
   ```bash
   git status
   # Output should show only the one file under "Changes to be committed"
   ```
4. **Commit with the appropriate type and stage name:**
   ```bash
   git commit -m "docs(multiplayer): add <artifact description>

   Stage: <D1|D2|D3|etc.> (<agent-name>)
   Inputs: <list of referenced artifacts, if any>

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
   ```
5. **Verify the commit:**
   ```bash
   git log --oneline -1
   git show --stat
   ```

### 5.2 At G1 checkpoint (after D3 verdict + all three test-readiness artifacts)

**Precondition:** All design artifacts are committed; user has not yet approved.

**Steps:**
1. **Summarize the design for the user:**
   - Note that all required design artifacts are now on `feature/multiplayer`.
   - List the artifacts: PRD, architecture, review, QA plan, test plan, chaos plan.
   - Point to the review verdict (APPROVE / APPROVE-WITH-CHANGES / REVISE outcome).
   - Provide a link or instructions for the user to review `feature/multiplayer` and approve.
2. **Do NOT commit at this point** — G1 is a user decision gate, not a code gate.
3. **If user requests changes:**
   - Gather the change list.
   - Route relevant agents to loop back (e.g., if architecture changes, game-developer re-runs, then qa/test/chaos refresh, then D3 re-reviews).
   - Commit the updated artifacts to `feature/multiplayer` as fresh commits (following §5.1 pattern).
   - Resurface to the user.
4. **If user approves:**
   - Proceed to V1 implementation.

### 5.3 At phase transitions (during V1 implementation)

**Precondition:** Implementing agent (react-specialist, websocket-engineer, backend-developer, llm-architect) has completed a phase and submitted code/design changes for review.

**Steps:**
1. **Verify the phase is complete** — code compiles, tests pass (or are wired), no obvious issues.
2. **Stage only the changed files in that phase:**
   ```bash
   git add src/<files> server/<files> ...  # Explicit paths, not .
   ```
3. **Commit with the phase name:**
   ```bash
   git commit -m "feat(multiplayer/<phase>): <description>

   Phase: V1 Phase <N> (<agent-name>)
   Completes: <phase name from architecture>

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
   ```
4. **Verify:**
   ```bash
   git log --oneline -1
   git diff HEAD~1 --name-only  # Confirm only intended files changed
   ```

### 5.4 At V2 artifact submissions (qa-expert, test-automator, chaos-engineer execution)

**Precondition:** V2 agent has run their plan against V1 and produced a results/report artifact (or new test code).

**Steps:**
1. **Stage the V2 artifact(s):**
   ```bash
   git add docs/design/<REPORT>.md tests/<test-files> ...
   ```
2. **Commit:**
   ```bash
   git commit -m "test(multiplayer/<agent>): <description>

   Stage: V2-<qa|test|chaos> (<agent-name>)
   Result: <PASS|FAIL|<summary>>

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
   ```
3. **Verify:**
   ```bash
   git status
   # Should be clean
   git log --oneline -3
   # Should show recent commits
   ```

### 5.5 At G3 (post-validation, ready to merge)

**Precondition:** All V2 agents have completed; quality gates pass; user has approved the merge.

**Steps:**
1. **Verify all V2 results are committed:**
   ```bash
   git log --oneline feature/multiplayer..master | wc -l
   # Should show the count of commits not yet on master
   ```
2. **Ensure master is current (no new commits on master since feature started):**
   ```bash
   git fetch origin
   git log --oneline master..feature/multiplayer | head -20
   # Preview what will merge
   ```
3. **Merge to master (user approval required before this step):**
   ```bash
   git checkout master
   git pull origin master  # Ensure local master is current
   git merge --no-ff feature/multiplayer -m "merge: multiplayer feature (design + phased implementation, signed off at G3)"
   git push origin master
   ```
4. **Verify:**
   ```bash
   git log --graph --oneline --all -20
   # Should show feature/multiplayer merged into master
   ```
5. **Post-merge cleanup (optional, coordinator decision):**
   ```bash
   git branch -d feature/multiplayer  # Delete local branch after merge
   git push origin --delete feature/multiplayer  # Delete remote if desired
   ```

---

## 6. Summary

| Aspect | Decision |
|--------|----------|
| **Branch model** | Single `feature/multiplayer` (no per-phase sub-branches). All design + implementation commits directly to it. |
| **Rebase discipline** | Rebase `feature/multiplayer` onto `master` as `master` advances, to catch conflicts early and keep history linear. |
| **Merge strategy** | Merge to `master` with `--no-ff` (merge commit) post-G3 to preserve feature history for bisect and blame. |
| **Commit cadence** | Per design artifact (D1–D3), per implementation phase (V1), per V2 execution (qa/test/chaos). Fresh commits, not amends. |
| **Message format** | Conventional Commits (`docs:`, `feat:`, `test:` types); mandatory `Co-Authored-By` trailer. |
| **Staging discipline** | Explicit `git add <path1> <path2>` — **never** `git add -A` or `.` — to avoid sweeping concurrent docs. |
| **No-push rule** | `feature/multiplayer` is local-only until user approves final merge; coordinator does NOT push. |

---

**Related:** `MULTIPLAYER-ORCHESTRATION.md` (gates, stages, handoff table) is the authoritative script the coordinator follows to dispatch agents and track progress. This document defines how the coordinator commits and integrates those artifacts.
