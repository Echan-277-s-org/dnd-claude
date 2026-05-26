# Party HUD Implementation Plan

> Status: REVISED 2026-05-24 — LLM-owned party model (supersedes manually-managed shim).
> Source of truth for visual targets: `design-handoff/README.md`.
> This document covers features 1–3 deferred in `THEMING-WORKTREE-PLAN.md:58–70`.

---

## 1. Recommended Data Model

### Decision: LLM-Owned Party State

**The `party` array is owned and emitted by the AI DM (Ollama/qwen2.5), not the user.
The app renders the party; it does not provide manual add/remove/edit UI for party members.**

#### Rationale

The user's role is to play their character(s) and interact with the story. The DM — the
LLM — knows who is in the scene, who is wounded, and whose turn it is. This matches how
D&D actually works: the DM narrates party state; the player reacts. Giving the user a
manual party editor creates a competing source of truth and redundant work. Instead:

- `CharacterPanel` / `dnd_character` remains the **human player's editable sheet** for
  their primary character's full stat block (name, class, HP, stats, notes). This is not
  being removed or replaced — it is the player's reference and input surface.
- The `party` array is a **separate, LLM-driven display model** — a summary view of all
  characters currently in the scene, including the human player's character. The LLM
  populates it; the app renders it read-only. These two models do not merge: `CharacterPanel`
  is richer and user-editable; `party` is a compact DM-managed snapshot.

This resolves all three features without a party editor:
- Party strip renders `party[]` as emitted by the DM.
- Turn-pill and active-cell dot reflect whichever member the DM marks `isActive: true`.
- Dice chip flow is addressed separately (see Feature 3).

#### State Shape

`party` state lives in `App.jsx`, initialized from migration (below), then updated
exclusively by parsing the LLM's structured output:

```js
// Stored under localStorage key `dnd_party` (JSON) for fallback across page reloads.
// This is a DISPLAY CACHE only — the LLM is the authoritative source during a session.
const DEFAULT_PARTY = [
  {
    id: 'seed-0',           // stable key; LLM members get crypto.randomUUID() on first parse
    name: 'Adventurer',     // mirrors DEFAULT_CHARACTER.name at boot
    role: 'Fighter',        // mirrors DEFAULT_CHARACTER.charClass at boot
    hpPct: 100,             // 0–100 integer
    isActive: true,         // exactly one member true at a time
  },
]
```

Full per-member shape:

```ts
type PartyMember = {
  id: string           // UUID; assigned by the parser on first appearance, stable thereafter
  name: string         // display name as the LLM emits it
  role: string         // class/role label (e.g. "Ranger", "Jedi")
  hpPct: number        // 0–100 integer
  isActive: boolean    // true = this member's turn / currently spotlit
}

type AppState = {
  party: PartyMember[]          // new; LLM-driven
  // existing (unchanged):
  campaign, character, ready, draftGenre
}
```

#### localStorage Keys

| Key | Content | Existing? |
|-----|---------|-----------|
| `dnd_party` | `JSON.stringify(party[])` — display cache | NEW |
| `dnd_character` | full character sheet object | existing, unchanged |

The `dnd_party` localStorage key is a **display cache** for rendering across page reloads.
On session start it seeds the strip so it is not blank before the first LLM turn. During
a session, every successful party-block parse overwrites the cache.

#### Migration from `dnd_character` (First-Boot Seed)

`loadParty()` in `App.jsx` produces the initial `party` before the LLM has spoken:

```
1. Read `dnd_party` from localStorage. If present and parseable, return it.
2. Else, read `dnd_character`. If present:
     Derive a single-member party from it:
       name:    stored.name || DEFAULT_CHARACTER.name
       role:    stored.charClass || DEFAULT_CHARACTER.charClass
       hpPct:   stored.hpMax > 0
                  ? Math.round((stored.hpCurrent / stored.hpMax) * 100)
                  : 100
       isActive: true
       id:      'seed-0'
     Return [derivedMember].
3. Else, return DEFAULT_PARTY.
```

Zero-data-loss: `dnd_character` is never deleted. After the first LLM response that
includes a party block, the LLM's data replaces the seed. If the LLM omits the block
on a given turn, the last-known party persists (graceful fallback — see parsing rules).

#### Who Controls `isActive` and Turn Order

The LLM's emitted `isActive` field is the sole source. The header turn-pill and the
active cell's `· turn` caption both reflect whichever member the DM marks active. The
app does not provide a manual click-to-set-active affordance for party members.

---

## 2. LLM Structured-Block Emission — Unified Parsing Mechanism

The DM emits **all structured data** as fenced code blocks with custom language tags,
placed at the end of each response. Three tags are in play:

| Tag | Payload | When emitted |
|-----|---------|--------------|
| `party` | JSON array of `PartyMember` | Every response |
| `check` | JSON object `{skill, dc}` | When the DM requests a skill check |
| `verdict` | JSON object `{skill, dc, roll, result}` | After a roll is submitted with a pending check |

One parser handles all three. There is no second parser, no competing regex stripper.

### 2a. Delimiter Design

Each block uses the standard fenced code fence with a custom language tag:

```
```party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true}]
```

```check
{"skill":"STEALTH","dc":15}
```

```verdict
{"skill":"STEALTH","dc":15,"roll":17,"result":"FAIL"}
```
```

Rationale for this delimiter over alternatives:
- A fenced block with a custom language tag is a pattern qwen2.5 and other Ollama models
  handle more reliably than XML sentinels (`<party>…</party>`), because instruction
  tuning emphasizes markdown code fences.
- Placing blocks at the **end** of the response means narrative text renders first; the
  parser strips them before display so they never appear as chat text.
- JSON is unambiguous to parse defensively; simpler than a custom DSL.
- The language tags `party`, `check`, `verdict` are unlikely to collide with any code
  examples the DM might emit (which would use `js`, `python`, `bash`, etc.).
- One check-block and one verdict-block per response at most. The party block is emitted
  every response. Multiple structured blocks can coexist in a single response (e.g. a
  `check` turn also carries a `party` update); the shared extractor handles each by tag.

### 2b. System Prompt Injection

`buildSystemPrompt` in `src/lib/context.js` and `src/lib/context.starwars.js` is where
the instruction lives. The current `buildSystemPrompt` signature is:

```js
export function buildSystemPrompt({ name, details, context } = {})
```

The following two paragraphs are appended to the returned string (after the existing
formatting guidelines, before the closing line). Both paragraphs go into both engine
files identically.

**Party-block instruction (existing, from Phase A0):**

```
Party state: At the end of EVERY response, append a fenced code block tagged `party`
containing a JSON array that reflects the current party — one object per member with
keys: name (string), role (string, e.g. "Fighter" or "Jedi"), hpPct (integer 0–100),
isActive (boolean — true for the character whose turn or spotlight it is, false for
others; exactly one true). Do not explain the block; the app strips it before display.
Example (do not copy literally — use the actual party):

\`\`\`party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":false}]
\`\`\`

If party composition has not changed, still emit the block with the same values.
```

**Check/verdict instruction (new, Phase D):**

