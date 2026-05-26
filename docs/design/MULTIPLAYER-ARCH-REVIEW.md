# Multiplayer Architecture Review (D3)

> **Owner:** architect-reviewer (D3)
> **Subject:** `MULTIPLAYER-ARCHITECTURE.md` (D2), judged against `MULTIPLAYER-PRD.md` (D1),
> the three test-readiness artifacts (`MULTIPLAYER-QA-PLAN.md`, `MULTIPLAYER-TEST-AUTOMATION.md`,
> `MULTIPLAYER-CHAOS-PLAN.md`), and the existing system
> (`src/lib/session.js`, `src/hooks/useSessionPersistence.js`, `server/sync-server.mjs`,
> `src/components/Chat.jsx`, `src/lib/genres.js`, `src/lib/context.js`).
> **Drives:** Gate G2.
> **Status:** REVIEW COMPLETE.

---

## 1. State / Transport / Coordination Evaluation

### 1.1 Authority model — SOUND

Server-authoritative is the correct call and is consistent with the existing system. Phase B
(`useSessionPersistence.js`) is already "server-authoritative-when-reachable" — `adopt()` on mount
overwrites local state from the server copy. The architecture extends that anchor with a push
channel without relocating authority, which is exactly the minimal-surface move. The rejection of a
leader-client model (§1.1) is well-reasoned for a LAN where the server process is trivially kept
alive, and it is the only model under which the `.md` store (R3) keeps a single trusted writer.

### 1.2 Transport — SOUND in principle, but the attach point is misstated against reality

WebSocket on the same port/process is the right choice; the SSE-vs-WS table (§2.1) is fair, and
keeping `pollSyncSession` as the offline fallback (§2.2) is the correct non-destructive posture.

However, the architecture's stated mechanism is wrong against the code it cites. §2.1 says the
upgrade "attaches `ws` to the same `http.Server` instance returned by `app.listen(3001)`."
`createSyncServer()` in `server/sync-server.mjs` **returns the Express `app`, not an
`http.Server`** — `app.listen()` is only called at the bottom-of-file `isMain` block, and the
return value of `listen()` is discarded. The `ws.WebSocketServer({ server })` pattern needs a
handle to the `http.Server`, which today no caller holds. This is not fatal but it is a real
contract change that the migration plan does not name: `createSyncServer` must be refactored to
either create and return the `http.Server` (e.g. `http.createServer(app)`) or accept an existing
one. The test harness in `MULTIPLAYER-TEST-AUTOMATION.md` §2.1 silently assumes the fixed shape
(`createSyncServer({ sessionsDir }).listen(0)` then `httpServer.address().port` and a
`wsBase` on the same port), so the test author has already presumed the refactor — but the
architecture never specifies it. See must-change **MC-1**.

### 1.3 Server-side Ollama proxy — the central question is UNDER-SPECIFIED, not unsound

Making the server the sole Ollama caller is the correct structural answer to R1, and §3.3's
"only the server holds a code path that calls Ollama in multiplayer mode" is the right framing.
But the architecture treats the DM call as if the only thing the server must do is `fetch` Ollama
and run `applyPartyUpdate`. **It is not.** In the existing system, `Chat.jsx#sendMessage`
(lines 167–241) assembles the request the DM depends on:

- `buildSystemPrompt(campaign)` — lives in the **genre engine** (`src/lib/context.js` /
  `context.starwars.js`), selected via `genres.js#getGenre(campaign.genre)`.
- `extractEntities(messages)` appended to the system prompt for continuity.
- `trimContext([...])` to bound the context window.
- The dice-message → text transform (`[Dice roll: d20 → 17 …]`) **and** the folding of
  session-only `pendingCheck` into the most-recent dice line (lines 182–192).
- The Ollama `options` block (`num_ctx`, `num_predict`, temperature, etc.) and
  `model: campaign.model || 'qwen2.5:14b'`.

