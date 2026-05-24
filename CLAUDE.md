# dnd-claude — D&D Campaign Assistant

## Commands

```powershell
npm install
npm run dev      # http://localhost:5173
npm run build
npm test -- --run   # Vitest (jsdom) — 203 tests
```

## Architecture

React 18 + Vite app. No routing library — `App.jsx` holds `campaign`, `character`, and
`party` state and conditionally renders the setup screen or `Chat`. The active **genre drives
the visual theme**: `App.jsx` writes `<html data-theme>` from `THEME_FOR_GENRE`
(`dnd → dnd`, `starwars → void`); there is no independent theme toggle.

| File | Role |
|------|------|
| `src/App.jsx` | Top-level state: `campaign`, `character`, `party`; routes between setup and chat; sets `<html data-theme>` from genre |
| `src/components/ApiKeySetup.jsx` | Imported as `CampaignSetup` — first-run screen: genre, campaign name/details, Ollama model, optional notes `.md`. **No API key** despite the filename |
| `src/components/Chat.jsx` | Streaming fetch to local Ollama; message rendering; structured-block parser; `parseMarkdown()` (with drop-cap hook) |
| `src/components/DiceRoller.jsx` | d4–d100 roller; emits `{ die, result }` |
| `src/components/DiceChip.jsx` | Renders a dice message — bare (`die → result`) upgrades to resolved (skill-check + `PASS`/`FAIL` verdict) |
| `src/components/PartyStrip.jsx` | Mobile 3-cell party strip (display-only; LLM-managed) |
| `src/components/CharacterPanel.jsx` | Player's editable character sheet (HP, stats, conditions); persisted to `dnd_character`. Decoupled from the LLM `party` |
| `src/components/HistoryPanel.jsx` | Session entities + action log + desktop party sub-section |
| `src/lib/genres.js` | `GENRES` registry + `getGenre(id)`; each genre has display props (`emblem`, `gmName`, …) + an `engine` |
| `src/lib/context.js` | **dnd** genre engine: `buildSystemPrompt`, `extractEntities`, `trimContext` |
| `src/lib/context.starwars.js` | **starwars** genre engine (same interface; block-emission text identical to `context.js`) |
| `src/App.css` | `:root` design tokens + `[data-theme="dnd"]` (Candle-lit Grimoire) / `[data-theme="void"]` (Crimson Void) theme blocks |

**Backend — local Ollama.** `Chat.jsx` POSTs to `http://<host>:11434/api/chat` with `stream: true`
and reads newline-delimited JSON, accumulating `event.message.content` deltas into the last
message. Default model `qwen2.5:14b` (from `campaign.model`). No cloud API / no API key.

**Dice messages**: `{ role: 'dice', die, result, check?, verdict? }`. Bare on roll; `check`/`verdict`
are added later by the structured-block parser. Transformed to text (`[Dice roll: d20 → 17 …]`)
before sending to the LLM.

## Structured-block protocol (LLM-managed game state)

The AI DM is instructed (in `buildSystemPrompt`, both genre engines) to append fenced JSON blocks
at the end of each response; `Chat.jsx` strips them from the displayed text and parses them:

- ` ```party ` — array of `{ name, role, hpPct, isActive }` (no `id`; the app assigns/preserves ids by
  name-match). The **DM owns the party**; the app renders it (PartyStrip on mobile, header turn-pill +
  status dot on desktop, HistoryPanel section). Persisted to `dnd_party`; migrated from `dnd_character`
  on first boot via `loadParty()`.
- ` ```check ` — `{ skill, dc }` → stored as session-only `pendingCheck`, folded into the next roll's context.
- ` ```verdict ` — `{ skill, dc, roll, result: "PASS"|"FAIL" }` → upgrades the most-recent unresolved
  dice message into a resolved `DiceChip`.

Parser is defensive: malformed/missing/partial-stream blocks → keep last-known state, no throw.
Full spec + rationale: `PARTY-HUD-PLAN.md` (and `PARTY-HUD-QWEN-VALIDATION.md` for model compliance).

## Campaign notes

`campaigns/` holds saved campaign-notes Markdown files. The setup screen's **Load .md file** button
reads one into `campaign.context`, injected into the system prompt as prior world state (see
`buildSystemPrompt`). Bold every NPC/location name (`**Name**`) so the continuity tracker
(`extractEntities`) picks them up. Example: `campaigns/jaycen-hawke-day2.md`.

> Historical note: `CONTEXT.md` documents the (now-complete) Anthropic→Ollama migration. The app
> already runs on local Ollama; that doc is kept for reference only.

## Agent routing

| Task | Agent |
|------|-------|
| React / Vite features and optimization | `react-specialist` |
| Ollama / LLM prompt + integration complexity | `llm-architect` |
| Local-model behavior / compliance validation | `ml-engineer` |
| Diagnosing a bug or error | `debugger` |
| Visual UI / component design | `ui-designer` |
| Translating a design spec into UI code | `design-bridge` |
| Writing or extending tests | `test-automator` |
| QA strategy / test planning | `qa-expert` |
| Security concerns | `security-auditor` |
| Claude API / Anthropic SDK integration | `claude-api` skill |
