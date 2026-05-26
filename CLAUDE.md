# dnd-claude — D&D Campaign Assistant

## Commands

```powershell
npm install
npm run dev      # vite (http://localhost:5173) + LAN sync server (:3001), concurrently
npm run dev:vite # vite only (no sync server)
npm run sync     # sync server only — node server/sync-server.mjs
npm run build
npm test -- --run   # Vitest (jsdom + one node-env server suite) — 405 passed, 2 skipped (407 total)
```

**Cross-device / LAN play.** To reach the app and Ollama from a phone on the same LAN,
serve Ollama on all interfaces (`$env:OLLAMA_HOST="0.0.0.0"` before `ollama serve`) and allow
ports **5173** (Vite), **3001** (sync), **11434** (Ollama) through the firewall. The app derives
all hosts from `window.location.hostname` via `getLanHost()` (`src/lib/session.js`), so opening
`http://<desktop-IP>:5173` on the phone targets the desktop's Ollama + sync server automatically.

**Environment variables (server):** `OLLAMA_HOST` (server-side only; default `http://localhost:11434`), `WS_ALLOWED_ORIGINS` (comma-separated WS upgrade origins; default `http://localhost:5173`), `SYNC_PORT` (default 3001).

## Architecture

React 18 + Vite app. No routing library — `App.jsx` holds `campaign`, `character`, and
`party` state and conditionally renders the setup screen or `Chat`. The active **genre drives
the visual theme**: `App.jsx` writes `<html data-theme>` from `THEME_FOR_GENRE`
(`dnd → dnd`, `starwars → void`); there is no independent theme toggle.

| File | Role |
|------|------|
| `src/App.jsx` | Top-level state: `campaign`, `character`, `party`; routes between setup and chat; sets `<html data-theme>` from genre |
| `src/components/ApiKeySetup.jsx` | Imported as `CampaignSetup` — first-run screen: genre, campaign name/details, Ollama model, optional notes `.md`. **No API key** despite the filename |
| `src/components/Chat.jsx` | Single-player fallback: streaming fetch to local Ollama (§3.2). Multiplayer mode: sends `action` WS message, renders `dm:delta/dm:done`. Message rendering; structured-block parser; `parseMarkdown()` (with drop-cap hook); hydrates/persists the session (Phase A) + **Save session (.md)** button (Phase A2); mounts `useSessionPersistence` (Phase B) + `useWebSocket` (when roomCode+displayName set). Imports `useWebSocket`, `isActiveTurn` for turn gating. |
| `src/lib/session.js` | **One serialize layer, three surfaces** — `serializeSession`/`deserializeSession` (the canonical payload), `toMarkdown`/`fromMarkdown` (the LLM-loadable `.md`), `getLanHost`, and the sync API (`loadSyncSession`/`saveSyncSession`/`pollSyncSession`). SCHEMA_VERSION=2 (v1 payloads still deserialize). New exports: `makeRoomCode` (sessionId → `dnd-<8hex>`), `applyPartyUpdate` (shared client/server), `RESTING_PHASES`. v2 payload adds `roomCode`, `phase`, `turnSequence`. Pure, no React |
| `src/hooks/useSessionPersistence.js` | Phase B client: server-authoritative-when-reachable load on mount, per-turn push, 30s poll (suspended when WS OPEN via `shouldPoll`). Dual-authority `adopt(payload, source)`: `'poll'` uses existing M7 savedAt gate; `'ws'` uses turnSequence (MC-6). Resets 9999 sentinel on `session:state`. Degrades silently when the sync server is down. |
| `server/sync-server.mjs` | Phase B LAN sync server: HTTP REST (`GET/PUT/DELETE /session/:id`, `GET /sessions`) + WebSocket `/ws` (noServer, same port 3001). In-memory `rooms` Map (keyed by sessionId; canonical state per §4.1). Server-side Ollama DM proxy (OLLAMA_HOST env, OLLAMA_TIMEOUT_MS=90s, MODEL_RE allowlist); per-connection rate limit ACTION_MIN_INTERVAL_MS=500ms; block-strip inbound; verdict.roll validated vs server dice event. Broadcasts: `session:state/session:update/dm:delta/dm:done/presence:update`; handles: `join/action/ping`. Presence + room GC (~30min) + rejoin (NAME_TAKEN guard). v1 payloads carried by HTTP PUT. |
| `src/components/DiceRoller.jsx` | d4–d100 roller; emits `{ die, result }` |
| `src/components/DiceChip.jsx` | Renders a dice message — bare (`die → result`) upgrades to resolved (skill-check + `PASS`/`FAIL` verdict) |
| `src/components/PartyStrip.jsx` | Mobile 3-cell party strip (display-only; LLM-managed) |
| `src/components/CharacterPanel.jsx` | Player's editable character sheet (HP, stats, conditions); persisted to `dnd_character`. Decoupled from the LLM `party` |
| `src/components/HistoryPanel.jsx` | Session entities + action log + desktop party sub-section |
| `src/lib/genres.js` | `GENRES` registry + `getGenre(id)`; each genre has display props (`emblem`, `gmName`, …) + an `engine` |
| `src/lib/context.js` | **dnd** genre engine: `buildSystemPrompt`, `extractEntities`, `trimContext` |
| `src/lib/context.starwars.js` | **starwars** genre engine (same interface; block-emission text identical to `context.js`) |
| `src/App.css` | `:root` design tokens + `[data-theme="dnd"]` (Candle-lit Grimoire) / `[data-theme="void"]` (Crimson Void) theme blocks |
| `src/hooks/useWebSocket.js` | WebSocket connection manager: exponential-backoff reconnect (1s→30s ±20% jitter), join handshake, readyState/send/shouldPoll API; `enabled=false` for single-player (zero socket created) |
| `src/lib/turnStateMachine.js` | Pure phase-transition reducer (client + server shared): `phaseReducer(phase, event, context)` + `isActiveTurn(displayName, party)`; sentinels `'DM_BUSY'` / `'NOT_YOUR_TURN'` |

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
Full spec + rationale: `docs/design/PARTY-HUD-PLAN.md` (and `docs/design/PARTY-HUD-QWEN-VALIDATION.md` for model compliance).

