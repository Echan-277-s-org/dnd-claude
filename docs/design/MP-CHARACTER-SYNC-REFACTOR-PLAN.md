# MP Character Sync — Refactor Plan

**Status:** Ready for implementation  
**Author:** refactoring-specialist  
**Date:** 2026-05-26  
**Branch:** `feature/mp-character-sync`  
**Blocks:** Phase 4 (prompt integration) and Phase 5 (server DM proxy + mid-session HP)

This plan locks the two cross-cutting refactors that must be agreed before implementation begins.
It does not touch any other code. The implementers (game-developer, websocket-engineer) follow this
plan exactly; any deviation is a loop-back, not a local judgement call.

---

## Refactor 1 — `buildSystemPrompt` Signature Extension

### Scope

Two files change. No other files are touched by this refactor in isolation:

- `src/lib/context.js` — `buildSystemPrompt` (line 14)
- `src/lib/context.starwars.js` — `buildSystemPrompt` (line 18)

Two call sites are threaded at the same time as Phase 4 / Phase 5 implementation (not as part of
this refactor alone, but specified here so the implementers know what to pass):

- `src/components/Chat.jsx` line 324 — single-player path
- `server/sync-server.mjs` line 426 — server DM-proxy path

### New Signature

```js
// Both engines — identical parameter list
export function buildSystemPrompt({ name, details, context, players } = {}) { ... }
```

`players` is `undefined` when not passed (callers that pass `campaign` unchanged remain valid). The
parameter is positional-destructured in the same object as `name`/`details`/`context`, so existing
call sites that pass `buildSystemPrompt(campaign)` continue to compile and run without change —
`players` is simply `undefined` inside the function.

### Hard Invariant: Byte-Identical Output When `players` Is Absent or Empty

The ONLY permitted guard is:

```js
if (players?.length) {
  // append the "Player Characters:" section
}
```

Both `players === undefined` and `players = []` must produce output byte-identical to today's
function. This protects all existing `context.test.js` tests (PP-05/PP-06 and the full-prompt
snapshot tests) without modification.

DO NOT use `players == null` or `players !== undefined` — these would behave differently for an
empty array, which must also be treated as "no players" and must not append the section.

### `players` Entry Shape the Engines Consume

The game-developer assembles this shape at each call site before calling `buildSystemPrompt`. The
engines receive it already assembled — they do not look up anything themselves.

```ts
// One entry per player. Built by the call site from two sources:
// characters[displayName] (static, set at join) + party row (live, per turn).
type PlayerEntry = {
  name: string          // character name (from characters map)
  race: string          // e.g. "Elf", "Twi'lek"
  charClass: string     // e.g. "Ranger", "Scoundrel"
  abilities: {          // raw scores (from characters map)
    STR: number
    DEX: number
    CON: number
    INT: number
    WIS: number
    CHA: number
  }
  ac: number            // from characters map
  hpMax: number         // from characters map
  hpCurrent: number     // DERIVED at call site: Math.round(hpPct / 100 * hpMax)
  conditions: string[]  // from party row (see Refactor 2)
}
```

The engines treat every field as already-validated. They do not clamp, sanitize, or default —
sanitization happens at the server boundary (`sanitizeCharacter`) and at the derivation site.

### Section Format Contract

The game-developer writes the actual section text content. This refactor specifies only the
structural contract the engines must satisfy:

1. The "Player Characters:" section is inserted at the END of the existing prompt string,
   immediately before the final `Stay in the DM role.` / `Stay in the Game Master role.` sentence
   (i.e., appended after all rules paragraphs but before that closing line). The structured-block
   instructions must remain the LAST substantive block; the player section comes before them in the
   prompt but after the role/formatting guidelines.

   Concretely, the existing `return` template literal is split so the section can be inserted. One
   safe approach is a local variable:

   ```js
   const playerSection = players?.length
     ? buildPlayerSection(players)  // game-developer writes this helper
     : ''
   return `...existing prompt up to the closing sentence...${playerSection}

   Stay in the DM role. Make every choice feel meaningful. Keep the adventure moving.`
   ```

   The exact position in the string is: after all structured-block worked examples, before the
   closing "Stay in" sentence. This keeps the DM persona line as the final instruction, which
   model-compliance testing (PARTY-HUD-QWEN-VALIDATION.md) has shown is important for instruction
   adherence.

