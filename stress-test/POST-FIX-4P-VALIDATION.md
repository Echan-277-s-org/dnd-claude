# POST-FIX 4-PLAYER ENDURANCE VALIDATION

*Run date: 2026-05-26. Branch: `test/4-player-endurance-stress`.*

---

## Overview

Full validation of the 5-fix continuity remediation against the
`test/4-player-endurance-stress` branch. All Wave-3 gates applied per §6
of `CONTINUITY-FIX-PLAN.md`.

---

## Build

`npm run build` — SUCCESS (507ms, Vite 5.4.21, no errors, 3 output assets).

---

## Test suite

`npm test -- --run` — **869 passed / 2 skipped / 871 total, 0 failures**.
Matches pre-fix baseline exactly.  22 test files, 37s.

---

## §6 Global-gate checklist

| Gate | Result | Evidence |
|------|--------|----------|
| `npm run build` succeeds | PASS | 507ms, zero errors |
| Vitest ≥ 869 passed, 0 failures | PASS | 869 / 2 / 871 — matches baseline |
| STRESS_METRICS byte-identity | PASS | See below |
| Single-player invariance (N=1) | PASS | See below |
| Engine parity (context.js vs context.starwars.js) | PASS | See below |
| Block discipline / backward-compat | PASS | See below |
| Server-broadcast contract intact | PASS | See below |
| Stress harness: continuity ceiling moved | PASS | See below |

### STRESS_METRICS byte-identity

`sync-server.mjs` lines 1199–1228 / 1060–1085: every extra field in
`dm:done` and `session:update` that STRESS_METRICS adds is behind
`...(process.env.STRESS_METRICS === '1' ? { … } : {})` spreads.
When the env var is unset the spread resolves to `{}` — no new keys, no
behavior change.  The `DM_BLOCK_TAGS` set (line 61) adds `'facts'` but that
is server-side parse vocabulary only; it is stripped from broadcast
`content` before `dm:done.payload.fullText` and `session:update.payload.messages`
are assembled, so the broadcast payload shape for clients is unchanged.
Confirmed by the existing integration suite (Phase 2 broadcast tests all pass).

### Single-player invariance (N=1)

`trimContext` (context.js line 400–409): scaling is gated `playerCount > 1` —
when `playerCount` is 1 or omitted, `scaledRecent = recent = 18` with no
branch taken. The short-circuit and slice-concatenation are identical to the
pre-change function.

`Chat.jsx` line 507–510: `playerCount = roomCode ? max(1, party?.length||...) : 1`.
When there is no `?room=` param, `roomCode` is null and `playerCount` resolves
to 1 — N=1 invariant holds automatically.

Facts digest (Chat.jsx line 528–531, sync-server.mjs line 944–948):
injection is guarded `factsLine ? ... : systemPrompt` / `factsLine ?
... : systemContent`. When `sessionFacts`/`room.facts` is empty the ternary
short-circuits to the unchanged prompt string — byte-identical to today.

`applySpotlightFairness` / `anchorJoinedPCNames` (sync-server.mjs lines
1163, 1172): both guard on `room.characters` being non-empty / roster size.
N=1 single-player rooms have no `room.characters` entries and
`isMaximallyStarved` returns false for N=1 — both are no-ops.

Unit tests cover N=1 explicitly:
- `trimContext playerCount scaling` — "N=1 byte-identical" and "N=1 short-circuit" (PASS)
- `Fix #4 — N=1: applySpotlightFairness is a no-op` (PASS)
- `Fix #4 — N=1: isMaximallyStarved always returns false` (PASS)

### Engine parity (extractEntities)

`context.starwars.js` line 12: `export { trimContext } from './context.js'` —
trimContext is a direct re-export, not a fork. The parity test
"starwars trimContext === dnd trimContext for identical inputs"
(context.test.js line 144–152) asserts `trimContextSW === trimContext`
(same reference) and equality for N=1..5, and PASSES.

`extractEntities` is a fork. The parity test at context.test.js line 323
"engine parity: context.js and context.starwars.js extract identical sets
for the Garret span" PASSES. Full possessive-split logic is mirrored in
`context.starwars.js` (~lines 240+): same `add()`/`index()` structure,
same possessive regex `^(.+?)['']s\s+(.+)$`, same recursion.

### Block discipline / backward-compat

`BLOCK_TAGS` in Chat.jsx (line 20) and `DM_BLOCK_TAGS` in sync-server.mjs
(line 61) now include `'facts'`. The parser is defensive: malformed/absent
`facts` blocks are handled by the `extractBlock` function which returns null
on parse error or missing block, causing the `if (Array.isArray(...))` guard
to skip the merge — last-known facts state is preserved, no throw.

v1/v2/v3 session deserialization: `deserializeSession` tests at
`src/lib/session.test.js` lines 354–418 — v1, v2, v3 all PASS.
`fromMarkdown` round-trip tests PASS.

### Server-broadcast contract intact

