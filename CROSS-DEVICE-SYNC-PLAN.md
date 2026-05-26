# Cross-Device Session Persistence — Implementation Handoff

> **Status:** Planned, approved, not yet implemented. Resume from "Next steps" at the bottom.
> **Decision:** Implement **A + B** (localStorage message persistence as a free prerequisite, then a local Express sync server for true cross-device continuity).
> **Last updated:** 2026-05-25

---

## Goal

Let a player start a D&D session on their **desktop** browser and continue it on their **phone** browser on the same LAN — sharing the conversation, party, and check state. Today nothing is shared across devices, and the chat log isn't even persisted on a single device.

---

## Context: how the app works (verified facts)

- React 18 + Vite app at `H:\Claude\dnd-claude`. Only backend is **local Ollama** (stateless inference; stores no conversation). Default model `qwen2.5:14b`.
- **Network is already LAN-ready:**
  - `vite.config.js:7` — `server: { host: true }` → Vite binds `0.0.0.0`. **No `--host` flag needed.** Just `npm run dev`, then browse from phone to `http://<desktop-LAN-IP>:5173`.
  - `Chat.jsx:170` — `const ollamaHost = ${window.location.hostname}:11434`. The Ollama host is derived from the browser's current address, so the phone automatically points its Ollama calls at the desktop. **No code change needed for routing.**
  - Remaining manual step for phone use: expose Ollama on the LAN with `OLLAMA_HOST=0.0.0.0` and open port `11434` in Windows Firewall. (Plain `http://` over LAN — trusted networks only.)

### What is persisted today (all `localStorage`, per-device only)
- `App.jsx:84-90` — `campaign` (genre, name, details, model, context)
- `App.jsx:83` — `dnd_setup_done`
- `App.jsx:91` — `dnd_character`
- `App.jsx:93` — `dnd_party` (written back by `Chat.jsx:243`)

### What is NEVER persisted (the gap)
- `Chat.jsx:87` — `messages` (`useState([])`, no persistence) — **lost on refresh**
- `Chat.jsx:94` — `sessionLog`
- `Chat.jsx:93` — `entities` (pure derivative of `messages` via `extractEntities` — does NOT need persisting; re-derive on load)
- `Chat.jsx:96` — `pendingCheck` (intentionally session-only; cleared on roll send at `Chat.jsx:155`)

### Message shapes that must round-trip
- `{ role: 'user', content }` — trivial.
- `{ role: 'assistant', content, id, error? }` — `id` is `crypto.randomUUID()` (`Chat.jsx:149`), used only as React key + streaming-update target. Old ids load fine (inert stable keys).
- `{ role: 'dice', die, result, check?, verdict? }` — keyed by array index (`Chat.jsx:399`), so no id needed. `check`/`verdict` are mutated in place by the verdict-block handler (`Chat.jsx:259-268`); a resolved dice message must store both.

---

## Approved plan