2. Budget guard — the game-developer's `buildPlayerSection` helper MUST enforce:
   - Maximum 5 players: `players.slice(0, 5)` before iterating (silently drops extras).
   - Total section length (header + all player lines) MUST be <= 500 characters. A unit test
     (new, in `context.test.js`) asserts this with a 5-player worst-case input (long names,
     long race/class strings). If the format naturally stays under 500 chars, no truncation
     logic is needed — but the test is mandatory regardless.

3. Modifier sign formatting — the spec's pseudocode was wrong. Use:

   ```js
   function fmtMod(score) {
     const mod = Math.floor((score - 10) / 2)
     return mod >= 0 ? `+${mod}` : `${mod}`
   }
   ```

   This is the same formula already in `CharacterPanel.jsx` line 15 (`modifier` function) — the
   game-developer should extract or mirror it, not reinvent.

4. Genre parity — the two engines must produce byte-identical output for the player section given
   the same `players` input. The game-developer writes `buildPlayerSection` once and imports it into
   both context files, OR copies the implementation literally. Either is acceptable; what is NOT
   acceptable is two independently-written formatters that happen to produce the same output today
   but can drift. The section-level parity test in `context.test.js` must call `buildSystemPrompt`
   from both engines and assert strict equality of the extracted player section.

### Call Site Specifications

**`src/components/Chat.jsx` line 324 — single-player path**

Current code:
```js
const systemPrompt = buildSystemPrompt(campaign)
```

Change to:
```js
// `party` and `characters` come from component state (already available in Chat.jsx scope).
// characters is the session.characters map: { [displayName]: SyncedCharacter }
// party is the DM-managed party array: PartyRow[]
const players = buildPlayersForPrompt(characters, party)
const systemPrompt = buildSystemPrompt({ ...campaign, players })
```

`buildPlayersForPrompt` is a pure helper (game-developer writes it, lives in `src/lib/session.js`
or a new `src/lib/characterUtils.js`) that:
- iterates `Object.entries(characters)`
- for each `[displayName, char]`, finds the matching party row by name-match (same normalization as
  `applyPartyUpdate`: `String(name).trim().toLowerCase()`)
- derives `hpCurrent = Math.round((row?.hpPct ?? 100) / 100 * char.hpMax)`
- reads `conditions` from the party row (defaults to `[]` if absent)
- returns a `PlayerEntry[]` sorted by party-row order (preserves DM-defined turn order)

When `characters` is `{}` or `undefined` (single-player with no character sync), `buildPlayersForPrompt`
returns `[]`, and `players?.length` is falsy, so the prompt is byte-identical to today.

**`server/sync-server.mjs` line 426 — server DM-proxy path**

Current code:
```js
const systemPrompt = engine.buildSystemPrompt(room.campaign ?? {})
```

Change to:
```js
const players = buildPlayersForPrompt(room.characters ?? {}, room.party ?? [])
const systemPrompt = engine.buildSystemPrompt({ ...(room.campaign ?? {}), players })
```

`buildPlayersForPrompt` is the same pure helper imported from wherever the game-developer places it.
On the server, `room.characters` is the `{ [displayName]: SyncedCharacter }` map populated at join;
`room.party` is the current DM-managed party array. When `room.characters` is empty (legacy room
with no character sync), `players` is `[]` and the server prompt is byte-identical to today.

### Implementation Checklist — Refactor 1

- [ ] `buildSystemPrompt` in `src/lib/context.js` accepts `players` in destructure, default `undefined`
- [ ] `buildSystemPrompt` in `src/lib/context.starwars.js` accepts `players` in destructure, default `undefined`
- [ ] Both engines: guard is `players?.length` (not `players != null`, not `players !== undefined`)
- [ ] Both engines: player section inserted before closing "Stay in …" sentence, after all worked examples
- [ ] `buildPlayerSection` helper: caps at 5 players, uses `fmtMod` formula, total <= 500 chars
- [ ] Section is byte-identical between the two engines for the same input (shared helper or literal copy)
- [ ] `buildPlayersForPrompt` pure helper written; handles missing character, missing party row, missing conditions
- [ ] `Chat.jsx` line 324: passes `players` derived from `characters` state + `party` state
- [ ] `sync-server.mjs` line 426: passes `players` derived from `room.characters` + `room.party`
- [ ] New test: `context.test.js` — `buildSystemPrompt` without `players` produces output byte-identical to snapshot
- [ ] New test: `context.test.js` — 5-player section stays under 500 chars
- [ ] New test: `context.test.js` — section-level genre parity (both engines produce identical player section)
- [ ] New test: `context.test.js` — `players: []` also byte-identical to no-players output
- [ ] All existing `context.test.js` tests pass without modification (zero snapshot updates for the no-players case)

