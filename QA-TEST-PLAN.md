# D&D Campaign Assistant — QA Test Plan
## Post-UI-Overhaul Release Candidate

**App URL:** http://localhost:5173
**Ollama endpoint:** http://localhost:11434
**Date authored:** 2026-05-23
**React version:** 18 | **Build tool:** Vite
**localStorage keys under test:** dnd_setup_done, dnd_campaign_name, dnd_campaign_details, dnd_model, dnd_campaign_context, dnd_character

---

## Test Suite Summary

| Section | Tests |
|---------|-------|
| 1. Critical Golden Path | 12 |
| 2. CharacterPanel (new) | 18 |
| 3. HistoryPanel (new) | 8 |
| 4. Player-Choice Buttons (new) | 10 |
| 5. Visual Overhaul (new) | 7 |
| 6. Regression — Setup Screen | 8 |
| 7. Regression — Streaming and Chat | 9 |
| 8. Regression — Dice Roller | 7 |
| 9. Regression — Session Controls | 6 |
| 10. Edge Cases | 14 |
| 11. Accessibility Basics | 8 |
| **Total** | **107** |

---

## Notation

- **PASS criteria** are stated as observable facts in the browser.
- **FAIL criteria** are the opposite observable state or an error condition.
- [localStorage] = open DevTools > Application > Local Storage > http://localhost:5173.
- [console] = open DevTools > Console.
---

## Section 1 — Critical Golden Path

These 12 tests cover a complete first-run to setup to conversation to panels flow. All must pass before any release.

### GP-01 — First load shows setup screen when no prior session exists

**Precondition:** Run localStorage.clear() in DevTools console, then hard-refresh.
**Steps:** Navigate to http://localhost:5173.
**PASS:** Setup card is visible. The sword emblem, D&D Campaign Assistant heading, and Begin the Campaign button are present. The chat layout is NOT visible.
**FAIL:** Chat layout renders on first load, or page is blank or throws an unhandled error.

---

### GP-02 — Setup screen persists the correct localStorage keys on submit

**Precondition:** localStorage cleared.
**Steps:** Set Campaign Name to Test Keep, leave Setting & Context blank, leave model on default (qwen2.5:14b). Click Begin the Campaign.
**PASS:** [localStorage] keys dnd_setup_done = 1, dnd_campaign_name = Test Keep, dnd_model = qwen2.5:14b all exist. dnd_campaign_details key exists (empty string acceptable).
**FAIL:** Any of those keys are absent, or values do not match input.

---

### GP-03 — Campaign name appears in chat header after setup

**Precondition:** GP-02 completed.
**Steps:** Observe the chat header after setup submits.
**PASS:** The .campaign-name element reads Test Keep. The subtitle Dungeon Master Assistant is visible below it.
**FAIL:** Header shows fallback D&D Campaign instead of Test Keep, or subtitle is missing.

---

### GP-04 — Empty state displays on first entry to chat

**Precondition:** GP-03 completed; no messages sent yet.
**Steps:** Observe the main message area.
**PASS:** Floating map emblem visible, heading Your adventure awaits... shown, exactly 3 starter prompt buttons present: (1) Begin the adventure — set the scene and describe where we are. (2) The party enters a dimly lit tavern. What do we see? (3) We arrive at the dungeon entrance. What dangers await?
**FAIL:** Empty state missing, heading text differs, or wrong number of starter prompts.

---

### GP-05 — Typing a message and pressing Enter sends it and triggers streaming

**Precondition:** Empty state visible.
**Steps:** Click the textarea. Type I look around the entrance hall carefully. Press Enter.
**PASS:** (a) User bubble appears right-aligned with label Player and typed text. (b) DM bubble appears below it left-aligned with label Dungeon Master. (c) While streaming, textarea is disabled (opacity 0.45 per .message-input:disabled CSS). (d) Typing dots or blinking cursor appears in DM bubble. (e) Send button is disabled.
**FAIL:** No DM bubble appears, textarea stays enabled during streaming, or Ollama fetch error thrown in console.

---

### GP-06 — Streaming completes and input refocuses

**Precondition:** GP-05 in progress. Wait for streaming to finish.
**Steps:** Wait until typing dots and blinking cursor are both gone.
**PASS:** (a) Full DM response text rendered. (b) Textarea re-enabled. (c) Textarea has keyboard focus without clicking. (d) Send button enabled again.
**FAIL:** Textarea remains disabled, focus does not return, or DM bubble content empty after completion.

---

### GP-07 — Session log records the sent message in HistoryPanel

**Precondition:** GP-06 completed.
**Steps:** Click the scroll icon header button to open HistoryPanel.
**PASS:** Session Log section has one entry with a HH:MM timestamp and the sent message text (truncated at 60 chars). Session Entities section shows either chips or the placeholder Entities will appear as the story unfolds...
**FAIL:** Session log empty, timestamp missing or malformed, or panel does not open.

---

### GP-08 — CharacterPanel opens and shows default values

**Precondition:** Fresh session, no prior dnd_character in localStorage.
**Steps:** Click the wizard icon header button.
**PASS:** Right sidebar slides open (width transitions 0 to 280px). Panel shows: Name=Adventurer, Race=Human, Class=Fighter, HP=20/20, AC=15, Initiative=2, Speed=30, all 6 ability scores=10 with +0 modifier, no conditions active.
**FAIL:** Panel does not open, wrong defaults, or no HP bar visible.

---

### GP-09 — Player-choice buttons appear after a completed DM response

**Precondition:** At least one DM message complete.
**Steps:** Observe the area below the most recent DM bubble.
**PASS:** 3-4 action suggestion buttons visible below the last DM bubble. Buttons match one of the four keyword groups: combat (Attack / Cast a Spell / Take Cover / Flee), social (Persuade / Intimidate / Ask a question / Offer coin), exploration (Search the area / Listen carefully / Examine it closely / Proceed cautiously), or default (Describe my action / Ask the DM / Roll for it / What do I know?).
**FAIL:** No action buttons appear, they appear during streaming, or appear on a non-last DM message.

---

### GP-10 — Clicking a player-choice button sends it as a user message

