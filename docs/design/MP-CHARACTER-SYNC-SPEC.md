# Per-Player Character Sync in Multiplayer — Feature Specification

**Status:** Scoped  
**Author:** Product Manager  
**Date:** 2026-05-26  
**Epic:** Multiplayer Character Management (Per-Player Character Data Sync & DM Awareness)

---

## 1. Overview

Today in multiplayer, when players join a room via `?room=`, they enter a display name and optionally skip character creation (landing on `DEFAULT_CHARACTER`). The synced party (carried in `session:state` and `session:update` messages) holds only `{ name, role, hpPct, isActive, displayName }` — a one-row per player, with no class/race or ability stats. As a result:

1. **Character wizard output is local-only** — each player's full character sheet (`dnd_character` localStorage) does not sync to the server or other clients.
2. **DM is uninformed** — the LLM system prompt receives only the party display (name/role/HP), not class/race or key stats (STR–CHA), so the DM cannot narrate skill checks, spell DCs, or tactical positioning accurately.
3. **No character persistence across rejoins** — if a player disconnects and reconnects, their character sheet is lost (they rejoin with `DEFAULT_CHARACTER` — the server has no copy).

**Goal:** extend the synced party model so that each joining player's character (name, race, class, core ability scores, AC, HP max) is transmitted on `join`, persisted by the server, and available to all clients and the DM. The DM is fed each player's class/race + key stats in the system prompt, bounded so that even 5 players do not bloat the prompt beyond token/char limits.

---

## 2. Product Decisions & Rationale

### Requirement vs. Optional Character Creation
**Decision:** Character creation is **OPTIONAL for joiners**. If a joiner skips the wizard, they receive `DEFAULT_CHARACTER` as their starting character, and it syncs just as a created character would.

**Rationale:** Eliminates blocking on character creation (players can join and start playing immediately), matches today's UX on single-player (skip is easy), and keeps the join flow lightweight. A player can edit their character in-session if needed (deferred to a future phase per §2 Scope Boundaries).

### Source-of-Truth for Synced Character Data
**Decision:** **Server-authoritative** for the synced subset (name, race, class, ability scores, AC, HP max). The full local `dnd_character` sheet remains the player's editable working copy (ephemeral client-side, not synced).

