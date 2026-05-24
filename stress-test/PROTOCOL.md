# Stress-Test Protocol: Long-Session Continuity & num_ctx Comparison
**Target app:** `H:\Claude\dnd-claude\` — React+Vite D&D Assistant
**Model:** `qwen2.5:14b` via `http://localhost:11434/api/chat`
**Hardware:** RTX 3070-class, 8GB VRAM, 16GB RAM
**Purpose:** Measure drift onset and determine whether raising `num_ctx` from 4096 to 8192 is worth the throughput cost.

---

## 1. Architecture Notes the Harness Must Mirror

**Endpoint and streaming format:**
- `POST http://localhost:11434/api/chat`
- Body: `{ model, stream: true, messages: [{role,content},...], options: {...} }`
- Response: newline-delimited JSON; each line is `{ message: { content: "..." }, done: bool }`. Accumulate `message.content` deltas until `done: true`. The final `done: true` line also carries `eval_count`, `eval_duration`, `total_duration` — capture all three.

**Message construction per turn (replicate `sendMessage` exactly — read the real bodies from `src/components/Chat.jsx`):**
1. Maintain a raw message log (full `messages` array, including `role: 'dice'` entries).
2. Before each API call, map dice entries to `{ role: 'user', content: '[Dice roll: dX → N]' }` in place.
3. Apply `trimContext` with `pinned=2, recent=18`: if `messages.length > 20`, keep `messages[0..1]` plus `messages[len-18..end]`.
4. Apply `extractEntities` against the **pre-trim full log** (all assistant messages), `max=40`. Captures `**bold**` spans (skip if >5 words) + double-quoted 1-3-word capitalized proper-noun spans (≤40 chars, no mid-string sentence punctuation), dedup case-insensitive, last 40.
5. System message = base `buildSystemPrompt` + if entities exist, append `\n\n---\nEstablished entities so far (stay consistent with these named NPCs, locations, and items): <comma-list>.`
6. Final API messages array: `[{role:'system', content: systemContent}, ...trimmedApiMessages]`.

**Sampling options (identical for both runs unless noted in §5):**
```
num_ctx: 4096          (or 8192 for second run)
num_predict: 400       (capped lower than prod 900 for speed — log this deviation)
temperature: 0.8
top_p: 0.9
top_k: 40
repeat_penalty: 1.15
repeat_last_n: 256
```

**Campaign object (fixed, both runs):**
```json
{
  "name": "The Shattered Vale",
  "details": "A dark fantasy campaign set in a crumbling empire. The party seeks the lost Sunstone artifact.",
  "model": "qwen2.5:14b"
}
```

**Seed:** Ollama does not expose a reliable seed for qwen2.5 on `/api/chat`. Do not seed. Comparison relies on identical scripts + aggregate metrics, not response-level determinism.

---

## 2. Ground-Truth Anchor Roster

Player turn text is the stimulus; the DM's response introduces the fact into history.

### Category A — Pinned-opener anchors (survive via pinned messages 0-1)
| ID | Fact | Introduced | Expected recall string |
|----|------|-----------|------------------------|
| A1 | Town: Ravenmoor | T=1 | `Ravenmoor` |
| A2 | Starting tavern: The Broken Lantern | T=1 | `Broken Lantern` |
| A3 | Quest giver: Elder Sorcha | T=2 | `Sorcha` |
| A4 | Artifact sought: the Sunstone | T=2 | `Sunstone` |

### Category B — Entity-digest anchors (survive ONLY via extractEntities digest) — MOST CRITICAL
| ID | Fact | Introduced | Expected recall string |
|----|------|-----------|------------------------|
| B1 | Blacksmith: Garret Ironhand | T=3 | `Garret` |
| B2 | Shop: The Forge of Embers | T=3 | `Forge of Embers` |
| B3 | Guard captain: Captain Vell | T=5 | `Vell` |
| B4 | Guard post: East Gate barracks | T=5 | `East Gate` |
| B5 | Price paid for info: 12 gold pieces | T=7 | `12 gold` |
| B6 | Informant: Mira the Fence | T=7 | `Mira` |
| B7 | Landmark: the cracked fountain | T=9 | `cracked fountain` |
| B8 | Rival faction: the Ash Covenant | T=10 | `Ash Covenant` |

Boundary: digest-only zone begins when `messages.length > 20` (≈ player turn 21). Log the exact message index at which each anchor's source message is dropped from the trim window.

### Category C — Recent-window anchors (sanity baseline)
| ID | Fact | Introduced | Expected recall string |
|----|------|-----------|------------------------|
| C1 | Dungeon entrance: the Weeping Arch | T=42 | `Weeping Arch` |
| C2 | Trap: a pressure-plate floor trap | T=44 | `pressure` |
| C3 | Guardian: a stone golem | T=48 | `golem` |
| C4 | Item found: the Shard of Dawn | T=52 | `Shard of Dawn` |

---

## 3. Scripted Campaign — 60 Player Turns