**Precondition:** GP-09 — action buttons visible.
**Steps:** Click any one of the action suggestion buttons.
**PASS:** (a) Player bubble with button text appears. (b) New DM bubble begins streaming. (c) Action buttons disappear from below the old DM bubble (it is no longer lastAssistantIndex).
**FAIL:** Button click does nothing, text not sent, or old buttons remain below a non-final DM message.

---

### GP-11 — Settings reset returns to setup screen and clears ready state

**Precondition:** In chat view.
**Steps:** Click the gear icon header button.
**PASS:** Setup screen re-renders. [localStorage] key dnd_setup_done is removed. Campaign name and model fields populate from remaining localStorage keys.
**FAIL:** App stays on chat view, key not removed, or setup screen fields blank.

---

### GP-12 — Page reload with valid localStorage skips setup

**Precondition:** GP-02 completed.
**Steps:** Hard-refresh the page (Ctrl+Shift+R).
**PASS:** Chat view renders directly. Setup screen is skipped. Campaign name in header matches stored value.
**FAIL:** Setup screen appears despite dnd_setup_done being present.
---

## Section 2 — CharacterPanel New Feature Tests

### CP-01 — Panel toggle via header button and side tab are both functional

**Steps:** (a) Click wizard icon in header — panel opens. Click again — closes. (b) Open panel, then click the left-edge tab button (angle bracket) — panel closes. Click it again — opens.
**PASS:** Both controls toggle. Wizard icon has active CSS class while panel is open. Tab arrow shows right-bracket when closed and left-bracket when open, matching isOpen ternary in CharacterPanel source.
**FAIL:** Either control has no effect, active class not applied, or arrow direction wrong.

---

### CP-02 — Character name is inline-editable

**Steps:** Open CharacterPanel. Click the character name Adventurer. Type Thorin Stonehelm. Press Enter.
**PASS:** Input appears with autoFocus when clicked. After Enter, span shows Thorin Stonehelm. [localStorage] dnd_character.name = Thorin Stonehelm.
**FAIL:** Clicking name does not show input, Enter does not commit, or localStorage not updated.

---

### CP-03 — Escape key cancels inline edit without saving

**Steps:** Click character name. Change to WRONG NAME. Press Escape.
**PASS:** Input closes and original name restored. WRONG NAME does not appear in span or localStorage.
**FAIL:** Escape commits the change, or field remains open.

---

### CP-04 — Race and Class are separately editable

**Steps:** Click Race (Human) — edit to Elf, Enter. Click Class (Fighter) — edit to Ranger, Enter.
**PASS:** Display shows Elf / Ranger. [localStorage] dnd_character contains race:Elf and charClass:Ranger.
**FAIL:** Fields not clickable, separator disappears, or localStorage not updated.

---

### CP-05 — HP bar width updates when current HP is edited

**Steps:** Default HP 20/20 (100% bar). Click current HP, change to 10, Enter.
**PASS:** HP bar fill narrows to approximately 50% of track. Bar transitions smoothly (0.3s). Current HP displays 10.
**FAIL:** Bar width unchanged, bar overflows track, or HP reverts to 20.

---

### CP-06 — HP bar clamps at 0% and 100% — never overflows

**Steps:** (a) Set current HP to 0, Enter. (b) Set current HP to 999, Enter.
**PASS:** At 0, bar fill = 0%. At 999, bar fill = 100% (clamped by Math.max(0, Math.min(100, ...))). Bar stays within track in both cases.
**FAIL:** Bar extends beyond track, goes negative, or shows wrong percentage.

---

### CP-07 — HP bar when max is 0 shows 0% without crash

**Steps:** Set HP Max to 0, Enter.
**PASS:** Bar shows 0% (the hpMax > 0 guard in source returns 0%). No console error. App does not crash.
**FAIL:** Console error about division by zero, NaN, or app crash.

---

### CP-08 — AC, Initiative, and Speed badges are individually editable

**Steps:** Click AC (15) -> 18, Enter. Click Init (2) -> 5, Enter. Click Speed (30) -> 40, Enter.
**PASS:** All three badges show updated values. [localStorage] dnd_character has ac:18, initiative:5, speed:40.
**FAIL:** Any badge not clickable, value not saved, or badges clobber each other.

---

### CP-09 — All 6 ability scores display correct auto-calculated modifiers

**Steps:** Verify default 10 shows +0. Set STR=20 (expect +5), DEX=8 (expect -1), CON=1 (expect -5), INT=30 (expect +10).
**PASS:** Modifier below each score matches Math.floor((score-10)/2), shown as +N or -N.
**FAIL:** Modifier not shown, formula wrong, or positive modifiers lack + sign.

---

### CP-10 — Ability score of 0 calculates modifier as -5 without crash

**Steps:** Click STR, set to 0, Enter.
**PASS:** STR shows 0. Modifier shows -5. No crash or NaN in console.
**FAIL:** App crashes, NaN shown, or wrong modifier.

---

### CP-11 — Ability score of 30 calculates modifier as +10

**Steps:** Click CHA, set to 30, Enter.
**PASS:** CHA shows 30. Modifier shows +10. localStorage updated.
**FAIL:** Modifier wrong or not shown.

---

### CP-12 — Non-numeric input in numeric fields defaults to 0

**Steps:** Click HP current. Type abc. Click elsewhere (blur).
**PASS:** HP becomes 0 (Number(draft) || 0 fallback in InlineEdit onBlur). No NaN or crash.
**FAIL:** NaN shown, crash, or previous value retained.

---

### CP-13 — Condition chips toggle on and off

**Steps:** Click Poisoned chip. Observe. Click again.
**PASS:** After first click: chip has char-condition-chip--active class, red-tinted background. After second click: reverts to inactive. [localStorage] dnd_character.conditions reflects current state.
**FAIL:** Visual state unchanged, toggle does not work, or localStorage not updated.

---

### CP-14 — Multiple conditions can be active simultaneously

**Steps:** Click Poisoned, Frightened, and Prone chips.
**PASS:** All three chips show as active (red tint). [localStorage] dnd_character.conditions contains all three.
**FAIL:** Only one condition active at a time, or fewer than three stored.

---

### CP-15 — All 6 conditions are present with correct labels