## Multiplayer (V1)

**Room model:** clients join a room via URL query `?room=dnd-<8hex>` (decoded to sessionId by `App.jsx`); 2–5 is the design target but no client cap is enforced in code. Each client enters a displayName. The sync server stores room state in-memory (keyed by sessionId per §4.1); persists to `.md` after every action. Canonical state flows from the server; all clients are identical replicas (no split-brain). Design: `docs/design/MULTIPLAYER-ARCHITECTURE.md` (§2–7, canonical); handoff: `docs/design/MULTIPLAYER-V1-HANDOFF.md`.

**WebSocket protocol** (port 3001, same as REST): client→server wire is `{ type, roomCode, payload }` (plus `sessionId` on join). Server→client broadcasts are `{ type, roomCode?, payload }` with inferred roomCode. Message types:
- Client → Server: `join` (with `sessionId`, `displayName`, `lastTurnSequence`), `action` (with `content`, `pendingCheck`), `ping`.
- Server → Client: `session:state` (full snapshot on join/rejoin), `session:update` (incremental: messages/party/phase/turnSequence), `dm:delta` (streaming text chunk), `dm:done` (final text + error flag), `presence:update` (list of {displayName, status}), `error`.

**Phase model:** `'free-roam'` (default) → action → `'awaiting-dm'` (transient) → DM completes → `'combat'` (if party has isActive) or back to `'free-roam'`. Transient phases (`'awaiting-dm'`, `'resolving'`) live only in the server's in-memory room state; only resting phases persist to `.md` (MC-4). Governed by `phaseReducer` (§4.2, shared client/server via `turnStateMachine.js`); sentinels `'DM_BUSY'` (action rejected, DM in progress) and `'NOT_YOUR_TURN'` (combat phase, wrong actor).

