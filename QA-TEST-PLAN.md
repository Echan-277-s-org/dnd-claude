# D&D Campaign Assistant — QA Test Plan
## Release Candidate: Genre + Theming, Party HUD, Structured Blocks, DiceChip

**App URL:** http://localhost:5173
**Ollama endpoint:** http://localhost:11434
**Date authored:** 2026-05-24
**React version:** 18 | **Build tool:** Vite
**localStorage keys under test:** dnd_setup_done, dnd_genre, dnd_campaign_name, dnd_campaign_details, dnd_model, dnd_campaign_context, dnd_character, dnd_party
**Vitest suite:** `npm test -- --run` (~203 tests, jsdom). Where a behavior is best validated by unit tests, the relevant test note is provided; the plan's primary mode is manual browser QA.

---

## Test Suite Summary

| Section | Tests |
|---------|-------|
| 1. Critical Golden Path | 13 |
| 2. Genre Selection and Theming | 12 |
| 3. LLM-Managed Party / Party HUD | 14 |
| 4. Structured-Block Protocol | 12 |
| 5. DiceChip Resolution | 9 |
| 6. CharacterPanel | 18 |
| 7. HistoryPanel | 10 |
| 8. Player-Choice Buttons | 10 |
| 9. Visual Overhaul | 7 |
| 10. Regression — Setup Screen | 9 |
| 11. Regression — Streaming and Chat | 9 |
| 12. Regression — Dice Roller | 7 |
| 13. Regression — Session Controls | 6 |
| 14. Edge Cases | 16 |
| 15. Accessibility Basics | 8 |
| **Total** | **160** |

---

## Notation

- **PASS criteria** are stated as observable facts in the browser.
- **FAIL criteria** are the opposite observable state or an error condition.
- [localStorage] = open DevTools > Application > Local Storage > http://localhost:5173.
- [console] = open DevTools > Console.
- Source file references use the format `file.jsx:behavior` to anchor a test to code.

---

## Section 1 — Critical Golden Path

These 13 tests cover a complete first-run to setup to conversation to panels flow. All must pass before any release.

### GP-01 — First load shows setup screen when no prior session exists

**Precondition:** Run `localStorage.clear()` in DevTools console, then hard-refresh.
**Steps:** Navigate to http://localhost:5173.
**PASS:** Setup card is visible. The genre emblem (⚔ for dnd default), the heading D&D Campaign Assistant, and the Begin the Campaign button are all present. The chat layout is NOT visible. `[data-theme="dnd"]` is set on `<html>`.
**FAIL:** Chat layout renders on first load, page is blank, or an unhandled error is thrown.

---

### GP-02 — Setup screen persists the correct localStorage keys on submit

**Precondition:** localStorage cleared.
**Steps:** Leave Genre on Dungeons & Dragons (5e). Set Campaign Name to Test Keep. Leave Setting & Context blank. Leave model on default (qwen2.5:14b). Click Begin the Campaign.
**PASS:** [localStorage] keys `dnd_setup_done = 1`, `dnd_genre = dnd`, `dnd_campaign_name = Test Keep`, `dnd_model = qwen2.5:14b` all exist. `dnd_campaign_details` exists (empty string acceptable). `dnd_campaign_context` exists.
**FAIL:** Any of those keys are absent, or values do not match input.

---

### GP-03 — Campaign name and subtitle appear in chat header after setup

**Precondition:** GP-02 completed.
**Steps:** Observe the chat header after setup submits.
**PASS:** The `.campaign-name` element reads Test Keep. The `.header-subtitle` reads Dungeon Master Assistant (from `genre.headerSubtitle` in `genres.js`). The `.header-emblem` shows ⚔.
**FAIL:** Header shows the fallback D&D Campaign instead of Test Keep, or subtitle is missing, or emblem is wrong.

---

### GP-04 — Empty state displays on first entry to chat with correct genre text

**Precondition:** GP-03 completed; no messages sent yet.
**Steps:** Observe the main message area.
**PASS:** Genre emptyEmblem 🗺 visible. Heading Your adventure awaits... shown. Exactly 3 starter prompt buttons present matching `GENRES.dnd.starterPrompts`: (1) Begin the adventure — set the scene and describe where we are. (2) The party enters a dimly lit tavern. What do we see? (3) We arrive at the dungeon entrance. What dangers await?
**FAIL:** Empty state missing, heading text differs, or wrong number of starter prompts, or prompts show Star Wars text.

---

### GP-05 — Typing a message and pressing Enter sends it and triggers streaming

**Precondition:** Empty state visible.
**Steps:** Click the textarea. Type I look around the entrance hall carefully. Press Enter.
**PASS:** (a) User bubble appears right-aligned with label Player and typed text. (b) DM bubble appears below it left-aligned with label Dungeon Master (from `genre.gmName`). (c) While streaming, textarea is disabled (opacity 0.45 per `.message-input:disabled`). (d) Typing dots or blinking cursor appears in DM bubble. (e) Send button is disabled.
**FAIL:** No DM bubble appears, textarea stays enabled during streaming, or Ollama fetch error thrown in [console].

---

### GP-06 — Streaming completes and input refocuses

**Precondition:** GP-05 in progress. Wait for streaming to finish.
**Steps:** Wait until typing dots and blinking cursor are both gone.
**PASS:** (a) Full DM response text rendered. (b) Textarea re-enabled. (c) Textarea has keyboard focus without clicking (from `textareaRef.current?.focus()` in the `finally` block of `sendMessage` in `Chat.jsx`). (d) Send button enabled again.
**FAIL:** Textarea remains disabled, focus does not return, or DM bubble content is empty after completion.

---

### GP-07 — Session log records the sent message in HistoryPanel

**Precondition:** GP-06 completed.
**Steps:** Click the 📜 header button to open HistoryPanel.
**PASS:** Session Log section has one entry with a HH:MM timestamp and the sent message text (truncated at 60 chars). Session Entities section shows either chips or the placeholder Entities will appear as the story unfolds...
**FAIL:** Session log empty, timestamp missing or malformed, or panel does not open.

---

### GP-08 — CharacterPanel opens and shows default values

**Precondition:** Fresh session, no prior `dnd_character` in localStorage.
**Steps:** Click the 🧙 header button.
**PASS:** Right sidebar slides open (`.char-panel` gains `.char-panel--open`, width transitions to `var(--panel-width)` = 280px). Panel shows: Name=Adventurer, Race=Human, Class=Fighter, HP=20/20, AC=15, Init=2, Speed=30, all 6 ability scores=10 with +0 modifier, no conditions active. HP bar visible with 100% fill.
**FAIL:** Panel does not open, wrong defaults, or HP bar missing.

---

### GP-09 — Player-choice buttons appear after a completed DM response

**Precondition:** At least one DM message complete.
**Steps:** Observe the area below the most recent DM bubble.
**PASS:** 4 action suggestion buttons visible below the last DM bubble. Button labels match one of the four dnd keyword groups defined in `genres.js`: combat (Attack / Cast a Spell / Take Cover / Flee), social (Persuade / Intimidate / Ask a question / Offer coin), exploration (Search the area / Listen carefully / Examine it closely / Proceed cautiously), or default (Describe my action / Ask the DM / Roll for it / What do I know?).
**FAIL:** No action buttons appear, they appear during streaming, or they appear on a non-last DM message.

---

### GP-10 — Clicking a player-choice button sends it as a user message

**Precondition:** GP-09 — action buttons visible.
**Steps:** Click any one of the action suggestion buttons.
**PASS:** (a) Player bubble with button text appears. (b) New DM bubble begins streaming. (c) Action buttons disappear from below the old DM bubble (it is no longer `lastAssistantIndex`).
**FAIL:** Button click does nothing, text not sent, or old buttons remain below a non-final DM message.

---

### GP-11 — Settings reset returns to setup screen and clears ready state

**Precondition:** In chat view.
**Steps:** Click the ⚙ header button (title="Campaign Settings").
**PASS:** Setup screen re-renders (`handleReset` in `App.jsx` calls `localStorage.removeItem('dnd_setup_done')` and `setReady(false)`). [localStorage] key `dnd_setup_done` is removed. Campaign name and model fields pre-populate from remaining localStorage keys.
**FAIL:** App stays on chat view, key not removed, or setup screen fields are blank.

---

### GP-12 — Page reload with valid localStorage skips setup

**Precondition:** GP-02 completed.
**Steps:** Hard-refresh the page (Ctrl+Shift+R).
**PASS:** Chat view renders directly. Setup screen is skipped. Campaign name in header matches stored value. `<html data-theme>` is set from stored genre.
**FAIL:** Setup screen appears despite `dnd_setup_done` being present.

---

### GP-13 — Party strip seeds from localStorage after reload

**Precondition:** GP-02 completed; at least one DM response received (so `dnd_party` was written).
**Steps:** Hard-refresh the page.
**PASS:** On desktop, the `.turn-pill` in the header shows the active member's name. On a mobile-width viewport, the `.party-strip` renders with at least one cell. The data matches what was stored in `dnd_party`. No blank or crashed strip.
**FAIL:** Party strip is empty, crashes, or shows `DEFAULT_PARTY` seed Adventurer after a session has progressed.

---

## Section 2 — Genre Selection and Theming

### GN-01 — Genre selector appears as the first field on the setup screen

**Precondition:** localStorage cleared.
**Steps:** Load http://localhost:5173 and inspect the setup form.
**PASS:** The first `<select>` inside `.setup-form` has `id="genre"` and label Genre. It is above the AI Model selector, which is above the Campaign Details divider. No "(optional)" annotation appears on the Genre label.
**FAIL:** Genre selector absent, out of order, or labeled "(optional)".

---

### GN-02 — Genre selector contains exactly the two documented options

**Steps:** Open the genre dropdown on the setup screen.
**PASS:** Exactly 2 options exist: value `dnd` labelled "Dungeons & Dragons (5e)" and value `starwars` labelled "Star Wars (d20 / Saga Edition)", matching the `GENRES` object in `genres.js`. The `dnd` option is pre-selected by default on a clean install.
**FAIL:** Fewer or more than 2 options, labels or values differ from source, or no option is pre-selected.

---

### GN-03 — Selecting starwars genre immediately applies the void theme to the setup screen (live preview)