**Steps:** Open CharacterPanel with fresh character.
**PASS:** Exactly 6 condition chips: Poisoned, Frightened, Restrained, Prone, Blinded, Incapacitated. Labels exact.
**FAIL:** Any condition missing, renamed, or extra conditions appear.

---

### CP-16 — Character sheet persists across page reload

**Steps:** Set Name=Lyria, Race=Half-Elf, Class=Bard, HP=15/22, STR=14, activate Blinded. Reload.
**PASS:** After reload CharacterPanel shows all saved values. Bar shows ~68% fill. Blinded chip active.
**FAIL:** Any field reverts to default, or dnd_character not read on mount.

---

### CP-17 — CharacterPanel edits do not cause message list to flash or jump

**Steps:** Send one message, wait for DM response. Open CharacterPanel. Edit character name.
**PASS:** Message list does not flash, re-render, or lose scroll position when character state updates.
**FAIL:** Message list flashes or scroll jumps when character edited.

---

### CP-18 — Closing panel mid-edit commits the edit via blur

**Steps:** Click character name to enter edit mode. Type New Name. Click elsewhere to blur. Open panel again.
**PASS:** onBlur fires, committing New Name. Panel reopened shows New Name stored.
**FAIL:** App crashes, or corrupt/empty value stored.
---

## Section 3 — HistoryPanel New Feature Tests

### HP-01 — Panel toggle via header button and side tab are both functional

**Steps:** Click scroll icon in header to open. Click again to close. Open again then click the right-edge tab button to close.
**PASS:** Both controls work. Scroll icon has active class while open. Tab arrow shows the left-angle when open and right-angle when closed, matching the HistoryPanel isOpen ternary which is the opposite of CharacterPanel.
**FAIL:** Either control non-functional, wrong arrow direction, or active class missing.

---

### HP-02 — Session Entities section shows placeholder before any messages

**Steps:** Open HistoryPanel before any message sent.
**PASS:** Session Entities section shows: Entities will appear as the story unfolds...
**FAIL:** Section blank, shows error, or shows chips from a prior session.

---

### HP-03 — Session Log shows placeholder before any messages

**Steps:** Observe Session Log with no messages sent.
**PASS:** Session Log section shows: Your actions will be logged here...
**FAIL:** Section blank or shows stale data.

---

### HP-04 — Session Log records each sent message with timestamp

**Steps:** Send I search for hidden doors. Wait for DM response. Send I attack the goblin.
**PASS:** Session Log has 2 entries. Each has a timestamp in HH:MM format. Entries in order sent.
**FAIL:** Entries missing, timestamps absent or wrong format, or out of order.

---

### HP-05 — Session Log truncates long messages at 60 characters

**Steps:** Send a message at least 80 characters long.
**PASS:** Session log entry shows only the first 60 characters from trimmed.slice(0,60) in sendMessage. Characters 61+ do not appear.
**FAIL:** Full text shown for long messages.

---

### HP-06 — Entity chips appear after DM response with bolded proper nouns

**Steps:** Send: What is the name of the innkeeper? Wait for DM response.
**PASS:** If DM response contains a bold name passing entity heuristics (proper-noun shape, not a mechanics term per context.js blocklists), one or more entity chips appear in Session Entities after streaming completes. Note: extractEntities called in the finally block of sendMessage.
**FAIL:** Chips never appear after any response, or mechanics terms like Perception or Armor Class appear as chips.

---

### HP-07 — Entity chips and session log clear on new session

**Steps:** Accumulate chips and log entries. Click trash icon and confirm.
**PASS:** Both sections revert to placeholder text.
**FAIL:** Old entities or log entries persist after session clear.

---

### HP-08 — HistoryPanel open does not block message sending

**Steps:** Open HistoryPanel. Type and send a message.
**PASS:** Message sends normally. Chat column narrows with the 3-column grid but remains functional.
**FAIL:** Panel open state prevents input, or chat column collapses to zero.

---

## Section 4 — Player-Choice Buttons New Feature Tests

### PCB-01 — Action buttons appear only after streaming is complete

**Steps:** Send a message. Observe DM bubble during and after streaming.
**PASS:** During streaming (isLoading true) no buttons appear. After completion (isLoading false and content.length > 0) buttons appear below the last DM bubble.
**FAIL:** Buttons appear mid-stream, or never appear after completion.

---

### PCB-02 — Combat keywords route to combat action set

**Steps:** Send: A goblin attacks me! Wait for DM response containing at least one of: attack, sword, enemy, creature, monster, fight, weapon, combat, battle, strike.
**PASS:** Exactly 4 buttons shown: Attack / Cast a Spell / Take Cover / Flee.
**FAIL:** Wrong set or wrong count of buttons.

---

### PCB-03 — Social keywords route to social action set

**Steps:** Send: I enter the tavern and speak to the innkeeper. Wait for DM response containing at least one of: says, asks, merchant, guard, innkeeper, tavern, town, village, noble, coin, price.
**PASS:** Exactly 4 buttons: Persuade / Intimidate / Ask a question / Offer coin.
**FAIL:** Wrong set or default fallback shown.

---

### PCB-04 — Exploration keywords route to exploration action set

**Steps:** Send: I push open the dungeon door. Wait for DM response containing at least one of: door, chest, hallway, dungeon, trap, ruin, passage, stairs, forest, cave.
**PASS:** Exactly 4 buttons: Search the area / Listen carefully / Examine it closely / Proceed cautiously.
**FAIL:** Wrong set shown.

---

### PCB-05 — Default fallback set appears when no keywords match

**Steps:** Send: What is the sky like today? (unlikely to trigger any keyword group).
**PASS:** Exactly 4 buttons: Describe my action / Ask the DM / Roll for it / What do I know?
**FAIL:** Incorrect keyword set shown, or no buttons appear.

---

### PCB-06 — Action buttons appear only on the LAST DM message

**Steps:** Send 3 messages, wait for all 3 DM responses to complete.
**PASS:** Buttons appear only below the 3rd DM bubble. The 1st and 2nd DM bubbles have no action buttons.
**FAIL:** Action buttons appear on multiple DM bubbles simultaneously.

---

