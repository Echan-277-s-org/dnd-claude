# 4-Player Endurance Run — Continuity Quality Analysis (QA)

**Run:** `4p_main` (20 rounds / 78 turns, stop_reason `B_COLLAPSE`).
**Sources:** `stress-test-summary-4p-4p_main.json`, `stress-test-4p-4p_main.jsonl`, `src/lib/context.js`, single-player baseline `stress-test-summary-8192_fixed3.json`.

## Headline verdict

The 4-player campaign hits a continuity ceiling at **round 16 (~64 player turns)**. `B_COLLAPSE` fired legitimately, not as a scoring artifact: the same three digest-only anchors (B1 Garret, B2 Forge of Embers, B5 12 gold) failed at **every** probe from P2 (round 8) onward — 8 consecutive anchor-test failures, with the DM confidently supplying *wrong* names rather than admitting uncertainty.

**Core diagnosis — Garret vs. Ash Covenant:** `Garret` was lost because the DM bolded the blacksmith as the single 5-word span **"Garret Ironhand's Forge of Embers"**, which `extractEntities` rejects (`context.js:218`, `words.length > 4`). It was therefore *never indexed* as a digest entity. Once its source messages scrolled out of the 18-message recent window (~round 5), nothing held it, and the DM confabulated a replacement — **"Eldric Ironhand" / "Smithy's Forge"** — which then accrued its own frequency count, permanently blocking `Garret` from recovering. `Ash Covenant` survived all 5 probes because it is a clean 2-word title-case span that the DM re-mentioned organically as a looming threat, so it accrued the frequency rank needed to hold a digest slot under the 50-entity cap.

## 1. Per-category accuracy curve

| Probe | Round | A | B | C | Probe |
|-------|-------|------|------|------|------|
| P1 | 4  | 1/1 | 4/4 (1.00) | 1/1 | 6/6 = 1.00 |
| P2 | 8  | 1/1 | 2/4 (0.50) | 1/1 | 3/6 = 0.50 |
| P3 | 12 | 1/1 | 1/4 (0.25) | 0/1 | 2/6 = 0.33 |
| P4 | 16 | 1/1 | 2/4 (0.50) | 1/1 | 3/6 = 0.50 |
| P5 | 20 | 1/1 | 2/4 (0.50) | 1/1 | 3/6 = 0.50 |

The expected health relation **A ≥ C ≥ B** holds exactly. Category A (pinned, `messages[0..3]`) = 1.00 throughout; C (recent window) = 0.80; B (digest-only) collapses 1.00 → 0.50 → 0.25 → 0.50 → 0.50. Cumulative B = 8/20 = **0.40**. The collapse is structural (same anchors fail every time), not probe variance.

## 2. Anchor-failure map and mechanism

- **B1 Garret / B2 Forge of Embers** — PASS@P1, FAIL@P2–P5. Never indexed (5-word bold span); DM later confabulated "Eldric Ironhand"/"Smithy's Forge" (digest strings at T46/T62/T78).
- **B5 12 gold** — PASS@P1, FAIL@P2–P5. Numeric facts have **no digest path** at all (`extractEntities` only captures `**bold**` / quoted proper-noun spans). Survives only in the recent window; gone by round 8.
- **B8 Ash Covenant** — PASS@P1–P5. 2-word title-case span, re-mentioned by the DM across mid-game turns → frequency-ranked survival.
- **A1 Ravenmoor** — PASS@P1–P5 (pinned opener, never trimmed).

## 3. Drift onset & single-player contrast

- Drift onset: **B1 Garret, round 8 (P2)** — ~6 rounds / ~24 turns after introduction (round 2).
- **Shared-window math:** 4 players generate ~8 messages/round, so the 18-message recent window holds only **~2.25 rounds** of history. Any individual player's fact is evicted ~**4× faster by round** than single-player (where one player owns every turn and the window covers ~9 of their own turns).
- **Baseline (`8192_fixed3`, single-player):** held category-B at 0.50 across 60 turns and **never** triggered `B_COLLAPSE`; drift onset at a 14-turn distance. The 4-player run collapses at round 20 with B=0.40. (Note: B8 Ash Covenant *failed* in the single-player run but *passed* here — a DM-behavior difference across runs, not a structural inversion.)

## 4. Spotlight starvation × continuity

`spotlight_distribution = {Lyra: 37 (47%), Kael: 18, Sora: 16, Bron: 7 (9%)}`; `max_starvation_gap = {Bron: 50, Sora: 44}`. Even *with* explicit cooperative handoff nudges in every beat, the DM concentrated the spotlight on Lyra (the Wizard, narratively "active" in a dungeon). Consequences:
- `category_B_accuracy_by_spotlight_owner.Bron = null` — Bron was never spotlit at a probe, so a quarter of the party's perspective is unmeasured.
- Low-spotlight players' facts are re-mentioned less → lower digest frequency → evicted first. Bron *introduced* Garret/Forge; both died.
- Experiential: a real Bron player is a near-passive observer for the whole session — a quality failure independent of context limits.

## 5. Party-shrink at round 13 — a real PC-name defect

At T49 (R13T1) the DM emitted `party_names: ["Aelis","Lyra","Bron","Sora"]` — **"Kael" renamed to "Aelis"** (`event_flags: ["PARTY_SHRINK"]`), self-correcting at T50. Same confabulation mechanism as Garret→Eldric, but applied to a **player character**. High-visibility, immersion-breaking; coincides with Kael re-entering the spotlight after low representation.

## 6. Verdict

Round-16 B-collapse is a **legitimate, structurally-necessary** ceiling under the current architecture. Honest answer: **noticeable name drift begins ~round 8**; by rounds 12–16 the DM is actively confabulating replacement names. Forgetting order (fastest → slowest): numeric/transaction facts → NPCs introduced by low-spotlight players → location guards → moderate-mention NPCs (Mira survived) → prominent factions (Ash Covenant) → pinned openers (never). The worst failure mode is **silent confabulation** — the DM never says "I don't recall," it states a wrong name confidently.

## Root causes (impact order)
1. The 18-message recent window is **shared** across all 4 players (no per-player pinning).
2. `extractEntities` rejects >4-word spans → possessive/compound entities ("Garret Ironhand's Forge of Embers") are never indexed.
3. Numeric/transactional facts have no digest representation.
4. Frequency-rank survival cannot protect an entity that was never indexed.
5. Spotlight concentration creates asymmetric re-mention that disadvantages low-spotlight players' facts.
