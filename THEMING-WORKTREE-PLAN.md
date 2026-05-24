# Theming Worktree Execution Plan — parallel dual-theme build

> **Status: CURRENT (drafted 2026-05-24).** Refreshed parallel-build plan for the
> two-theme effort. Supersedes [`archive/THEMING-WORKTREE-PLAN.md`](./archive/THEMING-WORKTREE-PLAN.md)
> (old "pure-CSS, no-JSX" scope + dead `theme/starwars` branch). Scope source of
> truth: [`design-handoff/README.md`](./design-handoff/README.md); reconciled
> index: [`THEMING-OVERVIEW.md`](./THEMING-OVERVIEW.md).
>
> **Goal:** build both themes with two agents in parallel, then merge — not one at
> a time. This plan is the Git orchestration that makes that safe.

## Scope decision (2026-05-24) — theme the real app only

Execution is scoped to **re-skinning the app as it actually exists** (single-character
`CharacterPanel`, `HistoryPanel`, dice messages `{die, result}`, Ollama chat). The
unambiguous, verifiable core ships: font + color tokenization, `data-theme` wiring by
genre, the two `[data-theme]` blocks (palette + scoped FX), and the kept Campaign Notes
field.

**Deferred — party-HUD features (build later).** The handoff's multi-character markup has
no backing data model in this app, so the following are explicitly *not* built here and
are tracked as future work:

- **Mobile party strip** — needs a `party: Array<{id,name,role,hpPct,isActive}>` model;
  the app has one `character`, not a party.
- **Turn-pill + live-status dot in the header** — needs an `activeCharacter` / turn concept.
- **Dice skill-check + verdict** (`{die, check, result, verdict}`) — DiceRoller emits only
  `{die, result}` with no associated skill check; crit/fumble already conveys a verdict.

When a party/turn model is added later, revisit these against `design-handoff/README.md`
(Mobile party strip, header turn-pill, Dice chip) — the token system shipped here re-skins
them for free.

## Post-merge gap closure (2026-05-24)

After the three theme merges landed on `master`, a handoff-vs-merged audit found five
visual features from `design-handoff/README.md` that the build hadn't applied. They split
into two buckets:

**Shipped — gaps inside the committed scope (commit `3c091e0`):**

- **(4) Composer `›` prefix glyph** — gold `›` at the left of the chat input
  (`.input-area::before`), token-driven via `--gold` + `--font-display` so Theme A renders
  it in Cinzel and Theme B in Orbitron with no per-theme rule.
- **(5) Shared drop-cap hook** — `parseMarkdown` (`Chat.jsx`) now wraps the GM's first
  letter in a single `<span class="dropcap">` (matches even when the paragraph opens with
  `<strong>`/`<em>`). Theme A illuminates the span; Theme B leaves it plain and surfaces GM
  identity via its `[GM]` HUD label. Replaces the old `::first-letter` selector so both
  themes share one hook — no JSX fork.
  - *Deviation from the original brief:* the plan said Theme B should "restyle the same
    span into `[GM]`." Turning a single-letter span into the text `[GM]` would swallow the
    first letter, so instead the `.dropcap` span is the shared hook (illuminated in A, plain
    in B) and B's `[GM]` tag stays on `.message-label.dm-label`. Same visual result, no fork.
  - Verified live in both themes (Ollama-backed GM message): drop-cap illuminates in `dnd`,
    stays a plain crimson letter in `void` (no bleed); `›` renders in both. Build green,
    108/108 tests pass.

**Still deferred — next tranche (items 1–3 above), each blocked on a missing data model:**

- **(1) Mobile party strip** — needs `party: Array<{id,name,role,hpPct,isActive}>`; app has
  one `character` (`App.jsx` `DEFAULT_CHARACTER`, persisted to `dnd_character`).
- **(2) Header turn-pill + live-status dot** — needs an `activeCharacter`/turn concept;
  none exists today.
- **(3) Dice skill-check chip + verdict** — needs `{die, check, result, verdict}`;
  `DiceRoller.jsx` emits only `{die, result}` and `Chat.jsx` renders crit/fumble via
  `.dice-result`.

