# 4-Player Dual-Model Endurance Findings — `qwen2.5:14b` vs `impish-qwen:14b`

**Date:** 2026-05-27
**Harness:** `stress-test/harness-4p.mjs` (follow-the-spotlight, 4 WS clients → `server/sync-server.mjs` → local Ollama; continuity-recall probe every 4 rounds)
**Runs:** `--mode=full --rounds=200` per model; both at **`num_ctx=8192`** (server-hardcoded).
**Analysis:** `qa-expert` (continuity + hallucination), `error-detective` (drift onset + leak verification), `debugger` (B_COLLAPSE root-cause).

---

## TL;DR

- **CJK / non-Latin leakage — the headline watch — did NOT materialize on either model. 0 leaks** (qwen 0/174 turns, impish 0/62 turns), verified three independent ways. *Caveat:* impish only ran 62 turns before collapsing, so its clean result is a true negative on a short run, not a clearance for full-length play.
- **`qwen2.5:14b` sustains usable continuity ~3.3× longer than `impish-qwen:14b`** at the same context window (R_continuity **40 vs 12**). Both stopped on the same graceful content-quality gate (`B_COLLAPSE`), not on any crash.
- **Failure styles differ in kind, not just degree.** qwen degrades by *graceful partial fade* (sheds low-salience names, keeps the anchor town + villain faction to round 40). impish degrades by *wholesale confabulation* — it renames the starting town (Ravenmoor → "Thornfield") and core NPCs by round 12, then stays **confidently self-consistent on the wrong facts**.
- **No infrastructure failures on either run:** zero timeouts, server errors, dropped turns, party-shrink, or CPU offload. Telemetry complete.
- **Recommendation (unchanged):** keep **`qwen2.5:14b`** as the default for long / format-critical sessions. **`impish-qwen:14b` is SAFE-WITH-CAVEATS** for short / casual RP (reliable to ~round 8). Re-test impish at its *native* large context before any reconsideration for longer play.

---

## Comparison Table

| Metric | `qwen2.5:14b` | `impish-qwen:14b` |
|---|---|---|
| Turns survived | **174** (44 rounds) | 62 (16 rounds) |
| Wall time | 1648 s | 354 s |
| Stop reason | `B_COLLAPSE` | `B_COLLAPSE` |
| **R_continuity** (usable rounds) | **40** | 12 |
| Drift onset | probe P4 / **round 16** (~123 KB ctx) | probe P2 / **round 8** (~62 KB ctx) |
| Category **A** (origin anchor) | **1.00** (11/11) | 0.50 (2/4) |
| Category **B** (deep-recall anchors) | **0.455** (20/44) | 0.3125 (5/16) |
| Category **C** (recency control) | 0.909 (10/11) | 1.00 (4/4) |
| **CJK / non-Latin leaks** | **0 / 174** | **0 / 62** |
| Hard failure (crash/timeout) | none (`R_hardfail=null`) | none (`R_hardfail=null`) |
| Mean throughput | 80.1 tok/s | 79.5 tok/s |
| CPU offload | no | no |

Throughput is effectively identical (~80 tok/s); impish's only measured "win" — finishing faster — is just a consequence of collapsing sooner.

---

## 1. CJK / Non-Latin Leakage — **0 leaks, and the result is trustworthy**

This was the a-priori concern for the impish RP finetune (the codebase even carries stray CJK like "钩子" in `context.js`). It did not appear. Verified three ways:

1. **Detector ran on every turn.** Every per-turn JSONL line carries a `cjk_leak` field (174/174 qwen, 62/62 impish; none missing). The scan runs on the full DM text, not the 200-char snippet.
2. **Detector demonstrably fires.** The harness self-test ("钩子" → 2 CJK chars) passes as smoke Gate 10; an independent re-run of the regexes correctly flags CJK, Kana, Hangul, and Cyrillic.
3. **Independent full-corpus rescan.** A stricter independent rule (any codepoint > U+024F minus an English-typography whitelist) found **0 non-Latin codepoints across 453,327 chars (qwen) and 97,532 chars (impish)**.

**Caveat (exposure asymmetry):** impish received only ~21% of qwen's text exposure (62 vs 174 turns) and never ran deep into the high-context regime where a finetune is likeliest to slip script. *"impish: 0 leaks" is a true negative on a short run* — it does not clear impish for a full-length session.

---

## 2. Continuity & Drift Onset

**What the probe categories test** (from `buildBeatQueue` / `scoreAnchors`): every 4th round an out-of-character "recap" probe asks the DM to restate fixed anchors, scored by case-insensitive substring match:

