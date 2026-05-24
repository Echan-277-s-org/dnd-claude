# dnd-claude — D&D Campaign Assistant

## Commands

```powershell
npm install
npm run dev      # http://localhost:5173
npm run build
```

## Architecture

React 18 + Vite app. No routing library — `App.jsx` holds `campaign` state and conditionally renders `ApiKeySetup` or `Chat`.

| File | Role |
|------|------|
| `src/App.jsx` | Top-level state: `apiKey`, `campaign`; routes between setup and chat |
| `src/components/ApiKeySetup.jsx` | First-run screen: API key, model, campaign name/details |
| `src/components/Chat.jsx` | Streaming SSE fetch to Anthropic; dice roll messages; `parseMarkdown()` helper |
| `src/components/DiceRoller.jsx` | d4–d100; crit/fumble highlight |
| `src/App.css` | Dark fantasy theme (Cinzel + Crimson Pro fonts) |

**Streaming**: `Chat.jsx` reads `content_block_delta` SSE events from Anthropic and updates the last message in state incrementally.

**Dice messages**: stored as `{ role: 'dice', die, result }` — filtered out before sending to the API.

## Campaign notes

`campaigns/` holds saved campaign-notes Markdown files. The setup screen's **Load .md file** button reads one into `campaign.context`, which is injected into the system prompt as prior world state (see `buildSystemPrompt` in `src/lib/context.js`). Bold every NPC/location name (`**Name**`) so the continuity tracker (`extractEntities`) picks them up.

Example: `campaigns/jaycen-hawke-day2.md`.

## Pending work — Ollama migration

The API key UI (`ApiKeySetup.jsx`) needs to be replaced with Ollama (local LLM). See `CONTEXT.md` for the full migration plan. In short:

1. Remove `ApiKeySetup.jsx` (or repurpose as model selector)
2. Remove `apiKey` state from `App.jsx` — go straight to `Chat`
3. Change `Chat.jsx` fetch to `http://localhost:11434/v1/chat/completions` (OpenAI-compatible), parse `choices[0].delta.content` instead of `content_block_delta`
4. Optionally fetch available models from `GET http://localhost:11434/api/tags`

## Agent routing

| Task | Agent |
|------|-------|
| React / Vite features and optimization | `react-specialist` |
| Ollama / LLM integration complexity | `llm-architect` |
| Diagnosing a bug or error | `debugger` |
| Visual UI / component design | `ui-designer` |
| Writing or extending tests | `test-automator` |
| Security concerns | `security-auditor` |
| Claude API / Anthropic SDK integration | `claude-api` skill |
