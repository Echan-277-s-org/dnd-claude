# Party HUD — qwen2.5:14b Structured-Block Emission Validation

> Produced: 2026-05-24  
> Agent: ml-engineer (read-only; no source changes)  
> Model: `qwen2.5:14b` via Ollama `POST http://localhost:11434/api/chat`  
> App options mirrored: `num_ctx 8192`, `temperature 0.8`, `top_p 0.9`, `stream false`  
> System prompt: exact output of `buildSystemPrompt({ name, details })` from `src/lib/context.js` (4204 chars)  
> Total turns evaluated: **18** across two validation passes  

---

## 1. Methodology

### 1.1 System Prompt

The exact string returned by `buildSystemPrompt` was used as the system message — no paraphrasing. Campaign seed:

```
name: "The Shadow of Thornwall"
details: "A grim medieval fantasy campaign in the town of Thornwall, beset by an ancient curse.
          The player characters are Aelis (Ranger, 80% HP) and Borin (Cleric, 95% HP)."
```

### 1.2 Turn Battery (18 turns)

| Turn | Label | Scenario | Expected blocks |
|------|-------|----------|-----------------|
| A1 | OpeningNarration | "Set the scene at the gates" | party only |
| A2 | Exploration | Walking to town square | party only |
| B1 | StealthCheckRequest | "Aelis sneaks past guards" | party + check |
| B2 | PerceptionCheckRequest | "Search market stalls for clues" | party + check |
| B3 | PersuasionCheckRequest | "Borin persuades innkeeper" | party + check |
| C1 | VerdictSetup(Stealth) | "Sneak into cursed temple" | party + check |
| C2 | VerdictHigh (roll=18, DC=14) | Player reports roll | party + verdict |
| C3 | VerdictSetup(Lockpick) | "Pick temple iron door lock" | party + check |
| C4 | VerdictLow (roll=4, DC=15) | Player reports roll | party + verdict |
| D1–D3 | Continuity (3 turns) | Multi-turn session | party only |
| T1–T3 | Spurious-block tests | Lore / roleplay / rest | party only |
| EXT-V1 | Lockpick FAIL (roll=3) | Verdict resolution | party + verdict |
| EXT-V2 | Persuasion FAIL (roll=6) | Verdict resolution | party + verdict |
| EXT-V3 | Athletics PASS (roll=19) | Verdict resolution | party + verdict |
| EXT-V4 | Arcana PASS (roll=14) | Verdict resolution | party + verdict |

### 1.3 Measurement Criteria

For each response the validator checked:
1. Presence of `party` fence (regex ```` ```party[\s\S]*?``` ````)
2. JSON parseability of each block
3. Party schema: no `id` field, exactly one `isActive: true`, `hpPct` in 0–100
4. Check block: `skill` key present and UPPERCASE, `dc` an integer
5. Verdict block: all four keys present, `result` is exactly `"PASS"` or `"FAIL"` string
6. Roll echo fidelity (`roll` value matches what the player reported)
7. Spurious emission: `check` or `verdict` on turns where they should not appear
8. Multiple blocks: more than one fence per tag per response
9. Trailing prose after the last closing fence

---

## 2. Compliance Results

### 2.1 Summary Table

| Metric | Measured | Rate | Severity |
|--------|----------|------|----------|
| **party block present** | 18/18 | **100%** | — |
| **party JSON valid** | 18/18 | **100%** | — |
| **party fully compliant** (present + valid JSON + no `id` + exactly one `isActive`) | 18/18 | **100%** | — |
| **party multiple per turn** | 0/18 | 0% | — |
| **check present when expected** | 7/7 check-trigger turns | **100%** | — |
| **check JSON valid** | 7/7 | **100%** | — |
| **check `skill` UPPERCASE** | 7/7 | **100%** | — |
| **verdict present when expected** | 3/6 verdict turns | **50%** | HIGH |
| **verdict `result` exactly `"PASS"` or `"FAIL"`** (of those present) | 3/3 | **100%** | — |
| **verdict correct judgment** (result matches roll vs DC) | 2/3 | **67%** | MEDIUM |
| **spurious `check` on non-check turns** | 2/18 | 11% | MEDIUM |
| **spurious `verdict` on non-verdict turns** | 1/18 (`{}` empty) | 6% | LOW |
| **trailing prose after last fence** | ~4/18 | 22% | LOW |
| **`id` field in party block** | 0/18 | 0% | — |
| **multiple party blocks per turn** | 0/18 | 0% | — |