---

## Refactor 2 — Party Row / Character Model Extension

### Scope

One file changes for the model itself:

- `src/lib/session.js` — `applyPartyUpdate` (lines 54–69)

One file is read-only relative to this refactor but must be understood:

- `src/components/CharacterPanel.jsx` — HP display and conditions UX

Two files gain read-only mirroring behavior driven by this model change (owned by game-developer /
react-specialist — specified here so they know the contract):

- `src/components/CharacterPanel.jsx` — HP becomes a mirror in multiplayer
- `src/components/PartyStrip.jsx` — conditions display (if added, Phase 5 fast-follow)

### Party Row Shape: Only One Addition

The party row gains a single optional field. ALL existing fields are unchanged:

```ts
type PartyRow = {
  // UNCHANGED — do not modify these
  id: string          // stable React key, preserved by name-match in applyPartyUpdate
  name: string
  role: string
  hpPct: number       // 0–100, DM-controlled
  isActive: boolean

  // NEW — additive only
  conditions: string[]  // DM-managed; [] when absent
}
```

Static character fields (race, charClass, abilities, ac, hpMax) do NOT go on the party row. They
live in the separate `characters: { [displayName]: SyncedCharacter }` map. `applyPartyUpdate` never
sees them and must not add them. This is the key correction over the spec's §2 (the plan at
`MP-CHARACTER-SYNC-PLAN.md` §Corrections already overrides the spec on this point).

### `applyPartyUpdate` Normalization — Exact Rules

The updated function body for the `conditions` field (all other logic unchanged):

```js
export function applyPartyUpdate(rawArray, existing) {
  const prev = Array.isArray(existing) ? existing : []
  return (Array.isArray(rawArray) ? rawArray : []).map(raw => {
    const normalizedName = String(raw?.name ?? '').trim().toLowerCase()
    const found = prev.find(
      e => String(e?.name ?? '').trim().toLowerCase() === normalizedName
    )

    // Normalize conditions: coerce to array, trim each entry, drop empties,
    // cap at 10 entries, cap each entry at 64 chars, default [].
    // Source: raw (DM-emitted) takes precedence over found (existing row).
    // When raw.conditions is absent/null/non-array, preserve found.conditions
    // (so a DM response that omits the field does not wipe active conditions).
    const rawConditions = raw?.conditions
    let conditions
    if (Array.isArray(rawConditions)) {
      conditions = rawConditions
        .map(c => String(c ?? '').trim().slice(0, 64))
        .filter(c => c.length > 0)
        .slice(0, 10)
    } else {
      // DM omitted conditions field — preserve whatever was there before
      conditions = Array.isArray(found?.conditions) ? found.conditions : []
    }

    return {
      id: found?.id ?? crypto.randomUUID(),
      name: String(raw?.name ?? '').trim() || 'Unknown',
      role: String(raw?.role ?? '').trim() || '',
      hpPct: Math.max(0, Math.min(100, Math.round(Number(raw?.hpPct) || 0))),
      isActive: Boolean(raw?.isActive),
      conditions,
    }
  })
}
```

Normalization rules summarized:
- **Coerce:** `raw.conditions` must be an `Array` — anything else (string, null, undefined, object)
  is treated as absent and triggers the "preserve existing" path.
- **Trim:** each element `String(c ?? '').trim()`.
- **Drop empties:** `.filter(c => c.length > 0)` after trim.
- **Cap count:** `.slice(0, 10)` — maximum 10 active conditions per party member.
- **Cap length:** `.slice(0, 64)` per entry — prevents runaway condition strings.
- **Default:** `[]` when no prior value exists.
- **Preservation semantics:** when the DM emits a party block that OMITS `conditions` (as all
  current DM responses do, since the field is new), existing conditions are preserved. This is
  critical: the first time a DM response adds conditions, it must emit the array explicitly; omission
  is "no change", not "clear all conditions".

### `hpPct` / `hpCurrent` Derivation — Where It Happens

