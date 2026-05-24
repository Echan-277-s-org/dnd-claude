> ⛔ **SUPERSEDED 2026-05-23.** Folded into the design handoff. The candle-lit
> palette (Phase 2) and FX (Phase 5) here **still match** Theme A in
> `../design-handoff/README.md` — but that README is now the single source of
> truth (it also carries the expanded scope: theme toggle, `--font-mono`, dice
> verdicts, mobile party strip). Reconciled index: `../THEMING-OVERVIEW.md`. Kept
> for history only — do not implement from this file.

# D&D Theming Plan

Plan for elevating the **D&D (5e / dark-fantasy)** genre mode from "the unstyled
default" into a deliberately-themed **candle-lit tome** look — the sibling of
`STARWARS-THEMING-PLAN.md`. **Nothing in Phases 1–5 is applied yet** — this is
the blueprint.

> **Authored 2026-05-23** against `master`, grounded in the current `App.css`
> (line numbers verified). Today the D&D genre renders on the bare `:root`
> default: dark leather-brown surfaces, `--gold` accents, Cinzel + Crimson Pro,
> a faint SVG-noise body texture. It already *reads* as D&D — this plan commits
> to it: warmer candlelight, parchment-grained bubbles, illuminated drop-caps,
> and wax-seal / rune accents, all scoped so they never touch Star Wars.

## Decisions locked (defaults)

- **Direction: candle-lit tome.** Refine the current dark+gold base; don't pivot
  to light parchment or dungeon-stone. Keep `--gold` (`#c9a84c`) as the anchor.
- **Mechanism: explicit `[data-theme="dnd"]`.** D&D becomes its own scoped theme
  (not "attribute absent"), so each genre owns its FX with zero bleed. **This
  changes one assumption in the Star Wars plan — see "Cross-plan coordination."**
- Accent stays gold; secondary accents: **wax-red** (`--red` `#8b1a1a`) and a
  **rune-glow** (gold at higher alpha). No new hues introduced.

## Why this is low-risk

`App.css` is built on CSS custom properties (`--bg`, `--gold`, `--surface-1`,
`--text-primary`, …) in `:root` (L1-19), and ~80% of the UI reads them via
`var(...)`. The candle-lit refinement is mostly **a refined set of values for the
same tokens**, scoped under `[data-theme="dnd"]`. The genre-specific *effects*
(parchment grain, drop-cap, candle flicker) are additive rules scoped to the same
attribute, so Star Wars — which only overrides token *values* — never inherits
them.

**Touched files (all phases):** `src/App.css`, `src/App.jsx`,
`src/components/ApiKeySetup.jsx`, `index.html`. No engine / `genres.js` /
`context.js` changes. `CharacterPanel.jsx` / `HistoryPanel.jsx` need **no JSX
edits** — they're already token-driven (their only inline styles are margins).

---

## Phase 1 — Theming mechanism (shared with the SW plan)

The genre is known at runtime (`campaign.genre` in Chat, dropdown in setup) but
not reflected in the DOM. This is the **same root-marker wiring** the SW plan
describes — do it once and both genres benefit. The only difference from the SW
plan: we now treat `dnd` as a *first-class theme value* rather than "no
attribute."

**`App.jsx`** — lift genre selection so theme previews work on the setup screen,
and always set the marker:
- `const [draftGenre, setDraftGenre] = useState(() => localStorage.getItem('dnd_genre') || 'dnd')`.
- `useEffect(() => { document.documentElement.dataset.theme = ready ? campaign.genre : draftGenre }, [ready, campaign.genre, draftGenre])`.
  For the D&D genre this resolves to `data-theme="dnd"` (no longer absent).
- Pass `value={draftGenre}` + `onChange={setDraftGenre}` to `CampaignSetup`;
  `handleSetup` already persists `dnd_genre`, so submit needs nothing extra.