**Steps:** Clear localStorage, load setup screen, change Genre selector from Dungeons & Dragons (5e) to Star Wars (d20 / Saga Edition). Observe without submitting.
**PASS:** `document.documentElement.dataset.theme` changes to `void` in DevTools (triggered by `onGenreChange` callback in `ApiKeySetup.jsx` → `setDraftGenre` → `useEffect` in `App.jsx`). The setup card background, font, and emblem visibly update to the Crimson Void palette. Setup emblem changes from ⚔ to ✦. Heading changes to Star Wars Campaign Assistant. Subtitle changes to Your AI Game Master — Powered by Ollama.
**FAIL:** Theme does not change until Begin is clicked, or `data-theme` stays `dnd`, or heading stays D&D Campaign Assistant.

---

### GN-04 — Selecting dnd genre applies the dnd theme

**Precondition:** GN-03 completed (void theme active).
**Steps:** Change Genre selector back to Dungeons & Dragons (5e).
**PASS:** `document.documentElement.dataset.theme` changes back to `dnd`. Candle-lit Grimoire palette active (warm gold). Emblem reverts to ⚔.
**FAIL:** Theme stays on void, or emblem stays ✦.

---

### GN-05 — Submitting with starwars genre writes dnd_genre = starwars and sets void theme in chat

**Steps:** Clear localStorage, select Star Wars genre, enter any campaign name, click Begin the Campaign.
**PASS:** [localStorage] `dnd_genre = starwars`. Chat view renders with `<html data-theme="void">`. Header emblem is ✦. Header subtitle reads Game Master Assistant. GM label inside DM bubbles reads Game Master (from `genre.gmName`).
**FAIL:** `dnd_genre` not stored, or `data-theme` is `dnd` in chat, or subtitle/label incorrect.

---

### GN-06 — dnd theme token values are correct in Computed Styles

**Precondition:** dnd genre selected and in chat view.
**Steps:** In DevTools Computed Styles on `<html>`, check CSS custom property values.
**PASS:** `--gold` = #c9a84c, `--gold-bright` = #f0d28a, `--surface-1` = #1c1409, `--font-display` references Cinzel, `--font-body` references Crimson Pro — matching the `[data-theme="dnd"]` block in `App.css`.
**FAIL:** Token values match `:root` defaults instead of the theme block, or void values are reported.

---

### GN-07 — void theme token values are correct in Computed Styles

**Precondition:** starwars genre selected and in chat view.
**Steps:** In DevTools Computed Styles on `<html>`, check CSS custom property values.
**PASS:** `--gold` = #b2222d, `--gold-bright` = #e85257, `--surface-1` = #0d0810, `--font-display` references Orbitron, `--font-body` references Titillium Web — matching the `[data-theme="void"]` block in `App.css`.
**FAIL:** Token values are wrong or default `:root` values.

---

### GN-08 — dnd empty state shows map emblem and D&D starter prompts

**Precondition:** dnd genre, chat view, no messages.
**Steps:** Observe `.empty-state`.
**PASS:** `.empty-emblem` shows 🗺. `h2` reads Your adventure awaits... The three starter prompts are the `GENRES.dnd.starterPrompts` values.
**FAIL:** Rocket emoji shown, or Star Wars prompts visible, or heading is Star Wars text.

---

### GN-09 — starwars empty state shows rocket emblem and Star Wars starter prompts

**Precondition:** starwars genre, chat view, no messages.
**Steps:** Observe `.empty-state`.
**PASS:** `.empty-emblem` shows 🚀. `h2` reads A long time ago, in a galaxy far, far away... The three starter prompts are the `GENRES.starwars.starterPrompts` values: (1) Begin the adventure — set the scene and describe where we are. (2) Our ship drops out of hyperspace above a contested world. What do we see? (3) We step into a crowded cantina on the edge of the Outer Rim. Who is here?
**FAIL:** Map emblem shown, or D&D prompts visible.

---

### GN-10 — starwars genre routes action suggestions through Star Wars keyword sets

**Precondition:** starwars genre, chat view.
**Steps:** Send a message that reliably contains a Star Wars combat keyword (e.g., blaster, lightsaber, or stormtrooper). Wait for DM response to complete.
**PASS:** Action buttons below the last DM bubble show the Star Wars combat set: Fire my blaster / Use the Force / Take Cover / Retreat — matching `GENRES.starwars.getActionSuggestions` in `genres.js`.
**FAIL:** D&D buttons (Attack / Cast a Spell) shown, or default fallback shown instead of combat set.

---

### GN-11 — starwars default fallback action set uses Ask the GM instead of Ask the DM

**Precondition:** starwars genre, chat view.
**Steps:** Send a message unlikely to trigger any keyword group (e.g., What is the weather like?). Wait for DM response.
**PASS:** Action buttons show: Describe my action / Ask the GM / Roll for it / What do I know? — matching the `matcher` fallback in `genres.js` for starwars.
**FAIL:** Ask the DM appears instead of Ask the GM, or D&D fallback buttons shown.

---

### GN-12 — Page reload preserves genre and theme without returning to setup

**Precondition:** starwars genre active, in chat view.
**Steps:** Hard-refresh the page.
**PASS:** Chat view renders directly. [localStorage] `dnd_genre = starwars` still present. `<html data-theme="void">` set on load from `THEME_FOR_GENRE[campaign.genre]` in `App.jsx`. Header emblem is ✦.
**FAIL:** Genre reverts to dnd after reload, or theme is dnd despite stored starwars genre.

---

## Section 3 — LLM-Managed Party / Party HUD

### PH-01 — Party seeds from DEFAULT_PARTY on first install (no prior localStorage)

**Precondition:** `localStorage.clear()`, complete setup, open chat without sending any message.
**Steps:** On a mobile-width viewport (DevTools device emulation ≤ 768px), observe the area below the header.
**PASS:** `.party-strip` is visible (CSS display:grid at max-width:768px). One cell shows name=ADVENTURER, role=Fighter. The seed member has `isActive: true` so the cell has `.party-strip-cell--active` class and the inset gold bar via `box-shadow: inset 2px 0 0 var(--gold)`.
**FAIL:** Strip is blank, crashes, or not visible on mobile viewport.

---

### PH-02 — Party strip seeds from dnd_character when dnd_party absent but dnd_character present

**Precondition:** Set localStorage manually: `dnd_setup_done=1`, `dnd_genre=dnd`, `dnd_model=qwen2.5:14b`, `dnd_character={"name":"Lyria","race":"Elf","charClass":"Bard","hpCurrent":15,"hpMax":20,"ac":15,"initiative":2,"speed":30,"abilities":{"STR":10,"DEX":10,"CON":10,"INT":10,"WIS":10,"CHA":10},"conditions":[]}`. Ensure `dnd_party` key is absent. Hard-refresh.
**PASS:** On mobile viewport, party strip shows one cell with name=LYRIA, role=Bard, hpPct=75% fill (15/20 = 75%). `loadParty()` migration in `App.jsx` derived the member from `dnd_character`. `dnd_party` remains absent until the first LLM response writes it.
**FAIL:** Strip shows Adventurer/Fighter instead of Lyria/Bard, or crashes.

---

### PH-03 — party block from LLM updates the party strip

**Precondition:** dnd genre, in chat. Ollama running. Send a message and wait for the complete DM response.
**Steps:** After streaming completes, observe the party strip (mobile) or turn-pill (desktop).
**PASS:** If the DM response contained a valid ` ```party ` block, the party strip member list updates to reflect what the LLM emitted (name, role, hpPct, isActive). [localStorage] `dnd_party` is written with the new values (verify via DevTools Application tab). The turn-pill on desktop shows `[activeMember.name]'s turn`.
**FAIL:** Strip does not update, `dnd_party` not written, or turn-pill shows stale data.

---

### PH-04 — Desktop turn-pill renders active member name and pulsing dot

**Precondition:** dnd genre, in chat view on a desktop-width viewport (> 768px). At least one DM response received.
**Steps:** Observe `.header-actions` in the header.
**PASS:** `.turn-pill` is visible (not hidden by the mobile media query). It contains `.turn-pill-dot` (6px gold pulsing dot per `turnDotPulse` keyframe) and text `[activeMember.name]'s turn`. `activeMember` is `party.find(m => m.isActive) ?? party[0]` from `Chat.jsx`.
**FAIL:** Turn-pill absent on desktop, dot not animating, or wrong member name shown.

---

### PH-05 — Desktop turn-pill and status dot are hidden on mobile viewport

**Precondition:** Desktop session with party data. Switch to mobile viewport (≤ 768px) in DevTools.
**Steps:** Observe `.header-status-dot` and `.turn-pill`.
**PASS:** Both elements have `display: none` per the `@media (max-width: 768px)` rule in `App.css`. Neither is visible. The party strip below the header is the mobile turn indicator.
**FAIL:** Turn-pill or status dot visible on mobile, or party strip hidden on mobile.

---

### PH-06 — Active strip cell shows gold inset bar and tinted background

**Precondition:** Mobile viewport, party strip visible with at least one member having `isActive: true`.
**Steps:** Inspect the active cell in the party strip.
**PASS:** The active cell has class `.party-strip-cell--active`. Computed styles show `box-shadow: inset 2px 0 0 var(--gold)` (inset gold left bar) and `background: color-mix(in oklab, var(--gold) 6%, var(--surface-1))` per `App.css`. The cell also renders `member.role + ' · turn'` in `.party-strip-role`.
**FAIL:** Active styling absent, inset bar not visible, or "· turn" not appended to role.

---

### PH-07 — HP fill in party strip uses gold gradient and stays within track

**Precondition:** Mobile viewport, party strip visible.
**Steps:** Inspect `.party-strip-hp-fill` for a member with partial HP.
**PASS:** Fill width matches `member.hpPct%`. Background is `linear-gradient(90deg, var(--gold-dim), var(--gold-bright))` per `App.css`. Track is 3px tall per design. Fill stays within `.party-strip-hp-track` at 0% and 100% extremes.
**FAIL:** Fill overflows track, uses wrong color (green), or HP track height is 4px or more.

---

### PH-08 — HistoryPanel party sub-section shows party rows on desktop

**Precondition:** Desktop viewport, HistoryPanel open, at least one DM response received that updated party state.
**Steps:** Scroll to the bottom of the open HistoryPanel and observe the Party header and rows below it.
**PASS:** A Party section header appears below Session Log (rendered when `party.length > 0` in `HistoryPanel.jsx`). Each member has a `.history-party-row`, showing `.history-party-name` and `.history-party-role`. The active member's row has `.history-party-row--active` (gold-tinted border and background per `App.css`). Each row has a `.history-party-hp-fill` reflecting `member.hpPct`.
**FAIL:** Party section absent, rows not rendered, or active highlighting missing.

