# Handoff: Tabletop Chat Assistant — Dual-Theme

## Overview

A tabletop RPG / sci-fi chat assistant. A Game-Master interacts with one or more players in a chat-style flow that includes dice rolls, action suggestions, and a live character/party HUD. The app ships with **two switchable themes** built from one shared markup and a CSS-custom-property token system — selecting a theme is just `[data-theme="dnd"]` vs `[data-theme="void"]` on the root `.app` element.

Two screens per theme:

1. **Setup** — choose a genre, name the campaign, write a brief, hit "Begin / Execute."
2. **Chat** — header with party HUD + scrolling messages (GM bubbles, player bubbles, dice-roll chips, action suggestions) + composer.

Both themes share **identical token names** (`--bg`, `--surface-1/2/3`, `--gold`, `--gold-dim`, `--gold-bright`, `--text-primary/secondary/muted`, `--border`, `--border-gold`, `--red`, `--green`, `--font-display`, `--font-body`). In Theme A "gold" is literal gold; in Theme B it's "crimson primary" — the names stay so the CSS doesn't have to fork.

## About the Design Files

The files in `reference/` are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy verbatim. The task is to **recreate these designs in the target codebase's existing environment** (React + CSS modules / styled-components / Tailwind / whatever the host app uses), reusing the codebase's component primitives where they exist. If no environment exists yet, React + plain CSS modules is the most direct match for the prototype's structure.

The token-driven approach (`var(--gold)`, `[data-theme="…"]` selector) maps 1:1 to a real `App.css` and should be carried over as-is — it's the same approach the prototypes use.

## Fidelity

**High-fidelity.** The mocks specify final colors (hex values below), final typography (Google Fonts), final spacing, and theme-scoped FX. Implement pixel-perfectly. The only thing that's intentionally placeholder is the **emblem glyph** in Setup (`⚔` for Theme A, `◆` for Theme B) — these are stand-ins; replace with the real brand mark or commissioned illustration when available.

## Themes

### Theme A — Candle-lit Grimoire (`data-theme="dnd"`)

Mood: dark, warm, candle-lit medieval spellbook. Dark leather + gilt + flame.

| Token            | Value     |
| ---------------- | --------- |
| `--bg`           | `#0d0a07` |
| `--surface-1`    | `#1c1409` |
| `--surface-2`    | `#241809` |
| `--surface-3`    | `#34250f` |
| `--gold`         | `#c9a84c` |
| `--gold-dim`     | `#846a34` |
| `--gold-bright`  | `#f0d28a` |
| `--text-primary` | `#ecdcae` |
| `--text-secondary` | `#a88a64` |
| `--text-muted`   | `#6f5442` |
| `--border`       | `#3f2d18` |
| `--border-gold`  | `#644626` |
| `--red`          | `#8b1a1a` (wax-seal) |
| `--green`        | `#2a5a1a` |
| `--font-display` | `'Cinzel'` (Google Fonts, weights 500/600/700) |
| `--font-body`    | `'Crimson Pro'` (Google Fonts, weights 400/500/600 + italic 400) |

**Theme-scoped FX:**

- **Body / setup / messages backdrop**: warm radial candlelight pools + subtle vellum noise. Recipe:
  ```css
  background:
    radial-gradient(circle at 12% 6%, color-mix(in oklab, var(--gold) 36%, transparent) 0%, transparent 50%),
    radial-gradient(circle at 88% 100%, color-mix(in oklab, #2a0c00 75%, transparent) 0%, transparent 60%),
    url("data:image/svg+xml;utf8,<svg…feTurbulence baseFrequency='0.9'…>");
  mix-blend-mode: screen;
  opacity: 0.55;
  ```
- **GM bubble**: faint diagonal parchment-grain wash over an inset gold glow.
  ```css
  background: repeating-linear-gradient(135deg, rgba(201,168,76,0.08) 0 2px, transparent 2px 6px), var(--surface-2);
  box-shadow: inset 0 0 50px -10px color-mix(in oklab, var(--gold) 24%, transparent), inset 0 1px 0 rgba(255,255,255,0.05);
  ```
