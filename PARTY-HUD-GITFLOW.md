# Party HUD — Git Worktree Orchestration & Merge Flow

> **Status:** Established 2026-05-24 · Two-worktree topology for parallel Wave 1 (A0 + A) with serial Wave 2 (B/C/D).
> Worktrees: `H:\Claude\dnd-claude-prompt` (party/prompt, port 5174) & `H:\Claude\dnd-claude-core` (party/core, port 5175).
> Base branch: `feat/party-hud` (serialization point, commit 17f7d4e).

This document defines the **Git worktree topology**, the **merge-back order with gates**, and the **workflow for agents building the party HUD across four phased tranches** (A0, A, B/C/D, tests).

---

## Architecture

### Branching Topology

```
master (commit e7a4be0: "post-merge gap closure")
  │
  ├─ docs: party-HUD plan committed
  │
  ├─── feat/party-hud (base branch, serialization point)
  │    commit 17f7d4e: PARTY-HUD-PLAN.md
  │
  │    ├─── party/prompt    (worktree dnd-claude-prompt, port 5174)
  │    │    └─ Phase A0: System prompt injection (context.js, context.starwars.js)
  │    │       Agent: llm-architect
  │    │
  │    └─── party/core      (worktree dnd-claude-core, port 5175)
  │         ├─ Phase A: State model + parser (App.jsx, Chat.jsx) — Agent: react-specialist
  │         ├─ Phase B: Party strip + history (PartyStrip.jsx, HistoryPanel, CSS)
  │         ├─ Phase C: Turn-pill + status dot (Chat.jsx, CSS)
  │         └─ Phase D: Dice chip + verdict wiring (DiceChip.jsx, prompt, CSS)
  │
  ●─────── feat/party-hud ← All Phase work merges here in sequence ●
  │
  ├─ prompt → core merge (Party prompt instruction stable)
  ├─ core → feat/party-hud merge (A complete; feature begins UI build)
  ├─ feat/party-hud → core rebase (B/C/D ride on merged A)
  ├─ all Phase D work → feat/party-hud (Feature complete)
  │
  ●─────── feat/party-hud → master (final production branch) ●
```

### Why Two Worktrees?

**File-touch analysis** (from PARTY-HUD-PLAN.md:58–70):

| Phase | Agent | Files | Parallelizable? |
|-------|-------|-------|---|
| A0 | llm-architect | `src/lib/context.js`, `src/lib/context.starwars.js` | **YES** — disjoint from A |
| A | react-specialist | `src/App.jsx`, `src/components/Chat.jsx` | Parallel to A0 ✓ |
| B/C/D | react-specialist | `src/App.jsx` (again), `src/components/Chat.jsx` (again), `src/components/PartyStrip.jsx` (new), `src/components/HistoryPanel.jsx`, `src/components/DiceChip.jsx` (new), `src/App.css` | **NO** — same agent, same files as A; serial after A |
| test | test-automator | `*.test.jsx`, `*.test.js` (new/extended tests) | Parallel to B/C/D; rides in core |

**Verdict:**
- **party/prompt** (A0 only): llm-architect writes the system prompt injection. Zero UI. Merges cleanly into core.
- **party/core** (A→B/C/D): react-specialist does all UI/state work, building on A's merged state. Serial within the worktree, parallel to A0.
- **Test code** does not need a separate worktree — it rides in core after A merges and A→B/C/D is rebased.

---

## Worktree Setup

### Created Worktrees

```powershell
# Run from H:\Claude\dnd-claude on branch feat/party-hud
git worktree add -b party/prompt H:\Claude\dnd-claude-prompt feat/party-hud
git worktree add -b party/core H:\Claude\dnd-claude-core feat/party-hud
```

**Verification:**
```
H:/Claude/dnd-claude        17f7d4e [feat/party-hud]
H:/Claude/dnd-claude-core   17f7d4e [party/core]
H:/Claude/dnd-claude-prompt 17f7d4e [party/prompt]
```

### npm + Dev Port Setup

Each worktree gets its own `node_modules` (Vite dependency isolation).

**Worktree I — dnd-claude-prompt (A0 work):**
```powershell
cd H:\Claude\dnd-claude-prompt
npm install   # spawned in background; ~1-2 min
npm run dev -- --port 5174   # dev server port for A0 testing
```

