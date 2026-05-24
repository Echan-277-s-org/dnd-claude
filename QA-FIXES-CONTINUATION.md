# dnd-claude — QA Fixes Continuation

**Created:** 2026-05-23
**Purpose:** Resume doc for fixing the defects found in the interactive UI/UX QA pass.
**Source of findings:** `QA-RESULTS-UIUX.md` (full per-test tables). Test plan: `QA-TEST-PLAN.md`.

---

## Where things stand

**STATUS: ALL 5 DEFECTS RESOLVED & VERIFIED (2026-05-23).** Fixes applied to `Chat.jsx` and
`ApiKeySetup.jsx`; `npm test` green (108/108); each defect re-verified interactively in Chrome against a
live Ollama (`qwen2.5:14b`). The protected `sendMessage` fetch/stream-parse block and `context.js` were
left untouched — only state-update mechanics (#2), focus timing (#3), the layout grid vars (#1), the
error-bubble guard (#4), and setup-field initializers (#5) changed.

The interactive Chrome QA pass was **complete** (~93 PASS / 5 defects). All four overhaul features
(CharacterPanel, HistoryPanel, player-choice buttons, visual overhaul) are functionally correct; the
defects were layout placement + a few interaction edges.

Protected logic (owned by separate "LLM updating" work) — **do not touch** unless the fix requires it:
`buildSystemPrompt`, `extractEntities`, `trimContext`, and `sendMessage`'s fetch/stream block in
`src/lib/context.js` and Chat.jsx wiring. Note: defects #2 and #3 below live *inside* `sendMessage` —
coordinate before editing that function.

## To restart the environment
1. `npm run dev` in `H:\Claude\dnd-claude\` → http://localhost:5173
2. Ollama up → http://localhost:11434 (model `qwen2.5:14b`)
3. For browser re-verification: `tabs_context_mcp` (fresh tab id each session) → AskUserQuestion to
   confirm the browser → drive from the main thread (subagents can't do the browser handshake).
4. Coordinate gotcha: viewport is wider than the screenshot (e.g. 1527 vs 1279). Compute click coords
   from `getBoundingClientRect()` × `(1279 / window.innerWidth)`. Native `confirm()`/`alert()` hang the
   session — override `window.confirm` before clicking the 🗑 New Session button.

---

## Defects to fix (ranked)

### 1. ✅ RESOLVED — MAJOR — Side-panel grid columns never sized (CharacterPanel off-screen, HistoryPanel overlaps)
> **Fixed** at `Chat.jsx:209` — inline `style` sets `--history-width`/`--char-width` from `showHistory`/`showCharacter`. Verified: both panels open → grid `280px 967px 280px`, panels in-column, chat shrinks (no overlap/off-screen).
- **Files:** `src/App.css:317`, `src/components/Chat.jsx:213`
- **Cause:** `grid-template-columns: var(--history-width, 0px) 1fr var(--char-width, 0px)` but the two
  vars are never assigned → grid stays `0px 1fr 0px`. Open panels (280px via `.--open`) overflow:
  CharacterPanel goes fully off the right edge (clipped by `overflow:hidden`); HistoryPanel overlaps chat.
- **Fix:** Set the vars from React when each panel opens. On `.app-layout` (Chat.jsx:213) add an inline
  style driven by `showHistory` / `showCharacter` (or whatever the state flags are), e.g.
  `style={{ '--history-width': showHistory ? 'var(--panel-width)' : '0px', '--char-width': showCharacter ? 'var(--panel-width)' : '0px' }}`.
  (The existing `transition: grid-template-columns 0.3s` then animates the open/close.)
- **Confirmed:** Injecting `--char-width:280px` / `--history-width:280px` at runtime made both panels
  render correctly in-column — this is the right fix.
- **Re-verify after fix:** GP-08, CP-01, HP-01 (toggle + side-tab arrow direction), VO-01 open state,
  EC-05 (both open, chat column shrinks not collapses), SCC-06.

### 2. ✅ RESOLVED — MEDIUM — Dice roll during streaming is lost
> **Fixed** in `Chat.jsx` `sendMessage` — placeholder assistant msg gets `id: crypto.randomUUID()`; stream loop and catch update by id (`prev.map`) instead of last-index overwrite. Verified: rolled d20 mid-stream → result persists after completion, DM bubble single & fully populated. Fetch/stream-parse logic untouched.
- **File:** `src/components/Chat.jsx:153–157` (stream loop) vs `:192–194` (`handleDiceRoll`)
- **Cause:** Stream loop does `updated[updated.length-1] = { role:'assistant', content:fullText }` every
  token, assuming the last element is the streaming assistant msg. A dice msg appended mid-stream becomes
  last and is overwritten by the next token (can also fork the DM bubble).
- **Fix idea:** Capture the streaming assistant message's index when streaming starts and update *that*
  index, or give it an id and find-by-id; alternatively guard `handleDiceRoll` while `isLoading`.
- **Re-verify:** DR-07.

### 3. ✅ RESOLVED — MEDIUM — Textarea not refocused after streaming
> **Fixed** in `Chat.jsx` — focus moved out of the `finally` block into `useEffect(() => { if (!isLoading) textareaRef.current?.focus() }, [isLoading])` (fires after the disabled attr clears on re-render). Verified: after stream, `document.activeElement` = `.message-input`.
- **File:** `src/components/Chat.jsx:174–176` (`finally` block)
- **Cause:** `textareaRef.current?.focus()` runs alongside `setIsLoading(false)`, while the textarea is
  still `disabled` (React hasn't re-rendered) → focus no-ops, `activeElement` falls to `BODY`.
- **Fix idea:** Focus after the disabled attr clears — `useEffect(() => { if (!isLoading) textareaRef.current?.focus() }, [isLoading])`, or `requestAnimationFrame`.
- **Re-verify:** GP-06(c), ACC-03.

### 4. ✅ RESOLVED — LOW–MED — Action buttons render under error bubbles
> **Fixed** at `Chat.jsx:316` — appended `&& !msg.error` to `showSuggestions`. Verified: forced Ollama 404 → error bubble renders with zero action-suggestions under it.
- **File:** `src/components/Chat.jsx:314`
- **Cause:** `showSuggestions = isLastAssistant && !isLoading && msg.content.length > 0` — error text is
  content, so the default action set shows under an error bubble.
- **Fix:** add `&& !msg.error`.
- **Re-verify:** PCB-10.

### 5. ✅ RESOLVED — LOW — Setup fields don't prefill on gear-reset
> **Fixed** at `ApiKeySetup.jsx:9-12` — `name`/`details`/`model`/`context` now use lazy `useState` initializers reading from localStorage. Verified: gear-reset → all fields prefill from stored campaign values.
- **File:** setup component (`ApiKeySetup.jsx` / CampaignSetup) initial state
- **Cause:** Campaign Name (and details) initialize empty instead of from localStorage; after gear reset
  the name field is blank though `dnd_campaign_name` persists.
- **Fix:** init those fields from `localStorage` on mount.
- **Re-verify:** GP-11.

> Carry-over from automated suite (separate, low impact): `extractEntities` leaks single-word bold
> imperatives (e.g. `**Examine**`) — lives in protected `src/lib/context.js`, leave unless coordinated.

---

## Suggested order
#4 and #5 are trivial one-liners. #1 is the highest-value fix and well understood. #3 is small. #2 needs
the most thought (touches the protected `sendMessage` stream block — coordinate with the LLM-work owner).

## Verification after fixes
- `npm test` (108 unit tests) must stay green.
- Re-run the affected interactive tests listed under each defect (browser, from main thread).
- Suggested smoke: open both panels (should sit in columns, chat shrinks), send a message (focus returns
  to textarea), roll a die mid-stream (result persists), trigger an Ollama error (no action buttons),
  gear-reset (name prefilled).
