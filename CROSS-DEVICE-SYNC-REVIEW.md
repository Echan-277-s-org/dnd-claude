# Cross-Device Sync — Post-Implementation Review (resume here)

> **Status:** Implementation complete (Phases A, A2, B). **8-agent review done → fix batch applied.**
> **Verdict: SHIP** — both MUST-FIX (M7, H4) and the cheap consensus SHOULD-FIX (#1 docs/decision,
> #2, #3, #7) are resolved; **274 tests green** (was 248, +26 regression tests, including post-handoff sentinel bug guard).
> **Last updated:** 2026-05-25
> **Resume at:** nothing blocking — see "Fix batch (resolved items)" + v1.1 backlog (with three new sibling issues).

This captures a multi-agent review of the shipped cross-device session-persistence work
(`CROSS-DEVICE-SYNC-EVALUATION.md` = original design; `-HANDOFF.md` = what shipped). Orchestrated
by `workflow-orchestrator` (facet-ownership matrix), then 8 reviewers dispatched in parallel and
synthesized under a MUST-FIX / SHOULD-FIX / NICE rubric with domain-authority tie-breaks.

---

## Headline verdict: REWORK → then SHIP

All six acceptance gates passed on the first 6-agent pass (SHIP-WITH-TICKETS), but the follow-up
review by **ai-engineer** and **game-developer** each surfaced one **MUST-FIX silent
state-corruption bug**. Both are ~5–6 lines. Fix them (plus the cheap consensus SHOULD-FIX wins),
re-run `npm test -- --run`, and the suite clears back to SHIP.

The hard prior-eval work is confirmed genuinely closed: all **6 MUST-FIX (M1–M6)** verified by
backend-developer; **M2 (campaign.context sync)** confirmed closed by llm-architect; prompt
determinism + context-window bounding confirmed.

---

## MUST-FIX (2) — block ship ✅ RESOLVED

### M7 — stale server overwrites a newer offline turn (silent data loss) *(ai-engineer)* ✅
`src/hooks/useSessionPersistence.js:35-42` (adopt) + `:45-50` (mount load).
The mount `adopt()` overwrites local state **unconditionally** whenever the server is reachable.
Failure path: play a turn while the server is down → localStorage saves, the server PUT fails
silently (`saveSyncSession → {ok:false}`), `lastSavedAt` never advances → next mount with the
server back up adopts the **older** server copy and silently discards the offline turn. Load order
enforces precedence only in the server-newer direction.
**Fix:** gate `adopt()` on `payload.savedAt > localSavedAt`. The localStorage payload already
carries `savedAt` (App stamps it on restore; the Phase-A serialize stamps `now`), so read the
local `dnd_session` savedAt at mount and only overwrite when the server is strictly newer.
✅ **FIXED (2026-05-25):** Strictly-newer gate implemented in `adopt()` (:52–67); compares as
ISO strings, rebases on server stamp when keeping local (no 409-deadlock). Verified by unit tests
(M7 both directions, equal-timestamp boundary, rebase guard).

### H4 — restored trailing bare dice chip catches the next verdict *(game-developer)* ✅
`src/components/Chat.jsx:302-313` (verdict parser targets "most-recent dice msg with `verdict==null`").
A saved session naturally ends on an unresolved roll. On restore that bare chip persists; the next
LLM turn's `verdict` block attaches to it, stamping PASS/FAIL on an unrelated old roll (often
scrolled off-screen → invisible corruption). Pre-existing parser behavior, but restore makes
ending-on-a-roll the common case.
**Fix:** mark restored bare dice chips `orphaned: true` on hydrate/adopt and exclude `orphaned`
chips from verdict targeting in the parser.
✅ **FIXED (2026-05-25):** `markOrphanedDice()` added to `session.js`; applied on hydrate and on
hook adopt; verdict-target search now excludes `orphaned` chips (`:&& !m.orphaned` in `Chat.jsx`).
Verified by unit tests (orphan on adopt, verdict exclusion).

---

## SHOULD-FIX — track; several are cheap consensus wins

1. **Restore/reconstruct `pendingCheck`** — *3-reviewer consensus (prompt-engineer, llm-architect,
   game-developer)*. Today it's excluded from the payload (correct, to avoid the original
   "answered-twice" sync hazard) but that breaks the verdict chip for the first roll after a
   mid-check save/reload. game-developer's clean fix: **don't persist the raw value — reconstruct
   it on load** by scanning the restored transcript for a trailing bare roll that followed a
   `check`. `src/lib/session.js` (load path) + `Chat.jsx:107`.
