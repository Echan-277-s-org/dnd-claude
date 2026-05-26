# Cross-Device Sync Plan — Multi-Agent Evaluation

> **Subject:** Review of `CROSS-DEVICE-SYNC-PLAN.md`
> **Date:** 2026-05-25
> **Method:** 7-agent review (product-manager, game-developer, llm-architect, ai-engineer,
> backend-developer, performance-engineer, refactoring-specialist), orchestrated via a
> `multi-agent-coordinator` facet-ownership matrix + a `task-distributor` dispatch plan, then
> synthesized under a MUST-FIX / SHOULD-FIX / NICE-TO-HAVE severity rubric with domain-authority
> tie-breaks.
> **User decisions folded in:** (1) usage = **handoff first** (simultaneous co-play deferred);
> (2) phone goes **straight into the synced session** (no phone setup); (3) deliverable = revised
> plan + findings; (4) **must keep the ability to save & continue a session from a Markdown file**
> — this is a hard requirement that reinstates the plan's declined Option C (see §2.5).

---

## 1. Headline verdict

| Phase | Verdict | Gate |
|---|---|---|
| **A — localStorage messages** | **Ship first**, with the streaming-hotpath fix | Must not serialize on every stream delta |
| **A2 — Markdown save/continue** | **Build before B** (user-required) | Lossless round-trip via embedded session block |
| **B — Express sync server** | **Rework before implementing** | 6 MUST-FIX items; the doc currently ships none |

Phase A is a near-zero-risk win (survive refresh). **Phase A2 (Markdown save/continue) is now a
required capability** — it was the plan's declined "Option C," but the user works in an
md-file-driven way and needs portable, offline, git-friendly session continuity (manual file move
also doubles as a resilient cross-device path when the server is down). Phase B is the right idea
for *live* sync, but as written it omits things that break the **base, non-adversarial case**:
CORS, path-safety, atomic writes, a stable session identity, the streaming hotpath cost, and
syncing `campaign` (so the phone has a system prompt at all).

---

## 2. MUST-FIX before Phase B ships

Each keyed to the owning agent per the synthesis rubric.

### M1 — Stable session identity, not a name slug  *(game-developer, echoed by 6/7)*
`campaignName → slug` collides for same-named campaigns; the `crypto.randomUUID()` **fallback
stored per-device** causes **split-brain** — the phone mints a *different* id than the desktop,
writes to a different file, and **silently never finds the session**, defeating the feature with
no error.
**Fix:** mint `campaign.sessionId = crypto.randomUUID()` once at campaign creation
(`ApiKeySetup`/`CampaignSetup`), persist inside `campaign` (`App.jsx:84-90`), use it as the sync
key. Keep the human slug only as a display label in `GET /sessions`.

### M2 — Sync the `campaign` object  *(llm-architect MUST-FIX; game-developer H2)*
With "phone straight to synced session," a phone with empty `localStorage` either hits the
`dnd_setup_done` gate and never reaches `Chat`, or replays the identical log against an **empty
system prompt** — `buildSystemPrompt` loses `campaign.context` (the loaded world-notes:
NPCs/locations/lore) and possibly runs a different `model`. The two devices then build materially
different prompts → contradictions, forgotten NPCs, tone/compliance drift.
**Fix:** include `{ name, genre, details, context, model, sessionId }` in the payload; on load,
if the device has no/differing campaign, adopt the synced one and skip setup.
**Note:** this revises plan line 109's "`App.jsx`: no changes."

### M3 — CORS + OPTIONS preflight  *(backend-developer — not mentioned in the plan at all)*
Phone app at `:5173` → server at `:3001` is cross-origin; the browser hard-blocks every `fetch`
without `Access-Control-Allow-Origin`, and `PUT` triggers a preflight `OPTIONS` that must be
answered. Without this the feature is **100% non-functional** and fails like a generic network
error.
**Fix:** `app.use(cors({ origin: true }))` (or ~8-line manual middleware) + handle `OPTIONS`.

### M4 — Path-traversal guard on `:id`  *(backend-developer)*
`GET /session/../../../package` escapes `server/sessions/`.
**Fix:** server-side validate `/^[A-Za-z0-9_-]{1,128}$/` and confirm `path.resolve` stays under
the sessions dir. Never trust the client slug.

