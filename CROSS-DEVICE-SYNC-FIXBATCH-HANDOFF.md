# Cross-Device Sync — Fix-Batch Session Handoff (resume here)

> **Status:** Review fix batch **applied + verified end-to-end**. Post-handoff sentinel bug caught + fixed.
> Verdict: **SHIP**. **274 tests green** (was 248, +26 including sentinel guard). Branch: `master` (uncommitted).
> **Last updated:** 2026-05-25
> **Resume at:** "Next steps" at the bottom — commit (if wanted) + the v1.1 SHOULD/NICE backlog.

This continues the cross-device session-persistence work. The 8-agent review
(`CROSS-DEVICE-SYNC-REVIEW.md`) returned **REWORK** for 2 MUST-FIX; this session applied the full
fix batch and verified it against the real running app + sync server. See `-HANDOFF.md` for the
original feature history and `-EVALUATION.md` for the canonical design.

---

## What landed this session

| Item | Where | Summary |
|------|-------|---------|
| **M7** (MUST) | `src/hooks/useSessionPersistence.js` `adopt()` | Strictly-newer gate: only overwrite local when `payload.savedAt > max(localStorage savedAt, lastSavedAt.current)`. When the server is NOT newer, keep local and rebase the next PUT on the **server's** stamp (not local) so the offline turn pushes up without a 409-deadlock. |
| **H4** (MUST) | `src/lib/session.js` `markOrphanedDice()`; `Chat.jsx` hydrate + verdict parser | Restored bare dice chips flagged `orphaned` on hydrate AND on hook adopt; verdict-target search excludes `orphaned` (`&& !m.orphaned`) so a later verdict can't hijack an old restored roll. |
| **SHOULD #1** | `Chat.jsx` `pendingCheck` init (comment) | **Decided: NOT reconstructed.** Skill/DC don't survive serialization (the ```check block is stripped from persisted content; `pendingCheck` is already cleared at roll-send). Persisting the raw value was ruled out by reviewers (cross-device "answered-twice" hazard). Self-heals on the DM's next ```check. |
| **SHOULD #2/#3** | `session.js` `deleteSyncSession()`; hook `onNewSession()`; `Chat.jsx` `handleNewSession` | New Session DELETEs the server copy + sets a max-date sentinel so an in-flight poll's adopt fails the M7 gate (no resurrection). |
| **SHOULD #7** | `server/sync-server.mjs` | Lock-Map entries deleted once the tail settles; `existsSync` removed → single async `readFile` (try/catch → missing) + `unlink` with `ENOENT` swallowed. |
| **SHOULD #5** | `session.test.js`, `useSessionPersistence.test.jsx`, `Chat.test.jsx` | +26 regression tests (M7 both directions, 409-keep-local, H4 orphan-on-adopt + verdict exclusion, `markOrphanedDice`, `deleteSyncSession`, `fromMarkdown` truncated-fence, QuotaExceeded trim-retry, **sentinel resurrection guard**). |
| Docs | `CROSS-DEVICE-SYNC-REVIEW.md`, `-HANDOFF.md` | Status/verdict flipped to SHIP; v1.1 backlog recorded. |