```
Skill checks: When you want the player to make a skill check, narrate the request and
ALSO emit a fenced block tagged `check` at the end of that response:

\`\`\`check
{"skill":"STEALTH","dc":15}
\`\`\`

`skill` is the check name in UPPERCASE. `dc` is the difficulty class integer. Only emit
this block when you are actually calling for a roll — do not emit it otherwise.

When the player's next message includes a dice roll and there was a pending check, judge
the roll against the DC and emit a fenced block tagged `verdict` at the end of your
narrated response:

\`\`\`verdict
{"skill":"STEALTH","dc":15,"roll":17,"result":"FAIL"}
\`\`\`

`result` is exactly "PASS" or "FAIL". Echo `skill`, `dc`, and `roll` faithfully. Do not
explain the block; the app strips it before display. Also emit the usual `party` block.
```

Both paragraphs are appended identically in both `context.js` (DnD) and
`context.starwars.js` (Star Wars). Genre-specific role vocabulary is handled naturally.
`genres.js` does not need changes.

**Prompt-size / compliance note for qwen2.5:** adding the check/verdict instruction
increases the system prompt by ~200 tokens. The model's instruction-following for
`check` and `verdict` is likely lower-fidelity than for `party` because it is
conditional rather than unconditional. If compliance is poor during Phase D manual
testing, consider: (a) splitting the instruction into two shorter bullet points, (b)
making the `check` emit part of the narration template rather than a separate fence.
Accept occasional non-compliance — the graceful fallback keeps the chip bare.

### 2c. Unified Streaming Extraction in Chat.jsx

`Chat.jsx` accumulates `fullText` during the NDJSON stream. All structured blocks must
not be applied until the stream closes, because they may be split across delta chunks
and always arrive last.

**Single strip function (all block types):**

```js
// Applied to fullText before setMessages(... content: stripped ...) on every delta.
// Strips any known structured block tag. An unclosed fence (no trailing ```) does not
// match the lazy [\s\S]*? + closing ``` — safe against partial chunks.
const BLOCK_TAGS = ['party', 'check', 'verdict']
const STRIP_RE = new RegExp(
  '```(?:' + BLOCK_TAGS.join('|') + ')[\\s\\S]*?```', 'g'
)
function stripStructuredBlocks(text) {
  return text.replace(STRIP_RE, '').trimEnd()
}
```

This single regex replaces the earlier `stripPartyBlock`. Adding a new block type in
the future is a one-line change to `BLOCK_TAGS`.

**Single extract function (parameterised by tag):**

```js
function extractBlock(tag, text) {
  const re = new RegExp('```' + tag + '\\s*([\\s\\S]*?)```')
  const match = text.match(re)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim())
  } catch {
    return null   // malformed JSON → ignore, keep last-known state
  }
}
```

Called three times in the `finally` block — once per tag.

**After stream closes (`finally` block, after `setIsLoading(false)`):**

```js
// 1. Party block — always apply if present
const partyRaw = extractBlock('party', fullText)
if (partyRaw && Array.isArray(partyRaw) && partyRaw.length > 0) {
  const next = applyPartyUpdate(partyRaw, party)
  setParty(next)
  localStorage.setItem('dnd_party', JSON.stringify(next))
}

// 2. Check block — store as pendingCheck; cleared when the roll is sent
const checkRaw = extractBlock('check', fullText)
if (checkRaw?.skill && checkRaw?.dc != null) {
  setPendingCheck({ skill: String(checkRaw.skill).toUpperCase(), dc: Number(checkRaw.dc) })
}

// 3. Verdict block — find the most recent unresolved dice message and upgrade it
const verdictRaw = extractBlock('verdict', fullText)
if (verdictRaw?.result === 'PASS' || verdictRaw?.result === 'FAIL') {
  setMessages(prev => {
    const idx = [...prev].map((m, i) => ({ m, i }))
      .reverse()
      .find(({ m }) => m.role === 'dice' && m.verdict == null)?.i
    if (idx == null) return prev
    return prev.map((m, i) =>
      i === idx
        ? { ...m, check: verdictRaw.skill, verdict: verdictRaw.result }
        : m
    )
  })
}
```

**Partial-fence / streaming behaviour:** `STRIP_RE` uses a lazy `[\s\S]*?` with a
required closing ` ``` `. An incomplete fence arriving mid-stream (opening tag but no
closing fence yet) does not match and passes through as plain text — briefly visible but
immediately overwritten on the next delta. In practice, the block arrives as one late
chunk. This is the same behaviour as the original `stripPartyBlock` and is acceptable.

`applyPartyUpdate(rawArray, existingParty)` reconciles incoming data with existing IDs
so React keys stay stable:

```js
function applyPartyUpdate(rawArray, existing) {
  return rawArray.map(raw => {
    const found = existing.find(
      e => e.name.toLowerCase() === (raw.name ?? '').toLowerCase()
    )
    return {
      id: found?.id ?? crypto.randomUUID(),
      name:     String(raw.name     ?? '').trim()   || 'Unknown',
      role:     String(raw.role     ?? '').trim()   || '',
      hpPct:    Math.max(0, Math.min(100, Math.round(Number(raw.hpPct) || 0))),
      isActive: Boolean(raw.isActive),
    }
  })
}
```

Defensive rules:
- `name` missing or empty → `'Unknown'` (prevents blank avatar puck).
- `hpPct` NaN or out-of-range → clamped to 0–100.
- `isActive` coerced with `Boolean()` — `"true"` (string) becomes `true`.
- Extra/unknown keys are ignored (forward-safe).
- Zero-member array: guarded by `partyRaw.length > 0` before calling `applyPartyUpdate`.
- If exactly zero or more than one member has `isActive: true`, the app renders
  faithfully — the next LLM turn will correct it.

### 2d. Graceful Fallback

| Situation | Behavior |
|-----------|----------|
| LLM emits no `party` block | Keep last-known `party` unchanged |
| LLM emits no `check` block when requesting a roll | `pendingCheck` stays null; dice chip renders bare; roll is sent with no pending-check context |
| LLM emits no `verdict` block after a roll | Most-recent dice chip stays bare (unresolved) — valid markup |
| LLM emits malformed JSON in any block | `JSON.parse` throws → `extractBlock` returns `null` → that block's state unchanged |
| LLM emits `verdict` with unexpected `result` value | Guard `=== 'PASS' \|\| === 'FAIL'` rejects it; chip stays bare |
| LLM emits a `party` block with 0 members | `partyRaw.length > 0` guard rejects it; party unchanged |
| Page reload mid-session | `loadParty()` reads `dnd_party` cache; `pendingCheck` resets to null (session-only) |
| First boot, no prior data | `loadParty()` seeds from `dnd_character` or `DEFAULT_PARTY` |
| Network error / LLM error | `finally` still runs; `fullText` may be partial; all `extractBlock` calls likely return `null`; all state unchanged |

qwen2.5 compliance is imperfect for conditional blocks (`check`, `verdict`) more than
for the unconditional `party` block. Accept occasional omissions — the graceful fallback
means the chip stays bare rather than crashing or showing stale data. Monitor during
Phase D manual testing and tighten the prompt if compliance is poor.

---

## 3. Per-Feature Implementation Plans