### M5 — Atomic writes + concurrency lock  *(backend-developer)*
`fs.writeFile` is non-atomic (crash/concurrent write → unparseable session); two concurrent PUTs
both pass the staleness check and the last clobbers (the 409 never fires — TOCTOU).
**Fix:** write-temp-then-`rename`; per-session in-memory lock (`Map<id, Promise>`);
`mkdir({recursive:true})` at startup; **server-stamped** `savedAt`; try/catch on `JSON.parse`
(→404) and `express.json()` error (→400).

### M6 — Streaming hotpath: persist once per turn, not per delta  *(performance-engineer + refactoring-specialist)*
Confirmed at `Chat.jsx:218`: `setMessages` fires **per token**. The plan's
`useEffect(..., [messages])` would run `JSON.stringify(entireHistory)` + synchronous
`localStorage.setItem` 30–80×/sec — O(n) per token, ~90 ms/sec of main-thread work on a long
session → **jank, worse on phone**. The plan's `setMessages(prev => { saveSyncSession(prev);
return prev })` trick is also a **side-effect-in-updater** that React StrictMode double-invokes →
double PUT → spurious 409.
**Fix:** persist **once per completed turn** via an `isLoading` `true→false` `useEffect` (clean
semantics, no double-fire), wrapped in try/catch for `QuotaExceededError`.

---

## 2.5 Required capability — Markdown save & continue *(reinstates declined Option C)*

The original plan declined Option C ("export/import JSON … B's payload is download-able later if
wanted"). **The user requires the ability to save a session to a Markdown file and continue from
it** — so this is promoted to a first-class deliverable, built **before** the sync server.

**Why it matters (and what it buys us):**
- Matches the existing workflow — `campaigns/*.md` already load into `campaign.context` via the
  setup screen's "Load .md file" button; campaign handoffs already live as markdown.
- Portable, human-readable, git-friendly, and **works with no server running** — a manual file
  move between devices is itself a cross-device path, and a resilient fallback when the Phase B
  server is down (directly answers ai-engineer's "informationally silent degradation" gap).
- Lower-risk than the server and independently shippable.

**Core design principle — the file is a self-contained, LLM-loadable handoff.** The saved md
must let *any* LLM continue the campaign with **no app required**: paste the campaign-notes file
**+** a session file into Claude (or any model) and play on. So the prose is not decoration — it
is a complete DM brief (role instruction → world recap → party/scene state → full transcript).
The fenced block rides alongside purely so the *app* can restore exact state losslessly.

**Two folders (decided):**

| Folder | Holds | Authored by | Loaded as |
|---|---|---|---|
| `campaigns/` *(exists)* | World notes / lore / setup, handoff docs | Human | `campaign.context` (prior world state) |
| `sessions/` *(new)* | Saved live play — transcript + state, one `.md` per save | The app | Full session restore (messages/party/dice/campaign) |

The two files are complementary: `campaigns/<name>.md` = the world; `sessions/<name>-<date>.md` =
where you are in it. Together = everything an LLM needs to resume. (`sessions/` is distinct from
the Phase-B sync server's internal store; see §3.)

**Format — fenced ` ```session ` block (decided over YAML frontmatter)**, because `Chat.jsx`
already strips/parses fenced blocks, so the parser pattern exists and the block stays invisible
in rendered markdown. Shape of a session file:

```markdown
# Session — Jaycen Hawke · Solace Cathedral
<!-- saved 2026-05-25T14:32Z · genre: dnd · model: qwen2.5:14b · sessionId: 7f3a… -->

## Continue from here
You are the Game Master. Below is the story so far and the current state — pick up as DM from the
last line. Pair this with the campaign notes (`campaigns/jaycen-hawke-solace-cathedral.md`).

## Where we are
<1–3 sentence recap of the current scene>

## Party
| Name | Role | HP | Turn |
|------|------|----|------|
| Jaycen Hawke | Paladin | 80% | ▶ |
| … | … | … | |

**Pending check:** Perception DC 15   <!-- omit line if none -->

## Transcript
**You:** I push open the chapel doors…
**GM:** The hinges groan. **Sister Veil** turns from the altar…
> 🎲 d20 → 17 · Perception DC 15 → **PASS**
…

```session
{ "schemaVersion": 1, "sessionId": "7f3a…", "savedAt": "2026-05-25T14:32:11Z",
  "campaign": { "name": "Jaycen Hawke", "genre": "dnd", "details": "…", "context": "…", "model": "qwen2.5:14b" },
  "messages": [ … ], "sessionLog": [ … ], "party": [ … ] }
```
```

The prose (recap + party + transcript) is the LLM-readable context; the trailing ` ```session `
block is the lossless machine payload (`schemaVersion`, `sessionId`, `savedAt`, `campaign`,
`messages`, `sessionLog`, `party`). `entities` excluded (re-derived); `pendingCheck` excluded
from the block in v1 but shown as a prose line so an LLM still sees it.

**Implementation — one serialize layer, three surfaces:**
- `src/lib/session.js` gets `toMarkdown(payload)` / `fromMarkdown(text)` next to
  `serializeSession`/`deserializeSession` — the **same payload shape** (§3) feeds localStorage,
  the `.md` file, **and** the sync server, defined once. `toMarkdown` renders prose from the
  payload; `fromMarkdown` parses the fenced ` ```session ` block (reusing the existing
  block-extraction approach) and ignores the prose.
- UI: a **"Save session (.md)"** button (in `Chat`/`HistoryPanel`) that downloads to `sessions/`,
  and **extend the existing "Load .md file" path** — if the file contains a ` ```session ` block,
  restore full state; otherwise fall back to today's behavior (prose → `campaign.context`). One
  button now loads either a world-notes file or a session file.

**Relationship to Phase B.** Markdown is the durable, user-controlled source of truth; the sync
server is a *live convenience layer on the same serialize layer*. The server may even store these
same `.md` files (reading `savedAt` from the fenced block) so its store is itself LLM-loadable —
or keep JSON internally and convert at the edge (server-parse tradeoff noted in §3). Build order:
**A → A2 (md save/continue) → B.**

---

## 3. Revised implementation plan

### Phase A — localStorage messages (ship first)
**`src/components/Chat.jsx`:**
- Lazy-init `messages` from `deserializeSession(localStorage.getItem('dnd_messages'))` (~line 87).
- **Persist once per turn**, not per delta — `isLoading` falling-edge effect (or save in the
  `finally` block via a captured local, *not* inside a state updater). try/catch →
  `QuotaExceededError` trims oldest + warns.
- `handleNewSession` (~line 293) `removeItem('dnd_messages')`.
- Add a Vitest reload-path test.

### Phase B — sync server + client (after A)
**New `server/sync-server.mjs`** (~110–120 lines once correct — *not* 80):
- `GET /session/:id` → payload | `404`; supports `?since=<ISO>` → `304`/`{savedAt}` when
  unchanged (don't ship the full history on every 30s poll — perf SHOULD-FIX).
- `PUT /session/:id` → path-safe id, `withLock`, staleness check, **temp-write + rename**,
  server-stamped `savedAt`, returns `{ savedAt }`; `409` stale; `400` bad JSON.
- `GET /sessions` → slugs (+`savedAt`) for a future picker.
- CORS + `OPTIONS`; startup `mkdir`; error-handling middleware last.

**New `src/lib/session.js`** (pure, unit-testable, no React):
- `getLanHost(port)` — **shared** util replacing the inline `window.location.hostname` in
  `Chat.jsx:170` (Ollama) *and* the proposed sync host (DRY).
- `serializeSession` / `deserializeSession` — payload shape defined **once**, used by both Phase
  A localStorage and Phase B sync.
- `campaignToSessionId` (label only), `loadSyncSession`, `saveSyncSession` (sends client
  `savedAt`, handles 409, **try/catch network errors** so a down server degrades gracefully),
  `pollSyncSession(id, savedAt, onNewer)` → cleanup.

**New `src/hooks/useSessionPersistence.js`** (refactoring SHOULD-FIX — keeps `Chat.jsx` cohesive):
owns mount-load (server-authoritative-when-reachable, **overwrite not merge**), per-turn save,
30s poll. Moves the `dnd_party` write out of the `setParty` updater so `party` has a single
persistence owner.

**Payload shape (revised):**
```json
{ "sessionId": "<uuid>", "schemaVersion": 1, "savedAt": "<server ISO>",
  "campaign": { "name": "...", "genre": "...", "details": "...", "context": "...", "model": "..." },
  "messages": [...], "sessionLog": [...], "party": [...] }
```
- `entities` excluded — re-derived via `extractEntities` (correct: pure derivative of `messages`;
  block-stripping removes no entity signal — confirmed by llm-architect + ai-engineer).
- `pendingCheck` **excluded for v1** (game-dev H3: syncing risks a check answered-twice; it's
  session-only by design — the DM's request is visible in message text). Revisit with
  simultaneous mode.
- **Source-of-truth rule (ai-engineer):** server authoritative for
  messages/sessionLog/party/campaign *when reachable*; localStorage = offline mirror; LLM output
  authoritative only for the current turn's mutation, written through to both. Enforce by load
  order: server fetch resolves → overwrite the localStorage-hydrated state.

**`package.json` / `.gitignore` / `vite.config.js`:** add `express` + `cors` + `concurrently`
(devDeps); `"dev": concurrently vite + node server`; gitignore `server/sessions/`; no vite change.

### Refactor sequencing (land A→A2→B without churn)
1. Extract `src/lib/session.js` (pure fns + `getLanHost` + `serialize`/`deserialize`) + unit
   tests — no component changes.
2. **Phase A** wiring in `Chat.jsx` (per-turn save) + reload test.
3. **Phase A2** — add `toMarkdown`/`fromMarkdown` to `session.js` (+ round-trip unit test); add
   the "Save session (.md)" button and extend "Load .md file" to detect & restore a session
   block. Independently shippable — no server needed.
4. **Phase B** — implement `server/sync-server.mjs` + Node integration tests (don't wire the
   client yet).
5. Extract `useSessionPersistence`, wire load/save/poll, move `dnd_party` write into it.

---

## 4. SHOULD-FIX backlog (track, not blocking v1-handoff)
- **Sync-status UI** (synced / offline / stale badge) — silent divergence is the top resilience
  gap (ai-engineer).
- **History retention policy** — full history per save grows unbounded; cap stored messages
  (reuse `trimContext`'s horizon) (ai-engineer + performance).
- **Non-destructive 409** — on conflict don't blow away the local unsaved turn (ai-engineer).
- **`handleNewSession` clears the server** (DELETE / empty-PUT), don't rely on overwrite
  (game-dev, backend, refactoring).
- **`character` (player HP/stats) sync** — currently per-device; mid-combat HP can desync
  (game-dev).
- **Phone LAN onboarding** — show desktop IP / QR; document `OLLAMA_HOST=0.0.0.0` + firewall
  (PM, backend).
- **Success metrics** — log save freq / 409 rate / cross-device adoption (PM).
- **Mid-stream race (in-flight signal)** — promote to MUST-FIX *if/when* simultaneous co-play
  ships (ai-engineer; deferred per usage decision).
- **`schemaVersion` validation on load** (game-dev, backend).

---

## 5. Verification
1. `npm test -- --run` (203 tests) green after Phase A; add reload + session serialize/deserialize
   unit tests.
2. Phase A: start session, refresh → messages + dice chips + party persist; New Session clears.
3. Phase A2 (md): "Save session (.md)" → reload app → "Load .md file" on that file restores the
   full session (messages/party/dice/campaign), not just `campaign.context`; round-trip is
   lossless (unit test on `toMarkdown`∘`fromMarkdown`). Verify on a second device by manual file
   move with **no** sync server running.
4. Phase B cross-device: desktop session → **fresh** phone (`http://<desktop-IP>:5173`, empty
   localStorage) loads same campaign+messages+party *without* a setup screen; verify phone's
   system prompt includes campaign `context` (no narrative drift).
5. Conflict: edit on desktop → phone shows reload prompt next poll; stale PUT gets 409, no clobber.
6. Negative: kill the sync server → app still works on one device (localStorage only); md
   save/continue still works fully; no crash.
7. Security smoke: `GET /session/../../package` rejected; `PUT` from `:5173` succeeds (CORS).

---

## 6. Conflict-watchlist resolutions
- **Phase A persist effect** — performance-engineer confirmed per-delta firing (`Chat.jsx:218`):
  real MUST-FIX, not a style nit.
- **`setMessages` save trick** — refactoring wins on pattern-correctness (StrictMode double PUT →
  409); use `isLoading` edge effect.
- **LWW + 30s poll conflict model** — acceptable for **handoff** (chosen); reload prompt would be
  "unplayable every turn" under simultaneous play → that mode is explicitly deferred.
- **`party` source-of-truth** — ai-engineer ruling adopted: server-authoritative-when-reachable,
  enforced by load order; single persistence owner via the hook.
- **`pendingCheck`** — game-dev "answered-twice" hazard wins for v1: don't sync it.
- **JSON vs SQLite** — unanimous: JSON files correct at this scale; SQLite rejected (Windows
  native-build fragility, no concurrency need).

---

## 7. Full per-agent findings

### product-manager — *verdict: ship Phase A alone first; clarify Phase B before greenlight*
**Strengths:** real problem (refresh wipes the log); Phase A is an unambiguous 30-min win; LAN-only
avoids cloud/auth/scale; defensive parsing; clean A→B sequencing.
**Risks/gaps:** missing conflict-UX contract ("continue session" mid-combat); 30s interval is
arbitrary/unjustified; "continue session" picker unspecified; Phase A shipping may hide Phase B
urgency; firewall/Ollama setup friction breaks silently; no success metrics; Option C
(export/import) dismissed without trade-off detail.
**Recommendations:** ship A immediately & measure; define the sync conflict/UX model before B; put
the "continue session" UI in B's scope (with name-collision test); add observability; reconsider
Option C as a "Phase B.0"; correct agent routing (A→react-specialist; B→fullstack/backend).

### game-developer — *Phase A viable; Phase B has 2 MUST-FIX + coverage gaps*
**Game-state coverage gaps:** `campaign` left in per-device localStorage (fresh phone never exits
setup — M2); `character` HP/stats per-device (could desync mid-combat); turn-order is positional
in the `party` array; `entities` correctly excluded.
**Hazards:** **H1 session-identity collision + UUID split-brain (MUST-FIX, M1)**; **H2 campaign
not in payload (MUST-FIX, M2)**; **H3 syncing `pendingCheck` → check answered twice (MUST-FIX —
don't sync)**; H4 verdict could attach to a stale bare dice chip on restore (SHOULD — mark restored
bare chips `orphaned`); H5 30s reload prompt mid-combat disruptive (depends on handoff vs
simultaneous); H6 turn-order OK if save-point discipline holds; H7 `handleNewSession` doesn't clear
server; H8 no `schemaVersion`.

### llm-architect — *message-log sync sound; system prompt NOT synced is the MUST-FIX*
**Correct & deterministic:** `extractEntities` is pure and reads only `**bold**`/quoted spans —
block-stripping removes zero entity signal, so re-derivation reconstructs byte-identically;
`trimContext(4,18)` + fixed `num_ctx:8192` bounds context regardless of restored history length
(can't blow the window); dice `[Dice roll: …]` transform is generated at send-time from stored
`{die,result}` — no double-strip/fence re-parse; `pendingCheck` fold-in is deterministic.
**MUST-FIX:** `campaign.context` (world-notes) never synced → phone replays against an empty/
different system prompt → drift (= M2). **SHOULD:** `campaign.model` not synced (model-specific
block compliance — see `PARTY-HUD-QWEN-VALIDATION.md`); party-block re-emission can diverge from
restored party if context gap not closed. **Recommendation:** add `campaign` (≥`context`+`model`)
to payload; optional `promptFingerprint` to detect divergence.

### ai-engineer — *conditionally sound; source-of-truth under-specified; 2 MUST-FIX*
**Architectural fit:** sync server is a dumb persistence relay — doesn't violate stateless
inference; risk is it becomes a 2nd authority with no conflict rule. Three stores (LLM output /
localStorage / server JSON); `party` is written by all three with no defined order.
**MUST-FIX:** (a) define `party` precedence — proposed: server-authoritative-when-reachable,
localStorage offline mirror, LLM output only for current turn, enforced by load order; (b)
mid-stream poll race (no in-flight-turn signal) — *demoted to SHOULD for handoff-only, promote if
simultaneous ships*; (c) unbounded per-save history → retention policy reusing `trimContext`'s
horizon. **SHOULD:** surface sync status; non-destructive 409; document `pendingCheck` dual-rule.
**JSON vs SQLite:** JSON correct at this scale.

### backend-developer — *3 MUST-FIX in the base case before any threat model*
**MUST-FIX:** path traversal on `:id` (M4); non-atomic writes → temp+rename (M5); TOCTOU on the
409 guard → per-session `withLock` mutex (M5); CORS + OPTIONS preflight or the feature is dead
(M3); JSON-parse guard on corrupted files (→404); `express.json()` error → 400.
**SHOULD:** server-stamps `savedAt` (clock-skew); disk-full/`ENOSPC` handling; PUT returns
`{savedAt}`. **NICE:** unauth read/write + slug enumeration + plain-http all acceptable on a
trusted home LAN. **Estimate:** realistically 100–120 lines and ~3 h *only* if you go straight to
the correct pattern (budget +30–45 min for CORS preflight debugging). Provided a minimal-correct
PUT-handler sketch (lock + path-safety + staleness + temp-write + rename + server stamp).

### performance-engineer — *Phase A `[messages]` effect is a MUST-FIX*
**Hotpath:** `setMessages` fires per-delta (`Chat.jsx:218`); `qwen2.5:14b` ≈15–50 tok/s →
30–80 `setMessages`/s; the proposed effect runs `JSON.stringify(history)` (O(n)) + sync
`localStorage.setItem` each time = ~90 ms/sec main-thread on a long session → jank (worse on
phone); compounds with the existing per-delta `scrollIntoView` (`Chat.jsx:100-102`).
**MUST-FIX:** no write try/catch → `QuotaExceededError` (~1,000–1,400 messages ≈ 5 MB); save once
per turn (isLoading edge / finally), gate + cap. **SHOULD:** poll `?since=` / 304 instead of full
payload every 30s; message-count cap (~300). **Open:** fire-and-forget `saveSyncSession` inside a
setter swallows 409/network errors — confirm error boundary; iOS Safari 60s fetch timeout on a
dead server blocks the poll effect.

### refactoring-specialist — *Phase A safe; Phase B save pattern is a correctness defect*
**MUST-FIX:** side-effect inside the `setMessages` state updater — StrictMode double-invokes →
double PUT → spurious 409; use an `isLoading` transition `useEffect` instead.
**SHOULD:** `dnd_party` written by two owners (Chat.jsx + sync) with no coordination → boot
flicker; persistence scattered across App.jsx + Chat.jsx (divergent change); duplicated
`window.location.hostname` host derivation → extract `getLanHost(port)`.
**Proposed abstraction:** `src/lib/session.js` (pure: `serializeSession`/`deserializeSession`,
`getLanHost`, sync API) + `src/hooks/useSessionPersistence.js` (React integration). Testable
against mock `Storage`/`fetch` like `context.test.js`/`loadParty.test.js`.
**Sequencing:** extract session.js → Phase A wiring → server + Node tests → extract hook & wire.
**Open:** confirm `<React.StrictMode>` (latent double entity-extraction today at `Chat.jsx:275-278`).

---

## 8. Resumable agent IDs
`SendMessage` to continue any agent with its context intact:

| Agent | ID |
|---|---|
| product-manager | `a867cc7cd99811a3d` |
| multi-agent-coordinator | `a40dbea195ca8b2f3` |
| task-distributor | `aadc82751e0c1f869` |
| game-developer | `a9279d46c4c9e01cd` |
| llm-architect | `aaa58b9774a199014` |
| ai-engineer | `ae8945afb2190ae8b` |
| backend-developer | `aac2378a139253643` |
| performance-engineer | `a67979cb95f0814bc` |
| refactoring-specialist | `ab0f584cfbe53da91` |