Before building 1–3, settle the data-model scope (full multi-character party + turn order
vs. a minimal shim) — that decision drives the work across `App.jsx`, `Chat.jsx`,
`DiceRoller.jsx`, `CharacterPanel.jsx`, `HistoryPanel.jsx`, and both `App.css` theme blocks.

## Themes

| Theme | Selector | Genre | Branch | Worktree | Dev port |
|-------|----------|-------|--------|----------|----------|
| A — Candle-lit Grimoire | `[data-theme="dnd"]` | `dnd` | `theme/dnd` | `H:\Claude\dnd-claude-dnd` | 5174 |
| B — Crimson Void | `[data-theme="void"]` | `starwars`→`void` | `theme/void` | `H:\Claude\dnd-claude-void` | 5175 |

`THEME_FOR_GENRE = { dnd: 'dnd', starwars: 'void' }` — genre drives the theme;
no independent toggle. `dnd-claude` is a local git repo (`master`, no remote).

## Topology

```
master ──● commit docs
         │
         ●── theming-base        ← ALL shared work lands here FIRST, then commit
         │   (serialization point — fan-out cannot start until this is committed)
         │
         ├── theme/dnd   (worktree dnd-claude-dnd, port 5174)  ← APPEND-ONLY
         └── theme/void  (worktree dnd-claude-void, port 5175) ← APPEND-ONLY
         │
         ●── merge theming-base → theme/dnd → theme/void → master → cleanup
```

## The rule that keeps parallel safe

Both themes share the **same** token mechanism, the **same** tokenization refactor
(fonts + colors), the **same** expanded fonts `<link>`, and the **same** new
markup/state — only palette *values* and attribute-scoped FX differ. Therefore:

1. **All shared work is committed to `theming-base` before any fan-out.** This is a
   hard serialization point; two agents starting earlier would collide on the same
   `App.css` lines and JSX.
