> ⛔ **SUPERSEDED 2026-05-23.** The Star Wars / holo-cyan direction was dropped.
> Theme B is now **Crimson Void** (`[data-theme="void"]`, crimson `#b2222d`) — an
> original, de-branded aesthetic. Source of truth: `../design-handoff/README.md`;
> reconciled index: `../THEMING-OVERVIEW.md`. Kept for history only — do not
> implement from this file.

# Star Wars Theming Plan

Plan for theming the **Star Wars (d20 / Saga Edition)** genre mode. Captured to be
resumed later. **Nothing in Phases 1–5 is applied yet** — this is the blueprint.

> **Revalidated 2026-05-23** against `master`, after the `ui-overhaul` and
> `context optimization` branches were merged in. The plan still holds; line
> numbers, the Phase 1 wiring, and two new Phase 3 items were corrected below.
> Headline: ui-overhaul's new panels (character / history / inline editor) are
> token-driven (53 `var(--…)` refs, 1 hardcoded color), so **Phase 2 re-skins
> them for free** — the merge *strengthened* this plan.

## Where things stand

- Now on `master`. The `starwars-mode` worktree/branch was merged and removed
  (Star Wars mode at `b9919c5`, this doc at `c800ca2`, merge at `a0c7433`).
- Star Wars **mode** is already built and committed (`b9919c5`): a genre toggle
  swaps the prompt engine + UI strings on `campaign.genre`.
  - `src/lib/context.starwars.js` — Game Master persona + Saga-tuned `extractEntities`; reuses `trimContext`.
  - `src/lib/genres.js` — registry binding each genre's engine to UI strings, starter prompts, action suggestions.
  - `ApiKeySetup.jsx` / `App.jsx` / `Chat.jsx` — select on genre.
- **No visual theming yet** — Star Wars currently renders on the existing
  dark-fantasy theme (gold + Cinzel/Crimson Pro). This doc is the theming work.

## Why this is low-risk

`App.css` is built on CSS custom properties (`--bg`, `--gold`, `--surface-1`,
`--text-primary`, …) in `:root`, and ~80% of the UI reads them via `var(...)`.
A theme is mostly **a second set of values for the same variables**, scoped under
a `[data-theme="starwars"]` attribute. `:root` is the genre-neutral fallback, so
anything Star Wars doesn't override renders identically to the base. The
ui-overhaul panels added since this was written follow the same discipline (53
`var(--…)` refs in the new section, see Phase 2).

> **Note (updated 2026-05-23):** the companion `DND-THEMING-PLAN.md` makes D&D an
> explicit `[data-theme="dnd"]` theme rather than "attribute absent." Phase 1's
> wiring below is unchanged and shared — `dataset.theme = campaign.genre` already
> yields `data-theme="dnd"` for the D&D genre. Whichever plan ships first lands
> the shared Phase 1 mechanism + Phase 3/4 tokenization; the other only adds its
> per-theme override values.

**Touched files (all phases):** `src/App.css`, `src/App.jsx`,
`src/components/ApiKeySetup.jsx`, `index.html`. No engine / `genres.js` /
`context.js` changes needed. The new `CharacterPanel.jsx` / `HistoryPanel.jsx`
need **no JSX edits** — their only inline styles are margins, not colors.

## Decisions locked (defaults)

- Accent direction: **Rebel holo-cyan**. Alts: Sith (`--gold` → `#e23b2f`), Imperial (`--gold` → `#9aa6b8`).
- Fonts: **Orbitron** (display) + **Titillium Web** (body). Softer alt for headers: **Saira**.

---

## Phase 1 — Theming mechanism

The genre is known at runtime (`campaign.genre` in Chat, dropdown in setup) but
not reflected in the DOM. Add one root marker:

