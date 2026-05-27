# Context-Window & Continuity Fix — Implementation Plan (handoff)

**Status:** PLANNED, not started. Authored 2026-05-27 as a handoff so it can be implemented in a fresh session.
**Implementation:** Implemented in branch `feat/context-window-continuity` — token-budget trimContext + per-model num_ctx; reserve dynamic from systemContent; pinned=8; FACTS_CAP=20.
**Scope decision (made by user):** **FULL FIX, INCLUDING SINGLE-PLAYER.** This deliberately breaks the historical "single-player byte-identical `trimContext`" invariant — see §4.
**Branch/landing:** must land via a **gated PR** (build → test → review → merge). Direct pushes to `master`/`main` are now blocked by a PreToolUse hook (`H:\Claude\.claude\hooks\block-default-push.sh`); use `gh pr create` → gates → `gh pr merge`. See memory `feedback-gate-all-via-pr`.

---

## 1. How to use this doc

Read §2–§4 for the *why* and the decisions, then implement §5 (three parts), update tests per §6, validate per §7, and ship per §8. All line numbers are from `master` @ commit `d83fb0c` and **may drift — grep/read to confirm before editing.**

---

## 2. Background & motivation

The dual-model 4-player endurance test (`stress-test/4P-DUAL-MODEL-FINDINGS.md`, committed `d83fb0c`) found that **both** `qwen2.5:14b` and `impish-qwen:14b` collapse on continuity (`stop_reason=B_COLLAPSE`): the DM forgets/​confabulates established anchors (NPC names, the blacksmith, gold amounts, the rival faction) as the session grows. `qwen2.5:14b` lasted to `R_continuity=40`; `impish-qwen:14b` to `R_continuity=12`. Neither leaked CJK; neither hard-failed. The headline limiting factor for the app is **continuity**, and the report flagged the hardcoded context window as the top caveat.

## 3. Root cause: there are TWO levers, not one

Raising `num_ctx` **alone is cosmetic.** Continuity is bounded by **what the app actually sends to the model**, which is `trimContext` (`src/lib/context.js:400`), NOT by Ollama's `num_ctx`:

- `trimContext(messages, { pinned = 4, recent = 18, playerCount = 1 })` keeps only **`pinned` opening messages + a `recent` tail**. With `RECENT_PER_EXTRA_PLAYER = 8` and `RECENT_CAP = 42`, the window is: N=1→**22 msgs** (4+18), N=2→30, N=3→38, N=4/5→**46 msgs** (4+42).
- Old anchors scroll out of that window and are never sent — so the model literally cannot see them, regardless of `num_ctx`. (`extractEntities` digest + the `facts` block partially mitigate by re-injecting names/numbers, but the endurance run shows that is insufficient — the model still re-improvises.)

**Therefore the real fix = expand `trimContext` to send more history AND raise `num_ctx` to fit it.** Both, together.

Current hardcoded `num_ctx = 8192` lives in exactly two runtime call sites (plus the stress harness, which has its own `--num_ctx`):
- `src/components/Chat.jsx:567` (single-player `options` block; `model: campaign.model || 'qwen2.5:14b'` at :560).
- `server/sync-server.mjs:1038` (multiplayer DM proxy `options` block; `model` resolved via `MODEL_RE` allowlist at :1022).
- Full `options` set at both sites: `num_ctx: 8192, num_predict: 900, temperature: 0.8, top_p: 0.9, top_k: 40, repeat_penalty: 1.15, repeat_last_n: 256`.

`numCtxForModel()` does **not** exist on `master` (it lives only on the parked `impish-qwen-swap` branch, commit `1df07fd`, in `src/lib/session.js` — port/adapt from there).

## 4. Decisions already made

1. **Full fix, including single-player.** The wider window applies to N=1 too (long solo campaigns suffer the same collapse).
2. **Break the single-player byte-identical invariant — intentionally.** The current code + CLAUDE.md treat N=1 `trimContext` as sacred (`context.js:393–395`; root + `dnd-claude/CLAUDE.md`). This plan **changes N=1 behavior**, so:
   - Rewrite the `context.js` invariant comments (`~360–395`).
   - Update the CLAUDE.md "single-player byte-identical invariant" language (root `CLAUDE.md` and `dnd-claude/CLAUDE.md`) to reflect the new, deliberate behavior.
   - Update/remove the tests that assert N=1 identity (`src/lib/context.test.js:75–92`).