- **A — origin anchor:** `Ravenmoor` (starting town, introduced round 1). The oldest, most-reinforced fact.
- **B — deep-recall anchors:** `Garret` (blacksmith), `Forge of Embers`, `12 gold` (paid to Mira), `Ash Covenant` (rival faction) — introduced rounds 2–3, never restated. **This is the core long-term-memory metric** that drives `R_continuity`.
- **C — recency control:** a landmark introduced one turn before the probe. Confirms the context window is functioning.

**Drift onset comparison** (first probe a persistent B-anchor flips to FAIL):

| Probe (round) | qwen B-pass | impish B-pass |
|---|---|---|
| P1 (R4) | 4/4 | 4/4 |
| P2 (R8) | 4/4 | **1/4 ← impish onset** |
| P3 (R12) | 4/4 | 0/4 (A also lost) |
| P4 (R16) | **1/4 ← qwen onset** | 0/4 → STOP |
| P5–P10 (R20–40) | 1/4 (stable plateau) | — |
| P11 (R44) | 1/4 + C lost → STOP | — |

**The cleanest co-variate of drift is accumulated context size, not throughput.** tok/s is flat (~78–80) across both runs and does not move with drift. qwen drifts at ~123 KB of persisted context, impish at ~62 KB — impish's effective continuity horizon at `num_ctx=8192` is roughly *half* qwen's. qwen's mean DM response also inflates from ~1.4 KB (early) to ~3.3–4.8 KB (R19–41), burning context faster and accelerating its own eventual decay; impish collapsed before any such verbosity ramp.

---

## 3. Hallucination Assessment (from full DM prose)

Both models fabricate under 8192-token pressure, but the rate, severity, and **style** differ sharply.

### `impish-qwen:14b` — fast, wholesale canon replacement
Impish doesn't fade into vagueness; it **substitutes a freshly invented canon** and then locks onto it:
- **R8 (P2):** shop → "Black Hammer Forge"; fee → "20 gold"; faction → "Order of Eldritch Shadows".
- **R12 (P3) — full collapse incl. the origin anchor:** town flips to "**Thornfield**"; blacksmith renamed "**Garrick Ironhand**"; Mira becomes "Mira Shadowwhisper … 50 gold".
- **R16 (P4):** the fabrications are now verbatim-stable — impish recalls its *invented* history faithfully.

Corpus scan confirms severity: across 62 turns impish says "Ravenmoor" only ~30× and invents "Thornfield" 4×. Its narrative turns also show stuck-loop boilerplate (R9/R11 repeat near-identical "Weeping Idol" prose) — recycling recent output rather than advancing state.

### `qwen2.5:14b` — graceful, salience-prioritized fade
- **P1–P3 (R4–12):** all anchors correct, every probe.
- **R16 (P4) — onset, selective:** mid-tier names mutate ("Thorn Blackforge", "50 gold") but **`Ravenmoor` and `Ash Covenant` hold**.
- **R20–R40:** a stable 3/6 plateau — same survivors (origin town + villain faction + rolling recency anchor), same casualties, for six straight probes.
- **R44 (P11):** faction finally displaced; even so it still anchors on `Ravenmoor`. By this point qwen has begun emitting an emergent self-summarization ledger ("Actions Taken So Far") — a grounding strategy impish never attempts.

Corpus scan: qwen says "Ravenmoor" **198×** across 174 turns and **never once** says "Thornfield".

**Most dangerous impish trait:** it doesn't merely forget — it *re-canonizes the world and stays internally consistent with the fabrication*, which is harder for a DM/player to catch than qwen's pattern of shedding peripheral names while the anchor town stays put.

> Note on impish's perfect **C=1.00**: this is not a strength. C tests one-turn-old facts, so it only proves the context window works. It sharpens the diagnosis — impish's *short-term* recall is intact; it is *long-range anchor retention* that fails.

---

## 4. Root-Cause: what `B_COLLAPSE` is and why impish collapses ~3× sooner

**Definition** (`harness-4p.mjs`): after each probe the harness computes cumulative Category-B accuracy over the whole run. `B_COLLAPSE` fires when that stays **below 0.50 for two consecutive probes** (a hysteresis gate — one bad probe is recoverable). `R_continuity` is recorded as the round of the *first* of those two sub-50% probes. Because B is cumulative, collapse is effectively terminal — the intended semantics of an endurance ceiling. It is a **pure content-quality stop**, independent of storage (`R_localstorage`) and heap (`R_server`) extrapolations.