### PCB-07 — Clicking an action button removes the old buttons

**Steps:** After receiving a DM response with buttons visible, click one of the action buttons.
**PASS:** Clicked text sent as player message. Old buttons disappear since that message is no longer lastAssistantIndex. New DM response begins.
**FAIL:** Old buttons remain below the previous DM bubble after new exchange starts.

---

### PCB-08 — Action buttons disappear while a new request is in flight

**Steps:** After one complete exchange with buttons visible, send a second message immediately.
**PASS:** As soon as isLoading becomes true the previous action buttons disappear. The showSuggestions condition gates on !isLoading.
**FAIL:** Buttons from previous response remain visible during new loading state.

---

### PCB-09 — Long DM response still produces action buttons

**Steps:** Send: Describe the entire history of the dungeon across 10 paragraphs. Wait for completion.
**PASS:** After streaming completes, action buttons appear below the DM bubble regardless of response length.
**FAIL:** Buttons do not appear for long responses, or app crashes.

---

### PCB-10 — Empty DM content (error case) does not show action buttons

**Steps:** Stop Ollama or set model to nonexistent:model. Send a message. Observe error DM bubble.
**PASS:** No action buttons below the error bubble. msg.content.length > 0 condition prevents it. Red border visible on error bubble.
**FAIL:** Action buttons appear below error or empty DM bubble.

---

## Section 5 — Visual Overhaul

### VO-01 — 3-column grid layout with both panels closed

**Steps:** Open the app with both HistoryPanel and CharacterPanel closed (default state).
**PASS:** `.app-layout` renders as a CSS grid with `grid-template-columns: 0px 1fr 0px`. The chat column fills the full viewport width. No white space or gap is visible on left or right edge.
**FAIL:** Chat column has visible lateral gaps, or the grid shows non-zero widths for the closed panel columns.

---

### VO-02 — Body noise texture is present over the dark background

**Steps:** Load the app. In DevTools > Elements select `body`. Inspect `background-image` in Computed Styles.
**PASS:** The `background-image` references a `data:image/svg+xml` URL containing `feTurbulence` (the SVG noise filter) as well as two `radial-gradient` layers. A subtle grain is visible on the dark background at 100% zoom.
**FAIL:** `background-image` is `none` or shows a plain flat colour with no SVG noise texture.

---

### VO-03 — DM bubble left border and inner glow are applied

**Steps:** Send any message and wait for the DM response to complete.
**PASS:** The `.dm-bubble` element has `border-left: 2px solid var(--gold-dim)` (computed ~`2px solid #7a6230`). The inset `box-shadow` `inset 0 0 30px rgba(201,168,76,0.04)` is present. A faint gold top-edge gradient from the `::before` pseudo-element is visible at the top of the bubble.
**FAIL:** DM bubble has a uniform border on all four sides with no left accent, or the inner glow is absent.

---

### VO-04 — Floating empty-state map emblem animation plays

**Steps:** Clear localStorage and reload. Complete setup to reach the empty chat state.
**PASS:** The `.empty-emblem` map icon visibly floats up and down with a smooth 3-second cycle. In DevTools > Elements > Computed > Animations the `float` keyframe animation is listed on `.empty-emblem` with `3s ease-in-out infinite`.
**FAIL:** Emblem is static with no movement, or the animation entry is present but paused.

---

### VO-05 — Glowing input focus ring appears on textarea focus

