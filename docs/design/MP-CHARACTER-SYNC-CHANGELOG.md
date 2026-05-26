# MP-CHARACTER-SYNC Changelog

**Branch:** `feature/mp-character-sync`
**Phases:** 0–6 (Stage B complete)
**Gate:** G-B / G-C — all gates green, 747 passed / 2 skipped / 0 failed

---

## Files Touched (Phases 0–6)

### Design documents (Phase 0 / pre-implementation)
| File | Change |
|------|--------|
| `docs/design/MP-CHARACTER-SYNC-PLAN.md` | New — game-developer implementation plan (supersedes spec on 3 points) |
| `docs/design/MP-CHARACTER-SYNC-SPEC.md` | New — PM spec (data model, protocol, security, test plan) |
| `docs/design/MP-CHARACTER-SYNC-WORKFLOW.md` | New — orchestration workflow, stage graph, quality gates G-A/G-B/G-C |
| `docs/design/MP-CHARACTER-SYNC-CHANGELOG.md` | New — this file (Phase 6 artifact) |

### Source — data layer (Phase 1)
| File | Change |
|------|--------|
| `src/lib/session.js` | Schema bump 2→3; `characters` map in `serializeSession`/`deserializeSession`; v1/v2 backfill migration; `toMarkdown`/`fromMarkdown` round-trip for `characters`; new exports `extractCharacterFromPayload`, `buildPlayersForPrompt`, `buildPlayerSection`, `fmtMod`; `applyPartyUpdate` updated to preserve/normalize optional `conditions: string[]` on party rows |

### Source — context / prompt (Phase 4)
| File | Change |
|------|--------|
| `src/lib/context.js` | `buildSystemPrompt` extended with optional `players` param; injects bounded "Player Characters:" section (≤500 chars, 5-player cap) when non-empty; byte-identical output when `players` absent/empty |
| `src/lib/context.starwars.js` | Same `players` extension as `context.js`; section text byte-identical across both engines |

### Source — WebSocket client (Phase 3)
| File | Change |
|------|--------|
| `src/hooks/useWebSocket.js` | `joinCharacter` added to the `join` message payload (null when not provided) |

### Source — UI (Phase 3)
| File | Change |
|------|--------|
| `src/components/ApiKeySetup.jsx` | Join-tab reworked: three character paths (A: sync existing local character, B: create via wizard, C: import from `.md`); `extractCharacterFromPayload` used for Path C; room genre resolved from server for wizard; mobile-responsive layout |
| `src/components/CharacterWizard.jsx` | Added `initialCharacter` prop for `.md`-import pre-fill; wizard state seeded from `initialCharacter` when provided |
| `src/App.jsx` | `handleJoin` threads `character` from the Join tab through to `useWebSocket` |
| `src/App.css` | ~400 lines of new responsive CSS for the Join-tab character section (three path cards, synced-character preview, wizard mobile layout at ≤375px) |

### Source — Chat (Phase 4/5)
| File | Change |
|------|--------|
| `src/components/Chat.jsx` | `buildPlayersForPrompt` called with local `characters` + `party`; result passed as `players` to `buildSystemPrompt`; no-op in single-player (empty characters map → empty players → byte-identical prompt) |

### Server (Phase 2 / Phase 5)
| File | Change |
|------|--------|
| `server/sync-server.mjs` | `sanitizeCharacter(raw)` function (strips unknowns, caps strings, clamps numerics); `join` handler stores sanitized character in `room.characters[displayName]`; rejoin preserves existing character (not overwritten); `session:state` carries `characters` map; `.md` persist includes `characters`; DM-proxy `buildSystemPrompt` call passes `players` assembled from `room.characters` + `room.party` via `buildPlayersForPrompt`; `conditions` preserved in `applyPartyUpdate` on server side |