**Worktree II — dnd-claude-core (A→B/C/D work):**
```powershell
cd H:\Claude\dnd-claude-core
npm install   # spawned in background; ~1-2 min
npm run dev -- --port 5175   # dev server port for all UI phases
```

**Base — dnd-claude (feat/party-hud):**
```powershell
cd H:\Claude\dnd-claude
npm run dev   # port 5173 (default); for final integration verification only
```

The `npm install` commands were spawned in background after worktree creation. Agents should verify installation is complete before starting work:
```powershell
npm list react   # quick check; should complete in < 5s if install is done
```

---

## Merge-Back Flow & Gates

All merges are local (no remote). Merge target is always `feat/party-hud` (the serialization point) unless otherwise stated.

### Wave 1 — Parallel: Prompt (A0) + Core Phase A

**Execution (parallel):**
- **Worktree `dnd-claude-prompt`:** llm-architect implements Phase A0 (system prompt injection).
  - Commit onto `party/prompt`.
  - Gate: `npm run build` + `npm test -- --run` (tests see longer prompt string; adjust if exact-string assertions fail).
  - Manual: send a message in `npm run dev -- --port 5174`; raw response includes a ` ```party ` fence.
- **Worktree `dnd-claude-core`:** react-specialist implements Phase A (state model, migration, parser).
  - Commit onto `party/core`.
  - Gate: `npm run build` + `npm test -- --run` (all 108+ tests pass).
  - Manual: send a message; fence absent from chat bubble; React DevTools shows `party` state updated.

**Merge order (into `feat/party-hud`):**
```powershell
cd H:\Claude\dnd-claude

# Merge 1: Prompt work
git merge --no-ff party/prompt -m "$(cat <<'EOF'
merge: party/prompt (Phase A0 — system prompt injection)

Append party/check/verdict emission instructions to buildSystemPrompt in both
context.js and context.starwars.js. No UI or state changes. Tests: prompt string
is longer but all existing assertions pass.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

# Gate: build + test + dev (port 5173, default)
npm run build && npm test -- --run && echo "✓ Merge 1 gate passed"

# Merge 2: Core Phase A
git merge --no-ff party/core -m "$(cat <<'EOF'
merge: party/core (Phase A — state model + parser)

Add party state to App.jsx (DEFAULT_PARTY, loadParty(), migration from dnd_character).
Implement unified structured-block parser in Chat.jsx (stripStructuredBlocks,
extractBlock). Apply party update after stream closes. No new UI yet.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

# Gate: build + test + dev (port 5173, default)
npm run build && npm test -- --run && echo "✓ Merge 2 gate passed"
```

**If merge conflict occurs:**
Conflicts are unlikely — Phase A0 touches only `context.js` files; Phase A touches `App.jsx` and `Chat.jsx`. If one appears:
- Review the conflict; keep both sides' changes (e.g., if both add to the same JSX file, interleave them).
- `git add <file>` and `git commit` (non-fast-forward merge already in progress).

---

### Wave 2 — Serial: Core Phases B, C, D

After **Merge 2 passes**, core phases can begin. **The core worktree must be rebased onto the updated `feat/party-hud`** so B/C/D build on the merged A.

```powershell
cd H:\Claude\dnd-claude-core

# Rebase party/core onto the updated feat/party-hud (now includes merged A)
git rebase feat/party-hud

# If rebase conflict: unlikely (A already committed to feat/party-hud, and no worker touched party/core yet).
# If it happens: resolve, `git add`, `git rebase --continue`.
```

**Phase B — Mobile party strip + History party section (react-specialist):**
- File touches: `src/components/PartyStrip.jsx` (new), `src/components/HistoryPanel.jsx`, `src/App.css`, `src/components/Chat.jsx` (wiring).
- Commit onto `party/core`.
- Gate: `npm run build` + `npm test -- --run` (new tests for PartyStrip, HistoryPanel).
- Manual: narrow viewport shows strip under header; desktop shows Party section in left panel.

**Phase C — Header turn-pill + status dot (react-specialist):**
- File touches: `src/components/Chat.jsx` (derive activeMember, add dot + pill), `src/App.css` (new rules + mobile hide).
- Commit onto `party/core`.
- Gate: `npm run build` + `npm test -- --run`.
- Manual: dot glows, pill shows DM-active member, both hidden on mobile.

**Phase D — Dice chip + verdict (react-specialist):**
- File touches: `src/components/DiceChip.jsx` (new), `src/components/Chat.jsx` (pendingCheck state, verdict wiring, DiceChip render), `src/lib/context.js` + `src/lib/context.starwars.js` (check/verdict instruction), `src/App.css`.
- Commit onto `party/core`.
- Gate: `npm run build` + `npm test -- --run` (new DiceChip tests, updated Chat tests).
- Manual: trigger check request → observe pendingCheck in React DevTools → roll → chip renders bare → DM responds with verdict → chip upgrades.

**Merges (after all B/C/D work committed to `party/core`):**
```powershell
cd H:\Claude\dnd-claude

