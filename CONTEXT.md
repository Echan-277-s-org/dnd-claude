# D&D Campaign Assistant — Context

## What was built

A React + Vite web app that acts as an AI-powered Dungeon Master for D&D campaigns.

**Location:** `C:\Users\Mask277\Desktop\Claude\dnd-claude\`

**Run:** `npm run dev` → opens at `http://localhost:5173`

## Current state

The app is fully functional using the Anthropic API directly from the browser (`anthropic-dangerous-direct-browser-access: true` header). It prompts the user to paste an API key into the UI on first launch, stored in `localStorage`.

**The user does NOT want this.** The API key UI should be replaced.

## Pending decision

The user wants to remove the API key requirement from the UI. Likely direction: **local LLM via Ollama** (user said "may be using a local LLM").

### Option A — Ollama backend (most likely)
- Add a small Express proxy server (or just call Ollama directly from the browser)
- Ollama runs locally at `http://localhost:11434`
- API endpoint: `POST http://localhost:11434/api/chat` (OpenAI-compatible: `/v1/chat/completions`)
- No key needed, completely free
- Good models for D&D narration: `llama3.1`, `mistral`, `gemma3`, `qwen2.5`
- The OpenAI-compatible endpoint supports streaming

### Option B — Backend proxy (.env file)
- Small Express server reads `ANTHROPIC_API_KEY` from `.env`
- Frontend calls `http://localhost:3001/api/chat` instead of Anthropic directly
- Key stays server-side, never in browser

## File structure

```
dnd-claude/
├── package.json
├── vite.config.js
├── index.html
└── src/
    ├── main.jsx
    ├── App.jsx           — state: apiKey, campaign; routes to Setup or Chat
    ├── App.css           — full dark fantasy theme (Cinzel + Crimson Pro fonts)
    └── components/
        ├── ApiKeySetup.jsx — setup screen (API key, model, campaign name/details)
        ├── Chat.jsx        — main chat; streaming fetch; dice rolls; messages
        └── DiceRoller.jsx  — d4/d6/d8/d10/d12/d20/d100 with crit/fumble highlight
```

## Key implementation notes

- **Streaming:** `Chat.jsx` reads SSE stream from Anthropic (`content_block_delta` events), updating the last message in state incrementally
- **Markdown:** Simple `parseMarkdown()` fn handles `**bold**`, `*italic*`, `` `code` ``, paragraphs — rendered via `dangerouslySetInnerHTML`
- **Dice:** Dice rolls are stored as `{ role: 'dice', die, result }` messages — filtered out before sending to the API
- **System prompt:** Built from campaign name + details, instructs DM behavior, formatting, and tone
- **Model:** Currently `claude-sonnet-4-6` default, `claude-opus-4-7` option — should be replaced with Ollama model name

## What needs to change for Ollama

1. **Remove `ApiKeySetup.jsx`** — no longer needed (or repurpose it as a model selector)
2. **Update `App.jsx`** — remove `apiKey` state, go straight to `Chat`
3. **Update `Chat.jsx` `sendMessage()`** — change fetch URL + headers to Ollama format:

```js
// Ollama OpenAI-compatible endpoint
const response = await fetch('http://localhost:11434/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'llama3.1',   // or whichever model is installed
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...apiMessages,
    ],
  }),
})

// Streaming format changes: look for `choices[0].delta.content` instead of content_block_delta
```

4. **Model selector** — let user pick from installed Ollama models (can fetch from `GET http://localhost:11434/api/tags`)

## Next session prompt

"Continue the D&D Campaign Assistant. Replace the API key setup with Ollama support. See CONTEXT.md in the project for full details."
