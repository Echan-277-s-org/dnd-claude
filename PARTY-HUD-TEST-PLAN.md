# Party HUD — Cross-Phase Test Strategy

**Prepared by:** qa-expert · **Executor:** test-automator
**Working dir:** `H:\Claude\dnd-claude` · **Runner:** Vitest 4.1.7 + Testing Library, jsdom
**Baseline:** 108 tests passing across 5 files (confirmed 2026-05-24)

> Binding spec: `PARTY-HUD-PLAN.md` · Frozen schema: `PARTY-HUD-COORDINATION.md` §2.

## 1. Baseline audit

| File | Tests | Focus |
|------|-------|-------|
| `src/App.test.jsx` | 10 | Routing, localStorage setup/reset, corrupt-JSON fallback |
| `src/components/Chat.test.jsx` | 48 | `parseMarkdown`, `getActionSuggestions` (pure shims) |
| `src/components/CharacterPanel.test.jsx` | 28 | Render, modifiers, HP math, inline edit, conditions, persistence |
| `src/components/HistoryPanel.test.jsx` | 14 | Entity chips, session log, open/close |
| `src/lib/context.test.js` | 8 | `trimContext`, `extractEntities`, `buildSystemPrompt` |

**Dice-shape impact:** the additive `{die, result, check?, verdict?}` change breaks **zero** existing tests (no existing test renders the dice branch or asserts the old shape exhaustively). Regression list for shape-break = empty; updates needed are for new props/sections only (§4).

## 2. jsdom constraints (structural assertions only)

`color-mix()`, `clip-path`, `box-shadow`, computed CSS custom properties, and `@media` queries do **not** evaluate in jsdom. Never assert rendered colors or responsive `display`. Use: class presence/absence, element counts, text content, inline `style.width`, role/aria queries. Both-theme color + responsive layout are validated at the live dev-server gates, not in tests.

## 3. Test matrix

Priority: **P1** (must pass before its wave gate) · **P2** (required for G-BCD/G-TEST) · **P3** (coverage, non-blocking).

### Phase A — Parser units → `src/lib/parser.test.js` (highest priority)
Test `stripStructuredBlocks` / `extractBlock` / `applyPartyUpdate` / verdict-upgrade. If react-specialist exported these from a module, import directly; else mirror them as shims (Chat.test.jsx convention).

