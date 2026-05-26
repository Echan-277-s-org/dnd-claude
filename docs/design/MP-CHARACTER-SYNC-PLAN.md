# Plan: Per-Player Character Sync in Multiplayer

## Context

Today the character wizard is effectively **host-only**, and the character it builds never reaches
other players or the DM:

- Each player's full sheet lives in local `dnd_character` and is **never synced**.
- The synced party row is only `{ id, name, role, hpPct, isActive }` — no race/class/abilities.
- The AI DM's system prompt gets campaign text but **no player stats**, so it can't reason about
  skill DCs, spell saves, AC, or HP.
- On reconnect, a player's character is lost (server keeps no copy).

**Goal:** each player (host *and* joiner) supplies a character at join time; the server validates,
stores, and persists it; all clients learn every player's character; and the DM is fed a bounded
per-player stat summary (incl. current HP) so it narrates accurately. Scope is **join-time sync + DM
awareness + AI-DM-controlled mid-session stat changes that persist** (e.g. HP loss in a fight).
Out of scope: client-driven self-edits of synced stats (`character:update`), leveling/XP, and
cross-session character persistence — those remain deferred.

Two upstream artifacts drive this and remain authoritative reading for implementers:
- `docs/design/MP-CHARACTER-SYNC-WORKFLOW.md` — orchestration: stages, gates (G-A/G-B/G-C), risks.
- `docs/design/MP-CHARACTER-SYNC-SPEC.md` — full PM spec (data model, protocol, security, test plan).

This plan **supersedes the spec on three points** (verified against the code — see Corrections below).

## Corrections to the spec (verified against current code)

1. **Characters live in a `characters` map keyed by `displayName` — do NOT widen the party row.**
   `applyPartyUpdate` (`src/lib/session.js:54`) rebuilds every party row from the DM's block each
   turn, preserving only `id` by name-match and **dropping all other fields**. Character stats added
   to a party row would be wiped on the next DM response. The `characters` map (already in the spec)
   is the single source of truth; party rows stay `{ id, name, role, hpPct, isActive }` unchanged.
   The connection→character link already exists: `room.clients` binds `displayName` (and a
   name-matched `partyId`) per connection (`server/sync-server.mjs:857-874`).
   **This overrides spec §2 ("Wider Party Row vs. Sibling Structure"): the game-developer implements
   the characters-map approach and must NOT add character fields to party rows.**

2. **Genre parity is section-level, not whole-prompt.** The two engines diverge by theme on purpose;
   only structured-block instructions are parity-tested (`src/lib/context.test.js` PP-05/PP-06). The
   new player-summary block gets a **section-level** parity test in the same style — not a
   whole-prompt byte-match.

3. **Fix the spec's modifier pseudocode bug.** Use `Math.floor((score - 10) / 2)`; the spec's
   `(STR || 10 - 10)` mis-parses and `${x:+s}` is invalid JS. Format the sign explicitly
   (`mod >= 0 ? '+'+mod : ''+mod`).

## Joiner character UX (per user decision: support all three)

In the **Join Session** tab (`src/components/ApiKeySetup.jsx`), a joiner picks their character via any of:
- **Sync existing local character** (lighter path): show the current local character (synced-subset
  preview) with a one-click sync and a "Use default instead" option.
- **Create a Character**: opens the existing `CharacterWizard` inline. Because the joiner doesn't
  choose genre, resolve the **room's genre first** via `loadSyncSession(sessionId)` (`GET /sessions`
  only returns `{sessionId,name,savedAt}`, no genre) and pass it to the wizard; fall back to the
  locally selected genre / `dnd` if the server is unreachable.
- **Import from .md** (new, per user request): the wizard accepts an uploaded `.md` file. Parse it
  with the existing `fromMarkdown` (`src/lib/session.js`) and a small character extractor with this
  precedence: (1) `characters` map entry whose key matches the entered display name; (2) else the
  single/first `characters` entry; (3) for a v1/v2 file with no `characters` block, derive from the
  single/first party row. The extracted fields **pre-fill the wizard's state** (name/race/class/
  abilities) so the player reviews/edits and confirms through the normal wizard flow — no blind
  import. No cross-session validation (any `.md` may be imported — flexibility over strictness). A
  malformed/blockless file must fail gracefully: the wizard stays empty, no crash. Genre still comes
  from the room.

Whichever path is used, the chosen character is passed through `onJoin` → `App.jsx handleJoin` →
`useWebSocket` and sent as `joinCharacter` on the `join` message (then server-sanitized).