3. **Per-model `num_ctx`** (VRAM-aware on the RTX 4090 / 24 GB): `qwen2.5:14b → 32768`, `impish-qwen:14b → 32768` (when present), `qwen2.5:32b → 8192`. 14B @ 32768 is already validated to fit 100% on GPU (the impish swap confirmed `ollama ps` CONTEXT 32768, 100% GPU).
4. **Land via gated PR** (per policy + push-guard hook). Findings/validation are part of the PR or an immediate follow-up.

## 5. Implementation

### Part A — per-model `num_ctx`

1. **`src/lib/session.js`** — add and export:
   ```js
   // Per-model Ollama context window. 14B models fit 32768 on a 24GB GPU;
   // qwen2.5:32b is held at 8192 to stay within VRAM.
   export function numCtxForModel(model) {
     if (model === 'qwen2.5:32b') return 8192
     return 32768 // qwen2.5:14b, impish-qwen:14b, and default
   }
   ```
   (Cross-check the exact table on `impish-qwen-swap` @ `1df07fd` and reconcile — keep one source of truth.)
2. **`src/components/Chat.jsx:567`** — replace `num_ctx: 8192` with `num_ctx: numCtxForModel(campaign.model)` (import from `session.js`; `campaign.model` is already in scope at :560).
3. **`server/sync-server.mjs:1038`** — replace `num_ctx: 8192` with `num_ctx: numCtxForModel(model)` (the validated `model` is in scope at :1022–1024; import `numCtxForModel`).

### Part B — `trimContext` rework (the part that actually fixes continuity)

Goal: send substantially more history when the budget allows, for **all** player counts.

**Recommended approach — token-budget-aware trim (cleanest):** replace the fixed message-count window with a budget-driven one. Compute an input-token budget from `num_ctx` and fill the tail until the budget is hit, always keeping `pinned` openers.
- Budget framework (per request): usable input ≈ `num_ctx − num_predict(900) − systemPromptTokens − digestTokens − safetyMargin`. At `num_ctx=32768`: ≈ `32768 − 900 − ~2000 − ~400 ≈ ~29,500` input tokens for history.
- Token estimate: ~`3.3 bytes/token` for English prose; observed mean ~`877 B/msg` (inflated by long DM turns; modal turn ~250–400 B). Conservatively ~`265 tokens/msg` ⇒ **~100–110 messages** of recent tail at 32768 (vs 18–46 today).
- `trimContext(messages, { pinned, model | numCtx, playerCount })` would size the tail to the budget. Keep `pinned` (consider raising to 6–8 to pin premise + quest-giver + first anchors).

**Simpler fallback — scale the existing counts:** keep the count-based design but raise base `recent` and `RECENT_CAP` ~3–4× for the 32768 budget (e.g. `recent` base ~72, `RECENT_CAP` ~150), and apply to N=1 too. Less principled; still effective.

Either way:
- Apply to **single-player** (N=1) — this is the invariant break.
- Thread `model`/`numCtx` into the two call sites: `Chat.jsx:511` and `sync-server.mjs:984` (multiplayer already computes `playerCount` at :983). `context.starwars.js:12` re-exports `trimContext` from `context.js`, so the change is centralized in one function.
- Update the `stress-test/harness.mjs:407` call (single harness) if the signature changes; the 4-player harness drives `sync-server.mjs` so it picks up :984 automatically.

**Latency trade-off (must flag/measure):** the current design prizes "flat-compute" (~1.0–1.2s prompt-eval). A ~100-msg / ~30K-token prompt raises prompt-eval to ~4–5s/turn. This is the cost of continuity; confirm it's acceptable in §7 and consider a soft cap.

### Part C — CJK comment cleanup (trivial)

- `src/lib/context.js:222` — the comment `// 5. Reject tokens with no Latin letters at all (stray CJK like "钩子"),` embeds a literal CJK example. Reword to drop the literal characters (e.g. "...stray non-Latin / CJK tokens..."). The *filter itself* (`!/[A-Za-z]/.test(t)` at :224) is correct — keep it.
- Run a full scan to confirm no other CJK in the prompt path: `rg -n "[\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Hangul}]" src server`. (As of `d83fb0c` the only hit is `context.js:222`.)

## 6. Tests to update / add (`npm test -- --run` must end green)

- **`src/lib/context.test.js`** — the `trimContext` suites (`:6–153`) encode the old window:
  - `:12` "22 messages returned as-is" (4+18) → new threshold.
  - playerCount scaling (`:69–142`): the N→recent table (18/26/34/42-cap) and `RECENT_CAP=42` assertions → new values/curve.
  - **single-player identity tests (`:75–92`)** — these assert N=1 == old behavior; rewrite to the NEW intended N=1 window (the invariant is intentionally broken).
  - starwars re-export parity (`:144–153`) should still hold (same function reference) — keep.