Send sequentially, awaiting full response each time. `[PROBE]` turns occupy real message positions (advance the counter, affect the trim window). Dice turns injected as `{role:'user', content:'[Dice roll: dX → N]'}`.

```
T01: Begin the adventure — we arrive in Ravenmoor and make for The Broken Lantern tavern. Set the scene.
T02: We approach Elder Sorcha and ask about the Sunstone. What does she tell us?
T03: We head to the blacksmith. Who is it and what do they know about the road ahead?
T04: We ask the blacksmith to inspect our weapons and tell us if they need repair.
T05: We go to the East Gate to speak with whoever is in charge there. Who greets us?
T06: We ask the captain if there has been any unusual activity on the road to the Shattered Vale.
T07: We seek out someone in town who might know about the Ash Covenant. We're willing to pay for information.
T08: We pay Mira and listen carefully to everything she tells us.
T09: We follow Mira's directions and find the cracked fountain she described. What do we see there?
T10: We examine the passage entrance. What dangers are apparent?
T11: We prepare our gear and descend into the passage.
T12: [Dice roll: d20 → 14]
T13: We move carefully, taking whatever path seems safest.
T14: We encounter a locked iron door. We check for traps first.
T15: [Dice roll: d20 → 8]
T16: We try to pick the lock.
T17: [Dice roll: d20 → 19]
T18: We push through and continue deeper.
T19: What do we hear echoing from below?
T20: We hold still and listen.
T21 [PROBE-1]: Out of character: without looking back, tell me the name of the blacksmith we visited at the start of the session, the name of his shop, and the price we paid Mira for information.
     // Tests B1,B2,B5 (digest-only). Expect: Garret / Forge of Embers / 12 gold
T22: Back in character. We descend toward the sound.
T23: We find a large underground chamber. What does it look like?
T24: We search the chamber for any exits or points of interest.
T25: [Dice roll: d20 → 11]
T26: We investigate the eastern wall more closely.
T27: We find markings on the wall. What do they say?
T28: We record the markings and continue through the northern passage.
T29: We hear movement ahead. We prepare for combat.
T30: [Dice roll: d20 → 17]
T31 [PROBE-2]: Out of character: who sent us on this quest, what is the artifact we are looking for, and what faction did Mira warn us about?
     // Tests A3,A4 (pinned), B8 (digest). Expect: Sorcha / Sunstone / Ash Covenant
T32: Back in character. We engage whatever is ahead.
T33: [Dice roll: d20 → 3]
T34: We fall back and take cover behind the nearest pillar.
T35: [Dice roll: d20 → 16]
T36: We strike when the moment is right.
T37: [Dice roll: d20 → 20]
T38: We loot anything useful from the fallen enemy.
T39: We tend our wounds and rest for a short time.
T40: We continue deeper. What is the next obstacle?
T41 [PROBE-3]: Out of character: what was the name of the town we started in, and what was the name of the guard captain at the East Gate?
     // Tests A1 (pinned), B3 (digest). Expect: Ravenmoor / Vell
T42: Back in character. We press forward and reach what appears to be the entrance to the main dungeon complex. Describe what we see.
T43: We study the Weeping Arch carefully before passing through.
T44: We step through and check the floor ahead before walking.
T45: [Dice roll: d20 → 9]
T46: We trigger something. What happens?
T47: We recover and press on, more cautiously now.
T48: We reach a large hall. What creature guards it?
T49: We attempt to communicate with the creature before attacking.
T50: [Dice roll: d20 → 13]
T51 [PROBE-4]: Out of character: describe the landmark we passed through to enter this dungeon complex, the trap we encountered just inside, and the type of creature guarding the main hall.
     // Tests C1,C2,C3 (recent). Expect: Weeping Arch / pressure / golem
T52: Back in character. We search the hall for the Sunstone. What do we find?
T53: We examine the item closely. What are its properties?
T54: We take the item and look for an exit.
T55: [Dice roll: d20 → 7]
T56: The exit appears guarded. We try to sneak past.
T57: [Dice roll: d20 → 15]
T58: We make it through and climb back toward daylight.
T59: We emerge near the cracked fountain. What do we see waiting for us?
     // Passive recall test of B7 (not a scored probe, but flag if DM forgets)
T60 [PROBE-5]: Out of character: final continuity check. Name the town we started in, the artifact we recovered, the faction that opposes us, the informant who helped us, and the price she charged.
     // Tests A1 (pinned), C4 (recent), B8,B6,B5 (digest). Expect: Ravenmoor / Shard of Dawn / Ash Covenant / Mira / 12 gold
```

Dice turns: T12,T15,T17,T25,T30,T33,T35,T37,T45,T50,T55,T57.

---

## 4. Scoring and Metrics

**Per sub-anchor:** case-insensitive substring match of expected string in the probe's DM response → PASS(1)/FAIL(0). No fuzzy/synonym matching.

