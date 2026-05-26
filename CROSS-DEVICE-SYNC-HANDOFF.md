# Cross-Device Sync — Session Handoff (resume here)

> **Status:** **Phases A, A2, and B implemented + review fix batch applied** (2026-05-25). All 6
> MUST-FIX shipped; the 8-agent review's M7 + H4 MUST-FIX and SHOULD #1/#2/#3/#7 are resolved.
> **264 tests green** (was 248). Open question #1 decided: **server stores `.md` files**.
> **8-agent review → `CROSS-DEVICE-SYNC-REVIEW.md` (verdict now: SHIP).**
> **Last updated:** 2026-05-25
> **Resume at:** nothing blocking v1. Remaining = the v1.1 SHOULD/NICE backlog in REVIEW.md
> (sync-status surface, quota notice, `dnd_party` single-owner refactor, server payload trim).

This is the continuation pointer for the cross-device session-persistence work. It ties together
the artifacts produced this session and records the decisions so a future session (or a fresh
LLM) can pick up without re-deriving anything.

---

## What this work is

Add cross-device session persistence to the dnd-claude app so a player can start on desktop and
continue on phone over the LAN — and, per a hard user requirement, **save/continue a session from
a Markdown file that any LLM can load**. Began as a request to run a 7-agent evaluation of the
approved-but-unimplemented `CROSS-DEVICE-SYNC-PLAN.md`.

## Where things stand

1. **Evaluated** `CROSS-DEVICE-SYNC-PLAN.md` with 7 agents (PM, game-dev, llm-architect,
   ai-engineer, backend, performance, refactoring), orchestrated by a `multi-agent-coordinator`
   facet matrix + a `task-distributor` dispatch plan.
2. **Synthesized** the result into **`CROSS-DEVICE-SYNC-EVALUATION.md`** — the canonical doc.
   Verdict: ship Phase A first; the original Phase B is **not** shippable as written (6 MUST-FIX).