### Feature 1: Mobile Party Strip

**Target spec:** README:172–178.

```
[ Æ  Aelis        ] [ B  Borin        ] [ V  Vex          ]
[    Ranger · turn] [    Cleric       ] [    Rogue        ]
[ ████████████░░░ ] [ █████████████░ ] [ ████████████░░ ]
```

Active cell: `border-color: var(--border-gold)`, gold-tinted bg, inset 2px left bar.
Active change animated with 200ms `box-shadow` + `border-color` transition (README:216).

The strip is **read-only** — no click-to-edit, no add/remove affordance. Clicking a
cell does nothing (no `onSetActive` callback). The DM drives membership and active state.

#### New Component: `PartyStrip`

File: `src/components/PartyStrip.jsx`

Props: `{ party: PartyMember[] }` — no callback, display-only.

```jsx
<div className="party-strip">
  {party.map(member => (
    <div
      key={member.id}
      className={`party-strip-cell ${member.isActive ? 'party-strip-cell--active' : ''}`}
    >
      <div className="party-strip-avatar">{member.name[0]?.toUpperCase() ?? '?'}</div>
      <span className="party-strip-name">{member.name}</span>
      <span className="party-strip-role">
        {member.role}{member.isActive ? ' · turn' : ''}
      </span>
      <div className="party-strip-hp-track">
        <div
          className="party-strip-hp-fill"
          style={{ width: `${member.hpPct}%` }}
        />
      </div>
    </div>
  ))}
</div>
```

#### Files Changed

- `src/components/PartyStrip.jsx` — new component (above).
- `src/components/Chat.jsx` — import and render `<PartyStrip party={party} />` inside
  `.chat-container`, immediately after `<header className="chat-header">` and before
  the `{showDice && ...}` block. `party` is passed as a prop from `App.jsx` via `Chat`.
  No `onSetActive` is threaded.
- `src/App.jsx` — add `party` state (initialized via `loadParty()`), `setParty` handler,
  `dnd_party` persistence, pass `party` down to `<Chat>`. Also expose `setParty` to
  `Chat` so the stream parser (in `sendMessage`) can call it after each response.
- `src/App.css` — new `.party-strip` rules (append-only, corrected from design-bridge
  findings; see Section 4 for the authoritative CSS recipe).

#### Desktop: Party Sub-section in HistoryPanel

README:170 specifies a "Party" sub-section in the left history panel on desktop.

- `src/components/HistoryPanel.jsx` — add `party` prop. Render a new section below
  Session Log:
  ```jsx
  <div className="panel-header">Party</div>
  <div className="history-party-list">
    {party.map(m => (
      <div key={m.id} className="history-party-row">
        <span className="history-party-name">{m.name}</span>
        <span className="history-party-role">{m.role}</span>
        <div className="history-party-hp-track">
          <div className="history-party-hp-fill" style={{ width: `${m.hpPct}%` }} />
        </div>
      </div>
    ))}
  </div>
  ```
  This section is display-only — no edit controls.
- `Chat.jsx` — pass `party` prop to `<HistoryPanel>`.
- `App.css` — add `.history-party-*` rules (token-driven, no hardcoded colors).

---

### Feature 2: Header Turn-Pill + Live-Status Dot

**Target spec:** README:159–162.