---

### PH-09 — HistoryPanel party section absent when party is empty (edge case)

**Precondition:** Render HistoryPanel while `party = []` (achievable by manually setting `dnd_party = []` in localStorage and reloading before any DM response).
**Steps:** Open HistoryPanel. Observe the area below Session Log.
**PASS:** No Party header and no `.history-party-list` rendered (the `party.length > 0` guard in `HistoryPanel.jsx` prevents it). The panel does not crash.
**FAIL:** Empty party section renders with a visible header but no rows, or the component crashes.

---

### PH-10 — party block with zero members is ignored; previous party state preserved

**Precondition:** In chat with an established party. (This test validates the defensive guard in `Chat.jsx`.)
**Steps:** Mock or construct a DM response whose raw text contains ` ```party\n[]\n``` `. Observe party strip.
**PASS:** The `partyRaw.length > 0` guard in the `finally` block of `sendMessage` in `Chat.jsx` prevents an empty array from overwriting the party. Party strip shows the prior members unchanged. `dnd_party` in localStorage is not overwritten with `[]`.
**FAIL:** Party strip clears to empty, or `dnd_party = []` is written to localStorage.

---

### PH-11 — Party member IDs are stable across multiple LLM updates (no key flicker)

**Precondition:** In chat with at least two named party members established.
**Steps:** Send two more messages, each eliciting a DM response with a `party` block containing the same member names (possibly different hpPct). Observe the party strip cells for visual flicker.
**PASS:** Because `applyPartyUpdate` in `Chat.jsx` matches members by normalized name and preserves existing IDs (`found?.id ?? crypto.randomUUID()`), the same DOM keys are reused. No cell flicker or remount is observable. React DevTools Profiler confirms stable keys.
**FAIL:** Strip cells unmount/remount on each LLM update, or member IDs change causing visible flicker.

---

### PH-12 — Corrupt dnd_party JSON in localStorage falls back to DEFAULT_PARTY

**Steps:** `localStorage.setItem('dnd_party', '{not valid json}')`. Hard-refresh. Complete setup.
**PASS:** `loadParty()` in `App.jsx` catches the parse error in the first try/catch and falls through. If `dnd_character` is also absent, `DEFAULT_PARTY` is returned (Adventurer/Fighter/100%). No crash or console uncaught error.
**FAIL:** App crashes, party strip is blank with no default, or a JavaScript error appears in [console].

---

### PH-13 — New session clears pendingCheck but does not clear party

**Steps:** Establish a party (at least one DM response). Click the 🗑 header button and confirm New Session.
**PASS:** Messages, entities, and session log clear. `pendingCheck` resets to `null` (all four `set` calls in `handleNewSession` fire). Party strip still shows the last known party members — party state is NOT cleared by `handleNewSession` because `setParty` is not called there.
**FAIL:** Party strip empties on new session, or party reverts to DEFAULT_PARTY.

---

### PH-14 — starwars genre party parity — party block parsed and rendered identically

**Precondition:** starwars genre active. Send a message to Ollama and wait for a response.
**Steps:** Observe party strip on mobile or turn-pill on desktop after a DM response.
**PASS:** Party HUD updates from the `party` block in the starwars engine's response. The starwars `buildSystemPrompt` in `context.starwars.js` uses identical structured-block instructions to the dnd engine, so the parser in `Chat.jsx` (which is genre-agnostic) processes both identically. Turn-pill and strip display member names and roles as emitted.
**FAIL:** Party HUD does not update for starwars genre, or crashes when processing starwars responses.

---

## Section 4 — Structured-Block Protocol

### SB-01 — party, check, and verdict blocks are stripped from displayed DM text

**Precondition:** Ollama running, dnd genre.
**Steps:** Send a message that results in a DM response containing at least one structured block. After streaming completes, inspect the rendered DM bubble text.
**PASS:** No ` ```party `, ` ```check `, or ` ```verdict ` fences or their JSON content are visible in the `.message-content` element. `stripStructuredBlocks()` in `Chat.jsx` uses `STRIP_RE` to remove all blocks matching `BLOCK_TAGS = ['party', 'check', 'verdict']` before setting display content.
**FAIL:** Raw JSON or fence markers are rendered in the DM bubble.

---

### SB-02 — Structured blocks are stripped incrementally during streaming (no mid-stream bleed)

**Steps:** Watch the DM bubble during streaming for a response known to contain a `party` block at the end.
**PASS:** While the block fence is still being received (unclosed mid-stream), the lazy regex `STRIP_RE` does not match the partial fence, so no partial JSON text appears in the bubble. Once the closing ` ``` ` arrives, the block is stripped cleanly. The narrative text remains unaffected throughout.
**FAIL:** Partial JSON or the opening ` ```party ` tag appears briefly in the bubble during streaming.

---

### SB-03 — check block sets pendingCheck session state

**Precondition:** In chat. Arrange for a DM response that calls for a roll (e.g., send I try to sneak past the guard). After streaming completes inspect `pendingCheck`.
**Steps:** Open DevTools > React DevTools (or Sources breakpoint in Chat.jsx) and check the `pendingCheck` state after the response.
**PASS:** `pendingCheck` is set to `{ skill: "STEALTH", dc: <integer> }` (uppercase skill, per `checkRaw.skill.toUpperCase()` in `Chat.jsx`). The `check` block validates `checkRaw?.skill && checkRaw?.dc != null` before storing.
**FAIL:** `pendingCheck` remains null after a response containing a `check` block, or skill is not uppercased.

---

### SB-04 — pendingCheck context is folded into the dice roll sent to the LLM

**Precondition:** SB-03 completed so `pendingCheck` is set.
**Steps:** Open the Dice Roller and roll any die. Then send a follow-up message. Inspect the POST body to Ollama in Network tab.
**PASS:** The `messages` array in the request body contains a user message for the dice roll in the form `[Dice roll: d20 → N | pending check: STEALTH DC 15]`. The `pendingCheck` context is appended via the `checkCtx` string in `sendMessage` in `Chat.jsx`.
**FAIL:** The dice roll entry in the API payload lacks the `| pending check:` suffix, or `pendingCheck` was not cleared after being folded in.

---

### SB-05 — verdict block upgrades the most recent unresolved dice message

**Precondition:** A dice roll is in the message list with no verdict. A DM response containing a `verdict` block then arrives.
**Steps:** Wait for streaming to complete. Inspect the dice message rendered as a `DiceChip`.
**PASS:** The `DiceChip` that previously showed bare state (die tile + result only) now renders with `check` and `verdict` props. The check label is visible as `.dice-chip-check`. The verdict shows as `.dice-chip-verdict` with class `.dice-chip-verdict--pass` or `.dice-chip-verdict--fail`. The update happens in the `finally` block of `sendMessage` in `Chat.jsx` (searching in reverse for `m.role === 'dice' && m.verdict == null`).
**FAIL:** Dice chip remains in bare state after a verdict block, or the wrong dice message is upgraded.

---

### SB-06 — Malformed party JSON is silently ignored; last-known party preserved

**Steps:** Using DevTools or a mocked stream, inject a response containing ` ```party\n{"broken":true}\n``` ` (object not array). Observe party strip.
**PASS:** `extractBlock('party', fullText)` in `Chat.jsx` returns the parsed value `{"broken":true}`. The `Array.isArray(partyRaw) && partyRaw.length > 0` guard rejects it. Party strip shows unchanged prior members. No console error thrown.
**FAIL:** Party strip clears, or an uncaught error fires.

---

### SB-07 — Malformed check JSON is silently ignored; pendingCheck stays null

**Steps:** Inject a response with ` ```check\nnot json\n``` `.
**PASS:** `extractBlock('check', fullText)` catches the `JSON.parse` exception and returns `null`. The `checkRaw?.skill && checkRaw?.dc != null` guard evaluates false for `null`. `pendingCheck` remains null. No console error.
**FAIL:** App crashes, or `pendingCheck` is set to a partial/invalid value.

---

### SB-08 — Malformed verdict JSON is silently ignored; dice message stays unresolved

**Steps:** Inject a response with ` ```verdict\n{bad}\n``` `.
**PASS:** `extractBlock('verdict', fullText)` returns `null`. The `verdictRaw?.result === 'PASS' || verdictRaw?.result === 'FAIL'` guard evaluates false. No dice message is upgraded. No console error.
**FAIL:** App crashes, or a dice message gets a null/undefined verdict.

---

### SB-09 — verdict with neither PASS nor FAIL result is ignored

**Steps:** Inject a response with ` ```verdict\n{"skill":"STEALTH","dc":15,"roll":17,"result":"PARTIAL"}\n``` `.
**PASS:** The guard `verdictRaw?.result === 'PASS' || verdictRaw?.result === 'FAIL'` is false for "PARTIAL". No dice message upgraded. No error.
**FAIL:** App crashes, or "PARTIAL" verdict applied to a chip.

---

### SB-10 — Structured blocks are excluded from Ollama API payload

**Steps:** Send a message after a DM response that contained a party block. Inspect the POST body in Network tab.
**PASS:** The `messages` array sent to Ollama contains the DM response with `content` equal to `stripStructuredBlocks(fullText)` — the block-stripped display text — not the raw fullText with JSON fences. Verify the assistant message content in the payload does not include ` ```party ` or raw JSON arrays.
**FAIL:** Raw structured blocks appear verbatim in the assistant message content of the API request.

---

### SB-11 — starwars engine structured-block instructions are identical to dnd engine

**Steps:** Compare `buildSystemPrompt` in `src/lib/context.js` and `src/lib/context.starwars.js` — specifically the "Structured data blocks" section through the worked examples. This is a static code review step.
**PASS:** Both engines instruct the model with identical structured-block rules: party REQUIRED every response, check ONLY when calling for a roll, verdict ONLY when resolving a roll; identical key names (`name`, `role`, `hpPct`, `isActive`; `skill`, `dc`; `skill`, `dc`, `roll`, `result`). The only differences are genre-flavored role examples (Fighter/Wizard vs Jedi/Pilot) and setting flavor text. The JSON parser in `Chat.jsx` is genre-agnostic and processes both identically.
**FAIL:** starwars engine omits one or more structured-block rules, or uses different key names that would break the parser.