3. **Reinstated Markdown save/continue** (the plan's declined Option C) as a required Phase **A2**,
   with finalized format/folder decisions (below).

## Decisions locked in

- **Build order: A → A2 → B.**
  - **A** — localStorage message persistence (survive refresh). Must persist **once per turn**,
    not per stream delta (perf MUST-FIX).
  - **A2** — Markdown save & continue (user-required, independently shippable, no server).
  - **B** — Express LAN sync server (live convenience layer; reworked per the 6 MUST-FIX).
- **Usage = handoff-first** (one device at a time). Simultaneous co-play + its mid-stream
  in-flight signal are deferred to a later phase.
- **Phone goes straight into the synced session** → `campaign` (name/genre/details/context/model)
  **must** be in the payload (overrides the plan's "App.jsx: no changes").
- **Markdown format = fenced ` ```session ` block** (not YAML frontmatter).
- **Two folders:** `campaigns/` (authored world-notes → `campaign.context`, exists) and
  **`sessions/`** (app-generated saves, created this session with a README).
- **The md file is a self-contained LLM handoff:** prose = DM brief (role → recap → party/scene →
  transcript); the fenced block is only for lossless app restore. Pasting
  `campaigns/<name>.md` + `sessions/<name>.md` into any LLM = playable.
- **One serialize layer** in `src/lib/session.js`: `serializeSession`/`deserializeSession` +
  `toMarkdown`/`fromMarkdown`, feeding localStorage + .md + sync server from one payload shape.
- `entities` excluded (re-derived via `extractEntities`); `pendingCheck` excluded from the block
  in v1 (shown as a prose line); JSON files over SQLite for the server.

## 6 MUST-FIX for Phase B (full detail in EVALUATION §2)

1. Stable `sessionId` (uuid in `campaign`), not a name slug — slug collisions + per-device UUID
   split-brain silently break sync.
2. Sync the `campaign` object (else fresh phone has no system prompt / never leaves setup).
3. CORS + OPTIONS preflight on the server (omitted from the plan; hard browser block).
4. Path-traversal guard on `:id`.
5. Atomic writes (temp+rename) + per-session write lock (TOCTOU on the 409 guard).
6. Streaming hotpath — save per turn via `isLoading` edge effect, not a `[messages]` effect; no
   side-effect inside `setMessages` (StrictMode double-PUT → 409).

## Artifacts this session

| File | What |
|------|------|
| `CROSS-DEVICE-SYNC-EVALUATION.md` | **Canonical** — verdict, MUST/SHOULD tiers, §2.5 md design, revised plan, per-agent findings, agent IDs |
| `CROSS-DEVICE-SYNC-PLAN.md` | Original approved plan (now superseded by the evaluation; kept for reference) |
| `sessions/README.md` | New folder + documented session-file format |
| `~/.claude/.../memory/md-save-continue-requirement.md` | Memory: the md save/continue requirement + finalized decisions |
| `~/.claude/plans/snug-meandering-tower.md` | Plan-mode copy of the revised plan |

## Open questions (decide before/while implementing B)

1. Should the Phase B sync server **store the same `.md` files** (store is itself LLM-loadable —
   current lean) or keep JSON internally and convert at the edge?
2. `sessions/` git policy — commit saves, or `.gitignore` them (keep only README)?
3. SHOULD-FIX backlog (sync-status UI, history retention cap, non-destructive 409,
   `handleNewSession` server-clear, `character` sync) — which land in v1 vs later. See EVALUATION §4.

## What shipped (2026-05-25)

- **Phase A** — `Chat.jsx` hydrates `messages`/`sessionLog` from `dnd_session`; persists once per
  settled turn via an `!isLoading` effect (not per delta) with `QuotaExceededError` trim+retry;
  `handleNewSession` clears the key. `campaign.sessionId` minted once in `App.jsx` (`loadSessionId`, M1).
- **Phase A2** — `src/lib/session.js` (one serialize layer: `serialize/deserialize`,
  `toMarkdown/fromMarkdown`, `getLanHost`, sync API). 💾 **Save session (.md)** button in `Chat`;
  **Load .md file** extended (`App.jsx#handleRestoreSession`) to detect a ` ```session ` block and
  boot straight into the restored session (adopts `campaign`, M2). Lossless round-trip unit-tested.
- **Phase B** — `server/sync-server.mjs` (stores `.md`, reusing the serialize layer) with all 6
  MUST-FIX: stable id, campaign in payload, CORS+OPTIONS, path-traversal guard, atomic temp+rename +
  per-session lock + server-stamped `savedAt`, per-turn (not per-delta) client save.
  `src/hooks/useSessionPersistence.js` wires server-authoritative load + per-turn push + 30s poll
  into `Chat`. `npm run dev` now runs vite + sync concurrently; `server/sessions/` gitignored.
- **Tests:** `src/lib/session.test.js` (28), `server/sync-server.test.mjs` (12, node-env),
  `src/hooks/useSessionPersistence.test.jsx` (5). Total 203 → **248**.

## Remaining work (SHOULD-FIX backlog — none block v1 handoff)

- **Phone LAN onboarding** — show desktop IP / QR so a fresh phone learns *which* `sessionId` to
  load (without it, devices must already share a sessionId). Biggest gap for true zero-touch cross-device.
- **Sync-status UI** (synced / offline / stale badge) — divergence is currently silent.
- **History retention cap** on save (reuse `trimContext`'s horizon); **`character` sync**;
  **non-destructive 409 merge** (v1 just keeps local + lets the poll reconcile); **`schemaVersion`
  upgrade path**. See EVALUATION §4.
- **Single persistence owner for `dnd_party`** — still written inside the `setParty` updater in
  `Chat.jsx`'s block parser (refactoring SHOULD-FIX); move into the hook.
- **Open question #2** — root `sessions/` git policy (README tracked; saves currently untracked-by-habit,
  no rule). Decide commit-vs-ignore.

## Resumable evaluation agents (SendMessage by id)

product-manager `a867cc7cd99811a3d` · multi-agent-coordinator `a40dbea195ca8b2f3` ·
task-distributor `aadc82751e0c1f869` · game-developer `a9279d46c4c9e01cd` ·
llm-architect `aaa58b9774a199014` · ai-engineer `ae8945afb2190ae8b` ·
backend-developer `aac2378a139253643` · performance-engineer `a67979cb95f0814bc` ·
refactoring-specialist `ab0f584cfbe53da91`