**Mobile-width compatibility (required).** The app is used on phones over LAN, so all new/affected UI
— the Join-tab character section, the `CharacterWizard` (every step incl. the ability-assignment grid
and `.md` import), and the character preview — must be responsive at small widths (~360–414px): no
horizontal overflow, tap-friendly controls, inline (non-modal) layout that reflows in a single column.
Reuse existing responsive patterns/breakpoints in `src/App.css` (same approach as `PartyStrip` and the
existing setup card); add styles where the new controls need them.

## Data model & protocol

- **Schema bump 2 → 3** (`src/lib/session.js`), additive. `deserializeSession` must still load v1/v2
  without throwing: backfill `characters: {}` and leave party rows as-is (no character fields needed
  on rows). Reject `schemaVersion > 3` (existing invariant). **Upgrade mechanics:** the upgrade is
  transparent — `deserializeSession` always returns a v3-shaped object, so when `Chat.jsx` hydrates a
  v2 `dnd_session` from localStorage it is auto-upgraded in memory and re-persisted as v3 on the next
  settled turn. A client holding a freshly-upgraded v3 that joins a room still defers to the server's
  `session:state` per the existing dual-authority adoption gate (turnSequence/savedAt) — no special
  v2↔v3 merge path is needed because the server is authoritative for the synced subset.