**`ApiKeySetup.jsx`** — replace the internal
`const [genreId, setGenreId] = useState('dnd')` with `value`/`onChange` props
from App (the dropdown at the top of the form already exists).

**`App.css`** — `:root` stays the **genre-neutral fallback** (current values, so
anything unscoped still renders). Add `[data-theme="dnd"] { … }` (Phase 2) and
the existing `[data-theme="starwars"] { … }` as overrides on top of it.

> **Regression baseline shift:** the guard is no longer "attribute absent." It
> becomes **"`data-theme="dnd"` renders identical to today's default"** — which
> holds before Phase 2, and after Phase 2 holds against the *intended* refined
> values. Snapshot the D&D screen before starting so the deltas are deliberate.

---

## Phase 2 — Candle-lit palette (same token names, warmer values)

Add to `App.css`. These nudge the existing dark-leather palette warmer and raise
the candlelight, rather than replacing it wholesale:

```css
[data-theme="dnd"] {
  --bg: #0d0a07;            /* unchanged — near-black vellum */
  --surface-1: #1c1409;     /* was #1a1208 — warmer leather */
  --surface-2: #241809;     /* was #211608 */
  --surface-3: #34250f;     /* was #2e200f — lit page edge */
  --gold: #c9a84c;          /* anchor, unchanged */
  --gold-dim: #846a34;      /* was #7a6230 — slightly warmer */
  --gold-bright: #f0d28a;   /* was #e8c87a — brighter candle flame */
  --text-primary: #ecdcae;  /* was #e8d5a3 — warmer ink-on-vellum */
  --text-secondary: #a88a64;
  --text-muted: #6f5442;
  --border: #3f2d18;
  --border-gold: #644626;   /* was #5a4020 — richer gilt */
  --red: #8b1a1a;           /* wax-seal red, unchanged */
  --green: #2a5a1a;
  --shadow: rgba(0, 0, 0, 0.72);
  /* layout tokens unchanged: --panel-width, --header-height */
}
```

This re-skins the header, bubbles, chips, inputs, dice tray, suggestions, the
character / history panels, the HP bar, and every var-driven button instantly —
all warmer, with a brighter flame highlight. Conservative on purpose: the point
is *commitment*, not a different game. If it reads too subtle, push `--surface-*`
and `--gold-bright` further in a follow-up; the token names won't change.

---

## Phase 3 — Hardcoded-color cleanup (shared with the SW plan)

These spots bypass the tokens, so a theme swap (D&D *or* SW) won't reach them.
Tokenize once in `:root`, override per theme. **This phase is identical to the
SW plan's Phase 3 — do it once and both plans collect the benefit.** *(Line
numbers verified on `master` 2026-05-23.)*

1. **Button gradients** (`.btn-begin` L284 / hover L305, `.send-btn` L1235 /
   hover L1250): introduce `--btn-grad-from` / `--btn-grad-to`. Default
   `#4a3010` / `#6a4818` (today's brown). For D&D, keep those values (or warm to
   `#5a3a14` / `#7a5420` for a brighter gilt). Replace the literal
   `linear-gradient(135deg, #4a3010 0%, #6a4818 100%)` + hover variants.
