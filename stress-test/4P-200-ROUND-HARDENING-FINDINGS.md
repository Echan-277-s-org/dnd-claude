# 4-Player 200-Round Hardening Validation (`qwen2.5:14b` @ 32768 tokens)

**Date:** 2026-05-27  
**Branch:** `harness-200-hardening` (commit `8ddfcd2`)  
**Harness:** `stress-test/harness-4p.mjs` (follow-the-spotlight, 4 WS clients → `server/sync-server.mjs` → local Ollama; continuity-recall probe every 4 rounds)  
**Run:** `--mode=full --rounds=200` at `num_ctx=32768` (per-model via `numCtxForModel` in PR #8)  
**Model:** `qwen2.5:14b`  
**Run ID:** `4p_qwen25_ctx32k_v2`  
**Summary artifact:** `stress-test-summary-4p-4p_qwen25_ctx32k_v2.json`

---

## TL;DR

The 200-round full endurance run completed with zero failures. The DM held all continuity anchors across all 50 probes (P1–P50, rounds 4–200), with category accuracies A=1.0, B=1.0, C=1.0. Session history grew to 1.97 MB by round 200; the DM kept recall of the deep anchors (Garret, Forge of Embers, 12 gold, Ash Covenant) in live prose throughout. The prior run (PR #8) reached round 137 before a harness-side party-block artifact forced a stop. This hardening work removed that artifact via defense-in-depth (prompt fix, server-side safety nets, harness robustness) and confirmed full 200-round durability of the context-window continuity fix.

---

## Background: The R137 Artifact

The prior validation run (PR #8, `4p_qwen25_ctx32k`) stopped at R137T1 because three faults aligned: the DM emitted worked-example party names (`Aelis`/`Borin`) from `src/lib/context.js:54–69` (`buildSystemPrompt`), the server's party repair logic had a gap (same-slot rename but no cross-slot detection), and the harness's fatal `double NOT_YOUR_TURN → SERVER_ERROR` sentinel halted the run. PR #8 did not touch party parsing, so this was an edge case in party-block handling that became visible at scale, not a regression in the continuity fix.

The root cause: qwen2.5 can copy the worked example into the party block, particularly in early rounds. The fix used defense in depth: prevent the copy at the prompt, repair cross-slot renames at the server if a copy occurs, and skip phantom roster members at the harness.

---

## Four Hardening Changes

### Option A: Harness Party-Block Robustness (`stress-test/harness-4p.mjs`)

**File:** `stress-test/harness-4p.mjs`  
**Change:** After a non-roster spotlight recipient (a name not in `activeClientList`) gets a `NOT_YOUR_TURN` error, the harness now advances the spotlight cursor to the next real roster player instead of fatal-stopping.

**Mechanism:**
- The harness maintains a spotlight cursor index into the roster.
- On a regular turn, spotlight advances to `(cursor + 1) % roster.length`.
- On a non-roster `NOT_YOUR_TURN` from the server, the harness detects the phantom (name not found in `activeClientList`), and uses a special "skip phantom" advance that finds the next real roster player (index-relative forward search, capped at one advance per beat to prevent loops).
- Emits `PHANTOM_ROSTER_RECOVERED` telemetry if a recovery occurs.

**Result:** A stray copied name in the party block no longer crashes the run. The spotlight rotates over the real players and the game continues.

### Option B: Server Party-Block Repair (`server/sync-server.mjs`, `anchorJoinedPCNames`)

**File:** `server/sync-server.mjs`  
**Function:** `anchorJoinedPCNames(newParty, oldParty, characters)` (lines ~172–325)  
**Changes:**
1. **Role-match-first:** Before falling back to same-slot rename, the matcher tries to match DM party members to canonical roster members by role first (e.g., a confabulated "Borin"/Cleric matches the canonical Bron/Cleric; the roster is Kael/Fighter, Lyra/Wizard, Bron/Cleric, Sora/Rogue).
2. **Same-slot fallback with guard:** Only applies same-slot rename if the roles are compatible (a new NPC with a different role at a missing PC's old index is NOT renamed to that PC).
3. **Total-confabulation safety net:** If the DM emits zero real players (a wholesale copy on turn 1, e.g., all entries are from the worked example), the server detects this and rebuilds the party from the canonical roster, preserving the original isActive/hpPct/id at each index.

**Unit tests:** Added 9 new tests (total suite now 903 pass / 2 skip), verifying role-match, cross-slot repair, same-slot guards, and confabulation recovery.

**Result:** Even if the DM copies worked-example names, the server's strict matching keeps phantoms out of the stored state, so the canonical roster shape holds.

### Option C: Prompt Anti-Copy Instruction (`src/lib/context.js` + `src/lib/context.starwars.js`)

**File:** `src/lib/context.js` (`buildSystemPrompt`: party-block spec item 1, plus an inline caution at the worked example)  
**Change:** Strengthened the party-block instruction. The operative text:
```
The `name` values MUST be the ACTUAL, real, established names of the players in
THIS campaign ... never invented, never derived from a role. ... CRITICAL: the
member names shown in the worked example below (and their hpPct values) are
illustrative placeholders that demonstrate the JSON FORMAT ONLY — they are NOT
characters in this campaign and must NEVER appear in your output. Copying those
example names is a serious error; always list this campaign's real party members.
```

**Interim pivot:** An earlier attempt used `PC_Ranger`/`PC_Cleric` placeholders for the example names. Smoke testing showed this made things worse: qwen2.5 treated `PC_<Role>` as a generative template and copied the entire example array (with hpPct values 80/95 verbatim) on turn 1. The smoke gate caught this regression before the long run. We pivoted to arbitrary example names (Aelis, Borin, etc.), an explicit anti-copy instruction, and the server/harness safety nets.

**CJK suppression:** Both prompt engines also gained an English-only guardrail line to push the model away from non-Latin output. This line alone does not eliminate CJK leaks (see §6).

**Result:** The DM lists real party members in its response party blocks, and the worked example is less likely to be copied. Server repair and harness robustness cover the cases where it is.

---

## Smoke Gate & Pivot

The smoke harness (`--mode=smoke`: one round of four beats plus a continuity probe, checked against ten gates) gated each iteration before the long run:
1. **Interim, `PC_<Role>` placeholders:** smoke FAILED. qwen2.5 copied the whole example party on turn 1 — `[PC_Ranger, PC_Cleric, PC_Wizard, PC_Rogue]`, hpPct 80/95 verbatim — so Gate 4 (party block carries the four roster names) failed and the run's later turns dropped. The gate caught the regression before any long run.
2. **Final, arbitrary names + anti-copy instruction + server/harness safety nets:** three consecutive smoke runs passed all ten gates, with the party block `["Kael","Lyra","Bron","Sora"]` each time and zero CJK leaks.

---

## Full 200-Round Results

**Run ID:** `4p_qwen25_ctx32k_v2`  
**Stop reason:** `completed` (not `stop_round` or error)  
**Wall time:** 9335 seconds (~2.6 hours)

### Continuity Performance

**Probes:** P1–P50, one every 4 rounds (rounds 4, 8, 12, …, 200)

| Category | Passed | Total | Accuracy | Note |
|---|---|---|---|---|
| **A (origin: Ravenmoor)** | 50 | 50 | 1.0 | No drift |
| **B (deep recall: Garret, Forge of Embers, 12 gold, Ash Covenant)** | 200 | 200 | 1.0 | All 4 spotlight owners, all 50 probes |
| **C (recency: 1-turn-old landmarks)** | 50 | 50 | 1.0 | Fresh anchors always present |
| **All anchors (cumulative)** | 300 | 300 | 1.0 | No single-point drift |

**Category B by spotlight owner:**
- Kael: 50/50 (1.0)
- Lyra: 50/50 (1.0)
- Bron: 50/50 (1.0)
- Sora: 50/50 (1.0)

**Drift metrics:**
- `drift_onset: null` (no probe failed; no drift detected)
- `rounds_to_B_collapse: null` (no collapse through R200)
- Last verified probe: P50 at R200, all 6/6 PASS

### Anchor Retention at Scale (Final Probe, R200)

Probe P50 fired at round 200 (turn 800, turn_index 799). At 1.97 MB of session history, the DM prose still named:
- "**Garret Ironhand**" with exact spelling
- "**the Forge of Embers**" as a known location
- "**12 gold pieces**" as a specific transaction from early in the campaign
- "**Ash Covenant**" as an active threat

Zero confusion with worked-example names; zero mid-tier variants. All four Category-B anchors survived in late-game narration at full context.

### Robustness

| Event type | Count | Status |
|---|---|---|
| PHANTOM_ROSTER_RECOVERED | 0 | (Option A never needed to fire) |
| PARTY_SHRINK | 0 | (No roster loss) |
| SERVER_ERROR | 0 | (No server crashes) |
| OLLAMA_TIMEOUT | 0 | (No model hangs) |
| RATE_LIMITED | 0 | (No action throttling) |

**Zero hard failures:** the DM never confabulated, so Options A/B safety nets were not exercised in this run. They are validated separately by unit tests + design review.

### Performance

| Metric | Value | Note |
|---|---|---|
| Mean tok/s | 66.95 | Stable across full run (p25=65.13, p75=67.8, p95=72.32) |
| First turn (R1T1) | 5.0 s | Warm start; model already resident from the preceding smoke runs (a true cold start is ~19.5 s) |
| Warm steady state (R50+) | ~7–9 s | Single-digit seconds, rising as context fills |
| CPU offload detected | false | Model stayed GPU-resident for all 800 turns |
| VRAM @ full ctx (32768) | Not re-captured | Baseline prior run: 17 GB / 100% GPU, fits RTX 4090 with 7 GB headroom |

Throughput held at ~67 tok/s as persist_bytes climbed from 9 KB (R1) to 1.97 MB (R200); no sag as history grew.

### Session History Growth

| Round | Bytes | Rounds to localStorage cap |
|---|---|---|
| 1 | 9.2 KB | — |
| 50 | 386 KB | — |
| 100 | 967 KB | — |
| 150 | 1.52 MB | — |
| 200 | 1.97 MB | 488 (projected) |

The limiting factor for long campaigns is localStorage exhaustion, not continuity. localStorage growth projects exhaustion near round 488, a pre-existing ceiling not introduced by this work.

### Spotlight Fairness

| Player | Spotlight turns | Max starvation gap |
|---|---|---|
| Kael | 201 | 12 |
| Lyra | 196 | 13 |
| Bron | 202 | 11 |
| Sora | 201 | 13 |

Distribution is balanced; max starvation gap is 13 turns across 800 total turns, which is acceptable for a 4-player table.

### CJK Leakage

| Metric | Value | Note |
|---|---|---|
| Turns affected | 3 / 800 | 0.4% leak rate |
| Total non-Latin chars | 54 | Across 3 turns (rounds 64, 112, 158) |
| Self-recovering | Yes | Model regains English after the leak |

**Caveats:**
- The English-only guardrail in the prompt reduced but did not eliminate leaks (prior run: 0.55%, this run: 0.4%). A prompt nudge alone cannot guarantee zero.
- CJK leaks are unrelated to the continuity fix or the hardening work; they are a qwen2.5 quirk at this context size.
- The leaks are acceptable: they do not corrupt game state or break continuity, they self-correct, and they are rare.

---

## Comparison to Prior Runs

### vs. Prior `4p_qwen25_ctx32k` (PR #8, R137 stop)

| Metric | PR #8 (R137 stop) | Hardening run (R200 complete) | Delta |
|---|---|---|---|
| **Completion** | 137/200 (stopped at artifact) | 200/200 (completed) | +63 rounds |
| **Category B accuracy** | 1.0 (through R136) | 1.0 (through R200) | Held |
| **Drift onset** | None through R136 | None through R200 | No regression |
| **Session history** | ~1.15 MB (R136) | 1.97 MB (R200) | +0.82 MB |
| **Robustness event** | PARTY_SHRINK @ R137 | (none) | Artifact fixed |

The artifact was a harness-side party-block edge case, not a failure of the continuity fix. With defense-in-depth in place, this run reached the full 200 rounds.

### vs. Baseline `4p_qwen25` (8192 ctx, prior report)

| Metric | Baseline (8192) | Hardening run (32768) | Delta |
|---|---|---|---|
| **Category B accuracy** | 0.455 (20/44) | 1.0 (200/200) | +120% |
| **R_continuity** | 40 (collapse) | null (no collapse) | Eliminated |
| **Late-run anchor retention** | 1/4 B survive past R40 | 6/6 survive at R200 | Perfect |
| **Mean tok/s** | 80.13 | 66.95 | −16% vs. 8192 baseline (KV-cache cost) |
| **Max context window** | 8192 | 32768 | 4× |

At twice the prior scope, the 32768 window held Category-B accuracy at 1.000 with no collapse.

---

## Verdict

The 200-round hardening validation passed. The context-window continuity fix (PR #8) is production-ready. The four hardening changes removed the R137 artifact and the run reached the full 200 rounds:

- Prompt (Option C): anti-copy instruction plus English-only guardrail
- Server (Option B): role-match-first repair, cross-slot guards, total-confabulation safety net, unit tests
- Harness (Option A): phantom-skip advance (not needed in this run, validated by design)

All three layers held. The DM never confabulated, so the safety nets were not exercised, but they remain available.

Continuity held through 200 rounds and 1.97 MB of session history, across all 4 spotlight owners and all 50 anchor categories. Robustness was clean: zero hard failures, zero timeouts, zero server errors.

On performance, throughput was −16% vs. the 8192 baseline (expected KV-cache cost) and −2.7% vs. the prior 32K run, at ~7–9 s per turn, which is acceptable for a D&D table. VRAM was not re-captured this run; the prior run measured 17 GB (fits RTX 4090).

Next step: this work is committed on `harness-200-hardening` (commit `8ddfcd2`); open the PR to main.

---

## Test Artifacts

| Artifact | Path | Purpose |
|---|---|---|
| Summary JSON | `stress-test-summary-4p-4p_qwen25_ctx32k_v2.json` | Full metrics, probe breakdown, performance series |
| Per-turn log | `stress-test-4p-4p_qwen25_ctx32k_v2.jsonl` | 800 turn records: tokens, wall time, anchor results, CJK flags |
| Full prose | `fulltext-4p-4p_qwen25_ctx32k_v2.jsonl` | DM narrative per turn (for spot-checks) |
| Console log | `run-4p_qwen25_ctx32k_v2.log` | Harness progress, throughput, probe results |
| Code branch | `harness-200-hardening` | Commit 8ddfcd2 (4 changes: harness + server + 2 prompts) |

---

## References

- **Design spec:** `docs/design/CONTEXT-WINDOW-CONTINUITY-PLAN.md`
- **Prior findings (PR #8):** `stress-test/4P-DUAL-MODEL-FINDINGS-CTX32K.md` (§9 on the artifact)
- **Baseline findings:** `stress-test/4P-DUAL-MODEL-FINDINGS.md` (8192 baseline)
- **Methodology:** `stress-test/harness-4p.mjs` (continuity probe def: anchors A/B/C, probe firing every 4 rounds)