2. **`handleNewSession` must DELETE the server session** — *game-developer H6/H7*.
   `Chat.jsx:352-360` clears localStorage only; the DELETE route exists (`sync-server.mjs:123`) but
   isn't called → a second device's 30s poll can resurrect the cleared session. (Same-device is
   safe — the `savedAt` poll guard holds.)
3. **In-flight poll race on New Session** — *qa-expert*. If a poll fetch is in flight when New
   Session fires, the resolved `adopt()` restores the cleared session. Fix: bump `lastSavedAt` to a
   sentinel (or cancel the poll) in `handleNewSession`. `useSessionPersistence.js:77`.
4. **Sync-status surface (badge)** — *ai-engineer, promoted NICE→SHOULD*. It's the observability
   backstop that makes M7's silent divergence visible.
5. **Missing regression tests** — *test-automator*. (a) `Chat.jsx` per-turn `!isLoading`
   localStorage gate — a regression to per-delta writes passes CI today (Chat isn't rendered in
   `Chat.test.jsx`); (b) QuotaExceeded trim-retry; (c) hook 409-keep-local leaves `lastSavedAt`
   unchanged; (d) poll `onNewer` → `setMessages`/`setParty` propagation; (e) `fromMarkdown` with a
   truncated/no-closing-fence block returns null.
6. **QuotaExceeded silent divergence** — *performance-engineer*. Trim-retry leaves localStorage
   holding ⅔ history while memory/server hold full; a refresh then loses the oldest third with no
   warning. Surface a non-blocking "history trimmed" notice. `Chat.jsx:135-142`.
7. **Server lock-Map leak + sync `existsSync`** — *backend-developer*. `locks` entries never
   deleted after settle (unbounded on long uptime — `sync-server.mjs:52-57`, delete entry once the
   tail settles); `existsSync` in the `GET /sessions` async loop blocks the event loop
   (`sync-server.mjs:41` — use `readFile` + try/catch).
8. **`dnd_party` single-owner refactor not done + server payload never trimmed** — *ai-engineer /
   refactoring*. `dnd_party` still written inside the `setParty` updater (`Chat.jsx:283-285`) with
   App.restore as a second writer; the promised move into the hook is outstanding. Server PUT ships
   full untrimmed history (`useSessionPersistence.js:63`).
9. **`fromMarkdown` hidden coupling** — *prompt-engineer*. Its fence regex is only safe because
   `Chat.jsx` strips structured blocks before persisting `content`. Document it or anchor the
   closing fence. `session.js:206`.

---

## NICE — backlog

### v1.1 SHOULD-FIX (new, sibling to M7/H4 fix batch)
- **deleteSyncSession retry** — Fire-and-forget DELETE has no retry; if the sync server is briefly
  unreachable at New-Session time, the stale file persists and a second device's poll can still
  resurrect it (the M7 sentinel only guards the local device). (game-developer / network resilience)
- **Post-new-session poll overhead** — Full payload still ships until the first real turn re-stamps
  `savedAt` on the server, wasting bandwidth on an empty session. (perf / bandwidth optimization)
- **Poll guard inertness** — The `!==` guard on the poll's `getLastSavedAt()` callback is inert after
  `onNewSession` (design smell); protection rightly defers to the M7 gate, but the guard reads poorly.
  (code quality / documentation)

### v1.1 NICE items (pre-existing backlog)
- Orphan `.tmp` cleanup on server startup; `?since` exact-string-equality fragility (backend).
- Move `stored` in `Chat.jsx:95` into the `useState` lazy initializer (currently re-parses every
  render) (qa).
- Full-payload PUT at scale (~1 MB at 500 msgs); dead-server fires a silent fetch error every 30s
  (perf).
- Add a condensed block-emission protocol to the `.md` "Continue from here" prose so a cold LLM
  (no app) still emits `party`/`check`/`verdict` fences (prompt-engineer).
- Restored party may diverge on first re-emission if members were established in now-trimmed
  messages (llm-architect — pre-existing trim-window property, amplified by phones resuming
  mid-combat).
- Poll 409 silent-drop on a simultaneous same-base LWW collision (game-developer).

---