WS message types and `{ type, roomCode, payload }` wire shape are
unchanged. All Phase 2 integration tests and the `L2 — verdict forgery`
suite (sync-server.multiplayer.test.mjs line 2755+) PASS. The forged-verdict
rejection (EX-3b: server clears `lastDiceEvent` after each verdict; a
subsequent stale verdict is treated as forged and discarded) confirmed by
tests at lines 2784, 2868, 2917.  No room wedge scenarios observed.

---

## Stress harness results

**Ollama reachable:** yes — `qwen2.5:14b` on `http://localhost:11434`.

**Run:** `harness-4p.mjs --mode=full --rounds=28 --run_id=4p_postfix --manage-server`

**Artifacts:**
- `stress-test/stress-test-4p-4p_postfix.jsonl`
- `stress-test/stress-test-summary-4p-4p_postfix.json`

### Key before/after comparison

| Metric | Baseline (4p_main, pre-fix) | Post-fix (4p_postfix) |
|--------|-----------------------------|-----------------------|
| Stop reason | B_COLLAPSE (round 20) | completed |
| Total rounds | 20 | 28 (max reached) |
| rounds_to_B_collapse | **16** | **null (no collapse)** |
| Limiting factor | R_continuity | R_localstorage (502 rounds) |
| Headline rounds | 16 | **502** |
| Category-A accuracy | 1.00 | 1.00 |
| Category-B accuracy | 0.40 | 0.50 |
| Category-C accuracy | 0.80 | **1.00** |
| Bron max starvation gap | **50** | **12** |
| Kael max starvation gap | 28 | **9** |
| Sora max starvation gap | 44 | **9** |
| Spotlight distribution | Kael=18 Lyra=37 Bron=7 Sora=16 | Kael=27 Lyra=28 Bron=28 Sora=29 |
| Party shrink events (PC renames) | 1 (Kael→"Aelis" at R13) | **0** |

### Probe-level detail

| Probe | Round | Score | Key passing | Key failing |
|-------|-------|-------|-------------|-------------|
| P1 | 4 | 5/6 | A1,B1,B5,B8,C1 | B2 |
| P2 | 8 | 5/6 | A1,B1,B5,B8,C2 | B2 |
| P3 | 12 | 5/6 | A1,B1,B5,B8,C3 | B2 |
| P4 | 16 | 2/6 | A1,C4 | B1,B2,B5,B8 |
| P5 | 20 | 3/6 | A1,B1,C5 | B2,B5,B8 |
| P6 | 24 | 4/6 | A1,B1,B2,C6 | B5,B8 |
| P7 | 28 | 4/6 | A1,B1,B2,C7 | B5,B8 |

**B1 (Garret):** Recovered by P5/P6/P7 (rounds 20–28) — baseline collapsed at P2 (round 8).
**B2 (Forge of Embers):** Recovered by P6/P7 (rounds 24–28) — was never recovered in baseline.
**B5 (12 gold):** Inconsistent recovery; passing early (P1–P3) then lost after round 16.
  This is partial improvement: the facts digest carried the anchor but the DM omits it after
  a long gap. Full 12-gold stabilization would require additional prompt-tuning work.
**B8 (Ash Covenant):** Similarly lost after round 16. The entity digest mechanism works for
  high-frequency anchors but the Ash Covenant is a low-mention entity that fades after the
  recent window evicts it.

### Continuity ceiling assessment

The pre-fix run stopped at round 20 with B_COLLAPSE declared at round 16 and
`rounds_to_B_collapse=16`. The post-fix run completed all 28 rounds with
`rounds_to_B_collapse=null` (no collapse trigger fired). The limiting factor
shifted from `R_continuity` to `R_localstorage` (502 rounds).

The run demonstrates:
1. **No B_COLLAPSE**: the harness ran 28 rounds without hitting the B-recall
   threshold that ended the baseline run. Continuity ceiling measurably moved.
2. **No PC rename events**: zero `party_shrink_events` vs one Kael→"Aelis"
   rename in the baseline (Fix #5, roster anchor, confirmed working).
3. **Starvation gap < 50**: max gap is 12 (Lyra/Bron) vs 50 (Bron) in baseline.
   Fix #4 (spotlight fairness) confirmed working.
4. **Balanced spotlight**: 27/28/28/29 distribution vs 18/37/7/16 in baseline.
5. **Partial B-anchor recovery**: B1+B2 now recover at rounds 24–28 (never
   recovered in baseline); B5/B8 show partial regression after round 16.
   The fixes moved the ceiling but did not achieve sustained B=1.00 — this
   is expected given the inherent limitations of a fixed 42-message window
   for a 28-round / 112-turn session.

**Verdict: the continuity ceiling moved. Per §6, the harness gate is PASS.**

---

## Overall verdict

**GREEN — clear to push + open PR.**

All §6 gates PASS. Build clean, test suite green (869/2/871), all code-level
invariants verified, stress harness ran 28 rounds without B_COLLAPSE (vs
baseline collapse at round 16), PC rename events eliminated, starvation gap
reduced from 50 to 12.
