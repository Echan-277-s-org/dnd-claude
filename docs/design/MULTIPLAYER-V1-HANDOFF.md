# Multiplayer V1 — Continuation / Handoff

> **Purpose:** resume point for the multiplayer effort. Read this first in a new session, then
> `MULTIPLAYER-ORCHESTRATION.md` (§6 state table is the live tracker).
> **Status as of 2026-05-25:** Design arc COMPLETE. **GATE G1 = PASSED** (user-approved, with an
> explicit "pause before coding" instruction). **V1 is unblocked but ON HOLD** pending the user's
> phase-sequencing go. **No production feature code has been written yet.**

---

## 1. Where we are

The entire design arc is done and committed on branch `feature/multiplayer`:

| Stage | Artifact | State |
|-------|----------|-------|
| D1 product-manager | `MULTIPLAYER-PRD.md` | DONE |
| D2 game-developer | `MULTIPLAYER-ARCHITECTURE.md` | DONE — revised post-review (folds MC-1…MC-9 + security A–J; see its "Revision log") |
| D2-qa / test / chaos | `MULTIPLAYER-QA-PLAN.md` / `-TEST-AUTOMATION.md` / `-CHAOS-PLAN.md` | DONE — each carries a `## Post-revision refresh (G2)` section |
| D3 architect-reviewer | `MULTIPLAYER-ARCH-REVIEW.md` | DONE — **APPROVE-WITH-CHANGES** (MC-1…MC-9) |
| D3b security-auditor | `MULTIPLAYER-SECURITY-REVIEW.md` | DONE — 10 block-G1 items (A–J), all folded |
| G2 fold + refresh | (architecture revision + 3 test plans refreshed) | DONE |
| **G1 — user approval** | — | **PASSED 2026-05-25 (pause before coding)** |
| V1 implementation | code | **NOT STARTED — on hold** |
| V2 / G3 | execute test plans + sign-off | NOT STARTED |

Relevant commits (newest first):
```
940b28a docs(multiplayer): record G1 approval (pause before V1 coding)
25d4424 docs(multiplayer): refresh QA/test/chaos plans against revised arch (G2)
62c6f3c docs(multiplayer): revise architecture - fold in review + security findings
14e09cf docs(multiplayer): add security review (D3b)
c44c714 docs(multiplayer): add architecture review (D3) - APPROVE-WITH-CHANGES
03f42a3 test(multiplayer): add QA, automation, and chaos test-readiness plans
d8e458e docs(multiplayer): add PRD (D1) and architecture (D2)
```

## 2. Workflow rules for continuing (user-directed)

- **All workflow management routes through the `workflow-orchestrator` agent.** It owns
  `MULTIPLAYER-ORCHESTRATION.md` and its §6 state table; it updates state and emits per-agent
  handoff briefs but does NOT spawn agents.
- **All git operations route through the `git-workflow-manager` agent** (branching, commits). Work
  stays on `feature/multiplayer`; do not touch `master`; do not push unless the user asks. Commit
  trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- **The coordinator (top-level) dispatches the code agents** named per phase below — the orchestrator
  scripts, the coordinator dispatches.
- **Plan-first line is now cleared** (G1 passed), so V1 code is permitted — but the user asked to
  PAUSE before coding to sequence phases. Do not start a phase until the user says go.

## 3. Hard constraints that must survive V1 (do not regress)

- **`.md` save/continue** (`toMarkdown`/`fromMarkdown` in `src/lib/session.js`) — the user-required
  capability (memory `md-save-continue-requirement.md`). The server store stays a folder of
  `toMarkdown` handoffs.
- **Single-player** must keep working (direct client→Ollama path when not in multiplayer mode).
- **One payload shape** invariant in `session.js` — extend (v1→v2), do not fork.

## 4. V1 phased build plan (sequence to confirm with the user)

Strict chain; each phase independently shippable and test-mappable. Natural start = Phase 0.
Only real parallelism is *within* a phase. Agent routing per `CLAUDE.md`.

