> ⛔ **SUPERSEDED 2026-05-23.** Names the dead `theme/starwars` branch and assumes
> the old "pure-CSS, no-JSX" scope. The *shared-base-first* idea still holds, but
> the handoff adds real component/state work, so a fresh execution plan is needed.
> Source of truth: `../design-handoff/README.md`; reconciled index:
> `../THEMING-OVERVIEW.md`. Kept for history only — do not implement from this file.

# Theming Worktree Execution Plan — D&D + Star Wars in parallel

How to build **both** genre themes in parallel using git worktrees, then merge
cleanly. Companion to `THEMING-OVERVIEW.md`, `DND-THEMING-PLAN.md`,
`STARWARS-THEMING-PLAN.md`. **This is the execution recipe — nothing here is
applied yet.**

> Captured 2026-05-23. `dnd-claude/` is its own git repo (toplevel
> `H:/Claude/dnd-claude`, branch `master`, **no remote**, single worktree), so
> `git worktree` is viable.

## Why "shared base first" (not pure parallel)

The two plans share a large refactor that edits the **same files at the same
lines** — Phase 1 (mechanism: `App.jsx`, `ApiKeySetup.jsx`), Phase 3 (tokenize
hardcoded colors in `App.css`), Phase 4 (swap 31 font literals in `App.css`).
Only Phase 2 (the `[data-theme]` palette block) and Phase 5 (theme-scoped FX) are
genuinely additive/independent.

Two fully-independent branches off `master` would therefore **conflict heavily**
in `App.css`/`App.jsx` and duplicate the font swap. So: land the shared refactor
**once** on a common base, then fan out two worktrees that each only add their
additive theme block.

**Decisions:** shared-base-first; full Phases 1–5 for both themes.

> Trade-off, stated honestly: the shared refactor is the *bulk* of the mechanical
> work and is done once on the base — so the real parallelism is in the creative
> Phase 2/5 tuning (palette + FX), iterated with two live dev servers side by
> side. If that's not worth the worktree overhead, the simpler sequential path
> (ship one theme on `master`, the other just adds its block) reaches the same
> end state.

## Structure

```
master ──● commit: theming docs (commit the uncommitted/untracked .md files)
         │
         ●  branch: theming-base
         └──● shared refactor = Phase 1 + Phase 3 + Phase 4
            ├─ worktree theme/dnd      → Phase 2 (dnd palette) + Phase 5 (dnd FX)
            └─ worktree theme/starwars → Phase 2 (sw palette)  + Phase 5 (sw FX)
         ●←─┘ merge theme/dnd, then merge theme/starwars into master
```

## Step 0 — Commit the docs (clean working tree first)

Working tree currently has `STARWARS-THEMING-PLAN.md` (modified),
`DND-THEMING-PLAN.md` + `THEMING-OVERVIEW.md` (untracked) — plus this file. Commit
them on `master` so both worktrees inherit the blueprints.

```bash
git -C H:/Claude/dnd-claude add *.md
git -C H:/Claude/dnd-claude commit -m "docs: D&D + SW theming blueprints + worktree plan"
```

## Step 1 — Shared base branch (Phases 1, 3, 4)