## Deferred — confirmed NOT blockers (product-manager ruling)
Phone onboarding / IP / QR · sync-status badge*  · history retention cap · `character` (player
HP/stats) sync · non-destructive 409 **merge** · simultaneous co-play · mid-stream poll clobber ·
`sessions/` git policy decision.
(*the sync-status *badge* is deferred as a feature, but ai-engineer promoted shipping *some* status
surface to SHOULD-FIX #4 as M7's observability backstop.)

PM verdict: hard user requirement (save & continue from `.md`) is first-class and preserved; no
scope creep; all deferred items documented. Ships as v1 once the 2 MUST-FIX clear.

---

## Closed hazards / confirmed-safe (don't re-litigate)
- **M1–M6** all genuinely closed (backend). **M2 context+model sync** closed (llm-architect).
- **H1** UUID split-brain, **H2** campaign-in-payload, **H8** schemaVersion validation — closed
  (game-developer).
- **Entity re-derivation** byte-identical on restore; **trimContext + num_ctx:8192** bound the
  window regardless of restored history length (llm-architect).
- **`party` precedence** correctly enforced by load order in the server-newer direction
  (ai-engineer) — M7 is the missing reverse-direction guard.
- **Stream-delta hot path**: `!isLoading` gate confirmed correct on both the Chat localStorage
  effect and the hook PUT (performance-engineer) — the prior eval's top perf MUST-FIX stays fixed.
- **applyPartyUpdate whitespace/case churn**: NOT a bug — `Chat.jsx:43-44` already `.trim().toLowerCase()`
  both sides (downgraded game-developer's MUST to NICE; churn only on a true rename).

---

## Fix batch (DONE — 2026-05-25)
1. ✅ **M7** — `useSessionPersistence.js` `adopt()` now gates on a STRICTLY-NEWER server stamp,
   comparing `payload.savedAt` against `max(localStorage savedAt, lastSavedAt.current)`. When the
   server is not newer it keeps local untouched and rebases the next PUT on the **server's** stamp
   (not local) so the offline turn pushes up without a 409-deadlock.
2. ✅ **H4** — `markOrphanedDice()` added to `session.js`, applied on hydrate (`Chat.jsx` lazy init)
   and on `adopt` (hook); the verdict-target search now excludes `orphaned` chips
   (`Chat.jsx` `&& !m.orphaned`).
3. ✅ **SHOULD #1** — **decided: NOT reconstructed** (documented in `Chat.jsx` `pendingCheck` init).
   The skill/DC signal does not survive serialization — the ` ```check ` block is stripped from the
   persisted content and `pendingCheck` is already cleared at roll-send time, so a save never carries
   a live check. Reviewers also ruled out persisting the raw value (cross-device "answered-twice"
   hazard). It self-heals on the DM's next ` ```check ` block.
4. ✅ **SHOULD #2** — `deleteSyncSession()` added to `session.js`; the hook exposes `onNewSession()`
   (DELETE + sentinel) and `handleNewSession` calls it.
5. ✅ **SHOULD #3 (NEW-SESSION SENTINEL BUG)** — folded into #4, but **post-handoff bug fix added
   2026-05-25:** The original sentinel was `new Date(8640000000000000).toISOString()` → `'+275760-09-13T00:00:00.000Z'`.
   The `'+'` prefix (ASCII 43) sorts BELOW `'2'` (ASCII 50) under string comparison, **inverting the M7 gate**
   and allowing resurrected sessions. **Fixed:** sentinel changed to `'9999-12-31T23:59:59.999Z'` (sorts after
   all real-era ISO dates). Regression test added (`onNewSession sentinel blocks a poll adopt`). The fix
   is safe post-DELETE — no deadlock (first new turn rebases on server's post-DELETE state).
6. ✅ **SHOULD #7** — `sync-server.mjs`: lock-Map entries deleted once the tail settles; `existsSync`
   removed in favor of a single async `readFile` (try/catch → missing) and `unlink` with `ENOENT`
   swallowed.
7. ✅ **SHOULD #5** — 26 regression tests added: M7 both directions, 409-keep-local, H4 orphan on
   adopt + verdict-target exclusion, `markOrphanedDice`, `deleteSyncSession`, `fromMarkdown`
   truncated-fence, QuotaExceeded trim-retry, **and sentinel resurrection guard**. `npm test -- --run` → **274 green**.

Deeper SHOULD/NICE items (4 sync-status surface, 6 quota notice, 8 `dnd_party` single-owner refactor +
server payload trim, 9 `fromMarkdown` coupling doc, plus three new post-handoff sibling issues) remain for **v1.1**.

---

## Resumable review agents (SendMessage by id)
workflow-orchestrator `aa83534d6a8cbf66f` · backend-developer `ac8a990e54ace1146` ·
qa-expert `aae72df8ae0973213` · test-automator `ac2cf3606ed076416` ·
performance-engineer `a318198f52d76e12b` · product-manager `abb635be3d6d742cf` ·
prompt-engineer `ac6d8d2e94634a6ca` · llm-architect `afca8b41bb2b2d9c4` ·
ai-engineer `ae63947e746e9b77c` · game-developer `a73e8ff64a45e154f`
