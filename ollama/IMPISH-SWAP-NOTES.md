# Model swap evaluation — Impish_QWEN_14B-1M (continuation notes)

**Date:** 2026-05-26
**Context:** Evaluating two community RP models against the current DM model for the `dnd-claude/` app, and prepping an Ollama swap to `Impish_QWEN_14B-1M`.

---

## Current model

- **`qwen2.5:14b`** (Qwen2.5 14B Instruct) via local Ollama; `qwen2.5:32b` also offered.
- Used as the AI Dungeon/Game Master. The app depends on **structured-block output**
  (` ```party `, ` ```check `, ` ```verdict ` fenced JSON) parsed in `Chat.jsx`, with
  `docs/design/PARTY-HUD-QWEN-VALIDATION.md` validating *format compliance*.
- So model choice is judged on **prose immersion AND strict instruction/format compliance**,
  not prose alone.

## The two candidates

| | qwen2.5:14b (current) | **Impish_QWEN_14B-1M** | L3-8B-Stheno-v3.2 |
|---|---|---|---|
| Base | Qwen2.5-14B-Instruct | Qwen2.5-14B-**Instruct-1M** (RP finetune) | Llama 3 8B |
| Params | 14B | 14B (same speed/VRAM) | 8B (faster, lighter) |
| Context | 32K native (128K YaRN) | **1M** | ~8K (L3 limit) |
| Format compliance | Strong | **Strong — IFEval 78.68** | Weakest of the three |
| Censorship | Aligned (sanitizes dark themes) | **Low** | **Low** |
| Prose / RP | Dry, assistant-y | RP-tuned, playful | Excellent for size |
| Prompt format | ChatML | **ChatML (drop-in)** | Llama-3 (different) |
| Ollama install | Built-in | GGUF import | GGUF import |

## Decision

**Use Impish_QWEN_14B-1M as a direct swap.** Same family as the current model
(Qwen2.5-14B, ChatML, 14B footprint) so it keeps the high instruction-following that the
structured-block parser needs, while adding RP tuning + low censorship + huge context headroom.

**Stheno rejected for this app:** ~8K context, weaker structured-output compliance, and a
different (Llama-3) prompt format that would force re-tuning the system prompt + re-validation.
Great general RP model, wrong shape for a format-strict, long-session multiplayer DM.

---

## Work done so far

- ✅ Wrote `dnd-claude/ollama/Modelfile.impish-qwen` — ChatML template, ChatML stop tokens,
  recommended RP sampler defaults, no SYSTEM line (app supplies its own prompt).
- ✅ **Swap completed 2026-05-26** — model built, app wired, prompt-tuned, validated, live-verified.
  See "## Completed" below for the full breakdown.

## Key technical finding (don't lose this)

The app sends **explicit inference `options` on every `/api/chat` request**, and in Ollama
**request options override Modelfile `PARAMETER` directives**. Both call sites hardcode:

```
num_ctx: 8192, num_predict: 900, temperature: 0.8,
top_p: 0.9, top_k: 40, repeat_penalty: 1.15, repeat_last_n: 256
```

- `src/components/Chat.jsx:565`  (single-player path)
- `server/sync-server.mjs:1037`  (multiplayer server-side DM proxy)

**Consequence:** a plain model swap runs Impish at **8K context**, NOT 1M. The Modelfile's
`num_ctx`/samplers are ignored by the app (they only apply to direct `ollama run`).
So the realistic gain from a swap = **prose quality + reduced censorship**, not the headline
context number.

`MODEL_RE` (`sync-server.mjs:49`, `^[a-zA-Z0-9._:-]{1,64}$`) is a format check only —
`impish-qwen:14b` passes, no server edit needed.

---

## Completed (2026-05-26)

1. ✅ **Downloaded a GGUF** — real filename `Impish_QWEN_14B-Q5_K_M.gguf` (Q5_K_M, 9.79 GiB; note: no
   `-1M`, hyphen before quant). Built from `H:\Claude\models\`, then the GGUF was **deleted** to avoid
   the ~10 GB duplicate (it's copied into Ollama's `blobs\` store). To rebuild, re-download from
   `https://huggingface.co/SicariusSicariiStuff/Impish_QWEN_14B-1M_GGUF/resolve/main/Impish_QWEN_14B-Q5_K_M.gguf`.
2. ✅ **Built** `impish-qwen:14b` via `ollama create` (lives in `C:\Users\Mask277\.ollama\models`, ~10 GB).
   The in-folder `Modelfile.impish-qwen` `FROM` line was corrected to `./Impish_QWEN_14B-Q5_K_M.gguf`.
3. ✅ **Smoke test passed**, then a full compliance battery (below).
4. ✅ **Dropdown** — added `{ value: 'impish-qwen:14b', label: 'Impish QWEN 14B — RP-tuned, low-censorship' }`
   to `OLLAMA_MODELS` (`src/components/ApiKeySetup.jsx`). `MODEL_RE` already accepts it; no server edit.
5. ✅ **Per-model `num_ctx`** — added `numCtxForModel()` to `src/lib/session.js` (32768 for the 14B models,
   8192 for `qwen2.5:32b` to stay within the 4090's 24 GB). Wired into `Chat.jsx` + `sync-server.mjs`.
   (Replaces the earlier "raise num_ctx globally" idea, which would have overflowed VRAM on the 32B model.)
6. ✅ **Prompt tuning** (both genre engines, byte-identical shared text):
   - Recovered/strengthened the mandatory `party` block instruction (tail reminder).
   - Added a 5e DC-band guide — eliminated routine-check DC inflation (was 23–25; now ≤20).
   - Added a no-self-roll rule + verdict guard — **eliminated fabricated verdicts/self-rolling** (the model
     now calls for a check and stops, never invents a roll).
7. ✅ **Party-block "prefill" experiment REVERTED** — an assistant-turn prefill guaranteed block presence but
   froze HP/turn (first-match extraction read the stale prefill, discarded the model's fresh block). Since
   blocks are stripped before storage/broadcast, the prefill gave no real benefit. Party state is again
   fully model-owned; the HUD keeps last-known when the model omits the block. A regression guard test locks
   this in.
8. ✅ **Final validation** — `docs/design/PARTY-HUD-QWEN-VALIDATION.md` ("Final validation" section).
   Verdict: **SAFE-WITH-CAVEATS** — good for casual/short play; party-block natural emission ~68% (HUD holds
   last-known otherwise); verdict judgment/roll-echo 100% when emitted; DCs ≤20; zero fabricated rolls.
   `qwen2.5:14b` remains the safer default for long/format-critical sessions.
9. ✅ **Live-verified in Chrome** — dropdown selectable; selecting it served the turn from `impish-qwen:14b`
   (confirmed `ollama ps`: 100% GPU, CONTEXT 32768 — proves both the dropdown wiring and per-model num_ctx);
   response streamed and rendered (markdown/drop-cap/continuity); Party HUD populated.

Tests: `npm test -- --run` green throughout (871 passed / 2 skipped at completion).

## Files

- `dnd-claude/ollama/Modelfile.impish-qwen` — the Modelfile (built; `FROM` corrected).
- `dnd-claude/ollama/IMPISH-SWAP-NOTES.md` — this file.
- `dnd-claude/src/components/ApiKeySetup.jsx` — dropdown entry.
- `dnd-claude/src/lib/session.js` — `numCtxForModel()` helper.
- `dnd-claude/src/components/Chat.jsx`, `dnd-claude/server/sync-server.mjs` — per-model num_ctx wiring.
- `dnd-claude/src/lib/context.js`, `context.starwars.js` — prompt tuning (DC bands, no-self-roll, verdict guard).
- `dnd-claude/docs/design/PARTY-HUD-QWEN-VALIDATION.md` — final compliance results.