Both elements are **desktop-only** (confirmed by design-bridge review; the mobile
reference omits them — the active strip cell's `· turn` caption is the mobile equivalent).

- **Status dot**: 8px circle, `var(--gold)`, `box-shadow: 0 0 10px var(--gold)`.
  Hidden on mobile via `@media (max-width: 768px) { display: none }`.
- **Turn-pill**: shows the LLM-active member's name. Hidden on mobile by the same rule.

`activeMember` is derived in `Chat.jsx` from the `party` prop — not from user click:

```js
const activeMember = party.find(m => m.isActive) ?? party[0]
```

The pill text reflects whatever the LLM last set as `isActive: true`. If no member is
active (initial state or empty party), `party[0]` is used as fallback.

#### Files Changed

- `src/components/Chat.jsx`:
  - Derive `activeMember` from `party` prop (line above).
  - Add `<span className="header-status-dot" />` inside `.header-left` before the emblem.
  - Add the turn-pill to `.header-actions` (leftmost position):
    ```jsx
    <div className="turn-pill">
      <span className="turn-pill-dot" />
      {activeMember?.name ?? ''}'s turn
    </div>
    ```
- `src/App.css` — same CSS recipe as in the original plan; both elements gain
  `@media (max-width: 768px) { display: none }` (OQ-2 resolved: hide on mobile).

#### Prop Threading

`App.jsx` passes `party` to `Chat`. `Chat` derives `activeMember` locally — no new
prop needed beyond `party`. No `setActivePartyMember` callback is needed; active state
is driven by the LLM.

---

### Feature 3: Dice Skill-Check Chip + Verdict

**Target spec:** README:190–202.

```
┌────┐
│ d20│  STEALTH    22    PASS
└────┘
```

#### The Dice Flow (LLM-driven)

**Who produces `check` and `verdict`?** The LLM. The DM narrates a check request,
emits a structured `check` block so the app knows a check is pending, receives the
roll result in the user's next message, then narrates the outcome and emits a
structured `verdict` block. The client only generates the random number; it never
computes PASS/FAIL itself.

**Step-by-step flow:**

1. **DM requests the check.** The DM narrates (e.g. "Give me a **STEALTH** check,
   DC 15.") and simultaneously emits a fenced `check` block at the end of the same
   response, using the same fence convention as `party`:

   ```
   ```check
   {"skill":"STEALTH","dc":15}
   ```
   ```

   `Chat.jsx` strips the block from the displayed text (same `stripBlock` helper as
   party), then parses it after the stream closes and stores it as `pendingCheck`
   state: `{ skill: 'STEALTH', dc: 15 }`.

2. **User rolls client-side.** `DiceRoller.jsx` remains result-only (no skill/DC
   input fields). The user clicks d20; `onRoll(die, result)` fires with just the
   random number — same signature as today.

3. **Dice message appended — bare state.** `Chat.jsx` `handleDiceRoll(die, result)`
   creates:

   ```js
   { role: 'dice', die, result }   // no check/verdict yet — rendered as "d20 → 17"
   ```

   `pendingCheck` is attached to the outgoing LLM message (step 4) but NOT written
   into the dice message yet; the chip renders bare immediately so the roll is visible
   before the DM responds.

4. **Roll sent to the DM with pending check context.** The dice-to-LLM transform
   (Chat.jsx:70–77) serialises the message including the pending check so the DM can
   judge it:

   ```js
   // m is the dice message; pendingCheck is current state at send time
   const checkCtx = pendingCheck
     ? ` | pending check: ${pendingCheck.skill} DC ${pendingCheck.dc}`
     : ''
   `[Dice roll: ${m.die} → ${m.result}${checkCtx}]`
   // e.g. "[Dice roll: d20 → 17 | pending check: STEALTH DC 15]"
   ```

   After the message is queued, `pendingCheck` is cleared (`setPendingCheck(null)`).

5. **DM narrates and emits a verdict block.** The DM's response includes narrative
   and a fenced `verdict` block at the end:

   ```
   ```verdict
   {"skill":"STEALTH","dc":15,"roll":17,"result":"FAIL"}
   ```
   ```

   `result` is `"PASS"` or `"FAIL"` (string, authoritative — the LLM decides).
   `skill`, `dc`, and `roll` are echoed back so the parser can correlate without
   relying on order alone.

6. **Chip upgrades from bare to resolved.** After the stream closes, `Chat.jsx`
   parses the `verdict` block and finds the most recent `dice` message in
   `messages[]` that has no `verdict` field yet. It updates that message in place:

   ```js
   // Additive update — existing fields unchanged; check + verdict added
   { role: 'dice', die, result, check: parsed.skill, verdict: parsed.result }
   ```

   The chip re-renders: `d20 / STEALTH / 17 / FAIL`. No check = no verdict = chip
   stays bare — a roll with no following verdict remains valid markup.

**Dice message shape (additive, existing rendering unaffected):**

```ts
// Before verdict arrives (bare state — valid, rendered as "d20 → 17"):
{ role: 'dice', die: 'd20', result: 17 }

// After verdict (resolved state — rendered as full chip):
{ role: 'dice', die: 'd20', result: 17, check: 'STEALTH', verdict: 'PASS' | 'FAIL' }
```

The `check` and `verdict` fields are optional. All existing code paths that read
`{ role: 'dice', die, result }` continue to work when those fields are absent.

**Finding the right dice message for the verdict-apply step:**

```js
// In the finally block, after extracting the verdict block:
const targetIdx = [...messages].reverse().findIndex(
  m => m.role === 'dice' && m.verdict == null
)
if (targetIdx !== -1) {
  const realIdx = messages.length - 1 - targetIdx
  setMessages(prev =>
    prev.map((m, i) =>
      i === realIdx
        ? { ...m, check: parsed.skill, verdict: parsed.result }
        : m
    )
  )
}
```

Using the most-recent unresolved dice message is the correct heuristic: the DM emits
exactly one verdict per check, so there is never ambiguity within a normal session.
If the DM ignores the roll entirely (no verdict block emitted), `targetIdx === -1`
and the chip stays bare — graceful.

**State additions to Chat.jsx / App.jsx:**

```ts
// Chat.jsx local state (not persisted — session-only):
const [pendingCheck, setPendingCheck] = useState<{skill: string, dc: number} | null>(null)
```

`pendingCheck` is cleared on `handleNewSession()` alongside `messages`.

---

## 4. Theming

All new markup is token-driven. Token table is identical to the original plan, except
`--green` is removed from the party strip HP fill (the design-bridge correction applies:
HP fill uses the gold gradient, not green).

| Token | Usage |
|-------|-------|
| `--gold` | Status dot bg + glow, turn-pill dot, chip tile border, HP fill gradient |
| `--gold-bright` | Turn-pill text, chip result, active cell avatar text, HP fill glow end |
| `--gold-dim` | HP fill gradient start |
| `--border-gold` | Turn-pill border, chip pill border, active cell border |
| `--surface-1` | Party strip cell base bg (corrected from surface-2) |
| `--surface-2` | Turn-pill bg base, chip pill bg |
| `--surface-3` | Party strip avatar bg, chip tile bg base |
| `--text-secondary` | Chip check label |
| `--text-muted` | Party strip role text |
| `--text-primary` | Party strip member name |
| `--green` | Verdict PASS tint only (not used in strip HP) |
| `--red` | Verdict FAIL |
| `--font-display` | Turn-pill, chip check label, chip result, party strip name + avatar |
| `--font-mono` | Chip verdict (PASS/FAIL) |

The append-only rule from `THEMING-WORKTREE-PLAN.md` continues to apply.

---

## 5. Responsive Layout

### Mobile Party Strip

- `.party-strip` is `display: none` by default.
- Inside `@media (max-width: 768px)`: `.party-strip { display: grid; }`.
- Rendered in JSX immediately after `<header>` inside `.chat-container`.

### Desktop Party Sub-section

- `HistoryPanel` renders the Party sub-section unconditionally.
- At mobile, the history panel collapses so the Party sub-section is hidden with it.

### Turn-Pill and Status Dot

- Both are **desktop-only**. Hidden via `@media (max-width: 768px) { display: none }`.
  OQ-2 is resolved: the active strip cell's `· turn` caption is the mobile indicator.
- Status dot is also desktop-only to match the reference (design-bridge confirmed).

---

## 6. Phasing and Verification

The LLM emission mechanism is new work that **precedes** the party-state rendering phase.
The revised phase order:

### Phase A0 — System prompt injection (context.js + context.starwars.js only)

**Goal:** Instruct the model to emit the `party` fence. No UI or state changes.

Files: `src/lib/context.js`, `src/lib/context.starwars.js`.

Changes:
1. Append the party-emission instruction paragraph to the string returned by
   `buildSystemPrompt` in both files (identical text).

Gate: `npm run build` green. `npm test -- --run` — all tests pass (pure function; tests
that call `buildSystemPrompt` will now see a longer string — assert they do not do exact
string matching on the full prompt; if they do, update the expected value). Manual test:
send one message in `npm run dev`, observe the raw Ollama response includes a `party`
fence at the end.

### Phase A — State model + migration + parser (App.jsx + Chat.jsx)

**Goal:** Add `party` state, `loadParty()`, stream-time strip function,
post-stream parser, and `applyPartyUpdate()`. No new UI yet.

Files: `src/App.jsx`, `src/components/Chat.jsx`.

Changes in `App.jsx`:
1. Add `DEFAULT_PARTY` constant.
2. Add `loadParty()` (migration from `dnd_character` as specified above).
3. Add `const [party, setParty] = useState(loadParty)`.
4. Persist on every `setParty` call to `dnd_party`.
5. Pass `party` and `setParty` down to `<Chat>`.

Changes in `Chat.jsx`:
1. Accept `party` and `setParty` as props.
2. Add `stripPartyBlock(text)` utility; apply it to `fullText` before each
   `setMessages(... content: stripped ...)` inside the streaming loop.
3. Add `extractPartyBlock(text)` and `applyPartyUpdate(rawArray, existing)` utilities.
4. In the `finally` block: call `extractPartyBlock(fullText)`; if non-null, call
   `setParty(applyPartyUpdate(parsed, party))`.

Gate: `npm run build` + `npm test -- --run` green. Manual test: send one message;
confirm the fence never appears in the chat bubble; open React DevTools, inspect `party`
state — it should update after each DM response.

### Phase B — Mobile party strip + History party sub-section

**Goal:** Render the LLM-driven `party` data. No click interactions on the strip.

Files: `src/components/PartyStrip.jsx` (new), `src/components/Chat.jsx`,
`src/components/HistoryPanel.jsx`, `src/App.css`.

Changes:
1. Create `PartyStrip.jsx` (display-only, no `onSetActive`).
2. Add corrected `.party-strip` CSS (from design-bridge Section 4 recipe below).
3. Add `.history-party-*` CSS rules.
4. Wire `<PartyStrip party={party} />` into `Chat.jsx`.
5. Pass `party` to `HistoryPanel`; add the Party sub-section JSX.

Gate: `npm run build` + `npm test -- --run` green. Visual: narrow viewport shows the
strip; desktop shows the party section in the history panel. After a DM response, both
update automatically.

**Tests to add:**
- `PartyStrip.test.jsx`: renders correct cell count; active cell has correct class; no
  click handler needed (remove the `onSetActive` click test from the original plan).
- `HistoryPanel.test.jsx`: add case where `party` prop is provided, assert names render.

### Phase C — Header turn-pill + status dot

**Goal:** Add desktop-only status dot and turn-pill driven by LLM `party` state.

Files: `src/components/Chat.jsx`, `src/App.css`.

Changes:
1. Derive `activeMember` from `party` prop (not user click).
2. Add dot and pill; both hidden on mobile via media query.
3. Add CSS for dot, pill, pulse animation, reduced-motion.

Gate: `npm run build` + `npm test -- --run` green. Visual: dot glows, pill shows DM's
active member name, updates automatically after each DM response.

**Tests to update:**
- `App.test.jsx` header area assertions — audit for exact child-count assumptions.

### Phase D — DiceChip component + LLM verdict wiring

**Goal:** Render the `DiceChip` component; wire the unified parser to drive
`pendingCheck` and the verdict-upgrade; update the system prompt with check/verdict
instructions. `DiceRoller` is result-only — **no skill/DC input fields are added to it**.

**Depends on:** Phase A0 (emission convention) and Phase A (the unified block parser).

Files: `src/components/DiceChip.jsx` (new), `src/components/Chat.jsx`,
`src/lib/context.js`, `src/lib/context.starwars.js`, `src/App.css`.

Changes:
1. Create `DiceChip.jsx` — renders bare state (`die + result`) and resolved state
   (`die + check + result + verdict`) from the dice message's optional fields.
   Both states must be valid markup; the chip need not know which state it is in —
   it simply renders whatever fields are present.
2. Add `pendingCheck` state to `Chat.jsx` (session-only, no localStorage).
3. Extend `BLOCK_TAGS` in `Chat.jsx` to include `'check'` and `'verdict'` (if not
   already present from Phase A).
4. Add the `check` and `verdict` extract+apply logic to the `finally` block (Section
   2c above).
5. Extend the dice-to-LLM transform (Chat.jsx:70–77) to include `pendingCheck` context
   in the serialised dice message string; clear `pendingCheck` after the message is sent.
6. Replace `DiceRoller`-rendered result with `<DiceChip>` in the dice message renderer
   (Chat.jsx:268–285). The chip upgrades automatically when `messages` state updates.
7. Append the check/verdict instruction paragraph to `buildSystemPrompt` in both
   `context.js` and `context.starwars.js`.
8. Add corrected `.dice-chip` CSS (from design-bridge Section — see corrected recipe
   in the design-fidelity review section below).

Gate: `npm run build` + `npm test -- --run` green. Manual test: trigger a check
request from the DM; observe `pendingCheck` in React DevTools; roll; observe the chip
render bare, then upgrade to resolved once the DM responds.

**Tests to add:**
- `DiceChip.test.jsx`: bare-state render (only die + result); resolved-state render
  (check + verdict present); PASS and FAIL variant classes; no crash when `check` and
  `verdict` are absent.
- `Chat.test.jsx` or `sendMessage.test.js`: assert that `extractBlock('verdict', ...)` 
  upgrades the most recent unresolved dice message and leaves resolved ones untouched.

### Verification Summary

| Gate | Command | Expected |
|------|---------|----------|
| After each phase | `npm run build` | Clean build, no TS/JSX errors |
| After each phase | `npm test -- --run` | All 108 tests pass (+ new ones) |
| After each phase | `npm run dev` at `:5173` | App loads, both genres render correctly |
| Phase A0 manual | Send one message | Raw response ends with ` ```party ` fence |
| Phase A manual | Send one message | Fence absent from chat; React DevTools shows party update |
| Phase B visual | Browser, narrow viewport | 3-cell strip visible under header |
| Phase B visual | Browser, wide viewport | Party section in HistoryPanel |
| Phase C visual | Both themes, desktop | Dot glows, pill shows DM-active member name |
| Phase D visual | DM emits check block | `pendingCheck` appears in React DevTools |
| Phase D visual | User rolls after pending check | Chip renders bare immediately, upgrades to resolved after DM verdict |
| Phase D visual | DM ignores roll (no verdict) | Chip stays bare — valid markup, no crash |

---

## 7. Open Questions / Risks

### OQ-1: Party management UI — RESOLVED
The user does not manage the party. No add/remove/edit UI is built. The LLM is the
sole editor. The strip and history panel are display-only.

### OQ-2: Turn-pill visibility on mobile — RESOLVED
Both the turn-pill and status dot are desktop-only. Hidden via `@media (max-width: 768px)
{ display: none }`. Confirmed by the mobile reference (design-bridge finding): mobile
uses the active strip cell's `· turn` caption.

### OQ-3: Star Wars / void genre support
`party[n].role` is whatever string the LLM emits — "Jedi", "Pilot", "Operative", etc.
No engine change needed; the strip renders whatever the DM says. The `DEFAULT_PARTY`
seed uses "Fighter" unconditionally. To improve first-boot accuracy, `loadParty()` can
check `dnd_genre` (or `campaign.genre`) when seeding:
- `dnd`: seed role from `dnd_character.charClass` or "Fighter".
- `starwars`: seed role "Operative" (or from `dnd_character.charClass` if it exists).
This is a minor UX polish — the LLM overwrites the seed on the first response anyway.
Defer unless the user requests it.

### OQ-4: Dice check field — RESOLVED (removed from DiceRoller)
The dice flow is LLM-driven. `DiceRoller` emits only `(die, result)` — the same
signature as today. No skill/DC input fields are added to the roller UI. Skill and DC
come from the DM's `check` block. The free-text input described in earlier plan
iterations is REMOVED.

### OQ-5: Verdict without a preceding check block — RESOLVED (graceful)
If the DM emits a `verdict` block but never emitted a matching `check` block (e.g.
the check was verbal, not structured), the verdict still upgrades the most recent
unresolved dice chip. The `check` field on the chip is populated from `verdictRaw.skill`
regardless of whether `pendingCheck` was set. This means the chip can display skill
label + PASS/FAIL even if the check block was missed. If neither check nor verdict
blocks are emitted, the chip stays bare — acceptable.

### OQ-6: hpPct sync with CharacterPanel — RESOLVED
No sync is needed or desired. `CharacterPanel` is the player's full stat sheet;
`party[n].hpPct` is the DM's report of party health. They are separate models. The DM
emits the party member's HP as it tracks it — the player's `CharacterPanel` is their
own reference and does not feed back into the strip.

### OQ-7: Crit/fumble treatment in DiceChip — UNCHANGED
`.dice-chip--crit` / `.dice-chip--fumble` modifier classes. See original plan.

### OQ-8: 108 test count — UNCHANGED
Verify with `npm test -- --run` before starting Phase A0.

### OQ-9: qwen2.5 compliance risk
qwen2.5:14b (the default model per `campaign.model || 'qwen2.5:14b'` in Chat.jsx:104)
reliably follows markdown formatting instructions but may occasionally:
- Omit the `party` fence on short responses (e.g. brief clarifying answers) — fallback:
  keep last-known party.
- Emit any fence mid-response instead of at the end — the unified `STRIP_RE` handles
  this; the strip function removes it wherever it appears.
- Produce trailing commas or unquoted keys in the JSON — the `try/catch` in
  `extractBlock` swallows these; fallback: keep last-known state for that block type.
- Add member names that differ in capitalization from prior turns ("aelis" vs "Aelis")
  — `applyPartyUpdate` normalizes with `.toLowerCase()` for ID matching.
- Emit a `check` block without the narration requesting it, or omit the block when it
  should be present — `pendingCheck` stays null; no chip upgrade expected.
- Emit a `verdict` block with `result` spelled differently from "PASS"/"FAIL" — the
  strict string guard rejects it; chip stays bare.

The check/verdict instruction adds ~200 tokens to the system prompt. Conditional
instructions (emit only when calling for a roll) are harder for the model to follow
than unconditional ones (emit every time). Compliance for `check`/`verdict` will likely
be lower than for `party`. The fallback — chip stays bare — is acceptable. Monitor
during Phase D manual testing and tighten the prompt wording if compliance is poor.

### OQ-10: Should `dnd_party` cache be cleared on New Session?
`handleNewSession()` in `Chat.jsx` clears `messages`, `entities`, and `sessionLog`. It
should also reset `party` to the boot seed (derived from `dnd_character` or
`DEFAULT_PARTY`) so the strip does not show the previous session's state. Add a
`resetParty()` call in `App.jsx` (or pass a `onNewSession` callback that covers
`setParty(loadParty())`). This is a one-line addition to `handleNewSession`.

---

## 8. Files Touched Summary

| File | Change Type | Phase |
|------|------------|-------|
| `src/lib/context.js` | Append party-emission instruction to buildSystemPrompt | A0 |
| `src/lib/context.starwars.js` | Append same instruction | A0 |
| `src/App.jsx` | Add party state, loadParty(), migration, persistence, pass to Chat | A |
| `src/components/Chat.jsx` | stripStructuredBlocks (unified), extractBlock (unified), applyPartyUpdate, post-stream apply for all three block types, pendingCheck state, dice-to-LLM transform with check context, PartyStrip + HistoryPanel wiring, turn-pill, DiceChip branch | A, B, C, D |
| `src/components/PartyStrip.jsx` | New display-only component | B |
| `src/components/HistoryPanel.jsx` | Add party prop + Party sub-section (display-only) | B |
| `src/components/DiceRoller.jsx` | No changes — remains result-only, onRoll(die, result) signature unchanged | — |
| `src/components/DiceChip.jsx` | New component; renders bare and resolved states from optional message fields | D |
| `src/App.css` | party-strip, history-party, status-dot, turn-pill, dice-chip rules | B, C, D |

Changed vs original plan:
- `src/lib/context.js` and `src/lib/context.starwars.js` now include BOTH the party-block
  instruction (Phase A0) AND the check/verdict instruction (Phase D).
- `src/App.jsx` no longer adds `setActivePartyMember` — no such callback exists.
- `PartyStrip.jsx` has no `onSetActive` prop.
- `DiceRoller.jsx` is NOT modified — no skill/DC fields are added to it.
- The two separate strip/extract functions (`stripPartyBlock`, `extractPartyBlock`) are
  replaced by `stripStructuredBlocks` and `extractBlock(tag, text)` — one of each,
  covering all block types.

---

## Design-fidelity review (design-bridge)

Reviewed against `design-handoff/README.md` (authoritative tokens/prose) and
`design-handoff/reference/Theme Compare Mobile.html` (authoritative layout/structure for
all three of these mobile features — verified, not stale). The desktop
`Theme Compare.html` Theme-B colors are stale per `THEMING-WORKTREE-PLAN.md:214-219` and
were NOT used. Where the plan's CSS disagrees with the mobile reference, **the reference
wins** — the README prose is a paraphrase and the plan copied a few values from the prose
that the mobile HTML contradicts.

Legend: ✓ covered · ⚠ under-specified / wrong value · ✗ missing.

### Feature 1 — Mobile party strip

| Item | Status | Ref | Note |
|------|--------|-----|------|
| 3-cell `1fr 1fr 1fr` grid, 8px gap | ✓ | README:172, HTML:371-376 | Reference padding is `6px 0 2px` inside the header, not `0 12px 10px` — see layout note below |
| Cell base background | ⚠ | HTML:380 | Plan uses `var(--surface-2)`. Reference uses **`var(--surface-1)`**. |
| Cell base border / radius | ⚠ | HTML:381-382 | Border `1px solid var(--border)` is correct; radius is **6px**, not 4px. |
| Active cell border-color | ⚠ | README:178, HTML:385 | README prose says `--border-gold`; reference active cell only changes `border-color: var(--border-gold)` — OK — but see inset below. |
| Active cell inset left border | ⚠ | HTML:387 | Plan: `inset 2px 0 0 var(--border-gold)`. Reference: **`inset 2px 0 0 var(--gold)`** (the brighter token). README:178 says "gold-tinted"; reference uses `--gold`, not `--border-gold`, for the inset bar. |
| Active cell tint bg | ⚠ | HTML:386 | Plan: `color-mix(... var(--gold) 6%, var(--surface-2))`. Reference: `color-mix(in oklab, var(--gold) 6%, var(--surface-1))` (over surface-1, matching the cell base). |
| Avatar / puck | ⚠ | HTML:390-398 | Plan: 24px circle, 14px font, `--surface-3` bg. Reference puck: **18px circle, 9px Cinzel, `--surface-3` bg, `1px solid var(--border-gold)`, `var(--gold-bright)` text**. |
| Name | ⚠ | HTML:399-405 | Plan: 11px `--text-primary`. Reference `.who`: `--font-display`, **9.5px, letter-spacing 0.12em, uppercase**, `--text-primary`. The uppercase + tracking is missing from the plan. |
| Role | ⚠ | HTML:406-414 | Plan: `--font-body` 10px italic `--text-muted`. Reference `.who small`: `--font-body` **9px** italic `--text-muted`, letter-spacing 0. Close; size is 9px not 10px. |
| HP track | ⚠ | HTML:415-421 | Plan: `height 4px`, `--surface-3` bg, no border, radius 2px. Reference `.bar`: **`height: 3px`, `background: var(--surface-3)`, `1px solid var(--border)`, `border-radius: 2px`, `overflow: hidden`**. |
| HP fill | ✗ | HTML:422-426 | **This is the biggest fidelity miss.** Plan fills with `var(--green)` and a red→gold `.warn` gradient. The reference fill is a **gold gradient with a glow**, with no green and no warn variant: `background: linear-gradient(90deg, var(--gold-dim), var(--gold-bright)); box-shadow: 0 0 6px -1px color-mix(in oklab, var(--gold) 60%, transparent);`. The README `.warn` red→bright gradient (README:167) belongs to the **desktop character-HUD stat bars**, not the mobile strip. Using `--green` here would also read wrong in void (green is identical `#2a5a1a` in both themes and clashes with the crimson HUD). |
| "·turn" caption | ✓ | README:175, HTML:871 | Reference writes `Ranger · turn` (spaces around the middot) and void writes `Blade · active`. Plan hardcodes `·turn` with no spaces and always the word "turn". Minor — consider matching `· turn` spacing and allowing the caption word to vary. |
| Active-change transition | ✓ | README:216 | `transition: border-color 200ms, box-shadow 200ms` is correct and matches README:216. |

**Corrected `.party-strip` recipe (port verbatim from the mobile reference):**
```css
.party-strip { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.party-strip-cell {
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px 8px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 200ms, box-shadow 200ms;   /* README:216 */
}
.party-strip-cell--active {
  border-color: var(--border-gold);
  background: color-mix(in oklab, var(--gold) 6%, var(--surface-1));
  box-shadow: inset 2px 0 0 var(--gold);               /* --gold, not --border-gold */
}
.party-strip-avatar {                                   /* the "puck" */
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--surface-3); border: 1px solid var(--border-gold);
  color: var(--gold-bright); font-family: var(--font-display);
  font-size: 9px; display: grid; place-items: center;
}
.party-strip-name {
  font-family: var(--font-display); font-size: 9.5px;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-primary);
}
.party-strip-role {
  font-family: var(--font-body); font-size: 9px; font-style: italic;
  color: var(--text-muted); letter-spacing: 0;
}
.party-strip-hp-track {
  height: 3px; background: var(--surface-3);
  border: 1px solid var(--border); border-radius: 2px; overflow: hidden;
}
.party-strip-hp-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--gold-dim), var(--gold-bright));
  box-shadow: 0 0 6px -1px color-mix(in oklab, var(--gold) 60%, transparent);
  transition: width 0.3s ease;
}
```
Drop the `.party-strip-hp-fill.warn` rule entirely — there is no warn variant on the
mobile strip in the reference. If the team wants low-HP emphasis, raise it as a new design
question rather than inventing the red gradient (it would be a deviation from the handoff).

**Both-theme check (strip):** all tokens above re-skin for free in void. The one bleed risk
the plan introduced is `var(--green)` on the HP fill — green is non-themed and would inject
a non-crimson color into the void HUD. Removing it (per above) resolves the bleed.

**Layout note (from reference, not pinned by README prose):** in the reference the strip
lives *inside* the `.m-header` block (`background: var(--surface-2)`, bottom border
`var(--border-gold)`), directly below the title row, with the header owning the padding
(`8px 14px 10px`) and the strip using `padding: 6px 0 2px`. The plan instead renders the
strip as a sibling *after* `<header>` with its own `padding: 0 12px 10px`. Either is
acceptable visually, but the reference treats the strip as part of the header surface (so
it sits on `--surface-2` with the gold bottom-border beneath it). Confirm whether the strip
should sit on the header surface (reference) or float on `--bg` between header and messages
(plan). Flagging because it changes the cell's surrounding contrast.

### Feature 2 — Header turn-pill + live-status dot

| Item | Status | Ref | Note |
|------|--------|-----|------|
| Status dot 8px, `--gold`, `0 0 10px var(--gold)` glow | ✓ | README:159, 259 | Values correct and token-driven. Re-skins to crimson in void for free. |
| Turn-pill inline-flex, rounded-full, gold-bright text | ✓ | README:161 | Correct. |
| Turn-pill font: Cinzel 10px uppercase | ⚠ | README:161 | Plan correctly uses `var(--font-display)` (so void gets Orbitron) — good. But README:161 implies tight tracking; plan's `letter-spacing: 0.1em` is a reasonable guess. The reference mobile chat has **no turn-pill** to copy from, so this is the desktop-only `Theme Compare.html` element — pull exact tracking from there during implementation rather than guessing. |
| 6px pulsing dot | ✓ | README:161 | `--gold-bright` dot, 6px, correct. |
| Pulse keyframes | ⚠ | — | Plan says "@keyframes turnDotPulse (scale/opacity, 1.4s)". The animation is invented (README only says "pulsing"). Acceptable, but keep it subtle and slow to match the candle/ember restraint the design explicitly chose (README:218, :280 — animations were deliberately slowed/dimmed). Suggest ~1.6-2s and opacity-only or small scale. |
| Reduced-motion wrap | ✓ | README:218 | Plan explicitly wraps `turnDotPulse` in `@media (prefers-reduced-motion: reduce) { animation: none }`. Correct. **Also add the same guard for the status-dot if you ever animate its glow** — currently the dot glow is static (`box-shadow`), so no animation guard is needed for it. Good. |
| Status-dot glow animation | ✓ | README:159 | Plan keeps the dot glow static (just a box-shadow), so no reduced-motion concern. Confirmed not an animation. |

**Both-theme check (pill/dot):** fully token-driven, no hardcoded hex. The plan's
`color-mix(in oklab, var(--gold) 10%, var(--surface-2))` pill bg and `var(--border-gold)`
border re-skin correctly. No bleed. The optional `[data-theme="void"]` "sharper HUD border"
is fine to defer — do not add it without the chamfer recipe (see void note below).

**Responsive split (the real issue here — ties to OQ-2):** the authoritative mobile
reference (`Theme Compare Mobile.html:863-883`) has **no status dot and no turn-pill in the
mobile header** — whose-turn-it-is is communicated solely by the active strip cell's
`· turn` caption. README:157-162 places the dot + pill in the **desktop** header. So:
- The plan's OQ-2 recommendation (hide the turn-pill on mobile via the `max-width:768px`
  block) is **correct and confirmed by the reference** — resolve OQ-2 as "hide on mobile."
- The **status dot** is also a desktop header element in the reference; the mobile header
  (reference) does not show it. The plan adds the dot to the shared `<header>` unconditionally.
  Decide: either also hide the dot on mobile (matches reference), or accept it as a small
  additive enhancement. Flagging so the dot doesn't silently appear on mobile where the
  reference omits it.
- Net: both header elements (dot + pill) are **desktop-primary**; the mobile equivalent is
  the strip's active cell. The plan should state this split explicitly (it currently only
  flags the pill).

