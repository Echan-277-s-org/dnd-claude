# THEMING-COORDINATION.md — parallel dual-theme coordination contract

> **Role of this file:** the convergence runbook for a 2-worker parallel CSS theming
> build. It does NOT re-specify palettes/FX (that is the orchestrator's worker brief +
> `design-handoff/README.md`). It defines the collision-avoidance contract, the
> per-branch acceptance checklist, the merge order + gates, no-bleed verification, and
> failure handling. Companion docs: `THEMING-WORKTREE-PLAN.md` (git orchestration),
> `design-handoff/README.md` (design SoT), `Theme Compare Mobile.html` (Theme-B authority).
>
> **State as of authoring:** serialization point `theming-base` is committed; fan-out is
> in progress on `theme/dnd` (worktree `dnd-claude-dnd`, 5174) and `theme/void`
> (worktree `dnd-claude-void`, 5175). Merge-back not started.

---

## 1. Append-only collision-avoidance contract (workers MUST obey)

The shared refactor on `theming-base` ends `src/App.css` with an **APPEND-ONLY ZONE**
(begins ~line 1272) holding two empty blocks: `[data-theme="dnd"] {}` and
`[data-theme="void"] {}`. Each worker owns exactly one block.

**Allowed (per worker, in its OWN worktree only):**
- Edit ONLY its own `[data-theme="x"] { … }` block.
- Add additional theme-scoped rules (e.g. `[data-theme="x"] body`,
  `[data-theme="x"] .dm-bubble`, `[data-theme="x"] .btn-begin`,
  `@keyframes candleFlicker`/`emberPulse`, the reduced-motion `@media`).
- **Every selector a worker writes MUST be prefixed with its own `[data-theme="x"]`.**
  The only exception is `@keyframes` (global by nature) — name them uniquely per theme
  (`candleFlicker` for dnd, `emberPulse` for void) so the two branches never collide.
- All worker output lives **at or after its block, inside the APPEND-ONLY ZONE at EOF**.

**Forbidden for workers (any of these = contract violation):**
- Editing `:root` or ANY shared rule above the APPEND-ONLY ZONE.
- Editing the OTHER theme's block or rules.
- Writing any unscoped selector (`body`, `.app`, `.dm-bubble` without the `[data-theme]`
  prefix) — would bleed across genres.
- Touching `index.html`, `src/App.jsx`, any `.jsx`, or ANY file other than `src/App.css`.
- Running `npm install`, the dev server, or `npm run build` (orchestrator runs all gates).

**Rationale:** the two branches then touch **disjoint regions of the same file** → near-
trivial merge. Worst case is "both added at EOF", resolved by stacking both blocks (see §3).

---

## 2. Per-branch deliverable checklist (orchestrator verifies per worktree)

Values come from the orchestrator's worker brief / README token tables — NOT invented.
Recipes are **ported from `design-handoff/README.md`**; the briefs are illustrative.

### `theme/dnd` — Candle-lit Grimoire (worktree `H:\Claude\dnd-claude-dnd`)
- [ ] Override all **14 standard tokens** in `[data-theme="dnd"]`: `--bg #0d0a07`,
      `--surface-1 #1c1409`, `--surface-2 #241809`, `--surface-3 #34250f`,
      `--gold #c9a84c`, `--gold-dim #846a34`, `--gold-bright #f0d28a`,
      `--text-primary #ecdcae`, `--text-secondary #a88a64`, `--text-muted #6f5442`,
      `--border #3f2d18`, `--border-gold #644626`, `--red #8b1a1a`, `--green #2a5a1a`.
- [ ] Override `--font-display: 'Cinzel'` and `--font-body: 'Crimson Pro'`.
      (`--font-mono` is `:root`-only — do NOT override it.)
- [ ] FX: warm radial candlelight + vellum-noise body/setup/messages backdrop.
- [ ] FX: parchment-grain GM bubble + inset gold glow.
- [ ] FX: illuminated drop-cap on the GM first-paragraph `<span class="dropcap">` hook.
- [ ] FX: `candleFlicker` 6s on the setup emblem (box-shadow only).
- [ ] FX: warm gold rune-glow focus ring + button gradient.
- [ ] FX: crimson wax-seal corner discs with gilt `✦` glyph.
- [ ] `@media (prefers-reduced-motion: reduce)` scoped to `[data-theme="dnd"]` that
      sets `animation: none` on the emblem (disables `candleFlicker`).

### `theme/void` — Crimson Void (worktree `H:\Claude\dnd-claude-void`)
> Authority = README token table + `reference/Theme Compare Mobile.html`. The desktop
> `Theme Compare.html` Theme-B palette is **STALE/rejected** — desktop = LAYOUT only.
- [ ] Override all **14 standard tokens** in `[data-theme="void"]`: `--bg #06040a`,
      `--surface-1 #0d0810`, `--surface-2 #160a13`, `--surface-3 #200d17`,
      `--gold #b2222d`, `--gold-dim #5a141a`, `--gold-bright #e85257`,
      `--text-primary #e6dee2`, `--text-secondary #a08894`, `--text-muted #6a5260`,
      `--border #2a1620`, `--border-gold #5a1820`, `--red #ff3b3f`, `--green #2a5a1a`.
- [ ] Override `--font-display: 'Orbitron'` and `--font-body: 'Titillium Web'`.
      (`--font-mono` is `:root`-only — do NOT override it.)
- [ ] FX: ember-dust + crimson radial body backdrop.
- [ ] FX: horizontal interlace + hot inner ember on GM bubble.
- [ ] FX: `[GM]` HUD tag (Orbitron 700, faceted clip-path) restyling the SAME
      `<span class="dropcap">` hook (NOT a drop-cap).
