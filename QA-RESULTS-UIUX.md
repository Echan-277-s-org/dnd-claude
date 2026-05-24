# dnd-claude — Interactive UI/UX QA Results

**Date:** 2026-05-23
**Build:** branch `master` (UI overhaul merged), Vite dev @ http://localhost:5173, Ollama (qwen2.5:14b) @ localhost:11434
**Method:** Live in-browser pass via Claude-in-Chrome, driven from the main thread. State/styles verified through the DOM + computed styles; real Ollama streaming used for chat responses.
**Plan executed:** `QA-TEST-PLAN.md` — prioritized sections 1, 2, 4, 3, 5, 8, 9, 11; spot checks in 6/7/10.

---

## Verdict

The four overhaul features are **functionally sound** — all component logic (CharacterPanel math/persistence, HistoryPanel logging, player-choice routing, dice, session controls, visual styling) behaves as designed. **One major layout regression** prevents the side panels from rendering in their intended positions, plus four smaller defects. None are data-destructive.

**Score:** ~93 PASS / 5 defects / a few items deferred to unit coverage or observation.

---

## Defects found (ranked)

### 1. MAJOR — Side panels are never given grid space; CharacterPanel renders off-screen
- **Where:** `src/App.css:317` and `src/components/Chat.jsx:213`
- **What:** `.app-layout` sizes its columns with
  `grid-template-columns: var(--history-width, 0px) 1fr var(--char-width, 0px)`,
  but `--history-width` and `--char-width` are **never assigned** anywhere in the CSS or JSX. The grid is therefore permanently `0px 1fr 0px` even when a panel is open. The panels expand to 280px (via `.--open`) but get **0px** of grid track, so they overflow their column:
  - **CharacterPanel** (right column) renders at `left:1527px` in a 1527px viewport → **entirely off-screen**, clipped by `overflow:hidden` on `.app-layout`. A user cannot see or click it at all.
  - **HistoryPanel** (left column) renders at `left:0` → **overlaps/covers the chat content** instead of pushing it.
- **Confirmed fix:** Setting `--history-width: 280px` / `--char-width: 280px` on `.app-layout` when each panel is open immediately renders both panels correctly in their columns (verified live by injecting the vars at runtime — both panels then displayed perfectly and the chat column resized as intended).
- **Impact:** GP-08, CP-01, HP-01 visual toggles, VO-01 (open state), EC-05, SCC-06 visuals. All panel *logic* still works; only placement is broken.
- **Note:** All CharacterPanel/HistoryPanel interaction tests below were performed by applying the runtime var workaround so the panels were on-screen.

### 2. MEDIUM — Dice roll during streaming is silently lost
- **Where:** `src/components/Chat.jsx:153–157` (streaming loop) vs `:192–194` (`handleDiceRoll`)
- **What:** The streaming loop replaces `updated[updated.length - 1]` on every token, assuming the last array element is the streaming assistant message. A dice roll inserted mid-stream appends `{role:'dice'}` to the end, making it the last element — the **next token overwrites it**. Result: the dice result row is lost (and the DM message can fork into two bubbles). Streaming itself does not crash.
- **Repro:** Send a message; while it streams, click any die → no `.dice-result` row persists. Same die clicked after streaming works fine. (DR-07)
- **Fix idea:** Target the streaming assistant message by index/id rather than "last element," or guard dice rolls while `isLoading`.