---

### SB-12 — pendingCheck is cleared after new session

**Precondition:** `pendingCheck` is set (SB-03 completed).
**Steps:** Click 🗑 and confirm new session.
**PASS:** `handleNewSession` in `Chat.jsx` calls `setPendingCheck(null)`. `pendingCheck` state is null. Subsequent dice rolls are sent without `| pending check:` appended in the API payload.
**FAIL:** `pendingCheck` persists after new session, contaminating the next dice roll's context.

---

## Section 5 — DiceChip Resolution

### DC-01 — Rolling a die renders a bare DiceChip centered in the message list

**Steps:** Open Dice Roller. Click the d8 button.
**PASS:** A `.dice-chip` element appears `align-self: center` in the messages flex column. It contains `.dice-chip-tile` (showing "d8"), `.dice-chip-result` (showing a number 1–8). No `.dice-chip-check` or `.dice-chip-verdict` element is present (bare state). The chip has `role="status"` and `aria-label="d8 rolled N"`.
**FAIL:** Old `.dice-result` pill renders instead of `.dice-chip`, or chip is left/right-aligned rather than centered.

---

### DC-02 — DiceChip renders correct aria-label in bare state

**Steps:** Roll a d20. Inspect the `.dice-chip` DOM element's `aria-label` attribute.
**PASS:** `aria-label` = "d20 rolled N" (matching the `verdict ? ... : \`${die} rolled ${result}\`` ternary in `DiceChip.jsx`).
**FAIL:** `aria-label` is empty, missing, or includes verdict text when no verdict is present.

---

### DC-03 — DiceChip upgrades to resolved state when verdict block arrives

**Precondition:** A `check` block established `pendingCheck`. A d20 was rolled. The DM response included a matching `verdict` block.
**Steps:** Observe the DiceChip after streaming completes.
**PASS:** The chip now shows `.dice-chip-check` (skill name in uppercase, e.g., STEALTH) and `.dice-chip-verdict` with text PASS or FAIL. The `aria-label` reads "d20 rolled N — STEALTH PASS/FAIL". The upgrade happened in-place without removing and re-inserting the chip.
**FAIL:** Chip stays bare after a verdict, or chip is replaced by a new element rather than updated in place.

---

### DC-04 — PASS verdict applies green-mix color class

**Precondition:** A verdict of PASS is received.
**Steps:** Inspect the `.dice-chip-verdict` element's class.
**PASS:** Element has class `dice-chip-verdict dice-chip-verdict--pass`. Computed color is `color-mix(in oklab, var(--green) 50%, var(--gold-bright))` per `App.css`. Text reads PASS.
**FAIL:** Class `dice-chip-verdict--fail` applied for a PASS result, or color is red.

---

### DC-05 — FAIL verdict applies red color class

**Precondition:** A verdict of FAIL is received.
**Steps:** Inspect the `.dice-chip-verdict` element's class.
**PASS:** Element has class `dice-chip-verdict dice-chip-verdict--fail`. Computed color is `var(--red)` per `App.css`. Text reads FAIL.
**FAIL:** Class `dice-chip-verdict--pass` applied for a FAIL result, or color is green.

---

### DC-06 — d20 critical hit (result=20) applies crit modifier class and label

**Steps:** In DevTools console run `Math.random = () => 0.95` (floor(0.95×20)+1 = 20). Click d20.
**PASS:** The `.dice-chip` has class `dice-chip--crit`. `.dice-chip-result` has class `dice-chip-result--crit` (computed color = `color-mix(in oklab, var(--gold-bright) 80%, var(--green))`). A `.dice-chip-crit-label` element with text " CRIT" is visible inside the result span. Chip border color includes the green-gold mix per `.dice-chip--crit` in `App.css`.
**FAIL:** No crit class, or CRIT label absent, or wrong border color.

---

### DC-07 — d20 fumble (result=1) applies fumble modifier class and label

**Steps:** In DevTools console run `Math.random = () => 0` (floor(0)+1 = 1). Click d20.
**PASS:** The `.dice-chip` has class `dice-chip--fumble`. `.dice-chip-result` has class `dice-chip-result--fumble` (computed color = `var(--red)`). A `.dice-chip-fumble-label` element with text " FUMBLE" is visible. Chip border color is `var(--red)` per `.dice-chip--fumble`.
**FAIL:** No fumble class, or FUMBLE label absent.

---

### DC-08 — crit/fumble modifier classes are preserved after verdict upgrade

**Precondition:** A d20 crit (result=20) chip is in the message list. A verdict block then arrives.
**Steps:** Observe the chip after the verdict upgrade.
**PASS:** Chip retains `.dice-chip--crit` class in addition to the newly rendered `.dice-chip-verdict--pass/fail`. Both modifier class and verdict class coexist. The chip does not lose its gold-green crit border when verdict is added.
**FAIL:** Crit class removed after verdict upgrade, or chip styling resets.

---

### DC-09 — DiceChip has no Player or DM label and is centered

**Steps:** Roll any die and observe the resulting DiceChip in the DOM.
**PASS:** The `.dice-chip` element has no `.message-header` child, no "Player" text, and no "Dungeon Master" or "Game Master" text. Its `align-self: center` CSS ensures it is horizontally centered in the message column flex layout.
**FAIL:** A message label appears on the chip, or it is left/right-aligned like a chat bubble.

---

## Section 6 — CharacterPanel

### CP-01 — Panel toggle via header button and side tab are both functional

**Steps:** (a) Click 🧙 in header — panel opens. Click again — closes. (b) Open panel, then click the left-edge toggle button (`.char-panel-toggle`) — panel closes. Click it again — opens.
**PASS:** Both controls toggle. 🧙 icon button has `active` CSS class while panel is open. Toggle icon shows `›` when panel is closed and `‹` when open, matching the `isOpen ? '›' : '‹'` ternary in `CharacterPanel.jsx`.
**FAIL:** Either control has no effect, active class not applied, or arrow direction wrong.

---

### CP-02 — Character name is inline-editable

**Steps:** Open CharacterPanel. Click the character name Adventurer. Type Thorin Stonehelm. Press Enter.
**PASS:** Input (`.char-inline-input`) appears with `autoFocus` when clicked. After Enter, span shows Thorin Stonehelm. [localStorage] `dnd_character.name = Thorin Stonehelm`.
**FAIL:** Clicking name does not show input, Enter does not commit, or localStorage not updated.

---

### CP-03 — Escape key cancels inline edit without saving

**Steps:** Click character name. Change to WRONG NAME. Press Escape.
**PASS:** Input closes and original name restored. WRONG NAME does not appear in span or localStorage. The `onKeyDown` handler in `InlineEdit` sets `draft` back to `value` and calls `setEditing(false)`.
**FAIL:** Escape commits the change, or field remains open.

---

### CP-04 — Race and Class are separately editable

**Steps:** Click Race (Human) — edit to Elf, Enter. Click Class (Fighter) — edit to Ranger, Enter.
**PASS:** Display shows Elf / Ranger with `.char-sep` slash between them. [localStorage] `dnd_character` contains `race: "Elf"` and `charClass: "Ranger"`.
**FAIL:** Fields not clickable, separator disappears, or localStorage not updated.

---

### CP-05 — HP bar width updates when current HP is edited

**Steps:** Default HP 20/20 (100% bar fill). Click current HP (`char-hp-val`), change to 10, Enter.
**PASS:** `.char-hp-bar-fill` width narrows to approximately 50% of track. Fill transitions smoothly (0.3s per `.char-hp-bar-fill { transition: width 0.3s ease }`). Current HP displays 10.
**FAIL:** Bar width unchanged, bar overflows track, or HP reverts to 20.

---

### CP-06 — HP bar clamps at 0% and 100% — never overflows

**Steps:** (a) Set current HP to 0, Enter. (b) Set current HP to 999, Enter.
**PASS:** At 0, bar fill = 0%. At 999, bar fill = 100% (clamped by `Math.max(0, Math.min(100, ...))` in `CharacterPanel.jsx`). Bar stays within track in both cases.
**FAIL:** Bar extends beyond track, goes negative, or shows wrong percentage.

---

### CP-07 — HP bar when max is 0 shows 0% without crash

**Steps:** Set HP Max to 0, Enter.
**PASS:** Bar shows 0% (the `hpMax > 0` guard returns `'0%'`). No console error about division by zero. App does not crash.
**FAIL:** Console error about NaN or division by zero, or app crash.

---

### CP-08 — AC, Initiative, and Speed badges are individually editable

**Steps:** Click AC (15) -> 18, Enter. Click Init (2) -> 5, Enter. Click Speed (30) -> 40, Enter.
**PASS:** All three `.char-badge` values show updated numbers. [localStorage] `dnd_character` has `ac: 18`, `initiative: 5`, `speed: 40`.
**FAIL:** Any badge not clickable, value not saved, or badges clobber each other.

---

### CP-09 — All 6 ability scores display correct auto-calculated modifiers

**Steps:** Verify default 10 shows +0. Set STR=20 (expect +5), DEX=8 (expect -1), CON=1 (expect -5), INT=30 (expect +10).
**PASS:** Modifier below each score in `.char-ability-mod` matches `Math.floor((score-10)/2)`, shown as `+N` or `-N`. Computed by the `modifier()` function in `CharacterPanel.jsx`.
**FAIL:** Modifier not shown, formula wrong, or positive modifiers lack + sign.

---

### CP-10 — Ability score of 0 calculates modifier as -5 without crash

**Steps:** Click STR, set to 0, Enter.
**PASS:** STR shows 0. Modifier shows -5. No crash or NaN in [console].
**FAIL:** App crashes, NaN shown, or wrong modifier.

---

### CP-11 — Ability score of 30 calculates modifier as +10

**Steps:** Click CHA, set to 30, Enter.
**PASS:** CHA shows 30. Modifier shows +10. localStorage updated.
**FAIL:** Modifier wrong or not shown.

---

### CP-12 — Non-numeric input in numeric fields defaults to 0

**Steps:** Click HP current. Type abc. Click elsewhere (blur).
**PASS:** HP becomes 0 (`Number(draft) || 0` fallback in `InlineEdit` `onBlur` for `type="number"`). No NaN or crash.
**FAIL:** NaN shown, crash, or previous value retained.