2. **Each theme agent edits `App.css` append-only**, inside its own
   `[data-theme="x"]{…}` block + scoped FX rules at the **end of the file**. The two
   branches touch disjoint regions → clean merges (worst case: a trivial "both added
   at EOF" you resolve by keeping both blocks stacked).
3. **Theme branches never touch** `index.html`, `App.jsx`, `:root`, or any existing
   shared rule. Those live only on `theming-base`. Enforced by review of every diff.

## Phase 0 — commit docs (master)

```powershell
cd H:\Claude\dnd-claude
git add design-handoff/README.md THEMING-OVERVIEW.md THEMING-WORKTREE-PLAN.md
git commit -m "docs: theming handoff + overview + worktree execution plan"
git status   # clean tree
```

## Phase 1 — shared base (branch `theming-base`, sequential, do once)

```powershell
git checkout -b theming-base
# ...implement the shared scope below...
git commit -am "theming base: data-theme wiring + font/color tokens + fonts link + shared markup"
```

Shared scope (route React work to `react-specialist`):

- **`src/App.jsx`** — add `const THEME_FOR_GENRE = { dnd:'dnd', starwars:'void' }` and a
  `useEffect` that sets `document.documentElement.dataset.theme` from the active genre
  (`ready ? campaign.genre : draftGenre`, fallback `'dnd'`). Genre still persists via
  the existing `dnd_genre` localStorage key — no new persistence.
- **`index.html`** — replace the single Google Fonts `<link>` with this **exact** URL
  (matches `design-handoff/README.md`; adds Orbitron, Titillium Web, JetBrains Mono and
  the weight axes the handoff uses — Orbitron `800`, Crimson Pro `ital`, etc. — paste
  verbatim so weights don't drift):

  ```html
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400&family=Orbitron:wght@500;600;700;800&family=Titillium+Web:wght@300;400;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  ```
- **`src/App.css` `:root`** — add `--font-display`, `--font-body` (base values = D&D
  fonts) and `--font-mono: 'JetBrains Mono', ui-monospace, monospace`. **`--font-mono`
  is `:root`-only — both themes use JetBrains Mono (timestamps, stat values, dice
  pass/fail, the void `[GM]` tag), so it is never overridden per theme.** Tokenize the
  **~15–20** hardcoded color spots (NOT ~6 as
  the overview claims): `.btn-begin` / `.send-btn` gradients, `.dice-result.crit` /
  `.fumble` colors, body radial gradients, the `rgba(201,168,76,…)` gold-glow series
  (~8), the `rgba(139,26,26,…)` red series (~6), select-arrow SVG fill. Swap the **31**
  font literals (25 `Cinzel` → `var(--font-display)`, 6 `Crimson Pro` → `var(--font-body)`).
- **`src/App.css` end** — add empty `[data-theme="dnd"]{}` and `[data-theme="void"]{}`
  placeholder blocks for the theme branches to fill.
- **Shared markup/state** — **DESCOPED per the 2026-05-24 scope decision above.** The
  party strip, turn-pill / status dot, and dice `{check, verdict}` are deferred (no backing
  data model). Phase 1 makes **no JSX feature additions**; it is purely the token refactor +
  `data-theme` wiring + empty theme blocks, so both themes re-skin the existing markup.
- **MUST KEEP** — the Campaign Notes / Load `.md` field (`ApiKeySetup.jsx` L108–133:
  hidden `.md/.txt` input, `.file-upload-btn`, `.file-loaded` chip + clear) that loads
  into `campaign.context`. The handoff omits it; keep it **between the Details textarea
  and the Begin button**. Already token-driven, so it re-skins for free.
- **No engine changes**: `src/lib/genres.js` (ids `'dnd'`/`'starwars'`), `src/lib/context.js`.

**Gate:** `npm run build` + `npm test -- --run` green; `npm run dev` (5173) shows D&D
rendering **identical to today** — this phase is a deliberate no-op refactor.

## Phase 2 — fan out worktrees (after base committed)

```powershell
git worktree add -b theme/dnd  H:\Claude\dnd-claude-dnd  theming-base
git worktree add -b theme/void H:\Claude\dnd-claude-void theming-base
git worktree list

cd H:\Claude\dnd-claude-dnd ; npm install
cd H:\Claude\dnd-claude-void ; npm install
```

Each worktree needs its **own `node_modules`** (Vite). Run dev servers on distinct
ports: base 5173 · dnd 5174 · void 5175 (`npm run dev -- --port 517x`).

### Agent brief — `theme/dnd` (Candle-lit Grimoire) → `react-specialist`

Append to the `[data-theme="dnd"]` block in `App.css` only. Palette (from overview):
`--bg #0d0a07 · --surface-1 #1c1409 · --surface-2 #241809 · --surface-3 #34250f ·
--gold #c9a84c · --gold-dim #846a34 · --gold-bright #f0d28a · --text-primary #ecdcae ·
--text-secondary #a88a64 · --text-muted #6f5442 · --border #3f2d18 · --border-gold
#644626 · --red #8b1a1a · --green #2a5a1a`; `--font-display 'Cinzel'`,
`--font-body 'Crimson Pro'`. Scoped FX (pull **exact recipes from the handoff**): warm
radial candlelight + vellum noise body wash · parchment-grain GM bubble + inset gold
glow · illuminated drop-cap (`::first-letter`) on GM's first paragraph · `candleFlicker`
6s on the setup emblem · warm gold rune-glow focus ring · crimson wax-seal corner discs
with a `✦` glyph.

### Agent brief — `theme/void` (Crimson Void) → `react-specialist`

Append to the `[data-theme="void"]` block in `App.css` only. Palette (from overview):
`--bg #06040a · --surface-1 #0d0810 · --surface-2 #160a13 · --surface-3 #200d17 ·
--gold #b2222d · --gold-dim #5a141a · --gold-bright #e85257 · --text-primary #e6dee2 ·
--text-secondary #a08894 · --text-muted #6a5260 · --border #2a1620 · --border-gold
#5a1820 · --red #ff3b3f · --green #2a5a1a`; `--font-display 'Orbitron'`,
`--font-body 'Titillium Web'`. Scoped FX (pull **exact recipes from the handoff**):
ember-dust + crimson radial body backdrop · interlace + hot inner ember on GM bubble ·
`[GM]` HUD tag (Orbitron) instead of a drop-cap · `emberPulse` 6.5s on the emblem ·
chamfered `clip-path` card/button corners · faceted `◤◥◣◢` corner glyphs · crimson
focus ring.

> ⚠️ **Read before writing any theme CSS — the recipes above are illustrative; the
> handoff is authoritative.** Each theme agent must take the precise `color-mix` /
> `clip-path` / keyframe CSS from `design-handoff/README.md`, not from the
> reconstructions above. Specifically:
>
> - **Palette token *values* above are verified and authoritative** (they match the
>   README token tables exactly).
> - **Theme B (void): `reference/Theme Compare.html` is STALE — use it for desktop
>   *layout* only.** Its Theme-B colors/FX are the **rejected "hot" palette**
>   (`--gold #c8232e`, `--gold-dim #6a1218`, `--gold-bright #ff5a5f`, `--border-gold
>   #6a1c24`, `emberPulse 5.5s`, ~70% GM-bubble glow) that README L280 retired as "too
>   hot on a phone at night." **Authoritative Theme-B source = the README token table +
>   `reference/Theme Compare Mobile.html`.** Do NOT port colors/FX from the desktop file.
> - **Reduced motion (both themes):** wrap the emblem animation in
>   `@media (prefers-reduced-motion: reduce) { animation: none }` (README L73 / L218).
>   Neither reference HTML contains this rule — implement it from the README prose.
> - **Port, don't invent:** anything not bulleted in the briefs (card-lift shadow,
>   button rune-glow, GM-bubble accent borders, dice-chip tile, turn-pill / status dot,
>   type scale, composer `›` glyph + send-button gradient, `.stat.warn` bar, mobile
>   party-strip cell states) is specified in README "Design Tokens" + "Screens" and the
>   Mobile HTML — port those values rather than inventing them.
> - **Drop-cap hook:** the GM's first paragraph wraps its initial letter in a
>   `<span class="dropcap">` (not `::first-letter`). Theme A illuminates that span;
>   Theme B restyles the **same** span into the `[GM]` HUD tag — both themes target one hook.

## Phase 3 — merge back (master) + cleanup

```powershell
cd H:\Claude\dnd-claude
git merge --no-ff theming-base -m "merge: theming-base (shared refactor)"
# gate: build + test + dev — D&D still identical
git merge --no-ff theme/dnd  -m "merge: theme/dnd (Candle-lit Grimoire)"
# gate: genre=dnd shows new palette + FX
git merge --no-ff theme/void -m "merge: theme/void (Crimson Void)"
# gate: genre=starwars→void shows new palette + FX; no bleed into dnd

git worktree remove H:\Claude\dnd-claude-dnd
git worktree remove H:\Claude\dnd-claude-void
git branch -d theme/dnd theme/void theming-base
git worktree list   # only main remains
```

If the final merge conflicts at EOF of `App.css`, keep **both** `[data-theme]` blocks
stacked, `git add src/App.css`, `git commit`.

## Verification gates (every gate must pass)

- Per branch/worktree: `npm run build` + `npm test -- --run` (both genre engines stay
  green) + `npm run dev` on its port.
- Post-merge: `genre=dnd` → Candle-lit palette + its FX; `genre=starwars` → Crimson Void
  palette + its FX; **no FX bleed** between themes (rules are attribute-scoped).
- `color-mix(in oklab,…)` and `clip-path` don't render in jsdom — tests assert structure
  only; verify visuals in the browser.
- Favicon / `<title>` in `index.html` stay generic (`D&D Campaign Assistant` / `⚔`).

## Risks / gotchas

- **Color tokenization is bigger than the overview says** — ~15–20 spots, not ~6.
- **Campaign Notes field** is omitted from the handoff — keep it (above).
- **Genre→theme map wrinkle** — genre id `starwars` maps to `[data-theme="void"]`; no
  genre rename, no engine changes.
- **node_modules per worktree** (~3× disk) and **distinct ports** — expected, temporary.
- **No remote** — all merges are local; `master` holds the result after merge-back.

## Touched files

`src/App.jsx`, `index.html`, `src/App.css` (base + both theme blocks),
`src/components/ApiKeySetup.jsx` (keep Campaign Notes), `src/components/Chat.jsx` +
`src/components/DiceRoller.jsx` (dice verdict/chip), new mobile party-strip component.
No `genres.js` / `context.js` changes.