`hpCurrent` is NEVER stored in the party row. It is derived on demand at exactly two points:

1. **DM prompt assembly** (in `buildPlayersForPrompt`, specified in Refactor 1 above):
   ```js
   hpCurrent = Math.round((partyRow?.hpPct ?? 100) / 100 * char.hpMax)
   ```
   Uses the party row's `hpPct` (0–100, DM-managed) and the static `hpMax` from the `characters`
   map. When `hpPct` is 0, `hpCurrent` is 0; when the party row is missing (character joined but
   no DM response yet), `hpPct` defaults to 100, yielding `hpCurrent = hpMax`.

2. **CharacterPanel HP mirror in multiplayer** (react-specialist owns the UI work):
   When the component is in "synced HP" mode (i.e., a `roomCode` is set and a matching party row
   exists), the displayed `hpCurrent` is:
   ```js
   Math.round((syncedHpPct / 100) * character.hpMax)
   ```
   where `syncedHpPct` comes from the party row for this player's displayName, and `character.hpMax`
   comes from the local character sheet (which holds the static hpMax from join time).

   The local `character.hpCurrent` in `dnd_character` (localStorage) is NOT updated by the server.
   Only the display value is derived. The InlineEdit control for HP current becomes read-only in
   this mode (no `onClick` handler, no `setCharacter` call for `hpCurrent`).

### Source-of-Truth Rule (CharacterPanel Behavior in a Room)

