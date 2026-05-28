# PR #6 Rebase Investigation & Plan

> Investigation performed 2026-05-28 after PR #10 (`harness-200-hardening`) was merged to master (`c2731ec`).
> PR #6 (`impish-qwen-swap`) was opened against master `45db1a8a` on 2026-05-27 and is now 13 commits out of date, with deep semantic conflicts on 4 game-state files.

## TL;DR

PR #6's single commit (`1df07fd`) claims six changes. After investigation, **four of the six are already on master** (added independently by intervening commits with byte-identical implementations). The remaining two changes — adding `impish-qwen:14b` to the model dropdown plus prompt-rule additions — are real and worth keeping, but a naive `git rebase` would silently regress PR #10's hardening and the token-budget `trimContext` rewrite.

**Recommended action:** discard PR #6's now-redundant changes and cherry-pick only its unique additions onto a new branch (`impish-qwen-rebased`). Land via a new PR; close PR #6 with a pointer.

---

## Diagnosis: what's already on master

Between PR #6's base (`45db1a8a`) and current master (`c2731ec`), 13 commits landed. Notable:

- `5d9d430` — UX: always-on setup, character export
- `315dc15` — feat(context): per-model num_ctx + token-budget trimContext
- `5398a9c` — test(context): trim suites + numCtxForModel + budget tests
- `4c5002c` — fix(mp): move 4-player continuity ceiling from round 16 to ~500+ (raises `SERVER_FACTS_CAP` from 12 → 20)
- `036be32` — fix(context): repair harness willTrim ref + thread systemContent
- `3bf8da8` — PR #8 merge (4-player continuity)
- `c2731ec` — PR #10 merge (200-round hardening, including hardened `anchorJoinedPCNames`, English-only guardrail, anti-copy worked-example warning, 9 new unit tests)

### PR #6 claim audit

| PR #6 claim | Status on current master |
|---|---|
| `numCtxForModel()` in `src/lib/session.js` | **Already byte-identical** (master line 110-114) |
| Wire `numCtxForModel` into `Chat.jsx` | **Already wired** (master line 519, 569) |
| Wire `numCtxForModel` into `sync-server.mjs` | **Already wired** (master line 1159, 1162, 1213) |
| `MODEL_RE` accepts `impish-qwen:14b` | **Already true** (master regex `/^[a-zA-Z0-9._:-]{1,64}$/`) |
| Add `impish-qwen:14b` to `OLLAMA_MODELS` dropdown | **NEW** (1 line in `ApiKeySetup.jsx`) |
| Prompt tuning (no-self-roll, DC-cap, REMINDER, verdict-CRITICAL) | **NEW** (partially — see Step 4 below) |

---

## What the 4 "conflict" files actually contain

### `src/lib/context.js` — structural conflict
- **Master has, PR #6 deletes:** the entire token-budget `trimContext` rewrite (`estimateTokens`, `NUM_PREDICT_RESERVE`, `SAFETY_MARGIN`, `DEFAULT_RESERVE_TOKENS`, dynamic reserve from `systemContent`, soft-cap, reference-equality short-circuit) — ~80 lines.
- **Master has, PR #6 deletes:** `- Always write in English only. Never emit Chinese, Japanese, Korean, or any non-Latin script characters…` (added by PR #10).
- **Master has, PR #6 deletes:** the anti-copy `CRITICAL: the member names shown in the worked example below…` warning (added by PR #10).
- **Master has, PR #6 deletes:** the `Aelis/Borin` placeholder names + `do NOT copy them; list this campaign's real party members instead` clause.
- **PR #6 adds (truly new):** DC-band 5e guide bullet; extended no-self-roll language; verdict-block CRITICAL clause; REMINDER footer.

### `src/lib/context.starwars.js`
Structurally parallel to `context.js`. PR #6 also renames `Veth/Daro` placeholders **back** to `Aelis/Borin` (inverse of an intervening master change). KEEP master's `Veth/Daro` names.

### `server/sync-server.mjs` — structural conflict
- **Master has, PR #6 deletes:** PR #10's hardened `anchorJoinedPCNames` — total-confabulation safety net, Pass 1 (role-matched global), Pass 2 (same-slot with role guard), Pass 3 (cross-slot 1:1 with role compatibility) — ~150 lines, plus the 9 unit tests in `multiplayer.test.mjs`.
- **PR #6 changes:** `SERVER_FACTS_CAP = 12` (master is `20`, raised by commit `4c5002c`). Drop — would regress 4-player continuity ceiling.
- **PR #6 adds (no longer unique):** numCtx wiring (already on master, byte-identical).

### `server/sync-server.multiplayer.test.mjs`
- **Master has, PR #6 deletes:** ~445 lines of PR #10's 9 hardening tests + intervening test additions.
- **PR #6 adds (truly new):** 2 tests — `per-model num_ctx: a qwen2.5:32b room sends num_ctx 8192` and `no party prefill: …does NOT send a trailing assistant party block`. KEEP both.
- **PR #6 modifies:** existing default-`num_ctx` assertion to literal `32768`. Master already uses `numCtxForModel('qwen2.5:14b')` — cleaner. SKIP this modification.

---

## Verified-unique content to cherry-pick

| Change | File | Action |
|---|---|---|
| Dropdown entry for impish-qwen | `src/components/ApiKeySetup.jsx` | +1 line |
| Modelfile + setup notes | `ollama/IMPISH-SWAP-NOTES.md`, `ollama/Modelfile.impish-qwen` | new files (114 + 39 lines) |
| Extended no-self-roll bullet | `context.js`, `context.starwars.js` | replace existing bullet |
| DC-band 5e guide bullet | `context.js`, `context.starwars.js` | insert after no-self-roll |
| Verdict-block CRITICAL clause | `context.js`, `context.starwars.js` | append to item 3 |
| REMINDER footer | `context.js`, `context.starwars.js` | append after closing line |
| 2 net-new multiplayer tests | `server/sync-server.multiplayer.test.mjs` | insert in Phase 3 describe |
| Impish-qwen validation section | `docs/design/PARTY-HUD-QWEN-VALIDATION.md` | append (+489 lines) |