---

### CP-13 — Condition chips toggle on and off

**Steps:** Click Poisoned chip. Observe. Click again.
**PASS:** After first click: chip has `.char-condition-chip--active` class, red-tinted background (`color-mix(in oklab, var(--red) 25%, transparent)`). After second click: reverts to inactive. [localStorage] `dnd_character.conditions` reflects current state.
**FAIL:** Visual state unchanged, toggle does not work, or localStorage not updated.

---

### CP-14 — Multiple conditions can be active simultaneously

**Steps:** Click Poisoned, Frightened, and Prone chips.
**PASS:** All three chips show as active (red tint). [localStorage] `dnd_character.conditions` array contains all three strings.
**FAIL:** Only one condition active at a time, or fewer than three stored.

---

### CP-15 — All 6 conditions are present with correct labels

**Steps:** Open CharacterPanel with a fresh character.
**PASS:** Exactly 6 condition chips matching `CONDITIONS` array in `CharacterPanel.jsx`: Poisoned, Frightened, Restrained, Prone, Blinded, Incapacitated. Labels exact.
**FAIL:** Any condition missing, renamed, or extra conditions appear.

---

### CP-16 — Character sheet persists across page reload

**Steps:** Set Name=Lyria, Race=Half-Elf, Class=Bard, HP=15/22, STR=14, activate Blinded. Reload.
**PASS:** After reload CharacterPanel shows all saved values. HP bar shows approximately 68% fill. Blinded chip active. `loadCharacter()` in `App.jsx` reads and merges from `dnd_character` with `DEFAULT_CHARACTER` spread.
**FAIL:** Any field reverts to default, or `dnd_character` not read on mount.

---

### CP-17 — CharacterPanel edits do not cause message list to flash or jump

**Steps:** Send one message, wait for DM response. Open CharacterPanel. Edit character name.
**PASS:** Message list does not flash, re-render, or lose scroll position when character state updates (character state is lifted to App.jsx and passed as props; it does not share state with messages).
**FAIL:** Message list flashes or scroll jumps when character edited.

---

### CP-18 — Closing panel mid-edit commits the edit via blur

**Steps:** Click character name to enter edit mode. Type New Name. Click elsewhere to blur. Open panel again.
**PASS:** `onBlur` fires in `InlineEdit`, committing New Name. Panel reopened shows New Name stored in `dnd_character`.
**FAIL:** App crashes, or a corrupt/empty value is stored.

---

## Section 7 — HistoryPanel

### HP-01 — Panel toggle via header button and side tab are both functional

**Steps:** Click 📜 in header to open. Click again to close. Open again then click the right-edge toggle button (`.history-panel-toggle`) to close.
**PASS:** Both controls work. 📜 icon button has `active` class while open. Toggle icon shows `‹` when open and `›` when closed — note this is the opposite direction from CharacterPanel, matching `isOpen ? '‹' : '›'` in `HistoryPanel.jsx`.
**FAIL:** Either control non-functional, wrong arrow direction, or active class missing.

---

### HP-02 — Session Entities section shows placeholder before any messages

**Steps:** Open HistoryPanel before any message sent.
**PASS:** `.history-empty-hint` in `.history-entities` reads: Entities will appear as the story unfolds...
**FAIL:** Section blank, shows error, or shows chips from a prior session.

---

### HP-03 — Session Log shows placeholder before any messages

**Steps:** Observe Session Log with no messages sent.
**PASS:** `.history-empty-hint` in `.history-log` reads: Your actions will be logged here...
**FAIL:** Section blank or shows stale data.

---

### HP-04 — Session Log records each sent message with timestamp

**Steps:** Send I search for hidden doors. Wait for DM response. Send I attack the goblin.
**PASS:** Session Log has 2 entries in `.history-log`. Each has a `.history-log-time` in HH:MM format (from `new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`). Entries in order sent.
**FAIL:** Entries missing, timestamps absent or wrong format, or out of order.

---

### HP-05 — Session Log truncates long messages at 60 characters

**Steps:** Send a message at least 80 characters long.
**PASS:** Session log `.history-log-text` shows only the first 60 characters from `trimmed.slice(0, 60)` in `sendMessage` in `Chat.jsx`. Characters 61+ do not appear.
**FAIL:** Full text shown for long messages.

---

### HP-06 — Entity chips appear after DM response with bolded proper nouns

**Steps:** Send: What is the name of the innkeeper? Wait for DM response.
**PASS:** If DM response contains a bolded proper noun that passes the `looksLikeEntity` heuristics in `context.js` (Title-case, non-mechanics, non-imperative), one or more `.history-entity-chip` elements appear in `.history-entities` after streaming completes. `extractEntities` is called in the `finally` block of `sendMessage`.
**FAIL:** Chips never appear after any response, or mechanics terms like Perception or Armor Class appear as chips.

---

### HP-07 — Entity chips and session log clear on new session

**Steps:** Accumulate chips and log entries. Click 🗑 and confirm.
**PASS:** Both sections revert to placeholder text. `setEntities([])` and `setSessionLog([])` are called in `handleNewSession`.
**FAIL:** Old entities or log entries persist after session clear.

---

### HP-08 — HistoryPanel Party sub-section does not appear before first DM response

**Precondition:** Fresh session with `dnd_party` absent from localStorage, no messages sent.
**Steps:** Open HistoryPanel. Scroll to the bottom.
**PASS:** If `party.length === 0` the party section does not render (the `party.length > 0` guard in `HistoryPanel.jsx`). If party was seeded from DEFAULT_PARTY, a Party section with one Adventurer row is shown — this is acceptable and expected.
**FAIL:** HistoryPanel crashes when party prop is empty or undefined.

---

### HP-09 — HistoryPanel open does not block message sending

**Steps:** Open HistoryPanel. Type and send a message.
**PASS:** Message sends normally. Chat column narrows with the CSS grid but remains functional with `min-width: 0` on `.chat-container`.
**FAIL:** Panel open state prevents input, or chat column collapses to zero.

---

### HP-10 — starwars genre entities use the starwars extractEntities engine

**Precondition:** starwars genre active. Send a message and wait for a DM response containing at least one bolded NPC or planet name.
**Steps:** Open HistoryPanel and observe Session Entities.
**PASS:** Entity chips extracted using `context.starwars.js:extractEntities` (loaded via `genre.engine` in `Chat.jsx`). Star Wars mechanics terms (lightsaber, stormtrooper a, use the force) do not appear as chips. A named NPC or location (e.g., **Wuher**, **Tatooine**) does appear.
**FAIL:** starwars mechanics terms appear as entity chips, or no entities extracted for any Star Wars response.

---

## Section 8 — Player-Choice Buttons

### PCB-01 — Action buttons appear only after streaming is complete

**Steps:** Send a message. Observe DM bubble during and after streaming.
**PASS:** During streaming (`isLoading` true) no `.action-suggestions` div appears. After completion (`isLoading` false and `msg.content.length > 0` and `!msg.error`) buttons appear below the last DM bubble. The `showSuggestions` condition in `Chat.jsx` gates all four requirements.
**FAIL:** Buttons appear mid-stream, or never appear after completion.

---

### PCB-02 — Combat keywords route to dnd combat action set

**Steps:** Send: A goblin attacks me! Wait for DM response containing at least one dnd combat keyword (attack, sword, enemy, creature, monster, fight, weapon, combat, battle, strike — per `dndCombat` in `genres.js`).
**PASS:** Exactly 4 buttons: Attack / Cast a Spell / Take Cover / Flee.
**FAIL:** Wrong set or wrong count of buttons.

---

### PCB-03 — Social keywords route to dnd social action set

**Steps:** Send: I enter the tavern and speak to the innkeeper. Wait for DM response containing a dnd social keyword.
**PASS:** Exactly 4 buttons: Persuade / Intimidate / Ask a question / Offer coin.
**FAIL:** Wrong set or default fallback shown.

---

### PCB-04 — Exploration keywords route to dnd exploration action set

**Steps:** Send: I push open the dungeon door. Wait for DM response with an exploration keyword.
**PASS:** Exactly 4 buttons: Search the area / Listen carefully / Examine it closely / Proceed cautiously.
**FAIL:** Wrong set shown.

---

### PCB-05 — Default fallback set appears when no keywords match (dnd)

**Steps:** Send: What is the sky like today? (unlikely to match any keyword group). Wait for DM response.
**PASS:** Exactly 4 buttons: Describe my action / Ask the DM / Roll for it / What do I know?
**FAIL:** Incorrect keyword set shown, or no buttons appear.

---

### PCB-06 — Action buttons appear only on the LAST DM message

**Steps:** Send 3 messages, wait for all 3 DM responses to complete.
**PASS:** Buttons appear only below the 3rd DM bubble. The 1st and 2nd DM bubbles have no action buttons (`showSuggestions` requires `isLastAssistant` which is derived from `lastAssistantIndex` in `Chat.jsx`).
**FAIL:** Action buttons appear on multiple DM bubbles simultaneously.

---

### PCB-07 — Clicking an action button removes the old buttons and starts new DM response

**Steps:** After receiving a DM response with buttons visible, click one of the action buttons.
**PASS:** Clicked text sent as player message. Old buttons disappear since that message is no longer `lastAssistantIndex`. New DM response begins streaming.
**FAIL:** Old buttons remain below the previous DM bubble after new exchange starts.

---

### PCB-08 — Action buttons disappear while a new request is in flight

**Steps:** After one complete exchange with buttons visible, send a second message immediately.
**PASS:** As soon as `isLoading` becomes true the previous action buttons disappear (the `!isLoading` condition in `showSuggestions`).
**FAIL:** Buttons from previous response remain visible during new loading state.

---

### PCB-09 — Empty DM content (error case) does not show action buttons

**Steps:** Stop Ollama or set model to a nonexistent value. Send a message. Observe the error DM bubble.
**PASS:** No action buttons below the error bubble. The `!msg.error` condition in `showSuggestions` prevents it. Red border visible on the `.dm-message.error` bubble.
**FAIL:** Action buttons appear below error or empty DM bubble.

---

### PCB-10 — starwars social set includes Deceive and Offer credits

**Precondition:** starwars genre active. Send a message referencing the cantina or a deal. Wait for DM response.
**PASS:** Action buttons show the starwars social set: Persuade / Intimidate / Deceive / Offer credits — matching `GENRES.starwars.getActionSuggestions` social branch.
**FAIL:** D&D social buttons (Ask a question / Offer coin) shown instead, or Deceive missing.

