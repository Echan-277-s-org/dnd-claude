# Theming Overview — Candle-lit Grimoire & Crimson Void

Reconciled index for the dual-theme effort. **Source of truth is the design
handoff in [`design-handoff/README.md`](./design-handoff/README.md)** (with live
HTML references + screenshots beside it). This file ties that handoff to the
codebase and records what changed from the earlier blueprints.

> Reconciled 2026-05-23 against the `design_handoff_tabletop_chat` bundle produced
> in Claude design. **Status: still a blueprint — nothing is applied to the app yet.**

## The two themes

| Theme | Selector | Direction | `--gold` token |
|-------|----------|-----------|----------------|
| **A — Candle-lit Grimoire** | `[data-theme="dnd"]` | dark leather + gilt + flame | `#c9a84c` (literal gold) |
| **B — Crimson Void** | `[data-theme="void"]` | cold deep-space, dark-order, crimson embers | `#b2222d` (crimson primary) |

Both share **identical token names** so the CSS never forks; only the *values* and
a few theme-scoped FX rules differ. Theme switch = flip `data-theme` on the root.

## What changed from the earlier blueprints (read this)

The handoff revised the prior plan in two ways. The old plan docs are archived in
[`archive/`](./archive/) with superseded banners.

1. **Star Wars → Crimson Void (the pivot).** Theme B was "Star Wars / Saga,
   holo-cyan `#3fa9d4`, `[data-theme="starwars"]`." It is now **Crimson Void** —
   an *original, de-branded* aesthetic: crimson `#b2222d`, `[data-theme="void"]`,
   ember dust, faceted/chamfered `clip-path` HUD, a `[GM]` HUD-tag instead of a
   drop-cap. (Retires `archive/STARWARS-THEMING-PLAN.md`.)
2. **Scope grew past "pure CSS reskin."** The earlier docs promised *no JSX/engine
   changes*. The handoff specifies real markup + state work (see "Scope reality"
   below). Theme A's candle-lit palette/FX are unchanged from
   `archive/DND-THEMING-PLAN.md` — that content was correct; only its framing and
   its Star Wars sibling changed.

## Core architecture (unchanged from before)

- `src/App.css` is built on CSS custom properties in `:root`
  (`--bg`, `--gold`, `--surface-1/2/3`, `--text-primary/secondary/muted`,
  `--border`, `--border-gold`, `--red`, `--green`, + layout tokens). ~80% of the
  UI reads them via `var(...)`.
- A theme = **a new set of values for those same tokens**, scoped under a
  `[data-theme="…"]` attribute on the root `.app`, plus additive theme-scoped FX.
- `:root` stays the **genre-neutral fallback** — anything a theme doesn't
  override renders from base.
- Two new font tokens to add: `--font-display` / `--font-body` (per theme) **and a
  new `--font-mono`** (`JetBrains Mono` — timestamps, stat values, small labels).

## Palettes (full tables live in the handoff)

**Theme A — `[data-theme="dnd"]`:** `--bg #0d0a07` · `--surface-1 #1c1409` ·
`--surface-2 #241809` · `--surface-3 #34250f` · `--gold #c9a84c` ·
`--gold-dim #846a34` · `--gold-bright #f0d28a` · `--text-primary #ecdcae` ·
`--text-secondary #a88a64` · `--text-muted #6f5442` · `--border #3f2d18` ·
`--border-gold #644626` · `--red #8b1a1a` (wax-seal) · `--green #2a5a1a`.
Fonts: **Cinzel** + **Crimson Pro**.

**Theme B — `[data-theme="void"]`:** `--bg #06040a` · `--surface-1 #0d0810` ·
`--surface-2 #160a13` · `--surface-3 #200d17` · `--gold #b2222d` (crimson) ·
`--gold-dim #5a141a` · `--gold-bright #e85257` (ember) · `--text-primary #e6dee2` ·
`--text-secondary #a08894` · `--text-muted #6a5260` · `--border #2a1620` ·
`--border-gold #5a1820` (blood-line) · `--red #ff3b3f` (alert/crit) · `--green #2a5a1a`.
Fonts: **Orbitron** + **Titillium Web**.

> ⚠️ Theme A's values are a *refinement* of today's `:root` (e.g. `--surface-1`
> `#1c1409` vs current `#1a1208`, `--gold-bright` `#f0d28a` vs `#e8c87a`). Applying
> Theme A is a small **deliberate** visual change to D&D, not a no-op.

## Theme-scoped FX (recipes in the handoff)

- **Theme A:** warm radial candlelight pools + vellum noise body wash · parchment-
  grain GM bubble over inset gold glow · **illuminated drop-cap** on the GM's first
  paragraph (`::first-letter` — `.dm-bubble::before` is already taken) ·
  `candleFlicker` 6s glow on the setup emblem · warm gold rune-glow focus ring ·
  crimson **wax-seal** corner discs with a `✦` glyph.