**Summary metrics:**
- `probe_accuracy[P]` = passed/total within probe.
- `category_accuracy[X]` = passed/total across all probes for category A/B/C. Expected if healthy: `C >= A >= B`. If B collapses while A/C hold → entity digest is the failing link. If A also fails → pin mechanism broken.
- `drift_onset` = earliest probe at which a previously-recalled anchor first fails; report anchor + turn distance (`probe_turn - introduced_turn`).
- `CONTRADICTION` events: non-probe turns where the DM spontaneously contradicts an anchor (record turn, anchor, snippet).
- **Degradation point:** system considered degraded when `category_B_accuracy < 0.50`.

**Performance (per turn, from final done JSON):** `tokens_per_sec = eval_count / (eval_duration/1e9)`; `prompt_eval_duration = total_duration - eval_duration`. Per-run summary: mean, p25, p75, p95 of tokens/sec over non-probe turns.

**CPU offload check:** every 10th turn, shell `ollama ps`, parse PROCESSOR + CONTEXT columns. Record first turn where CPU involvement appears that was absent at turn 1.

---

## 5. num_ctx Comparison Protocol

Two complete sequential runs of the identical 60-turn script:
- **Run A:** `num_ctx: 4096` (production)
- **Run B:** `num_ctx: 8192`

Hold constant: campaign object, all 60 turn texts, all options except num_ctx, `num_predict: 400`, trimContext + extractEntities logic. Run A fully completes before Run B. ≥60s between runs; verify via `ollama ps` model idle. Do NOT restart Ollama or evict the model between runs (keep weights GPU-resident). Reset harness message log to empty before Run B.

**Decision rule:**
```
recall_delta_B = category_B_accuracy[B] - category_B_accuracy[A]
speed_ratio    = mean_tokens_per_sec[B] / mean_tokens_per_sec[A]
```
| Condition | Recommendation |
|-----------|----------------|
| recall_delta_B ≥ 0.20 AND speed_ratio ≥ 0.70 | Upgrade to 8192 |
| recall_delta_B ≥ 0.20 AND speed_ratio < 0.70 | Conditional: upgrade only if user accepts >30% slowdown; report absolute tok/s |
| recall_delta_B < 0.20 AND speed_ratio ≥ 0.85 | Upgrade to 8192 (negligible cost) |
| recall_delta_B < 0.20 AND speed_ratio < 0.85 | Stay at 4096 |
| CPU offload appears in B not A | Hard flag: report turn, recommend staying at 4096 unless user accepts offload |

Also: if Run A already achieves `category_B_accuracy >= 0.80`, note the digest works well and the 8192 motivation is weak.

---

## 6. Run Management

- **num_predict: 400** for all runs (log the deviation from prod 900 in output header).
- **Smoke subset first (15 turns):** T01,T02,T03,T05,T07,T09, then PROBE-1 text as smoke-turn 12, then T10–T17. Verify: (1) trimContext+extractEntities construct correctly, (2) streaming NDJSON succeeds, (3) final done line has eval_count+eval_duration, (4) `ollama ps` parses, (5) ≥1 B-anchor recalled in the probe. Halt + report if any fails. Only then run full.
- **Incremental logging:** write one JSON line per turn to `stress-test-[run_id].jsonl` AS each turn completes (no batching) so partial progress survives interruption. Each line ≥: run_id, turn, is_probe, probe_id, anchors_tested, anchors_passed, tokens_per_sec, eval_count, eval_duration_ns, total_duration_ns, ollama_processor, entity_digest_string, response_snippet (first 200 chars).
- **Time budget:** ~18 min/run at num_predict 400, ~45-60 min total. Run as a background process; poll the jsonl.

---

## 7. Output Files (per run)
1. `stress-test-[run_id].jsonl` — one line/turn (§6).
2. `stress-test-summary-[run_id].json` — written on completion: run_id, num_ctx, num_predict, total_turns, probe_results (score + passed/failed per probe), category_accuracy {A,B,C}, drift_onset, contradictions, performance {mean,p25,p75,p95 tok/s}, cpu_offload_detected, cpu_offload_first_turn, wall_time_seconds.

After both runs, print a final comparison table to stdout applying the §5.3 decision rule, naming the recommendation and the values driving it.

---

## 8. Boundary Conditions to Verify Explicitly
1. **Trim boundary logging:** when `messages.length` crosses 20, log dropped indices; verify B-anchors' source response text is absent from the trimmed payload.
2. **Digest capture verification:** after every call, log the full entity digest string. Primary observable for B failures — if an anchor fails, check whether it was ever in the digest.
3. **Dice turn handling:** inject as `{role:'user', content:'[Dice roll: dX → N]'}` (not prose). They advance history but aren't scored.
4. **Probe turn position:** real positions (T21,T31,T41,T51,T60); they advance the counter and affect trim.
5. **Empty digest:** T01/T02 have no assistant messages yet → send system WITHOUT digest suffix (match `entities.length` check). Verify for first two turns.
