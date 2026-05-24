# Local LLM Optimization — Progress & Handoff

Last updated: 2026-05-24. App: D&D Campaign Assistant (`H:\Claude\dnd-claude\`), React + Vite, runs `qwen2.5:14b` via local Ollama at `localhost:11434`. Hardware target: RTX 3070 8GB VRAM, 16GB RAM.

## Goal of this work
Optimize the local LLM for two problems the user reported: **long-session drift** (model forgets early NPCs/decisions) and **response quality**.

## Root cause found
The app was calling Ollama's OpenAI-compatible endpoint `/v1/chat/completions`, which **silently drops** all Ollama-native params (`num_ctx`, `top_k`, `repeat_penalty`, etc.). So `num_ctx` never applied and context defaulted to ~2048 tokens — the real cause of drift. Confirmed: after migrating to `/api/chat`, `ollama ps` reports `context_length: 4096`.

## Changes implemented (all in `src/components/Chat.jsx` unless noted)

All of the following are DONE and live:

1. **Endpoint migration** `/v1/chat/completions` → native `/api/chat`.
   - Tuning params moved into an `options: {}` block.
   - `max_tokens` → `num_predict`.
   - Stream parser rewritten: reads **newline-delimited JSON** (`event.message.content`, `event.done`), NOT SSE `data:` lines. Includes a cross-chunk `buffer` so a JSON object split across reads isn't dropped.
2. **Sampling retuned** (in `options`): `num_ctx: 4096`, `num_predict: 900`, `temperature: 0.8`, `top_p: 0.9`, `top_k: 40`, `repeat_penalty: 1.15`, `repeat_last_n: 256`.
   - Removed `frequency_penalty`/`presence_penalty` — OpenAI-only (no-ops on `/api/chat`) AND `frequency_penalty: 0.5` was suppressing recurring NPC/place names, hurting continuity. `repeat_penalty` is the correct tool.
3. **System prompt hardening** (`buildSystemPrompt`): added CONTINUITY block, "never invent player stats — ask instead", "state the check/DC and wait for the player's roll before narrating the outcome", and one-line scene grounding after transitions.
4. **Dice fix**: dice messages `{role:'dice',die,result}` used to be filtered OUT before the API call, so the DM never saw rolls. Now transformed at send time into `{role:'user', content:'[Dice roll: dX → N]'}` in chronological position.
5. **Context management** (replaced naive last-20 window):
   - `extractEntities(messages, max=40)` — regexes unique `**bold**` names from assistant messages (dedupe case-insensitive, skip phrases >5 words), appended to the system message as an "Established entities so far: …" digest. Bridges names from dropped middle messages.
   - `trimContext(messages, {pinned=2, recent=18})` — pins the opening messages (campaign premise/quest hook) plus the recent tail, so early anchors survive long sessions. Digest is appended at the END of the system message to keep the static prefix cache-friendly.

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

**Known minor caveat:** bold extraction still has no capitalization filter, so if the DM bolds a label-like phrase (e.g. an out-of-character recap that bolds `**Name of the Tavern:**`), that phrase can leak into the digest as noise. Low harm (digest is just hints, capped at 40) and only seen with unusual meta-prompts, not normal play. Tighten only if it becomes a problem.

### Browser-verification blocker — RESOLVED (kept for history)
Previously could not drive the app via the `claude-in-chrome` MCP bridge (MCP `navigate` to `localhost` returned `permission_required: localhost`; bridge ran in its own tab group and couldn't see the user's localhost tab). As of 2026-05-24 the MCP tab group can reach `localhost:5173` directly and `tabs_context_mcp` lists the running app tab — the live test above was driven this way.

## Remaining / optional ideas (from llm-architect review, NOT implemented)
- `OLLAMA_KV_CACHE_TYPE=q8_0` server env var — ~halves KV cache memory, lets you raise `num_ctx` without more CPU offload. Server-side config change.
- Bump `num_ctx` to 8192/12288 if the user accepts slower tokens/sec (Q4_K_M 14B ~9GB already partially CPU-offloads on 8GB VRAM).
- `mirostat: 2` (tau ~5.0) — dynamic perplexity control for long creative output; overrides top_p/top_k. Experiment only.
- Relabel the `qwen2.5:32b` option in `ApiKeySetup.jsx` to set speed expectations on 8GB VRAM, or offer a fast `qwen2.5:7b`.

## RL / feedback ideas (from reinforcement-learning-engineer review — mostly NOT worth it)
- DPO/LoRA fine-tuning: NO — needs 500–5000 preference pairs (months of play) and can't train on 8GB VRAM (needs 24GB+ cloud GPU).
- Contextual bandit over sampling presets: NO — signal-to-noise too low at single-user volume.
- Best-of-N sampling: NO — 100–180s blocking latency kills the streaming UX.
- ONLY realistic option: thumbs up/down → `localStorage` log → inject a dynamic style note into the system prompt when recent ratings dip (~30-50 lines, no infra). Not implemented.