# Merge 3: Merge party/core back onto feat/party-hud
# (party/core was rebased, so this is a fast-forward or a no-ff merge of the rebased branch)
git merge --no-ff party/core -m "$(cat <<'EOF'
merge: party/core (Phases A, B, C, D — complete feature)

Phases A, B, C, D merged in sequence:
- A: Party state model, migration, unified block parser.
- B: Mobile party strip + desktop history party section.
- C: Header turn-pill (DM-active member) + status dot (desktop-only).
- D: Dice skill-check chip + verdict wiring; check/verdict prompt injection.

All 108+ tests pass. Both themes render correctly. No FX bleed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

# Gate: build + test + dev (port 5173)
npm run build && npm test -- --run && echo "✓ Merge 3 gate passed"
```

---

### Wave 3 — Tests & Polish

**Test tranche** (test-automator) rides in the core worktree after Phase D is committed.

- File touches: `*.test.jsx`, `*.test.js` (new tests for PartyStrip, DiceChip, updated Chat/App tests).
- Commit onto `party/core`.
- Gate: `npm test -- --run` (all tests pass).

**Polish/bug-fix rounds** (as needed):
- Any agent can commit small fixes to their respective worktree or directly to `feat/party-hud` if the change is isolated.
- All commits to `feat/party-hud` must pass `npm run build` + `npm test -- --run`.

---

## Final Merge to Master

Once `feat/party-hud` is complete and verified:

```powershell
cd H:\Claude\dnd-claude

# Merge feat/party-hud → master
git merge --no-ff feat/party-hud -m "$(cat <<'EOF'
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
EOF
)"

# Final gate: build + test + dev (5173)
npm run build && npm test -- --run && npm run dev -- --port 5173

# Verify both themes in browser:
# - dnd: Candle-lit Grimoire theme, party strip visible on narrow, turn-pill + dot on desktop.
# - starwars (void): Crimson Void theme, no FX bleed.
```

---

## Cleanup

After final merge to master:

```powershell
cd H:\Claude\dnd-claude

# Remove worktrees
git worktree remove H:\Claude\dnd-claude-prompt
git worktree remove H:\Claude\dnd-claude-core

# Delete feature branches
git branch -d party/prompt party/core feat/party-hud

# Verify
git worktree list   # should show only H:/Claude/dnd-claude
git branch          # should show only master
```

---

## Verification Gates (Every Merge)

| Merge | Command | Expected | Manual Verify |
|-------|---------|----------|---|
| party/prompt → feat/party-hud | `npm run build` + `npm test -- --run` | Clean build; tests pass; prompt string longer | Send message; raw response ends with ` ```party ` fence |
| party/core (Phase A) → feat/party-hud | `npm run build` + `npm test -- --run` | Clean build; tests pass | Fence absent from chat; React DevTools shows party update |
| party/core (Phases A+B+C+D) → feat/party-hud | `npm run build` + `npm test -- --run` | Clean build; all 108+ tests pass | Strip visible on mobile; turn-pill + dot on desktop; dice chip bare then resolved |
| feat/party-hud → master | `npm run build` + `npm test -- --run` + `npm run dev` | Clean build; tests pass; both themes show party HUD | dnd theme: Candle-lit palette + party strip/pill/dot/chip. starwars: Crimson Void, no bleed. |

---

## Conflict Resolution Policy

### Merge Conflicts

