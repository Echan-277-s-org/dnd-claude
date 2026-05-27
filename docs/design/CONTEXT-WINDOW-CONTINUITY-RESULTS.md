# Context-Window Continuity Fix: Results & Verdict

**Status:** SHIPPED (PR #8, merge commit 3bf8da8)  
**Date:** 2026-05-27  
**Validation:** 4-player endurance harness re-run at the new settings, plus an efficacy analysis and a root-cause writeup on the early stop.

---

## What Shipped

PR #8 merged three parts into master.

### Part A: Per-Model `num_ctx`
- **File:** `src/lib/session.js`
- **Change:** added `numCtxForModel(model)`, which returns 32768 for 14B models and 8192 for qwen2.5:32b
- **Wire sites:** `src/components/Chat.jsx:567` (single-player) and `server/sync-server.mjs:1038` (multiplayer)

### Part B: Token-Budget `trimContext` Rework
- **File:** `src/lib/context.js`
- **Change:** replaced the fixed message-count window (pinned=4, recent=18–46) with a token-budget trim
  - **New params:** pinned=8, softCap=120, dynamic reserve measured from systemContent
  - **Scope:** now applies to single-player too, which intentionally breaks the old byte-identical invariant
  - **Result:** sends ~100–120 messages instead of 18–46 when the context budget allows
- **Integration:** threaded `{numCtx, systemContent}` into the trim call; `model` resolution hoisted above the trim

### Part C: Cleanup
- **File:** `src/lib/context.js:222`
- **Change:** removed literal CJK characters from a comment; reworded to "stray non-Latin / CJK tokens"
- **Scan:** verified no other CJK in the prompt path

### Invariant Retired
- **Single-player byte-identical `trimContext` is gone.** Solo campaigns now use the wide window, matching N≥2. This was an intentional decision per the plan.
- **FACTS_CAP:** raised 12→20 to support the larger window.

### Gates & Validation
- **GATE 1 (Build):** unit suite green (894 passed, 2 skipped); clean build
- **GATE 2 (Review):** code review fixed a `willTrim` ReferenceError in the harness before merge
- **GATE 3 (Endurance):** the 4-player post-fix validation run analyzed below

---

## Before / After

| Aspect | Before (master @ d83fb0c) | After (PR #8, 3bf8da8) |
|---|---|---|
| **`num_ctx` policy** | Hardcoded 8192 | Per-model: 14B→32768, 32b→8192 |
| **`trimContext` algorithm** | Pinned 4 + recent 18–46 (fixed counts) | Pinned 8 + token-budget tail (dynamic) |
| **Single-player behavior** | Byte-identical, minimal window | Wide window (same as multiplayer) |
| **Continuity floor** | R_continuity=40 (Category B avg 0.455) | No collapse through R136 (Category B avg 1.000) |
| **Drift onset** | P4/R16 | None through R136 / 1.1 MB |
| **History sent per turn** | ~6–16 KB (18–46 msgs) | ~30–40 KB (100–120 msgs) |
| **Throughput** | 80.13 tok/s | 68.75 tok/s (−14%, expected KV cost) |
| **VRAM @ 32768** | Not measured | 17 GB / 100% GPU (RTX 4090) |
| **Continuity status** | Broke past R40 | Held through R136; full-200 unverified |

---

## Efficacy Summary

**Hypothesis:** a wider history window plus a larger num_ctx fixes the continuity collapse.  
**Result:** confirmed through 136 rounds.

### Core Metrics
- **Category-B accuracy (the hard anchors):** baseline 0.455 (20/44) → new 1.000 (136/136)
- **Usable session length:** baseline collapsed at R40 (R_continuity=40); the new run reached R136 with no collapse
- **Anchor retention at scale:** baseline shed Garret/Forge/12gold by R20; the new run passed all 6/6 anchors at every probe through 1.1 MB of history
- **Coherence:** baseline showed a graceful fade; the new run showed no drift through R136

### Continuity Probes (P1–P34)
All 34 probes scored 6/6 PASS across the anchor categories:
- **A (Ravenmoor, origin):** 34/34
- **B1–B5, B8 (NPC / location / value / faction):** 136/136 (all four spotlight owners, all 34 probes)
- **C (recency, 1-turn-old):** 34/34

No probe scored below 6/6, and accuracy did not decline as history accumulated.

### Late-Run Prose Spot-Check (R136 @ 1.1 MB)
Probe P34 fired at R136 turn 2 (turn_index 542). In its own narration the DM:
- names "**Garret Ironhand**" with the exact spelling from the introduction, not a variant
- locates "**the Forge of Embers**", not an invented shop
- recalls "**12 gold pieces**" paid to Mira the Fence, not "20 gold" or "50 gold"
- treats "**Ash Covenant**" as a live faction, not forgotten or confused

All four deep-recall anchors survive in context-rich late-game narration.

---

## Performance Trade-Offs

### Throughput
- **Baseline:** 80.13 tok/s
- **New:** 68.75 tok/s (p25=68.0, p75=68.7, stable plateau)
- **Delta:** −14%, from the 4× KV-cache expansion. Per-turn wall time settles around 7–9 s, which is fine for a 4-player table.

### VRAM
- **RTX 4090 total:** 24 GB
- **Ollama + model @ 32768:** 17 GB (100% GPU, no CPU offload)
- **Headroom:** 7 GB unused
- **Swap behavior:** none detected; the model stayed resident on GPU throughout the run

### Latency by Phase
- **Cold start (R1T1):** 19.5 s (one-time prompt-eval)
- **Warm steady state (R50+):** ~7–9 s per turn (median 7.8 s, p75 9.1 s)
- **No sag:** throughput held at 68–69 tok/s as persist_bytes climbed to 1.15 MB
- **Spotlight fairness:** max starvation gap 12 turns across 4 players and 545 turns

---

## Known Unknowns & Limits

### Not Yet Measured
1. **Duration ceiling:** planned 200 rounds, reached 136 before the harness stopped (the model did not collapse). The natural failure mode at 32768 is still unknown, so 136 rounds is a floor, not a ceiling.
2. **Impish-qwen:14b @ 32768:** tested at 8192 only (baseline). PR #6 (parked) would enable a re-test; not done.
3. **Multi-session durability:** one 136-round session is validated; no data on behavior after cache eviction or GC cycles.

### Inherent Ceilings (pre-existing)
- **localStorage:** ~8 KB/round growth; the summary projects exhaustion near round 599. Pre-existing, not introduced by the fix.
- **VRAM at larger num_ctx:** 32b models at 32768 would overflow, so they stay at 8192 by design.
- **Long campaigns:** anchors eventually scroll out of any finite window; the `extractEntities` digest is a fallible backup.

### Caveats
- **The 14% throughput penalty is real.** It is the trade for coherence; smaller windows are faster.
- **Early stop at R137:** a harness artifact (a worked-example name copied into the party block), not a fix failure. Production mode recovers gracefully; the harness has a fatal sentinel. Full §9 in the findings doc.

---

## Verdict

Ship PR #8. Through the part of the run we measured, the fix works: Category-B accuracy went from 0.455 to 1.000, drift onset is gone through R136, and the DM held every anchor across 136 rounds and 1.1 MB of history, at 17 GB VRAM, 68.75 tok/s, and ~7–9 s per turn. The run reached 137 of a planned 200 rounds before a harness-side party-block edge case stopped it, so full-200 durability is not yet proven. The 136-round result is a verified floor. The early stop is unrelated to the fix; PR #8 did not touch party-block parsing.

**Recommend:** deploy PR #8 to main and watch production sessions for party-block anomalies. The Option A/B/C harness follow-ups are low priority and can wait.

---

## Test Artifacts

| Artifact | Path | Purpose |
|---|---|---|
| Summary JSON | `stress-test-summary-4p-4p_qwen25_ctx32k.json` | Aggregate metrics, probe breakdown, series data |
| Per-turn log | `stress-test-4p-4p_qwen25_ctx32k.jsonl` | 545 turn records: tokens, wall time, anchors, CJK flags |
| Full prose | `fulltext-4p-4p_qwen25_ctx32k.jsonl` | DM narrative per turn (for spot-checks) |
| Console log | `run-4p_qwen25_ctx32k.log` | Harness progress, throughput, probe results |
| Findings | `stress-test/4P-DUAL-MODEL-FINDINGS-CTX32K.md` | Detailed analysis |

---

## References

- **Design:** `docs/design/CONTEXT-WINDOW-CONTINUITY-PLAN.md` (the spec this shipped against)
- **Baseline findings:** `stress-test/4P-DUAL-MODEL-FINDINGS.md` (8192 baseline, qwen vs impish)
- **PR #8:** merge commit 3bf8da8; gated via code review and unit tests
- **Implementation guide:** `CONTEXT-WINDOW-CONTINUITY-PLAN.md` §5