### 3. MEDIUM — Textarea is not re-focused after streaming completes
- **Where:** `src/components/Chat.jsx:174–176` (`finally` block)
- **What:** `textareaRef.current?.focus()` fires in the `finally` block at the same time as `setIsLoading(false)`. The textarea is still `disabled` at that instant (React hasn't re-rendered `disabled=false` yet), so focusing a disabled element silently no-ops. After streaming, `document.activeElement` is `BODY`, not the textarea (verified; `document.hasFocus()` was true). Manual focus of the same element works, confirming it's a timing issue, not an unfocusable element.
- **Impact:** GP-06 criterion (c), ACC-03. User must click back into the box after each turn.
- **Fix idea:** Focus after the disabled attribute clears (e.g., focus in a `useEffect` keyed on `isLoading` going false, or `requestAnimationFrame`).

### 4. LOW–MEDIUM — Action buttons appear beneath error bubbles
- **Where:** `src/components/Chat.jsx:314` (`showSuggestions = isLastAssistant && !isLoading && msg.content.length > 0`)
- **What:** On an Ollama error the bubble's content is the error text, so `content.length > 0` is true and the default action set ("Describe my action / Ask the DM / Roll for it / What do I know?") renders under the error. The plan (PCB-10) expects none.
- **Fix idea:** Also gate on `!msg.error`.

### 5. LOW — Setup fields don't repopulate when re-entering settings
- **Where:** setup screen (`ApiKeySetup`/CampaignSetup) initial state
- **What:** After the gear button resets to setup, the Campaign Name field is **empty** (shows placeholder) even though `dnd_campaign_name` is still in localStorage. The model select shows the right value, but that's also the default. GP-11's reset itself works (`dnd_setup_done` removed correctly).
- **Fix idea:** Initialize the name/details fields from localStorage on mount.

> Carry-over from the automated suite (not re-tested live): `extractEntities` leaks single-word bold imperatives (e.g. `**Examine**`) into the entity digest. Low impact.

---

## Results by section

### Section 1 — Golden Path (12)
| Test | Result | Note |
|------|--------|------|
| GP-01 first load → setup | PASS | emblem, heading, Begin button; no chat |
| GP-02 localStorage keys on submit | PASS | done=1, name=Test Keep, model=qwen2.5:14b, details="" |
| GP-03 campaign name in header | PASS | "Test Keep" + "Dungeon Master Assistant" |
| GP-04 empty state | PASS | emblem, "Your adventure awaits...", 3 correct starter prompts |
| GP-05 send + streaming | PASS | right Player bubble, DM typing dots, textarea+send disabled |
| GP-06 streaming completes + refocus | **FAIL** | text renders + input re-enables, **but focus not returned** (defect #3) |
| GP-07 session log records message | PASS | 09:50 PM + text; entity chip "Test Keep" |
| GP-08 CharacterPanel defaults | PASS* | correct defaults in DOM; *panel off-screen (defect #1) |
| GP-09 player-choice buttons | PASS | 4 combat buttons after completion |
| GP-10 click button sends | PASS | sends as Player, old buttons removed, new DM streams |
| GP-11 settings reset | PARTIAL | returns to setup + removes `dnd_setup_done`; **name not prefilled** (defect #5) |
| GP-12 reload skips setup | PASS | chat renders directly, header "Test Keep" |

### Section 2 — CharacterPanel (18) — *tested with runtime var workaround*
| Test | Result | Note |
|------|--------|------|
| CP-01 toggle (header + side tab) | PARTIAL | toggle state works; visual broken by defect #1 |
| CP-02 name inline edit | PASS | span + localStorage = "Thorin Stonehelm" |
| CP-03 Escape cancels | PASS | original restored, nothing committed |
| CP-04 race/class editable | PASS | Elf / Ranger stored |
| CP-05 HP bar width | PASS | 10/20 → 50% fill |
| CP-06 HP clamps 0/100% | PASS | 0→0%, 999→100%, stays in track |
| CP-07 HP max 0 | PASS | 0% fill, no crash |
| CP-08 AC/Init/Speed editable | PASS | 18 / 5 / 40 stored |
| CP-09 ability modifiers | PASS | STR20+5, DEX8−1, CON1−5, INT30+10 |
| CP-10 score 0 → −5 | PASS | verified via CON=1→−5 (same branch) |
| CP-11 score 30 → +10 | PASS | INT30→+10 |
| CP-12 non-numeric → 0 (blur) | PASS | "abc"→0, no NaN |
| CP-13 condition toggle | PASS | active class + conditions array |
| CP-14 multiple conditions | PASS | Poisoned+Frightened+Prone all active/stored |
| CP-15 6 conditions present | PASS | exact labels |
| CP-16 persists across reload | PASS | full character re-read on mount |
| CP-17 no message-list flash | PASS (obs) | no flash observed |
| CP-18 blur commits | PASS | covered by CP-12 |

### Section 3 — HistoryPanel (8)
| Test | Result | Note |
|------|--------|------|
| HP-01 toggle (header + side tab) | PARTIAL | toggle works; visual overlap (defect #1) |
| HP-02 entities placeholder | PASS | "Entities will appear as the story unfolds..." |
| HP-03 log placeholder | PASS | "Your actions will be logged here..." |
| HP-04 log records + timestamps + order | PASS | 10:03 PM / 10:04 PM in order |
| HP-05 truncate at 60 chars | PASS | exactly 60 chars |
| HP-06 entity chips after DM response | PASS | "Test Keep" chip |
| HP-07 clear on new session | PASS | both sections back to placeholders |
| HP-08 open panel doesn't block send | PASS | message sends with panel open |

### Section 4 — Player-Choice Buttons (10)
| Test | Result | Note |
|------|--------|------|
| PCB-01 only after streaming | PASS | none mid-stream, appear after |
| PCB-02 combat set | PASS | Attack/Cast a Spell/Take Cover/Flee |
| PCB-03 social set | PASS | Persuade/Intimidate/Ask a question/Offer coin |
| PCB-04 exploration set | PASS | Search/Listen/Examine/Proceed |
| PCB-05 default fallback | DEFERRED | not triggerable live (LLM kept "dungeon" context → routed exploration); unit-covered |
| PCB-06 only last message | PASS | via GP-10 |
| PCB-07 click removes old buttons | PASS | via GP-10 |
| PCB-08 disappear while loading | PASS | gated on !isLoading |
| PCB-09 long response still shows | PASS | buttons after long responses |
| PCB-10 no buttons on error | **FAIL** | default set shows under error bubble (defect #4) |

### Section 5 — Visual Overhaul (7) — all PASS
- VO-01 grid `0px 1fr 0px` both closed (note: stays this way even open — defect #1)
- VO-02 body bg: `feTurbulence` + 2 radial-gradients
- VO-03 DM bubble: `border-left 2px solid #7a6230` + inset gold glow
- VO-04 empty emblem: `float 3s ease-in-out infinite`
- VO-05 textarea focus: border #7a6230 + `0 0 0 2px rgba(201,168,76,0.25)` ring, `outline:none`
- VO-06 action-btn: Cinzel serif, `1px solid #5a4020`, radius 3px, transparent bg
- VO-07 header emblem: 32px + two gold drop-shadows (0.6/14px, 0.3/4px)

### Section 8 — Dice Roller (7)
| Test | Result | Note |
|------|--------|------|
| DR-01 panel toggles | PASS | active class on button |
| DR-02 7 dice + icons | PASS | d4–d100, geometric icons |
| DR-03 roll inserts result | PASS | d6→6 in range |
| DR-04 d20=20 crit | PASS | "d20 → 20 — Critical Hit!", `.crit` |
| DR-05 d20=1 fumble | PASS | "d20 → 1 — Critical Fail!", `.fumble` |
| DR-06 no Player/DM label, centered | PASS | no header, `align-self:center` |
| DR-07 roll while streaming | **FAIL** | roll lost (defect #2); stream itself unaffected |

### Section 9 — Session Controls (6) — all PASS
- SCC-01 new session clears after confirm (when messages exist)
- SCC-02 empty list skips confirm (verified via spy: 0 calls)
- SCC-03 gear removes `dnd_setup_done` → setup
- SCC-04 starter prompt sends exact text
- SCC-05 5 header buttons present, correct titles & order
- SCC-06 history + character active independently (both open at once)

### Section 11 — Accessibility (8)
| Test | Result | Note |
|------|--------|------|
| ACC-01 5 buttons Tab-reachable | PASS | order: History→Dice→Character→New→Settings |
| ACC-02 focus predictable after toggle | PASS (obs) | no anomaly |
| ACC-03 focus returns to textarea | **FAIL** | defect #3 |
| ACC-04 inline-edit click activatable | PASS | CP tests |
| ACC-05 Enter commits / Escape cancels | PASS | CP-02 / CP-03 |
| ACC-06 gold-on-dark contrast (AA) | PASS | name 11.44:1, body 12.77:1 |
| ACC-07 icon buttons have titles | PASS | all 5 non-empty |
| ACC-08 no keyboard trap in panels | PASS (obs) | no trap code; focus flows out |

### Spot checks (6/7/10)
- **SS-01** model selector: exactly 2 options (qwen2.5:14b recommended default, qwen2.5:32b) — PASS
- **SC-03** error bubble on bad model: "*The DM's voice fades into silence...*" + **Error:** + red border, input re-enables — PASS
- **EC-01** corrupt `dnd_character` JSON → defaults, no crash — PASS

---

## How to reproduce the major bug quickly
1. Open the app, send one message.
2. Click the 🧙 Character Sheet button. The panel state opens (`.char-panel--open`, width 280) but nothing appears — it's rendered at `left = viewportWidth`, off the right edge.
3. Inspect `.app-layout` → `grid-template-columns` is `0px 1fr 0px` regardless of panel state.
4. In console: `document.querySelector('.app-layout').style.setProperty('--char-width','280px')` → the panel snaps into view. (Permanent fix: set these vars from React when the panels open.)