**Expected conflict scenarios:**
1. **`src/App.css`** (unlikely but possible): Phase B/C/D append rules to the token-driven sections. If both branches add to the same file at different positions → resolve by keeping both blocks (EOF rule from THEMING-WORKTREE-PLAN.md:249–250 applies).
2. **`src/App.jsx` or `src/components/Chat.jsx`** (low probability): Phase A adds state/parser; Phase B/C/D add UI. Different sections of the file, so conflicts are rare. If they occur, carefully interleave the changes.

**Resolution:**
- Review the conflict markers.
- Ensure both logical changes are present (do not delete either side).
- `git add <file>`.
- `git commit` (merge already in progress).

### Fast-Forward vs. No-FF

All merges into `feat/party-hud` use `--no-ff` to maintain explicit merge commits in the history. This keeps the Git log readable and traceable for future reference.

---

## Branching Summary

| Branch | Purpose | Agent | Merge Target | Status |
|--------|---------|-------|---|---|
| `feat/party-hud` | Base branch; serialization point | (all) | `master` | Created; ready for work |
| `party/prompt` | Phase A0 (system prompt) | llm-architect | `feat/party-hud` | Worktree dnd-claude-prompt, port 5174 |
| `party/core` | Phases A, B, C, D | react-specialist | `feat/party-hud` | Worktree dnd-claude-core, port 5175 |

---

## File Synchronization & Inheritance

**All worktrees inherit PARTY-HUD-PLAN.md** from the base branch commit (17f7d4e). This ensures every agent:
1. Reads the binding specification before starting.
2. Understands the phasing and gates.
3. Knows the file-touch map and what phases depend on prior work.

**Cross-branch references:**
- A0 reads the party-emission instruction from PARTY-HUD-PLAN.md:172–187.
- A reads the state-model shape and parser spec from PARTY-HUD-PLAN.md:36–88 + :226–299.
- B/C/D read the component specs and theming corrections from PARTY-HUD-PLAN.md:357–667 + design-bridge fidelity audit.

No additional coordination docs are needed; PARTY-HUD-PLAN.md is the source of truth.

---

## Timeline & Parallelism

```
Day N:       [ Worktree creation + npm install ]
             
Day N+1:     [ A0 work (prompt) ] ━━ [ Merge 1 (gate) ] ┐
                                                           ├ Merge 2 (gate)
             [ A work (state + parser) ] ━━━━━━━━━━━┛
             
Day N+2:     [ B + C + D work (UI + CSS) — serial in core ] ━━ [ Merge 3 (gate) ]
             
Day N+3:     [ Test refinement + final merge to master ]
```

Both A0 and A run in parallel (Wave 1). B/C/D are serial (same agent, same files; Wave 2). Tests ride after D (Wave 3). Total elapsed time: ~3–4 days depending on agent availability and manual testing cadence.

---

## Risk Mitigation

1. **npm install hang:** If `npm install` does not complete in 2–3 min, cancel and re-run (`npm ci` as fallback).
2. **Port conflict:** If port 5174 or 5175 is in use, run `npm run dev -- --port 51XX` with a different port; update this doc.
3. **Test regressions:** If a phase breaks a test, fix it in that phase's commit (do not defer to a later merge). All gates must pass before merge.
4. **Late party-plan revisions:** Do not add new features to PARTY-HUD-PLAN.md after Wave 1 is underway. Defer to a v2 plan.

---

## Git Commands Quick Reference

### Worktree Management
```powershell
git worktree list                                    # show all
git worktree add -b <branch> <path> <commit/branch> # create
git worktree remove <path>                          # remove
```

### Merge Workflow
```powershell
git merge --no-ff <branch> -m "message"  # merge with explicit commit
git merge --abort                         # cancel a merge in progress
git status                                # check merge state
```

### Rebase (for party/core before B/C/D)
```powershell
git rebase feat/party-hud         # rebase onto updated base
git rebase --continue             # after conflict resolution
git rebase --abort                # cancel rebase
```

### Branch Cleanup
```powershell
git branch -d <branch>   # delete (safe; only local branches)
git branch -D <branch>   # force delete (use only if sure)
```

---

## Sign-Off & Approval

Each phase merge includes the Co-Authored-By footer:
```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

This applies to all commits on the feature branches and the merge commits into `feat/party-hud` and `master`.

---

End of PARTY-HUD-GITFLOW.md