---

## Section 9 — Visual Overhaul

### VO-01 — 3-column grid layout with both panels closed

**Steps:** Open the app with both HistoryPanel and CharacterPanel closed.
**PASS:** `.app-layout` renders as `grid-template-columns: 0px 1fr 0px` (CSS variables `--history-width: 0px` and `--char-width: 0px` set in `Chat.jsx` when both panels closed). Chat column fills the full viewport width. No white space or gap visible on left or right edge.
**FAIL:** Chat column has visible lateral gaps, or the grid shows non-zero widths for the closed panel columns.

---

### VO-02 — Body noise texture is present over the dark background

**Steps:** Load the app. In DevTools > Elements select `body`. Inspect `background-image` in Computed Styles.
**PASS:** `background-image` references a `data:image/svg+xml` URL containing `feTurbulence` (the SVG noise filter) as well as `radial-gradient` layers. A subtle grain is visible on the dark background at 100% zoom.
**FAIL:** `background-image` is `none` or shows a plain flat color with no SVG noise texture. (Note: void theme overrides `body` background-image entirely with ember-dust radials; verify the base `:root` texture on dnd theme.)

---

### VO-03 — DM bubble left border and inner glow are applied

**Steps:** Send any message and wait for the DM response to complete.
**PASS:** The `.dm-bubble` element has `border-left: 2px solid var(--gold-dim)` per `App.css`. The `box-shadow: inset 0 0 30px rgba(...)` glow is present. A faint gold gradient is visible along the top edge via the `::before` pseudo-element.
**FAIL:** DM bubble has a uniform border on all four sides with no left accent, or the inner glow is absent.

---

### VO-04 — Floating empty-state emblem animation plays

**Steps:** Clear localStorage and reload. Complete setup to reach empty chat state.
**PASS:** The `.empty-emblem` element (genre-specific emoji) visibly floats up and down with a smooth 3-second cycle. In DevTools > Elements > Computed > Animations, the `float` keyframe animation is listed with `3s ease-in-out infinite`.
**FAIL:** Emblem is static, or animation is paused/absent.

---

### VO-05 — Glowing input focus ring appears on textarea focus

**Steps:** Click into the message textarea.
**PASS:** Textarea `border-color` changes to `var(--gold)` and a `box-shadow: 0 0 0 3px color-mix(in oklab, var(--gold) 28%, transparent)` glow ring appears per `.message-input:focus` in `App.css`. No default blue browser outline is visible (`outline: none` set).
**FAIL:** Default browser blue outline shown, or no visible gold ring appears on focus.

---

### VO-06 — Action suggestion buttons use display font and gold border styling

**Steps:** Send a message, wait for a complete DM response, and observe the action buttons.
**PASS:** Each `.action-btn` has `font-family: var(--font-display)` (Cinzel for dnd, Orbitron for starwars) in Computed Styles, `border: 1px solid var(--border-gold)`, `border-radius: 3px`, and transparent background. On hover the border transitions to `var(--gold)` and text to `var(--gold-bright)`.
**FAIL:** Buttons use a default sans-serif font, have a solid background fill, or hover state does not change color.

---

### VO-07 — dnd theme applies illuminated drop-cap to first DM paragraph

**Precondition:** dnd genre active. At least one DM response rendered.
**Steps:** Inspect the first `<p>` inside `.dm-bubble .message-content`.
**PASS:** The first non-whitespace character of the first paragraph is wrapped in `<span class="dropcap">` (injected by `parseMarkdown()` in `Chat.jsx`). Under `[data-theme="dnd"]`, this span has computed `font-size` approximately 2.8em, `float: left`, and `color: var(--gold-bright)` with `text-shadow` per the `[data-theme="dnd"] .dm-bubble .message-content > p:first-child .dropcap` rule in `App.css`.
**FAIL:** No `.dropcap` span found in DOM, or dropcap styling absent on dnd theme, or dropcap appears on void theme with the same illuminated style (void theme intentionally does not style the dropcap).

---

## Section 10 — Regression: Setup Screen

### SS-01 — Model selector contains exactly the two documented options

**Steps:** Clear localStorage, load the app, open the AI Model dropdown.
**PASS:** Exactly 2 options exist: value `qwen2.5:14b` labelled "Qwen 2.5 14B — Fast & capable (recommended)" and value `qwen2.5:32b` labelled "Qwen 2.5 32B — Richer narration, slower", matching `OLLAMA_MODELS` in `ApiKeySetup.jsx`. The first option is pre-selected by default.
**FAIL:** Fewer or more than 2 options, labels or values differ from source, or no option is pre-selected.

---

### SS-02 — Genre selector hint text is correct

**Steps:** Observe the `.form-hint` below the Genre selector.
**PASS:** Hint reads: "Sets the Game Master's ruleset, voice, and continuity tracking." as hard-coded in `ApiKeySetup.jsx`.
**FAIL:** Hint is absent, empty, or shows API key text from an older version of the file.

---

### SS-03 — Campaign Name field is optional and accepts free text

**Steps:** Leave Campaign Name blank. Click Begin the Campaign.
**PASS:** Form submits successfully. `dnd_campaign_name` in localStorage is an empty string. Chat header shows the genre fallback name (`genre.headerDefaultName`: D&D Campaign for dnd, Star Wars Campaign for starwars).
**FAIL:** Form blocks submission with a validation error when Campaign Name is empty.

---

### SS-04 — Setting & Context textarea uses genre-specific placeholder and hint

**Steps:** Switch genre to starwars. Observe the Setting & Context field placeholder and hint.
**PASS:** Placeholder matches `GENRES.starwars.detailsPlaceholder`: "Rebellion era, 4 players, gritty smuggler tone aboard the freighter Kestrel, hunted by an Imperial ISB agent...". Hint reads `GENRES.starwars.detailsHint`: "Era, party, tone, ship — the GM will use this as context." Switching back to dnd reverts both texts.
**FAIL:** Placeholder or hint text does not change when genre changes.

---

### SS-05 — .md file upload populates context and shows the filename

**Steps:** Create a file called notes.md containing "Session 1: party met Gareth." Click "Load .md file" and select it.
**PASS:** The upload label is replaced by a `.file-loaded` row showing `📄 notes.md` (via `.file-loaded-name`) and a `.file-clear-btn` (`✕`). After submitting, `dnd_campaign_context` in localStorage contains the file content.
**FAIL:** File row does not appear, filename is not shown, or context is not stored.

---

### SS-06 — File clear button removes the loaded file and restores the upload label

**Steps:** Load a .md file per SS-05. Click the `✕` clear button.
**PASS:** The `.file-loaded` row disappears and the `label[for="context-file"]` "Load .md file" reappears. The hidden file input value is reset via `fileInputRef.current.value = ''` in `clearFile()` in `ApiKeySetup.jsx`. The `context` state returns to empty string.
**FAIL:** Clear button has no effect, old filename remains, or file input retains prior selection.

---

### SS-07 — Begin the Campaign button submits and transitions to chat

**Steps:** Enter Campaign Name "Ironhold", leave other fields at defaults. Click Begin the Campaign.
**PASS:** Setup card disappears. Chat layout renders. Header shows "Ironhold". [localStorage] contains `dnd_setup_done = 1`, `dnd_genre = dnd`, `dnd_campaign_name = Ironhold`, `dnd_model = qwen2.5:14b`. Empty state shown with no messages.
**FAIL:** Click has no effect, localStorage keys are not written, or chat layout does not appear.

---

### SS-08 — All optional field labels include the "(optional)" annotation

**Steps:** Load the setup screen and read each field label text.
**PASS:** Campaign Name, Setting & Context, and Campaign Notes labels each include an `(optional)` annotation rendered via the `.optional` class (italic, smaller, muted color per `App.css`). The Genre and AI Model labels do NOT include "(optional)".
**FAIL:** Any optional field label is missing the annotation, or a non-optional field carries it.

---

### SS-09 — Hint text is visible below each form field

**Steps:** Load the setup screen and read each `.form-hint` text.
**PASS:** Below Genre: "Sets the Game Master's ruleset, voice, and continuity tracking." Below AI Model: "Runs locally via Ollama at localhost:11434 — no API key needed." Below Setting & Context: genre-driven hint from `genre.detailsHint`. Below Campaign Notes: "Load a Markdown file with session notes, NPC lists, or previous events to continue an existing campaign."
**FAIL:** Any hint text is absent or shows the wrong string.

---

## Section 11 — Regression: Streaming and Chat

### SC-01 — Streaming tokens append incrementally to the DM bubble

**Steps:** Send any message and observe the DM bubble during streaming (Ollama live at localhost:11434).
**PASS:** Text grows token-by-token inside the DM bubble without flashing blank between tokens. A `.cursor-blink` character is visible at the text end while streaming. `displayText = stripStructuredBlocks(fullText)` accumulates correctly via `fullText += delta` in `sendMessage`.
**FAIL:** DM bubble flashes blank between token updates, only shows the full response after a delay, or no text appears during streaming.

---

### SC-02 — Bold, italic, and inline code markdown renders in DM responses

**Steps:** Send a message eliciting formatted output. Inspect the DM bubble DOM.
**PASS:** Double-asterisk wrapping renders as `<strong>` (gold-bright color per `.message-content strong`). Single-asterisk wrapping renders as `<em>` (italic, text-secondary). Backtick wrapping renders as `<code>` (monospace, gold color, surface-2 background). HTML special characters `&`, `<`, `>` appear as escaped entities via `parseMarkdown()`'s escape-first chain.
**FAIL:** Asterisks appear as literal characters, raw HTML tags appear in the bubble, or code spans are unstyled.

---

### SC-03 — Error bubble appears when Ollama is unreachable

**Steps:** Block the Ollama endpoint. Send any message.
**PASS:** DM bubble content starts with `*The DM's voice fades into silence...*` followed by `**Error:**` and the error message. The `.dm-message.error` class applies red border (`border-color: var(--red)`) and red-tinted background per `App.css`. `isLoading` resets to false and textarea re-enables.
**FAIL:** App crashes, shows a blank bubble, or no error styling is applied.

---

### SC-04 — Message ordering is Player-then-DM and preserved