2. **`body` background** (L23-36; image L27-30): the SVG-noise + dual radial is
   already on-theme for D&D. For a richer tome feel, scope a candlelit variant —
   warmer radial pools, as if lit by a single flame:
   ```css
   html[data-theme="dnd"] body {
     background-image:
       url("data:image/svg+xml,…");              /* keep the existing noise SVG */
       /* plus warmer pools: */
       radial-gradient(ellipse at 30% 18%, rgba(201,168,76,0.07), transparent 55%),
       radial-gradient(ellipse at 72% 82%, rgba(42,26,8,0.55), transparent 55%);
   }
   ```
   (Scope on `html` since `body` is the marker's child, mirroring the SW plan.)
3. **`.setup-container`** (L53; radial L61 + gold stripes L62-68): already brown
   radial + faint gold stripes — on-theme. Optionally warm the radial top toward
   `#241808` and lift the stripe alpha from `0.015` so the parchment weave reads.
4. **`.setup-card` glow** (box-shadow L78 `rgba(201,168,76,0.07)`) and **emblem
   drop-shadow** (L106 `rgba(201,168,76,0.45)`): both are `--gold` hardcoded as
   rgba. Tokenize to `--accent-glow` so the candle warmth is tunable per theme.
5. **Select arrow SVG** (`.form-group select`, ~L175-189): duplicate under
   `[data-theme="dnd"] .form-group select` only if Phase 2's `--gold-dim` change
   makes the baked-in arrow fill look off; otherwise leave it.

**The two rgba literals the SW plan also flags** (same lines, same fix):

6. **Action-suggestion / player-choice buttons** (`.action-suggestions` L1162,
   bg L1186 `rgba(201,168,76,0.06)` + focus glow): tokenize to `--accent-soft` /
   `--focus-glow`. For D&D these stay gold (`rgba(201,168,76,…)`); for SW they
   become cyan. Tokenizing here is what lets *both* themes diverge cleanly.
7. **Char HP-bar glow** (`.char-hp-bar-fill` L628 `rgba(139,26,26,0.5)`) and the
   error-bubble reds (L1046, L223, L745/751, L1119): all `--red` hardcoded. For
   D&D a red glow already reads as a bloodied wound bar — lowest priority, fix
   only if you want full token cohesion.

---

## Phase 4 — Typography (tokenize; largest mechanical edit; own commit)

D&D already uses the right faces (Cinzel display + Crimson Pro body) — so for the
**D&D theme** this phase is purely the **shared tokenization refactor** that the
SW plan needs in order to swap fonts. Doing it here keeps D&D byte-identical
while unlocking SW.

1. **`App.css`** — add to `:root`:
   `--font-display: 'Cinzel', serif; --font-body: 'Crimson Pro', Georgia, serif;`
   The `[data-theme="dnd"]` block inherits these (no override needed); the SW
   block overrides to Orbitron / Titillium.
2. Find/replace the **31 literals** (verified: 25 `Cinzel` + 6 `Crimson Pro`):
   `'Cinzel', serif` → `var(--font-display)`, `'Crimson Pro', …` →
   `var(--font-body)`, plus `body { font-family }` at L24.
3. **`index.html`** still has only the single Cinzel+Crimson `<link>` (L10) — no
   change needed for D&D. (The SW plan adds its second Google Fonts link here.)
4. *Optional D&D flourish:* if you want a more decorative display face for D&D
   headers specifically, override `--font-display` inside `[data-theme="dnd"]`
   only (e.g. a blackletter/uncial like `'UnifrakturCook'` or `'IM Fell English'`)
   and add that `<link>`. Headers only — body stays Crimson Pro for readability.
   Skip unless desired; Cinzel is already strong.

---

## Phase 5 — Candle-lit polish FX (additive, all scoped to `[data-theme="dnd"]`)

The D&D analog of the SW plan's hologram/saber FX. Each rule is scoped so Star
Wars never sees it.

1. **Parchment grain on the GM bubble** — a faint fibrous wash over the existing
   `inset` glow (L1030):
   ```css
   [data-theme="dnd"] .dm-bubble {
     background-image: repeating-linear-gradient(
       102deg, rgba(201,168,76,0.018) 0 3px, transparent 3px 7px);
   }
   ```
2. **Illuminated drop-cap** on the GM's first paragraph. Note `.dm-bubble::before`
   is **already taken** (gold top-border accent, L1034) — target the text instead:
   ```css
   [data-theme="dnd"] .dm-bubble .message-content p:first-child::first-letter {
     font-family: var(--font-display);
     font-size: 2.6em;
     line-height: 0.8;
     float: left;
     margin: 4px 8px 0 0;
     color: var(--gold-bright);
     text-shadow: 0 0 10px rgba(201,168,76,0.4);
   }
   ```
3. **Candle-flicker** on the setup emblem (L102-107) — a slow, subtle glow pulse
   on the existing `drop-shadow`, scoped + `prefers-reduced-motion`-guarded:
   ```css
   @media (prefers-reduced-motion: no-preference) {
     [data-theme="dnd"] .setup-emblem { animation: candle 4s ease-in-out infinite; }
     @keyframes candle {
       0%,100% { filter: drop-shadow(0 0 16px rgba(201,168,76,0.45)); }
       50%     { filter: drop-shadow(0 0 22px rgba(201,168,76,0.6)); }
     }
   }
   ```
4. **Rune-glow focus ring** — tokenize the hardcoded `.message-input:focus` ring
   (L1223 `rgba(201,168,76,0.25)`) to `--focus-glow` (shared with Phase 3.6;
   tokenize once, reuse). For D&D keep it gold; warm/brighten if you want the
   "spell taking hold" feel.
5. **Wax-seal accent** *(optional)* — the setup card already has `✦` corner marks
   (`::before`/`::after`, L82-95). For a sealed-letter touch, swap the bottom-right
   glyph to a wax-seal motif (`✶`/`❧`) in red under `[data-theme="dnd"]`. Cosmetic,
   lowest priority.

---

## Cross-plan coordination (read before starting)

Choosing explicit `[data-theme="dnd"]` touches **one assumption in
`STARWARS-THEMING-PLAN.md`**:

- That plan's Phase 1 already sets
  `document.documentElement.dataset.theme = campaign.genre`, which for the D&D
  genre yields `data-theme="dnd"` — so the *wiring* is identical and shared.
- The only stale bit is the SW plan's framing that **"D&D = attribute absent"**
  (its "Why this is low-risk" para and the regression-guard note at its end).
  Update those two spots to **"D&D = `data-theme="dnd"`; `:root` is the
  genre-neutral fallback."** No code in the SW plan changes — just that note.
- **Phases 3 and 4 here are the same shared refactors as the SW plan's Phases 3
  and 4.** Whichever plan ships first does them; the other plan then only adds
  its per-theme override values. Don't do them twice.

---

## Commit sequencing (on `master`)

1. `Phase 1+2: data-theme mechanism + candle-lit D&D palette` — biggest payoff,
   safe stop-point. (If the SW plan already landed Phase 1, this is just the
   `[data-theme="dnd"]` palette block.)
2. `Phase 3: tokenize hardcoded colors + candlelit body` — shared with SW.
3. `Phase 4: tokenize fonts` — shared with SW; D&D stays byte-identical.
4. `Phase 5: parchment/drop-cap/candle polish FX` — D&D-scoped.

Each commit is independently shippable. Because the D&D-specific FX live under
`[data-theme="dnd"]`, Star Wars rendering is unaffected by Phases 2 and 5.

**Effort:** Phase 1+2 ≈ 30–40 min for ~80% of the look (less if SW already did
Phase 1). Phases 3–5 ≈ another 1–1.5 hr, mostly Phase 4's 31-literal swap (shared
cost with SW).

## Notes / gotchas for whoever resumes

- All work is in the single `master` tree (`H:\Claude\dnd-claude`); `npm run dev`
  on `:5173` as normal.
- Verify with `npm run build` **and** `npm test -- --run` — confirms both genre
  engines and rendering are untouched.
- Favicon/`<title>` in `index.html` are static HTML and can't react to runtime
  genre; leave the generic `D&D Campaign Assistant` / `⚔` favicon.
- `.dm-bubble::before` is **already in use** (Phase 5.2) — drop-caps must use
  `::first-letter` on the paragraph, not the bubble's pseudo-element.
- Regression guard (post-shift): with `[data-theme="dnd"]` set, the D&D screen
  must match its pre-Phase-2 snapshot up to the *intended* palette deltas. After
  each phase, confirm Star Wars (`data-theme="starwars"`) is unchanged.