**Steps:** Click into the message textarea.
**PASS:** The textarea border changes to `var(--gold-dim)` (#7a6230) and a `box-shadow: 0 0 0 2px rgba(201,168,76,0.25)` glow ring appears. No default blue browser outline is visible (`outline: none` set in CSS).
**FAIL:** Default browser blue outline is shown, or no visible gold ring appears on focus.

---

### VO-06 — Action suggestion buttons use Cinzel font and gold border styling

**Steps:** Send a message, wait for a complete DM response, and observe the action buttons below the DM bubble.
**PASS:** Each `.action-btn` has `font-family: Cinzel, serif` in Computed Styles, `border: 1px solid var(--border-gold)` (#5a4020), `border-radius: 3px`, and a transparent background. On hover the border transitions to `var(--gold)` (#c9a84c) and text to `var(--gold-bright)` (#e8c87a).
**FAIL:** Buttons use a default sans-serif font, have a solid background fill, or hover state does not change colour.

---

### VO-07 — Header emblem renders at 32px with gold drop-shadow

**Steps:** Observe the sword emblem at the left side of the chat header.
**PASS:** In Computed Styles, `.header-emblem` has `font-size: 32px` and a `filter` containing two `drop-shadow` layers: one at `rgba(201,168,76,0.6)` with 14px spread and one at `rgba(201,168,76,0.3)` with 4px spread. A visible gold glow is perceptible around the emblem.
**FAIL:** Emblem appears at a different size, has no glow, or displays a default black drop-shadow.

---
## Section 6 — Regression: Setup Screen

### SS-01 — Model selector contains exactly the two documented options

**Steps:** Clear localStorage, load the app, open the AI Model dropdown on the setup screen.
**PASS:** Exactly 2 options exist: value `qwen2.5:14b` labelled "Qwen 2.5 14B — Fast & capable (recommended)" and value `qwen2.5:32b` labelled "Qwen 2.5 32B — Richer narration, slower", matching the OLLAMA_MODELS array in ApiKeySetup.jsx. The first option is pre-selected by default.
**FAIL:** Fewer or more than 2 options exist, labels or values differ from source, or no option is pre-selected.

---

### SS-02 — Campaign Name field is optional and accepts free text

**Steps:** Leave Campaign Name blank. Click Begin the Campaign.
**PASS:** Form submits successfully. `dnd_campaign_name` in localStorage is an empty string. The chat header shows the fallback "D&D Campaign" text (from `campaign.name || 'D&D Campaign'` in Chat.jsx).
**FAIL:** Form blocks submission with a validation error when Campaign Name is empty.

---

### SS-03 — Setting & Context textarea accepts multi-line input

**Steps:** Click the Setting & Context textarea. Type line one, press Shift+Enter, type line two.
**PASS:** Both lines appear in the textarea separated by a newline. The textarea has `resize: vertical` per CSS. The submitted `dnd_campaign_details` localStorage value preserves the newline.
**FAIL:** Shift+Enter submits the form or is ignored, or multi-line text is not accepted.

---

### SS-04 — .md file upload populates context and shows the filename

**Steps:** Create a file called notes.md containing "Session 1: party met Gareth." Click "Load .md file" and select it.
**PASS:** The upload label is replaced by a `.file-loaded` row showing a document icon, "notes.md", and a clear button. After submitting, `dnd_campaign_context` in localStorage contains the file content.
**FAIL:** File row does not appear, filename is not shown, or context is not stored.

---

### SS-05 — File clear button removes the loaded file and restores the upload label

**Steps:** Load a .md file per SS-04. Click the clear button (the x icon).
**PASS:** The `.file-loaded` row disappears and the "Load .md file" label reappears. The hidden file input value is reset via `fileInputRef.current.value = ''` in `clearFile()`. The `context` state returns to an empty string.
**FAIL:** Clear button has no effect, old filename remains, or file input retains the prior selection.

---

### SS-06 — Begin the Campaign button submits and transitions to chat

**Steps:** Enter Campaign Name "Ironhold", leave other fields at defaults. Click Begin the Campaign.
**PASS:** Setup card disappears. Chat layout renders. Header shows "Ironhold". [localStorage] contains `dnd_setup_done = 1`, `dnd_campaign_name = Ironhold`, `dnd_model = qwen2.5:14b`. The empty state is shown with no messages.
**FAIL:** Click has no effect, localStorage keys are not written, or chat layout does not appear.

---

### SS-07 — All optional field labels include the "(optional)" annotation

**Steps:** Load the setup screen and read each field label text.
**PASS:** Campaign Name, Setting & Context, and Campaign Notes labels each include an "(optional)" annotation rendered via the `.optional` class (italic, smaller, muted colour per CSS). The AI Model label does NOT include "(optional)".
**FAIL:** Any optional field label is missing the annotation, or a non-optional field carries it.

---

### SS-08 — Hint text is visible below each form field

**Steps:** Load the setup screen and read the `.form-hint` text below each field.
**PASS:** Below AI Model: "Runs locally via Ollama at localhost:11434 — no API key needed." Below Setting & Context: hint referencing setting, party composition, tone, and house rules. Below Campaign Notes: hint referencing Markdown files, session notes, NPC lists, and continuing a campaign.
**FAIL:** Any hint text is absent or shows the wrong string.

---
## Section 7 — Regression: Streaming and Chat

### SC-01 — Streaming tokens append incrementally to the DM bubble

**Steps:** Send any message and observe the DM bubble during streaming (Ollama live at localhost:11434).
**PASS:** Text grows token-by-token inside the DM bubble without flashing blank between tokens. A `.cursor-blink` character is visible at the text end while streaming. Tokens accumulate without replacing prior content (the `fullText +=` accumulation pattern in `sendMessage` in Chat.jsx).
**FAIL:** DM bubble flashes blank between token updates, only shows the full response after a delay, or no text appears during streaming.

---

### SC-02 — Bold, italic, and inline code markdown renders in DM responses

**Steps:** Send a message that elicits formatted output (e.g., "List one thing in bold, one in italics, one as inline code."). Inspect the DM bubble DOM.
**PASS:** Double-asterisk wrapping renders as `<strong>` (gold-bright colour per `.message-content strong`). Single-asterisk wrapping renders as `<em>` (italic, text-secondary per `.message-content em`). Backtick wrapping renders as `<code>` (monospace, gold colour, surface-2 background). HTML special characters `&`, `<`, `>` in DM text appear as escaped entities, not raw markup.
**FAIL:** Asterisks appear as literal characters, raw HTML tags appear in the bubble, or code spans are unstyled.

---

### SC-03 — Error bubble appears when Ollama is unreachable

**Steps:** Block the Ollama endpoint (stop the service or use DevTools request blocking). Send any message.
**PASS:** The DM bubble receives content starting with `*The DM's voice fades into silence...*` followed by `**Error:**` and the error message. The `.dm-message.error` class applies red border and red-tinted background per CSS. `isLoading` resets to false and the textarea re-enables.
**FAIL:** App crashes, shows a blank bubble, or no error styling is applied.

---

### SC-04 — Message ordering is Player-then-DM and preserved

**Steps:** Send three messages in sequence, waiting for each DM reply before sending the next.
**PASS:** Messages appear in strict alternating order: Player, DM, Player, DM, Player, DM. No messages are reordered or duplicated. Earlier exchanges are in correct chronological order when scrolled up.
**FAIL:** A DM reply appears before its triggering player message, or duplicate bubbles appear.

---

### SC-05 — Dice roll messages are excluded from the Ollama API payload

**Steps:** Roll any die. Send a text message and inspect the POST to `http://localhost:11434/api/chat` in the Network tab.
**PASS:** The request body `messages` array does not contain a raw `{ role: 'dice', ... }` object. Dice messages are converted to `{ role: 'user', content: '[Dice roll: dX → N]' }` by the mapping in `sendMessage` before `trimContext` is called. Only `user` and `assistant` roles appear as raw entries.
**FAIL:** A raw dice object appears verbatim in the network request body.

---

### SC-06 — Message list auto-scrolls to bottom on each new message

**Steps:** Send enough messages to require scrolling. Scroll up manually. Send another message.
**PASS:** After new player and DM bubbles are added, the list scrolls back to the bottom automatically via the `useEffect` on `messages` that calls `messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })`. The newest message is visible without manual scrolling.
**FAIL:** List stays at the previous scroll position after new messages are added.

---

### SC-07 — Textarea auto-resizes up to 140px then caps

**Steps:** Type one line. Add enough Shift+Enter newlines to fill more than two rows.
**PASS:** Textarea height grows with content up to a maximum of 140px (matching `Math.min(el.scrollHeight, 140)` in the resize `useEffect` in Chat.jsx). Beyond 140px an internal scrollbar appears rather than further expansion. Height resets to auto after sending.
**FAIL:** Textarea stays at a fixed height regardless of content, or grows beyond 140px without capping.

---

### SC-08 — Enter sends; Shift+Enter inserts a newline

**Steps:** (a) Type hello and press Enter. (b) Type line one, press Shift+Enter, type line two, then press Enter.
**PASS:** (a) "hello" sends as a player message. (b) A two-line message sends as a single player bubble with preserved newline rendered via `white-space: pre-wrap` on `.player-message .message-bubble`. Textarea clears in both cases.
**FAIL:** Enter inserts a newline instead of sending, or Shift+Enter sends the message prematurely.

---

### SC-09 — Textarea is disabled during streaming and focus is restored after

**Steps:** Send a message. Immediately try typing in the textarea during streaming.
**PASS:** The textarea has the `disabled` attribute during streaming (opacity drops to 0.45 per `.message-input:disabled` CSS). After streaming completes, the attribute is removed and `textareaRef.current?.focus()` in the `finally` block of `sendMessage` restores keyboard focus automatically.
**FAIL:** Textarea accepts keystrokes during streaming, or remains disabled after streaming ends.

---
## Section 8 — Regression: Dice Roller

### DR-01 — Dice Roller panel toggles via the dice header button

**Steps:** Click the dice header button once. Click it again.
**PASS:** First click: `.dice-panel` appears below the header with a `slideDown` entrance animation (opacity 0 to 1, translateY -6px to 0 per CSS keyframes). Button has `.active` class applied (background becomes `var(--surface-2)`). Second click: panel disappears and active class is removed.
**FAIL:** Panel does not appear, animation is absent, or button active state is not toggled.

---

### DR-02 — All 7 die types are present with correct labels and icons

**Steps:** Open the Dice Roller. Inspect all buttons in `.dice-grid`.
**PASS:** Exactly 7 buttons exist with labels d4, d6, d8, d10, d12, d20, d100, matching the DICE array in DiceRoller.jsx. Each button shows a geometric icon above the label via `.die-icon` (triangle ▲ for d4, hexagon ⬡ for d6, diamond ◆ for d8, ◈ for d10, ⬟ for d12, ⬡ for d20, % for d100).
**FAIL:** Fewer than 7 dice are shown, any label is misspelled, or icons are missing.

---

### DR-03 — Rolling a die inserts a dice result message into the chat

**Steps:** Open the Dice Roller. Click the d6 button.
**PASS:** A `.dice-result` message appears centred in the message list (not left- or right-aligned). It shows the die name, an arrow (→), and an integer result between 1 and 6 inclusive. The element uses `.dice-result` pill styling (Cinzel font, surface-2 background, rounded pill border, `align-self: center`).
**FAIL:** No message appears, the text format differs, or the result is outside the valid range for the die.

---

### DR-04 — d20 result of 20 receives the crit class and Critical Hit label

**Steps:** In DevTools console run `Math.random = () => 0.95` (produces `Math.floor(0.95 * 20) + 1 = 20`). Click d20.
**PASS:** The `.dice-result` element has class `crit`. Text shows "d20 → 20 — Critical Hit!" Border colour is #3a6a1a, background rgba(42,90,26,0.2), result number colour #a0e880 per CSS.
**FAIL:** No crit class applied, the Critical Hit label is absent, or the colours are wrong.

---

### DR-05 — d20 result of 1 receives the fumble class and Critical Fail label

**Steps:** In DevTools console run `Math.random = () => 0` (produces result 1). Click d20.
**PASS:** The `.dice-result` element has class `fumble`. Text shows "d20 → 1 — Critical Fail!" Border is var(--red) (#8b1a1a), background rgba(139,26,26,0.2), text colour #e08060 per CSS.
**FAIL:** No fumble class, the Critical Fail label is absent, or incorrect styling is applied.

---

### DR-06 — Dice result message has no Player or DM label

**Steps:** Roll any die and observe the resulting message element in the DOM.
**PASS:** The `.dice-result` element has no `.message-header` child and no "Player" or "Dungeon Master" text. It is centred in the flex column via `align-self: center` on the element.
**FAIL:** Dice message shows a Player or DM label, or is left- or right-aligned like a chat bubble.

---

### DR-07 — Rolling while streaming appends the dice message without disrupting the stream

**Steps:** Send a message to start streaming. While the DM bubble is still receiving tokens, click any die button.
**PASS:** A `.dice-result` row appears in the message list. DM streaming continues uninterrupted. `isLoading` does not reset. No console error is thrown.
**FAIL:** Dice roll during streaming causes an error, clears the streaming DM bubble, or is silently ignored.

---
## Section 9 — Regression: Session Controls

### SCC-01 — New session clears messages after confirmation when messages exist

**Steps:** Send at least one message. Click the trash-can header button.
**PASS:** `window.confirm` appears with "Start a new session? The current conversation will be cleared." Clicking OK triggers `setMessages([])`, `setEntities([])`, and `setSessionLog([])` per `handleNewSession` in Chat.jsx. The empty state re-appears with no message bubbles.
**FAIL:** Confirm dialog does not appear, messages remain after clicking OK, or the app errors.

---

### SCC-02 — New session with empty message list skips the confirm dialog

**Steps:** Complete setup so the chat view is shown but send no messages. Click the trash-can header button.
**PASS:** No `window.confirm` dialog appears (the `messages.length === 0` branch in `handleNewSession` bypasses it). The empty state remains visible with no error.
**FAIL:** Confirm dialog appears when the message list is already empty.

---

### SCC-03 — Settings gear removes dnd_setup_done and returns to setup screen

**Steps:** From chat view, click the gear icon header button.
**PASS:** `handleReset` fires: `localStorage.removeItem('dnd_setup_done')` is called (verify in [localStorage] — key gone). App re-renders the setup screen (CampaignSetup component). Campaign Name and model select pre-populate from the remaining `dnd_campaign_name` and `dnd_model` localStorage keys.
**FAIL:** Chat view remains, `dnd_setup_done` is still present, or setup fields are blank instead of pre-populated.

---

### SCC-04 — Clicking a starter prompt sends the full prompt text

**Steps:** Reach the empty state. Click the starter prompt "The party enters a dimly lit tavern. What do we see?"
**PASS:** A Player bubble appears with the exact prompt text. A DM streaming response begins. The empty-state container is no longer visible (messages.length > 0).
**FAIL:** Click has no effect, wrong text is sent, the empty state persists after sending, or streaming does not start.

---

### SCC-05 — All 5 header icon buttons are present with correct titles

**Steps:** Inspect the `.header-actions` div in DevTools Elements.
**PASS:** Exactly 5 `<button class="icon-btn">` elements exist with `title` attributes in DOM order: "Campaign History", "Dice Roller", "Character Sheet", "New Session", "Campaign Settings" — matching the Chat.jsx source.
**FAIL:** Any button is missing, title text differs from source, or buttons are in the wrong order.

---

### SCC-06 — History and Character button active states are mutually independent

**Steps:** Click the scroll icon to open history (it gains the active class). Then click the wizard icon to open the character panel (it also gains the active class).
**PASS:** Both buttons can be simultaneously active. The scroll icon retains `.active` class after the wizard icon is clicked. Both panels are open at the same time (3-column layout). Each panel closes independently by clicking its button again.
**FAIL:** Opening one panel closes the other, or clicking one button removes the active class from the other.

---


## Section 10 — Edge Cases

### EC-01 — Corrupt dnd_character JSON in localStorage falls back to defaults

**Steps:** In DevTools console run: localStorage.setItem('dnd_character', '{bad json}'). Hard-refresh the page. Complete setup. Open CharacterPanel.
**PASS:** No crash. The try/catch in loadCharacter() in App.jsx catches the JSON.parse error and returns DEFAULT_CHARACTER. CharacterPanel shows Name=Adventurer, Race=Human, Class=Fighter with all default stat values.
**FAIL:** App throws an unhandled error, page goes blank, or CharacterPanel shows NaN values.

---

### EC-02 — Missing dnd_campaign_name and dnd_model keys fall back gracefully

**Steps:** Set only dnd_setup_done = 1 in localStorage (remove dnd_campaign_name and dnd_model). Hard-refresh.
**PASS:** App renders the chat view. Header shows the fallback 'D&D Campaign' text (campaign.name || 'D&D Campaign' in Chat.jsx). campaign.model defaults to qwen2.5:14b via the || 'qwen2.5:14b' fallback in App.jsx. No console errors.
**FAIL:** App crashes, renders blank, or shows undefined/null in the header or model fields.

---

### EC-03 — Very long DM response renders without layout breakage

**Steps:** Send a prompt designed to elicit a very long response. Wait for completion.
**PASS:** The DM bubble expands vertically within the scrollable .messages-container. A scrollbar appears as needed. The input area stays anchored at the bottom. No horizontal overflow and the chat column does not collapse.
**FAIL:** Input area disappears below viewport, a horizontal scrollbar appears on the body, or the chat column collapses.

---

### EC-04 — Toggling both panels mid-stream does not interrupt streaming

**Steps:** Send a message. While streaming, click the scroll icon to open HistoryPanel, then the wizard icon to open CharacterPanel.
**PASS:** Streaming continues and tokens append to the DM bubble through both panel transitions. No console error appears. The response is complete when streaming finishes.
**FAIL:** Streaming halts or truncates during a panel toggle, or a console error fires.

---

### EC-05 — Both panels open simultaneously do not collapse the chat column

**Steps:** Open both HistoryPanel and CharacterPanel at the same time.
**PASS:** The .app-layout shows three visible columns. Chat column = viewport width minus 280px (history) minus 280px (character), per --panel-width: 280px in App.css. The chat column has min-width: 0 per CSS so it shrinks without hiding content. Messages, input, and header remain usable.
**FAIL:** Chat column collapses to zero width, content is hidden, or a horizontal scrollbar appears on the page body.

---

### EC-06 — Ability scores at boundary values produce correct modifiers

**Steps:** Open CharacterPanel. Set STR to 0 and note the displayed modifier. Set CHA to 30 and note the modifier.
**PASS:** STR=0 shows modifier -5 (Math.floor((0-10)/2) = -5). CHA=30 shows modifier +10 (Math.floor((30-10)/2) = +10). Both rendered correctly by the modifier() function in CharacterPanel.jsx. No NaN or crash.
**FAIL:** Incorrect modifier shown, NaN displayed, or app crashes.

---

### EC-07 — Empty character name and class store and display as empty strings

**Steps:** Click the character name, delete all text, press Enter. Click charClass, delete all text, press Enter.
**PASS:** Both fields display as empty strings. dnd_character in localStorage stores name: "" and charClass: "". No crash because the InlineEdit text-type path returns the raw draft without numeric coercion (type !== "number" branch in InlineEdit.onBlur).
**FAIL:** Crash occurs, fields revert to previous values, or localStorage stores null or a default string.

---

### EC-08 — Rapid double-send does not duplicate the message

**Steps:** Type a message. Double-click the send button or press Enter twice in rapid succession.
**PASS:** Only one Player bubble and one DM bubble appear. The !trimmed || isLoading guard in sendMessage prevents a second call once isLoading is true. Only one network request to Ollama is initiated.
**FAIL:** Two Player bubbles appear with the same text, or two concurrent Ollama requests are visible in the Network tab.

---

### EC-09 — Network drop mid-stream produces an error bubble

**Steps:** Start a long DM response. While streaming, use DevTools > Network to set throttling to Offline.
**PASS:** The in-progress DM bubble transitions to the error state: content contains the italicised silence phrase and the bold Error prefix. The error: true flag applies red border and background per .dm-message.error CSS. isLoading resets to false and the textarea re-enables.
**FAIL:** App hangs indefinitely with textarea disabled, or an unhandled Promise rejection fires with no user-visible error.

---

### EC-10 — Special characters and emoji in user input are displayed correctly

**Steps:** Type a message containing angle brackets, ampersands, emoji, and accented characters. Send it.
**PASS:** The Player bubble displays the exact typed text rendered via React text interpolation (not dangerouslySetInnerHTML), preventing injection. No characters are stripped or double-encoded. The Ollama request body contains the literal string.
**FAIL:** Characters are stripped or corrupted, or any unintended script execution occurs.

---

### EC-11 — XSS attempt in DM response is escaped by parseMarkdown

**Steps:** Mock the Ollama stream to return a string containing an img tag with an onerror attribute followed by bold markdown. Observe the DM bubble.
**PASS:** parseMarkdown in Chat.jsx escapes < to &lt; and > to &gt; in the escaped variable before any markdown replacement runs (the .replace(/&/g, ...) chain at the start of parseMarkdown). The rendered output shows the img syntax as visible escaped text and a bold element. No alert fires and no img DOM node is injected.
**FAIL:** An img element is created in the DOM, the onerror callback fires, or an alert appears.

---

### EC-12 — Page reload during active streaming recovers cleanly

**Steps:** Start streaming a DM response. Immediately hard-refresh (Ctrl+Shift+R).
**PASS:** Page reloads and, because dnd_setup_done is in localStorage, the chat view renders directly (not the setup screen). The aborted fetch is discarded by the browser. The message list starts empty since messages are not persisted to localStorage. No console errors appear on load.
**FAIL:** App shows an indefinite loading state, crashes, or displays partial content from the aborted stream.

---

### EC-13 — localStorage quota exhaustion is handled without crashing the app

**Steps:** Fill localStorage near its quota in DevTools console (e.g., localStorage.setItem('filler', new Array(5242880).join('x'))). Then edit any character field in CharacterPanel to trigger the localStorage.setItem('dnd_character', ...) call in CharacterPanel.update().
**PASS:** The setItem call throws a QuotaExceededError. The React setCharacter state update still succeeds so the UI reflects the edit in memory. No unhandled rejection crashes or blanks the app.
**FAIL:** App crashes, goes blank, or an unhandled error breaks the UI entirely.

---

### EC-14 — Switching model in settings uses the new model for the next request

**Steps:** Complete setup with qwen2.5:14b. Click the gear icon to return to setup. Change AI Model to qwen2.5:32b. Click Begin the Campaign. Send a message. Inspect the POST to Ollama in the Network tab.
**PASS:** The request body contains "model": "qwen2.5:32b". [localStorage] dnd_model = qwen2.5:32b. The campaign.model state reflects the new value passed through handleSetup in App.jsx.
**FAIL:** Network request still sends qwen2.5:14b, localStorage is not updated, or setup rejects the changed selection.

---

## Section 11 — Accessibility Basics

### ACC-01 — All 5 header icon buttons are keyboard reachable via Tab

**Steps:** Click a neutral area of the header. Press Tab repeatedly.
**PASS:** Each of the 5 .icon-btn buttons receives keyboard focus in left-to-right DOM order: Campaign History, Dice Roller, Character Sheet, New Session, Campaign Settings. A visible focus ring appears on each. No button is skipped.
**FAIL:** Any button is not reachable via Tab, or focus jumps over a button in sequence.

---

### ACC-02 — Focus remains predictable after panel toggle via keyboard

**Steps:** Tab to the Campaign History button and press Space to open the history panel. Press Tab again.
**PASS:** After the panel opens, Tab moves focus to the next focusable element in DOM order — the .history-panel-toggle tab button on the panel edge. Focus does not vanish or jump to an unrelated element.
**FAIL:** Focus disappears to body, jumps unexpectedly, or becomes trapped inside the panel without an escape path.

---

### ACC-03 — Focus returns to the textarea automatically after message send

**Steps:** Type a message. Press Enter to send. Wait for streaming to complete.
**PASS:** The textarea has keyboard focus without any user click after streaming ends, confirmed by textareaRef.current?.focus() in the finally block of sendMessage in Chat.jsx. Pressing a key immediately after streaming types into the textarea.
**FAIL:** Focus remains on the send button, goes to body, or requires a click to restore.

---

### ACC-04 — Inline-edit fields in CharacterPanel are activatable by click

**Steps:** Open CharacterPanel. Click the character name span. Then click the STR ability score value.
**PASS:** Each clicked .char-inline-value span transitions to a .char-inline-input with autoFocus set (per InlineEdit in CharacterPanel.jsx), making it immediately editable. The input captures Enter and Escape key events without further action.
**FAIL:** Clicking an inline value has no effect, or the input appears without receiving focus.

---

### ACC-05 — Enter commits and Escape cancels inline edits

**Steps:** Click the character name to enter edit mode. Type New Name. Press Enter. Click the name again, type Wrong, press Escape.
**PASS:** Enter calls e.target.blur() triggering onBlur, which commits the value to state and localStorage. Escape resets draft to the original value and closes the input without saving. Both key handlers are in the onKeyDown callback in InlineEdit.
**FAIL:** Enter or Escape have no effect, or Escape commits the wrong value.

---

### ACC-06 — Primary gold-on-dark text meets WCAG AA contrast ratio

**Steps:** In DevTools > Accessibility pane inspect the campaign name (.campaign-name, colour #e8c87a on background #1a1208) and DM message body text (.message-content, colour #e8d5a3 on #1a1208).
**PASS:** DevTools reports contrast ratio at or above 4.5:1 for both elements (WCAG AA for normal text). Gold-bright (#e8c87a) on surface-1 (#1a1208) is approximately 9.5:1; text-primary (#e8d5a3) on surface-1 is approximately 10.8:1.
**FAIL:** Either element shows a ratio below 4.5:1 in the DevTools accessibility inspector.

---

### ACC-07 — All icon buttons have descriptive title attributes

**Steps:** Inspect each .icon-btn element in DevTools Elements panel and check the title attribute value.
**PASS:** All 5 buttons have non-empty, descriptive title values matching Chat.jsx: Campaign History, Dice Roller, Character Sheet, New Session, Campaign Settings. These serve as tooltip text and the accessible name for screen readers.
**FAIL:** Any title is missing, empty, or set to a generic placeholder.

---

### ACC-08 — No keyboard trap exists inside either side panel

**Steps:** Open CharacterPanel. Tab through all focusable elements inside it. Continue pressing Tab.
**PASS:** After the last focusable element inside the panel, Tab moves focus out to the next focusable element in the page (the textarea or send button in the chat column). Focus is never trapped inside the panel.
**FAIL:** Tab cycles indefinitely within the panel with no way to exit without pressing Escape or clicking outside.

---

