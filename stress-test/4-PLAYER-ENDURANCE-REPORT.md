# 4-Player D&D Campaign Endurance — Report

*Multi-agent stress test (workflow-orchestrator → test-automator → performance-engineer + qa-expert + chaos-engineer). Full-fidelity run against the real multiplayer server (`server/sync-server.mjs`) driven by 4 simulated WebSocket clients. Model `qwen2.5:14b`, production sampling (`num_ctx:8192`, `num_predict:900`).*

## Headline

**A 4-player campaign degrades after ~16 rounds (~64 player turns).** Limiting factor: **continuity** — the AI DM starts forgetting and confabulating mid-campaign NPC names and facts, while storage and compute have 40–600× more headroom.

- **Noticeable drift begins ~round 8** (the blacksmith's name/shop and a paid price are already gone); by rounds 12–16 the DM confidently supplies *wrong* names.
- Run: `4p_main`, 20 rounds / 78 turns, `stop_reason = B_COLLAPSE`, wall 399 s (~6.6 min). The run was *designed* to push to 60 rounds but auto-halted at the continuity-collapse stop condition.

## Per-dimension ceilings (all four, with headroom)

| Dimension | Ceiling (rounds) | Ceiling (turns) | Measured / Extrapolated | Evidence |
|-----------|------------------|-----------------|--------------------------|----------|
| **Continuity** (category-B recall < 0.50 sustained) | **16** | ~64 | **measured** | `QA-4P-CONTINUITY.md`, probe_results |
| localStorage (5 MB `dnd_session`) | 745 (conservative) – 1,226 | 2,980 – 4,903 | extrapolated | `PERF-4P-ANALYSIS.md`, `CHAOS-4P-EXPERIMENTS.md` EX-1 |
| Server room memory (65 MB) | 9,638 | ~38,500 | extrapolated | `PERF-4P-ANALYSIS.md`, CHAOS EX-2 (no leak) |
| Hard failure (timeout / ctx overflow) | none | none | measured | `R_hardfail = null` |

`limiting_factor = R_continuity`, `headline_rounds = 16`. Continuity binds **47–602× sooner** than any resource ceiling.

## Continuity detail

**Category accuracy by probe (rounds 4/8/12/16/20):**

| | A (pinned) | B (digest-only) | C (recent) |
|---|---|---|---|
| P1 | 1.00 | **1.00** | 1.00 |
| P2 | 1.00 | **0.50** | 1.00 |
| P3 | 1.00 | **0.25** | 0.00 |
| P4 | 1.00 | **0.50** | 1.00 |
| P5 | 1.00 | **0.50** | 1.00 |

Pinned (A) and recent-window (C) facts hold; digest-only (B) facts collapse. Cumulative B = 0.40.

**Drift onset:** `Garret` (the blacksmith) first fails at **round 8**, ~24 turns after introduction.

**Why "Garret" dies but "Ash Covenant" lives — the core finding.** The DM bolded the blacksmith as one 5-word span, **"Garret Ironhand's Forge of Embers."** `extractEntities` rejects spans longer than 4 words (`src/lib/context.js:218`), so the entity was **never indexed** in the continuity digest. Once its source messages scrolled out of the shared 18-message recent window (~round 5), nothing retained it, and the DM confabulated a replacement — **"Eldric Ironhand" / "Smithy's Forge"** — which then accrued its own frequency count and permanently blocked recovery. `Ash Covenant` (a clean 2-word title-case span the DM re-mentioned as a threat) accrued enough frequency rank to survive all five probes.

**Forgetting order (fastest → slowest):** numeric/transaction facts (`12 gold` — no digest path at all) → NPCs introduced by low-spotlight players (`Garret`/`Forge`) → location guards (`Captain Vell`) → moderately re-mentioned NPCs (`Mira` survived) → narratively-prominent factions (`Ash Covenant`) → pinned openers (`Ravenmoor` — never forgotten).

**Spotlight starvation (a distinct 4-player failure).** Even with explicit cooperative hand-off phrasing in every turn, the DM concentrated the spotlight: **Lyra 37 turns (47%), Kael 18, Sora 16, Bron 7 (9%)**, with a **50-turn** gap for Bron. The combat-phase turn gate (`sync-server.mjs:451`) means non-spotlit players are *locked out entirely* — so under-rotation isn't just unfair, it blocks three of four players from acting for long stretches. Low-spotlight players' facts are also re-mentioned less, so they evict first (Bron introduced Garret/Forge — both died).

**Player-character name defect.** At round 13 the DM renamed **Kael → "Aelis"** in the party block (self-corrected one turn later). The same confabulation mechanism that erased Garret can rename a *player's own character* mid-session.

## Throughput & resources

- **Compute is flat (the central thesis, confirmed).** Mean **82.5 tok/s** (p25 78.9 / p75 84.7 / p95 89.4); tok/s-vs-round slope −0.16/round at **R² = 0.03** (i.e. noise, not sag). `trimContext` caps the prompt at 22 messages, so prompt-eval time plateaus (~1.0–1.2 s) after the rounds-1–4 context fill rather than growing. **No CPU offload** — GPU-resident across all 78 turns. Campaign length does **not** slow the DM.
- **localStorage:** `serializeSession` grows ~6,707 bytes/round (R² = 0.998) → 5 MB at **~745 rounds** (conservative, production-accurate message sizes). Chaos EX-1's independent model gives ~1,226 rounds; the gap is purely a per-message-size assumption (full unstripped text + JSON fence blocks vs. stripped prose). Either way: ~47–77× past the continuity ceiling.
- **Server memory:** `room.messages` grows ~6,705 bytes/round → ~9,638 rounds to a 65 MB threshold. **No leak** (CHAOS EX-2: action queue, lock maps, `applyPartyUpdate`, room GC, `lastDiceEvent` all bounded). The heap series even drops 4.9 MB at round 12 (V8 GC), so `room_messages_bytes` — not heap — is the clean linear proxy.

## Resilience (CHAOS, stubbed Ollama, isolated ports)

All three edge cases **PASS**:
- **Ollama timeout/error → recovery:** `dm:done{error:true}` broadcast, phase reset out of `awaiting-dm`, `turnSequence` not incremented, `dmBusy` cleared in `finally` — room accepts the next action immediately (no wedge).
- **Forged `verdict.roll` rejected:** a DM claiming `roll=17` against a recorded `d20→11` is caught and not applied; the matching positive control applies correctly.
- **`DM_BUSY` / `RATE_LIMITED` under burst:** correct rejection within `ACTION_MIN_INTERVAL_MS`; room stays consistent and recovers after the interval.

## Why continuity binds first

The whole study rests on one architectural fact: `trimContext` (`pinned=4, recent=18`) sends the model **at most 22 messages regardless of campaign length**. That bounds compute (flat throughput) and means storage — not the LLM — is what grows. But the same 18-message recent window is **shared across all 4 players**: a round is ~8 messages, so the window holds only ~2.25 rounds. Each player's own facts are evicted roughly **4× faster (by round) than in single-player**, and the only thing standing between an evicted fact and confabulation is the entity digest — which silently dropped the very anchors (`Garret`/`Forge`, `12 gold`) that this test introduced. The single-player baseline (`8192_fixed3`) never collapsed in 60 turns; four players collapse by round 20. Continuity binds first, and it binds *because* the design that makes the app fast (aggressive trimming) is shared, not per-player.

## Recommendations (prioritized; each cites the dimension it relieves)

1. **Per-player recent windows / scale `recent` with player count** *(continuity — largest gain).* Give each active player their own pinned recent slots, or set `recent ≈ 18 × playerCount` for N>1. Restoring ~9 rounds of per-player history (single-player parity) would push the continuity ceiling from ~16 toward ~50+ rounds.
2. **Fix `extractEntities` compound/possessive capture** *(continuity).* Split possessive and long spans so "Garret Ironhand's Forge of Embers" indexes as **"Garret Ironhand"** + **"Forge of Embers"** instead of being rejected at >4 words (`context.js:218`). This single change would have saved B1 + B2 — i.e. half the failed anchors.
3. **Add a structured fact-log for numeric/transactional facts** *(continuity).* `12 gold` has no digest path today. A small parallel "facts" block (prices, counts, dates) folded into the system prompt covers a class the entity digest structurally cannot.
4. **Enforce spotlight rotation / starvation guard** *(4-player experience).* The DM under-rotates badly even when prompted; a server-side fairness nudge (or surfacing "whose turn" and not letting one player hold `isActive` for >K turns) keeps all four players in the game. Without this, a 4-player session is effectively 1–2 players from round 2.
5. **Anchor the player roster against confabulation** *(continuity / immersion).* The party block (PC names) should be pinned as ground truth so the DM cannot rename Kael→"Aelis"; validate party-block names against the joined roster server-side.
6. **localStorage rotation/compaction at ~K turns** *(localStorage — low priority).* Only relevant near ~745 rounds; the existing `QuotaExceededError` trim-and-retry already covers the cliff. Defer until items 1–5 push continuity far enough that storage could matter.

## Artifacts

| File | Contents |
|------|----------|
| `4P-PROTOCOL.md` | Design spec (round model, MP-server contract, metrics, decision rule) |
| `harness-4p.mjs` | 4-client follow-the-spotlight WS harness (`--mode`, `--rounds`, `--manage-server`) |
| `stress-test-4p-4p_main.jsonl` / `-summary-…json` | Per-turn log + rollup (the shared authoritative artifacts) |
| `PERF-4P-ANALYSIS.md` | Throughput/resource scaling analysis |
| `QA-4P-CONTINUITY.md` | Continuity degradation analysis |
| `CHAOS-4P-EXPERIMENTS.md` + `chaos/*` | localStorage cliff, memory leak audit, resilience |
| `4p_main_run.log` | Full run console output |

*Note: `server/sync-server.mjs` carries a flag-gated (`STRESS_METRICS=1`) test-only instrumentation patch that forwards Ollama metrics / heap on broadcasts. It is additive and OFF by default — production broadcasts are byte-identical when the flag is unset (verified; 808 existing tests pass).*