**Mechanism of the gap (same `num_ctx=8192` for both):**
- impish fails by **confabulation/re-invention** — it fills scrolled-out facts with plausible fiction (the RP-finetune objective: fluent, atmospheric continuation over factual pinning).
- qwen fails by **lossy compression that prioritizes salience** — it preserves the high-salience anchors (town, named faction) and sheds only the fiddly ones (a shop label, a number).

**This is intrinsic to the impish finetune, not context-window-bound.** Decisive evidence: at the *identical* 8192-token window, qwen lasts to round 40 and impish breaks at round 12. If the window were the binding constraint, both would fail at a similar round. Two corroborating signals: (a) impish emits *confident, specific, wrong* substitutes rather than abstaining (a generation-objective property, not a token-count one), and (b) impish's short-horizon recall is perfect (C=4/4) — it is not broadly memory-impaired, it specifically fails to *prioritize and retain* older anchors.

---

## 5. Infrastructure — clean on both runs

- `R_hardfail=null`, `limiting_factor=R_continuity` for both. The only stop was the content-quality gate.
- **Zero event flags** across all 236 turns — no `OLLAMA_TIMEOUT`, `SERVER_ERROR`, `DM_BUSY`/`RATE_LIMITED`, `NOT_YOUR_TURN`, `PARTY_SHRINK`, or `CJK_LEAK`. No dropped/retried turns.
- Max DM wall time 6.9 s (impish) / 15.1 s (qwen) — far under the 90 s server and 120 s client timeouts. No CPU offload; GPU-resident throughout.
- Spotlight fairness OK (all 4 players rotated; max starvation gap 9–11 turns). `party_shrink_events: []` — the structured `party` block never lost a roster member; the "Thornfield/Garrick" drift is *content* confabulation inside intact party blocks, not structural shrink.
- Memory ceilings never approached: extrapolated `R_localstorage` (qwen 413 / impish 643 rounds) and `R_server` (qwen 7954 / impish 3276) are an order of magnitude beyond where continuity broke.

This was a **model-quality collapse, gracefully detected** — exactly the harness's intended soft stop — not an infrastructure failure.

---

## 6. The `num_ctx=8192` caveat

Both models ran at the app/server-hardcoded `num_ctx=8192`, so **impish's 1M-context capability was not exercised.** A larger window keeps the round 2–3 anchors physically present longer and would *likely push impish's collapse round out in absolute terms*. But:
- The comparison conclusion is unaffected — at equal context, qwen2.5 is materially the stronger endurance DM for this app's continuity contract.
- impish's weakness is a *retention-discipline* deficit (re-improvising scrolled-out anchors) that a bigger window mitigates rather than cures — a long campaign always eventually scrolls anchors out.

**If impish is reconsidered for longer play, re-run this harness with `num_ctx` raised** (requires lifting the server hardcode in `server/sync-server.mjs` + `Chat.jsx`, or wiring the per-model `numCtxForModel()` from the `impish-qwen-swap` branch). Until that test exists, the 8192-ctx result stands.

---

## 7. Recommendation

| Use case | Model | Notes |
|---|---|---|
| **Long / format-critical** campaigns (stable NPCs/locations/quest state; relies on `party`/`check`/`verdict` blocks) | **`qwen2.5:14b`** (default) | Holds the origin anchor for the full 174-turn run; ~3.3× more usable rounds; coherent narration even as peripheral names drift. Treat **~R16 as a soft "refresh" point** and **~R40 as the hard continuity ceiling** at 8192 ctx — beyond R40, re-seed/reload context. |
| **Short / casual RP** (one-shots, vibe scenes ≤ ~R8) | **`impish-qwen:14b`** — SAFE-WITH-CAVEATS | Clean of CJK leaks, never crashes, full speed. Trustworthy only through **~R8**; fully collapses by **~R12** and will *confidently rename your world* past that. Must not be used where downstream state (party blocks, persisted `.md` continuity) depends on the DM remembering established facts. |

This confirms the existing project stance: **`qwen2.5:14b` stays the default; impish is the low-censorship / RP-flavor option for short play.**

---

## Methodology & Reproduction

```
# qwen baseline
node stress-test/harness-4p.mjs --mode=full --rounds=200 --model=qwen2.5:14b  --run_id=4p_qwen25 --manage-server
# impish
node stress-test/harness-4p.mjs --mode=full --rounds=200 --model=impish-qwen:14b --run_id=4p_impish --manage-server
```

Artifacts per run: `stress-test-4p-<run_id>.jsonl` (per-turn records + `cjk_leak`), `fulltext-4p-<run_id>.jsonl` (full DM prose per turn — hallucination evidence; not committed due to size, regenerable), `stress-test-summary-4p-<run_id>.json` (aggregate metrics). Both summaries + per-turn JSONLs for these two runs are committed alongside this report.
