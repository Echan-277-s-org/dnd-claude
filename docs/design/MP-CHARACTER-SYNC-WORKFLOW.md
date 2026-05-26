# Per-Player Character Sync in Multiplayer — Orchestration Workflow

**Status:** Defined (coordination doc — not a spec, not code)
**Author:** Workflow Orchestrator
**Date:** 2026-05-26
**Branch:** `feature/mp-character-sync` (nothing merges to `master` until the final gate is green)
**Driver:** the main Claude thread executes every handoff below; this orchestrator does not spawn agents.

> This document defines the **process** for shipping "Per-Player Character Sync in Multiplayer."
> It names the stages, owners, the exact artifacts that cross each boundary, the checkable gates,
> the failure loops, and the integration risks. The two downstream agents (`product-manager`,
> `game-developer`) follow it; they own the spec and the code respectively.

---

## 0. Feature in one paragraph (context only — PM owns the real scope)

Today the character wizard is host-only and the character it builds is **decoupled from the synced
party** (`dnd_character` is local-only; the synced party row is just `{ name, role, hpPct, isActive }`).
The goal: each joining player builds a character via the existing wizard, that character **syncs** so
the server and every client know about it, and the AI DM is told every player's class/race + key stats
so it narrates and manages the party accurately. The shared party model and WS `join`/`session:*`
protocol must be extended to carry character data; today they do not.

**Grounded touch-points** (verified — agents must not re-discover these):
- `src/components/ApiKeySetup.jsx` — wizard lives in "New Campaign"; "Join Session" tab collects only `{ roomCode, displayName, sessionId }`.
- `src/App.jsx` `handleSetup` — `buildCharacter()` → `dnd_character` + one-row `dnd_party` seed.
- `src/hooks/useWebSocket.js` — `join` payload (lines 99–106) carries no character today.
- `server/sync-server.mjs` — `sanitizeDisplayName` (l.97), `MODEL_RE` (l.49), block-strip `sanitizeActionContent` (l.259), connection-bound identity (l.331 "per-message displayName is ignored for authorization"), `NAME_TAKEN` rejoin (l.810+), `applyPartyUpdate` overwrites `room.party` from the DM block each turn.
- `src/lib/session.js` — `SCHEMA_VERSION = 2` (l.19), `applyPartyUpdate` (l.54), `deserializeSession` (l.124, v1 payloads still load).
- `src/lib/context.js` / `context.starwars.js` — `buildSystemPrompt` (where the DM is told player stats).
- `src/lib/turnStateMachine.js` — `phaseReducer` + `isActiveTurn`.
- Test gate: `npm test -- --run` — currently **584 passed, 2 skipped**. This count is the floor.

---

## 1. Stage graph

Three **strictly sequential** stages. Stage B cannot begin until Stage A's artifact exists and passes
the spec-acceptance gate (G-A); Stage C cannot begin until Stage B's branch is pushed and self-green.

```
 ┌──────────────────────┐      G-A       ┌──────────────────────────┐     G-B      ┌─────────────────────┐
 │ Stage A: PM Scoping  │ ──spec────────▶│ Stage B: Implementation  │ ──branch───▶ │ Stage C: Test /      │
 │ owner: product-manager│   approved?    │ owner: game-developer    │  self-green? │ Integration Gate     │
 └──────────────────────┘                └──────────────────────────┘              │ owner: main thread + │
        │  ▲                                      │  ▲                              │ test-automator       │
        │  │ loop-back (spec ambiguous            │  │ loop-back (tests red /        └─────────────────────┘
        │  │  or gate fails)                      │  │  gate fails)                          │  ▲
        └──┘                                      └──┘                                       │  │ loop-back (regression)
                                                                                            └──┘
                                                          all gates green ──▶ merge to master
```

**Why sequential:** the game-developer's data-model, WS-protocol, and migration choices are *decided
by the spec*. Implementing before the spec is locked produces rework on the highest-risk surfaces
(SCHEMA_VERSION bump, WS protocol). Do not parallelize A and B.

### Parallelizable work *within* a stage

- **Within Stage A (PM):** the six required spec sections (§2.1) are independent prose and can be
  drafted in any order / concurrently; only the **phased breakdown** (§2.1.f) must be assembled last
  because it references all the others.