### Feature 3 — Dice skill-check chip + verdict

| Item | Status | Ref | Note |
|------|--------|-----|------|
| Self-centered pill, rounded-full, `--surface-2` bg | ✓ | README:198, HTML:506-519 | Correct (`align-self: center`). |
| Pill border | ⚠ | README:198 vs HTML:512 | README:198 says "1px gold-dim border"; the mobile reference uses **`1px solid var(--border-gold)`** (HTML:512). The plan's CSS already uses `var(--border-gold)` — matches the reference, so keep it (README prose is the looser one here). |
| Pill missing glow | ✗ | HTML:518 | Plan omits the chip's outer glow. Reference: `box-shadow: 0 0 16px -8px color-mix(in oklab, var(--gold) 60%, transparent);`. Add it — it's what makes the chip read as a "story beat" in both themes. |
| Pill padding | ⚠ | HTML:509 | Plan: `5px 14px 5px 5px`. Reference: `5px 12px 5px 6px`. Minor; prefer reference. |
| Die tile min-width 22/26px, padding 0 5/6px | ✓ | README:199 | Correct. Reference also pins `height: 22px` and `display: grid; place-items: center` (HTML:520-529) — add the height + centering so single vs double-digit labels stay aligned. |
| Die tile border | ⚠ | README:199, HTML:524 | Plan: `1px solid var(--gold-dim)`. README:199 and reference both say **`1px solid var(--gold)`** (the brighter token). Change `--gold-dim` → `--gold`. |
| Die tile bg | ⚠ | HTML:526 | Plan: `var(--surface-3)`. Reference: **`color-mix(in oklab, var(--gold) 10%, var(--surface-3))`** (a faint gold wash, not flat surface-3). |
| Die tile radius | ✓ | README:199, HTML:523 | 5px (reference uses 5px; README says 5-6px). Fine. |
| Check label: `--font-display` 9.5/10.5px, ls 0.22em, uppercase, `--text-secondary` | ✓ | README:200, HTML:514-517 | Correct. |
| Result: `--font-display` 13/15px, `--gold-bright` | ✓ | README:201, HTML:530 | Correct. |
| PASS color | ⚠ | README:202, HTML:531 | Plan: `color-mix(in srgb, var(--green) 40%, #ffffff)`. Reference: **`color-mix(in oklab, var(--green) 50%, var(--gold-bright))`** — note it mixes toward `--gold-bright`, not white. Using white hardcodes a non-token and reads differently in void; the reference's gold-bright mix keeps it on-theme. Change to the reference recipe. |
| FAIL color: `--font-mono` 9/10px `var(--red)` | ✓ | README:202, HTML:531 (pass shown) | `var(--red)` is correct and themes correctly (`#8b1a1a` dnd / `#ff3b3f` void). |
| Verdict font `--font-mono` | ✓ | README:202 | Correct (JetBrains Mono in both themes). |
| fadeUp animation | ⚠ | README:213-214 | Plan uses `animation: fadeUp 0.2s ease-out`. README:213 specifies the send/append animation as **opacity 0→1 + translate-y 6px→0, 200ms ease-out** — make sure `fadeUp` matches that exactly (6px, not a larger offset). Wrap in reduced-motion if it's more than a fade. |