- **`server/sync-server.multiplayer.test.mjs:622`** — asserts `num_ctx: 8192`; update to the per-model value (`numCtxForModel('qwen2.5:14b')` etc.).
- **`src/lib/session.test.js`** — add unit tests for `numCtxForModel` (14B→32768, 32b→8192, default).
- Add a `trimContext` budget test (given a `num_ctx`/model, the tail respects the budget and always keeps `pinned`).

## 7. Validation (acceptance criteria)

The ONLY way to confirm continuity improved is to re-run the harness at the new settings and compare to the 8192 baseline (`R_continuity`: qwen 40, impish 12).

1. **Re-run the 4-player endurance** for `qwen2.5:14b` (and ideally `impish-qwen:14b`) at the new `num_ctx`/window:
   `node stress-test/harness-4p.mjs --mode=full --rounds=200 --model=qwen2.5:14b --run_id=4p_qwen25_ctx32k --manage-server`
   - **Accept if** `R_continuity` is materially higher than 40 (target: no `B_COLLAPSE` well past round 40, ideally toward the rounds cap). Compare category-B accuracy.
2. **Single-player continuity check** (since solo was expanded): a focused long-session run or the single harness (`stress-test/harness.mjs`) with the new `num_ctx`.
3. **Performance/VRAM:** record tok/s + prompt-eval wall time (expect slower per §5B — confirm acceptable); confirm `ollama ps` stays 100% GPU at 32768 for the 14B model.
4. **Unit tests** green; **CJK scan** clean.
5. Write results into `stress-test/4P-DUAL-MODEL-FINDINGS.md` (or a sibling `…-CTX32K.md`).

## 8. Gated workflow & agent routing

Flow (per `feedback-gate-all-via-pr` + push-guard hook): branch (e.g. `feat/context-window-continuity`) → implement → `npm test -- --run` green (GATE 1) → `gh pr create --base master` → `code-reviewer` (GATE 2) → live check if any UI surface changed (minimal here) → endurance validation (§7) → `gh pr merge --merge`. **Never `git push origin master`.**

Suggested agents (route via the orchestration layer per root CLAUDE.md):
- **`llm-architect`** — design Part B (token-budget trim + window sizing + latency trade-off).
- **`react-specialist`** (or `backend-developer` for the server side) — wire Part A + the `trimContext` call sites.
- **`test-automator`** — rework `context.test.js` + `sync-server.multiplayer.test.mjs` + add `numCtxForModel`/budget tests.
- **`qa-expert` + `error-detective`** — analyze the §7 endurance re-run into findings.
- **`git-workflow-manager`** — branch/commit/push/PR/merge (the only agent that commits).

## 9. Risks, trade-offs, interactions

- **Latency:** larger prompts ⇒ slower prompt-eval (loses the flat-compute property). Measure; consider a soft cap so worst case stays tolerable.
- **VRAM:** 14B @ 32768 validated to fit 24 GB; **do not** raise `qwen2.5:32b` past 8192 (it would overflow). The bigger KV cache at 32768 uses more VRAM than 8192 — confirm headroom with `ollama ps`.
- **Parked impish PR #6 conflict:** `impish-qwen-swap` (`1df07fd`) already adds `numCtxForModel` to `session.js`. Landing Part A on `master` will conflict with PR #6 — flag that PR #6 needs a rebase afterward (or fold its `numCtxForModel` in and simplify #6). This work also *enables* the findings' "re-test impish at native context" caveat.
- **Continuity may still need the digest:** even with a big window, very long campaigns eventually scroll anchors out. Keep `extractEntities`/`facts` as belt-and-suspenders; consider raising `extractEntities` `max` (currently 50).

## 10. Reference index

- Findings: `stress-test/4P-DUAL-MODEL-FINDINGS.md` (master `d83fb0c`).
- Trim/prompt logic: `src/lib/context.js` (`buildSystemPrompt`, `extractEntities`, `trimContext`); `src/lib/context.starwars.js` (re-exports `trimContext`).
- Call sites: `src/components/Chat.jsx:511` (trim), `:560–575` (options); `server/sync-server.mjs:983–984` (trim), `:1022–1047` (options).
- `numCtxForModel` source to port: `impish-qwen-swap` branch, commit `1df07fd`, `src/lib/session.js`.
- Tests: `src/lib/context.test.js`, `server/sync-server.multiplayer.test.mjs:622`, `src/lib/session.test.js`.
- Harness: `stress-test/harness-4p.mjs` (4-player, drives sync-server), `stress-test/harness.mjs` (single).
- Policy: memory `feedback-gate-all-via-pr`; hook `H:\Claude\.claude\hooks\block-default-push.sh`.