| ID | Description | Key assertion |
|----|-------------|---------------|
| PA-01..03 | strip removes complete `party`/`check`/`verdict` fence | fence absent, narrative preserved |
| PA-04 | strip removes all three in one response | all absent, prose verbatim |
| PA-05 | strip does NOT strip an **unclosed** fence mid-stream | output == input unchanged |
| PA-06 | strip leaves non-party code fences (` ```js `) untouched | preserved verbatim |
| PA-07..09 | `extractBlock` parses valid party/check/verdict JSON | returns expected JS object/array |
| PA-10 | malformed JSON → `null`, no throw | |
| PA-11 | tag absent → `null` | |
| PA-12 | unclosed fence → `null` | |
| PA-13 | trailing whitespace in JSON body still parses | P2 |
| PA-14 | `applyPartyUpdate` preserves id for name-matched member | id stable |
| PA-15 | new member gets a UUID | non-empty id |
| PA-16 | name-match is case-insensitive | same id for `Aelis`/`aelis` |
| PA-17/18 | `hpPct` clamped to 0 / 100 | |
| PA-19 | `hpPct` NaN/bad → 0 | |
| PA-20 | `hpPct` rounded to integer (73.6→74) | P2 |
| PA-21 | `isActive` coerced via Boolean (`'true'`→true, `0`→false) | |
| PA-22 | missing `name` → `'Unknown'` | |
| PA-23 | missing `role` → `''` | P2 |
| PA-24 | unknown keys ignored (forward-safe) | P2 |
| PA-25 | verdict-upgrade targets MOST-RECENT dice msg lacking verdict | only that index changes |
| PA-26 | verdict-upgrade leaves resolved dice msgs untouched | no overwrite |
| PA-27/28 | PASS/FAIL sets `verdict` + populates `check` from `verdictRaw.skill` | |
| PA-29 | invalid `result` (e.g. lowercase `pass`) → NO upgrade | messages unchanged |
| PA-30/31 | no unresolved dice msg / empty list → no-op, no throw | |
| PA-32 | zero-member array rejected before `applyPartyUpdate` | party unchanged |

### Phase A — State/migration → `src/lib/loadParty.test.js`
Mock localStorage with the App.test.jsx IIFE pattern.

| ID | Description | Key assertion |
|----|-------------|---------------|
| PM-01 | `loadParty()` returns valid `dnd_party` verbatim | |
| PM-02 | falls back to `dnd_character` when `dnd_party` absent | seeds `party[0]` (name/charClass→role, hp→hpPct, isActive:true) |
| PM-03 | `hpPct = round(hpCurrent/hpMax*100)` | 10/20→50, 0/20→0 |
| PM-04 | `hpMax===0` → `hpPct:100` (division guard) | |
| PM-05 | both keys absent → `DEFAULT_PARTY` | |
| PM-06/07 | corrupt `dnd_party` / `dnd_character` JSON → DEFAULT_PARTY, no throw | |
| PM-08 | `dnd_character` NOT modified/deleted by `loadParty()` | unchanged after call |
| PM-09 | after `applyPartyUpdate`, `dnd_party` written; `dnd_character` unchanged | |
| PM-10 | `pendingCheck` session-only (no `dnd_pendingCheck` key ever) | P2 |

### Phase A0 — Prompt → update `src/lib/context.test.js`
Import `buildSystemPrompt` from BOTH `./context` and `./context.starwars` (aliased). Existing 5 assertions use `toContain` → unaffected.

| ID | Description | Key assertion |
|----|-------------|---------------|
| PP-01 | dnd prompt includes party instruction | contains `party` + `hpPct` |
| PP-02 | dnd prompt includes check instruction | contains `check` + `dc` |
| PP-03 | dnd prompt includes verdict instruction | contains `verdict` + `PASS` + `FAIL` |
| PP-04 | starwars prompt includes same three | inclusion checks pass |
| PP-05 | party-block instruction text byte-identical across engines | extracted substrings strictly equal |
| PP-06 | check/verdict instruction text byte-identical across engines | strictly equal |
| PP-07 | `buildSystemPrompt(undefined)` still does not throw | regression check |

### Phase B — `src/components/PartyStrip.test.jsx` (new)
PB-01 one cell per member · PB-02 names · PB-03 roles · PB-04 active cell has `--active` · PB-05 exactly one `--active` · PB-06 active role has `· turn` suffix · PB-07 inactive lacks `turn` · PB-08 HP fill `style.width` == `hpPct%` · PB-09/10 0%/100% · PB-11 puck = first letter upper · PB-12 empty name → `?` · PB-13 empty party → 0 cells, no crash · PB-14 single member · PB-15 display-only (no `onSetActive`, click no-op) · PB-16 stable keys, no console key warning (P3).

### Phase B — HistoryPanel party section → update `src/components/HistoryPanel.test.jsx`
PH-01 `Party` header when party provided · PH-02 names · PH-03 roles · PH-04 HP fill width · **PH-05 (P1) all 14 existing tests pass when `party` undefined** (backward-compat) · PH-06 empty party → no member rows.
Update `renderPanel` helper to accept+pass optional `party` (default undefined).

### Phase C — Header pill/dot → update `src/App.test.jsx`
PC-01 `.header-status-dot` present when party populated · PC-02 `.turn-pill` present · PC-03 pill text = `isActive` member name · PC-04 falls back to `party[0].name` when none active · **PC-05 (P1) existing 10 App tests pass.** Use a distinct mock party name (e.g. `Zara`) to avoid `getByText` collisions with campaign-name fixtures (`Test Keep`, `Ironhold`). Keep the existing fetch-reject mock.

### Phase D — `src/components/DiceChip.test.jsx` (new)
PD-01/02 bare shows die + result · PD-03/04 bare shows no check/verdict · PD-05 resolved shows check label · PD-06 result number · PD-07/08 FAIL/PASS apply `--fail`/`--pass` class · PD-09/10 verdict text `PASS`/`FAIL` · PD-11 no-crash with only die+result · PD-12/13 crit(20)/fumble(1) classes · PD-14 root `.dice-chip`.

### Phase D — pendingCheck transform → add to `src/lib/parser.test.js`
PD-15 with pendingCheck → `[Dice roll: d20 → 17 | pending check: STEALTH DC 15]` · PD-16 null pendingCheck → `[Dice roll: d20 → 17]` · PD-17 skill uppercased in transform (P2).

## 4. Regression update list
- **`context.test.js`** — no existing assertion changes (all `toContain`). Add second import alias for `context.starwars.js`. Add PP-01..07.
- **`HistoryPanel.test.jsx`** — update `renderPanel` signature to accept optional `party`; all 14 existing pass unchanged (PH-05 enforces).
- **`App.test.jsx`** — no existing changes; add PC-01..05 in a new describe; keep fetch-reject mock; seed party via `localStorageMock._set('dnd_party', …)` before render. Also add: clicking **New Session** resets `party` to seed (OQ-10).
- **`Chat.test.jsx`, `CharacterPanel.test.jsx`** — zero changes.

## 5. New files & totals
New: `parser.test.js` (~25), `loadParty.test.js` (10), `PartyStrip.test.jsx` (16), `DiceChip.test.jsx` (14).
Updates add: context.test.js (+6), HistoryPanel (+6), App (+5). **~82 new → suite ~190.**

## 6. Coverage gaps / risks
- **Streaming `finally` wiring** not unit-testable in jsdom → parser logic tested as pure units (this plan); wiring validated at the live `npm run dev` gate (G-INT-A). Low risk (3 lines/block).
- **`pendingCheck` cleared-on-send** — mock fetch to reject and assert cleared before fetch, or expose `clearPendingCheck`.
- **Multiple `isActive:true`** — accepted behavior (next LLM turn corrects); optional P3: assert PartyStrip renders 2 `--active` without crash.
- **OUT OF SCOPE — qwen2.5 compliance** (fence presence/JSON validity/check-verdict emission/`PASS|FAIL` literal fidelity): owned by ml-engineer's live-Ollama G-QWEN gate, NOT unit tests. PA-10/11/29 are the boundary — they prove the parser degrades gracefully when the model misbehaves.
- **Responsive / color** — validated at dev-server + G-FINAL, never via `getComputedStyle`.

## 7. Conventions (match existing suite)
- `import { describe, it, expect, vi, beforeEach } from 'vitest'`; Testing Library `render, screen, fireEvent`.
- localStorage: replicate App.test.jsx `localStorageMock` IIFE; `clear()` + `vi.clearAllMocks()` in `beforeEach`; seed via `_set` (bypasses spy).
- Private Chat.jsx functions: import if exported, else mirror verbatim with `// mirror of source` (Chat.test.jsx convention).
- Prompts: `toContain` only, never full-string equality.
- App.test.jsx: keep fetch-reject mock; don't remove.
- Class assertions: `container.querySelector('.x')` + `toBeInTheDocument()`.
- PB-16: `vi.spyOn(console,'error')` + `afterEach(vi.restoreAllMocks)`.

## 8. Execution order (matches wave gates)
1. PP-01..07 → `context.test.js` (G-A0, before Merge 1)
2. PM + PA → `loadParty.test.js`, `parser.test.js` (G-A)
3. PB + PH → `PartyStrip.test.jsx`, `HistoryPanel.test.jsx` (Phase B)
4. PC → `App.test.jsx` (Phase C)
5. PD → `DiceChip.test.jsx`, parser.test.js additions (Phase D)
6. Full `npm test -- --run` → G-TEST (~190 green)

Run `npm test -- --run` after each step; full suite green before advancing.