**Steps:** Send three messages in sequence, waiting for each DM reply before sending the next.
**PASS:** Messages appear in strict alternating order: Player, DM, Player, DM, Player, DM. No messages are reordered or duplicated.
**FAIL:** A DM reply appears before its triggering player message, or duplicate bubbles appear.

---

### SC-05 — Dice roll messages are excluded from the Ollama API payload as raw role='dice' objects

**Steps:** Roll any die. Send a text message and inspect the POST to `http://localhost:11434/api/chat` in the Network tab.
**PASS:** The request body `messages` array does not contain a raw `{ role: 'dice', ... }` object. Dice messages are converted to `{ role: 'user', content: '[Dice roll: dX → N]' }` by the `messages.map` in `sendMessage` before `trimContext` is called. Only `user` and `assistant` roles appear as raw entries.
**FAIL:** A raw dice object appears verbatim in the network request body.

---

### SC-06 — Message list auto-scrolls to bottom on each new message

**Steps:** Send enough messages to require scrolling. Scroll up manually. Send another message.
**PASS:** After new player and DM bubbles are added, the list scrolls back to the bottom automatically via the `useEffect` on `messages` that calls `messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })`.
**FAIL:** List stays at the previous scroll position after new messages are added.

---

### SC-07 — Textarea auto-resizes up to 140px then caps

**Steps:** Type one line. Add enough Shift+Enter newlines to fill more than two rows.
**PASS:** Textarea height grows with content up to a maximum of 140px (matching `Math.min(el.scrollHeight, 140)` in the resize `useEffect` in `Chat.jsx`). Beyond 140px an internal scrollbar appears rather than further expansion. Height resets to auto after sending.
**FAIL:** Textarea stays at a fixed height regardless of content, or grows beyond 140px without capping.

---

### SC-08 — Enter sends; Shift+Enter inserts a newline

**Steps:** (a) Type hello and press Enter. (b) Type line one, press Shift+Enter, type line two, then press Enter.
**PASS:** (a) "hello" sends as a player message. (b) A two-line message sends as a single player bubble with preserved newline rendered via `white-space: pre-wrap` on `.player-message .message-bubble`. Textarea clears in both cases.
**FAIL:** Enter inserts a newline instead of sending, or Shift+Enter sends the message prematurely.

---

### SC-09 — Textarea is disabled during streaming and focus is restored after

**Steps:** Send a message. Immediately try typing in the textarea during streaming.
**PASS:** The textarea has the `disabled` attribute during streaming (opacity drops to 0.45 per `.message-input:disabled`). After streaming completes, the `useEffect` watching `isLoading` calls `textareaRef.current?.focus()` immediately when `isLoading` becomes false.
**FAIL:** Textarea accepts keystrokes during streaming, or remains disabled after streaming ends.

---

## Section 12 — Regression: Dice Roller

### DR-01 — Dice Roller panel toggles via the dice header button

**Steps:** Click the 🎲 header button once. Click it again.
**PASS:** First click: `.dice-panel` appears below the header with `slideDown` animation (opacity 0→1, translateY -6px→0 per `@keyframes slideDown` in `App.css`). Button has `.active` class. Second click: panel disappears and active class is removed.
**FAIL:** Panel does not appear, animation is absent, or button active state is not toggled.

---

### DR-02 — All 7 die types are present with correct labels and icons

**Steps:** Open the Dice Roller. Inspect all buttons in `.dice-grid`.
**PASS:** Exactly 7 buttons exist with die labels d4, d6, d8, d10, d12, d20, d100 matching `DICE` array in `DiceRoller.jsx`. Each button shows a `.die-icon` (▲ for d4, ⬡ for d6, ◆ for d8, ◈ for d10, ⬟ for d12, ⬡ for d20, % for d100) and a `.die-label`.
**FAIL:** Fewer than 7 dice shown, any label misspelled, or icons missing.

---

### DR-03 — Rolling a die inserts a DiceChip centered in the message list

**Steps:** Open the Dice Roller. Click the d6 button.
**PASS:** A `.dice-chip` element appears centered (not left- or right-aligned). It shows the d6 die tile and an integer result between 1 and 6 inclusive. `handleDiceRoll` in `Chat.jsx` appends `{ role: 'dice', die: 'd6', result: N }` to messages, which `Chat.jsx` renders as `<DiceChip>`.
**FAIL:** No chip appears, the result is outside valid range, or the old `.dice-result` pill renders instead.

---

### DR-04 — d20 result of 20 receives the crit class and CRIT label

**Steps:** In DevTools console run `Math.random = () => 0.95`. Click d20.
**PASS:** The `.dice-chip` element has class `dice-chip--crit`. `.dice-chip-result` has class `dice-chip-result--crit`. A `.dice-chip-crit-label` with text " CRIT" is present. `isCrit` condition in `DiceChip.jsx` is `die === 'd20' && result === 20`.
**FAIL:** No crit class applied, CRIT label absent, or styles incorrect.

---

### DR-05 — d20 result of 1 receives the fumble class and FUMBLE label

**Steps:** In DevTools console run `Math.random = () => 0`. Click d20.
**PASS:** The `.dice-chip` element has class `dice-chip--fumble`. `.dice-chip-result` has class `dice-chip-result--fumble`. A `.dice-chip-fumble-label` with text " FUMBLE" is present. `isFumble` condition in `DiceChip.jsx` is `die === 'd20' && result === 1`.
**FAIL:** No fumble class, FUMBLE label absent, or incorrect styles.

---

### DR-06 — Dice chip has no Player or DM label

**Steps:** Roll any die and observe the resulting DiceChip element in the DOM.
**PASS:** The `.dice-chip` element has no `.message-header` child and no "Player" or "Dungeon Master" text. It is centered via `align-self: center` on the element.
**FAIL:** Dice chip shows a Player or DM label, or is left/right-aligned like a chat bubble.

---

### DR-07 — Rolling while streaming appends the dice chip without disrupting the stream

**Steps:** Send a message to start streaming. While the DM bubble is still receiving tokens, click any die button.
**PASS:** A `.dice-chip` row appears in the message list. DM streaming continues uninterrupted. `isLoading` does not reset. `handleDiceRoll` only calls `setMessages(prev => [...prev, ...])` — it does not touch `isLoading`. No console error thrown.
**FAIL:** Dice roll during streaming causes an error, clears the streaming DM bubble, or is silently ignored.

---

## Section 13 — Regression: Session Controls

### SCC-01 — New session clears messages after confirmation when messages exist

**Steps:** Send at least one message. Click the 🗑 header button.
**PASS:** `window.confirm` appears with "Start a new session? The current conversation will be cleared." Clicking OK triggers `setMessages([])`, `setEntities([])`, `setSessionLog([])`, and `setPendingCheck(null)` per `handleNewSession` in `Chat.jsx`. The empty state re-appears.
**FAIL:** Confirm dialog does not appear, messages remain after clicking OK, or the app errors.

---

### SCC-02 — New session with empty message list skips the confirm dialog

**Steps:** Complete setup so the chat view is shown but send no messages. Click the 🗑 header button.
**PASS:** No `window.confirm` dialog appears (the `messages.length === 0` branch in `handleNewSession` bypasses it). Empty state remains visible with no error.
**FAIL:** Confirm dialog appears when the message list is already empty.

---

### SCC-03 — Settings gear removes dnd_setup_done and returns to setup screen

**Steps:** From chat view, click the ⚙ header button (title="Campaign Settings").
**PASS:** `handleReset` fires in `App.jsx`: `localStorage.removeItem('dnd_setup_done')` called (verify key gone in [localStorage]). App re-renders the setup screen. Campaign Name and model select pre-populate from remaining `dnd_campaign_name` and `dnd_model` localStorage keys. Genre selector pre-populates from `dnd_genre`.
**FAIL:** Chat view remains, `dnd_setup_done` still present, or setup fields blank.

---

### SCC-04 — Clicking a starter prompt sends the full prompt text

**Steps:** Reach the empty state. Click the first starter prompt (genre-appropriate).
**PASS:** A Player bubble appears with the exact prompt text from `genre.starterPrompts[0]`. A DM streaming response begins. Empty state container no longer visible (`messages.length > 0`).
**FAIL:** Click has no effect, wrong text sent, empty state persists, or streaming does not start.

---

### SCC-05 — All 5 header icon buttons are present with correct titles

**Steps:** Inspect the `.header-actions` div in DevTools Elements.
**PASS:** Exactly 5 `<button class="icon-btn">` elements exist with `title` attributes in DOM order: "Campaign History" (📜), "Dice Roller" (🎲), "Character Sheet" (🧙), "New Session" (🗑), "Campaign Settings" (⚙) — matching `Chat.jsx`. The turn-pill is also in `.header-actions` when an active member exists, but is not a button.
**FAIL:** Any button is missing, title text differs from source, or buttons are in the wrong order.

---

### SCC-06 — History and Character button active states are mutually independent

**Steps:** Click 📜 to open history (it gains the active class). Then click 🧙 to open character panel (it also gains active class).
**PASS:** Both buttons can be simultaneously active. 📜 retains `.active` class after 🧙 is clicked. Both panels open at the same time (3-column layout). Each panel closes independently.
**FAIL:** Opening one panel closes the other, or clicking one button removes active class from the other.

---

## Section 14 — Edge Cases

### EC-01 — Corrupt dnd_character JSON in localStorage falls back to defaults

**Steps:** `localStorage.setItem('dnd_character', '{bad json}')`. Hard-refresh. Complete setup. Open CharacterPanel.
**PASS:** No crash. `loadCharacter()` in `App.jsx` catches the parse error and returns `DEFAULT_CHARACTER`. CharacterPanel shows Name=Adventurer, Race=Human, Class=Fighter with all default stat values.
**FAIL:** Unhandled error thrown, page goes blank, or CharacterPanel shows NaN values.

---

### EC-02 — Corrupt dnd_party JSON in localStorage falls back without crash

**Steps:** `localStorage.setItem('dnd_party', 'not json')`. Hard-refresh. Complete setup.
**PASS:** `loadParty()` catches the error and falls through to derive from `dnd_character` or return `DEFAULT_PARTY`. App renders normally. Party strip shows seed data. No uncaught error.
**FAIL:** App crashes or goes blank on load.

---

### EC-03 — Missing dnd_campaign_name and dnd_model keys fall back gracefully

