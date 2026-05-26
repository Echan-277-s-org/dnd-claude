# Character Wizard + SP/MP Toggle — Feature Specification

**Status:** Scoped  
**Author:** Project Manager  
**Date:** 2026-05-26  
**Epic:** Setup Screen Improvements (Character Creation & Explicit Mode Toggle)

---

## 1. Overview

Two additions to the login/setup screen (`src/components/ApiKeySetup.jsx`, exported as `CampaignSetup`):

1. **Guided Character Wizard** — A multi-step form (name → race/species → class → ability scores → review) that seeds `DEFAULT_CHARACTER` and the LLM-driven party display cache with playable defaults. Genre-aware (D&D 5e vs Star Wars d20).

2. **Explicit Single-Player / Multiplayer Toggle** — A segmented control at the top of the "New Campaign" tab that replaces the implicit mode (blank display name = SP, filled = MP). The toggle makes the mode explicit, revealing/hiding relevant fields (host vs join).

---

## 2. Phased Breakdown

### Phase 1: Data Layer — Genre-aware Class/Race Definitions

**Objective:** Make race/class/species data available to the wizard without breaking existing code.

**Deliverables:**
- Create `src/lib/characterClasses.js` with:
  - `DND_CLASSES` (Fighter, Rogue, Cleric, Wizard, etc. — 12 standard 5e classes)
  - `DND_RACES` (Human, Elf, Dwarf, Tiefling, etc. — 10 standard 5e races)
  - `STARWARS_CLASSES` (Soldier, Scoundrel, Scholar, Jedi, etc. — 6 d20 Saga Edition classes)
  - `STARWARS_SPECIES` (Human, Twi'lek, Wookiee, Droid, etc. — 8 d20 species)
- Each class record: `{ id, label, hpBase, hitDieSize, quickAbilities? }`
  - Example: `{ id: 'fighter', label: 'Fighter', hpBase: 10, hitDieSize: 10, quickAbilities: { STR: 2, CON: 1 } }`
- Each race record: `{ id, label, abilityBonuses? }`
  - Example: `{ id: 'human', label: 'Human', abilityBonuses: { STR: 1, CON: 1 } }`
- Add a `getClassesForGenre(genreId)` and `getRacesForGenre(genreId)` export.
- Update `src/lib/genres.js` to re-export these helpers (one-line accessors per genre) — no breaking changes to existing genre structure.

**Acceptance Criteria:**
- [ ] All 12 D&D classes and 10 races can be imported and used.
- [ ] All 6 Star Wars classes and 8 species can be imported and used.
- [ ] `getClassesForGenre('dnd')` returns D&D classes; `getClassesForGenre('starwars')` returns SW classes.
- [ ] Each class has a valid `hpBase` (8–12) and `hitDieSize` (6–12).
- [ ] Unit tests: genre data integrity (no missing fields, correct counts).

**Risk:** None — pure data layer, no integration until Phase 2.

---

### Phase 2: Ability Score Math — Point-Buy & Roll Systems

**Objective:** Implement D&D 5e point-buy and array/roll mechanics; simple equivalent for Star Wars.

**Deliverables:**
- Create `src/lib/abilityScoreMath.js` with:
  - `POINT_BUY_STANDARD` — D&D 5e 27-point budget, rules object:
    - Base 8 for all 6 abilities.
    - Cost table: 9→1pt, 10→2pt, 11→3pt, 12→4pt, 13→5pt, 14→7pt, 15→9pts (max).
    - Total budget: 27 points after base 8.
  - `STANDARD_ARRAY` — D&D 5e predefined: `[15, 14, 13, 12, 10, 8]` (player assigns to abilities).
  - `ROLL_4D6_DROP_LOWEST` — Generate 6 rolls: roll d6×4, drop the lowest, sum remainder; repeat 6×, player assigns to abilities.
  - `STARWARS_SIMPLE_BUILD` — Simple d20 equivalent (no point-buy complexity; three presets: balanced, strong, quick).
  - Point-buy validation function: `validatePointBuy(abilityScores) → { valid: bool, spent: int, remaining: int, errors: string[] }`
  - Roll generator: `roll4d6DropLowest() → [roll1, roll2, roll3, roll4, roll5, roll6]`
  - Apply ability bonuses from race: `applyRaceBonus(base, raceId, genreId) → { STR, DEX, ... }`

**Acceptance Criteria:**
- [ ] Point-buy budget validation rejects invalid allocations (overspendt, ability > 15).
- [ ] Standard array picker (UI chooses which roll → which ability) is functional.
- [ ] 4d6 roller generates 6 rolls; drop-lowest logic correct (tested with fixed RNG seed).
- [ ] Race bonuses (+1/+2) are applied post-assignment without exceeding bounds.
- [ ] Star Wars simple presets generate sensible starting ability arrays.
- [ ] Unit tests: point-buy math, race bonus application, roll generation (mocked crypto.getRandomValues).

**Risk:** Math errors in point-buy cost table or roll logic → rebalance via tuning tests before Phase 3.

---

### Phase 3: Wizard Component & Integration

**Objective:** Build the multi-step wizard UI and wire it into the setup screen.

**Deliverables:**
- Create `src/components/CharacterWizard.jsx`:
  - State shape: `{ step, name, race, charClass, abilityMethod, abilityScores, ... }`
  - Steps (sequential; no back button, but review screen before commit):
    1. **Name** — text input (required, 1–64 chars).
    2. **Race/Species** — dropdown (genre-driven; none selected → error).
    3. **Class** — dropdown (genre-driven; none selected → error).
    4. **Ability Method** — radio buttons (D&D: "Point Buy", "Standard Array", "Roll 4d6"; SW: "Balanced", "Strong", "Quick").
    5. **Ability Assignment** — interactive grid or drag-drop (D&D point-buy: click to increment/decrement with budget feedback; array/roll: drag values to ability columns).
    6. **Review** — read-only summary: name, race, class, final abilities + modifiers; "Create" or "Back" buttons.
  - On "Create": callback `onCreateCharacter({ name, race, charClass, abilities })` (no ID, no HP yet).
  - On "Cancel" or back from wizard: close wizard, restore UI to initial state.
  - Clear styling that fits the existing setup-card theme (no modal overlay; inline under the toggle or in a dedicated section).

**Acceptance Criteria:**
- [ ] All 6 steps render correctly.
- [ ] Genre change (App.jsx → onGenreChange) updates race/class dropdowns in real-time (no stale data).
- [ ] Point-buy UI shows remaining budget and prevents overspending.
- [ ] Standard array picker is drag-or-click assignable; final result is correct.
- [ ] 4d6 rolls display all 6 results and allow reassignment (drag).
- [ ] Review screen shows final ability scores + modifiers (using existing `modifier()` logic from CharacterPanel).
- [ ] "Create" callback is only invoked when review is confirmed.
- [ ] Escape key or cancel button closes wizard without side effects.

**Risk:** Complex stateful UI — test heavily with multiple genre/ability-method combinations.

---

### Phase 4: SP/MP Toggle Integration (Setup Screen Refactor)

**Objective:** Make single-player vs multiplayer selection explicit, restructure the form layout.

**Deliverables:**
- Refactor `src/components/ApiKeySetup.jsx`:
  - **New top-level section** in "New Campaign" tab: **Segmented control** with two buttons: "Single-Player" and "Multiplayer" (aria-pressed pattern).
  - **Single-Player mode** reveals:
    - Character Wizard button ("Create a Character" or "Skip") — optional.
    - If skipped, `DEFAULT_CHARACTER` is used as-is.
  - **Multiplayer mode** reveals:
    - Character Wizard button (same optional behavior).
    - "Host Display Name" field (was previously "Your Name" with the implicit blank=SP rule).
  - **Campaign Details section** (Genre, Model, Campaign Name, Details, Notes file) remains **visible in both modes** and unchanged in layout.
  - Update form submission:
    - `handleSubmit({ genre, name, details, model, context, displayName, character? })` — pass the created character if wizard was used, otherwise omit (defaults to `DEFAULT_CHARACTER`).
  - Update App.jsx `handleSetup` to accept and store the optional `character` parameter:
    - If provided, seed `character` state + `dnd_character` localStorage.
    - If omitted, use existing `loadCharacter()` → `DEFAULT_CHARACTER` fallback (backward-compat).
  - **Preserve existing contracts:**
    - `displayName: null` ⇒ single-player (no roomCode, no WS opened).
    - `displayName: string` ⇒ host multiplayer (derive roomCode via `makeRoomCode(sessionId)`).
    - `?room=` URL param behavior unchanged (pre-selects "Join Session" tab).
    - `.md` file restore unchanged (boots single-player, existing character sheet if present in file).

**Acceptance Criteria:**
- [ ] SP/MP toggle is visible and functional; toggling shows/hides correct fields.
- [ ] Character wizard button present in both SP and MP modes.
- [ ] Wizard skip path works: no wizard → default character used.
- [ ] Wizard create path works: wizard output → seeded character + party display.
- [ ] Form submission preserves all three modes: SP (no wizard), SP (with wizard), MP.
- [ ] `handleSetup` receives `character` and stores to `dnd_character` localStorage when present.
- [ ] Existing "Join Session" tab behavior unchanged.
- [ ] Existing `.md` restore behavior unchanged.
- [ ] All existing tests still pass (routing, localStorage keys, multi-tab behavior).

**Risk:** Scope creep in UI layout — keep wizard integrated inline, not modal; use existing form styles.

---

### Phase 5: Derived Stats & Character Seeding

**Objective:** Calculate HP, AC, Initiative from class, ability scores, and race; populate character object fully.

**Deliverables:**
- Create `src/lib/characterBuilder.js`:
  - `buildCharacter(wizardOutput, genreId) → CHARACTER_OBJECT`
    - Input: `{ name, race, charClass, abilities }`
    - Output: `{ name, race, charClass, hpCurrent, hpMax, ac, initiative, speed, abilities, conditions: [] }`
    - HP calculation: `hpBase (from class) + CON modifier`
    - AC calculation: 10 + DEX modifier (simple baseline; no armor, future enhancement).
    - Initiative: DEX modifier (D&D standard).
    - Speed: 30 (D&D), 6 squares (SW) — hardcoded per genre or class-based.
    - Conditions: always empty array (player starts fresh).
  - Fallback: if no wizard output, return `DEFAULT_CHARACTER` unchanged.
  - Unit test cases: verify HP floors to 1 (even with negative CON mod), AC is >= 10, initiative works with negative mods.

**Acceptance Criteria:**
- [ ] `buildCharacter` accepts wizard output and produces a valid `CHARACTER_OBJECT`.
- [ ] HP is `max(1, hpBase + CON mod)` (no negative HP).
- [ ] AC is 10 + DEX mod (or class-adjusted if future-proofing is desired).
- [ ] Initiative equals DEX modifier.
- [ ] When no character is passed, returns `DEFAULT_CHARACTER`.
- [ ] Unit tests validate math edge cases (low CON, high DEX, etc.).

**Risk:** AC and speed are simplified (no armor complexity); document as v1 scope.

---

### Phase 6: Party Display Seeding

**Objective:** Initialize the LLM-driven party cache with the created character.

**Deliverables:**
- Update App.jsx `handleSetup`:
  - When character is provided, derive a `DEFAULT_PARTY` entry:
    ```javascript
    [{
      id: 'seed-0',
      name: character.name,
      role: character.charClass,
      hpPct: 100,
      isActive: true,
    }]
    ```
  - Store to `dnd_party` localStorage alongside `dnd_character`.
  - This becomes the initial display cache; the LLM overwrites it after the first response.
- Preserve existing `loadParty()` behavior (no changes to the migration logic).

**Acceptance Criteria:**
- [ ] Created character name appears in the party display on first boot.
- [ ] Party cache initializes correctly when character is passed.
- [ ] Party cache falls back to `DEFAULT_PARTY` when no character is created.
- [ ] Existing migration logic (dnd_character → dnd_party) still works.

**Risk:** Low — touches existing party seeding, not the LLM integration.

---

## 3. Data Model Decisions

### Character Representation

The `CHARACTER_OBJECT` shape is **unchanged**:
```javascript
{
  name: string,
  race: string,           // 'Human', 'Elf', 'Twi\'lek', etc.
  charClass: string,      // 'Fighter', 'Scoundrel', etc.
  hpCurrent: number,
  hpMax: number,
  ac: number,
  initiative: number,
  speed: number,
  abilities: {
    STR: number,
    DEX: number,
    CON: number,
    INT: number,
    WIS: number,
    CHA: number,
  },
  conditions: string[],
}
```

### Class & Race Data Structure

**D&D 5e Classes** (from PHB):
- Fighter, Rogue, Cleric, Wizard, Barbarian, Bard, Druid, Monk, Paladin, Ranger, Warlock, Sorcerer
- Each has `hpBase` (8 or 10) and `hitDieSize` (6, 8, 10, or 12).
- HP = hpBase + CON mod (no multiclassing; simplified).

**D&D 5e Races** (core):
- Human, Elf (High/Wood/Dark), Dwarf, Halfling, Dragonborn, Gnome, Half-Elf, Half-Orc, Tiefling
- Ability bonuses: +1 or +2 per ability, max +3 to one ability (variant human).

**Star Wars d20 Saga Classes** (simplified):
- Soldier, Scoundrel, Scout, Jedi, Smuggler, Gunslinger
- HP per level: 6–8.

**Star Wars Species**:
- Human, Wookiee, Twi'lek, Bothan, Droid, Mon Calamari, Ewok, Zabrak
- Ability bonuses: +2 to one ability per species.

### Ability Score Methods

**D&D:**
1. **Point Buy** (27-point budget) — standard 5e rule.
2. **Standard Array** — `[15, 14, 13, 12, 10, 8]` (player assigns).
3. **Roll 4d6 Drop Lowest** — 6 rolls, each roll is 4d6, drop the lowest die, sum the remainder. Player assigns rolls to abilities.

**Star Wars (Simplified):**
1. **Balanced** — `[12, 12, 12, 11, 10, 9]` (distributed, no specialization).
2. **Strong** — `[14, 13, 12, 10, 10, 8]` (focus on strength).
3. **Quick** — `[13, 13, 12, 11, 9, 8]` (focus on dexterity).

All methods apply race bonuses **after** assignment.

### HP & AC Derivation (v1)

- **HP**: `hpBase (from class) + CON modifier`, floored at 1.
- **AC**: `10 + DEX modifier` (no armor; future enhancement).
- **Initiative**: DEX modifier.
- **Speed**: 30 ft (D&D) or 6 squares (Star Wars) — constant per genre.

---

## 4. UX Flow & Layout

### Setup Screen (New Campaign Tab)

**Current state:**
- Genre, Model select.
- Campaign name, details, notes upload.
- "Multiplayer (optional)" section with "Your Name" field (implicit: blank = SP, filled = MP).

**New state (Phase 4):**

```
┌─────────────────────────────────────────────┐
│  Setup Screen Header (D&D Campaign, etc.)   │
├─────────────────────────────────────────────┤
│  New Campaign | Join Session [tabs]         │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ Play Mode ──────────────────────────┐  │
│  │ [Single-Player]  [Multiplayer]       │  │
│  └──────────────────────────────────────┘  │
│                                             │
│  ┌─ Campaign Settings ───────────────────┐ │
│  │ Genre: [D&D ▼]                        │ │
│  │ Model: [Qwen 2.5 14B ▼]              │ │
│  ├─────────────────────────────────────┤ │
│  │ Campaign Name: [________]            │ │
│  │ Setting & Context: [________]        │ │
│  │ Campaign Notes: [Load .md file]      │ │
│  └──────────────────────────────────────┘ │
│                                             │
│  ┌─ Character (SP) / Character (MP) ────┐ │
│  │ [Create a Character]  [Skip]         │ │
│  │ (wizard slides in inline or below)   │ │
│  └──────────────────────────────────────┘ │
│                                             │
│  ┌─ Multiplayer (visible in MP mode) ──┐ │
│  │ Host Display Name: [______]          │ │
│  └──────────────────────────────────────┘ │
│                                             │
│  [Begin the Campaign]                       │
│                                             │
└─────────────────────────────────────────────┘
```

**Character Wizard Flow** (inline, replacing the [Create a Character] button area):

```
Step 1: Name
  "Name your character:" [____] [Next] [Cancel]

Step 2: Race/Species
  "Choose your race:" [Dropdown ▼]
  (options change by genre)
  [Next] [Back] [Cancel]

Step 3: Class
  "Choose your class:" [Dropdown ▼]
  [Next] [Back] [Cancel]

Step 4: Ability Method
  "How do you want to assign abilities?"
  O Point Buy (27-point budget)
  O Standard Array ([15, 14, 13, 12, 10, 8])
  O Roll 4d6 Drop Lowest
  [Next] [Back] [Cancel]

Step 5: Ability Assignment
  (varies by method — interactive grid with budget feedback, drag-drop, or roll display)
  [Next] [Back] [Cancel]

Step 6: Review
  Name: Thorin
  Race: Dwarf
  Class: Fighter
  Abilities: STR 15 (+2), DEX 10 (+0), ...
  [Create Character] [Back] [Cancel]
```

### Join Session Tab

**No changes.** Existing "Room Code" and "Your Name" fields unchanged.

---

## 5. Backward Compatibility & Risk Register

| Risk | Impact | Mitigation | Phase |
|------|--------|-----------|-------|
| Existing single-player auto-boot via `dnd_setup_done` breaks | High | Add SP/MP toggle; when already set up + no `?room=`, stay in SP mode (no toggle required, wizard optional). The toggle is only shown on new setups or reset. | 4 |
| `?room=` URL join path breaks | High | Preserve existing logic in App.jsx and ApiKeySetup.jsx. URL param auto-selects "Join Session" tab, bypasses SP/MP toggle. | 4 |
| `.md` restore breaks (save/continue feature) | Medium | `.md` restore pre-populates character data into localStorage but always boots single-player (no roomCode). Wizard state is NOT saved in `.md` (only final character + party). On restore, character is hydrated, no wizard is shown. | 5 |
| Existing 407 tests fail | High | All new tests are isolated (characterClasses.test.js, abilityScoreMath.test.js, CharacterWizard.test.jsx, etc.). Refactored ApiKeySetup.jsx is tested in-place; existing routing tests (App.test.jsx) unchanged. | Each |
| localStorage key collision (e.g., new wizard state key) | Medium | Wizard state is **ephemeral** (React component state only). Character output is stored via existing `dnd_character` key (already used by CharacterPanel). No new localStorage keys. | 3 |
| Genre change during wizard loses progress | Medium | Wizard component observes `genreId` prop; race/class dropdowns repopulate. Ability scores are genre-agnostic (STR–CHA are universal). On genre change, re-render dropdowns but preserve ability scores. | 3 |
| Wizard overshadows the form (UX clutter) | Medium | Wizard is **inline**, not modal. When closed/completed, form returns to normal (wizard container hidden). Max ~600px width, integrated below the toggle. | 4 |

**Test Coverage at Risk:**
- `App.test.jsx`: Routing logic (setup → chat). Ensure `dnd_setup_done` + no `?room=` still boots SP. ✓
- `ApiKeySetup.test.jsx`: Form submission, tab switching, join flow. Add tests for SP/MP toggle. ✓
- All new modules: 100% unit test coverage (math, class data, builder logic).

---

## 6. Test Plan

### Unit Tests (Pure Logic)

**`src/lib/characterClasses.test.js`** (new)
- [ ] All D&D classes have `hpBase` 8–12 and valid `hitDieSize`.
- [ ] All D&D races exist and have optional `abilityBonuses` object.
- [ ] All Star Wars classes have `hpBase` 6–8.
- [ ] All Star Wars species exist and have `abilityBonuses`.
- [ ] `getClassesForGenre('dnd')` returns array of D&D classes only.
- [ ] `getClassesForGenre('starwars')` returns array of SW classes only.
- [ ] `getRacesForGenre('dnd')` returns array of D&D races only.
- [ ] `getRacesForGenre('starwars')` returns array of SW species only.
- [ ] Invalid genre ID falls back to D&D.

**`src/lib/abilityScoreMath.test.js`** (new)
- [ ] Point-buy cost table is correct (9→1pt, 15→9pts, total 27).
- [ ] `validatePointBuy` rejects overspent allocations (> 27 pts).
- [ ] `validatePointBuy` rejects ability scores > 15.
- [ ] `validatePointBuy` accepts valid allocations.
- [ ] `roll4d6DropLowest` (mocked RNG) produces 6 results in range 3–18.
- [ ] Drop-lowest logic: [6,5,4,3] → 15; [1,1,1,1] → 3.
- [ ] `applyRaceBonus` applies bonuses correctly (e.g., Elf +2 DEX, +1 INT).
- [ ] Bonuses do not exceed maximum ability scores (cap at 20 or 15+race-bonus).
- [ ] Star Wars presets generate valid ability arrays.

**`src/lib/characterBuilder.test.js`** (new)
- [ ] HP is `hpBase + CON mod`, min 1 (even with -5 CON mod).
- [ ] AC is 10 + DEX mod.
- [ ] Initiative equals DEX mod (including negative).
- [ ] Speed is correct per genre.
- [ ] Fallback to `DEFAULT_CHARACTER` when input is null/undefined.
- [ ] All output fields match `CHARACTER_OBJECT` schema.

**`src/lib/session.test.js`** (existing)
- [ ] No new changes; ensure `.md` restore still loads character data.

### Component Tests

**`src/components/CharacterWizard.test.jsx`** (new)
- [ ] Step 1 (Name): input validation (required, 1–64 chars), Next button disabled until filled.
- [ ] Step 2 (Race): dropdown populated by genre; Next disabled until selected.
- [ ] Step 3 (Class): dropdown populated by genre; Next disabled until selected.
- [ ] Step 4 (Method): radio buttons toggle; Next enabled once selected.
- [ ] Step 5 (Assign Abilities):
  - Point-buy: budget display, increment/decrement prevent overspending.
  - Standard array: drag/click to assign, all 6 rolls assigned before Next.
  - Roll 4d6: 6 results displayed, drag to assign, all assigned before Next.
- [ ] Step 6 (Review): read-only display, modifiers calculated correctly.
- [ ] "Create Character" callback with correct payload.
- [ ] "Back" button returns to previous step (state preserved).
- [ ] "Cancel" button closes wizard without side effects.
- [ ] Genre change (via prop) repopulates dropdowns without data loss.
- [ ] Escape key closes wizard.

**`src/components/ApiKeySetup.test.jsx`** (update existing)
- [ ] SP/MP toggle exists and toggles correctly.
- [ ] SP mode shows "Create a Character" button, no display name field.
- [ ] MP mode shows "Create a Character" button + "Host Display Name" field.
- [ ] Campaign details section visible in both modes.
- [ ] Form submission with wizard output includes `character` parameter.
- [ ] Form submission without wizard omits `character`.
- [ ] Join Session tab unchanged.
- [ ] `?room=` param still auto-selects Join tab.

**`src/App.test.jsx`** (update existing)
- [ ] `dnd_setup_done` without `?room=` still boots SP (routing test).
- [ ] `handleSetup` with `character` parameter stores to `dnd_character`.
- [ ] `handleSetup` without `character` uses fallback `DEFAULT_CHARACTER`.
- [ ] Party is initialized correctly from character.
- [ ] Existing "transition from setup to chat" test still passes.

### Integration Tests

**Setup → Chat Flow:**
- [ ] SP mode (no wizard): boots with `DEFAULT_CHARACTER`, party is `DEFAULT_PARTY`.
- [ ] SP mode (with wizard): boots with created character, party reflects character name + class.
- [ ] MP mode (no wizard): boots host with `DEFAULT_CHARACTER`, roomCode generated.
- [ ] MP mode (with wizard): boots host with created character, roomCode generated.
- [ ] Join mode (no wizard): `?room=` tab pre-selected, existing flow unchanged.
- [ ] `.md` restore: boots SP, character hydrated, no wizard shown.

### Existing Test Preservation

- [ ] All 407 existing tests still pass (run `npm test -- --run` at end of each phase).
- [ ] No regression in localStorage keys or routing logic.
- [ ] No regression in multiplayer join/WebSocket flow.

---

## 7. Implementation Order & Checkpoints

1. **Phase 1** (Checkpoint: data imports work) → Pull PR, basic unit tests.
2. **Phase 2** (Checkpoint: ability math validated) → Pull PR, math tests.
3. **Phase 3** (Checkpoint: wizard component renders) → Pull PR, full wizard tests.
4. **Phase 4** (Checkpoint: SP/MP toggle + form integration) → Pull PR, routing tests.
5. **Phase 5** (Checkpoint: character seeding) → Pull PR, seeding tests.
6. **Phase 6** (Checkpoint: party display integration) → Pull PR, E2E test.
7. **Final integration & smoke test** → Verify all 407 tests pass + manual SP/MP/join flow.

---

## 8. Success Criteria

- [ ] **On-time:** Completed in 6–8 developer-days (2 agents × 3–4 days, or 1 agent × 6–8 days).
- [ ] **Quality:** All 407 existing tests pass + 100+ new tests (wizard, classes, math, builder, integration).
- [ ] **UX:** SP/MP toggle is clear and discoverable; wizard is intuitive (no > 2 clicks to skip).
- [ ] **Backward-compat:** Existing single-player, multiplayer, and `.md` restore flows unbroken.
- [ ] **Documentation:** Each phase documents its data model, test strategy, and breaking changes (none expected).

---

## 9. Known Limitations & Future Work

- **AC Calculation:** v1 uses `10 + DEX mod` only. Future: add armor, shields, class-specific bonuses (Barbarian unarmored defense, Monk, etc.).
- **Hit Points:** No multiclassing or per-level rolling. Future: track level-ups.
- **Ability Assignment:** No visual ability score modifier preview during assignment. Future: show all 6 at once with real-time mod display.
- **Star Wars Classes:** Simplified to 6 core classes (no prestige classes). Future: add advancement rules.
- **Racial Customization:** No variant rules (e.g., variant Human). Future: add optional rule toggle.

---

## 10. Glossary

| Term | Definition |
|------|-----------|
| **SP** | Single-Player mode (no multiplayer). |
| **MP** | Multiplayer mode (host or join). |
| **Character Wizard** | Multi-step form to create a character. |
| **Point-Buy** | D&D 5e ability allocation system using a 27-point budget. |
| **Standard Array** | D&D 5e predefined ability scores `[15, 14, 13, 12, 10, 8]` assigned by the player. |
| **Roll 4d6 Drop Lowest** | D&D 5e random ability generation: roll 4d6 six times, drop the lowest die each time. |
| **Character Object** | React state shape: `{ name, race, charClass, hpCurrent, hpMax, ac, initiative, speed, abilities, conditions }`. |
| **DEFAULT_CHARACTER** | App.jsx hardcoded fallback (Adventurer / Human / Fighter with 10 base abilities). |
| **DEFAULT_PARTY** | Initial LLM-driven party cache; overwritten after first DM response. |
| **CHARACTER_OBJECT** | Full character sheet representation (includes all stats, HP, AC, etc.). |