- **Theme B:** ember-dust + crimson radial body backdrop · interlace + hot inner
  ember on GM bubble · **`[GM]` HUD tag** (Orbitron) instead of a drop-cap ·
  `emberPulse` 6.5s on the emblem · **chamfered `clip-path`** card/button corners ·
  faceted `◤◥◣◢` corner glyphs (no fill) · crimson focus ring.

## Scope reality — it's not pure CSS anymore

The handoff needs JSX + state beyond a CSS reskin. Flagged so it isn't underestimated:

- ~~Theme toggle + `localStorage`~~ — **dropped** per the decision below (theme
  follows genre; the genre→theme marker is the only wiring needed).
- **`--font-mono`** (JetBrains Mono) wired into `index.html` + `:root`.
- **Dice chips** carry `{ die, check, result, verdict }` — current messages are
  `{ role: 'dice', die, result }`, so DiceRoller/Chat need `check` + `verdict`.
- **Mobile party strip** (3-cell HP strip pinned under the header), **history
  timestamps** with current-session highlight, **turn-pill** + live-status dot.
- Header/composer/HUD chrome per the handoff's Chat spec.

## DECISION (settled 2026-05-23): theme follows genre

**Theme is driven by `campaign.genre`, not an independent toggle.** Picking the
genre drives both the prompt engine *and* the look; there is no separate theme
control, and the handoff's independent `theme` state + `localStorage` toggle is
**dropped**. (Genre already persists via `dnd_genre`, so no new persistence.)

**Mapping wrinkle (must handle in Phase 1):** the genre ids are `'dnd'` and
`'starwars'` (`src/lib/genres.js`), but the handoff's Theme B selector is
`[data-theme="void"]`. So map genre → theme attribute rather than assigning the
genre id directly:

```js
const THEME_FOR_GENRE = { dnd: 'dnd', starwars: 'void' };
useEffect(() => {
  const genre = ready ? campaign.genre : draftGenre;
  document.documentElement.dataset.theme = THEME_FOR_GENRE[genre] ?? 'dnd';
}, [ready, campaign.genre, draftGenre]);
```

No genre rename, no engine/`genres.js`/`context*.js` changes — the `'starwars'`
genre id and its Saga engine stay; only its *visual* attribute is `void`.

## Build sequence (carried over; still sound)

Do the **shared work once**, then add each theme's additive block:

1. **Shared mechanism** — wire the root `data-theme` marker via the genre→theme
   map (see the decision below) + lift genre selection into `ApiKeySetup.jsx` so
   the setup screen previews the right skin.
2. **Shared refactors** — tokenize the ~6 hardcoded color spots (button gradients,
   card/emblem glow, the two rgba literals, body bg, select-arrow SVG); swap the
   **31 font literals** (25 `Cinzel` + 6 `Crimson Pro` — count verified) to
   `var(--font-display)` / `var(--font-body)`; add `--font-mono` + the expanded
   Google Fonts `<link>` (Cinzel/Crimson Pro/Orbitron/Titillium Web/JetBrains Mono).
3. **Per-theme** — the `[data-theme="dnd"]` and `[data-theme="void"]` palette
   blocks + their scoped FX. Plus the new markup/state from "Scope reality."

Whichever theme ships first lands steps 1–2; the second only adds its block.

## Touched files

`src/App.css`, `src/App.jsx`, `src/components/ApiKeySetup.jsx`, `index.html` — plus,
new vs. the old plan: `Chat.jsx` / `DiceRoller.jsx` (dice verdict + chip), and a
mobile party-strip component. No engine / `genres.js` / `context.js` changes.

## Verify / regression guard

- `npm run dev` on `:5173`; verify with `npm run build` **and** `npm test -- --run`
  (confirms both genre engines + rendering untouched).
- After each phase, confirm the *other* theme still renders identically — FX are
  attribute-scoped, so they shouldn't bleed.
- `color-mix(in oklab,…)` and `clip-path` render in modern browsers but not in
  jsdom — harmless for the test suite, just not visually asserted there.
- Favicon / `<title>` in `index.html` are static and can't react to theme; leave
  the generic `D&D Campaign Assistant` / `⚔`.

## Reference files

- [`design-handoff/README.md`](./design-handoff/README.md) — **source of truth**:
  full token tables, FX recipes, screen specs, state model, locked decisions.
- [`design-handoff/reference/Theme Compare.html`](./design-handoff/reference/Theme%20Compare.html) — desktop, both themes, live FX.
- [`design-handoff/reference/Theme Compare Mobile.html`](./design-handoff/reference/Theme%20Compare%20Mobile.html) — mobile, both themes.
- `design-handoff/screenshots/` — `desktop-setup.png`, `mobile.png`.
- [`archive/`](./archive/) — superseded blueprints (Star Wars, D&D, worktree),
  kept for history only.
