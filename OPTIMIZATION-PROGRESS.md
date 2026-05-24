# Local LLM Optimization — Progress & Handoff

Last updated: 2026-05-24. App: D&D Campaign Assistant (`H:\Claude\dnd-claude\`), React + Vite, runs `qwen2.5:14b` via local Ollama at `localhost:11434`. Hardware target: RTX 3070 8GB VRAM, 16GB RAM.

## Goal of this work
Optimize the local LLM for two problems the user reported: **long-session drift** (model forgets early NPCs/decisions) and **response quality**.

## Current live config (authoritative snapshot — read this first)
This is the current state of the deployed code. The sections below are the chronological narrative of how it got here; where an older section quotes a different number, THIS snapshot wins.

- **Endpoint:** native `/api/chat` (NDJSON streaming), host `${window.location.hostname}:11434`. Model `qwen2.5:14b`.
- **Sampling (`Chat.jsx` `sendMessage` `options`):** `num_ctx: 8192`, `num_predict: 900`, `temperature: 0.8`, `top_p: 0.9`, `top_k: 40`, `repeat_penalty: 1.15`, `repeat_last_n: 256`.
- **Context functions live in `src/lib/context.js`** (shared by the app AND the stress harness — single source of truth, no copies):
  - `buildSystemPrompt(campaign)` — DM system prompt incl. CONTINUITY block, check-then-wait rule, "bold every NPC/location name" rule.
  - `extractEntities(messages, max=50)` — captures `**bold**` + double-quoted proper-noun spans, filters noise via `looksLikeEntity`, retains by **mention-frequency (tie-break earliest-seen)**, returns digest in first-seen order.
  - `trimContext(messages, {pinned=4, recent=18})` — pins first 2 exchanges + recent tail.
- **Digest injection:** appended to the END of the system message as "Established entities so far: …" (cache-friendly static prefix).
- **Dice:** `{role:'dice',die,result}` → `{role:'user', content:'[Dice roll: dX → N]'}` at send time.
- **Build:** `npm run build` passes (verified 2026-05-24).
- **Unrelated in-flight app work (not part of this optimization, but now in `Chat.jsx`):** `HistoryPanel` + `CharacterPanel` components, `character`/`setCharacter` props, `sessionLog`, and an `entities` state that surfaces the digest in the UI. Mentioned only so a resumer isn't surprised by these imports.

## Root cause found
The app was calling Ollama's OpenAI-compatible endpoint `/v1/chat/completions`, which **silently drops** all Ollama-native params (`num_ctx`, `top_k`, `repeat_penalty`, etc.). So `num_ctx` never applied and context defaulted to ~2048 tokens — the real cause of drift. Confirmed: after migrating to `/api/chat`, `ollama ps` reports `context_length: 4096`.

## Changes implemented (all in `src/components/Chat.jsx` unless noted)

All of the following are DONE and live:

1. **Endpoint migration** `/v1/chat/completions` → native `/api/chat`.
   - Tuning params moved into an `options: {}` block.
   - `max_tokens` → `num_predict`.
   - Stream parser rewritten: reads **newline-delimited JSON** (`event.message.content`, `event.done`), NOT SSE `data:` lines. Includes a cross-chunk `buffer` so a JSON object split across reads isn't dropped.
2. **Sampling retuned** (in `options`): `num_ctx: 4096` *(later raised to 8192 — see snapshot/stress-test)*, `num_predict: 900`, `temperature: 0.8`, `top_p: 0.9`, `top_k: 40`, `repeat_penalty: 1.15`, `repeat_last_n: 256`.
   - Removed `frequency_penalty`/`presence_penalty` — OpenAI-only (no-ops on `/api/chat`) AND `frequency_penalty: 0.5` was suppressing recurring NPC/place names, hurting continuity. `repeat_penalty` is the correct tool.
3. **System prompt hardening** (`buildSystemPrompt`): added CONTINUITY block, "never invent player stats — ask instead", "state the check/DC and wait for the player's roll before narrating the outcome", and one-line scene grounding after transitions.
4. **Dice fix**: dice messages `{role:'dice',die,result}` used to be filtered OUT before the API call, so the DM never saw rolls. Now transformed at send time into `{role:'user', content:'[Dice roll: dX → N]'}` in chronological position.
5. **Context management** (replaced naive last-20 window) — *these functions were later moved to `src/lib/context.js` and reworked; see snapshot + stress-test section for current behavior:*
   - `extractEntities(messages, max=40)` — *originally* regexed unique `**bold**` names from assistant messages, appended as an "Established entities so far: …" digest. *(Now max=50, also captures quoted names, filters noise, retains by frequency.)*
   - `trimContext(messages, {pinned=2, recent=18})` — pins opening messages + recent tail. *(Now pinned=4.)*

`Modelfile` was created then deleted — redundant once `num_ctx` is set per-request on `/api/chat`. Default model stays `qwen2.5:14b`.

## Verification status
- ✅ **App loads/renders** in the real browser (confirmed via screenshot — full empty-state UI, starter prompts, input).
- ✅ **Streaming contract** confirmed via curl: `/api/chat` returns newline-JSON matching the new parser; `num_ctx: 4096` applied per `ollama ps`.
- ✅ **Live multi-turn session verified (2026-05-24)** via the `claude-in-chrome` MCP bridge (the localhost blocker below is now resolved). Played a ~22-message session (qwen2.5:14b):
  - **Continuity:** named party (Kael, Mirae) + NPCs (innkeeper Sven, shepherd Tomas) and locations (Ravensford, Gilded Stag) reused consistently across all turns with zero drift.
  - **Pinned-opener recall:** after 20+ messages, asked the DM out-of-character to name the first innkeeper / tavern / town → answered **Sven / Gilded Stag / Ravensford** exactly. "Sven" was never bolded, so it survived via the *pinned opener*, not the digest.
  - **Dice reaches the model:** rolled D20 → 17 for a Perception check; DM narrated a clear *success* (spotted fresh large-creature tracks) rather than a generic reply, confirming the `{role:'dice'}` → `[Dice roll: …]` transform lands in the API call.
  - **Check-then-wait prompt hardening:** DM correctly called for a "Wisdom (Perception) check," stated it would set the DC, and **waited for the player's roll** before narrating the outcome.

### Finding + FIX: entity digest now captures NPC names, not just locations
The model (qwen2.5:14b) reliably **bolds place names** (`**Ravensford**`, `**Gilded Stag**`) but almost always renders **NPC names in quotes, not bold** (`"Sven"`, `"Tomas"`). Bold-only extraction therefore missed most NPCs.

**Hardened 2026-05-24 (both sides, in `Chat.jsx`):**
1. `extractEntities` now also scans **double-quoted spans** and keeps them only if they look like a proper name (1–3 words, every word capitalized, no mid-string sentence punctuation, ≤40 chars). This rejects dialogue like `"Please help!"` / `"Well, now,"` while capturing `"Sven"`, `"Mirae"`, `"Tomas"`. Single-quote/apostrophe delimiters are intentionally excluded to avoid `it's`-style noise.
2. System-prompt formatting rule strengthened to demand bolding every NPC name on first introduction ("write the innkeeper **Sven**, not "Sven"").

**Verification:** unit-tested the regex against real session narration → `["Gilded Stag","Ravensford","Sven","Mirae","Tomas"]` (locations + NPCs in, all dialogue rejected). Confirmed live via a temporary `console.log` of the injected digest — NPC names now appear in the "Established entities so far" line sent to Ollama. Note: the prompt nudge (#2) alone did **not** change the model's quoting habit in testing, so the extraction fix (#1) is the load-bearing change.

**Known minor caveat (NOW FIXED — see stress-test section below):** bold extraction originally had no capitalization filter, so the DM bolding label-like phrases (`**Name of the Tavern:**`, option lists, mechanics terms) leaked noise into the digest. The 60-turn stress test proved this was *not* minor — it evicted real anchors at the 40-cap. Fixed via the de-noise + frequency-retention rework described below.

### 60-turn stress test + context-management rework (2026-05-24)
Built an automated harness (`stress-test/harness.mjs`, spec in `stress-test/PROTOCOL.md`) that replays a scripted 60-turn campaign against Ollama using the app's real request construction, with recall probes scored by substring match. Anchors are categorized: **A**=early facts, **B**=digest-only facts (scrolled out of pinned+recent window — the real test of the digest), **C**=recent facts. Player turns pin canonical names so ground truth is deterministic (without this every probe falsely failed — the model invents its own names otherwise).

**num_ctx 4096 vs 8192 result:** B-recall 0.375 → 0.625, throughput 73.5 → 72.6 tok/s (−1.3%), **no CPU offload at 8192** (KV cache still fit on GPU). → adopted **8192** (`num_ctx: 8192` in `Chat.jsx`). At prod `num_predict: 900` the recent window overflows 4096 even harder, so the win is likely larger in real use.

**Three fixes applied (all in the new shared module `src/lib/context.js`):**
1. **`num_ctx` 4096 → 8192.**
2. **Pin depth `pinned` 2 → 4** in `trimContext` — pins the first *two* exchanges, so the Turn-2 quest premise/giver survives. (Proven: `Sorcha` went FAIL→PASS in both validation runs; category A 0.75 → 1.0.)
3. **`extractEntities` de-noise + reprioritize** — added `looksLikeEntity` (rejects labels, mechanics/stat-block terms, imperative option-lists, prose phrases, pronoun filler), and replaced `slice(-max)` (keep *last* 40) with **mention-frequency ranking tie-broken by earliest-seen** (cap 50). A recurring NPC introduced early can no longer be evicted by a late one-off. (Proven: `Mira` went FAIL→PASS; 0/47 junk phrases survive, 24/24 real anchors survive.)

**Architecture:** the three pure functions (`buildSystemPrompt`/`extractEntities`/`trimContext`) were extracted from `Chat.jsx` into `src/lib/context.js`, imported by both the app and the harness — so the harness now tests the *real* app code and the two copies can't drift. `npm run build` passes. As a side benefit, the de-noised entities feed the app's HistoryPanel.

**Honest caveats on the aggregate B number:** the fixed run's aggregate B (0.5) didn't beat the unfixed 8192 baseline (0.625) because (a) one anchor — a *price* (`12 gold`) — is structurally uncapturable (never bolded/quoted, so it can't enter a name-based digest), and (b) runs are unseeded (forbidden by the protocol), so B swings on whether the model bolds the scripted names at introduction time. The *per-anchor* fixes (Sorcha via pin, Mira via retention, junk removal) are consistent across runs — that's the clean signal. Zero contradictions in any run: the model fails by silent omission, never by confabulating wrong facts.

### Browser-verification blocker — RESOLVED (kept for history)
Previously could not drive the app via the `claude-in-chrome` MCP bridge (MCP `navigate` to `localhost` returned `permission_required: localhost`; bridge ran in its own tab group and couldn't see the user's localhost tab). As of 2026-05-24 the MCP tab group can reach `localhost:5173` directly and `tabs_context_mcp` lists the running app tab — the live test above was driven this way.

## Remaining / optional ideas (from llm-architect review, NOT implemented)
- `OLLAMA_KV_CACHE_TYPE=q8_0` server env var — ~halves KV cache memory, lets you raise `num_ctx` without more CPU offload. Server-side config change.
- ~~Bump `num_ctx` to 8192~~ **DONE** (8192, no offload observed, −1.3% tok/s — see stress-test section). 12288 untested; would test next if longer sessions still drift.
- `mirostat: 2` (tau ~5.0) — dynamic perplexity control for long creative output; overrides top_p/top_k. Experiment only.
- Relabel the `qwen2.5:32b` option in `ApiKeySetup.jsx` to set speed expectations on 8GB VRAM, or offer a fast `qwen2.5:7b`.

## RL / feedback ideas (from reinforcement-learning-engineer review — mostly NOT worth it)
- DPO/LoRA fine-tuning: NO — needs 500–5000 preference pairs (months of play) and can't train on 8GB VRAM (needs 24GB+ cloud GPU).
- Contextual bandit over sampling presets: NO — signal-to-noise too low at single-user volume.
- Best-of-N sampling: NO — 100–180s blocking latency kills the streaming UX.
- ONLY realistic option: thumbs up/down → `localStorage` log → inject a dynamic style note into the system prompt when recent ratings dip (~30-50 lines, no infra). Not implemented.

---

## ▶ Resume here — to continue later

**Where everything is:**
| Path | What |
|------|------|
| `src/lib/context.js` | The three context functions (system prompt, `extractEntities`, `trimContext`). Single source of truth. |
| `src/components/Chat.jsx` | App chat: imports `context.js`; `sendMessage` holds the `/api/chat` options (`num_ctx: 8192`). |
| `stress-test/PROTOCOL.md` | The test spec (60-turn script, anchor roster A/B/C, scoring, num_ctx protocol). |
| `stress-test/harness.mjs` | The harness. Imports `../src/lib/context.js` so it tests real app code. |
| `stress-test/run-full-comparison.mjs` | Orchestrates Run A (4096) → gap → Run B (8192) → comparison. |
| `stress-test/stress-test-summary-*.json` + `*.jsonl` | Per-run results + per-turn logs (incl. `entity_digest_string`). |

**How to re-run the stress test** (needs Ollama up with `qwen2.5:14b`; ~4-5 min per full run):
```bash
cd H:\Claude\dnd-claude\stress-test
node harness.mjs --mode=smoke                                   # 15-turn validation (~70s)
node harness.mjs --mode=full --num_ctx=8192 --run_id=myrun      # one full 60-turn run
node run-full-comparison.mjs                                    # both ctx sizes + comparison table
```
Scoring categories: **A**=early facts, **B**=digest-only (the real continuity test), **C**=recent. Watch `category_accuracy` in the summary and `entity_digest_string` in the jsonl. NOTE: runs are unseeded (per protocol), so aggregate B has run-to-run variance — trust per-anchor PASS/FAIL trends, not single-run aggregates.

**Open follow-ups, prioritized:**
1. **Capture non-name facts (prices/quantities/numbers).** The digest is name-based, so facts like "12 gold" can never enter it and fail recall in every run. Cleanest fix: a small structured "campaign facts" store (key→value, e.g. `priceForInfo: 12 gold`) injected alongside the entity digest. Biggest remaining recall gap.
2. **Test `num_ctx: 12288`.** 8192 showed no CPU offload; 12288 may still fit and help very long sessions. Re-run the comparison with `--num_ctx=12288`. Stop if `ollama ps` shows CPU offload (tokens/sec will tank).
3. **`extractEntities` residual leak (low priority).** `Adjective + Noun` scenery (`Stone Chamber`, `Magical Barriers`) is shape-identical to real anchors (`Stone Golem`, `Weeping Arch`), so a few one-offs still slip in. Deliberately tolerated (filtering harder would drop real anchors; frequency-retention evicts these one-offs anyway). Revisit only if the HistoryPanel looks noisy in real play.
4. **Server-side `OLLAMA_KV_CACHE_TYPE=q8_0`** — halves KV cache, would make 12288+ comfortable. Server env change, not code.
5. **Model picker polish** — relabel `qwen2.5:32b` for speed expectations / offer `qwen2.5:7b` (`ApiKeySetup.jsx`).
6. **Lightweight feedback loop** — thumbs up/down → `localStorage` → dynamic style note in system prompt (see RL section).

**Verification still pending:** the reworked digest has been proven by the harness and `npm run build`, but NOT yet watched in a live browser play session at the new settings (the earlier browser verification was pre-rework). Quick confidence check: play a long session in the app and confirm the HistoryPanel entity list stays clean and early NPCs persist.