- **Within Stage B (game-developer):** the spec must define phases such that these are independently
  buildable and testable before integration:
  - *Pure layers* — `session.js` payload/schema changes + `turnStateMachine.js` (if touched) +
    a new character-validation/serialization module — have no UI dependency and can land first.
  - *Server* (`sync-server.mjs` `join` handling + party hydration + prompt assembly) and *client*
    (`useWebSocket.js` join payload + `ApiKeySetup.jsx` Join-tab wizard + `App.jsx` wiring) share
    the wire contract but can be built against it in parallel **once the pure layer fixes the shape**.
  - *Prompt* (`context.js` + `context.starwars.js`) is a parallel track gated only on the final
    character shape; the two genre engines must stay behaviorally identical (existing invariant).
- **Within Stage C:** unit, component, and the node-env server suite run in one `npm test -- --run`;
  manual SP/MP/join smoke checks can run concurrently with reading the changelog.

---

## 2. Handoff contract

Each stage produces exactly one primary artifact that the next stage consumes. No verbal/implicit handoff.

### Stage A → B

**Producer:** `product-manager`
**Artifact:** `docs/design/MP-CHARACTER-SYNC-SPEC.md`
**Format/depth:** match `docs/design/CHARACTER-WIZARD-FEATURE-SPEC.md` exactly — numbered sections,
phased breakdown with explicit `[ ]` acceptance-criteria checklists per phase, a risk register table,
and a dedicated test plan section.
**Consumer:** `game-developer` reads it as the single source of truth; any gap is a loop-back to PM, not a guess.

**Required sections (the gate G-A checks every one is present and unambiguous):**

a. **Data model changes** — the new per-player character shape that travels on the wire and the
   exact extension to the synced party row. Today the party row is `{ name, role, hpPct, isActive }`.
   The spec must decide: do we widen the party row (add e.g. `race`, `charClass`, `abilities` subset,
   `displayName` linkage) or carry character data on a sibling structure keyed by `displayName`?
   Must define which `CHARACTER_OBJECT` fields sync vs stay local (full sheet is local today; the DM
   only needs class/race + key stats). Must state the localStorage impact (`dnd_character`,
   `dnd_party`) and confirm whether `entities` re-derivation is affected.

b. **WS protocol additions** — the concrete additions to:
   - client→server `join` (today `{ type, roomCode, sessionId, displayName, lastTurnSequence }`) —
     add the character payload;
   - server→client `session:state` (full snapshot) and `session:update` (incremental) so late joiners
     and all clients learn every player's character;
   - whether a new dedicated message type (e.g. `character:update` for mid-session edits) is in scope
     or explicitly deferred. Must specify wire field names and types, and reaffirm that
     **connection-bound identity rules still hold** (server ignores per-message `displayName` for
     authorization — `sync-server.mjs` l.331).

c. **Backward-compat / migration for the SCHEMA_VERSION bump** — whether the payload schema must go
   `2 → 3`, and if so the migration rule. Hard requirement: **v1 and v2 payloads must still
   `deserializeSession` without throwing** (current invariant, `session.js` l.124). Must define the
   default character shape applied when an old payload (no per-player character) loads, and how the
   `.md` save/continue round-trip carries the new data (`toMarkdown`/`fromMarkdown`).

d. **Security validation of inbound character payloads** — must mirror the existing server pattern:
   inbound character data is **validated and clamped server-side** the way `sanitizeDisplayName`
   (l.97) and `sanitizeActionContent` (l.259) already do. Spec must enumerate: string-length caps on
   name/race/class, numeric clamps on ability scores / HP (reject NaN / out-of-range / negative),
   allowlist or strip of unknown fields, and the rule that **the server is authoritative** — a client
   cannot inject a forged 20-STR / 999-HP character. Must reaffirm no host env / `OLLAMA_HOST` /
   `MODEL_RE` internals leak to the client.

e. **DM prompt integration** — how `buildSystemPrompt` (both `context.js` and `context.starwars.js`,
   which must stay behaviorally identical) is fed each player's class/race + key stats, and the
   **token-budget guard** for many players (cap the per-player stat summary; see Risk R-4).

f. **Phased breakdown with acceptance criteria** — ordered phases (pure layer → server+client →
   prompt → integration), each with `[ ]` checkable acceptance criteria, matching the template's depth.
   Must mark which phases are parallel per §1.

g. **Test plan** — new unit tests (session schema migration, character validation/clamp, prompt
   assembly with N players), component tests (Join-tab wizard), and the regression set that must stay
   green. Must explicitly assert the **single-player no-WS path** is covered.

### Stage B → C