### Tests (Phases 1–6)
| File | New Tests Added |
|------|-----------------|
| `src/lib/session.test.js` | ~60 new tests: v1/v2/v3 deserialization, `characters` serialize/deserialize, `.md` round-trip for characters, `extractCharacterFromPayload` (all precedence branches), `applyPartyUpdate` conditions normalization, `buildPlayersForPrompt` (all branches), `buildPlayerSection` (format, budget), Phase 6 G-C2/G-C3 integration back-compat tests |
| `src/lib/context.test.js` | ~20 new tests: byte-identical-when-empty invariant, player section injection, section-level genre parity (PP-05/PP-06 style), budget enforcement, `fmtMod` formula |
| `src/hooks/useWebSocket.test.js` | ~8 new tests: `joinCharacter` in join message (present, null default, reconnect, SP never creates socket) |
| `src/components/ApiKeySetup.test.jsx` | ~30 new tests: Join-tab three character paths (sync existing, wizard, `.md` import), Path C valid `.md` pre-fills wizard, malformed `.md` graceful empty, blockless `.md` graceful error, wizard output produces correct synced subset on `onJoin` |
| `src/components/CharacterWizard.test.jsx` | ~10 new tests: `initialCharacter` prop pre-fills name/race/class steps, empty pre-fill leaves wizard empty |
| `src/lib/session.multiplayer.test.js` | ~4 new tests: MP-specific `buildPlayersForPrompt` / `applyPartyUpdate` integration |
| `server/sync-server.test.mjs` | ~15 new tests: `sanitizeCharacter` clamping (string caps, numeric ranges, allowlist strips, null→DEFAULT) |
| `server/sync-server.multiplayer.test.mjs` | ~16 new tests: join stores/broadcasts characters, null→DEFAULT_CHARACTER, forged clamped (G-C4), G-C7 late joiner, G-C7 existing clients updated, rejoin preserves original character, mid-session HP/conditions channel unaffected, DM system prompt contains player stats, 2-player prompt, forged reaches DM as clamped, HP broadcast in session:update, static map unchanged after HP update, HP persists across `.md` save/reload, HP persists across disconnect→rejoin, **G-C7 end-to-end 3-player all-clients** |

**Total new tests across Phases 0–6: 163** (from baseline 584 → 747 passing)

---

## Schema-Version Decision: 2 → 3

**Decision:** bump `SCHEMA_VERSION` from 2 to 3, additive.

**Rationale:** the `characters` map is a new field that cannot be expressed in a v1/v2 payload without a version marker. Existing v1/v2 payloads must still deserialize without throwing — a non-negotiable invariant.

**Migration rule** (implemented in `deserializeSession`, `src/lib/session.js`):
- `schemaVersion === 1` or `2` (or missing): backfill `characters: {}`, leave party rows exactly as-is (no character fields added to rows).
- `schemaVersion === 3`: read `characters` map as-is (may be `{}`).
- `schemaVersion > 3`: return `null` (existing guard, unchanged).

On the next settled turn after a client boots with a v2 `dnd_session` in localStorage, `Chat.jsx` re-persists the session as v3 (auto-upgrade in memory, then re-written on turn settle). No explicit migration step or user action required.

**`.md` round-trip:** `toMarkdown` always writes the `characters` map inside the authoritative `session` block, so a `.md` saved at v3 carries the characters. A `.md` with a v1/v2 block (no `characters` key) loads cleanly via `fromMarkdown` with `characters` backfilled to `{}`.

---

## New WebSocket Fields

### Client → Server: `join` message
```json
{
  "type": "join",
  "roomCode": "dnd-<8hex>",
  "sessionId": "<uuid>",
  "displayName": "Alex",
  "lastTurnSequence": 0,
  "joinCharacter": {
    "name": "Aria",
    "race": "Elf",
    "charClass": "Ranger",
    "abilities": { "STR": 12, "DEX": 18, "CON": 14, "INT": 13, "WIS": 16, "CHA": 10 },
    "ac": 15,
    "hpMax": 38
  }
}
```
`joinCharacter` is `null` when the player has no character (server substitutes `DEFAULT_CHARACTER`). Server-side `sanitizeCharacter()` clamps/strips the value before storing.

### Server → Client: `session:state` payload
```json
{
  "characters": {
    "Alex": { "name": "Aria", "race": "Elf", "charClass": "Ranger",
               "abilities": { "STR": 12, "DEX": 18, "CON": 14, "INT": 13, "WIS": 16, "CHA": 10 },
               "ac": 15, "hpMax": 38 }
  }
}
```
`characters` map (keyed by `displayName`) is included in every `session:state` snapshot — on first join, late join, and rejoin. Carries the static per-player subset. Mutable HP/conditions still ride party rows (unchanged).