**Corrected `.dice-chip` recipe (port from the mobile reference):**
```css
.dice-chip {
  align-self: center;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 12px 5px 6px;
  border-radius: 99px;
  background: var(--surface-2);
  border: 1px solid var(--border-gold);
  box-shadow: 0 0 16px -8px color-mix(in oklab, var(--gold) 60%, transparent);
  animation: fadeUp 0.2s ease-out;                      /* opacity 0→1, ty 6px→0 */
}
.dice-chip-tile {                                        /* "die" */
  min-width: 22px; height: 22px; padding: 0 5px;
  border-radius: 5px;
  border: 1px solid var(--gold);                         /* --gold, not --gold-dim */
  background: color-mix(in oklab, var(--gold) 10%, var(--surface-3));
  color: var(--gold-bright);
  font-family: var(--font-display); font-size: 13px;
  display: grid; place-items: center;
}
.dice-chip-check {
  font-family: var(--font-display); font-size: 9.5px;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--text-secondary);
}
.dice-chip-result { font-family: var(--font-display); font-size: 13px; color: var(--gold-bright); }
.dice-chip-verdict { font-family: var(--font-mono); font-size: 9px; }
.dice-chip-verdict--pass { color: color-mix(in oklab, var(--green) 50%, var(--gold-bright)); }
.dice-chip-verdict--fail { color: var(--red); }
@media (min-width: 769px) {
  .dice-chip-tile { min-width: 26px; padding: 0 6px; }
  .dice-chip-check { font-size: 10.5px; }
  .dice-chip-result { font-size: 15px; }
  .dice-chip-verdict { font-size: 10px; }
}
```