The architecture's §3.4 step list jumps straight from "reads Ollama's stream" to
"runs `extractBlock`/`applyPartyUpdate`" — it never says **who builds the prompt**. If the server
builds it, the genre engines and the `pendingCheck`/dice-folding logic must become server-reachable
ESM (they are pure and importable, so this is feasible — `session.js` is already imported by
`sync-server.mjs`), and `pendingCheck` — which the architecture itself classifies as session-only
and *never machine-restored* (§1.2, consistent with `session.js` header and `Chat.jsx` lines
108–114) — now has to travel from the acting client to the server on the `action` event, because
the server has no other way to know it. That is a new wire field the message envelope (§2.4) does
not carry. Alternatively the client could pre-assemble the full prompt and send it — but then the
"server is the sole authority" claim weakens and a malicious client (R4 is explicitly in-scope as
LAN-trust-only) could inject an arbitrary system prompt.

This is the single largest gap in the design. It is not a reason to reject the approach — the
approach is right — but it is a concrete must-change because the phased plan (Phase 3) and the
test plan both assume "server calls Ollama" is a small refactor, and it is not. See **MC-2**.

### 1.4 Schema v1→v2 extension — MOSTLY CORRECT, one defensive hole

The extend-don't-fork decision is right and matches the "ONE payload shape" invariant in
`session.js`. The v1-compat branch in §1.2 is the correct shape. Verified against
`deserializeSession`: today it does `if (obj.schemaVersion !== SCHEMA_VERSION) return null`, so the
v2 version must add an explicit `=== 1` acceptance arm exactly as the architecture shows. Good.

Two issues:

1. **`serializeSession` is the write path the server uses on every PUT and must learn the v2
   fields.** `sync-server.mjs#put` rebuilds the payload through `serializeSession(...)` (lines
   111–120), which today hard-drops anything outside `{campaign, messages, sessionLog, party}`.
   If `serializeSession` is not extended to carry `phase`/`roomCode`/`turnSequence`, **every HTTP
   PUT silently strips the v2 fields** even though `deserializeSession` would accept them — a
   write-path/read-path asymmetry. The architecture documents the read side and `toMarkdown`/
   `fromMarkdown` but never says `serializeSession` gains the fields. The test plan's
   "HTTP PUT v2 payload → GET round-trip preserves v2 fields" (TEST-AUTOMATION §5.4) would catch
   this, but the architecture should specify it so it is built right the first time. See **MC-3**.

2. **`phase: 'awaiting-dm'` / `'resolving'` must never be persisted as a resting phase.** The
   chaos plan already found this (EX-9): a `.md` saved mid-stream could carry `awaiting-dm`, and a
   fresh load must coerce to `free-roam` because there is no in-flight Ollama call on load. The
   architecture's §4.1 lists these as phases and §6.3 says "`phase` is written" — but nowhere does
   it state the sanitize-on-write or sanitize-on-load rule. This is a small but real correctness
   item. See **MC-4**.

### 1.5 Moving `applyPartyUpdate` into `session.js` — CLEAN

Verified: `applyPartyUpdate` (`Chat.jsx` lines 47–61) is already pure and uses only
`crypto.randomUUID()`, which is a global in both the browser and Node 18+. It has no React or DOM
dependency. Moving it to `session.js` as a named export is clean, lets both the client and the
server import one implementation, and is already mirror-tested in `parser.test.js` (PA-14..32) and
stubbed in `session.multiplayer.test.js`. No concern. This is the cleanest part of the proposal.

---

## 2. Migration Risk

### 2.1 `.md` save/continue (R3) — PRESERVED, with the MC-3/MC-4 caveats

The server store stays a folder of `toMarkdown` handoffs; the 💾 button and `fromMarkdown`
setup-screen load are untouched (§6.3). This honors the hard `md-save-continue-requirement.md`
override. The exclusion of `connections`/`dmClientId` from `.md` is correct and test-covered
(COMPAT-05 / TEST-AUTOMATION §5.3). The only risks are the two already filed: `serializeSession`
must actually carry the v2 fields (MC-3) and a non-resting `phase` must be sanitized (MC-4).
Both are mechanical once named.

### 2.2 Single-player non-regression — PRESERVED by design, but the mode-switch is fragile

