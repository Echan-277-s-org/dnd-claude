# D&D Campaign Assistant

A local-first AI Dungeon Master (and Star Wars Game Master) powered by a locally running **Ollama** instance. No cloud API, no API key, no data leaving your machine.

![Setup screen](docs/screenshots/setup-screen.png)

---

## Features

- **Two genre-driven themes** — Dungeons & Dragons 5e ("Candle-lit Grimoire" dark theme) and Star Wars Saga Edition ("Crimson Void" dark theme). Genre selection drives both the visual theme and the system prompt engine; there is no independent theme toggle.
- **Streaming Ollama chat** — messages stream token-by-token from `http://localhost:11434/api/chat`. Default model: `qwen2.5:14b`.
- **LLM-managed party HUD** — the AI DM appends fenced ` ```party ` JSON blocks to each response; the app parses them and renders the live party roster in the header turn-pill (desktop), the mobile PartyStrip, and the Campaign History panel.
- **Dice roller + skill-check verdicts** — roll d4 through d100 in-chat. The DM emits ` ```check ` (skill + DC) and ` ```verdict ` (PASS/FAIL) structured blocks; these upgrade bare dice messages into resolved DiceChip components.
- **Session persistence (localStorage)** — the full session (messages, party, campaign) is saved to `localStorage` on every settled turn with a `QuotaExceededError` trim-and-retry.
- **Markdown save/continue** — download a self-contained, LLM-loadable `.md` handoff from the header button; load it on any device via the setup screen's "Load .md file" button to resume play in full.
- **LAN cross-device sync** — an Express sync server (`server/sync-server.mjs`) stores sessions as `.md` files and serves them over your local network. The app auto-derives the desktop host from `window.location.hostname`, so opening `http://<desktop-IP>:5173` on a phone targets the desktop's Ollama and sync server automatically.

---

## Screenshots

| D&D play screen | Resolved dice chip |
|---|---|
| ![D&D chat](docs/screenshots/chat-dnd.png) | ![Dice chip resolved](docs/screenshots/dice-chip-resolved.png) |

| Campaign History panel (desktop) | Mobile party strip |
|---|---|
| ![Party HUD desktop](docs/screenshots/party-hud.png) | ![Party HUD mobile](docs/screenshots/party-hud-mobile.png) |

**Star Wars "Crimson Void" theme**

![Void theme](docs/screenshots/void-theme.png)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** | v18 or later recommended |
| **Ollama** | Running locally at `http://localhost:11434` |
| **Model** | `qwen2.5:14b` pulled in Ollama (`ollama pull qwen2.5:14b`) |

Ports used:

| Port | Service |
|---|---|
| `5173` | Vite dev server |
| `3001` | LAN sync server |
| `11434` | Ollama |

---

## Quick Start

```powershell
# 1. Install dependencies
npm install

# 2. Start Vite dev server + LAN sync server together
npm run dev

# Open http://localhost:5173 in your browser
```

---

## Available Scripts

All scripts are defined in `package.json`.

| Script | Command | Description |
|---|---|---|
| `dev` | `concurrently -n vite,sync -c cyan,magenta "vite" "node server/sync-server.mjs"` | Vite + sync server together (recommended) |
| `dev:vite` | `vite` | Vite only — no sync server |
| `sync` | `node server/sync-server.mjs` | Sync server only |
| `build` | `vite build` | Production build |
| `preview` | `vite preview` | Preview the production build locally |
| `test` | `vitest run` | Run the full test suite once (274 tests, jsdom + Node) |
| `test:watch` | `vitest` | Run tests in watch mode |

---

## Cross-Device / LAN Play

To reach the app and Ollama from a phone (or any device) on the same LAN:

1. Serve Ollama on all interfaces before starting it:

   ```powershell
   $env:OLLAMA_HOST = "0.0.0.0"
   ollama serve
   ```

2. Allow ports **5173**, **3001**, and **11434** through the Windows Firewall.