**Steps:** Set only `dnd_setup_done = 1` and `dnd_genre = dnd` in localStorage (remove `dnd_campaign_name` and `dnd_model`). Hard-refresh.
**PASS:** App renders the chat view. Header shows the fallback `genre.headerDefaultName` = 'D&D Campaign'. `campaign.model` defaults to `qwen2.5:14b` via the `|| 'qwen2.5:14b'` fallback in `App.jsx`. No console errors.
**FAIL:** App crashes, renders blank, or shows undefined/null in the header.

---

### EC-04 — Missing dnd_genre key defaults to dnd theme

**Steps:** Set `dnd_setup_done = 1`, `dnd_campaign_name = Test` in localStorage (omit `dnd_genre`). Hard-refresh.
**PASS:** `campaign.genre` defaults to `'dnd'` via `localStorage.getItem('dnd_genre') || 'dnd'` in `App.jsx`. `<html data-theme="dnd">` is set. Header emblem is ⚔. No crash.
**FAIL:** Theme is void or undefined when `dnd_genre` is absent.

---

### EC-05 — Very long DM response renders without layout breakage

**Steps:** Send a prompt designed to elicit a very long response. Wait for completion.
**PASS:** DM bubble expands vertically within the scrollable `.messages-container`. Scrollbar appears as needed. The input area stays anchored at the bottom. No horizontal overflow and chat column does not collapse.
**FAIL:** Input area disappears below viewport, horizontal scrollbar appears on body, or chat column collapses.

---

### EC-06 — Toggling both panels mid-stream does not interrupt streaming

**Steps:** Send a message. While streaming, click 📜 to open HistoryPanel, then 🧙 to open CharacterPanel.
**PASS:** Streaming continues and tokens append to the DM bubble through both panel transitions. No console error appears. The response is complete when streaming finishes.
**FAIL:** Streaming halts or truncates during a panel toggle, or a console error fires.

---

### EC-07 — Both panels open simultaneously do not collapse the chat column

**Steps:** Open both HistoryPanel and CharacterPanel at the same time.
**PASS:** `.app-layout` shows three visible columns. Chat column = viewport width minus `var(--panel-width)` (280px) × 2. Chat column has `min-width: 0` so it shrinks without hiding content. Messages, input, and header remain usable.
**FAIL:** Chat column collapses to zero width, content is hidden, or a horizontal scrollbar appears on the page body.

---

### EC-08 — Non-numeric input in numeric CharacterPanel fields defaults to 0

**Steps:** Click HP current. Type abc. Click elsewhere (blur).
**PASS:** HP becomes 0 (`Number(draft) || 0` in `InlineEdit.onBlur` for `type="number"`). No NaN or crash.
**FAIL:** NaN shown, crash, or previous value retained.

---

### EC-09 — Rapid double-send does not duplicate the message

**Steps:** Type a message. Double-click the send button or press Enter twice rapidly.
**PASS:** Only one Player bubble and one DM bubble appear. The `!trimmed || isLoading` guard in `sendMessage` prevents a second call once `isLoading` is true. Only one network request visible in Network tab.
**FAIL:** Two Player bubbles appear with the same text, or two concurrent Ollama requests are visible.

---

### EC-10 — Network drop mid-stream produces an error bubble

**Steps:** Start a long DM response. While streaming, use DevTools > Network to set throttling to Offline.
**PASS:** The in-progress DM bubble transitions to error state: content contains the italicised silence phrase and bold Error prefix. `error: true` flag applies `.dm-message.error` red styling. `isLoading` resets to false and textarea re-enables.
**FAIL:** App hangs indefinitely with textarea disabled, or unhandled Promise rejection fires.

---

### EC-11 — Special characters and emoji in user input are displayed correctly

**Steps:** Type a message containing angle brackets, ampersands, emoji, and accented characters. Send it.
**PASS:** Player bubble displays the exact typed text rendered via React text interpolation (not `dangerouslySetInnerHTML`), preventing injection. No characters stripped or double-encoded. Ollama request body contains the literal string.
**FAIL:** Characters stripped or corrupted, or any unintended script execution occurs.

---

### EC-12 — XSS attempt in DM response is escaped by parseMarkdown

**Steps:** Mock the Ollama stream to return a string containing `<img src=x onerror=alert(1)>` followed by bold markdown. Observe DM bubble.
**PASS:** `parseMarkdown` in `Chat.jsx` escapes `<` to `&lt;` and `>` to `&gt;` in the `escaped` variable before any markdown replacement runs. The rendered output shows the img syntax as visible escaped text. No alert fires and no img DOM node is injected.
**FAIL:** An img element is created in the DOM, the onerror callback fires, or an alert appears.

---

### EC-13 — Page reload during active streaming recovers cleanly

**Steps:** Start streaming a DM response. Immediately hard-refresh (Ctrl+Shift+R).
**PASS:** Page reloads and, because `dnd_setup_done` is in localStorage, chat view renders directly. The aborted fetch is discarded by the browser. Message list starts empty (messages not persisted). No console errors on load.
**FAIL:** App shows an indefinite loading state, crashes, or displays partial content.

---

### EC-14 — localStorage quota exhaustion is handled without crashing the app

**Steps:** Fill localStorage near quota in DevTools console. Then edit any character field in CharacterPanel.
**PASS:** The `setItem` call throws `QuotaExceededError`. The React `setCharacter` state update still succeeds so the UI reflects the edit in memory. No unhandled rejection crashes or blanks the app.
**FAIL:** App crashes, goes blank, or an unhandled error breaks the UI entirely.

---

### EC-15 — Switching model in settings uses the new model for the next request

**Steps:** Complete setup with `qwen2.5:14b`. Click ⚙ to return to setup. Change AI Model to `qwen2.5:32b`. Click Begin the Campaign. Send a message. Inspect the POST to Ollama in Network tab.
**PASS:** Request body contains `"model": "qwen2.5:32b"`. [localStorage] `dnd_model = qwen2.5:32b`. `campaign.model` reflects the new value passed through `handleSetup` in `App.jsx`.
**FAIL:** Network request still sends `qwen2.5:14b`, localStorage not updated, or setup rejects the change.

---

### EC-16 — Switching genre in settings applies new theme and GM name

**Steps:** Complete setup with dnd. Click ⚙. Change Genre to starwars. Click Begin the Campaign.
**PASS:** Chat view renders with `<html data-theme="void">`. Header emblem is ✦. Header subtitle reads Game Master Assistant. [localStorage] `dnd_genre = starwars`. DM bubble label reads Game Master not Dungeon Master.
**FAIL:** Theme stays dnd, or GM label remains Dungeon Master, or `dnd_genre` not updated.

---

## Section 15 — Accessibility Basics

### ACC-01 — All 5 header icon buttons are keyboard reachable via Tab

**Steps:** Click a neutral area of the header. Press Tab repeatedly.
**PASS:** Each of the 5 `.icon-btn` buttons receives keyboard focus in left-to-right DOM order: Campaign History, Dice Roller, Character Sheet, New Session, Campaign Settings. A visible focus ring appears on each. No button is skipped.
**FAIL:** Any button is not reachable via Tab, or focus jumps over a button in sequence.

---

### ACC-02 — Focus remains predictable after panel toggle via keyboard

**Steps:** Tab to the Campaign History button and press Space to open the history panel. Press Tab again.
**PASS:** After the panel opens, Tab moves focus to the next focusable element in DOM order — the `.history-panel-toggle` tab button on the panel edge. Focus does not vanish or jump to an unrelated element.
**FAIL:** Focus disappears to body, jumps unexpectedly, or becomes trapped inside the panel.

---

### ACC-03 — Focus returns to the textarea automatically after message send

**Steps:** Type a message. Press Enter to send. Wait for streaming to complete.
**PASS:** The textarea has keyboard focus without any user click after streaming ends (confirmed by `textareaRef.current?.focus()` in the `finally` block of `sendMessage`). Pressing a key immediately after streaming types into the textarea.
**FAIL:** Focus remains on the send button, goes to body, or requires a click to restore.

---

### ACC-04 — Inline-edit fields in CharacterPanel are activatable by click

**Steps:** Open CharacterPanel. Click the character name span. Then click the STR ability score value.
**PASS:** Each clicked `.char-inline-value` span transitions to a `.char-inline-input` with `autoFocus` (per `InlineEdit` in `CharacterPanel.jsx`), making it immediately editable. The input captures Enter and Escape key events.
**FAIL:** Clicking an inline value has no effect, or the input appears without receiving focus.

---

### ACC-05 — Enter commits and Escape cancels inline edits

**Steps:** Click the character name to enter edit mode. Type New Name. Press Enter. Click the name again, type Wrong, press Escape.
**PASS:** Enter calls `e.target.blur()` triggering `onBlur`, which commits the value to state and localStorage. Escape resets `draft` to the original `value` and closes the input without saving. Both key handlers are in the `onKeyDown` callback in `InlineEdit`.
**FAIL:** Enter or Escape have no effect, or Escape commits the wrong value.

---

### ACC-06 — Primary gold-on-dark text meets WCAG AA contrast ratio

**Steps:** In DevTools > Accessibility pane inspect `.campaign-name` (color `var(--gold-bright)` on `var(--surface-1)`) and `.message-content` text (color `var(--text-primary)` on `var(--surface-1)`).
**PASS:** DevTools reports contrast ratio at or above 4.5:1 for both elements (WCAG AA for normal text). Verify for both dnd theme and void theme separately since token values differ.
**FAIL:** Either element shows a ratio below 4.5:1 in the DevTools accessibility inspector on either theme.

---

### ACC-07 — All icon buttons have descriptive title attributes

**Steps:** Inspect each `.icon-btn` element in DevTools Elements and check the `title` attribute value.
**PASS:** All 5 buttons have non-empty, descriptive title values matching `Chat.jsx`: Campaign History, Dice Roller, Character Sheet, New Session, Campaign Settings. These serve as tooltip text and accessible name for screen readers.
**FAIL:** Any title is missing, empty, or set to a generic placeholder.

---

### ACC-08 — No keyboard trap exists inside either side panel

**Steps:** Open CharacterPanel. Tab through all focusable elements inside it. Continue pressing Tab.
**PASS:** After the last focusable element inside the panel, Tab moves focus out to the next focusable element in the page (the textarea or send button in the chat column). Focus is never trapped inside the panel.
**FAIL:** Tab cycles indefinitely within the panel with no way to exit without pressing Escape or clicking outside.