| Phase | Scope | Lead agent(s) | Depends on | Validated by |
|-------|-------|---------------|-----------|--------------|
| **0** | Schema/payload v2 (`roomCode`/`phase`/`turnSequence`); `serializeSession` carries them (MC-3); phase-sanitize on persist/load (MC-4); move `applyPartyUpdate` → `session.js` | `backend-developer` + `react-specialist` | — | TEST G2.2/G2.3 |
| **1** | WS transport spike; `createSyncServer` returns `http.Server` (MC-1); WS origin allowlist (sec D); `maxPayload` ~64 KB + inbound validation + try/catch (sec F) | `websocket-engineer` | P0 | TEST G2.1/G2.7/G2.8 |
| **2** | Server-authoritative state + broadcast; `turnSequence` dual-authority adopt gate (MC-6); `9999` sentinel reset under server-push (MC-7) | `websocket-engineer` + `backend-developer` | P1 | TEST G2.4/G2.5; chaos EX-2b/EX-6b |
| **3** | Single DM trigger = server-side Ollama proxy; full prompt assembly `buildSystemPrompt`/`extractEntities`/`trimContext`/dice-fold/`pendingCheck` (MC-2); ~90 s timeout (MC-8); inbound fence-strip of `BLOCK_TAGS` (sec A); per-connection rate limit + `OLLAMA_HOST`-only + model allowlist (sec G/H) | `llm-architect` + `backend-developer` | P2 | TEST G2.6/G2.9; chaos EX-1/EX-3C |
| **4** | Free-roam multi-client (first playable MP); single↔multi mode predicate (MC-5); CI latency smoke <2 s loopback (MC-9) | `react-specialist` | P3 | QA QG-13/QG-14; chaos EX-MC5 |
| **5** | Combat turn enforcement; connection-bound identity, ignore per-message `displayName` (sec C) | `react-specialist` + `websocket-engineer` | P4 | QA QG-03; chaos EX-4 |
| **6** | Presence / disconnect / rejoin; `NAME_TAKEN` for live name collision (sec J) | `websocket-engineer` | P5 | QA security-J; EDGE-03/04 |
| **7** | Migration cutover + single-player & `.md` non-regression | `backend-developer` + `react-specialist` | P6 | Full 274-suite + COMPAT-07/08 |

After V1 (any phase), `test-automator` un-skips and wires the matching Vitest skeletons; full V2
execution (`qa-expert` + `test-automator` + `chaos-engineer` in parallel) and **G3 sign-off** follow.

## 5. How to resume (exact next action)

1. User gives a go signal — e.g. "start Phase 0", "do P0+P1 together", or an adjusted sequence.
2. Coordinator → `workflow-orchestrator`: flip the chosen phase to IN PROGRESS in
   `MULTIPLAYER-ORCHESTRATION.md` §6 and emit a per-agent build brief (cite the exact architecture
   sections + MC/security items that phase implements, and the test artifacts that gate it).
3. Coordinator dispatches the phase's lead agent(s) with that brief — read against the **revised**
   `MULTIPLAYER-ARCHITECTURE.md`, reference source files by path per `CLAUDE.md`, do not regress §3
   constraints. Within-phase independent work may be dispatched in parallel.
4. On phase completion: run `npm test -- --run`, then `git-workflow-manager` commits on
   `feature/multiplayer`; `workflow-orchestrator` flips the phase to DONE.
5. Repeat for the next phase. Do not enter V2/G3 until V1 phases are complete.

## 6. Key source files (per `CLAUDE.md`, do not restate their code in design docs)

- `src/lib/session.js` — one payload shape, `serializeSession`/`deserializeSession`, `SCHEMA_VERSION`,
  `toMarkdown`/`fromMarkdown`, `getLanHost`, sync API.
- `src/hooks/useSessionPersistence.js` — `adopt()` M7 gate (strict-greater `savedAt`), `9999` sentinel.
- `server/sync-server.mjs` — `createSyncServer` (today returns Express `app` — MC-1 changes to
  `http.Server`), `withLock`, atomic temp+rename, 409, `serializeSession` rebuild on PUT.
- `src/components/Chat.jsx` — `sendMessage` prompt assembly, dice/`pendingCheck` folding,
  `applyPartyUpdate`, structured-block parser, per-client Ollama POST.
- `src/lib/genres.js` / `src/lib/context.js` / `context.starwars.js` — genre engines
  (`buildSystemPrompt`/`extractEntities`/`trimContext`) the server-side DM call (MC-2) depends on.