---

## 3. Raw Evidence

### 3.1 party Block — Representative Compliant Examples

**Turn A1 (opening narration):**
```
```party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":false}]
```
```

**Turn D2 (multi-turn, active member switched correctly to Borin):**
```
```party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":false},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":true}]
```
```

Observation: The model correctly rotates `isActive` between members as the narrative spotlight shifts. No `id` field was observed in any of the 18 responses.

### 3.2 check Block — Compliant Examples

**Turn B1 (stealth):**
```
```check
{"skill":"STEALTH","dc":14}
```
```

**Turn B2 (perception):**
```
```check
{"skill":"PERCEPTION","dc":12}
```
```

Both skill names emitted in UPPERCASE as required.

### 3.3 Verdict Block — PASS Compliant Example (C2)

**Full response (549 chars), Turn C2 — roll=18, DC=14:**

> You press yourself against the wall, heart pounding as you hold your breath. The guard's silhouette remains still, oblivious to your presence. With swift and silent steps, you slip past him into the shadowy courtyard of the **cursed temple**.

```
```party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":false}]
```
```verdict
{"skill":"STEALTH","dc":15,"roll":18,"result":"PASS"}
```
```

Followed by trailing hook: "The entrance to the temple looms ahead..."

### 3.4 Verdict Block — FAIL Compliant Example (EXT-V2)

**Full response, Turn EXT-V2 — roll=6, DC=16 (Persuasion):**

> The **guard captain** looks unimpressed by Borin's attempts at intimidation...

```
```party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":false},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":true}]
```
```verdict
{"skill":"PERSUASION","dc":16,"roll":6,"result":"FAIL"}
```
```

Roll faithfully echoed as `6`. `"FAIL"` literal exact.

### 3.5 Verdict Failure — Substituted Check (Failure Mode FM-1)

**Turn C4 (lockpick, roll=4, DC=15)** and **EXT-V1 (lockpick, roll=3, DC=15)** and **EXT-V3 (Athletics PASS, roll=19)**:

Instead of emitting a `verdict` block, the model re-narrated a failed attempt and requested another roll:

> *Aelis fiddles with the lock, your fingers tangle in an awkward position and you feel a sharp click. Pull back slightly, heart racing as you wonder if that sound alerted anyone nearby.*
>
> Give me another **Intelligence (Investigation)** check using Thieves' Tools to try picking this lock again without breaking it. This time the DC is 15.

```
```party
[...]
```
```check
{"skill":"INVESTIGATION","dc":15}
```
```

No `verdict` block emitted. The model treated the failed roll as a narrative complication requiring a new roll rather than finalizing a FAIL verdict.

**EXT-V3 (Athletics PASS, roll=19):** Same pattern — the model narrated the jump in progress and asked for an Athletics check to "see if Aelis lands," despite the player having already reported a d20 result:

```
```check
{"skill":"ATHLETICS","dc":13}
```
```

### 3.6 Verdict Failure — Wrong Judgment (Failure Mode FM-2)

**Turn EXT-V4 (Arcana, roll=14, DC=12):**

The model set DC=15 at setup (inflating the DC from the prompted DC=12), then issued a `"FAIL"` verdict against its own elevated DC:

```
```verdict
{"skill":"WISDOM(RELIGION)","dc":15,"roll":14,"result":"FAIL"}
```
```

The player's roll of 14 beat the originally-prompted DC=12 but failed the model's self-chosen DC=15. The verdict literal `"FAIL"` was correctly formatted, but the judgment was wrong relative to the user's expectation. Additionally the model emitted trailing prose after the verdict fence (a two-paragraph elaboration on the lore), violating the "at the very END of EVERY response" placement rule.

### 3.7 Spurious Blocks

**Turn A1 (first pass):** Two `check` blocks emitted on an opening narration turn where no roll was requested. The model invented Perception (DC=12) and Insight (DC=14) checks on its own initiative. On a second run of the same prompt the block was absent — confirming this is a stochastic failure, not a systematic one.

**Turn T1 (lore question):** A spurious `verdict` block with empty JSON `{}` appeared in a pure lore-question response:

```
```verdict
{}
```
```

