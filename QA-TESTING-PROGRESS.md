# dnd-claude QA / Testing — Progress & Continuation

**Last updated:** 2026-05-23
**Purpose:** Hand-off doc to resume the testing effort for the dnd-claude UI overhaul.

---

## What this effort is

After a major UI overhaul of the D&D Campaign Assistant (`H:\Claude\dnd-claude\`), we are validating it
three ways: a written QA plan (qa-expert), an automated suite (test-automator), and an interactive
in-browser pass (ui-ux-tester / Claude-in-Chrome). The first two are **done**; the interactive pass is
**not started** (see Blocker below).

## The UI overhaul being tested (4 features)

1. **CharacterPanel** (right sidebar, `src/components/CharacterPanel.jsx`) — collapsible; inline-editable
   name/race/class, HP bar, AC/Init/Speed badges, 6 ability scores w/ auto modifiers, condition chips;
   persisted to localStorage key `dnd_character`. Toggled by 🧙 header button.
2. **HistoryPanel** (left sidebar, `src/components/HistoryPanel.jsx`) — collapsible; entity pills (from
   `extractEntities`) + timestamped session log. Toggled by 📜 header button.
3. **Player-choice buttons** — 3–4 contextual action buttons under the last DM message; keyword-routed
   (combat / social / exploration / default); hidden while streaming.
4. **Visual overhaul** — 3-column CSS grid, body noise texture, illuminated-manuscript DM bubbles,
   floating empty-state emblem, glowing input focus ring, physical-dice buttons, larger header emblem.

Built on branch `ui-overhaul` in worktree `H:\Claude\dnd-claude-ui`, **merged to `master`**. The worktree
still exists and can be removed when done: `git worktree remove ..\dnd-claude-ui`.

## Environment (both must be running for the interactive pass)

- Vite dev server: **http://localhost:5173** (`npm run dev` from `H:\Claude\dnd-claude\`)
- Ollama: **http://localhost:11434** (real streaming DM responses work when up)

---

## Status by track

### 1. QA plan — DONE
- File: `H:\Claude\dnd-claude\QA-TEST-PLAN.md`
- **107 tests across 11 sections**, each with Steps / PASS / FAIL tied to actual code:
  1 Golden Path (12), 2 CharacterPanel (18), 3 HistoryPanel (8), 4 Player-Choice (10),
  5 Visual Overhaul (7), 6 Setup regression (8), 7 Streaming/Chat regression (9),
  8 Dice Roller (7), 9 Session Controls (6), 10 Edge Cases (14), 11 Accessibility (8).

### 2. Automated suite — DONE, all green
- Run with: `npm test` (or `npx vitest run`) from `H:\Claude\dnd-claude\`
- Stack added: Vitest + @testing-library/react + jest-dom + jsdom (config in `vite.config.js`,
  setup in `src/test-setup.js`).
- **5 files, 108 tests passing (~1.7s):**
  - `src/lib/context.test.js` (28) — extractEntities, trimContext, buildSystemPrompt, parseMarkdown (incl. XSS escaping)
  - `src/components/Chat.test.jsx` (21) — player-choice keyword routing
  - `src/components/CharacterPanel.test.jsx` (38) — modifier math, HP-bar clamping, inline edit, conditions, localStorage
  - `src/components/HistoryPanel.test.jsx` (15)
  - `src/App.test.jsx` (11) — setup/chat routing, corrupt + missing localStorage
- **Behavior finding (real, not a test bug):** `extractEntities` does NOT filter single-word bold
  imperatives like `**Examine**` — the imperative guard requires ≥2 words, so a lone bold verb leaks
  into the entity digest. Low impact (model rarely bolds bare verbs). Worth fixing in `src/lib/context.js`.

### 3. Interactive Chrome pass — DONE (2026-05-23)
- Report: `H:\Claude\dnd-claude\QA-RESULTS-UIUX.md` (created).
- Ran sections 1, 2, 4, 3, 5, 8, 9, 11 live in-browser from the main thread; spot checks in 6/7/10.
- Result: ~93 PASS / 5 defects. Headline: **MAJOR layout bug** — `--history-width`/`--char-width` are
  referenced in `App.css:317` but never assigned, so CharacterPanel renders off-screen and HistoryPanel
  overlaps chat (fix confirmed: set those vars on panel open). Other defects: dice roll lost mid-stream
  (Chat.jsx:153-157 clobbers last msg), textarea not refocused after stream (Chat.jsx:176 focuses while
  still disabled), action buttons show under error bubbles (Chat.jsx:314), setup name not prefilled on
  gear reset. See report for full per-test table.

---

## BLOCKER discovered — how to run the interactive pass

**The `ui-ux-tester` subagent cannot do it.** The Claude-in-Chrome integration *requires* a user-driven
browser-selection handshake before any browser action, and subagents have no ask-user tool — so the agent
hung at 0 bytes of output and fell back to static source analysis. **Drive the browser from the main
thread instead** (the main agent has AskUserQuestion for the handshake).

### Browser handshake (already done this session, may need redo next session)
- Connected browser: **"Browser 1"**, deviceId `7cba959e-e196-47cf-acda-8787d9f57d03` (local, Windows).
- Confirm with the user via AskUserQuestion (chrome-mcp protocol requires it), then `select_browser`.
- App tab already open: **tabId `1245403261`** at http://localhost:5173 (re-fetch with `tabs_context_mcp`
  — tab IDs change between sessions; never reuse a stale ID).

### Exact next step (was about to run, interrupted)
GP-01 — clean first load. In one `browser_batch`:
1. `javascript_tool`: `localStorage.clear()`
2. `navigate` to http://localhost:5173
3. `wait` 2s
4. `screenshot`
Then verify the setup card renders (sword emblem, "D&D Campaign Assistant" heading, "Begin the Campaign"
button; no chat layout). Proceed through GP-02..GP-12, then sections 2, 4, 3, 5, 8, 9, 11.

### Gotchas for the browser pass
- **Native dialogs hang the session.** The 🗑 New Session button calls `window.confirm()` when messages
  exist. Avoid triggering it, or pre-handle via the javascript tool. Same caution for any confirm/alert.
- Real DM responses stream from Ollama and take several seconds — wait until typing dots AND blinking
  cursor are gone before checking post-response state.
- Read localStorage assertions via the javascript tool (`localStorage.getItem('dnd_character')`), not DevTools.
- Prefer `browser_batch` to chain click/type/navigate/screenshot in one round trip.

---

## Constraints / things NOT to touch

- **Protected logic** (owned by separate, in-progress "LLM updating" work): `buildSystemPrompt`,
  `extractEntities`, `trimContext`, and `sendMessage`'s fetch/stream block. These live in
  **`src/lib/context.js`** (and Chat.jsx wiring). `context.js` currently has **uncommitted LLM-work
  changes** (expanded D&D mechanics blocklist in `looksLikeEntity`) — leave it alone; tests pass against it.
- Test files only added test infra + `package.json`/`vite.config.js`; `Chat.jsx` was NOT modified by the
  test work.

## Housekeeping done
- Deleted 3 stray throwaway scripts the qa-expert created at repo root: `s3.js`, `write-plan.js`,
  `append-section.js`.

## Git state
- Repo: `H:\Claude\dnd-claude\` on branch `master` (git initialized this session).
- Uncommitted/untracked: test files + `src/test-setup.js`, `vite.config.js`, `package.json`,
  `package-lock.json`, `QA-TEST-PLAN.md`, this file, `src/lib/context.js` (LLM work), stress-test files,
  `OPTIMIZATION-PROGRESS.md`. Nothing has been committed since the merge — decide what to stage when ready.

## TL;DR — to resume
1. Ensure `npm run dev` (5173) and Ollama (11434) are up.
2. `tabs_context_mcp` → get fresh tab ID; AskUserQuestion to confirm "Browser 1" → `select_browser`.
3. Run GP-01 (clear localStorage, reload, screenshot) and walk QA-TEST-PLAN.md.
4. Write findings to `QA-RESULTS-UIUX.md`.