- [ ] FX: `emberPulse` 6.5s on the emblem (box-shadow only).
- [ ] FX: chamfered `clip-path` card/button corners (card 16px TL+BR, primary 10px, send 8px).
- [ ] FX: faceted `◤◥◣◢` corner glyphs (`--font-mono`, no bg fill).
- [ ] FX: crimson focus ring (reuses the `--gold` token name).
- [ ] `@media (prefers-reduced-motion: reduce)` scoped to `[data-theme="void"]` that
      sets `animation: none` on the emblem (disables `emberPulse`).

---

## 3. Sync points / merge order (for git-workflow-manager)

- **Serialization point:** `theming-base` — DONE (shared token/`data-theme` refactor).
  Nothing else serializes; the two theme branches are fully parallel.
- **Fan-out:** in progress on `theme/dnd` + `theme/void` (append-only, disjoint regions).
- **Merge-back order (all `--no-ff`, gate between each):**

  ```
  theming-base ──► theme/dnd ──► theme/void ──► master
  ```

  ```powershell
  cd H:\Claude\dnd-claude
  git checkout master
  git merge --no-ff theming-base -m "merge: theming-base (shared refactor)"   # GATE-0
  git merge --no-ff theme/dnd    -m "merge: theme/dnd (Candle-lit Grimoire)"  # GATE-A
  git merge --no-ff theme/void   -m "merge: theme/void (Crimson Void)"        # GATE-B
  ```
  If the void merge conflicts at EOF of `App.css`, **keep BOTH `[data-theme]` blocks
  stacked** (dnd then void), `git add src/App.css`, `git commit`.

- **What "gate" means (must be GREEN before the next merge; run from the merge target):**
  - `npm run build` succeeds (no Vite/Rollup errors).
  - `npx vitest run` (a.k.a. `npm test -- --run`) all green — **both engines pass**:
    the D&D engine tests AND the Star Wars engine tests (`src/lib/genres.js` ids
    `'dnd'`/`'starwars'`; no engine code changed, so these must stay green at every gate).
  - **GATE-0** additionally: `npm run dev` (5173) renders `genre=dnd` **identical to
    pre-refactor** (deliberate no-op base).
  - **GATE-A** additionally: `genre=dnd` shows Theme-A palette + FX in browser.
  - **GATE-B** additionally: `genre=starwars` shows Theme-B palette + FX, AND `genre=dnd`
    still shows Theme-A with NO bleed (see §4).

---

## 4. Convergence & no-bleed verification (post-merge, on `master`)

- **Expected:** `genre=dnd` → Theme-A (Candle-lit) palette + FX;
  `genre=starwars` → Theme-B (Crimson Void) palette + FX
  (`THEME_FOR_GENRE = { dnd:'dnd', starwars:'void' }` sets `<html data-theme>`).
- **No-bleed guarantee:** every FX rule is prefixed with `[data-theme="x"]`, so a theme's
  rules simply do not match when the other theme is active. Confirm by:
  1. `git grep -n "candleFlicker\|emberPulse\|wax-seal\|dropcap" src/App.css` and eyeballing
     that **every** theme rule sits under a `[data-theme="…"]` selector (no bare selectors
     in the APPEND-ONLY ZONE except the uniquely-named `@keyframes`).
  2. In-browser: switch genre dnd ↔ starwars and confirm backdrop/bubble/emblem/corner FX
     swap completely with no residual glyphs, glows, or fonts from the other theme.
- **jsdom caveat:** `color-mix(in oklab,…)` and `clip-path` do NOT render in jsdom.
  Automated tests assert **structure only** (e.g. the right classes/attributes/`data-theme`
  present); the **final visual check is manual, in a real browser** on each genre.

---

## 5. Failure handling

### A worker violated the contract (touched a forbidden region)
- **Detect** (run in the worker's worktree before its gate):
  ```powershell
  # any change outside src/App.css → violation
  git diff --name-only theming-base..HEAD              # MUST list only: src/App.css
  # any edit above the APPEND-ONLY ZONE / to the other block → violation
  git diff theming-base..HEAD -- src/App.css           # inspect: all hunks at/after the ZONE,
                                                        # all selectors prefixed [data-theme="x"]
  ```
- **Remedy:** revert only the offending hunk(s) on the worker's branch BEFORE merging
  (`git checkout -p theming-base -- <file>` for stray files; `git restore -p`/manual edit
  for in-ZONE strays), re-run the gate, then merge. Do not "fix it during merge."

### A worker's branch fails its build/test gate
- **Do NOT merge it.** Return the branch to the worker for fix; the unaffected branch may
  still merge on schedule. `master` stays releasable at every step — a failing theme branch
  never lands. If a regression is only discovered post-merge, prefer reverting that single
  `--no-ff` merge commit over hot-patching.

---

## 6. State tracker (orchestrator updates as work completes)

| Branch | Role | Status | Gate |
|--------|------|--------|------|
| `theming-base` | Shared token + `data-theme` refactor (serialization point) | DONE — committed | PASS (no-op refactor verified) |
| `theme/dnd` | Worker A — Candle-lit Grimoire (`dnd-claude-dnd`, 5174) | _<pending / in-progress / ready>_ | _<not-run / PASS / FAIL>_ |
| `theme/void` | Worker B — Crimson Void (`dnd-claude-void`, 5175) | _<pending / in-progress / ready>_ | _<not-run / PASS / FAIL>_ |
| `master` | Merge target / release | _<base-merged / dnd-merged / void-merged / converged>_ | _<not-run / GATE-0 / GATE-A / GATE-B PASS>_ |

> Status legend: `pending` (not started) · `in-progress` · `ready` (deliverable
> checklist §2 complete, awaiting gate) · `DONE`. Gate legend: `not-run` · `PASS` · `FAIL`.