**Both-theme check (chip):** the only hardcode to remove is `#ffffff` in the PASS color
(swap to the gold-bright mix above). Everything else is token-driven and re-skins. No bleed
once PASS is fixed.

### Cross-cutting: void chamfer / clip-path

The plan's optional void FX ("faint outer ember glow", "sharper HUD border", "ember border
glow on the chip tile for the crit case") are vague and gated on user confirmation, which is
fine — but if any are added they must follow the **faceted clip-path language** the void
theme uses everywhere else (README:116-117, :245-248; HTML:716, :745-755). The void chamfer
recipe is a polygon clip, e.g.:
```css
[data-theme="void"] .dice-chip {        /* if a faceted variant is desired */
  clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
  border-radius: 0;
}
```
Do **not** add a generic `box-shadow` ember glow in void without considering that void's
language is angular (chamfers + faceted corner glyphs), not soft rounded glows. This is a
"confirm with design" item, not a blocker. Also note: a rounded-full pill (`border-radius:
99px`) is intentionally kept rounded in BOTH themes in the reference (the dice chip and
turn-pill are not chamfered in the mobile HTML), so the safest default is **no void override
at all** for these three components — they already re-skin correctly via tokens.

### Reduced-motion summary

- Turn-pill dot pulse: ✓ guarded by the plan (README:218). Keep it slow/subtle.
- Status-dot glow: static box-shadow, no animation, no guard needed. ✓
- Dice-chip `fadeUp` and the active-cell 200ms transition: README:213/216 define these as
  intended motion; they are short and not the flicker/pulse class README:218 calls out.
  Optional to guard, but if `fadeUp` includes translate, wrapping it in the reduced-motion
  query is the safer, consistent choice.