- **Session payload** gains `characters: { [displayName]: SyncedCharacter }`. `serializeSession`
  carries it; `toMarkdown`/`fromMarkdown` round-trip it (informational ` ```characters ` block plus
  the authoritative `session` block).
- **Synced character — static subset** (set at join, stable for the session):
  `{ name, race, charClass, abilities:{STR,DEX,CON,INT,WIS,CHA}, ac, hpMax }`. `initiative`, `speed`,
  and the full sheet stay local in `dnd_character`.
- **DM-controlled mutable state** (changes during play, persists): `hpCurrent` (carried as the party
  block's `hpPct`, with `hpCurrent = round(hpPct/100 × hpMax)`), `isActive`, and `conditions`. These
  live in the **party block channel**, not the static `characters` map — see "Mid-session stat
  updates" below.
- **WS `join`** (`src/hooks/useWebSocket.js:100`) gains `joinCharacter: SyncedCharacter | null`.
  Connection-bound identity is unchanged (server ignores per-message `displayName` for authz).
- **`session:state`** (full snapshot) carries the static `characters` map so late joiners learn
  everyone's sheet; mutable HP/conditions ride the party rows (already in the snapshot).
- **`session:update`** carries the updated party rows each turn (existing path) — this is how
  mid-session HP/condition changes propagate. The static `characters` map need not be resent.
- **`character:update`** (client-driven self-edits) — still **deferred**. Players do not self-edit
  synced stats; the **DM** is the authority for mutable state (per user requirement).

### Mid-session stat updates (AI-DM-controlled, in scope)

Players' stats actually change during play and persist — e.g. taking damage in a fight. This is
**owned by the AI DM**, reusing the existing structured-block loop (no new protocol):
- The DM is fed each player's static stats **and current HP** in the prompt (e.g. `HP 22/45`) so it
  can apply and track damage.
- When the DM narrates damage/healing/conditions, it emits an updated ` ```party ` block (lower
  `hpPct`, toggled `isActive`); `applyPartyUpdate` (`session.js:54`) applies it, the server persists
  it to `.md`, and `session:update` broadcasts it. **HP loss therefore persists across turns,
  reconnects, and reloads** because party state is server-authoritative and persisted.
- To let the DM also manage **conditions** per player, extend the party block row with an optional
  `conditions: string[]` (additive; `applyPartyUpdate` must be updated to preserve/normalize it —
  this is a model change the refactoring-specialist plans). If conditions prove costly, ship HP
  persistence first and treat conditions as a fast-follow.
- **Source-of-truth:** while in a room, a player's synced HP/conditions are DM/server-authoritative;
  the local `CharacterPanel` HP becomes a read-only mirror of the synced value (derived from
  `hpPct × hpMax`). The local sheet remains editable only for non-synced fields.

## Security (server-authoritative)

New `sanitizeCharacter(raw)` in `server/sync-server.mjs`, mirroring `sanitizeDisplayName`
(`:97`) / `sanitizeActionContent` (`:259`): strip `[<>&"']` + control chars; cap name 64 / race 32 /
class 32; clamp each ability to integer 3–20 (else 10); AC integer 5–30 (else 10); hpMax 1–999
(else 10); hpCurrent clamped to `[0, hpMax]`; **allowlist only** the named fields (strip unknowns);
`null` → `DEFAULT_CHARACTER`. Applied in the `join` handler before storing into `room.characters`.
No `OLLAMA_HOST` / `MODEL_RE` references leak into `src/**` (gate G-C5).

## DM prompt integration

Extend `buildSystemPrompt({ name, details, context, players })` in **both** `src/lib/context.js`
and `src/lib/context.starwars.js` (identical injection logic — signature change threaded across call
sites is a refactor the refactoring-specialist plans). When `players` is non-empty, append a bounded
**"Player Characters:"** section — one line per player including **current HP** so the DM can apply
damage: `name (Class Race): STR s(±m), … ; AC a, HP cur/max`, capped at 5 players and **≤ 500 chars**
total. When `players` is absent/empty, output is **byte-identical to today** (protects existing
prompt tests).
- Each `players` entry merges the static `characters[displayName]` (race/class/abilities/ac/hpMax)
  with the live party row (`hpCurrent = round(hpPct/100 × hpMax)`, conditions) so the DM sees the
  current battle state, not just the join-time sheet.
- Call sites: `src/components/Chat.jsx:324` (`buildSystemPrompt(campaign)`) → pass derived local
  players; `server/sync-server.mjs:425` (`engine.buildSystemPrompt(room.campaign ?? {})`) → pass
  players built from `room.characters` + `room.party`.

## Stage B — implementation ownership (on `feature/mp-character-sync`)

Per user routing, Stage B is split across agents (not game-developer alone):
- **refactoring-specialist** — *plans* (does not solo-implement) the cross-cutting refactors before
  code starts: the `buildSystemPrompt({...,players})` signature change + threading through both genre
  engines and the two call sites; and the party/character **model change** (extending the party row
  with optional `conditions` + the `hpPct ↔ hpCurrent` derivation, and updating `applyPartyUpdate`
  to preserve/normalize the new field). Output: a short refactor plan the implementers follow.
- **websocket-engineer** — owns ALL WebSocket/transport work: the `join` payload `joinCharacter`
  (`useWebSocket.js`), server WS `join` handler + `room.characters` store + rejoin restore, and the
  `session:state`/`session:update` broadcast changes (`sync-server.mjs`).
- **game-developer** — owns game systems: `sanitizeCharacter`, character/HP math + derivation,
  DM party-block HP/condition application, prompt content (player summary incl. current HP), genre
  engines, `.md` round-trip of the `characters` map.
- **react-specialist** — owns the Join-tab UI: the three character paths, `CharacterWizard` `.md`
  import + pre-fill, and `App.css` mobile responsiveness (per project React routing).

The branch must be **self-green** (`npm test -- --run` ≥ 584 passed, 0 failed) before push — gate
**G-B**. Stage C (G-C gates) and Stage D (multi-agent validation) run **after**, against the pushed
branch — they are not Stage B phases.

### Phases

0. **Refactor plan (refactoring-specialist):** lock the `buildSystemPrompt` signature change and the
   party/character model change (conditions + hpCurrent derivation + `applyPartyUpdate` update)
   before implementation. Blocks Phases 4/5 and the mid-session-HP work.
1. **Data layer (game-developer; pure, parallelizable first):** schema bump + migration in
   `session.js`; `sanitizeCharacter` + tests. Gate: v1/v2/v3 deserialize; forged input clamped.
2. **Server join/persist + WS (websocket-engineer; parallel with 3 once Phase 1 fixes the shape):**
   accept + sanitize `joinCharacter`, store in `room.characters`, include in `session:state`, restore
   on rejoin (NAME_TAKEN path `:810+`), persist in `.md`; emit mutable HP/conditions on
   `session:update`.
3. **Client join + WS + UI (websocket-engineer for the `join` payload; react-specialist for UI;
   parallel with 2):** `useWebSocket` sends `joinCharacter`; Join-tab UX (sync-existing, wizard,
   `.md` import + genre resolve); `CharacterWizard` gains an `.md`-import/pre-fill entry; `App.jsx
   handleJoin` threads the character through. **Mobile AC:** Join tab, every wizard step, and the
   character preview reflow to one column at ~375px with no horizontal scroll and tap-friendly
   controls.
4. **Prompt integration (game-developer; after Phase 0):** both engines + section-level parity test +
   500-char budget test; player summary includes current HP; wire Chat.jsx local players.
5. **Server DM proxy + mid-session HP (game-developer + websocket-engineer; after 2 + 4):** build
   `players` from `room.characters` + `room.party`, pass to `buildSystemPrompt`; DM party-block
   updates lower `hpPct`/toggle conditions and persist; forged value reaches DM as clamped.
6. **Integration & back-compat (game-developer; final, after 1–5):** end-to-end SP/MP/late-join/
   rejoin/`.md` scenarios; **mid-session HP persists across a rejoin**; v1/v2 `.md` load;
   **mobile-width smoke at 375px**. Last Stage-B phase, green before push (G-B); distinct from Stage D.

## Critical files

- `src/lib/session.js` — schema bump, migration, `characters` map, `.md` round-trip. **Do NOT** add
  static character fields to party rows; the only party-row change is the optional DM-managed
  `conditions: string[]` (with `applyPartyUpdate` updated to preserve/normalize it, per the
  refactoring-specialist's plan).
- `server/sync-server.mjs` — `sanitizeCharacter`, `join` handler, `room.characters`, `.md` persist,
  DM-proxy prompt assembly (`:425`).
- `src/hooks/useWebSocket.js` — `joinCharacter` on the `join` message (`:100`).
- `src/components/ApiKeySetup.jsx` — Join-tab character UX (sync-existing + inline wizard w/ room
  genre + `.md` import).
- `src/components/CharacterWizard.jsx` — `.md`-import entry that pre-fills wizard state.
- `src/lib/session.js` — reuse `fromMarkdown` + add a small character extractor for the import path.
- `src/App.jsx` — `handleJoin` threads character to the WS layer.
- `src/App.css` — responsive styles for the Join-tab character section + wizard at mobile widths.
- `src/lib/context.js` + `src/lib/context.starwars.js` — `players` param + bounded summary (identical).
- `src/components/Chat.jsx` — pass local `players` to `buildSystemPrompt`.
- Tests: extend `session.test.js`, `context.test.js`, `useWebSocket.test.js`, `ApiKeySetup.test.jsx`,
  the node-env server suite; new `sanitizeCharacter` tests.

## Verification

- **Gate (hard):** `npm test -- --run` green — **≥ 584 passed, 0 failed, ≤ 2 skipped** plus new
  tests. This is the merge floor (never merge red).
- **Back-compat (G-C2):** explicit tests load v1 and v2 payloads/`.md` through `deserializeSession`
  → no throw, `characters` defaults to `{}`.
- **Security (G-C4):** `join` with a forged character (oversized name, `STR:999`, `ac:NaN`,
  `hpMax:9999`, extra fields) → server clamps/strips; forged values never reach `room.characters` or
  the prompt.
- **SP untouched (G-C3):** no `?room=` → `useWebSocket` `enabled=false`, zero socket, 30s poll runs,
  `sendMessage` hits Ollama directly; existing SP tests stay green.
- **Prompt budget (G-C6):** 5-player summary < 500 chars; engine parity test for the section.
- **Late join (G-C7) — required integration test (not smoke-only):** a 3rd joiner connects to an
  active 2-player session via `?room=`, joins with a character, and receives `session:state`
  containing all 3 players' characters (none null/missing).
- **Mid-session HP persistence:** a DM party-block update that lowers a player's `hpPct` persists
  across a `session:update`, a `.md` save/reload, and a disconnect→rejoin (the rejoiner sees the
  reduced HP, not the join-time `hpMax`). Verified by a server/session test + a manual fight smoke.
- **Manual smoke:** `npm run dev`, open two browsers on `?room=dnd-…`, each joins with a different
  character (one via wizard, one synced-existing, and verify a third via `.md` import pre-fills the
  wizard), take a turn, confirm the DM references player classes/stats; save `.md`, restore, confirm
  characters persist.
- **.md import:** uploading a saved session `.md` in the Join tab extracts a character and pre-fills
  the wizard; a malformed/blockless `.md` fails gracefully (no crash, wizard stays empty).
- **Mobile width:** at a ~375px viewport (DevTools device emulation or a real phone on LAN), the Join
  tab, every wizard step, and the character preview reflow to one column with no horizontal scroll and
  tap-friendly controls.
- **No-leak (G-C5):** grep confirms `OLLAMA_HOST`/`MODEL_RE` only under `server/`.

## Validation & hardening (Stage D — multi-agent, after the test gate is green)

A long-lasting campaign is the realistic stress case for character sync: history grows, players
disconnect/rejoin, the room is saved/restored many times, and the DM must keep using everyone's stats.
After Stage C is green, run this validation pass; any agent that finds an issue **fixes it on the
branch**, then the full suite is re-run (never leave it red). Live runs need local **Ollama**
(`qwen2.5:14b`) + `npm run dev` (vite+sync); where the model isn't reachable, fall back to
simulated/recorded transcripts (see `docs/design/PARTY-HUD-QWEN-VALIDATION.md` for the existing
model-compliance approach).

**Endurance & resilience (run first — produces the defect list):**
- **chaos-engineer** — controlled failure experiments over a long MP session: WS disconnect/reconnect
  storms (assert the character is restored every time via the `NAME_TAKEN` rejoin path); sync-server
  restart mid-campaign (assert `.md` reload restores `characters` + party + phase + turnSequence);
  concurrent multi-player actions (action-queue serialization + 500ms rate limit); idle room GC
  (~30min) then rejoin; poll-vs-WS dual-authority adoption under partition (turnSequence vs savedAt).
- **qa-expert** — scripted long campaign (many turns across free-roam/combat/rest, 2–5 players,
  repeated save/restore + `.md` round-trips, late joins, rejoins, mobile widths). Verify character
  integrity end-to-end and the local-vs-synced source-of-truth rule; produce a defect report.

**LLM quality & performance validation (consume the defect list; validate + fix):**
- **prompt-engineer** — verify the player-summary format makes the DM use stats correctly (skill DCs,
  AC, HP) and doesn't degrade party/check/verdict block compliance; tune format/wording if it does.
- **llm-architect** — context strategy over long sessions: confirm the system-prompt player summary
  survives `trimContext` (it's not in the trimmed history) and the budget holds as history grows;
  recommend windowing changes if needed.
- **ml-engineer** — model-compliance validation against `qwen2.5:14b` (mirror the existing QWEN
  validation doc): does the model honor the stats + still emit valid blocks over many turns?
- **ai-engineer** — end-to-end AI-system view: the server DM-proxy → prompt → parse → broadcast loop
  under the new data; wire any fixes that span prompt + server.
- **performance-engineer** — DM-proxy latency as context grows, prompt-assembly cost, streaming
  throughput, server memory (in-memory rooms + message accumulation), per-action `.md` write cost,
  and client re-render/poll cost with extended party rows on mobile; fix bottlenecks.

**Coordination addendum (locked before Stage D starts):**
- **Defect list** is the handoff artifact from D1 (chaos/QA) to D2 (fix cluster): a markdown table,
  one row per defect = `{ id (D-1…), severity (blocker/major/minor), affected phase/file, repro,
  root cause, owner agent }`.
- **Fix-merge sequence** to avoid the 5 fix agents colliding on shared files (esp. the server DM
  proxy + prompt): data/schema fixes → server fixes → prompt + client fixes (parallel) →
  integration re-test. Each fix agent: write/extend a test reproducing the defect, run
  `npm test -- --run` locally, then commit to the branch with a message linking the defect id.
- **Re-pass after fixes:** the main thread re-runs the **full** suite once the cluster completes;
  individual agents minimally re-pass **G-C1 + G-C4 + G-C6** for their own change before pushing.
- **Live-model dependency:** D2's LLM-quality work needs local Ollama (`qwen2.5:14b`). If unreachable,
  use recorded/simulated transcripts per `docs/design/PARTY-HUD-QWEN-VALIDATION.md`, or defer the
  model-compliance items to when Ollama is available — do not block the rest of delivery on them.

I drive the handoffs (endurance/QA first → fix cluster). `MP-CHARACTER-SYNC-WORKFLOW.md` gains a
Stage D section during execution; all Stage D fixes re-pass the gates before delivery.

## Execution & delivery

**Step 0 (on approval):** save this plan verbatim into the repo as
`docs/design/MP-CHARACTER-SYNC-PLAN.md` (alongside the workflow + spec docs) so it's a durable,
version-controlled artifact, and commit it on the feature branch.

Work lands on `feature/mp-character-sync` (already created, branched from synced `master`). The
`game-developer` agent implements per the workflow; `test-automator` may assist the test gate; the
Stage D agents above validate and harden. After all gates are green **and** Stage D fixes are folded
in, the **main thread opens the PR** (`feature/mp-character-sync` → `master`) and is the approver/
merger — the automated gates are the review; merge only once the suite is confirmed green. No direct
push to `master`.

**Schedule/effort risk (flagged):** the spec gives no per-phase effort estimate. Phase 1 (data layer)
is the critical-path prerequisite for everything else; if it slips, the whole chain shifts. I'll
surface a blocker for sign-off rather than silently extending scope, and Stage D's model-compliance
items are deferrable (above) if Ollama is unavailable so they don't block the PR.