3. Run `npm run dev` on the desktop.

4. Open `http://<desktop-IP>:5173` on the phone. The app derives the Ollama and sync server host from `window.location.hostname` automatically — no config needed on the phone.

---

## Project Structure

| Path | Role |
|---|---|
| `src/App.jsx` | Top-level state: `campaign`, `character`, `party`; routes between setup and chat; sets `<html data-theme>` from genre |
| `src/components/ApiKeySetup.jsx` | Imported as `CampaignSetup` — first-run screen: genre, campaign name/details, Ollama model, optional notes `.md` |
| `src/components/Chat.jsx` | Streaming fetch to Ollama; message rendering; structured-block parser; `parseMarkdown()`; session hydration/persistence; Markdown save button |
| `src/lib/session.js` | One serialize layer, three surfaces: `serializeSession`/`deserializeSession`, `toMarkdown`/`fromMarkdown`, and the sync API (`loadSyncSession`/`saveSyncSession`/`pollSyncSession`) |
| `src/hooks/useSessionPersistence.js` | LAN sync client: server-authoritative on mount, per-turn push, 30 s poll; degrades silently when the sync server is unreachable |
| `server/sync-server.mjs` | Express LAN sync server — `GET`/`PUT`/`DELETE /session/:id`, `GET /sessions`; atomic writes, per-session lock, server-stamped `savedAt` |
| `src/components/DiceRoller.jsx` | d4–d100 roller; emits `{ die, result }` |
| `src/components/DiceChip.jsx` | Renders a dice message — bare (`die → result`) or resolved (skill-check + PASS/FAIL verdict) |
| `src/components/PartyStrip.jsx` | Mobile 3-cell party strip (display-only; LLM-managed) |
| `src/components/CharacterPanel.jsx` | Player's editable character sheet (HP, stats, conditions); persisted to `dnd_character` |
| `src/components/HistoryPanel.jsx` | Session entities, action log, and desktop party sub-section |
| `src/lib/genres.js` | `GENRES` registry + `getGenre(id)`; each genre has display props and a prompt `engine` |
| `src/lib/context.js` | D&D genre engine: `buildSystemPrompt`, `extractEntities`, `trimContext` |
| `src/lib/context.starwars.js` | Star Wars genre engine (same interface as D&D engine) |
| `src/App.css` | `:root` design tokens + `[data-theme="dnd"]` (Candle-lit Grimoire) / `[data-theme="void"]` (Crimson Void) theme blocks |
| `campaigns/` | Authored world-notes Markdown files loaded into `campaign.context` via the setup screen |
| `sessions/` | App-authored `.md` session saves (see `sessions/README.md`) |
| `server/sessions/` | Sync server's live session store (gitignored) |

---

## Session Persistence Details

Three surfaces share **one payload shape** defined in `src/lib/session.js`:

```
{ sessionId, schemaVersion, savedAt,
  campaign { name, genre, details, context, model, sessionId },
  messages, sessionLog, party }
```

- **localStorage** (`dnd_session`) — hydrated on boot; written once per settled turn (never per stream delta).
- **Markdown save/continue** — the header download button writes a self-contained `.md` handoff (`toMarkdown`). The setup screen's "Load .md file" detects the embedded ` ```session ` block (`fromMarkdown`) and boots straight into the restored session.
- **LAN sync** — `useSessionPersistence` keeps localStorage as an offline mirror; a strictly-newer gate (`savedAt` ISO comparison) prevents a stale in-flight poll from overwriting a freshly cleared session.

---

## Campaign Notes

Place Markdown files in `campaigns/`. Use the setup screen's "Load .md file" button to inject one into `campaign.context` as prior world state. Bold every NPC and location name (`**Name**`) so the continuity tracker (`extractEntities`) picks them up.

---

## Author

**Eric Chan**

---

## License

MIT — see [LICENSE](LICENSE).