### Verdict

**Not yet design-complete enough to start coding the CSS as written — but the structure,
prop threading, state model, phasing, and both-theme token strategy are sound.** The plan's
architecture (lightweight party shim, additive dice message shape, token-only styling) is
the right call and needs no rework. What needs fixing before Phase B/C/D CSS is written is a
set of **concrete value corrections** where the plan copied loose README prose instead of
the verified mobile reference:

Must-fix before coding (fidelity bugs):
1. **HP fill is gold-gradient + glow, not green; delete the red `.warn` gradient** (strip).
2. **Strip cell base is `--surface-1`, radius 6px; active inset uses `--gold` not
   `--border-gold`; active tint mixes over `--surface-1`.**
3. **Puck is 18px / 9px Cinzel with a `--border-gold` ring; name is 9.5px uppercase
   0.12em tracking.**
4. **Dice die-tile border = `--gold` (not `--gold-dim`), bg = gold-10% wash over
   `--surface-3`; add the chip's `0 0 16px -8px` outer glow.**
5. **PASS color mixes toward `--gold-bright`, not `#ffffff`** (removes a hardcode/bleed).

Confirm-with-design (not blockers):
6. Whether the strip sits on the header surface (reference) or floats on `--bg` (plan).
7. Whether the status dot is desktop-only (reference omits it on mobile) like the turn-pill.
8. Void: prefer no override for these three components; if a faceted variant is wanted, use
   clip-path, not a soft glow.

OQ-2 is effectively answered by the reference: hide the turn-pill on mobile (the active strip
cell's `· turn` caption is the mobile turn indicator).