**Rationale:** Prevents split-brain (client A's edits don't step on client B's rejoins), mirrors the existing party sync model (server holds the truth, clients are replicas), and keeps security simple (server validates all inbound character data before storing). The local sheet is the player's view; the synced subset is what other clients and the DM see.

### Synced Character Subset: What Travels on the Wire
**Decision:** The synced character includes ONLY what the DM needs for narration + turn order:
- `name` (string) — player's character name
- `race` (string) — e.g. "Elf", "Tiefling", "Twi'lek"
- `charClass` (string) — e.g. "Wizard", "Fighter", "Scoundrel"
- `abilities` (object: `{ STR, DEX, CON, INT, WIS, CHA }` — raw ability scores, not modifiers)
- `ac` (number) — Armor Class (used for combat narration)
- `hpMax` (number) — hit points max (DM tracks in-combat damage; hpPct is derived as `hpCurrent / hpMax * 100`)

Not synced (remain local):
- `hpCurrent` (is now on the server, derived from the party `hpPct` + the synced `hpMax`, read-only on client)
- `initiative` (local only; not needed for async turn-based play)
- `speed` (local only; rarely relevant in narrative)
- `conditions` (local only; the DM manages conditions in the party block)

**Rationale:** Keeps the per-player sync compact (~200 chars per player, 1 KB for 5 players). Full sheets would inflate the wire (5 players × full sheet ~2–3 KB total, plus repeated on every session:state), risk token overflow in the DM prompt, and duplicate state (DM manages party state anyway). The DM gets class/race for flavor, ability scores for skill DCs and spell saves, and AC for combat — the essentials.

### Wider Party Row vs. Sibling Structure
**Decision:** **Widen the existing party row** by adding the synced character fields. The party array grows from 4 fields to 10 fields per row.

Today:
```javascript
{ name, role, hpPct, isActive, displayName }
```

After change:
```javascript
{
  name, role, hpPct, isActive, displayName,
  race, charClass, abilities, ac, hpMax
}
```

**Rationale:** Single-array simplicity (no sibling structures keyed by displayName), minimal migration (v2 existing rows gain new fields with defaults), and re-uses existing `applyPartyUpdate` logic (only the broadened field set). A sibling map would require a second sync path and divergent update logic.

---

## 3. Data Model Changes

### Session Payload Schema Bump
**SCHEMA_VERSION: 2 → 3** (additive, v1/v2 still load).

The serialized session (`session.js` `serializeSession` output) gains an optional **`characters`** field — a map keyed by `displayName`, carrying the full synced character for each player in the room.

```javascript
{
  sessionId, schemaVersion, savedAt,
  campaign: { ... },
  messages: [...], sessionLog: [...],
  party: [
    {
      name, role, hpPct, isActive, displayName,  // existing
      race, charClass, abilities, ac, hpMax       // NEW (schema 3+)
    }
  ],
  characters: {
    // NEW (schema 3+): full detail per player (displayName is the key)
    "Alice": {
      name, race, charClass, hpCurrent, hpMax, ac, initiative, speed,
      abilities: { STR, DEX, CON, INT, WIS, CHA },
      conditions: []
    },
    "Bob": { ... }
  },
  roomCode, phase, turnSequence
}
```

### Party Row Extension
Each row in the `party` array gains these new fields (all required, populated from `characters[displayName]` or defaults on load):
- `race` (string) — e.g. "Elf", "Human"
- `charClass` (string) — e.g. "Wizard", "Ranger"
- `abilities` (object: `{ STR, DEX, CON, INT, WIS, CHA }`) — ability score integers
- `ac` (number) — Armor Class
- `hpMax` (number) — hit points maximum

When a party row is created (from the DM's block), these fields are added as `null` initially. When the server receives the character via `join`, it backfills them from the character payload.

### Character Shape on the Wire (Client → Server on `join`)
Clients send a `joinCharacter` object in the `join` message:

```javascript
{
  type: 'join',
  roomCode,
  sessionId,
  displayName,
  lastTurnSequence,
  joinCharacter: {                         // NEW (schema 3+)
    name: string,
    race: string,
    charClass: string,
    abilities: { STR, DEX, CON, INT, WIS, CHA },
    ac: number,
    hpMax: number,
    hpCurrent: number                      // sent so server knows the player's current HP
  }
}
```

Or `null` if no character (skip case; server uses `DEFAULT_CHARACTER`).

### localStorage & .md Save Impact
- **`dnd_character`** (localStorage key, existing) — **unchanged**. The full local character sheet remains client-only and is never synced to the server. Persisted by the player's device only.
- **`dnd_party`** (localStorage key, existing) — **updated**: now carries the extended party rows with character fields. On schema bump (v2 → v3), the migration backfills missing character fields with defaults (`race: '', charClass: '', abilities: { STR: 10, ... }, ac: 10, hpMax: 10`).
- **`.md` save/continue** (`toMarkdown` / `fromMarkdown`) — **updated**: the `.md` file now includes a trailing ` ```characters ` block (after the existing ` ```session ` block) with all players' full character objects (the `characters` map). On restore (`fromMarkdown`), the block is parsed and the characters are re-hydrated into the session state; on join, the player's own character is loaded from the file into their local `dnd_character`, and the synced subset is sent to the server.

### Entities Re-derivation
**No change.** The `extractEntities` function (in `context.js`) runs on `messages` only (character names in prose), not on the synced character fields. Character names are still captured from the NPC/location bolding in DM narration, not pre-loaded from the character sync. No new entity indexing is needed.

---

## 4. WebSocket Protocol Additions

### Client → Server: `join` Message (Extended)
**Existing fields:**
```javascript
{
  type: 'join',
  roomCode: string,
  sessionId: string,
  displayName: string,
  lastTurnSequence: number
}
```

**New field:**
```javascript
{
  type: 'join',
  roomCode: string,
  sessionId: string,
  displayName: string,
  lastTurnSequence: number,
  joinCharacter: {                          // NEW
    name: string,
    race: string,
    charClass: string,
    abilities: { STR, DEX, CON, INT, WIS, CHA },
    ac: number,
    hpMax: number,
    hpCurrent: number
  } | null  // null if skipped wizard (server uses DEFAULT_CHARACTER)
}
```

The server **validates and clamps** this payload server-side (§4.d Security). The client **does not transform the character**; the server is authoritative.

### Server → Client: `session:state` (Full Snapshot on Join/Rejoin)
Unchanged structure, **now carries the extended party rows** with character fields:

```javascript
{
  type: 'session:state',
  roomCode: string,
  payload: {
    sessionId, schemaVersion, savedAt,
    campaign: { ... },
    messages: [...], sessionLog: [...],
    party: [
      {
        id, name, role, hpPct, isActive, displayName,  // existing
        race, charClass, abilities, ac, hpMax           // NEW
      }
    ],
    characters: { ... },  // NEW (for completeness; clients mostly ignore)
    phase, turnSequence, roomCode
  }
}
```

Late joiners receive the full snapshot and learn all existing players' characters from the extended party rows.

### Server → Client: `session:update` (Incremental Update after Each Turn)
Unchanged structure, **now includes character fields if the party changed**:

```javascript
{
  type: 'session:update',
  roomCode: string,
  payload: {
    messages: [...],
    sessionLog: [...],
    party: [
      {
        id, name, role, hpPct, isActive, displayName,  // existing
        race, charClass, abilities, ac, hpMax           // NEW (if party changed)
      }
    ],
    phase, turnSequence
    // characters map: NOT included in incremental updates (only in session:state)
  }
}
```

### Mid-Session Character Edits: `character:update` Message
**Status: EXPLICITLY DEFERRED** to a future phase (not in scope for join-time sync). If a player edits their character mid-session (e.g. spell slot spend, damage taken), there is no `character:update` message. Instead, the DM's party block governs the party display (role/hpPct/isActive); the synced character fields (race/class/abilities/ac/hpMax) are immutable once the session starts. A future phase will add `character:update` if needed.

### Connection-Bound Identity Invariant
**Reaffirmed:** the server uses the WebSocket connection identity (the socket object itself) to bind a displayName. Per-message `displayName` in `join` is trusted **once**, on connection open; any later messages ignore the `displayName` field and use the socket's bound identity. This prevents a client from impersonating another player mid-session. The implementation is unchanged from the existing code (`sync-server.mjs` l.331: "per-message displayName is ignored for authorization").

---

## 5. Backward-Compatibility & Migration

### SCHEMA_VERSION: 2 → 3
**Decision:** Bump `SCHEMA_VERSION` from 2 to 3 in `session.js`. The bump is **additive** — v1 and v2 payloads must still deserialize without throwing.

### Migration Rule
In `deserializeSession` (session.js):
1. Accept `schemaVersion` 1, 2, or 3. (If 4+, return null as before — unchanged invariant.)
2. If schemaVersion is 1 or 2 (no character fields), apply defaults:
   - For each row in `party`, add: `race: '', charClass: '', abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, ac: 10, hpMax: 10`.
   - Set `characters: {}` (empty map).
3. Output the full schema 3 payload (with the new fields present).

```javascript
export function deserializeSession(raw) {
  // ... existing validation ...
  const obj = ... // parsed
  if (obj.schemaVersion > 3) return null // reject unknown versions

  // Upgrade v1/v2 to v3
  const party = Array.isArray(obj.party) ? obj.party : []
  const upgradedParty = party.map(row => ({
    ...row,
    race: row.race ?? '',
    charClass: row.charClass ?? '',
    abilities: row.abilities ?? { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    ac: row.ac ?? 10,
    hpMax: row.hpMax ?? 10,
  }))

  return {
    sessionId: obj.sessionId ?? ...,
    schemaVersion: SCHEMA_VERSION,  // 3
    savedAt: obj.savedAt ?? null,
    campaign: pickCampaign(obj.campaign),
    messages: Array.isArray(obj.messages) ? obj.messages : [],
    sessionLog: Array.isArray(obj.sessionLog) ? obj.sessionLog : [],
    party: upgradedParty,
    characters: obj.characters ?? {},  // NEW
    roomCode: obj.roomCode ?? null,
    phase: readPhase(obj.phase),
    turnSequence: readTurnSequence(obj.turnSequence),
  }
}
```

### `.md` Save/Continue Round-Trip
**`toMarkdown` (serializing to .md):**
- Existing ` ```session ` block carries the full payload (including the new character fields in `party` and the `characters` map).
- Add a new ` ```characters ` block (optional, for clarity during manual `.md` inspection) listing all players' full character objects. This is informational; the session block is the authoritative copy.

**`fromMarkdown` (deserializing from .md):**
- Parse the ` ```session ` block as before; the `characters` map is now part of the payload.
- When a player loads a `.md` file:
  1. The file is parsed → full session state restored (including all players' synced characters).
  2. In single-player mode (no `?room=`), the player boots directly into chat with all characters restored to the party display.
  3. In multiplayer mode (joining a room), the player's own character is extracted from the file and sent to the server in the next `join` message.

---

## 6. Security Validation of Inbound Character Payloads

### Validation Module: `sanitizeCharacter`
Create a new pure function in `server/sync-server.mjs` (exported for testing):

```javascript
export function sanitizeCharacter(raw) {
  const char = raw ?? {}

  // Validate and clamp string fields
  const name = String(char.name ?? '')
    .trim()
    .replace(/[<>&"']/g, '')      // strip HTML/XML
    .replace(/\p{Cc}/gu, '')      // strip control chars
    .slice(0, 64)                  // max 64 chars (name)
  
  const race = String(char.race ?? '')
    .trim()
    .replace(/[<>&"']/g, '')
    .replace(/\p{Cc}/gu, '')
    .slice(0, 32)                  // max 32 chars (race name like "Half-Orc")
  
  const charClass = String(char.charClass ?? '')
    .trim()
    .replace(/[<>&"']/g, '')
    .replace(/\p{Cc}/gu, '')
    .slice(0, 32)                  // max 32 chars (class name)

  // Validate ability scores: integers in range 3–20 (D&D 5e natural range)
  // Clamp NaN, Infinity, non-integers to 10 (neutral baseline)
  const abilities = {}
  for (const stat of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
    let val = Number(char.abilities?.[stat])
    if (!Number.isInteger(val) || val < 3 || val > 20) val = 10
    abilities[stat] = val
  }

  // AC: integer 5–30 (reasonable D&D range; 10 is unarmored)
  let ac = Number(char.ac)
  if (!Number.isInteger(ac) || ac < 5 || ac > 30) ac = 10

  // hpMax: integer 1–999 (cap at 999 to reject ludicrous values like 9999)
  let hpMax = Number(char.hpMax)
  if (!Number.isInteger(hpMax) || hpMax < 1 || hpMax > 999) hpMax = 10

  // hpCurrent: integer, clamped to [0, hpMax]
  let hpCurrent = Number(char.hpCurrent)
  if (!Number.isInteger(hpCurrent) || hpCurrent < 0 || hpCurrent > hpMax) hpCurrent = hpMax

  // Reject unknown fields — allowlist only the above
  // (do NOT pass through arbitrary properties)

  return {
    name,
    race,
    charClass,
    abilities,
    ac,
    hpMax,
    hpCurrent,
  }
}
```

### Application in `join` Handler
In `sync-server.mjs`, when a client sends a `join` message with `joinCharacter`:

```javascript
const { joinCharacter } = payload
const sanitized = joinCharacter ? sanitizeCharacter(joinCharacter) : null
const char = sanitized ?? DEFAULT_CHARACTER  // server builds the fallback if missing or invalid

// Store the character in the room (add to room.characters map, keyed by displayName)
room.characters[displayName] = char
```

### Authorization Rule: Server is Authoritative
**The server NEVER trusts the client's character data to be correct.** All numeric fields are validated and clamped server-side:
- Out-of-range ability scores → clamped to 10.
- NaN / Infinity → clamped to a safe default.
- Negative or oversized HP → clamped or rejected.
- Unknown fields → stripped (allowlist only the named fields).
- Missing fields → filled from `DEFAULT_CHARACTER`.

A client **cannot** inject a forged 20-STR or 999-HP character; the server clamps it to a sensible range before storing.

### No Host Secrets Leak
**Reaffirmed:** `OLLAMA_HOST` and `MODEL_RE` are **server-only environment variables**. The client bundle (`src/**`) must never reference them. Tests and the integration gate (G-C5) verify that `OLLAMA_HOST` and `MODEL_RE` appear only in `server/sync-server.mjs`, never in client code.

---

## 7. DM Prompt Integration

### Current System Prompt
Today, `buildSystemPrompt` in `src/lib/context.js` (and the identical `src/lib/context.starwars.js`) builds the DM's system instruction. It includes campaign name, details, and prior context (notes), but **does not include player character data** — the DM is unaware of class/race/abilities.

### Change: Per-Player Stat Summary Injection
**Modify `buildSystemPrompt` to accept an optional `party` array and inject a bounded per-player summary:**

```javascript
export function buildSystemPrompt({ name, details, context, party } = {}) {
  // ... existing prompt text ...

  // NEW: Party stats summary (only if party array is provided and has entries)
  let partySection = ''
  if (Array.isArray(party) && party.length > 0) {
    partySection = '\n\nPlayer Characters:\n'
    for (const member of party.slice(0, 5)) {  // cap at 5 players
      if (!member) continue
      const abilityMods = (member.abilities || {})
      const strMod = Math.floor((abilityMods.STR || 10 - 10) / 2)
      const dexMod = Math.floor((abilityMods.DEX || 10 - 10) / 2)
      const conMod = Math.floor((abilityMods.CON || 10 - 10) / 2)
      const intMod = Math.floor((abilityMods.INT || 10 - 10) / 2)
      const wisMod = Math.floor((abilityMods.WIS || 10 - 10) / 2)
      const chaMod = Math.floor((abilityMods.CHA || 10 - 10) / 2)
      
      partySection += `- ${member.name} (${member.charClass} ${member.race}): STR ${abilityMods.STR || 10}(${strMod:+s}${strMod}), DEX ${abilityMods.DEX || 10}(${dexMod:+s}${dexMod}), CON ${abilityMods.CON || 10}(${conMod:+s}${conMod}), INT ${abilityMods.INT || 10}(${intMod:+s}${intMod}), WIS ${abilityMods.WIS || 10}(${wisMod:+s}${wisMod}), CHA ${abilityMods.CHA || 10}(${chaMod:+s}${chaMod}); AC ${member.ac || 10}, HP ${member.hpMax || 10}\n`
    }
  }

  return `...existing prompt...${partySection}

Structured data blocks: [rest of existing text]`
}
```

**Format rationale:** The per-player summary is compact (1–2 lines per player) and includes class/race for flavor, raw ability scores (so the DM can calculate modifiers inline), AC for combat narration, and HP max for damage tracking. A 5-player party at full detail is ~300 chars; the prompt overhead is minimal.

**Behavioral invariant:** Both `context.js` and `context.starwars.js` must export an identical `buildSystemPrompt` signature and identical injection logic. A test asserts that calling `buildSystemPrompt` from both genre engines with the same `{ name, details, context, party }` input produces identical DM text (byte-for-byte, including the player summary).

### Integration in Chat.jsx & Server DM Proxy
- **Chat.jsx (single-player):** When calling `sendMessage` → Ollama, pass the current `party` state to `buildSystemPrompt({ name, details, context, party })`.
- **Server DM proxy (multiplayer):** When the server calls Ollama in response to an `action` message (Phase 3, MULTIPLAYER-ARCHITECTURE.md §3), construct the party array from the room's synced character data and pass it to `buildSystemPrompt`.

### Token/Char Budget Guard (Risk R-4)
**Constraint:** With up to 5 players, the party section must not exceed **500 characters** of total prompt overhead.

**Enforcement:** A unit test (`abilityScoreMath.test.js` or a new `buildSystemPrompt.test.js`) asserts:
```javascript
test('buildSystemPrompt with 5 players stays under 500 char budget', () => {
  const party = [
    { name: 'Aelis', race: 'Elf', charClass: 'Ranger', abilities: {...}, ac: 14, hpMax: 45 },
    { name: 'Borin', race: 'Dwarf', charClass: 'Cleric', abilities: {...}, ac: 16, hpMax: 52 },
    { name: 'Grok', race: 'Half-Orc', charClass: 'Barbarian', abilities: {...}, ac: 12, hpMax: 68 },
    { name: 'Lira', race: 'Tiefling', charClass: 'Warlock', abilities: {...}, ac: 13, hpMax: 38 },
    { name: 'Zeb', race: 'Halfling', charClass: 'Rogue', abilities: {...}, ac: 15, hpMax: 28 },
  ]
  const prompt = buildSystemPrompt({ name: 'Test', details: 'details', context: 'context', party })
  const partySection = prompt.match(/Player Characters:\n(.*)/s)?.[1] || ''
  expect(partySection.length).toBeLessThan(500)
})
```

If the budget is exceeded, trim the per-player summary (e.g. remove INT/CHA, show only STR/DEX/CON + AC/HP) or switch to a one-line-per-player format.

---

## 8. Phased Breakdown with Acceptance Criteria

### Phase 1: Data Layer — Session Payload & Character Validation

**Objective:** Extend the session payload schema (v2 → v3), implement character validation, and ensure v1/v2 backward-compat.

**Parallelizable:** Yes — pure logic, no UI or server I/O.

**Deliverables:**
- Update `src/lib/session.js`:
  - Bump `SCHEMA_VERSION` to 3.
  - Extend `serializeSession` to carry the new character fields in the party rows and add a `characters` map.
  - Update `deserializeSession` to handle v1/v2 upgrade (backfill missing character fields with defaults).
  - Ensure v1 and v2 payloads still load without throwing.
- Create `server/validateCharacter.js`:
  - Export `sanitizeCharacter(raw)` function.
  - Implement validation and clamping per §6.
  - No dependencies on other modules (pure function).
- Create `src/lib/characterValidator.js` (mirror for client-side validation, optional for this phase):
  - Export the same `sanitizeCharacter` for symmetry (so tests can import from one place).
  - Or defer client validation to Phase 2 (the server is authoritative).

**Acceptance Criteria:**
- [ ] `SCHEMA_VERSION` is 3 in `session.js`.
- [ ] `serializeSession` output includes character fields in party rows and a `characters` map (when provided).
- [ ] `deserializeSession` loads a v1 payload and produces a valid v3 output with default character fields (no throw).
- [ ] `deserializeSession` loads a v2 payload and produces a valid v3 output (no throw).
- [ ] `deserializeSession` loads a v3 payload and preserves all character data (roundtrip test).
- [ ] `sanitizeCharacter({ name: 'Alice', race: 'Elf', charClass: 'Mage', abilities: {...}, ac: 12, hpMax: 30, hpCurrent: 20 })` returns a valid character with all fields present.
- [ ] `sanitizeCharacter({ name: '<script>bad</script>', race: 'Elf', abilities: { STR: 999 }, ac: NaN, hpMax: -5 })` clamps all values (no script, STR → 10, ac → 10, hpMax → 10).
- [ ] `sanitizeCharacter` rejects unknown fields (strips them from output).
- [ ] Unit tests: `session.test.js` (migration, roundtrip), `characterValidator.test.js` (all validation edge cases).
- [ ] Existing 584 tests still pass (no regression in serialize/deserialize).

---

### Phase 2: Server-Side Join Handling & Party Hydration

**Objective:** Extend the server's `join` handler to accept, validate, and store per-player character data; hydrate the party display with character fields.

**Parallelizable:** With Phase 1 (depends on schema + validation module). Can run in parallel with Phase 3 (client-side join changes).

**Deliverables:**
- Update `server/sync-server.mjs`:
  - Extend the WebSocket `join` handler (~l.600) to accept an optional `joinCharacter` field in the payload.
  - Call `sanitizeCharacter(joinCharacter)` on the inbound payload.
  - Store the result in the room's character map (keyed by displayName): `room.characters[displayName] = sanitized`.
  - When the server creates an initial party row (or when it receives the DM's party block), backfill the character fields (race/class/abilities/ac/hpMax) from `room.characters[displayName]`.
  - On rejoin (NAME_TAKEN reconnect path): restore the player's stored character from `room.characters[displayName]` and re-send it in `session:state`.
  - Add logging (debug level) for character storage and hydration.
- Implement character persistence in `.md` store:
  - When the server writes a session to `.md` (after every action), include the full `characters` map in the serialized payload.
  - When the server reads a session from `.md` on startup or restore, the map is automatically available (Phase 1 schema change handles it).

**Acceptance Criteria:**
- [ ] Server accepts a `join` message with `joinCharacter` field and stores it without error.
- [ ] Server validates inbound character using `sanitizeCharacter` and stores only the sanitized version (security gate).
- [ ] Server rejects a `join` with oversized name (> 64 chars) or invalid ability scores (> 20) and clamps to valid range.
- [ ] Server sends `session:state` with the extended party rows (character fields included) to the joining client.
- [ ] Late joiner receives all existing players' characters via `session:state` (integration test).
- [ ] Rejoin path: a player reconnects and their stored character is restored from `room.characters[displayName]` (test with disconnect + reconnect).
- [ ] Character data is persisted to `.md` files on disk (manual check: read a `.md` after a session and verify the `characters` map).
- [ ] Unit tests: `sync-server.test.js` (join with character, validation, late join, rejoin, `.md` persist).
- [ ] Existing 584 tests still pass (no regression in `join`/`session:state` for the no-character case).

---

### Phase 3: Client-Side Join Handling & WebSocket Message Extension

**Objective:** Extend the client's `join` message to carry character data; wire the join form to accept and send the character.

**Parallelizable:** With Phase 1 (depends on schema). Can run in parallel with Phase 2 (server changes).

**Deliverables:**
- Update `src/hooks/useWebSocket.js`:
  - Extend the `join` message payload (~l.100) to include an optional `joinCharacter` field.
  - The hook receives `character` as a prop (the local `dnd_character` or `DEFAULT_CHARACTER`).
  - On WebSocket `open`, extract the synced subset from the character and send it in the `join` message.
- Update `src/components/ApiKeySetup.jsx` (Join Session tab):
  - The form already collects `roomCode` and `displayName`.
  - Add a hidden field or automatically include the player's local `dnd_character` (from localStorage or prop) when submitting the join form.
  - On form submit, pass the character to the WebSocket `join` handler (via props or callback).
- Update `src/App.jsx`:
  - When the join form submits, load the player's local `dnd_character` from localStorage (or use `DEFAULT_CHARACTER`).
  - Pass it to the connection flow (e.g. as `character` prop to the Chat component or to `useWebSocket`).
  - When the server sends `session:state` with the extended party rows, the Chat component receives the synced characters for all players (no further work needed; the party display updates automatically).

**Acceptance Criteria:**
- [ ] `useWebSocket` accepts a `character` prop and includes it in the `join` message.
- [ ] `useWebSocket` extracts the synced subset (name, race, class, abilities, ac, hpMax) from the full `dnd_character`.
- [ ] Join form (ApiKeySetup.jsx, Join tab) loads the player's local character and passes it to `useWebSocket`.
- [ ] Join message sent to the server includes `joinCharacter` with valid fields.
- [ ] On receiving `session:state`, the Chat component hydrates with the extended party rows (character fields present).
- [ ] Late joiner joins and learns all existing players' characters (integration test with Chat).
- [ ] Single-player path (no `?room=`) is unaffected (zero WebSocket created, `enabled=false` invariant preserved).
- [ ] Unit tests: `useWebSocket.test.js` (character in join message), `ApiKeySetup.test.jsx` (join form with character).
- [ ] Existing 584 tests still pass (no regression in join, routing, or SP path).

---

### Phase 4: Prompt Integration — DM Awareness of Player Stats

**Objective:** Feed the synced character data into the system prompt so the DM is aware of player class/race and ability scores.

**Parallelizable:** With Phase 1 (depends on schema). Can run in parallel with Phases 2–3 (independent of server/client join logic).

**Deliverables:**
- Update `src/lib/context.js`:
  - Modify `buildSystemPrompt({ name, details, context, party })` to accept an optional `party` array.
  - Inject a "Player Characters" summary section into the prompt, listing each player's class/race, ability scores, AC, and HP max (per §7).
  - Ensure the summary is bounded to 500 chars (cap at 5 players).
  - Preserve byte-for-byte identical behavior when `party` is undefined/null (backward-compat for existing tests).
- Mirror identical changes to `src/lib/context.starwars.js`:
  - Same `buildSystemPrompt` signature and per-player summary format (genre-neutral summary).
  - Unit test confirms both genre engines produce identical output for the same input.
- Update `src/components/Chat.jsx`:
  - When calling `sendMessage` (single-player fallback) → Ollama, pass `{ name, details, context, party }` to `buildSystemPrompt`.
  - The `party` state is already available in Chat (it's part of `session.party` from `useSessionPersistence`).
  - No changes to multiplayer (the server's DM proxy handles prompt building on the server side).

**Acceptance Criteria:**
- [ ] `buildSystemPrompt` accepts a `party` array and injects a player summary section.
- [ ] Per-player summary includes name, race, class, ability scores (with modifiers in parentheses), AC, and HP max.
- [ ] Summary is bounded to 500 chars for a 5-player party (test verifies length).
- [ ] Calling `buildSystemPrompt` without a `party` argument produces identical output to the old (pre-change) behavior (backward-compat).
- [ ] `context.js` and `context.starwars.js` both implement `buildSystemPrompt` identically (unit test compares outputs).
- [ ] Chat.jsx passes `party` to `buildSystemPrompt` on every `sendMessage` call.
- [ ] Unit tests: `context.test.js` (with/without party, budget guard, genre parity), `Chat.test.jsx` (prompt assembly).
- [ ] Existing 584 tests still pass (prompt tests may shift but must not break).

**Note:** The server-side DM proxy (Phase 3 integration, MULTIPLAYER-ARCHITECTURE.md §3) will also call `buildSystemPrompt` with the room's party; that integration is tested in Phase 5 (system integration).

---

### Phase 5: Multiplayer DM Proxy — Server-Side Prompt Assembly & Party Hydration

**Objective:** Integrate character data into the server's DM proxy (the Ollama call that happens when a multiplayer action is submitted).

**Parallelizable:** With Phases 1–4. Depends on: schema (Phase 1), server join + validation (Phase 2), prompt format (Phase 4).

**Deliverables:**
- Update `server/sync-server.mjs` (DM proxy section, ~l.700+):
  - When an `action` message arrives, construct the party array from the room's current state (party rows + stored characters).
  - Call `buildSystemPrompt({ name, details, context, party })` with the full party (imported from `context.js`).
  - Pass the prompt to the Ollama HTTP call (existing flow).
  - On receiving the DM's response (party block + narration), apply the party block to the room's party state (existing `applyPartyUpdate` call).
  - The DM has access to all players' class/race/abilities/AC, so it can narrate skill checks and combat accurately.
- Add logging (debug level) for prompt assembly so we can inspect what the DM sees.

**Acceptance Criteria:**
- [ ] Server's DM proxy builds the party array from room state and passes it to `buildSystemPrompt`.
- [ ] Prompt sent to Ollama includes all players' character data (verify via logs or a test that captures the HTTP request).
- [ ] DM response is processed normally (party block applied, narration sent to clients).
- [ ] Late-joiner scenario: a 3rd player joins mid-session; the DM's next response includes data for all 3 players.
- [ ] Forged character scenario: a client sends a 999-HP character; the server clamps it, and the DM sees the clamped value (not the forged 999).
- [ ] Test: send an action in a 5-player room and verify the prompt budget is met (< 500 chars player summary).
- [ ] Existing 584 tests still pass (no regression in Ollama calls or party block parsing).

---

### Phase 6: Integration & Backward-Compat Verification

**Objective:** Verify that single-player, multiplayer, and `.md` save/continue paths work end-to-end with character sync.

**Parallelizable:** Depends on all of Phases 1–5.

**Deliverables:**
- End-to-end tests:
  - **Single-player (no wizard, no sync):** Player boots SP, uses `DEFAULT_CHARACTER`, plays normally, saves `.md`, closes, restores `.md`, character is still there. No WebSocket.
  - **Single-player (with character wizard, no sync):** Player boots SP, runs character wizard, creates a character, plays normally, saves `.md`, restores `.md`, character is restored. No WebSocket.
  - **Multiplayer (host, no wizard):** Host creates a room (no character wizard), joins with `DEFAULT_CHARACTER`, WebSocket connects, displays `session:state`. No character in the join message (sanitizeCharacter handles null).
  - **Multiplayer (host, with wizard):** Host creates a room, runs character wizard, joins with the created character. WebSocket connects, `session:state` includes the character, late joiners see it.
  - **Multiplayer (joiner, late-join):** 2 players start a session. A 3rd player joins via `?room=` query, joins the form, submits their character (or skips and uses `DEFAULT_CHARACTER`). They receive `session:state` with the 2 existing players' characters + their own.
  - **Multiplayer (rejoin):** Player A joins a session with character X. Player A disconnects. Player A reconnects with the same `displayName` (NAME_TAKEN guard). The server restores character X from storage. Player A's character is unchanged.
  - **`.md` save/continue in multiplayer:** After the host has started a MP session (with 2 players' characters synced), the host saves `.md` file. The file includes all synced characters. The host closes the app. The host restores the `.md` file. Single-player boots, all characters are restored (verified in party display). Cannot rejoin the multiplayer room (the `.md` boots SP).
- Verify backward-compat:
  - Load a v1 `.md` file (from a pre-character-sync save). Verify it loads without error, party is displayed with default character fields, and gameplay is unaffected.
  - Load a v2 `.md` file (from a post-multiplayer-v1 save, before character sync). Verify it loads and upgrades to v3, with default character fields backfilled.
  - Existing localStorage keys (`dnd_session`, `dnd_character`, `dnd_party`) are respected and unmoved.

**Acceptance Criteria:**
- [ ] All 6 end-to-end scenarios above execute without error (integration tests or manual smoke runs).
- [ ] Backward-compat: v1 and v2 `.md` files load and display with default character fields (no throw).
- [ ] localStorage keys unchanged; no migration required for existing users.
- [ ] Existing 584 tests still pass; new tests add to the count (target: 584 + 50–80 new tests = 630+).
- [ ] Manual smoke test: Create a 5-player room, each player has a different created character, play 5 turns, verify DM narrates using player names/classes, save `.md`, restore, verify players are still there.

---

## 9. Test Plan

### Unit Tests

**`src/lib/session.test.js` (extending existing)**
- [ ] `deserializeSession` with a v1 payload (schemaVersion 1) returns a valid v3 output with default character fields (race, class, abilities, ac, hpMax).
- [ ] `deserializeSession` with a v2 payload returns a valid v3 output.
- [ ] `deserializeSession` with a v3 payload preserves all character data (roundtrip).
- [ ] `serializeSession` with party rows containing character fields preserves all fields.
- [ ] `serializeSession` with a `characters` map carries it in the output.

**`server/sync-server.test.js` (extending existing, or new file)**
- [ ] `sanitizeCharacter` clamps ability scores out of range to 10.
- [ ] `sanitizeCharacter` clamps NaN/Infinity ability to 10.
- [ ] `sanitizeCharacter` clamps AC out of range (< 5 or > 30) to 10.
- [ ] `sanitizeCharacter` clamps hpMax out of range (< 1 or > 999) to 10.
- [ ] `sanitizeCharacter` clamps hpCurrent to [0, hpMax].
- [ ] `sanitizeCharacter` truncates oversized name (> 64 chars) and race (> 32 chars) and class (> 32 chars).
- [ ] `sanitizeCharacter` strips HTML/XML special chars (`<>&"'`) from string fields.
- [ ] `sanitizeCharacter` strips control characters (Unicode category Cc).
- [ ] `sanitizeCharacter` rejects unknown fields (output only includes the 7 defined fields).
- [ ] `sanitizeCharacter(null)` returns a valid character with defaults.
- [ ] Server's `/ws` join handler accepts a `joinCharacter` field and stores it in `room.characters[displayName]`.
- [ ] Server sends `session:state` with extended party rows (character fields present).
- [ ] Late joiner receives all existing players' characters in `session:state`.
- [ ] Rejoin path: player disconnects and reconnects; stored character is restored.

**`src/lib/context.test.js` (extending existing)**
- [ ] `buildSystemPrompt` with `party: undefined` produces identical output to the old behavior (backward-compat).
- [ ] `buildSystemPrompt` with a 1-player party injects a player summary (name, race, class, abilities, AC, HP).
- [ ] `buildSystemPrompt` with a 5-player party keeps the summary under 500 chars.
- [ ] `buildSystemPrompt` with a 6-player party caps the summary at the first 5 players.
- [ ] Ability score modifiers in the summary are calculated correctly (STR 14 → +2 mod).
- [ ] `context.js` and `context.starwars.js` produce identical output for the same `buildSystemPrompt` call.

**`src/components/ApiKeySetup.test.jsx` (extending existing)**
- [ ] Join form loads the player's local `dnd_character` from localStorage.
- [ ] Join form submission passes the character to the `onSubmit` callback.
- [ ] Join form submission omits the character if it's `DEFAULT_CHARACTER` (or include it; the spec allows either).

**`src/hooks/useWebSocket.test.js` (extending existing)**
- [ ] `useWebSocket` accepts a `character` prop and includes it in the `join` message.
- [ ] `useWebSocket` extracts the synced subset (name, race, class, abilities, ac, hpMax) from the full character.
- [ ] `useWebSocket` sends `joinCharacter: null` if no character is provided.

---

### Component Tests

**`src/components/Chat.test.jsx` (extending existing)**
- [ ] Chat component passes `party` to `buildSystemPrompt` on each `sendMessage` call.
- [ ] Chat component displays extended party rows (race/class/AC visible in party header or history panel, if desired).

---

### Integration & Manual Tests

**Smoke Test Scenarios:**
- [ ] **SP no-wizard:** Boot SP, skip character wizard, play normally, verify no WebSocket (`enabled=false`).
- [ ] **SP with-wizard:** Boot SP, create character via wizard, play normally, verify character is used in party display.
- [ ] **MP host:** Host creates a room, joins with character, WebSocket opens, `session:state` received, character visible in party strip.
- [ ] **MP late-join:** 2 players in session; 3rd player joins, receives all 3 characters in `session:state`.
- [ ] **MP rejoin:** Player disconnects, reconnects with same displayName; character is restored.
- [ ] **`.md` restore SP:** Restore a `.md` file from a previous session; character is loaded into party display.
- [ ] **`.md` restore (v1/v2):** Restore an old `.md` file (pre-character-sync); verify it loads with default characters and plays normally.
- [ ] **5-player prompt budget:** Create a 5-player room, take a turn, capture the DM prompt, verify player summary is under 500 chars.
- [ ] **Forged character:** Modify a client-side character to have 999 HP or 20+ ability; verify the server clamps it and the DM sees the clamped value.

**Regression Checks:**
- [ ] Existing single-player path (no `?room=`) is unaffected: 407 tests remain green, no new WebSocket created.
- [ ] Existing multiplayer v1 path (no character sync): rooms work without character data (party rows have character fields = null or defaults).
- [ ] Existing `.md` save/continue (no character in .md file): old `.md` files load and upgrade to v3.

---

## 10. Success Criteria

- [ ] All seven sections (a–g) of the spec are complete, detailed, and unambiguous (gate G-A checklist).
- [ ] `SCHEMA_VERSION` bumped to 3 with a clear v1/v2 migration rule (test verifies both load without throw).
- [ ] Synced character subset is minimal (name, race, class, abilities, ac, hpMax) and does not bloat the wire or prompt.
- [ ] Server-authoritative validation prevents forged character data (test sends a 999-HP character; server clamps to valid range).
- [ ] Per-player character data is transmitted on `join`, persisted by the server, and available to all clients and the DM.
- [ ] DM is informed of player class/race/ability scores and uses them in narration (integration test verifies prompt includes player data).
- [ ] Single-player path (no `?room=`) remains untouched: zero WebSocket created (`enabled=false` invariant), no regression in 584 existing tests.
- [ ] Backward-compat: v1 and v2 payloads load without throwing; `.md` save/continue works for old and new files.
- [ ] Late-joiner scenario: a player joining mid-session receives all existing players' characters and is visible to the DM.
- [ ] Prompt budget guard: with 5 players, the per-player summary is under 500 chars, DM narration is not degraded.

---

## 11. Known Limitations & Deferred Scope

- **Mid-session character edits:** Deferred to Phase 2 (future). A player cannot change their ability scores, AC, or HP max after the session starts (immutable on join). The DM's party block governs in-combat HP (hpPct); the synced hpMax is read-only.
- **Multi-classing / leveling:** Out of scope. Characters have a single `charClass` and no XP/level tracking.
- **Character persistence across sessions:** Out of scope. Characters are per-session (tied to the room). A player joining a new room starts with `DEFAULT_CHARACTER` unless they create a new character via the wizard.
- **Character edit UI during play:** Deferred. The local `dnd_character` sheet is editable (CharacterPanel) but those edits do not sync (local view only).
- **Ability score modifiers in the prompt:** The DM is given raw ability scores (e.g. STR 14); the DM can calculate modifiers inline (straightforward math, tested in QA).

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **Synced character** | The subset of a character that travels on the wire: name, race, class, abilities, ac, hpMax. |
| **Local character** | The full character sheet stored in `dnd_character` localStorage (client-only, not synced). |
| **Party row** | A single entry in the `party` array in the synced session state; now carries both display fields (name/role/hpPct/isActive) and character fields (race/class/abilities/ac/hpMax). |
| **`joinCharacter`** | The optional character payload sent by a client in the `join` WebSocket message. |
| **`sanitizeCharacter`** | Server-side validation function that clamps and validates inbound character data. |
| **Backward-compat** | v1 and v2 session payloads must deserialize without throwing; old `.md` files must load and upgrade to v3. |
| **Source-of-truth** | The server is authoritative for all synced character fields; the client trusts the server's version. |
| **Token/char budget** | The 500-char limit on the per-player summary in the DM prompt (5 players max). |
| **Late joiner** | A player who joins a session after play has started; they receive `session:state` with all existing players' characters. |
| **Rejoin** | A player who disconnects and reconnects with the same `displayName`; the server restores their stored character. |