> **Adapted for current `App.jsx`** (the merged optimization added persistence
> the original snippet predates): `ready` is now a flag from
> `localStorage('dnd_setup_done')` (L29); `campaign.genre` persists via
> `localStorage('dnd_genre')` (read L31, written in `handleSetup` L41); and
> `CampaignSetup` is rendered with **only** `onSetup` (L56) — `genreId` lives
> inside it as `useState('dnd')`.

**`App.jsx`** — lift genre selection so the theme previews live on setup:
- `const [draftGenre, setDraftGenre] = useState(() => localStorage.getItem('dnd_genre') || 'dnd')` (matches the new persistence; falls back to `campaign.genre`).
- `useEffect(() => { document.documentElement.dataset.theme = ready ? campaign.genre : draftGenre }, [ready, campaign.genre, draftGenre])`.
- Pass `value={draftGenre}` + `onChange={setDraftGenre}` to `CampaignSetup`. `handleSetup` already persists `dnd_genre`, so on submit nothing extra is needed.

**`ApiKeySetup.jsx`** — replace the internal `const [genreId, setGenreId] = useState('dnd')` with `value`/`onChange` props from App (the dropdown at the top of the form already exists).

**`App.css`** — keep `:root` as default (D&D); add an empty `[data-theme="starwars"] { … }` for Phase 2.

---

## Phase 2 — Star Wars palette (same token names, new values)

Add to `App.css`:

```css
[data-theme="starwars"] {
  --bg: #05070d;
  --surface-1: #0c1019;
  --surface-2: #121826;
  --surface-3: #1b2334;
  --gold: #3fa9d4;          /* holo-cyan accent */
  --gold-dim: #2a6b86;
  --gold-bright: #8fd9f2;
  --text-primary: #d4dcea;
  --text-secondary: #8fa0bb;
  --text-muted: #5a6a82;
  --border: #232c3c;
  --border-gold: #35506a;   /* steel-blue accent border */
  --red: #b3231f;           /* blaster red */
  --green: #1f6a3a;
  --shadow: rgba(0, 0, 0, 0.75);
}
```

Re-skins header, bubbles, chips, inputs, dice tray, suggestions, and any
var-driven button instantly — **plus** the ui-overhaul additions: the character
panel, history panel, inline-stat editor, and HP bar (all token-driven). All 14
color tokens above still exist in `:root`; the 2 tokens the overhaul added
(`--panel-width`, `--header-height`) are layout-only, so nothing new to override.

---

## Phase 3 — Hardcoded-color cleanup

Tokenize the spots that bypass vars, then override per theme. *(Line numbers
verified on `master` 2026-05-23.)*

1. **Button gradients** (`.btn-begin` L283/hover L302, `.send-btn` L1234/hover L1247): introduce `--btn-grad-from`/`--btn-grad-to`. Default `#4a3010`/`#6a4818`; SW `#123247`/`#1d5070`. Replace the gradient literals + `:hover` variants.
2. **`body` background** (L23-30): starfield variant — scope on `html` since `body` is the marker's child:
   ```css
   html[data-theme="starwars"] body {
     background-color: #05070d;
     background-image:
       radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.5), transparent),
       radial-gradient(1px 1px at 70% 60%, rgba(255,255,255,0.35), transparent),
       radial-gradient(2px 2px at 40% 80%, rgba(143,217,242,0.4), transparent),
       radial-gradient(ellipse at 30% 18%, rgba(40,107,134,0.15), transparent 60%),
       radial-gradient(ellipse at 75% 78%, rgba(20,30,60,0.45), transparent 55%);
   }
   ```
3. **`.setup-container`** (L53; radial + stripes at L61-62): override brown radial + gold stripes with dark-space gradient + faint cyan stripes.
4. **Select arrow SVG** (`.form-group select` L175-189): duplicate under `[data-theme="starwars"] .form-group select` with fill `%232a6b86`.
5. **Dice crit/fumble + error text** (locations shifted — `grep` for the literal greens/reds): optional — tokenize to `--crit`/`--fumble` for full cohesion.