- **GM bubble's first paragraph**: **illuminated drop-cap**. `font-family: var(--font-display)`, ~2.8em, `color: var(--gold-bright)`, `text-shadow: 0 0 14px color-mix(in oklab, var(--gold) 55%, transparent)`, `float: left`, `padding: 6px 10px 0 0`.
- **Setup emblem**: slow `candleFlicker` 6s ease-in-out animation on `box-shadow` only (peak glow softened from initial spec — the 3.6s/full-bright version reads as a loading spinner).
  ```css
  @keyframes candleFlicker {
    0%, 100% { box-shadow: 0 0 22px -2px color-mix(in oklab, #c9a84c 45%, transparent); }
    50%      { box-shadow: 0 0 26px -2px color-mix(in oklab, #f0d28a 45%, transparent); }
  }
  ```
  **Reduced-motion**: disable the animation.
- **Focus rings & button gradients**: warm gold rune-glow.
  - Focus ring: `border-color: var(--gold); box-shadow: 0 0 0 3px color-mix(in oklab, var(--gold) 28%, transparent);`
  - Button bg: `linear-gradient(180deg, color-mix(in oklab, var(--gold) 32%, var(--surface-3)), color-mix(in oklab, var(--gold-dim) 35%, var(--surface-2)))`.
- **Card corners**: crimson wax-seal discs with a gilt `✦` glyph. Each corner is a 22px circle with a radial-gradient red fill and a 1px crimson rim. Glyph is `var(--font-display)`, 10–11px, `var(--gold-bright)` with subtle text-shadow.

### Theme B — Crimson Void (`data-theme="void"`)

Mood: cold deep-space, dark-order villain, crimson embers, faceted angular HUD. Original aesthetic — not a recreation of any branded property.

| Token            | Value     |
| ---------------- | --------- |
| `--bg`           | `#06040a` |
| `--surface-1`    | `#0d0810` |
| `--surface-2`    | `#160a13` |
| `--surface-3`    | `#200d17` |
| `--gold`         | `#b2222d` (crimson primary) |
| `--gold-dim`     | `#5a141a` |
| `--gold-bright`  | `#e85257` (ember) |
| `--text-primary` | `#e6dee2` |
| `--text-secondary` | `#a08894` |
| `--text-muted`   | `#6a5260` |
| `--border`       | `#2a1620` |
| `--border-gold`  | `#5a1820` (blood-line) |
| `--red`          | `#ff3b3f` (alert / crit) |
| `--green`        | `#2a5a1a` |
| `--font-display` | `'Orbitron'` (Google Fonts, weights 500/600/700/800) |
| `--font-body`    | `'Titillium Web'` (Google Fonts, weights 300/400/600/700) |

**Theme-scoped FX:**

- **Backdrop**: sparse ember dust + slow crimson radial pools. ~8 tiny radial-gradient dots at 0.4–1.2px sizes; `opacity: 0.72`.
- **GM bubble**: faint horizontal interlace + hot inner ember.
  ```css
  background:
    repeating-linear-gradient(0deg, rgba(178,34,45,0.06) 0 1px, transparent 1px 3px),
    radial-gradient(120% 80% at 0% 0%, color-mix(in oklab, var(--gold) 10%, var(--surface-2)) 0%, var(--surface-2) 60%);
  box-shadow:
    inset 0 0 30px -10px color-mix(in oklab, var(--gold) 22%, transparent),
    0 0 14px -10px color-mix(in oklab, var(--gold) 40%, transparent);
  ```