Create `theming-base` from `master`, implement the shared work **in the main
tree** (it's the common ancestor for both themes). Line numbers verified in the
plan docs as of 2026-05-23.

- **Phase 1 — mechanism**
  - `src/App.jsx`: add
    `const [draftGenre, setDraftGenre] = useState(() => localStorage.getItem('dnd_genre') || 'dnd')`;
    add `useEffect(() => { document.documentElement.dataset.theme = ready ? campaign.genre : draftGenre }, [ready, campaign.genre, draftGenre])`;
    pass `value={draftGenre}` + `onChange={setDraftGenre}` to `CampaignSetup`.
  - `src/components/ApiKeySetup.jsx`: replace internal `useState('dnd')` for
    `genreId` with `value`/`onChange` props from App.
  - `src/App.css`: leave `:root` as the genre-neutral fallback; add empty
    `[data-theme="dnd"] {}` and `[data-theme="starwars"] {}` placeholder blocks.
- **Phase 3 — tokenize hardcoded colors** in `src/App.css`: button gradients
  (`.btn-begin`, `.send-btn` + hovers) → `--btn-grad-from`/`--btn-grad-to`;
  `.setup-card` glow + emblem drop-shadow → `--accent-glow`;
  `.action-suggestions` bg + focus glow → `--accent-soft` / `--focus-glow`;
  `.message-input:focus` ring → `--focus-glow`; `.char-hp-bar-fill` glow → token
  off `--red`; select-arrow SVG left as-is unless palette makes it look off. Add
  new token defaults to `:root` matching today's values (D&D-neutral) so base
  renders byte-identical.
- **Phase 4 — tokenize fonts** in `src/App.css`: add
  `--font-display: 'Cinzel', serif; --font-body: 'Crimson Pro', Georgia, serif;`
  to `:root`; find/replace the **31 literals** (25 `Cinzel` + 6 `Crimson Pro`,
  incl. `body { font-family }`) → `var(--font-display)` / `var(--font-body)`.
  Leaves rendered output identical while unlocking the SW font swap.

```bash
git -C H:/Claude/dnd-claude checkout -b theming-base
# ...implement Phases 1/3/4...
git -C H:/Claude/dnd-claude commit -am "theming base: data-theme mechanism + tokenize colors & fonts (P1/P3/P4)"
```

**Verify base is a visual no-op** (see Verification) — the regression guard.

## Step 2 — Create the two worktrees off the base

```bash
git -C H:/Claude/dnd-claude worktree add -b theme/dnd      H:/Claude/dnd-claude-dnd      theming-base
git -C H:/Claude/dnd-claude worktree add -b theme/starwars H:/Claude/dnd-claude-starwars theming-base
```

- Place worktrees **outside** `dnd-claude/` (siblings under `H:/Claude/`) so the
  main tree's tooling doesn't pick them up.
- Each worktree needs its **own `node_modules`** (Vite dev requires it present).
  Run `npm install` in each once.
- Run dev servers on **different ports** to compare live:
  `npm run dev` (5173, base) · `npm run dev -- --port 5174` (dnd) ·
  `npm run dev -- --port 5175` (starwars).

## Step 3 — Per-theme work (parallel, additive only)

Each worktree touches **only** additive, attribute-scoped blocks — no edits to
the shared Phase 1/3/4 regions — so the merges stay clean.

- **`theme/dnd`** (`H:/Claude/dnd-claude-dnd`):
  - Phase 2: fill `[data-theme="dnd"] {}` with the candle-lit palette (warmer
    `--surface-*`, `--gold-bright #f0d28a`, `--text-primary #ecdcae`,
    `--border-gold #644626`, … — see `DND-THEMING-PLAN.md` §Phase 2) + D&D values
    for the Phase-3 tokens (`--accent-glow`, `--accent-soft`, `--focus-glow`,
    `--btn-grad-*`).
  - Phase 5 (scoped to `[data-theme="dnd"]`): parchment-grain wash on
    `.dm-bubble`; illuminated drop-cap via
    `.dm-bubble .message-content p:first-child::first-letter` (NOT
    `.dm-bubble::before` — already taken); candle-flicker `@keyframes` on
    `.setup-emblem` (guard `prefers-reduced-motion`); warm rune-glow focus;
    optional wax-seal corner glyph; candlelit body radials via
    `html[data-theme="dnd"] body`.
- **`theme/starwars`** (`H:/Claude/dnd-claude-starwars`):
  - Phase 2: fill `[data-theme="starwars"] {}` with the holo-cyan palette
    (`--gold #3fa9d4`, deep-space `--surface-*`, … — see
    `STARWARS-THEMING-PLAN.md` §Phase 2) + cyan values for the Phase-3 tokens.
  - Phase 4 delta: add the **second `<link>`** (Orbitron + Titillium Web) to
    `index.html`, and override `--font-display`/`--font-body` inside the SW block.
    ⚠️ `index.html` is the one shared file SW also touches — see merge note.
  - Phase 5 (scoped to `[data-theme="starwars"]`): hologram scanlines on
    `.dm-bubble`; starfield body via `html[data-theme="starwars"] body`; cyan
    saber-glow focus; cyan suggestion-button glow.

Commit within each worktree as you go.

## Step 4 — Merge back

```bash
git -C H:/Claude/dnd-claude checkout master
git -C H:/Claude/dnd-claude merge theming-base      # shared refactor first
git -C H:/Claude/dnd-claude merge theme/dnd          # additive [data-theme="dnd"] block
git -C H:/Claude/dnd-claude merge theme/starwars     # additive [data-theme="starwars"] block
```

- The two themes append **different `[data-theme]` selectors** to `App.css`, so
  the theme merges auto-merge or need only trivial "both added near EOF"
  resolution.
- **One real overlap to watch:** SW's `index.html` `<link>` and the two `App.css`
  theme blocks are the merge seams. SW's link is purely additive (a second
  `<link>` line) — if a conflict appears, keep both.
- Merge order `theming-base → theme/dnd → theme/starwars` keeps each conflict
  surface small.

## Step 5 — Cleanup

```bash
git -C H:/Claude/dnd-claude worktree remove H:/Claude/dnd-claude-dnd
git -C H:/Claude/dnd-claude worktree remove H:/Claude/dnd-claude-starwars
git -C H:/Claude/dnd-claude branch -d theme/dnd theme/starwars theming-base
```

## Verification (run at each gate: base, each worktree, post-merge)

- `npm run build` — must succeed.
- `npm test -- --run` — confirms both genre engines + rendering untouched
  (~108 tests per the SW plan).
- `npm run dev` and eyeball:
  - **Regression guard:** with the D&D genre selected (`data-theme="dnd"`), the
    Step-1 base must render **identical to today** (Phases 1/3/4 are a visual
    no-op). Snapshot D&D Setup + Chat screens before Step 1 to diff against.
  - After each theme lands, switch genres and confirm the *other* theme is
    unchanged — FX are `[data-theme]`-scoped, so no bleed.
- Static items stay generic: favicon + `<title>` in `index.html` can't react to
  runtime genre — leave `D&D Campaign Assistant` / `⚔`.

## Files touched (summary)

| File | Base (P1/3/4) | theme/dnd | theme/starwars |
|------|:-:|:-:|:-:|
| `src/App.jsx` | ✎ | | |
| `src/components/ApiKeySetup.jsx` | ✎ | | |
| `src/App.css` | ✎ (tokens + empty blocks) | ✎ (dnd block + FX) | ✎ (sw block + FX) |
| `index.html` | | | ✎ (Orbitron/Titillium link) |

No engine / `genres.js` / `context*.js` / `CharacterPanel.jsx` /
`HistoryPanel.jsx` changes.