### Server → Client: `session:update`
`session:update` does **not** carry the `characters` map (only `session:state` does). HP/condition changes flow through the existing `party` array channel in `session:update`, exactly as before.

---

## New Data-Model Fields

### `characters` map (session payload)
`{ [displayName: string]: SyncedCharacter }`

**SyncedCharacter** (static subset, set at join, stable for the session):
```typescript
{
  name: string       // ≤64 chars, sanitized
  race: string       // ≤32 chars, sanitized
  charClass: string  // ≤32 chars, sanitized
  abilities: {
    STR: number  // integer, clamped [3,20]
    DEX: number  // integer, clamped [3,20]
    CON: number  // integer, clamped [3,20]
    INT: number  // integer, clamped [3,20]
    WIS: number  // integer, clamped [3,20]
    CHA: number  // integer, clamped [3,20]
  }
  ac: number     // integer, clamped [5,30], else 10
  hpMax: number  // integer, clamped [1,999], else 10
}
```

Mutable HP/conditions are **not** in `characters`; they live in party rows.

### Party row: `conditions` field (optional)
Party rows gain an optional `conditions: string[]` managed by the AI DM. `applyPartyUpdate` normalizes it: trims strings, drops empties, caps each entry at 64 chars, caps the array at 10 entries, preserves existing conditions when the DM omits the field (null/absent/non-array), clears when DM emits `[]`. Does **not** add `hpCurrent` to party rows.

---

## Gate Results: G-C1 through G-C7

| Gate | Description | How Verified | Test(s) |
|------|-------------|--------------|---------|
| **G-C1** | Test floor: all existing + new tests pass, 0 failed | `npm test -- --run`: **747 passed / 2 skipped / 0 failed** | Full suite |
| **G-C2** | Schema back-compat: v1 and v2 payloads load without throw, `characters` defaults to `{}` | Explicit tests in `session.test.js` for v1, v2, and v3 `deserializeSession`; plus v1 and v2 `.md` through `fromMarkdown`; plus `extractCharacterFromPayload` deriving from v1/v2 party rows | `describe 'Phase 1 — deserializeSession: v1 / v2 / v3 version handling'` (4 tests); `describe 'Phase 1 — .md round-trip preserves characters'` (1 test, v1 block); `describe 'Phase 6 (G-C2) — v1 and v2 .md back-compat through fromMarkdown'` (2 tests); `describe 'Phase 6 (G-C2 + import flow)'` (5 tests) |
| **G-C3** | Single-player unaffected: `enabled=false`, zero socket, 30s poll runs, Ollama direct | `useWebSocket.test.js` `enabled=false` invariant; `buildPlayersForPrompt`/`buildPlayerSection` no-op on empty input; `serializeSession` SP round-trip | `'single-player (enabled=false) never creates a WebSocket regardless of joinCharacter'`; `describe 'Phase 6 (G-C3)'` (3 tests) |
| **G-C4** | Inbound character validated server-side: forged values clamped/stripped | Server test sends forged payload (STR:999, ac:NaN, hpMax:9999, extra fields, XSS name); asserts clamped/stripped values in `session:state`; pure unit test on `sanitizeCharacter`; server proxy passes clamped values to DM system prompt | `'FORGED joinCharacter … is clamped/stripped'` in `sync-server.multiplayer.test.mjs`; `sanitizeCharacter` suite in `sync-server.test.mjs`; `'forged joinCharacter reaches the DM system prompt as clamped values'` in Phase 5 proxy tests |
| **G-C5** | No server-only env leaks to client bundle: `OLLAMA_HOST` and `MODEL_RE` absent from `src/**` | Static grep of `src/**` returns zero matches | Grep result: `Grep('OLLAMA_HOST\|MODEL_RE', path='src/')` → **No files found**. Both identifiers exist only in `server/sync-server.mjs` (lines 49, 80, 543) and the server test file. |
| **G-C6** | Prompt budget: 5-player summary ≤500 chars; both engines emit identical section | `buildPlayerSection` worst-case 5-player test; `buildSystemPrompt` 5-player cap test; engine parity test | `'total section length <= 500 chars for 5 worst-case players'` in `session.test.js`; `'5-player section stays under 500 chars'` in `context.test.js`; `describe 'buildSystemPrompt — Phase 4: section-level genre parity'` |
| **G-C7** | Late joiner receives all existing characters; existing clients see new joiner | Server integration test: 3rd joiner receives all 3 characters; 2-player existing-client test; Phase 6 end-to-end test verifying ws1 AND ws2 both see all 3 characters when ws3 joins | `'session:state includes the characters map with all existing players (G-C7 late joiner)'`; `'G-C7: existing clients receive session:state with new joiner character'`; `'G-C7 end-to-end: all 3 clients receive session:state with all 3 characters when 3rd joins'` |