### One subtlety worth remembering (M7 ↔ LWW push-up)
When the M7 gate keeps the newer local copy, it sets `lastSavedAt.current = payload.savedAt`
(the **server's** stamp). Basing the next PUT on the local stamp instead would mismatch the server's
stored `savedAt` and 409-deadlock forever, stranding the offline turn. `onNewSession()` deliberately
does **not** set `adopting.current` — the clear fires no PUT (no loading falling edge), so a flag
would wrongly suppress the first real turn after a new session.

---

## Follow-up fix (caught post-handoff, applied 2026-05-25)

### New-Session sentinel bug
The original fix batch set `lastSavedAt.current = new Date(8640000000000000).toISOString()`
in `onNewSession()`, producing the string `'+275760-09-13T00:00:00.000Z'`. Under **string comparison**
the `'+'` prefix (ASCII 43) sorts BELOW any real-era date like `'2026-05-25...'` (ASCII `'2'` = 50),
**inverting the M7 strictly-newer gate** and allowing a just-deleted session to be resurrected by an
in-flight poll's `adopt()`.

**Fix:** changed sentinel to `'9999-12-31T23:59:59.999Z'`. This sorts **after** all real-era ISO
timestamps under string comparison, correctly blocking resurrection. Safe post-DELETE: after the
server's stored session is null, the first new turn's PUT skips the 409 staleness check and writes
cleanly (no deadlock).

**Verified:** regression test `onNewSession sentinel blocks a poll adopt after clearing` added to
`useSessionPersistence.test.jsx` (and inverted the prior `KNOWN-DEFECT` test that allowed resurrection).
Test suite: **274 green**.

---

## Verification performed (all PASS)

Ran against the real app: `node server/sync-server.mjs` (:3001) + `npm run dev:vite` (:5173),
driven via the Chrome MCP browser. Ollama was up but **not** needed — flows were exercised
deterministically by seeding localStorage + the server, avoiding nondeterministic LLM turns.

- **Server HTTP:** 404/200/304/409/200 lifecycle, `.md` round-trip, **DELETE-twice → 204** (the #7
  ENOENT path), path-traversal → 400.
- **M7 (browser):** server = older copy, localStorage = newer offline turn → reload → page shows the
  local turn, NOT the server's; localStorage preserved.
- **H4 (browser):** session ending on a bare roll → reload → chip renders bare (no verdict/check).
- **New Session (browser):** overrode the blocking `confirm()`, clicked 🗑 → server **200 → 404**
  (DELETE fired), UI + localStorage logically cleared, no poll resurrection.

> The verdict-targeting *exclusion* of orphaned chips (the part that would need a live LLM verdict
> block) is covered by unit tests, since model output isn't reproducible.
> Browser/extension gotchas seen (cosmetic only): drop-cap splits the first letter of a message
> (string `includes()` false-negatives — check the DOM), and return fields named `*Session*`/derived
> from `localStorage` get `[BLOCKED: Sensitive key]` by the extension filter.

---

## Files touched
- `src/hooks/useSessionPersistence.js` — M7 gate, `onNewSession`, orphan-on-adopt.
- `src/components/Chat.jsx` — hydrate orphan, verdict exclusion, `onNewSession` wiring, pendingCheck note.
- `src/lib/session.js` — `markOrphanedDice`, `deleteSyncSession`.
- `server/sync-server.mjs` — lock cleanup, async readFile/unlink.
- `src/lib/session.test.js`, `src/hooks/useSessionPersistence.test.jsx`, `src/components/Chat.test.jsx` — tests.
- `CROSS-DEVICE-SYNC-REVIEW.md`, `CROSS-DEVICE-SYNC-HANDOFF.md` — status → SHIP.

## Next steps (resume here)
1. **Commit** the fix batch + sentinel bug fix if desired (not yet committed). Suggested message:
   `fix(sync): M7 offline-turn guard + H4 orphaned dice + New-Session server-clear + sentinel bug; +26 tests`.
2. **v1.1 SHOULD/NICE backlog** (none block v1 ship — full detail in `CROSS-DEVICE-SYNC-REVIEW.md`):
   - #4 sync-status surface (badge) — observability backstop for M7's silent divergence.
   - #6 QuotaExceeded "history trimmed" non-blocking notice.
   - #8 `dnd_party` single persistence owner (still written inside the `setParty` updater in
     `Chat.jsx`'s block parser) + server PUT ships full untrimmed history.
   - #9 document `fromMarkdown`'s fence-regex coupling (safe only because Chat strips blocks first).
   - **New sibling issues (post-sentinel fix):** `deleteSyncSession` retry on network failure;
     post-new-session poll overhead; poll `!==` guard code smell.
   - NICE: orphan `.tmp` cleanup on server startup; move `stored` parse into the `useState` lazy init.
3. Optional true cross-device E2E: two real devices on the LAN with a live Ollama turn through the
   M7/H4/New-Session flows (this session verified deterministically without the LLM).
