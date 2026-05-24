# Star Wars Theming Plan

Plan for theming the **Star Wars (d20 / Saga Edition)** genre mode. Captured to be
resumed later. **Nothing in Phases 1–5 is applied yet** — this is the blueprint.

## Where things stand

- Branch: `starwars-mode` (isolated worktree at `H:\Claude\dnd-claude-starwars`).
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
a `[data-theme="starwars"]` attribute. D&D = "attribute absent," so D&D rendering
stays byte-identical.

**Touched files (all phases):** `src/App.css`, `src/App.jsx`,
`src/components/ApiKeySetup.jsx`, `index.html`. No engine / `genres.js` /
`context.js` changes (keeps clear of the parallel `context.js` lane on master).

## Decisions locked (defaults)

- Accent direction: **Rebel holo-cyan**. Alts: Sith (`--gold` → `#e23b2f`), Imperial (`--gold` → `#9aa6b8`).
- Fonts: **Orbitron** (display) + **Titillium Web** (body). Softer alt for headers: **Saira**.

---

## Phase 1 — Theming mechanism

The genre is known at runtime (`campaign.genre` in Chat, dropdown in setup) but
not reflected in the DOM. Add one root marker:

**`App.jsx`** — lift genre selection so the theme previews live on setup:
- `const [draftGenre, setDraftGenre] = useState(campaign.genre)`.
- `useEffect(() => { document.documentElement.dataset.theme = ready ? campaign.genre : draftGenre }, [ready, campaign.genre, draftGenre])`.
- Pass `value={draftGenre}` + `onChange={setDraftGenre}` to `CampaignSetup`; on submit, `genreId` already equals `draftGenre`.

**`ApiKeySetup.jsx`** — replace local `genreId` state with `value`/`onChange` props from App (dropdown already exists).

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

Re-skins header, panels, bubbles, chips, inputs, dice tray, suggestions, and any
var-driven button instantly.

---

## Phase 3 — Hardcoded-color cleanup

Tokenize the spots that bypass vars, then override per theme.

1. **Button gradients** (`.btn-begin` ~L284, `.send-btn` ~L1235): introduce `--btn-grad-from`/`--btn-grad-to`. Default `#4a3010`/`#6a4818`; SW `#123247`/`#1d5070`. Replace the gradient literals + `:hover` variants.
2. **`body` background** (~L27-30): starfield variant — scope on `html` since `body` is the marker's child:
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
3. **`.setup-container`** (~L60-69): override brown radial + gold stripes with dark-space gradient + faint cyan stripes.
4. **Select arrow SVG** (~L190): duplicate under `[data-theme="starwars"] .form-group select` with fill `%232a6b86`.
5. **Dice crit/fumble + error text** (~L1110-1122, ~L227): optional — tokenize literal greens/reds to `--crit`/`--fumble` for full cohesion.

---

## Phase 4 — Typography (largest mechanical edit; own commit)

1. **`index.html`** — add a second Google Fonts link:
   ```html
   <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700&family=Titillium+Web:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet" />
   ```
2. **`App.css`** — add to `:root`: `--font-display: 'Cinzel', serif; --font-body: 'Crimson Pro', Georgia, serif;`
   and to the SW block: `--font-display: 'Orbitron', sans-serif; --font-body: 'Titillium Web', system-ui, sans-serif;`
3. Find/replace the ~30 literals: `'Cinzel', serif` → `var(--font-display)`, `'Crimson Pro', …` → `var(--font-body)`, plus `body { font-family }` (~L24).
4. Orbitron is wide/techy → headers only; body uses Titillium. If headers feel too sci-fi, swap Orbitron → Saira.

---

## Phase 5 — Polish FX (additive, all scoped to the theme)

1. **Hologram scanlines** on the GM bubble:
   ```css
   [data-theme="starwars"] .dm-bubble {
     background-image: repeating-linear-gradient(0deg, rgba(143,217,242,0.03) 0 2px, transparent 2px 4px);
   }
   ```
2. **Saber-glow focus** — tokenize the hardcoded focus ring (`.message-input:focus` ~L1223) to `--focus-glow`; SW = `rgba(63,169,212,0.3)`.
3. **Starfield** — folded into Phase 3.2 (do here if Phase 3's body work is skipped).

---

## Commit sequencing (on `starwars-mode`)

1. `Phase 1+2: data-theme mechanism + Star Wars palette` — biggest payoff, safe stop-point
2. `Phase 3: tokenize hardcoded colors + starfield bg`
3. `Phase 4: tokenize fonts + Star Wars type` — largest diff
4. `Phase 5: hologram/saber polish FX`

Each commit is independently shippable; D&D never has `data-theme="starwars"` on the root, so it stays byte-identical.

**Effort:** Phase 1+2 ≈ 30–40 min for ~80% of the look. Phases 3–5 ≈ another 1–1.5 hr, mostly Phase 4's literal-swapping.

## Notes / gotchas for whoever resumes

- Don't restart the dev server on `:5173` if QA/UI testers are live — it serves from the `master` tree, not this worktree. Run this worktree on a different port: `npm run dev -- --port 5174`.
- `node_modules` here is symlinked to `../dnd-claude/node_modules`; `dist/` and `node_modules` are gitignored.
- Verify with `npm run build` in the worktree — doesn't touch the running dev server.
- Favicon/`<title>` in `index.html` are static HTML and can't react to runtime genre; leave generic.