**New since the ui-overhaul** — two gold/red rgba literals that bypass the tokens
and therefore *won't* follow the cyan swap:

6. **Action-suggestion / player-choice buttons** (`.action-suggestions` block, bg ~L1186 + glow ~L1223): `rgba(201,168,76,0.06)` background and `rgba(201,168,76,0.25)` glow are `--gold` hardcoded as rgba. Tokenize to `--accent-soft` / `--focus-glow`; SW = a cyan equivalent (`rgba(63,169,212,…)`).
7. **Char HP-bar glow** (`.char-hp-bar-fill` ~L628): `rgba(139,26,26,0.5)` = `--red` hardcoded. Lowest priority — a red glow already reads as blaster-red, so leave it unless you want full cohesion.

---

## Phase 4 — Typography (largest mechanical edit; own commit)

1. **`index.html`** — add a second Google Fonts link:
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700&family=Titillium+Web:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet" />
   ```
2. **`App.css`** — add to `:root`: `--font-display: 'Cinzel', serif; --font-body: 'Crimson Pro', Georgia, serif;`
   and to the SW block: `--font-display: 'Orbitron', sans-serif; --font-body: 'Titillium Web', system-ui, sans-serif;`
3. Find/replace the 31 literals (verified: 25 `Cinzel` + 6 `Crimson Pro`): `'Cinzel', serif` → `var(--font-display)`, `'Crimson Pro', …` → `var(--font-body)`, plus `body { font-family }` (~L24). `index.html` still has only the single Cinzel+Crimson `<link>` (L10), so step 1's link is purely additive.
4. Orbitron is wide/techy → headers only; body uses Titillium. If headers feel too sci-fi, swap Orbitron → Saira.

---

## Phase 5 — Polish FX (additive, all scoped to the theme)

1. **Hologram scanlines** on the GM bubble:
   ```css
   [data-theme="starwars"] .dm-bubble {
     background-image: repeating-linear-gradient(0deg, rgba(143,217,242,0.03) 0 2px, transparent 2px 4px);
   }
   ```
2. **Saber-glow focus** — tokenize the hardcoded focus ring (`.message-input:focus` L1220) to `--focus-glow`; SW = `rgba(63,169,212,0.3)`. Note this shares `--focus-glow` with Phase 3.6's suggestion-button glow — tokenize once, reuse.
3. **Starfield** — folded into Phase 3.2 (do here if Phase 3's body work is skipped).

---

## Commit sequencing (on `master`)

1. `Phase 1+2: data-theme mechanism + Star Wars palette` — biggest payoff, safe stop-point
2. `Phase 3: tokenize hardcoded colors + starfield bg`
3. `Phase 4: tokenize fonts + Star Wars type` — largest diff
4. `Phase 5: hologram/saber polish FX`

Each commit is independently shippable; D&D never has `data-theme="starwars"` on the root, so it stays byte-identical.

**Effort:** Phase 1+2 ≈ 30–40 min for ~80% of the look. Phases 3–5 ≈ another 1–1.5 hr (+~5 min for Phase 3's two new rgba literals), mostly Phase 4's literal-swapping.

## Notes / gotchas for whoever resumes

- All work is now in the single `master` tree (`H:\Claude\dnd-claude`); the
  isolated worktree is gone, so just `npm run dev` on `:5173` as normal — the
  old "different port / don't restart the server / symlinked node_modules" notes
  no longer apply.
- Verify with `npm run build` **and** `npm test -- --run` (108 tests as of the
  merge) — confirms D&D rendering and the genre engines are untouched.
- Favicon/`<title>` in `index.html` are static HTML and can't react to runtime genre; leave generic.
- Regression guard: `:root` is the genre-neutral fallback, and Star Wars only
  overrides token values + adds theme-scoped rules — so the D&D path (now
  `data-theme="dnd"`, per `DND-THEMING-PLAN.md`) is never touched by this plan's
  changes. After each phase, confirm the D&D path still renders identically.