**Server-side DM trigger:** single-player `sendMessage` is replaced by a server-side Ollama call in multiplayer. The sync server orchestrates: locks the room's action queue, advances the phase to `'awaiting-dm'`, builds the system prompt, streams Ollama with identical parameters as Chat.jsx, parses party/check/verdict blocks, broadcasts incremental `dm:delta` then final `dm:done`, persists the `.md`, and broadcasts `session:update` (all clients sync in parallel). Verdict.roll is validated server-side (MC-2) to reject forged rolls. OLLAMA_HOST and MODEL_RE allowlist are server-only env/code (security item H).

**Dual-authority adoption gate** (MC-6): the 30s poll (`useSessionPersistence`) is suspended while the WS is OPEN (`shouldPoll`). On poll, the M7 strictly-newer savedAt gate applies. On WS `session:update`, a `turnSequence`-based gate applies instead (WS is faster; turn-count is a proxy for freshness). No lost updates; a 409 conflict poll is graceful.

**Single-player default:** when there is no `?room=` param, `roomCode` and `displayName` are null; `useWebSocket` is never mounted (`enabled=false`), zero WebSocket is created, the 30s poll still runs, and `sendMessage` calls Ollama directly (the original fallback path in Chat.jsx).

## Session persistence & cross-device sync

Three surfaces, **one payload shape** defined once in `src/lib/session.js`
(`{ sessionId, schemaVersion, savedAt, campaign{name,genre,details,context,model,sessionId},
messages, sessionLog, party }`). `entities` are excluded (re-derived via `extractEntities`);
`pendingCheck` is session-only (surfaced as a prose line in `.md`, never machine-restored).

- **Phase A — localStorage** (`dnd_session`): `Chat.jsx` hydrates on boot and persists **once per
  settled turn** via an `!isLoading` effect (never per stream delta), with a `QuotaExceededError`
  trim-and-retry. `campaign.sessionId` is a stable uuid minted once in `App.jsx` (`loadSessionId`).
- **Phase A2 — Markdown save/continue** (no server). The 💾 header button downloads a
  self-contained, LLM-loadable handoff (`toMarkdown`): prose DM brief + a trailing ` ```session `
  block. The setup screen's **Load .md file** detects that block (`fromMarkdown`) and restores the
  full session (boots straight into play, adopting the file's `campaign`); a file *without* a block
  falls back to today's prose→`campaign.context` behavior.
- **Phase B — LAN sync** (`server/sync-server.mjs` + `useSessionPersistence`): server-authoritative
  when reachable, localStorage is the offline mirror. The HTTP-poll path is handoff-first LWW
  (one device at a time); real-time concurrent play runs over WebSocket instead (see Multiplayer V1).
  Conflict (409) is non-destructive — the 30s poll reconciles. **M7 strictly-newer gate:** `adopt()`
  only overwrites local when `payload.savedAt > max(localStorage savedAt, lastSavedAt.current)`;
  ISO timestamps compare as strings, so a `'9999-12-31T23:59:59.999Z'` sentinel (set by `onNewSession`)
  sorts after all real-era dates and blocks resurrection of a cleared session on in-flight poll adoption.

Folders: `campaigns/` = authored world notes → `campaign.context`; `sessions/` = app-authored saves
(see `sessions/README.md`); the sync server's `server/sessions/` store is gitignored.
Full design + rationale: `docs/design/CROSS-DEVICE-SYNC-EVALUATION.md` (canonical) and `docs/design/CROSS-DEVICE-SYNC-HANDOFF.md`.

## Campaign notes

`campaigns/` holds saved campaign-notes Markdown files (untracked; loaded at runtime). The setup
screen's **Load .md file** button reads one into `campaign.context`, injected into the system prompt
as prior world state (see `buildSystemPrompt`). Bold every NPC/location name (`**Name**`) so the
continuity tracker (`extractEntities`) picks them up.

> Historical note: `docs/design/CONTEXT.md` documents the (now-complete) Anthropic→Ollama migration. The app
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
