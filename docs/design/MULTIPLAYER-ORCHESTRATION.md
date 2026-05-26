# Multiplayer Orchestration Plan

> **Owner:** workflow-orchestrator (this document is authoritative).
> **Executor:** the top-level coordinator dispatches the agents below in the order and with the
> handoff contracts defined here. The orchestrator does NOT write feature code and does NOT spawn
> agents — this plan is the script the coordinator follows literally.
>
> **Status:** DESIGN-ARC complete; **GATE G1 PASSED** (user-approved 2026-05-25). V1 is unblocked but
> **on hold** at the user's explicit "pause before coding" instruction — no production feature code until
> the user sequences the V1 phases (§3.1 D2 Phases 0–7).

---

## 1. Goal & non-goals

**Goal.** Add **multiplayer** to the local-AI D&D app so 2–5 players on a trusted home LAN share one
live session with one AI Dungeon Master, using a **hybrid play model** — real-time free-roam during
exploration/roleplay, enforced initiative/turn order during combat (built on the existing
`isActive` party flag, see `src/components/Chat.jsx` and the `party` block in `CLAUDE.md`). This
effort produces a **reviewed, test-ready design** (PRD + architecture + reviewer verdict + QA/test/chaos
plans) — not a running feature. **Non-goals:** cloud hosting, accounts/auth beyond LAN-trust,
WAN/internet play, voice/video, mobile-native rewrites, and — critically — **anything that drops the
`.md` save/continue capability** (`toMarkdown`/`fromMarkdown` in `src/lib/session.js`; see memory
`md-save-continue-requirement.md`, which overrides any plan that would remove it).

---

## 2. Two-arc phase sequence

```
DESIGN ARC  (plan-first; no production feature code)
  Stage D1  product-manager ─────────────► PRD (incl. join/identity recommendation)
                  │
                  ▼
  Stage D2  game-developer ──────────────► technical architecture + phased build plan
                  │  (PRD is an input)
                  ├──────────────► qa-expert        ─┐  contribute test-readiness
                  ├──────────────► test-automator   ─┤  in PARALLEL once D2 architecture
                  └──────────────► chaos-engineer   ─┘  is drafted (read the same arch)
                  │
                  ▼
  Stage D3  architect-reviewer ──────────► verdict (APPROVE / APPROVE-WITH-CHANGES / REVISE)
                  │
                  ▼
        ╔═══════════════════════════════════════════════════╗
        ║  GATE G1 — USER APPROVAL of the reviewed,          ║
        ║  test-ready design. COORDINATOR MUST PAUSE HERE.   ║
        ╚═══════════════════════════════════════════════════╝

VALIDATION ARC  (only after G1 clears)
  Stage V1  implementation (per game-developer phased plan; routed to the
            code agents named in §3.2 by the coordinator — NOT this orchestrator)
                  │
                  ▼
  Stage V2  qa-expert + test-automator + chaos-engineer EXECUTE their plans  (PARALLEL)
                  │
                  ▼
        ╔═══════════════════════════════════════════════════╗
        ║  GATE G3 — POST-VALIDATION sign-off                ║
        ╚═══════════════════════════════════════════════════╝
```

### Ordering & dependency rules
- **D1 → D2 → D3 is strictly sequential** (PRD feeds architecture; architecture feeds review).
- **qa-expert / test-automator / chaos-engineer run in PARALLEL with the tail of D2** — they read the
  game-developer architecture draft and produce test-readiness artifacts *before* D3, so the
  reviewer can judge whether the design is genuinely test-ready. They are **dependencies of G1**, not
  of D3 review pass/fail (the reviewer may flag a design as REVISE *because* the test artifacts expose
  an untestable failure mode — see G2).
- **Loop on REVISE (G2):** an architect-reviewer REVISE verdict returns to D2 with the findings; D2
  re-runs, then the three test-readiness agents refresh against the revised architecture, then D3
  re-reviews. Repeat until APPROVE or APPROVE-WITH-CHANGES.
- **V1 implementation does not begin until G1 (user approval) clears.** This is the hard plan-first line.
- **V2 agents execute the plans they authored in the design arc** — no new test design in V2, only execution
  against the now-built feature, with the design-arc artifacts as the spec.