**Producer:** `game-developer`
**Artifacts:**
1. Working code on `feature/mp-character-sync` implementing the spec, with all new + existing tests.
2. A short **changelog** (plain markdown, in the PR/commit body or `docs/design/MP-CHARACTER-SYNC-CHANGELOG.md`)
   listing: files touched, the schema-version decision and migration applied, new WS fields, new tests
   added (count + names), and any spec items deferred (with PM sign-off reference).
**Consumer:** Stage C (main thread + `test-automator`) runs the gates against the branch.

**Hard rule:** the game-developer pushes the branch only when it is **self-green locally**
(`npm test -- --run` passes on their machine). A red push is a process violation, not a handoff.

---

## 3. Quality gates (explicit + checkable)

### G-A — Spec acceptance (blocks Stage B)
- [ ] All seven sections §2.1.a–g present in `MP-CHARACTER-SYNC-SPEC.md`.
- [ ] Data-model section names every new/changed field with a type.
- [ ] WS section gives the exact wire shape for `join`, `session:state`, `session:update` deltas.
- [ ] Migration rule stated and explicitly preserves v1/v2 deserialization.
- [ ] Security section maps each inbound field to a clamp/validation rule and names the server as authority.
- [ ] Phased breakdown has `[ ]` acceptance criteria per phase and marks parallel work.
- [ ] Test plan lists new tests by file and asserts SP-no-WS coverage.
- **Verdict owner:** main thread. Fail → loop-back to PM (§4).

### G-B — Implementation self-green (game-developer's own gate before push)
- [ ] `npm test -- --run` passes on the dev machine, count **≥ 584 passed** (existing floor) plus the new tests; **0 failed**; skipped ≤ 2.
- [ ] Changelog artifact produced.
- **Verdict owner:** game-developer. Fail → do not push; fix locally.

### G-C — Integration gate (blocks merge to master)
- [ ] **G-C1 Test floor:** `npm test -- --run` green on the branch — **all existing tests pass + new tests pass**, 0 failed.
- [ ] **G-C2 Schema back-compat:** an explicit test loads a v1 payload and a v2 payload through `deserializeSession` and both succeed (no throw, sensible defaults for the new character field). If schema bumped to 3, a v3 round-trip test also passes.
- [ ] **G-C3 Single-player unaffected:** with no `?room=` param, `useWebSocket` is `enabled=false` (zero WebSocket created), the 30s poll still runs, and `sendMessage` hits Ollama directly. Verified by the existing SP tests staying green + a manual SP smoke run.
- [ ] **G-C4 Inbound character validated server-side:** a test sends a forged character (oversized name, NaN/999 ability, extra fields) over `join` and asserts the server clamps/strips it exactly like `displayName` — the forged values never reach `room.party` or the DM prompt.
- [ ] **G-C5 No secret/host leak:** grep/test confirms no `OLLAMA_HOST`, `MODEL_RE`, or server-only env is referenced in client bundle paths (`src/**`); these stay in `server/`.
- [ ] **G-C6 Prompt budget:** with the max design target of 5 players, `buildSystemPrompt` output stays within the spec'd token/char cap (test asserts the per-player summary is bounded).
- [ ] **G-C7 Mid-session join:** a late joiner receives every existing player's character via `session:state` (test or smoke).
- **Verdict owner:** main thread + `test-automator`. Fail → loop-back to game-developer (or PM if the failure is a spec ambiguity) per §4.

---

## 4. State model + error handling

### Workflow states
`SPEC_DRAFTING → SPEC_REVIEW →(G-A)→ IMPLEMENTING → SELF_VERIFY →(G-B)→ INTEGRATION →(G-C)→ MERGED`
Plus failure states: `SPEC_REWORK`, `IMPL_REWORK`.

### Transitions & loop-backs
| Trigger | From → To | Action |
|---|---|---|
| Spec missing a section / ambiguous field | SPEC_REVIEW → SPEC_REWORK | Main thread returns G-A checklist with the failing items to `product-manager`; PM revises `MP-CHARACTER-SYNC-SPEC.md`; re-run G-A. |
| Game-developer hits a spec gap mid-build | IMPLEMENTING → SPEC_REWORK | **Pause implementation.** Raise the ambiguity to PM with the exact decision needed (e.g. "widen party row vs sibling map"). PM amends spec; resume. Do not guess on data-model/WS/security items. |
| `npm test` red on push or G-C1 fails | INTEGRATION → IMPL_REWORK | Return the failing test names + output to `game-developer`; fix on branch; re-push; re-run all of G-C (not just the failed gate). |
| G-C2/C4/C5 fails (back-compat / security) | INTEGRATION → IMPL_REWORK | Same loop; these are **non-negotiable** — no waiver. |
| G-C3 fails (SP regression) | INTEGRATION → IMPL_REWORK | Highest-severity regression; fix before anything else. |
| A G-C failure is rooted in a spec decision (e.g. prompt budget impossible as specified) | INTEGRATION → SPEC_REWORK | Loop to PM, then back through B and C. |