The fallback story (§3.2: direct Ollama fetch when WS is disconnected **or** `connectionCount === 1`)
keeps single-player working and is gated behind QG-08 (full 274-test suite) and COMPAT-07/08. The
design is sound. The fragility is the **mode-selection predicate**: `connectionCount === 1` is
derived from "the last `presence:update`." There is a window at session start where a single host
is WS-connected but has not yet received a `presence:update`, and a window after a second player
leaves before the count updates. During those windows the predicate's value is ambiguous, and the
two branches (client-side Ollama fetch vs server-side proxy) have **different** turn-sequence and
persistence side effects. If the predicate flips at the wrong instant you can get a client-side
Ollama call that the server's `turnSequence` never sees, or a double call across the boundary.
This is adjacent to R1 and is not currently a named chaos experiment. See **MC-5**.

### 2.3 M7 strictly-newer gate / 409 LWW — PRESERVED for the poll path, but the WS push path has a SILENT-BREAK risk

This is the most important migration finding. The architecture asserts repeatedly (§2.2, §6.2,
Decisions-that-flow-forward) that "the M7 gate applies identically — `payload.savedAt > local` is
still the condition" on the `session:update` path. That assertion is **only safe if the server
stamps a strictly-monotonic `savedAt` on every broadcast and the broadcast carries it.** Three
concrete hazards the architecture does not close:

1. **`savedAt` is server-wall-clock (`new Date().toISOString()`), and `adopt()` compares it as a
   string.** Two `dm:done` broadcasts inside the same millisecond (possible on a fast LAN with a
   trivial mock or a fast model) produce equal `savedAt`, and the M7 gate is **strictly** greater
   (`payload.savedAt > local`), so the second update would be **rejected by every client** and the
   room would silently desync until the next strictly-newer write. The system already has a
   monotonic counter for exactly this — `turnSequence` — but the M7 gate ignores it and keys on
   `savedAt`. The gate should be reframed to admit a `session:update` when
   `turnSequence > localTurnSequence` **or** `savedAt > local`, with `turnSequence` authoritative
   for live multiplayer and `savedAt` retained for the offline/poll path. As written, the design
   reuses the timestamp gate verbatim and inherits a tie-break hole that single-player never
   exercised (one writer, 30 s apart). See **MC-6**.

