# Daniel and Dragons

A local-first AI Dungeon Master (and Star Wars Game Master) powered by a locally running **Ollama** instance. Nothing is sent to the cloud, and no API key is required.

The project is named after my friend Dan, a longtime Dungeon Master. He's always the one running the game for everyone else, so I built this to let the AI handle the DM seat and give Dan a turn as a player.

![Setup screen](docs/screenshots/setup-screen.png)

---

## Features

- **Two genre-driven themes** — Dungeons & Dragons 5e ("Candle-lit Grimoire" dark theme) and Star Wars Saga Edition ("Crimson Void" dark theme). Genre selection drives both the visual theme and the system prompt engine; there is no independent theme toggle.
- **Streaming Ollama chat** — messages stream token-by-token from `http://localhost:11434/api/chat`. Default model: `qwen2.5:14b`.
- **LLM-managed party HUD** — the AI DM appends fenced ` ```party ` JSON blocks to each response; the app parses them and renders the live party roster in the header turn-pill (desktop), the mobile PartyStrip, and the Campaign History panel.
- **Dice roller + skill-check verdicts** — roll d4 through d100 in-chat. The DM emits ` ```check ` (skill + DC) and ` ```verdict ` (PASS/FAIL) structured blocks; these upgrade bare dice messages into resolved DiceChip components.
- **Session persistence (localStorage)** — the full session (messages, party, campaign) is saved to `localStorage` on every settled turn with a `QuotaExceededError` trim-and-retry.
- **Markdown save/continue** — download a self-contained, LLM-loadable `.md` handoff from the header button; load it on any device via the setup screen's "Load .md file" button to resume the session.
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
| **Ollama** | Running locally at `http://localhost:11434`. Download: [Windows installer](https://ollama.com/download/OllamaSetup.exe) · [all platforms](https://ollama.com/download) |
| **Model** | `qwen2.5:14b` pulled in Ollama (`ollama pull qwen2.5:14b`) |

Ports used:

| Port | Service |
|---|---|
| `5173` | Vite dev server |
| `3001` | LAN sync server |
| `11434` | Ollama |

---

## Quick Start

**1. Clone and install.**

```powershell
git clone https://github.com/EricChan277/dnd-claude.git
cd dnd-claude
npm install
```

**2. Start Ollama and confirm the model is ready.**

```powershell
ollama pull qwen2.5:14b   # skip if already pulled
ollama serve              # runs at http://localhost:11434
```

Ollama must be running before you start a session — `Chat.jsx` POSTs to `http://<host>:11434/api/chat` with `stream: true`.

**3. Start the dev server (Vite on 5173 + sync server on 3001).**

```powershell
npm run dev
```

**4. Open `http://localhost:5173`** and fill in the setup screen:

| Field | Required | Notes |
|---|---|---|
| **Genre** | Yes | `Dungeons & Dragons (5e)` or `Star Wars (d20 / Saga Edition)`. Drives the visual theme **and** the system-prompt engine — there is no separate theme toggle. |
| **AI Model** | Yes | Default `qwen2.5:14b`; `qwen2.5:32b` also available (slower, longer narration). |
| **Campaign Name** | Optional | Used in save-file names and the session header. |
| **Setting & Context** | Optional | Free-text setting, party, tone, house rules — injected into the system prompt. |
| **Campaign Notes / Load .md file** | Optional | Accepts `.md` or `.txt`. A file with a ` ```session ` block boots straight into a saved session (`fromMarkdown`); otherwise its prose loads as `campaign.context`. |

**5. Click "Begin the Campaign"** and type your first action. The AI DM streams its response token-by-token.

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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Message sent, spinner runs forever, no response | Ollama is not running | Run `ollama serve` before starting the app |
| `model not found` in the console | Model not pulled | `ollama pull qwen2.5:14b` (or `qwen2.5:32b` if selected) |
| Streaming starts then stalls mid-response | Ollama memory pressure / model paged out | Check `ollama ps`; restart `ollama serve`. This is Ollama-side, not the app |
| AI fails from a phone with a network/CORS error | Ollama bound to `localhost` only | Set `$env:OLLAMA_HOST = "0.0.0.0"` **before** `ollama serve` |
| Phone reaches `:5173` but AI never responds | Firewall blocking port **11434** | Allow inbound TCP on 5173, 3001, **and** 11434 on the desktop |
| Phone can't reach the app at all | Firewall blocking port **5173** | Allow inbound TCP on 5173 (and 3001 for sync) |
| Session not syncing across devices | Ran `npm run dev:vite` (no sync server) | Use `npm run dev`, or start sync separately with `npm run sync` |
| Another device's saves don't appear immediately | Poll interval is 30 s, not real-time | Wait up to 30 s — the hook polls via `pollSyncSession` |
| `409` logged after saving a turn | Stale-write conflict (another device saved first) | Non-destructive: local state is kept and the 30 s poll reconciles via `adopt()` |
| Old session briefly reappears after "New Campaign" | In-flight poll adopted the stale server copy | The strictly-newer sentinel (`'9999-12-31T23:59:59.999Z'`) blocks adoption; resolves on the next poll tick |
| `QuotaExceededError` in the console | localStorage full (very long session) | The app trims oldest messages and retries; if it persists, save a `.md` and start fresh |
| "Load .md file" loads as plain context, not a restored session | The `.md` has no ` ```session ` block | Only files from the 💾 save button (`toMarkdown`) are machine-restorable |
| Port 5173/3001 already in use | Another process holds the port | Free it, or override: `$env:SYNC_PORT = "3002"; npm run sync` |

---

## Good to Know

Non-obvious behaviors that don't appear on the happy path:

- **Genre drives the theme *and* the prompt engine — no independent theme toggle.** D&D → `data-theme="dnd"` + `context.js`; Star Wars → `data-theme="void"` + `context.starwars.js`. Changing genre after a campaign starts is not supported.
- **The DM owns the party HUD.** `Chat.jsx` reads a fenced ` ```party ` block off each response and treats it as authoritative; you can't edit party members in the UI — the LLM manages HP, roles, and active status.
- **Entities are re-derived, not stored.** `extractEntities` re-runs over the message history on every load. Bold NPC/location names (`**Name**`) so the continuity tracker picks them up.
- **`pendingCheck` is session-only.** A ` ```check ` block lives in React state for the current session and is *not* restored by `fromMarkdown`; after a reload the next roll won't carry a verdict until the DM emits a new check.
- **The sync layer degrades silently by design.** Every `fetch` in `src/lib/session.js` catches and returns `null` / `{ ok: false }`; sync errors never surface to the user — localStorage and `.md` saves keep working.
- **`SYNC_PORT` is the only runtime knob.** No API keys, no `.env`; all hosts are derived from `window.location.hostname` via `getLanHost()`.

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

**Eric Chan** — [@EricChan277](https://github.com/EricChan277)

---

## License

MIT — see [LICENSE](LICENSE).