---

## Test Count and Suites Added

**Baseline (before this feature):** 584 passing (the original floor per workflow doc)
**At Phase 6 start:** 736 passing / 2 skipped (established by Phases 1–5)
**After Phase 6:** 747 passing / 2 skipped / 0 failed

**New tests from Phase 6 (this session):** 11

New Phase 6 test suites:
- `describe 'Phase 6 (G-C2) — v1 and v2 .md back-compat through fromMarkdown'` (2 tests) in `session.test.js`
- `describe 'Phase 6 (G-C2 + import flow) — extractCharacterFromPayload on v1/v2 .md'` (5 tests) in `session.test.js`
- `describe 'Phase 6 (G-C3) — single-player path: no characters → prompt unchanged'` (3 tests) in `session.test.js`
- `'G-C7 end-to-end: all 3 clients receive session:state with all 3 characters when 3rd joins'` (1 test) in `sync-server.multiplayer.test.mjs`

---

## Deferred Items (Out of Scope, Per Plan)

The following items were explicitly deferred in the spec and plan. They are **not** implemented on this branch and require a separate feature or Stage D work:

| Item | Reason Deferred |
|------|-----------------|
| `character:update` (client-driven self-edits of synced stats) | Not in scope per plan §"Data model & protocol". The DM is the authority for mutable state. Requires a new WS message type and server-side merge strategy. |
| Leveling / XP tracking | Out of scope per plan. Requires LLM prompt changes, new schema fields, and a client-side level-up flow. |
| Cross-session character persistence (`dnd_character` ↔ characters map sync) | Out of scope per plan. Each session gets a fresh join-time character snapshot. |
| `character:update` mid-session self-editing UI | Out of scope; blocked on client-driven self-edits (above). |
| PM sign-off on deferred items | Captured in `docs/design/MP-CHARACTER-SYNC-SPEC.md` §Deferred and the plan's "Out of scope" paragraph. |

---

## Manual Smoke Tests (Stage D — not automated here)

The following are manual / live-model validations deferred to Stage D:

- **Mobile-width 375px smoke**: open the Join tab and CharacterWizard in Chrome DevTools device emulation at 375px; confirm no horizontal overflow and tap-friendly controls.
- **Live-Ollama manual smoke**: `npm run dev`, two browsers on `?room=dnd-…`, each joins with a different character (one via wizard, one synced-existing, one via `.md` import), take a turn, confirm the DM references player classes/stats; save `.md`, restore, confirm characters persist.
- **Model compliance** (`qwen2.5:14b`): confirm the model honors player stats in narration and still emits valid `party`/`check`/`verdict` blocks.

These are not blocked on Stage B green; they run in Stage D per the plan.

---

## G-C5 Grep Evidence

```
Grep pattern: OLLAMA_HOST|MODEL_RE
Search path:  src/**
Result:       No files found
```

`OLLAMA_HOST` and `MODEL_RE` appear only in:
- `server/sync-server.mjs` lines 49 (`MODEL_RE` definition), 80 (`OLLAMA_HOST` env read), 543 (`MODEL_RE.test(...)`)
- `server/sync-server.multiplayer.test.mjs` (test harness — sets `process.env.OLLAMA_HOST` to point at mock Ollama; also appears as a deliberately-injected extra field in forged character tests, verified to be stripped by `sanitizeCharacter`)

No server-only configuration leaks into the client bundle (`src/**`).