- **GM bubble drop-cap replacement**: instead of an illuminated cap (doesn't fit holo / faceted look), render `[GM]` as a HUD tag — Orbitron weight 700, 0.78em, `var(--gold-bright)`, 1px gold border, faceted clip-path corners, slight ember-tinted background.
- **Emblem**: `emberPulse` 6.5s ease-in-out, breathing box-shadow only.
- **Card / button corners**: chamfered via `clip-path`. Setup card uses 16px chamfer on TL+BR; the primary button uses 10px; send button 8px.
- **Corner accents** (replacing wax seals): faceted triangle glyphs `◤◥◣◢` in `--font-mono`, 12px, `color: var(--gold)`, `text-shadow: 0 0 6px color-mix(in oklab, var(--gold) 55%, transparent)`. No background fill.
- **Focus rings**: same `box-shadow: 0 0 0 3px color-mix(in oklab, var(--gold) 28%, transparent)` — the gold token name is reused.

## Fonts (Google Fonts URL)

```
https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400&family=Orbitron:wght@500;600;700;800&family=Titillium+Web:wght@300;400;600;700&family=JetBrains+Mono:wght@400;500&display=swap
```

JetBrains Mono is used for `--font-mono` (timestamps, stat values, small machine-feeling labels).

## Screens

### Setup

**Purpose**: Spin up a new campaign/operation. Genre → name → details → begin.

**Layout (desktop)**: centered card on a textured background. Card: `min(440px, 100%)` wide, ~38px vertical padding, `border: 1px solid var(--border-gold)`, `border-radius: 8px` (Theme A) / clip-path chamfer (Theme B). 1px gold inner rule inset 8px from the edge. Four corner-accent positions (`tl`/`tr`/`bl`/`br`).

**Components, top→bottom**:

1. **Emblem** — 92px circle (mobile 78px), bordered, with a radial fill, a small inset glow, and a dashed orbit-ring `-8px` outset. Glyph in `--font-display`, 42px (mobile 34px), `var(--gold-bright)`. **Placeholder glyph** — replace with brand mark.
2. **Eyebrow** — `Cinzel` 10px, letter-spacing 0.3em, uppercase, `var(--gold-dim)`. Example copy: "Begin a saga" / "// Sealed Directive".
3. **Title** — `Cinzel` 28px (mobile 22px), letter-spacing 0.08em, uppercase, `var(--gold-bright)`.
4. **Subtitle** — body font, 14px italic, `var(--text-secondary)`.
5. **Genre select** — appearance-none, 1px border, 4px radius, 14px text, custom dropdown chevron drawn via two `linear-gradient` background-images.
6. **Campaign name input** — same chrome as the select. **Show this field in a focused state** in the static mock so the focus ring is visible at rest.
7. **Details textarea** — 70px min-height, resize vertical (desktop) / none (mobile).
8. **Primary button** — full-width, gold gradient, `Cinzel` 14px, letter-spacing 0.18em, uppercase, with a `›` arrow. Theme B clips the corners (10px). Min-height 44pt on mobile.

**Field labels**: `--font-display`, 10px, letter-spacing 0.22em, uppercase, `var(--text-secondary)`. Optional `<span class="hint">` to the right of the label is body-font italic, lowercase, `var(--text-muted)`.

### Chat

**Purpose**: Run the session. GM narrates, players respond, dice roll, suggested actions appear.

**Layout (desktop)**: `grid-template-columns: 144px 1fr 168px`, `grid-template-rows: auto 1fr auto`. Three columns: history panel (left), messages (center), character HUD (right). Header spans all columns; composer spans all columns.

**Layout (mobile)**: single column. Side panels collapse. **Locked decision: party HUD becomes a 3-cell strip pinned under the header**; history is reached via a back-button (the title row's left "Sagas" / "Ops" link). Character sheet becomes a swipe-up drawer (peeked state shown in the mobile reference for visual guidance, but the actual implementation can keep the drawer closed at rest and reveal on drag).

**Header**:

- Left: app title in display font, 13–14px, uppercase, with a live-status dot (8px circle, `var(--gold)`, with a `0 0 10px var(--gold)` glow) before it.
- Center crumb: "Session III · Sablewatch Inn" / "Phase 03 · Blacksite Veyra" — body font, italic, `var(--text-secondary)`.
- Right: turn-pill (`◌ Aelis' turn`) + icon buttons. Turn-pill is `display: inline-flex`, rounded-full, gold-bright text, `Cinzel` 10px uppercase, with a 6px pulsing dot.
- Icon buttons: 30px square, 4px radius, `var(--surface-3)` bg, hover lifts to gold-bright.

**Party HUD (right panel, desktop)** — sectioned:

- **Identity** — `<h4>` "Aelis · L4 Ranger", portrait slot (96px tall, diagonal stripe placeholder).
- **Stats** — three stat rows: label / value / 4px progress bar. `.warn` variant uses a red→bright gradient on the bar.
- **Carries / Loadout** — chip tags (`.tag-chip`) in mono, 9.5px, surface-2 bg, 1px border.

**History (left panel, desktop)** — `<h4>` "History", list of past sessions with timestamps; current session has accent left border + gold tint. Plus a "Party" / "Wing" sub-section with at-a-glance HP.

**Mobile party strip** — three equal-width cells (`grid-template-columns: 1fr 1fr 1fr`, 8px gap):
```
[ Æ  Aelis        ] [ B  Borin        ] [ V  Vex          ]
[    Ranger·turn  ] [    Cleric       ] [    Rogue        ]
[ ████████░░░░░░░ ] [ █████████████░ ] [ ████████████░░ ]
```
Active cell gets `border-color: var(--border-gold)`, gold-tinted bg, and an inset 2px left border for emphasis.

**Messages list** (center, both layouts):

- `display: flex; flex-direction: column; gap: 14px` (desktop) / `gap: 12px` (mobile).
- **Day-rule divider** — centered uppercase label flanked by hairlines that fade out to transparent.
- **Message row** — flex row with avatar (32px desktop, 26px mobile) + bubble. Player rows are `flex-direction: row-reverse` and right-aligned.
- **GM bubble** — `var(--surface-2)` bg, top border 2px gold, left border 3px gold (the "accent" lines), inner gold glow per theme FX. Meta-row above content: `Game-Master` in `Cinzel` 10px uppercase, `var(--gold)`, followed by `JetBrains Mono` 9.5px `var(--text-muted)` timestamp.
- **Player bubble** — `var(--surface-3)` bg, 1px gold-dim border, meta-row right-aligned.
- **Dice chip** — see below.
- **Actions** — vertical stack of buttons on mobile (full-width, 44pt min, 1px border, `›` prefix), horizontal wrap on desktop. Hover state: gold-tinted bg + gold-bright text.

**Dice chip** (locked: inline, between messages):

```
┌────┐
│ d20│  STEALTH    22    PASS
└────┘
```

- Self-centered pill (rounded-full), `var(--surface-2)` bg, 1px gold-dim border.
- Die tile: **`min-width: 22px` (mobile) / 26px (desktop), `padding: 0 5/6px`** — must flex for "20" vs "d20" labels. 1px gold border, 5–6px radius.
- Check label: `--font-display` 9.5/10.5px, letter-spacing 0.22em, uppercase, `--text-secondary`.
- Result: `--font-display`, 13/15px, `var(--gold-bright)`.
- PASS/FAIL: `--font-mono`, 9/10px, green-tinted on PASS, red on FAIL.

**Composer**:

- Top border `var(--border-gold)`, `var(--surface-2)` bg, ~12px vertical padding.
- Input has a `›` glyph prefix at the left (gold, `Cinzel` 18px).
- Send button: 44×44 (mobile) / inline button (desktop). Gold gradient fill, `var(--gold-bright)` text.

## Interactions & Behavior

- **Tab/click between Setup and Chat** — no animated transition specified; route-level swap is fine.
- **Sending a message** — append to message list (animate: opacity 0→1, translate-y 6px→0, 200ms ease-out).
- **Dice roll** — synthesizes a `.dice-chip` element appended to the message list. No transient banner (decision settled during exploration).
- **Suggested action click** — fills the composer with the action text + sends. Could also just send directly; treat as a normal send.
- **Active player change** — animate strip `.cell.active` reassignment with a 200ms `box-shadow` + `border-color` transition.
- **Theme switch** — flip `data-theme` on `.app`. Use a 200ms transition on `background-color` and `color` only; FX backgrounds swap cut-style. Tokens use `var()` so the cascade does the rest.
- **Reduced motion** — disable `candleFlicker` and `emberPulse`. The candle-flicker in particular has been explicitly slowed and dimmed during design; respect the prefers-reduced-motion query.
- **Focus visible** — every input/textarea/select/button must show the gold focus ring (`box-shadow: 0 0 0 3px color-mix(in oklab, var(--gold) 28%, transparent)`). Inputs additionally swap `border-color` to `var(--gold)`.
- **Keyboard handling on mobile composer** — when the on-screen keyboard appears, the messages region scrolls to keep the latest message in view. Use a `scrollTop = scrollHeight` after layout, NOT `scrollIntoView` (the prototype prohibits it for app-stability reasons and the host app should follow the same convention).

## State Management

- `theme: 'dnd' | 'void'` — global; persist to localStorage; default to `'dnd'` on first run.
- `screen: 'setup' | 'chat'` — route state.
- `setupForm: { genre, name, details }` — local form state until the user clicks Begin.
- `messages: Array<{ kind: 'gm'|'player'|'dice'|'system', author?, text?, dice?: {die, check, result, verdict}, ts }>` — chat log.
- `party: Array<{ id, name, role, hpPct, isActive }>` — drives the party strip on mobile and the history panel + character HUD on desktop.
- `activeCharacter` — drives the right HUD and the turn-pill in the header.
- `suggestedActions: Array<string>` — last GM response can include 0–3 suggestions.

GM responses come from whatever backend the host app uses (OpenAI/Anthropic/etc.); not specified here. Use the host's existing API client.

## Design Tokens (combined)

### Spacing

The design uses a loose 4/6/8/10/12/14/18/22/28-point rhythm. No strict 8-pt grid — paddings on cards (28px), buttons (12–14px vertical), bubbles (10–12px), and form fields (12px) reflect the practical sizes.

### Radii

| Element | Radius |
| --- | --- |
| Setup card (A) | 8px |
| Setup card (B) | 0 + 16px chamfer (clip-path) |
| Inputs / selects / textarea | 4px (desktop) / 6px (mobile) |
| Primary button (A) | 4px |
| Primary button (B) | 0 + 10px chamfer |
| Bubbles | 8px |
| Side-panel list items | 4px |
| Tag chips | 2–4px |
| Phone screen (mock only) | 34px |

### Shadows / Glows (recurring patterns)

- **Card lift**: `0 36px 60px -36px rgba(0,0,0,0.85)` + `inset 0 0 0 1px color-mix(in oklab, var(--gold) 8%, transparent)`.
- **Button rune-glow**: `0 0 22px -6px color-mix(in oklab, var(--gold) 60%, transparent)` + `inset 0 0 0 1px rgba(255,255,255,0.05)`.
- **GM bubble inner glow**: `inset 0 0 50px -10px color-mix(in oklab, var(--gold) 24%, transparent)`.
- **Live status dot**: `0 0 10px var(--gold)`.

### Z-axis

Status bar (mobile mock): 30. Bubble glows: inset. Dice banner sticky: 5. Phone bezel notch: 50. Home indicator: 60. (App content has no internal z-stacking beyond this.)

## Assets

- **Fonts** — all Google Fonts (see URL above). No local font hosting required for prototype-fidelity match.
- **Emblems / corner glyphs** — currently Unicode placeholders: `⚔` (Theme A setup), `◆` (Theme B setup), `✦` (Theme A wax-seal), `◤◥◣◢` (Theme B corners). Replace setup emblems with real brand marks when available.
- **Portrait placeholder** — diagonal stripe pattern in the character-HUD portrait slot (`repeating-linear-gradient` over `var(--surface-3)`). When real character art is available, drop it in.
- **No raster images** are used.

## Mobile Layout Decisions (locked)

These were the explored variations that did NOT make the cut — useful as context for why the chosen direction looks the way it does:

| Decision | Picked | Rejected | Why |
| --- | --- | --- | --- |
| Party header | **3-cell strip** | HP-ring avatar pucks | Three explicit HP bars compare faster than three SVG arcs when fights are active. |
| Dice placement | **Inline chip** | Sticky banner at top of messages | Inline reads as a story beat; banner felt heavier and stayed on screen longer than warranted. |
| Crimson Void contrast | **Toned-down** | Original spec | Original `#c8232e` / `#ff5a5f` + 70% GM glow was too hot on a phone at night. |

The strip-vs-pucks comparison file (`Theme Compare Mobile v2.html`) and earlier sketches are not included in this handoff — only the final direction.

## Files (in this bundle)

- `reference/Theme Compare.html` — desktop reference: Setup + Chat for both themes side-by-side.
- `reference/Theme Compare Mobile.html` — mobile reference: Setup + Chat in iPhone-sized frames for both themes.
- `screenshots/desktop-setup.png` — preview of the Setup screen in both themes (open the HTML for the Chat screen, which doesn't capture cleanly as a single still).
- `screenshots/mobile.png` — preview of all four mobile screens (Setup + Chat × both themes).
- `README.md` — this document.

Open the HTML files in a browser to see the live FX (candle-flicker, ember-pulse, focus rings, hover states) and the desktop Chat layout. Use them as the source of truth when in doubt about a value — they're the same CSS that should be ported.