| Field | Single-player | In a room (roomCode set) |
|---|---|---|
| hpCurrent display | local `character.hpCurrent` (editable) | `round(syncedHpPct/100 * character.hpMax)` (read-only mirror) |
| hpMax | local (editable) | local (editable — hpMax is set at join, not DM-managed) |
| conditions (CharacterPanel) | local (editable, independent) | local (editable, independent — CharacterPanel conditions are the player's own tracking, separate from DM-managed party row conditions) |
| ac, initiative, speed | local (editable) | local (editable) |
| name, race, charClass, abilities | local (editable) | local (editable) |

The party row's `conditions` (DM-managed) and `CharacterPanel`'s `conditions` (player-managed) are
two separate things. The CharacterPanel conditions are NOT replaced by the party row conditions. The
DM's conditions appear in the PartyStrip / HistoryPanel party view; the local conditions in
CharacterPanel are the player's own bookkeeping for non-synced status. This distinction must be
preserved — do not merge these two arrays.

### `serializeSession` / `deserializeSession` Impact

`conditions` on party rows is carried automatically by the existing serialize/deserialize logic
because both functions pass `party: Array.isArray(party) ? party : []` without field-picking —
the entire row object is round-tripped. No changes to `serializeSession` or `deserializeSession`
are needed for `conditions` alone.

The game-developer handles the SCHEMA_VERSION bump (2 → 3) and `characters` map in Phase 1 as a
separate concern. When the game-developer writes the v1/v2 migration in `deserializeSession`, the
migration path must not strip `conditions` off party rows loaded from v3 files (it must pass them
through unchanged). Since the migration only adds defaults to MISSING fields (and `conditions` is
new/optional), this is naturally satisfied — no special handling is needed.

### `toMarkdown` Impact

`partyTable` in `session.js` (line 198) currently renders only `name`, `role`, `hpPct`, `isActive`.
The game-developer may optionally extend it to include a conditions column for human readability of
the `.md` file, but this is cosmetic — the authoritative machine payload in the ` ```session ` block
already carries the full party array including `conditions` automatically.

### Implementation Checklist — Refactor 2

- [ ] `applyPartyUpdate` in `src/lib/session.js` updated per the exact normalization rules above
- [ ] `conditions` is coerced/trimmed/filtered/capped as specified (not just spread from raw)
- [ ] When `raw.conditions` is absent/non-array, existing conditions are preserved (not wiped)
- [ ] All five existing fields (id, name, role, hpPct, isActive) are unchanged
- [ ] `conditions` defaults to `[]` when the party row is brand new (no `found` match)
- [ ] `hpCurrent` is NEVER added to the party row by `applyPartyUpdate` or anywhere else
- [ ] `buildPlayersForPrompt` derives `hpCurrent` from `hpPct × hpMax` (Refactor 1 call site)
- [ ] `CharacterPanel` hpCurrent becomes read-only mirror when `roomCode` is set (react-specialist)
- [ ] CharacterPanel conditions remain independent (player-managed, not overwritten by DM conditions)
- [ ] New tests: `session.test.js` — `applyPartyUpdate` with conditions present in raw
- [ ] New tests: `session.test.js` — `applyPartyUpdate` with conditions absent in raw (preserves existing)
- [ ] New tests: `session.test.js` — `applyPartyUpdate` strips empties, trims entries
- [ ] New tests: `session.test.js` — `applyPartyUpdate` caps at 10 conditions
- [ ] New tests: `session.test.js` — `applyPartyUpdate` caps condition string length at 64 chars
- [ ] New tests: `session.test.js` — `applyPartyUpdate` coerces non-array `conditions` to preserve path
- [ ] New tests: `session.test.js` — round-trip serialize → deserialize preserves `conditions` array
- [ ] All existing `applyPartyUpdate` tests pass without modification

---

## Ordering Constraints and Risks

### Phase Ordering

```
Phase 0 (this plan)
  └─► Phase 4 (prompt integration — game-developer)
        requires: Refactor 1 signature + `buildPlayersForPrompt` helper
  └─► Phase 5 (server DM proxy — game-developer + websocket-engineer)
        requires: Phase 4 complete + Phase 2 (room.characters populated)
  └─► Phase 1 (data layer — game-developer)
        schema bump + characters map in session.js; independent of this refactor
        but `deserializeSession` must not strip conditions from party rows
```

Phase 1 (schema bump + `characters` map) is independent of this refactor and can run in parallel.
However: if Phase 1 modifies `deserializeSession` to filter party row fields, it must preserve
`conditions`. The game-developer must be aware of this dependency.

### Risk: Conditions Preservation on DM Response

The "preserve existing when absent" rule in `applyPartyUpdate` is the most fragile part of this
refactor. The LLM will not emit `conditions` in party blocks today (the field is new). If the
guard used `raw.conditions ?? []` instead of the array-check path, conditions would be wiped on
every DM response. The implementer must use the exact `Array.isArray(rawConditions)` check
specified above — a test must cover this explicitly (see checklist item: "conditions absent in raw
preserves existing").

### Risk: `buildSystemPrompt` Call in `stress-test/harness.mjs`

`context.js` is also imported by `stress-test/harness.mjs` (per the file's header comment, line 5).
The new signature is backward-compatible (extra optional destructure key), so no change to the
harness is needed. Confirm this by checking whether the harness calls `buildSystemPrompt(campaign)`
directly — if so, it continues to work without change.

### Risk: Test Snapshot Drift

`context.test.js` likely has snapshot tests or exact string assertions on `buildSystemPrompt` output.
The byte-identical invariant means these tests MUST continue to pass without updating snapshots.
If any test passes a `campaign` object with extra unknown keys (e.g., a test that passes
`{ name, details, context, someOtherField }`), it is still safe — unknown keys are ignored by
destructuring. The only risk is if a test currently passes an object that happens to have a `players`
key, which is extremely unlikely but the implementer should grep for it.

### Risk: `CharacterPanel` Conditions Namespace Collision

`CharacterPanel.jsx` already has a `CONDITIONS` constant and a `toggleCondition` function that
writes `character.conditions` to localStorage. The DM-managed `conditions` on the party row are a
different thing and must never overwrite `character.conditions`. The naming is unfortunately
identical. The react-specialist must not introduce any code path that copies `partyRow.conditions`
into `character.conditions`. When displaying DM conditions, use a separate prop/display path.

---

## What This Plan Does NOT Cover

The following are owned by other agents and are out of scope for this refactor plan:

- The actual text content of the "Player Characters:" section (game-developer, Phase 4)
- `sanitizeCharacter` function (game-developer, Phase 1)
- `characters` map in session payload, `serializeSession`, `deserializeSession` schema bump (game-developer, Phase 1)
- `joinCharacter` on the WS `join` message (websocket-engineer, Phase 2/3)
- `room.characters` storage on the server (websocket-engineer, Phase 2)
- Join-tab UX and CharacterWizard `.md` import (react-specialist, Phase 3)
- Mobile responsiveness (react-specialist, Phase 3)
- Server DM-proxy `room.characters` population (websocket-engineer, Phase 2)
- `session:state` / `session:update` broadcast changes (websocket-engineer, Phase 2)