### Rollback
- All work is on `feature/mp-character-sync`. **Nothing merges to `master` until every G-C box is checked.**
- A red branch is never merged (per the standing rule: never merge/push red code).
- If a gate cannot be met within the phase scope, the offending phase is reverted on the branch
  (the spec's phased breakdown makes phases independently revertable) and either re-scoped by PM
  (loop to SPEC_REWORK) or explicitly deferred in the changelog with PM sign-off — never silently shipped.
- The branch itself is the rollback boundary: if the whole feature is abandoned, the branch is dropped
  and `master` is untouched (584/2 baseline preserved).

---

## 5. Risk register

| # | Risk | Impact | Mitigation | Owner |
|---|---|---|---|---|
| R-1 | **Protocol / schema versioning** — bumping `SCHEMA_VERSION` (2→3) breaks loading of existing v1/v2 saves or `.md` files. | High — data loss / boot failure on upgrade. | Spec mandates additive migration; G-C2 test loads v1 + v2 payloads and asserts no throw + default character backfill. `.md` round-trip test. | PM (rule) → game-developer (impl) → test-automator (G-C2) |
| R-2 | **Mid-session joiners** — a player joining after play started never learns the existing party's characters (or existing clients never learn the joiner's). | High — DM and clients have an inconsistent party. | Spec requires `session:state` to carry the full per-player character set on every join/rejoin; G-C7 verifies a late joiner gets all characters. Reuse existing `NAME_TAKEN`/rejoin path so a reconnect re-binds the same character. | PM (protocol) → game-developer (server `join`) |
| R-3 | **Forged character stats** — a malicious/buggy client injects a 20-STR / 999-HP character over `join` or a per-message field. | High — breaks game balance, trusts client. | Server is authoritative: validate + clamp inbound character exactly like `sanitizeDisplayName`/`sanitizeActionContent` (string caps, numeric range clamps, strip unknown fields). Identity stays connection-bound (server ignores per-message identity for authz). G-C4 sends a forged payload and asserts it's clamped. | game-developer (server validator) → security-auditor if novel surface |
| R-4 | **DM prompt bloat with many players** — concatenating full stat blocks for 5 players inflates `buildSystemPrompt`, slowing/degrading Ollama and risking context overflow. | Medium — latency + worse DM narration. | Spec defines a bounded per-player summary (class/race + key stats only, not the full sheet); G-C6 asserts the prompt stays within cap at 5 players. Keep both genre engines identical. | PM (budget rule) → game-developer (prompt assembly) |
| R-5 | **Single-player regression** — changes to `join`/`useWebSocket`/`App.jsx` accidentally open a socket or alter the SP path. | High — violates the zero-WS-in-SP absolute constraint. | Spec marks SP path as untouched; G-C3 + existing SP tests guard it; `enabled=false` invariant in `useWebSocket.js` is not modified. | game-developer → main thread (G-C3) |
| R-6 | **Local/synced character divergence** — `dnd_character` (local sheet) and the synced character drift (HP edited locally vs party `hpPct`). | Medium — confusing UI. | Spec must state the source-of-truth rule (server-authoritative for the synced subset; local sheet remains the player's editable view) and which fields sync. Tested in the data-model phase. | PM (source-of-truth decision) |
| R-7 | **Spec ambiguity stalls implementation** — game-developer guesses on data-model/WS and creates rework. | Medium — wasted cycles. | Hard process rule (§4): any data-model/WS/security gap pauses Stage B and loops to PM; no guessing on high-risk surfaces. | main thread (enforces loop-back) |

---

## 6. Definition of Done
- [ ] `MP-CHARACTER-SYNC-SPEC.md` exists and passed G-A.
- [ ] Code on `feature/mp-character-sync` implements the spec; changelog produced.
- [ ] All of G-C (C1–C7) checked.
- [ ] Branch merged to `master` only after every gate is green.