---

## 3. Per-agent work order

All artifacts live under `H:\Claude\dnd-claude\docs\design\`. Filenames are fixed so the coordinator and
later agents can reference them by path. Each agent must reference source files by path (per `CLAUDE.md`)
and must NOT restate code already in the repo.

### 3.1 Design-arc agents

#### D1 — `product-manager`
- **Artifact:** `docs/design/MULTIPLAYER-PRD.md`
- **Inputs (handoff in):** this plan (§1 goal/non-goals, §5 risks); `CLAUDE.md`; the locked product
  decisions (hybrid play model; plan-first scope; join/identity is to be RECOMMENDED not pre-decided).
- **Required sections:**
  1. **Player personas & flows** — host/DM-owner vs joining players; first-join, rejoin, mid-session-arrival.
  2. **Join & identity recommendation** — the proposed model (e.g. room code + display name + claim a
     `party` slot vs accounts) with rationale and the runner-up rejected; how a player maps to a `party`
     member (by name-match, reusing `applyPartyUpdate` semantics in `Chat.jsx`).
  3. **Hybrid model feel** — exactly how free-roam vs combat transitions present to players (who can act
     when; what the UI signals; how the existing desktop turn-pill / `isActive` becomes the combat HUD).
  4. **MVP boundary & scope cuts** — what ships in multiplayer v1 vs deferred; explicit cuts.
  5. **Success criteria** — measurable acceptance outcomes (latency feel, max players, no-DM-double-output).
  6. **Constraints honored** — explicit statement that `.md` save/continue and single-player both survive.
- **Handoff out (must surface as a labelled section "Decisions that flow forward"):** the chosen
  join/identity model; the MVP feature list; the player→`party`-slot mapping rule; success criteria.

#### D2 — `game-developer`
- **Artifact:** `docs/design/MULTIPLAYER-ARCHITECTURE.md`
- **Inputs (handoff in):** `MULTIPLAYER-PRD.md` "Decisions that flow forward" (join/identity, MVP list,
  player→slot mapping, success criteria); the four grounded source files —
  `src/components/Chat.jsx` (turn loop, structured-block parser, the per-client Ollama POST),
  `src/hooks/useSessionPersistence.js` (the LWW/30s-poll model, the M7 strictly-newer gate, the
  `9999...` new-session sentinel), `server/sync-server.mjs` (per-id lock, atomic temp+rename,
  server-stamped `savedAt`, 409 staleness), `src/lib/session.js` (the ONE payload shape +
  `toMarkdown`/`fromMarkdown` + `getLanHost`).
- **Required sections:**
  1. **Shared-session state model** — where the authoritative session lives once N clients share it
     (server-authoritative vs leader-client); how it relates to the existing payload shape in
     `session.js` (extend, don't fork — name any new fields and bump `SCHEMA_VERSION` if needed).
  2. **Transport choice** — WebSocket / SSE vs the current 30s poll, with rationale; what replaces or
     wraps `pollSyncSession`; reconnect/backoff behavior.
  3. **Single serialized AI-DM trigger** — THE central question: who calls Ollama so N clients do NOT
     each `POST /api/chat`. Specify the elected/host trigger, how the stream fans out to all clients,
     and how `Chat.jsx`'s per-client `fetch(.../api/chat)` is refactored. Must prevent DM double-trigger.
  4. **Turn/initiative state machine** — explicit states (free-roam / combat-initiative / awaiting-DM /
     resolving) and transitions; how `isActive` and the `party` block drive whose turn it is; how a
     player action is accepted or rejected per phase.
  5. **Identity / room implementation** — concrete realization of the PRD's join model on the transport;
     player→connection→`party`-slot binding; presence/disconnect signaling.
  6. **Migration path from the current LWW sync layer** — step-by-step from today's
     `useSessionPersistence` + `sync-server.mjs` to the multiplayer transport, **explicitly preserving
     `.md` save/continue** (the server store stays a folder of `toMarkdown` handoffs, or the doc states
     precisely how `.md` survives). Must keep single-player working.
  7. **Phased build plan** — ordered phases (e.g. transport spike → server-authoritative state →
     single-DM trigger → free-roam multi-client → combat turn enforcement → identity/rooms → migration
     cutover), each phase independently shippable and test-mappable to §3.2 artifacts.
  8. **Failure-mode pre-analysis** — first-pass notes on DM double-trigger, split-brain, dropped/rejoin,
     combat-turn desync, Ollama-mid-stream-failure (hands the reviewer and chaos-engineer a target list).
- **Handoff out ("Decisions that flow forward"):** transport choice; trigger/election mechanism; the
  state-machine state names + transitions; the new/changed `session.js` fields and schema version; the
  phased build plan phase list. These feed D3 and all three test-readiness agents.

#### D3 — `architect-reviewer`
- **Artifact:** `docs/design/MULTIPLAYER-ARCH-REVIEW.md`
- **Inputs (handoff in):** `MULTIPLAYER-ARCHITECTURE.md` (full); `MULTIPLAYER-PRD.md`; the three
  test-readiness artifacts (3.2) so the verdict accounts for testability; the four source files for
  fit-against-existing-system evaluation.
- **Required sections:**
  1. **State / transport / coordination evaluation** — is the shared-state + transport + single-DM-trigger
     design sound and consistent with the existing serialize layer and server contract?
  2. **Migration risk** — does the path preserve `.md` save/continue, single-player, and the M7 gate
     semantics? Call out any silent break.
  3. **Failure-mode review** — DM double-trigger, split-brain state, dropped/rejoining players,
     combat-turn desync; are mitigations real and testable?
  4. **Verdict** — one of **APPROVE / APPROVE-WITH-CHANGES / REVISE**, each with explicit reasoning and,
     for APPROVE-WITH-CHANGES, an itemized must-change list bound to specific architecture sections.
- **Handoff out:** the verdict + (if not clean APPROVE) the exact change list. **Drives gate G2.**

### 3.2 Test-readiness agents (contribute in design arc, execute in validation arc)

#### `qa-expert`
- **Artifact:** `docs/design/MULTIPLAYER-QA-PLAN.md`
- **Inputs (handoff in):** `MULTIPLAYER-PRD.md` (success criteria, hybrid-model feel, MVP boundary);
  `MULTIPLAYER-ARCHITECTURE.md` (state machine, transport, trigger mechanism); existing test posture
  (Vitest jsdom + one node-env server suite, 274 tests, `npm test -- --run`).
- **Required sections:** acceptance criteria for the hybrid model (free-roam + combat); concurrency
  scenarios (2–5 players); edge cases (simultaneous actions, mid-combat disconnect, rejoin, DM
  mid-stream); quality gates (pass thresholds tied to PRD success criteria); a traceability map from each
  PRD success criterion to a test scenario.
- **Design-arc deliverable:** the plan above. **Validation-arc deliverable:** execute the plan against
  the implemented feature; report pass/fail per quality gate. Feeds **G3**.

#### `test-automator`
- **Artifact:** `docs/design/MULTIPLAYER-TEST-AUTOMATION.md` (+ optional test skeletons under `tests/`
  or alongside existing suites, clearly marked TODO/skipped until V1).
- **Inputs (handoff in):** `MULTIPLAYER-ARCHITECTURE.md` (transport, the new/changed `session.js`
  fields + schema version, the sync-server contract changes); the existing Vitest setup and the
  `session.js` / `sync-server.mjs` test seams.
- **Required sections:** Vitest unit/integration coverage (pure `session.js` schema + reducer logic) vs an
  integration/e2e harness for real-time multi-client behavior (multiple simulated WS clients + a fake or
  real Ollama); test scaffolding approach against the `session.js`/sync-server contracts and the new
  transport; CI integration (extend `npm test -- --run`); what stays jsdom vs what needs node-env.
- **Design-arc deliverable:** the plan + may scaffold skipped skeletons against the spec.
  **Validation-arc deliverable:** implement and wire the automated suites into CI. Feeds **G3**.

#### `chaos-engineer`
- **Artifact:** `docs/design/MULTIPLAYER-CHAOS-PLAN.md`
- **Inputs (handoff in):** `MULTIPLAYER-ARCHITECTURE.md` failure-mode pre-analysis (§3.1 D2.8); the
  transport + single-DM-trigger design.
- **Required sections:** failure-injection experiments for **DM double-trigger**, **dropped WebSocket /
  network partition**, **Ollama unavailable mid-turn**, **two players acting on the same combat turn**,
  **server restart with live sessions**; for each: steady-state hypothesis, injection method,
  expected/abort conditions, and **blast-radius limits** (LAN dev environment only — no prod, no WAN,
  bounded to test sessions). Each experiment maps to a §5 risk.
- **Design-arc deliverable:** the experiment design. **Validation-arc deliverable:** run the experiments
  against the implemented system; report which hypotheses held. Feeds **G3**.

---

## 4. Decision gates

| Gate | When | Who decides | Pass condition | On fail |
|------|------|-------------|----------------|---------|
| **G1 — User approval (HARD PAUSE)** | After D3 verdict + all three test-readiness artifacts exist | **User** | User explicitly approves the reviewed, test-ready design | Coordinator pauses; collect user changes; loop relevant design-arc stage. **No V1 code until cleared.** |
| **G2 — Reviewer verdict** | End of D3 | `architect-reviewer` | APPROVE or APPROVE-WITH-CHANGES (changes folded into the architecture before G1) | **REVISE → loop back to D2** with the reviewer's exact findings; refresh the three test-readiness artifacts against the revised architecture; re-run D3. |
| **G3 — Post-validation** | End of V2 | `qa-expert` quality gates + chaos hypotheses + green CI | All QA quality gates pass, chaos steady-state hypotheses hold, automated suite green in CI | File defects; route fixes to the implementing code agent; re-run the failing V2 experiments only. |

**G2/G1 interaction:** APPROVE-WITH-CHANGES does NOT auto-pass to V1 — the must-change list is folded
back into `MULTIPLAYER-ARCHITECTURE.md` and the updated design is what the user reviews at G1.

---

## 5. Risk register

| # | Risk | Description | Owning agent (mitigation authored by) | Verified by |
|---|------|-------------|----------------------------------------|-------------|
| R1 | **DM double-trigger / concurrency** | N clients each `POST /api/chat` (today's per-client `fetch` in `Chat.jsx`) → duplicate/garbled DM output. | `game-developer` (single serialized trigger + election) | `chaos-engineer` (DM-double-trigger experiment), `qa-expert` (no-double-output gate) |
| R2 | **Sync-layer migration** | Moving off LWW/30s-poll + the M7 strictly-newer gate / `9999...` sentinel without breaking single-player or producing split-brain state. | `game-developer` (migration path §3.1 D2.6) | `architect-reviewer` (migration-risk section), `test-automator` (schema/contract tests) |
| R3 | **`.md` handoff preservation** | The hard, user-required save/continue (`toMarkdown`/`fromMarkdown`) must survive the new transport/state model. | `game-developer` (explicit preservation in migration path) + `product-manager` (constraint stated in PRD) | `architect-reviewer` (calls out any silent break), `qa-expert` (save/continue acceptance test) |
| R4 | **LAN-only / no-auth security** | Plain HTTP, no auth, room-join trust on an open LAN; a wrong/hostile client claiming a `party` slot or session id. | `product-manager` (join/identity recommendation + trust boundary) + `game-developer` (id/room implementation) | `chaos-engineer` (where in scope), `qa-expert` (join-flow edge cases) |
| R5 | **Combat-turn desync** | Two players act on the same initiative turn; `isActive`/turn state diverges across clients. | `game-developer` (turn/initiative state machine §3.1 D2.4) | `chaos-engineer` (two-players-same-turn experiment), `qa-expert` (mid-combat concurrency scenarios) |

---

## 6. Handoff / state-tracking table

The coordinator updates **Status** as stages complete. **Blocks-on** is the hard dependency that must be
DONE before the row may start.

| Stage | Agent | Artifact (`docs/design/`) | Status | Blocks-on |
|-------|-------|---------------------------|--------|-----------|
| D1 | `product-manager` | `MULTIPLAYER-PRD.md` | **DONE** | this plan |
| D2 | `game-developer` | `MULTIPLAYER-ARCHITECTURE.md` | **DONE** | D1 (PRD "Decisions that flow forward") |
| D2-qa | `qa-expert` | `MULTIPLAYER-QA-PLAN.md` | **DONE** | D2 architecture draft |
| D2-test | `test-automator` | `MULTIPLAYER-TEST-AUTOMATION.md` | **DONE** | D2 architecture draft |
| D2-chaos | `chaos-engineer` | `MULTIPLAYER-CHAOS-PLAN.md` | **DONE** | D2 architecture draft (D2.8 failure list) |
| D3 | `architect-reviewer` | `MULTIPLAYER-ARCH-REVIEW.md` | **DONE — verdict APPROVE-WITH-CHANGES (MC-1…MC-9)** | D2 + D2-qa + D2-test + D2-chaos |
| D3b | `security-auditor` | `MULTIPLAYER-SECURITY-REVIEW.md` | **DONE — 10 findings A–J, all block-G1** | D2 architecture (parallel to D3) |
| G2-fold | `game-developer` | `MULTIPLAYER-ARCHITECTURE.md` (revised) | **DONE — MC-1…MC-9 + A–J folded in (see "Revision log (post-review)")** | D3 + D3b |
| G2-refresh | `qa-expert` + `test-automator` + `chaos-engineer` (PARALLEL) | `MULTIPLAYER-QA-PLAN.md` / `-TEST-AUTOMATION.md` / `-CHAOS-PLAN.md` (refreshed) | **DONE — all three carry a `Post-revision refresh (G2)` section (QG-12/13/14 + MC-8; MC-1…MC-7 + sec D/F/G/H skeletons, ~417 CI tests; EX-3C/EX-MC5/EX-2b/EX-6b)** | G2-fold |
| **G1** | **User** | — (approval) | **PASSED — user-approved 2026-05-25, with an explicit "pause before coding" instruction** | D3 verdict + D3b + 3 test-readiness artifacts refreshed (G2-refresh DONE) |
| V1 | code agents (coordinator routes per CLAUDE.md: `react-specialist` for `Chat.jsx`/client, `websocket-engineer` for transport, `backend-developer` for the server, `llm-architect` for the single-DM-trigger) | implementation | **IN PROGRESS — autonomous overnight build started 2026-05-26 (user-directed, unattended). Phase 0 IN PROGRESS.** Follows the §3.1 D2 phased build plan (Phases 0–7) | **G1 cleared** + D2 phased build plan |
| V1.P0 | `react-specialist` (coordinator-implemented) | `src/lib/session.js`, `src/components/Chat.jsx`, `src/lib/session.multiplayer.test.js` | **DONE** — schema v2 + `applyPartyUpdate` move + Phase 0 unit tests active (301 pass/59 skip, no regressions). Commit `05612de`. | V1 start |
| V1.P1 | `websocket-engineer` | `server/sync-server.mjs`, `src/hooks/useWebSocket.js`, `package.json`, `server/sync-server.multiplayer.test.mjs`, `src/hooks/useWebSocket.test.js` | **DONE** — WS transport: `createSyncServer`→`http.Server` (MC-1), `/ws` + origin allowlist (D), join→session:state, ping/pong, NAME_TAKEN (J), displayName sanitize (B), maxPayload 64KB (F), `useWebSocket` hook w/ backoff. 336 pass/42 skip, no regressions. Commit `6390995`. | P0 |
| V1.P2 | `websocket-engineer` + `backend-developer` | `server/sync-server.mjs`, `src/hooks/useSessionPersistence.js` | **DONE** — per-room action queue + `session:update` broadcast (echo placeholder); dual-authority adopt gate `adopt(payload,source)` (MC-6); `onSessionState` unconditional sentinel reset + `onNewSession` sets `localTurnSequence=-1` (MC-7); poll suspended via optional `socketConnected`. 14 existing hook tests untouched/green. 342 pass/39 skip. Commit `86185ea`. | P1 |
| V1.P3 | `llm-architect` + `backend-developer` | `server/sync-server.mjs`, `src/components/Chat.jsx`, `src/lib/genres.js`, `src/lib/context.starwars.js` | **DONE** — server-side Ollama DM proxy: full prompt assembly reproduced (MC-2), AbortController 90s timeout+error-reset (MC-8/F5), inbound block-strip STRIP_RE (A), forged verdict.roll guard, synchronous `dmBusy`+phase DM_BUSY gate, OLLAMA_HOST-only + model allowlist (G/H), dm:delta/dm:done + .md persist. Mode-aware `sendMessage` predicate-gated (false until P4) so single-player unchanged. Added `.js` import extensions so server boots under raw Node ESM (verified). 348 pass/33 skip. | P2 |
| V1.P4 | `react-specialist` (+ websocket/frontend scope) | `src/App.jsx`, `src/components/ApiKeySetup.jsx`, `src/components/Chat.jsx`, `src/hooks/useWebSocket.js`, `server/sync-server.multiplayer.test.mjs`, `src/components/Chat.test.jsx` | **DONE** — free-roam multi-client live: `?room=` + Join-Session tab + share-code affordance; `useWebSocket` gated by `enabled=!!(roomCode&&displayName)` (single-player opens NO socket); session:state→roomJoined, session:update→dual-authority adopt, dm:delta/dm:done drive UI; presence chips + player labels as React text nodes (XSS-safe). MC-9 latency smoke <2s + XSS guard tests added. App.test.jsx unchanged; Chat.test.jsx additive. 357 pass/33 skip. | P3 |
| V2-qa | `qa-expert` | (executes `MULTIPLAYER-QA-PLAN.md`) | NOT STARTED | V1 |
| V2-test | `test-automator` | (implements + runs suites in CI) | NOT STARTED | V1 |
| V2-chaos | `chaos-engineer` | (runs `MULTIPLAYER-CHAOS-PLAN.md` experiments) | NOT STARTED | V1 |
| **G3** | QA gates + chaos hypotheses + green CI | — (sign-off) | NOT STARTED | V2-qa + V2-test + V2-chaos |

**Parallelism summary for the coordinator:**
- D2-qa, D2-test, D2-chaos may be dispatched **together** the moment the D2 architecture draft is readable.
- D3 must wait for **all** of D2 + the three test-readiness artifacts.
- V2-qa, V2-test, V2-chaos run **in parallel** after V1.
- On a G2 REVISE: re-run D2, then re-dispatch the three test-readiness agents in parallel, then re-run D3.

**Note on D3b and the G2 post-fold refresh (added in execution):**
- **D3b** (`security-auditor` → `MULTIPLAYER-SECURITY-REVIEW.md`) was not enumerated in the original §2/§3
  sequence; it ran in **parallel with D3** against the same D2 architecture and produced 10 findings (A–J),
  all flagged block-G1. It is a real, completed stage and is tracked above.
- The D3 verdict was **APPROVE-WITH-CHANGES**, not REVISE — so per §4 G2/G1 the must-changes (MC-1…MC-9)
  plus the security items (A–J) were **folded into** `MULTIPLAYER-ARCHITECTURE.md` (stage **G2-fold**, DONE;
  see that file's "Revision log (post-review)" mapping each item to a section) rather than looping back to a
  full D2 re-run.
- The fold commit touched **only** the architecture file. Per the D3 review's "Folding note", the three
  test-readiness artifacts must be **refreshed against the revised sections** (notably MC-2 prompt assembly,
  MC-6 `turnSequence` convergence gate, MC-7 sentinel reset, MC-8 Ollama timeout / EX-3C). That refresh is the
  **G2-refresh** loop above (**DONE**). It is a lighter-weight variant of the §2 "loop on REVISE" rule:
  no D2 re-run and no D3 re-review (the verdict already cleared as APPROVE-WITH-CHANGES) — only the three
  plans realign to the folded architecture. With G2-refresh **DONE**, G1's blocks-on (D3 verdict + D3b +
  3 refreshed test-readiness artifacts) was satisfied and **G1 PASSED** — the user approved the reviewed,
  test-ready design on **2026-05-25**, but with an explicit **"pause before coding"** instruction. V1 is
  therefore **unblocked but on hold**: the user will sequence the V1 phases (the §3.1 D2 Phases 0–7) before
  any production feature code is written. **No V1 code begins until the user issues that phase-sequencing go.**