### Phase A — localStorage message persistence (~30 min, no deps)
Fixes desktop refresh wiping the session. Does **not** solve cross-device (that's B).

**`src/components/Chat.jsx`:**
- Change initializer at line 87:
  ```js
  const [messages, setMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dnd_messages') ?? '[]') } catch { return [] }
  })
  ```
- Add `useEffect(() => { localStorage.setItem('dnd_messages', JSON.stringify(messages)) }, [messages])`.
- `handleNewSession` (line ~293) must `localStorage.removeItem('dnd_messages')`.
- Safe: assistant `content` already has structured blocks stripped (`Chat.jsx:217`) before entering state, so stored text is clean — no stale fence re-parse on load.

### Phase B — local Express sync server (~3 hrs; adds `express`, `concurrently`)
True cross-device continuity over the LAN.

**Topology:**
```
Desktop machine
├── Vite        :5173  (app, already LAN-accessible)
├── Ollama      :11434 (already LAN-accessible)
└── Sync server :3001  (NEW)

Phone → <host>:5173 (app) → <host>:11434 (Ollama) → <host>:3001 (sync)
```

**New file `server/sync-server.mjs`** (~80 lines, Express, `fs/promises`, no SQLite):
- `GET /session/:id` → `{ messages, sessionLog, party, pendingCheck, savedAt }` or `404`
- `PUT /session/:id` → writes `server/sessions/<id>.json`; reject with `409` if stored `savedAt` is newer than the client's (last-writer-wins + staleness guard)
- `GET /sessions` → list of slugs (for a future "continue session" picker)
- Storage: plain JSON files in `server/sessions/` (human-readable, no native deps). **Not** SQLite (`better-sqlite3` native build is fragile on Windows, no benefit here).

**New file `src/lib/sync.js`** (~50 lines, pure client helpers):
- `getSyncHost()` → `http://${window.location.hostname}:3001` (reuse the Ollama trick)
- `campaignToSessionId(campaignName)` → slug (e.g. `"Jaycen Hawke"` → `jaycen-hawke`); fall back to a `crypto.randomUUID()` stored once as `dnd_session_id`
- `loadSyncSession(id)`, `saveSyncSession(id, payload)` (sends `savedAt`, handles 409), `pollSyncSession(id, savedAt, onNewer)` (returns cleanup fn)

**`src/components/Chat.jsx`:**
- Import the sync helpers.
- **Mount `useEffect([])`:** `loadSyncSession` → if data, restore `messages`, `sessionLog`, `pendingCheck`, and `setParty` (use `setParty` directly — NOT `applyPartyUpdate`, which is only for reconciling id-less LLM output).
- **Save in the `finally` block** (after line ~278, after all three structured-block parsers + `party`/`verdict` commit). Do **not** save mid-stream (deltas fire dozens/sec). Capture post-stream state via the functional pattern: `setMessages(prev => { saveSyncSession(prev, ...); return prev })`.
- **Poll `useEffect`:** `pollSyncSession` every 30s; on newer `savedAt`/`409` show a reload prompt.
- `handleNewSession`: clear server session (or rely on next-save overwrite).

**Session payload shape:**
```json
{
  "sessionId": "jaycen-hawke",
  "savedAt": "2026-05-25T14:32:11.000Z",
  "messages": [...],
  "sessionLog": [...],
  "party": [...],
  "pendingCheck": null
}
```
`entities` deliberately excluded — re-derived from `messages` on load (avoids stale cache).

**`package.json`:**
- Add `express`, `concurrently` (devDeps).
- `"dev": "concurrently \"vite\" \"node server/sync-server.mjs\""`
- `"dev:app": "vite"`, `"dev:sync": "node server/sync-server.mjs"` for running individually.

**`.gitignore`:** add `server/sessions/`.

**`src/App.jsx`, `src/lib/context.js`, `vite.config.js`:** no changes.

### Gotchas (carry forward)
1. Dice messages keyed by array index — preserve message order on load, don't sort.
2. Restore `party` via `setParty` directly (loaded members already have ids); `applyPartyUpdate` is only for id-less LLM output.
3. Assistant `id` from storage is inert on load (new `assistantId` is minted per turn at `Chat.jsx:149`).
4. A loaded `pendingCheck` is correct/intentional — the player should see a pending check; it clears on next roll.
5. Open firewall ports `11434` (Ollama) and `3001` (sync) for LAN. Vite's `host: true` handles `5173`.

---

## Trade-off table

| Option | Effort | Cross-device | New deps |
|---|---|---|---|
| A. localStorage | ~30 min | ❌ (refresh only) | none |
| **B. sync server** | ~3 hrs | ✅ LAN sync | express, concurrently |
| C. export/import JSON | ~1 hr | ✅ manual file move | none |

Option C was **declined** as a standalone feature (B's payload is download-able later if wanted). Real-time sync uses 30s polling — SSE/CRDT rejected as overkill for single-user-two-devices.

---

## Agent fleet requested for implementation

User asked to involve these agents (not yet briefed — interrupted before kickoff):
- `llm-architect` — Ollama prompt/integration concerns
- `ai-engineer` — end-to-end AI system aspects
- `performance-monitor` — observability / metrics
- `performance-engineer` — performance bottlenecks

> **Note for resumption:** clarify with the user what each agent should own for a *session-persistence* feature — the core work (Express server + localStorage + React wiring) is frontend/backend plumbing, better suited to `react-specialist` / `backend-developer` / `fullstack-developer` per the repo's `CLAUDE.md` routing table. The four requested agents fit if the scope expands to: sync's effect on prompt/context assembly and `trimContext` (llm-architect), broader AI-system design (ai-engineer), and measuring save/poll/stream overhead (performance-monitor / performance-engineer). Confirm intended division of labor before spawning.

---

## Related, already-done this session
- Converted `campaigns/Jaycen Hawke Campaign Handoff — Solace Cathedral.markdown` into the app-ready `campaigns/jaycen-hawke-solace-cathedral.md` (usage header, character-panel values, hybrid-dice DM directives, bolded entities for `extractEntities`, full lore + current chapel scene). Original handoff left untouched.

---

## Next steps (resume here)
1. Confirm the agent division of labor (see "Agent fleet" note above), or proceed inline.
2. Implement **Phase A** (Chat.jsx localStorage) and run `npm test -- --run` (203 tests) — ensure new-session/refresh paths still pass; add a test for message reload.
3. Implement **Phase B**: `server/sync-server.mjs`, `src/lib/sync.js`, Chat.jsx wiring, `package.json` scripts, `.gitignore`.
4. Verify cross-device: desktop session → phone loads same session; edit on one, reload prompt on the other.
5. Document the `OLLAMA_HOST=0.0.0.0` + firewall steps in `dnd-claude/CLAUDE.md` (and the new `npm run dev` dual-process behavior).