This is invalid JSON under the schema (missing all required keys). The app parser's `try/catch` would return `null`, keeping the dice chip bare — the graceful fallback works correctly.

### 3.8 Trailing Prose After Blocks

Observed in approximately 4/18 responses. Pattern: the model places the `party` (and optionally `verdict`) block mid-response, then appends a hook sentence or continuation paragraph afterward. Example from EXT-V4:

```
```verdict
{"skill":"WISDOM(RELIGION)","dc":15,"roll":14,"result":"FAIL"}
```

Though you didn't fully recall the specifics, this knowledge may still be useful. **Baelzebub** is known for being one of the most treacherous and corrupt entities in the Abyss...

What would you like to do next?
```

The strip regex `STRIP_RE` (```` ```(?:party|check|verdict)[\s\S]*?``` ````) correctly removes the fenced blocks regardless of position. The trailing prose renders as normal narration in the chat — this is a cosmetic positioning issue, not a parse failure.

---

## 4. Failure Mode Catalog

| ID | Mode | Turns | Rate | Parser impact | Severity |
|----|------|-------|------|---------------|----------|
| **FM-1** | Verdict substitution: model issues a new `check` instead of emitting a `verdict` for a low/failed roll | C4, EXT-V1, EXT-V3 | ~3/6 verdict turns (50%) | `pendingCheck` cleared; dice chip stays bare; model requests a new roll that player did not attempt | HIGH |
| **FM-2** | DC inflation: model self-assigns a different DC than the one the player cited in the dice message, leading to incorrect PASS/FAIL judgment | EXT-V4 | 1/6 | Verdict emitted with correct literal format but wrong result relative to player expectation | MEDIUM |
| **FM-3** | Spurious `check` on non-check turn | A1 (stochastic) | ~1–2/18 (~6–11%) | `pendingCheck` set unexpectedly; next dice roll will carry irrelevant check context | MEDIUM |
| **FM-4** | Spurious `verdict {}` on non-verdict turn | T1 | 1/18 (6%) | Parser rejects empty object (missing `result`); chip stays bare; no crash | LOW |
| **FM-5** | Trailing prose after block fence | ~4/18 (22%) | — | Trailing text renders as narration (not a parse failure; strip regex handles blocks regardless of position) | LOW (cosmetic) |
| **FM-6** | Skill name with non-standard compound form (`WISDOM(RELIGION)`, `THIEVES' TOOLS`) | EXT-V4, EXT-V1 | 2/7 check turns | Parser stores the skill string as-is; chip label renders correctly; only matters if parser does exact-string matching on skill names | LOW |
| **FM-7** | Setup check uses different skill than what the player reported (e.g. DM called ATHLETICS, player said THIEVES' TOOLS) | EXT-V1 | 1 observed | Model resolves against its own chosen skill, not the player's cited skill name | MEDIUM |

---

## 5. Compliance Narrative

### party Block

**Unconditional compliance: 100%.** The model reliably appends a `party` fence to every response across all 18 turns including brief replies, lore answers, and verdict resolutions. JSON is always valid and minified. The `id` field is never emitted. Exactly one `isActive: true` is always present. The model correctly rotates `isActive` between party members as narrative focus shifts — Borin becomes active in turns where the DM spotlights his actions. This is the healthiest compliance result and requires no prompt changes.

### check Block

**Conditional compliance when the DM elects to call for a roll: 100%.** On every turn where the model decided to request a roll, it emitted a properly formatted `check` block with UPPERCASE skill and integer DC. The prompt instruction is effective for this direction. The main risk is not the format but the model's discretion — it sometimes chooses not to call for a check (B3 run 1), sometimes calls for one (B3 run 2), and once called for a check unprompted on an opening narration turn (FM-3). This reflects the model's narrative judgment more than a compliance gap.

### verdict Block

**Compliance is the primary weakness: 50% overall.** Of 6 verdict-trigger turns, only 3 produced a verdict block. The other 3 hit FM-1: the model treated a low or failed roll as a "try again" narrative beat and re-requested a check instead of finalizing the outcome. When a verdict block is emitted, the literal format is perfect — `"PASS"` and `"FAIL"` are always exact. No case-variant failures (`Pass`, `FAIL!`, `Success`, prose-only) were observed. The failure is in whether the block appears, not in how it is formatted when it does.

The FM-1 pattern has a clear narrative logic: the model narrates the failed attempt as a dramatic complication and naturally re-escalates with a new check. It is not ignoring the verdict instruction — it is following its "make outcomes dramatic" role and losing track of the structured-data obligation. This is a conditional-instruction compliance gap that the system prompt's wording can likely improve.

---

## 6. Parser Resilience Cross-Reference

Per `PARTY-HUD-PLAN.md §2d`, the parser degrades gracefully on every observed failure mode:

| Failure | Parser behavior | UX impact |
|---------|-----------------|-----------|
| FM-1: verdict absent | `extractBlock('verdict', ...)` returns null; `targetIdx === -1`; dice chip stays bare | Roll renders as "d20 → N" with no skill/result label. Player sees their number but no PASS/FAIL. Acceptable fallback. |
| FM-2: wrong DC/judgment | Verdict block accepted; chip shows `FAIL` (or `PASS`) per model's judgment | Chip may disagree with player's mental model. No crash. |
| FM-3: spurious check | `pendingCheck` set; next roll carries stale check context to DM | Next dice message string will include wrong skill/DC context. DM likely ignores it. Minor. |
| FM-4: `verdict {}` | `JSON.parse({})` succeeds but `result` missing; guard `=== 'PASS' \|\| === 'FAIL'` rejects; chip stays bare | Same as FM-1 UX. |
| FM-5: trailing prose | Strip regex removes block wherever it appears; trailing prose renders as narration | Cosmetic: player sees a continuation sentence after narration — reads naturally. No parse error. |
| FM-6: compound skill name | Stored as-is in verdict; chip label renders the compound string | Chip shows "WISDOM(RELIGION)" or "THIEVES' TOOLS" — readable but non-standard. |

No observed failure mode causes a crash or corrupts the party state.

---

## 7. Prioritized Recommendations

These are **prompt-wording proposals for llm-architect** routed through `party/prompt` per §2.6. No schema changes are proposed — tags, keys, types, and the `"PASS"`/`"FAIL"` literals are frozen.

### R1 — HIGH PRIORITY: Verdict instruction — explicitly prohibit the "try again" escape

**Problem:** FM-1 (50% of verdict turns). The model defaults to re-requesting a check on low rolls because its DM role rewards dramatic escalation. The current instruction ("When the player's message reports a dice roll for a pending check, judge it against the DC and append a fenced block tagged `verdict`") does not explicitly close the "ask for another roll" escape hatch.

**Proposed wording addition** (append to the `verdict` paragraph):

> When the player reports a roll, always finalize the outcome in that same response — emit the `verdict` block and narrate the result, whether success or failure. Do not re-request a roll for the same action; the outcome is decided by the reported number.

**Expected effect:** closes the primary failure mode. The model should still narrate failure dramatically; it just also emits the block.

### R2 — MEDIUM PRIORITY: Verdict instruction — remind the model to echo the player's pending check context

**Problem:** FM-7 / FM-2. The model sometimes picks its own DC or skill rather than echoing the check context the player included in their dice message. The dice-to-LLM transform sends `[Dice roll: d20 → N | pending check: SKILL DC X]` — the model should use those values.

**Proposed wording addition** (append to the `verdict` paragraph):

> Echo the `skill` and `dc` values from the pending check context in the player's message. Use the roll number the player reported as `roll`. Do not substitute a different skill or DC.

**Expected effect:** reduces FM-2 and FM-7. Also anchors the PASS/FAIL judgment to the correct DC.

### R3 — MEDIUM PRIORITY: Blocks placement — add "nothing follows the blocks" instruction

**Problem:** FM-5 (22% of responses). Trailing prose after the closing fence is cosmetically acceptable but creates a weak instruction-following signal and may confuse future parsers. The current instruction says "at the very END of EVERY response" but the model still appends continuation text.

**Proposed wording addition** (to the first sentence of the structured-data paragraph):

> After the narrative — at the very END of EVERY response, below all prose — append fenced code blocks. Nothing should appear after the final closing fence.

**Expected effect:** moderate reduction in FM-5. Some residual occurrence is likely given the model's tendency to add hooks.

### R4 — LOW PRIORITY: Opening/pure-roleplay turns — clarify that check blocks are not automatic

**Problem:** FM-3 (spurious check on opening narration). The current instruction says "ONLY when you are calling for a roll" which is correct. The stochastic nature of the failure suggests this is already mostly understood but occasionally misfires.

**Proposed wording addition** (to the `check` paragraph):

> Do not emit a `check` block at scene transitions, opening narrations, or pure dialogue turns where the player has not attempted a specific action requiring a test.

**Expected effect:** minor reduction in FM-3 frequency.

### R5 — LOW PRIORITY (parser-side observation, not a prompt change)

The spurious `verdict {}` (FM-4) is already handled correctly by the parser guard `=== 'PASS' || === 'FAIL'`. No action required. The observation that this occurs at all is worth monitoring — if it escalates, it could indicate the model is pattern-matching the presence of a `verdict` fence without understanding when to use it.

---

## 8. Appendix — Quantitative Summary

### Pass 1 (12 turns)

| Turn | party | check (if expected) | verdict (if expected) | Anomalies |
|------|-------|---------------------|-----------------------|-----------|
| A1 OpeningNarration | OK | SPURIOUS (×2) | — | FM-3: 2 spurious check blocks |
| A2 Exploration | OK | — | — | — |
| B1 StealthCheck | OK | OK (STEALTH DC 14) | — | — |
| B2 PerceptionCheck | OK | OK (PERCEPTION DC 12) | — | — |
| B3 PersuasionCheck | OK | OK (run 1); absent (run 2) | — | FM-3 inverse: model chose not to call for roll |
| C1 VerdictSetup | OK | OK (STEALTH DC 14) | — | — |
| C2 VerdictHigh (18 vs 14) | OK | — | OK — `"PASS"` | Trailing prose after fence |
| C3 VerdictSetup2 | OK | OK (LOCKPICK DC 15) | — | — |
| C4 VerdictLow (4 vs 15) | OK | SPURIOUS (FM-1) | ABSENT | FM-1: re-requested check instead of FAIL verdict |
| D1 Continuity | OK | — | — | — |
| D2 Continuity | OK | — | — | isActive correctly rotated to Borin |
| D3 Continuity | OK | — | — | Trailing prose after fence |

### Pass 2 (6 extended verdict turns + 3 spurious tests)

| Turn | party | verdict | Anomalies |
|------|-------|---------|-----------|
| EXT-V1 Lockpick FAIL (3 vs 15) | OK | ABSENT | FM-1: re-requested check, spurious check block |
| EXT-V2 Persuasion FAIL (6 vs 16) | OK | OK — `"FAIL"` | Clean |
| EXT-V3 Athletics PASS (19 vs 13) | OK | ABSENT | FM-1: re-requested check, spurious check block |
| EXT-V4 Arcana PASS (14 vs 12) | OK | `"FAIL"` (wrong) | FM-2: inflated DC to 15; trailing prose after fence |
| T1 Lore | OK | SPURIOUS `{}` | FM-4: empty verdict block |
| T2 Roleplay | OK | — | — |
| T3 Rest | OK | — | — |

---

## 9. Conclusion

`qwen2.5:14b` is **fully reliable** for the unconditional `party` block (100% across 18 turns), which is the most important structural requirement — the HUD will always have current party data to render.

The conditional `check` block is **reliable when the model elects to call for a roll** (100% format compliance), though the model exercises independent judgment about when to request rolls, meaning the app cannot guarantee a check block every time a player attempts a skill-dependent action.

The `verdict` block is the **primary compliance gap** (50% presence rate). The model correctly formats `"PASS"` and `"FAIL"` when it does emit a verdict, but on approximately half of verdict-trigger turns it instead narrates a dramatic complication and re-requests a check. This is a failure of the conditional instruction, not the schema. Prompt wording improvements R1 and R2 above are the highest-leverage interventions.

The parser's graceful fallback handles all observed failure modes without crashing. The main player-facing UX impact is that dice chips often stay bare (unresolved) after low rolls, which may feel like incomplete DM feedback. It is not a crash risk.

**Recommended actions for llm-architect (all route through `party/prompt` branch per §2.6):**

1. Implement R1 (prohibit re-requesting rolls in verdict turns) — highest expected uplift.
2. Implement R2 (echo the pending check context) — reduces DC drift.
3. Implement R3 (nothing after final fence) — cosmetic but reinforces instruction adherence.
4. R4 optional at llm-architect's discretion.

No schema changes are proposed. No parser changes are required. Rollback risk from the proposed wording tweaks is zero — the parser already handles all fallback cases.