2. **The `9999-12-31...` sentinel will silently swallow legitimate server pushes.** `onNewSession`
   sets `lastSavedAt.current = '9999-12-31T23:59:59.999Z'` to block resurrection of a cleared
   session. In single-player that sentinel is cleared on the first real turn (the PUT rebases on
   the server's post-DELETE stamp). In multiplayer, **the server is the writer**, so the client's
   own turn does not produce a local PUT that rebases `lastSavedAt` — the client receives a
   `session:update` from the server instead. Until something resets the sentinel, **every**
   server push fails `payload.savedAt > '9999-...'` and is dropped. The architecture says the
   sentinel is "unchanged" and "blocks resurrection via the WebSocket path just as it blocks the
   poll path" (§6.2) — but it never specifies what resets it in the WS world. If a host clears the
   session and then a new multiplayer session starts on the same client without a full remount,
   the client goes deaf to the server. See **MC-7**.

3. **The 409 path and the WS write path can both be live at once.** §6.2 keeps the 409 guard for
   "a concurrent PUT from an offline client." But in multiplayer the server is also writing the
   `.md` on every `dm:done` (§3.4 step 5). If an offline-rejoining client's queued PUT and a
   server-side `dm:done` write race, the per-id `withLock` serializes the file write (good), but
   the offline client's PUT will 409, and its **non-destructive** local state is then reconciled
   only by the next poll/push — which, per hazards 1 and 2, may itself be gated out. The
   composition of "server writes on dm:done" + "client may still PUT" + "M7 gate on push" is not
   analyzed as a system; each piece is individually described. This is the split-brain reintroduction
   the work order explicitly asks me to hunt for. It is latent, not proven-safe. See **MC-6/MC-7**
   (closing those closes this).

**Verdict on migration semantics:** `.md` and single-player are preserved; the M7/LWW story is
*asserted* to carry over but in fact relies on properties (monotonic tie-break, sentinel reset
under server-push) that the architecture does not establish. This is a silent-break class risk, and
it is the reason this review is not a clean APPROVE.

---

## 3. Failure-Mode Review (real vs asserted; testable vs not)

| Mode | Mitigation real (structural)? | Testable by the plans? | Verdict |
|------|------------------------------|------------------------|---------|
| **F1 DM double-trigger (R1)** | YES — per-room Promise-chain queue (the existing `withLock` pattern) + `awaiting-dm` set inside the lock before the Ollama fetch. Server is the sole caller. This is genuinely structural, not flag-based. | YES — QG-04 (zero overlapping Ollama calls), CON-02, EDGE-02/07, chaos EX-1 with a call-count assertion on mock Ollama. The mock-Ollama `getCallCount()` makes "exactly one" machine-checkable. | **REAL + TESTABLE.** The one residual is the single-player↔multiplayer boundary (MC-5), which is *not* in F1's blast radius and not in any chaos experiment. |
| **F2 split-brain (R2)** | PARTIAL — depends entirely on the M7 gate carrying over correctly. As written, see §2.3: the gate's strict-greater timestamp compare and the `9999` sentinel are holes under server-push. | PARTIALLY — EDGE-05/EDGE-11 and chaos EX-2 test the *poll-path* reconnect-adopt, and the abort conditions explicitly watch for the `9999` sentinel mis-firing. But no scenario exercises the **same-millisecond `savedAt` tie** (hazard 1) or **sentinel-deafness under pure server-push with no client PUT** (hazard 2). The tests would pass while the hole remains. | **ASSERTED where it matters most.** Testable only after MC-6/MC-7 reframe the gate around `turnSequence`; then EX-6 (gap detection) becomes the natural coverage. |
| **F3 dropped/rejoining player (R4)** | YES for stability (close handler, presence broadcast, party untouched because DM-owned), YES-as-documented-stall for the active-player-disconnect deadlock (v1 accepts host narration; no auto-bump). | YES — EDGE-03/04, chaos EX-7 assert no-crash, phase stays COMBAT, rejoin re-enables input. EX-7's abort condition explicitly asks whether a host "advance turn" escape hatch is needed. | **REAL + TESTABLE.** The stall is an accepted product decision (PRD 3.4), not a hidden defect. Acceptable for v1. |
| **F4 combat-turn desync (R5)** | YES in shape — `turnSequence` gap detection → request full `session:state`. This is the right pattern. | YES — EX-6 injects a dropped `session:update` and asserts gap-detect + resync + convergence; QG-03 times the flip. | **REAL + TESTABLE**, but note it depends on the very `turnSequence` authority that MC-6 says the *adopt gate* currently ignores. The desync mitigation keys on `turnSequence`; the adopt gate keys on `savedAt`. **These two must use the same authority** or a gap-triggered resync can itself be rejected by the timestamp gate. This inconsistency is internal to the architecture and must be reconciled. See **MC-6**. |
| **F5 Ollama mid-stream failure** | YES — try/catch, `dm:done {error,partial}`, phase reset, no `turnSequence` increment, no `.md` write, lock released. Mirrors the existing single-player error path in `Chat.jsx` (lines 275–280). | YES — EDGE-09/10, chaos EX-3 (three sub-scenarios: ECONNREFUSED, mid-abort, hang). | **REAL + TESTABLE**, with one genuine gap the chaos plan itself flags: **EX-3C (Ollama hangs forever) requires a request-timeout guard the architecture never specifies.** §3.5 says "one stream per action, sequentially" but defines no timeout. Without it the room wedges in `awaiting-dm` indefinitely and the queue never drains — a permanent denial of play. The chaos plan lists this exact abort condition ("> 90 s ... most dangerous failure"). The architecture must add an explicit server-side Ollama timeout. See **MC-8**. |
| **F6 server restart (R3/R2)** | YES — in-memory state lost, `.md` is the recovery point, clients backoff-reconnect and re-`join`, server re-reads `.md`. Consistent with the existing stateless-relay design. | YES — EDGE-06/11/12, chaos EX-5 (clean + mid-stream restart). | **REAL + TESTABLE.** Depends on the persisted `phase` being a resting phase (MC-4). |
| **F7 two players same combat turn (R5)** | YES — server checks `phase === combat` + case-insensitive `displayName` match before the queue; non-active → `NOT_YOUR_TURN`. | YES — EDGE-01, CON-03, chaos EX-4 with the abort condition "rejected action reaches Ollama" proving the check is *before* the queue. | **REAL + TESTABLE.** |

**Cross-cutting testability gap:** the latency criteria (PRD <500 ms propagation, <3 s join,
<500 ms turn-flip) are correctly pushed to manual/real-hardware runs (TEST-AUTOMATION §1.3,
QA MANUAL-04) because CI timing is flaky. That is the right call and not a defect — but it means
the headline PRD success metrics are validated only by one manual run. The QA plan should at least
record a CI-side *upper-bound smoke* (e.g. propagation under a generous 2 s on loopback) so a gross
regression is caught automatically. Minor; folded into **MC-9**.

---

## 4. Verdict

### **APPROVE-WITH-CHANGES**

**Reasoning.** The three load-bearing decisions are correct and well-grounded in the existing
system: server-authoritative state (extends Phase B's existing authority), WebSocket transport with
the poll retained as fallback (meets the latency target without removing the offline path), and a
server-side Ollama proxy as the *structural* single-DM-trigger (the right answer to R1, and
genuinely structural rather than flag-guarded). The schema-extension strategy respects the
"ONE payload shape" invariant, the `.md`/R3 constraint is honored, and `applyPartyUpdate`'s move to
`session.js` is clean. The failure-mode pre-analysis is unusually thorough and the three test
artifacts trace tightly to it (F1–F7 → QG/AC/EX with machine-checkable assertions like the
mock-Ollama call counter).

It is **not** a clean APPROVE because the design, as written, (a) misstates the one concrete
integration point it must hook (`createSyncServer` returns an `app`, not a server), (b) treats the
server-side DM call as a thin proxy while the real prompt-assembly pipeline it depends on lives
client-side and is unaddressed, and (c) *asserts* M7/LWW carry-over while in fact reusing a
timestamp gate that has a tie-break hole and a sentinel-deafness hole under server-push — exactly
the silent split-brain reintroduction this gate was asked to catch. None of these require
redesigning the architecture (so not REVISE); each is a bounded, specifiable change folded into the
document before G1.

### Itemized must-change list (each bound to an architecture section)

- **MC-1 — Name the `createSyncServer` refactor. [§2.1, §6.2 Step 1]**
  Specify that `createSyncServer` is changed to create and return the `http.Server`
  (e.g. `const server = http.createServer(app); return server`, or return `{ app, server }`), since
  `ws` must attach to an `http.Server` and today only the `isMain` block calls `app.listen()`. The
  HTTP routes and the `listen(0)` test harness depend on the new shape; state it explicitly so the
  test author's assumption (TEST-AUTOMATION §2.1) and the implementation agree.

- **MC-2 — Specify server-side prompt assembly. [§3.2, §3.4, new sub-section]**
  The server-side DM call must reproduce `Chat.jsx#sendMessage`'s request, not just `fetch` Ollama:
  `buildSystemPrompt(campaign)` + `extractEntities` + `trimContext` (all from the genre engine via
  `getGenre(campaign.genre)`), the dice→text transform with `pendingCheck` folding, and the Ollama
  `options`/`model`. State whether the genre engines move/are imported server-side (they are pure
  ESM and feasible) and — critically — how `pendingCheck` (session-only, never machine-restored per
  §1.2) reaches the server: either add it to the `action` envelope (§2.4) as an explicit
  per-action field, or document that the server reconstructs check context from the last `check`
  block. Do **not** have the client send a pre-built system prompt (defeats sole-authority + R4
  trust boundary).

- **MC-3 — `serializeSession` must carry the v2 fields. [§1.2, §6.2 Step 2]**
  The write path (`sync-server.mjs#put` rebuilds via `serializeSession`) currently drops everything
  outside `{campaign, messages, sessionLog, party}`. Specify that `serializeSession` is extended to
  include `phase`/`roomCode`/`turnSequence` so the HTTP PUT round-trip does not silently strip them.
  (Read-path/`toMarkdown` are already covered; this closes the write-path asymmetry.)

- **MC-4 — Sanitize non-resting phases on persist/load. [§1.2, §4.1, §6.3]**
  Define that `awaiting-dm` and `resolving` are never written as the resting `phase` (or are coerced
  to the pre-action phase on write), and that on `.md` load any `awaiting-dm`/`resolving` coerces to
  `free-roam`. This closes chaos EX-9 at the design level rather than leaving it to implementation.

- **MC-5 — Define the single-player↔multiplayer mode predicate precisely. [§3.2, §6.2 Step 4]**
  Replace "`connectionCount === 1` OR WS disconnected" with an unambiguous, edge-safe rule that
  resolves the startup window (WS open, no `presence:update` yet) and the player-leaves window, and
  guarantees a turn is never executed by *both* the client fetch and the server proxy across a mode
  flip. Add a chaos/QA scenario for the boundary (currently untested).

- **MC-6 — Reframe the adopt gate and desync detection around `turnSequence`, not `savedAt`. [§2.2, §3.3, §4, §6.2, §8 F2/F4]**
  The live-multiplayer adopt condition must admit a `session:update` when
  `turnSequence > localTurnSequence` (with `savedAt` retained for the offline/poll path), so that
  (a) two writes in the same millisecond do not tie out under the strict-greater timestamp compare,
  and (b) the F4 gap-resync (which keys on `turnSequence`) cannot be rejected by a gate that keys on
  `savedAt`. Today the architecture uses two different authorities for the same convergence problem.

- **MC-7 — Specify how the `9999` sentinel is reset under server-push. [§2.2, §6.2 Step 6]**
  In single-player the sentinel clears when the first real turn's PUT rebases `lastSavedAt`. Under
  server-push the client issues no PUT, so define the reset: e.g. a fresh `session:state` on
  (re)join authoritatively resets `lastSavedAt`/`turnSequence`, or `onNewSession` clears the
  sentinel once the new room's `session:state` arrives. Without this the client can go permanently
  deaf to server updates after a session clear.

- **MC-8 — Add an explicit server-side Ollama request/stream timeout. [§3.5, §8 F5]**
  Define a bounded timeout (the chaos plan suggests ~90 s on LAN) after which a hung Ollama stream
  is aborted, the queue lock released, `phase` reset, and `dm:done {error:true}` broadcast. Without
  it, EX-3C wedges the room indefinitely — the most dangerous failure in the chaos plan and
  currently unmitigated in the architecture.

- **MC-9 — Add a CI upper-bound smoke for propagation/turn-flip. [§7, QA §4]**
  Keep the precise latency numbers on manual hardware runs, but add one generous loopback smoke
  assertion (e.g. propagation under 2 s) so a gross real-time regression is caught in
  `npm test -- --run` rather than only at the single manual run.

**Folding note (per ORCHESTRATION §4, G2/G1 interaction):** APPROVE-WITH-CHANGES does not advance to
V1. MC-1 through MC-9 are folded into `MULTIPLAYER-ARCHITECTURE.md`; the three test-readiness
artifacts are refreshed against the revised sections (notably the prompt-assembly tests for MC-2,
the `turnSequence`-gate tests for MC-6, the sentinel-reset test for MC-7, and the Ollama-timeout
experiment EX-3C contract for MC-8). The updated design is what the user reviews at G1.

---

## References

- `docs/design/MULTIPLAYER-ARCHITECTURE.md` — §1.2 schema, §2 transport, §3 DM proxy, §4 state
  machine, §6 migration, §8 F1–F7
- `docs/design/MULTIPLAYER-PRD.md` — §5 success criteria, §6 constraints (R3, single-player)
- `docs/design/MULTIPLAYER-QA-PLAN.md` / `-TEST-AUTOMATION.md` / `-CHAOS-PLAN.md` — testability basis
- `docs/design/MULTIPLAYER-ORCHESTRATION.md` — §3.1 D3 work order, §4 gates, §5 risk register
- `src/lib/session.js` — `serializeSession`/`deserializeSession` (v1 reject branch), `toMarkdown`/
  `fromMarkdown`, `SCHEMA_VERSION`, `getLanHost`
- `src/hooks/useSessionPersistence.js` — `adopt()` M7 gate (strict-greater `savedAt`), `9999` sentinel
- `server/sync-server.mjs` — `createSyncServer` returns the Express `app`; `withLock`, 409, atomic
  write, `serializeSession` rebuild on PUT
- `src/components/Chat.jsx` — `sendMessage` prompt assembly, `pendingCheck` dice-folding,
  `applyPartyUpdate`, structured-block parse
- `src/lib/genres.js` / `src/lib/context.js` — genre engines (`buildSystemPrompt`/`extractEntities`/
  `trimContext`) the server-side DM call depends on