---

## Execution plan

1. **Branch.** `git checkout -b impish-qwen-rebased origin/master` (start from `c2731ec`).
2. **`src/components/ApiKeySetup.jsx`** — `Edit` to insert the impish-qwen dropdown entry after the qwen2.5:32b line.
3. **`ollama/IMPISH-SWAP-NOTES.md`** + **`ollama/Modelfile.impish-qwen`** — `Write` from PR #6's verbatim content.
4. **`src/lib/context.js`** — 4 `Edit` operations:
   - 4a. Replace the existing "When an action requires a roll…" bullet with PR #6's extended version (no-self-roll language).
   - 4b. Insert the DC-band 5e guide bullet immediately after 4a.
   - 4c. Append the verdict-block CRITICAL clause to the end of item 3 (do not substitute a different skill or DC.").
   - 4d. Append the REMINDER footer after `Stay in the DM role. Make every choice feel meaningful. Keep the adventure moving.`
5. **`src/lib/context.starwars.js`** — same 4 edits, adapted to GM/Star Wars wording (parallel structure to context.js). Preserve master's `Veth/Daro` example names.
6. **`server/sync-server.multiplayer.test.mjs`** — `Edit` to insert 2 new `it(...)` blocks inside the existing `describe('Phase 3 — exactly one Ollama call per action', …)` block, after the existing `'exactly one Ollama call per action'` test. No other modifications.
7. **`docs/design/PARTY-HUD-QWEN-VALIDATION.md`** — `Edit` to append PR #6's "## Impish QWEN 14B (impish-qwen:14b) Validation" section (line 380 onward in PR #6).
8. **Validate.**
   - `npm test -- --run` — expect **905 pass / 2 skip** (master's 903 + 2 new tests).
   - `npm run build` — expect clean.
9. **Commit.** Single commit on `impish-qwen-rebased`:
   ```
   feat: add impish-qwen:14b model + prompt hardening (rebased PR #6)

   Cherry-picks PR #6's unique content onto current master.
   4 of PR #6's 6 claimed changes were already on master via
   intervening commits (315dc15 per-model num_ctx, 5398a9c tests,
   plus PR #10 hardening). Only the dropdown entry, ollama files,
   prompt-rule additions, and 2 net-new tests are retained.
   ```
10. **Push** to new remote branch `impish-qwen-rebased` (do **NOT** force-push the original author's branch — keeps their history intact).
11. **Open new PR** titled "Add Impish QWEN 14B + prompt hardening (rebase of #6)", base `master`, head `impish-qwen-rebased`. Body explains the rebase and credits PR #6.
12. **Comment on PR #6** linking to the new PR; recommend closing #6.

---

## Drop entirely (already done on master)

These changes from PR #6 must NOT be re-applied:
- `src/lib/session.js` — `numCtxForModel`, `DEFAULT_NUM_CTX`, `NUM_CTX_BY_MODEL` (byte-identical on master)
- `src/components/Chat.jsx` — `num_ctx: numCtxForModel(...)` wiring (master line 519, 569)
- `server/sync-server.mjs` — `numCtxForModel(model)` import + use (master line 32, 1162, 1213)
- `src/lib/session.test.js` — `DEFAULT_NUM_CTX` import (already present on master)
- `multiplayer.test.mjs` — `num_ctx: 32768` literal assertion modification (master uses helper)

These changes from PR #6 are **regressions** and must NOT be reverted from master:
- Old fixed-count `trimContext` (master's token-budget version is strictly better)
- Old single-pass `anchorJoinedPCNames` (master has PR #10's 3-pass hardened version)
- `SERVER_FACTS_CAP = 12` (master's `20` came from continuity-fix commit `4c5002c`)
- Removal of English-only guardrail (came from PR #10)
- Removal of anti-copy worked-example warning (came from PR #10)
- Renaming Star Wars example party from `Veth/Daro` back to `Aelis/Borin`

---

## Risks

1. **Prompt strengthening, not weakening.** PR #6's stronger no-self-roll text replaces master's shorter version. Both convey the same rule; PR #6 is more forceful. The 200-round endurance run on master used the milder version. Swap is additive (also adds DC-cap and REMINDER) — no logical regression, but no 200-round revalidation either.

2. **DC-band rule is a behavior nudge.** "Reserve DC 20+ ONLY for genuinely difficult feats" caps routine DCs at 20. This was an explicit design call from PR #6's `qwen2.5:14b` validation (observed DCs of 23-25). Master's prompt doesn't enforce a cap.

3. **No live LLM validation.** I will not run the 200-round endurance harness (~2.6h). Test gate is `npm test`. Recommend a smoke run post-merge.

4. **Compressed PR diff vs PR #6's original.** The new PR's diff will be ~600 lines (mostly the doc append) versus PR #6's claimed +755. The compression reflects how much was already done independently — the new-PR description should call this out explicitly to avoid confusion.

5. **`git rebase` would silently corrupt master.** I considered using `git rebase origin/master` then resolving conflicts. Rejected — the conflicts are structural (whole-function rewrites of `trimContext` and `anchorJoinedPCNames`); the wrong "ours" / "theirs" choice would silently regress ~150 lines of PR #10's hardening with no test failure if PR #6's tests were also kept. Surgical cherry-pick eliminates this class of error.
