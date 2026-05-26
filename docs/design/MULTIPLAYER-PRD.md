# Multiplayer PRD — D&D Campaign Assistant

> **Owner:** product-manager (D1)  
> **Inputs:** MULTIPLAYER-ORCHESTRATION.md (§1 goals/non-goals, §5 risks); CLAUDE.md (architecture, structured-block protocol, sync design); project scope (hybrid play model, plan-first, LAN-only, 2–5 players).  
> **Status:** DESIGN-ARC, waiting for D2 game-developer input.

---

## 1. Player personas & flows

### 1.1 Personas

**Host / DM-Owner** ("Sam")
- Launches the app first on a trusted LAN device (desktop or laptop).
- Runs the local Ollama model (already running on the same machine or reachable on the network).
- Creates the campaign (genre, notes, Ollama model choice) and starts the first session.
- Invites other players to join by sharing a room code + LAN IP address or direct URL.
- May or may not play a character; often acts as GM-facilitator only, or claims one party slot.
- Drives resets, new sessions, or campaign transitions.
- Can save the campaign state to `.md` and resume later (single-player or multi).
- **Success:** invites arrive quickly, session stabilizes for 2–5 concurrent players, no double-DM output.

**Joining Player** ("Alex")
- Arrives on the LAN with a laptop or tablet.
- Receives a room code (or direct URL) from the host.
- Enters the code + display name and claims an available party slot (e.g. "Theron the Barbarian").
- Sees the existing session context (world state, message log, current party lineup) **within seconds**.
- Can immediately participate in freeform roleplay (exploration, dialogue, social scenes).
- When combat starts, respects the initiative order and waits for the `isActive` flag to turn green on their character.
- Can rejoin after a disconnect (same code + name → re-claims the same slot, no progress loss).
- **Success:** join latency < 3 seconds, session state is never stale by >1 turn, actions are acknowledged.

**Rejoin Player** ("Jordan")
- Left mid-session (device died, network hiccup, or deliberate step away).
- Rejoins with the same room code + original display name.
- System recognizes the name, syncs them to the current session state, and they resume in-place.
- If combat was in progress and they were on a future turn, they see combat HUD but wait their turn.
- **Success:** rejoin < 3 seconds, no message duplication, no desync with other players.

**Mid-Session Arrival** ("Casey")
- Joins while combat is underway and other players are mid-initiative.
- Waits for the DM to make a clear offer: "Do you want to join the fray?" (the DM re-emits the party block).
- Claims a new slot; the DM updates the party to add them, and they enter the initiative order for the next round.
- Or waits until the next scene (free-roam phase) to join with no role-breaking.
- **Success:** arrival is non-disruptive, the joining player understands where they are in the scene, no combat desync from a late arrival.

### 1.2 Flows

**First join (Sam creates session, Alex joins):**
1. Sam opens the app, sees setup screen, selects genre + campaign name + Ollama model.
2. Session mints a stable `sessionId` (UUID).
3. Sam shares a room code (e.g. `dnd-session-a1b2c`) derived from the `sessionId` + a display label.
4. Sam (or the app) displays the IP-based direct URL: `http://[LAN IP]:5173?room=dnd-session-a1b2c`.
5. Alex opens that URL (or navigates to `:5173` and pastes the room code).
6. Setup screen prompts: "Enter your name" (display name only, no password).
7. Alex submits → app pings the sync server: "Join session dnd-session-a1b2c as 'Alex'."
8. Server confirms the session exists and loads the current state.
9. Alex's client hydrates with the full session (messages, party, turn state) **within 1–2 seconds**.
10. Both Sam and Alex now see each other in the `party` strip/HUD (Sam sees "Alex | Rogue | 75 HP").
11. They can immediately play together.

**Rejoin after disconnect (Alex's network hiccup during freeform roleplay):**
1. Alex's browser auto-reconnects (WebSocket or polling) or Alex manually refreshes.
2. The app sends `joinSession(room, originalName)` to the sync server.
3. Server recognizes the name, loads the session, and checks `savedAt` timestamp.
4. Alex's client syncs to the latest server state (no prompt or confirmation; silent re-adoption).
5. Alex is back in place, sees the new messages while they were gone, and can resume.
6. If they were mid-message (draft text), the draft is lost (acceptable UX trade-off for LAN trust).

**Rejoin during mid-combat (Jordan was knocked unconscious, comes back online):**
1. Jordan rejoins via room code + name.
2. System recognizes them and syncs the current party state (including turn order, `isActive` flags).
3. Jordan sees the combat HUD: a visual turn tracker showing "Orcboss (DM) → Theron (Sam) → Jordan [WAITING]."
4. When the DM's turn comes around again and they update the party block, Jordan's `isActive` might flip to true.
5. Jordan sees their character name light up and can now act.

**Mid-session arrival during free-roam (Casey joins mid-exploration):**
1. Casey uses the room code to join; system adds them as a new `party` member.
2. The DM describes the scene and acknowledges Casey's arrival narratively: "A figure appears in the doorway."
3. Casey can immediately roleplay (they submit an action in the chat, and the DM responds).
4. No combat turn order is enforced yet.

**Combat transitions:**
- **Freeform → Combat:** DM posts a narrative turn, ends it with the party block listing all members + `isActive` for ONE player.
- The app UI changes: hidden combat HUD shows, desktop turn-pill lights up, mobile turn indicator appears.
- Each non-active player sees a grayed-out or waiting state.
- **Combat → Free-roam:** DM's next message has a party block with all `isActive: false`, or the block is omitted. UI reverts to freeform (free action text input, no turn enforcement).

---

## 2. Join & identity recommendation

### 2.1 Recommended model: Stateless room code + display name + LAN-trusted slot binding

**Proposed approach:**
1. **Room identity:** Each session gets a stable, human-readable **room code** (e.g. `dnd-session-a1b2c`) derived from the session UUID. No separate "room" entity; the code maps directly to a `sessionId`.
2. **Player identity:** Players enter a **display name only** (e.g. "Alex", "Jordan") — no password, no email, no account.
3. **Party slot binding:** A player's name is matched (case-insensitive, trimmed) against the current `party` array. If a match is found, they claim that slot. If not, they become a new member (the DM adds them via the next `party` block).
4. **Security boundary:** Trust is **per-LAN only**. Any device on the LAN can join with any name; we do not prevent name collision or spoofing. The host can manually eject or rename players if needed (out-of-band, via the sync server's `/session/:id DELETE` or a UI "kick" button, deferred to v2).
5. **Disconnect handling:** A player who disconnects and rejoins within a **30-minute session window** using the same room code + name re-claims their slot. After the session is archived or manually cleared, the code expires.

**Rationale:**
- **Minimal friction for LAN play:** A room code is easier to communicate than a UUID; display names are natural and require zero setup.
- **Name-match is already in the codebase:** `applyPartyUpdate` in `Chat.jsx` does name-based reconciliation (normalizes to lowercase/trimmed, matches against existing party). Multiplayer reuses this without code duplication.
- **LAN trust is appropriate:** The app is explicitly designed for a **home LAN**; there is no internet transit and no unknown actors (the host curates the guest list by physically handing out the code or URL).
- **Stateless reduces server surface:** The server doesn't track "user sessions" or "logged-in players" — it stores **one serialized session per room**, and each client independently associates with a room code. No session table bloat.
- **Graceful degradation:** If the sync server is down, clients fall back to localStorage (single-player), so the join/identity layer doesn't become a critical path.

**Mapping player → `party` slot (leveraging `applyPartyUpdate`):**
- The party array in the serialized session has the shape `[{ id, name, role, hpPct, isActive }, ...]`.
- When a player joins, they declare a **display name** (e.g. "Alex").
- The client searches the current `party` for a member with a matching name (same logic as `applyPartyUpdate`: normalize to lowercase, trim, compare).
- **Match found:** Player is assigned that member's `id` and `isActive` state. Their client remembers this `id` locally so they can claim the same slot if they disconnect/rejoin.
- **No match:** Player is a new member. Their client creates a local "pending" entry (`{ id: new UUID, name, role: '', hpPct: 0, isActive: false }`). On the next DM turn, the DM's `party` block either includes them (if the DM describes them) or doesn't (they stay pending). The "pending" entry is not persisted and vanishes on refresh; they must join again.
- **Practical example:**
  - Existing party: `[{ id: 'uuid-1', name: 'Theron', ... }, { id: 'uuid-2', name: 'Rogue', ... }]`
  - Alex joins as "Theron" → claimed `id: 'uuid-1'`, inherits role/hp/isActive from the party block.
  - Casey joins as "Mage" → no match, assigned a new local UUID, marked "PENDING" in the UI. Once the DM includes "Mage" in the next `party` block, Casey is anchored.

### 2.2 Rejected runner-up: Account-based identity with persistent player profiles

**Model:**
- Players create accounts (username + password) or authenticate via a guest token.
- The server maintains a player table and a session → players mapping.
- A player can rejoin any session they've ever been invited to, even weeks later.
- Roles, character sheets, and progression are tied to the account, not the session.

**Why rejected:**
- **Breaks LAN-only scope:** Accounts require at minimum hashing, rate-limiting, and session tokens. The entire auth surface expands the threat model beyond "trusted home LAN."
- **Kills `.md` save/continue:** A saved `.md` file can't carry account IDs (they're server-specific). When continuing a campaign weeks later on a different machine, the `.md` would need to re-bootstrap account identities, which defeats the portability goal.
- **Over-engineers for the use case:** 2–5 players on one LAN don't need persistent player profiles. If a player wants to keep their character, they save the campaign as `.md`.
- **Adds server complexity:** Player table, auth tokens, session→player bindings, password reset flows, etc. Multiplayer v1 should focus on coordination, not identity infrastructure.

### 2.3 Trust boundary (addressing R4 — LAN-only / no-auth security)

The app **explicitly trusts the LAN.**

- **What we defend:** Malformed/partial JSON in messages, bad timestamps, oversized payloads, rejection of incompatible schema versions (same defensive posture as Phase A/B today).
- **What we do NOT defend:** A device on the LAN claiming a player's name and hijacking their slot, or a malicious client crafting fake `party` blocks to corrupt game state. The host (Sam) is trusted to curate who gets the room code.
- **Practical recourse:** If a hostile actor joins, the host can manually eject them (out-of-band: kill the session, start a new one, or a future UI "kick" button). For v1, this is acceptable; account-based blocking is deferred.
- **Rationale:** A home LAN is physically controlled (family, close friends). The risk of insider attack is lower than the friction of setting up accounts. If the threat model changes (e.g. playing across WANs), the identity layer can be swapped without breaking the rest of multiplayer.

---

## 3. Hybrid model feel — free-roam vs combat transitions

### 3.1 Free-roam phase (default, exploration/roleplay)

**Player experience:**
- **Who can act:** Any player, at any time, in any order. Multiple players can type at once.
- **UI signals:**
  - Chat input is always enabled (no "waiting for your turn" state).
  - Party strip / HUD shows all members, no visual emphasis (equal footing).
  - Desktop turn-pill is **hidden or grayed out** (not relevant in free-roam).
- **DM behavior:** The DM responds to whichever action is most narratively interesting, or addresses multiple players in parallel roleplay. No enforced turn order; the session feels like a collaborative storytelling conversation.
- **Reconciliation:** Messages stream in from all clients in rough timestamp order. If two players message at once, the Ollama-selected response picks one action to respond to first (deterministic given the message order). The other player's action is queued for the next DM turn.

### 3.2 Combat phase (initiative-driven)

**Transition into combat:**
- **Trigger:** The DM writes a narrative turn that initiates combat (e.g. "A goblin leaps from the shadows, rolling initiative!"). At the **end of the message**, the DM emits a `party` block with **one member's `isActive: true`** and others `false`.
  - Example: ` ```party ` with `[{ name: 'Theron', ..., isActive: true }, { name: 'Alex', ..., isActive: false }, ...]`
- **UI transformation:**
  - **Desktop:** Turn-pill animates in at the top (showing "Theron's turn" or similar). Desktop turn-order sidebar (HistoryPanel) highlights Theron. Other players see their names grayed out.
  - **Mobile:** Party strip cells light up / fade per `isActive`. A prominent banner says "Combat active" with a turn timer or counter.
  - **All clients:** Chat input becomes **disabled** for non-active players, or shows a subtle "waiting" overlay. Active player's input is fully enabled and highlighted.

**During combat rounds:**
- **Active player actions:**
  - The player with `isActive: true` types an action (e.g. "I swing my sword at the goblin").
  - They submit. The action is sent to the DM (Ollama).
  - The DM responds with the outcome, then rolls initiative for the **next actor** and emits an updated `party` block (new `isActive: true` player).
- **Waiting players:**
  - See the current active player's name/action.
  - Cannot submit input (input is disabled or shows "It's not your turn").
  - See real-time updates as `isActive` flags flip.
  - Can read the message log and anticipate their turn.
- **Party strip HUD:** Flips through participants as turns progress (e.g. "→ Goblin (DM) → Theron (active) → Alex (waiting) → Rogue (waiting)"). Rounds loop until combat ends or someone is knocked out / flees.

### 3.3 Transition out of combat

**Exit trigger:** DM writes a narrative turn that ends the encounter (e.g. "The goblin retreats into the forest, defeated"). The `party` block is either:
- Omitted entirely, **or**
- Present but with **all `isActive: false`** (or some members absent if the DM wants to show defeats).

**UI transformation:**
- Turn-pill is **hidden or fades out**.
- Chat input becomes **fully enabled for all players again**.
- Party strip returns to equal display (no highlighting).
- Session returns to free-roam feel.

### 3.4 UI specifics (high-level; detailed by design-arc D2)

**Desktop experience (existing `HistoryPanel` evolution):**
- During free-roam: party list is static, turn-pill is hidden.
- During combat: party list gains a **turn indicator** (arrow or numbered sequence), current actor is highlighted in a color (e.g. gold border), waiting players are slightly dimmed.
- The turn-pill in the header (if present) shows "Theron's turn" or similar.

**Mobile experience (existing `PartyStrip` evolution):**
- Free-roam: 3-cell strip shows party in order, neutral styling.
- Combat: the active player's cell is highlighted (e.g. gold background or glow). Waiting cells are dimmed. A banner overlay at the top says "Combat in progress" with an optional round counter.

**Chat input:**
- Free-roam: always enabled, standard placeholder "What do you do?"
- Combat: active player sees "Your turn: describe your action," others see "Waiting for [name]'s action…" with a disabled/readonly input.

**Turn timing:**
- No hard timer; players take their turn when ready.
- DM is responsible for pacing (Ollama inherently has ~5–15 second latency per response, providing natural pacing).
- If a player is AFK, the host can manually bump the turn to the next player (deferred to v2; v1 relies on social cues).

---

## 4. MVP boundary & scope cuts

### 4.1 What ships in multiplayer v1

**Core multiplayer:**
- [ ] Room code + display name join flow (no authentication).
- [ ] Sync server extension to broadcast party/message updates to all clients on a room (via WebSocket or polling).
- [ ] Rejoin by room code + name (reconnect detection, state sync within <3 seconds).
- [ ] Single Ollama trigger (election or leader-based, specified in D2) — prevents DM double-output.
- [ ] Party state sync (existing `party` block protocol) — all clients see the same party lineup.
- [ ] `isActive` flag sync — clients see whose turn it is in real-time.

**Hybrid play model:**
- [ ] Free-roam input enabled for all (no turn enforcement).
- [ ] Combat phase detection via `isActive: true/false` in party block.
- [ ] Combat input disable/enable logic (input disabled for non-active players).
- [ ] Desktop turn-pill and mobile combat HUD (re-using existing `HistoryPanel` and `PartyStrip` styling, with combat overlays).

**Persistence & continuity:**
- [ ] `.md` save/continue survives multiplayer (session.js `toMarkdown`/`fromMarkdown` unchanged; server store remains markdown-based per CLAUDE.md Phase B).
- [ ] Single-player mode still works (a session with one player is indistinguishable from today; sync server gracefully serves single-client rooms).
- [ ] Session archival / clear session flow (host can end a session; new sessions mint new room codes).

**Message synchronization:**
- [ ] Messages stream to all clients (existing Ollama response structure; server broadcasts deltas).
- [ ] Structured-block parsing happens per-client (existing `Chat.jsx` parser, no change).
- [ ] Dice rolls sync (a local roll generates a dice message, which is broadcast like any other message).

### 4.2 Scope cuts (deferred to v2+)

**Identity & security:**
- No player accounts or authentication.
- No name collision detection / prevention (host manages manually if needed).
- No player "kick" / ejection UI (can restart the session).
- No password-protected rooms.
- No persistent player profiles or character progression tracking across sessions.

**Advanced combat features:**
- No automatic initiative tracking (DM writes initiative; `isActive` drives turn order, but there's no built-in d20 roller feeding an auto-sorted initiative list).
- No "ready action" or "reaction" mechanics (handled narratively by the DM; v1 is simple: one turn at a time, in order).
- No visibility / fog-of-war (all clients see all messages; the DM narrates hidden information).

**Rich media & expansion:**
- No voice/video (out-of-scope per orchestration plan).
- No map / grid-based movement (handled narratively).
- No character sheet UI beyond the existing `CharacterPanel` (which is already decoupled from the DM-managed party, so no conflict).
- No handout system for distributing information selectively.

**Server robustness (v1 is LAN-scoped; WAN upgrades are post-launch):**
- No server persistence beyond the session `.md` files (no database; server keeps in-memory state, reloads on restart).
- No session backup / undo (state is what it is; the last `.md` save is the recovery point).
- No server-side conflict resolution beyond the existing M7 strictly-newer gate (per CLAUDE.md).

### 4.3 Non-goals confirmed

- **No cloud hosting** — Ollama and sync server run locally on the LAN.
- **No WAN play** — Internet play is out-of-scope; firewall traversal / port forwarding is a stretch goal for docs, not a product feature.
- **No mobile rewrites** — Existing responsive design adapts mobile browsers; no native iOS/Android apps.
- **No `.md` removal** — `.md` save/continue is mandatory (overrides any plan that would drop it).
- **No dropping single-player** — A session with one client must work exactly as today.

---

## 5. Success criteria

**Acceptance threshold:** All criteria must be met before G1 (user approval).

### 5.1 Latency & responsiveness

- **Join time:** A new player can join and see the full session state (messages + party + current turn) within **< 3 seconds** (local LAN, Ollama on-device).
- **Rejoin time:** A returning player re-claims their slot within **< 3 seconds** after reconnecting.
- **Message propagation:** A message from one client appears on all other clients' screens within **< 500 ms** (includes Ollama response streaming).
- **Turn-state sync:** When the DM updates `isActive`, the flag flips on all clients within **< 500 ms** (controls HUD responsiveness in combat).

### 5.2 Stability & correctness

- **No DM double-output:** The DM triggers exactly once per turn, regardless of network flakiness or client count (single serialized trigger + election mechanism). Zero instances of duplicate Ollama calls or merged responses.
- **Message order preserved:** All clients receive and display messages in the same order (per server-stamped timestamp or sequence number).
- **Party state convergence:** After 60 seconds of no new updates, all clients agree on the current party composition, roles, HP, and `isActive` flags (M7 strictly-newer gate + LWW semantics).
- **No split-brain:** When a client rejoins after a network partition, it syncs to the server's authoritative state and does not display stale data.

### 5.3 Concurrent play

- **Max players:** The system supports 2–5 concurrent players on one LAN session (target is 5; must not degrade perceptibly up to 5).
- **Simultaneous actions:** Two players can submit actions in the same turn (free-roam) without message loss. The DM responds to one and queues the other for the next turn (deterministic order).
- **Combat turn order:** During combat, only the active player can submit an action; others see a "waiting" state. Transition to the next turn happens within **< 1 second** of the DM's response.

### 5.4 Persistence & recovery

- **Session continuity:** A saved `.md` file can be loaded by any client (including from a different machine) and resumes the session with full state (messages, party, turn state) restored.
- **Disconnect recovery:** A player who drops and rejoins within the session lifetime (30 min or until archived) is restored to their exact game state with no message duplication or state rewind.
- **Server failure recovery:** If the sync server restarts, existing client sessions degrade to localStorage-only (single-player mode) until the server is back online, at which point they re-sync without data loss.

### 5.5 User experience

- **No cognitive overload:** New players understand the join flow in < 30 seconds (room code + name + see the party list).
- **Combat clarity:** During combat, a non-active player can read the UI and know exactly whose turn it is and when theirs will come (turn order is visually obvious, not inferred).
- **Error handling:** Malformed or stale messages are silently dropped (existing defensive parsing in `Chat.jsx`); the UX never shows a cryptic error or crashes.

### 5.6 Backward compatibility

- **Single-player survival:** An existing single-player session (one client, same room code) behaves identically to today (localStorage sync + `.md` save/continue).
- **`.md` handoff unbroken:** A `.md` file saved from multiplayer v1 loads identically in single-player v1 and vice versa (no schema drift).

---

## 6. Constraints honored

### 6.1 Markdown save/continue (R3 — mandatory preservation)

The hard constraint from memory `md-save-continue-requirement.md`: **`.md` save/continue must survive multiplayer.**

**How we honor it:**
- The session payload schema in `src/lib/session.js` is **unchanged** (or extended with new optional fields that degrade gracefully). The `toMarkdown` and `fromMarkdown` functions continue to work as today.
- When a multi-player session is saved to `.md`, the file includes the full party state and message log (plus a trailing ` ```session ` block with the serialized `sessionId`, `campaign`, etc.).
- A single player can load that `.md` and resume the session (even if the original room code has expired), by restoring the `sessionId` and adopting the file's `campaign` + `messages` + `party`.
- The sync server store (`server/sessions/` folder) continues to hold serialized sessions as `.md` files (per CLAUDE.md Phase B), **not** a database.
- **No breaking changes to the serialize layer** — D2 architect must explicitly document how schema version bumps (if any) preserve backward compatibility.

### 6.2 Single-player survival (non-goal but inviolable)

An existing single-player session (one browser, one room code) must work identically to today.

**How we honor it:**
- A room with one client sees no behavioral difference (the sync server treats it the same as a room with 5 clients, just with one active connection).
- All multiplayer-specific features (turn-state sync, message broadcast, etc.) operate transparently when there is only one client.
- The offline fallback (localStorage + silent degradation when sync server is down) remains unchanged.
- Tests in v2 will explicitly verify that a single-player session still passes the full test suite.

---

## 7. Decisions that flow forward

This section is the crisp handoff for the game-developer (D2) and subsequent stages. Each item is **decision-dense** and **unambiguous**.

### Join & identity model

**Chosen:** Stateless room code + display name + LAN-trusted name-matching slot binding.

- **Room identity:** Session UUID → human-readable room code (e.g. `dnd-session-a1b2c`, stable for the session lifetime).
- **Player identity:** Display name only (text input at join, no password, no account).
- **Slot binding:** Name-match (case-insensitive, trimmed) against the `party` array. Reuses `applyPartyUpdate` logic from `Chat.jsx` (no new string-matching code). New players get a new UUID; existing name + new UUID = a re-claimed slot.
- **Rejoin:** Same room code + original name within 30 minutes → silent sync to server state, no prompt.
- **Trust boundary:** LAN-only; the host curates who gets the code. No account-based security in v1. Hostile client joining = host manual eject (out-of-band) or restart session (v2: add UI "kick" button).

### MVP feature list

**Transport & sync:**
- [ ] Extend sync server to broadcast session updates (party + messages) to all connected clients on a room (WebSocket or long-polling, specified in D2).
- [ ] Detect client reconnect + automatically re-sync latest state (M7 strictly-newer gate applied per-client).

**Single-DM trigger:**
- [ ] Elect or designate one client (host or latest joiner) as the DM trigger point.
- [ ] That client is the only one that POSTs to Ollama; all other clients receive the streaming response via the sync server (not direct Ollama polling).
- [ ] Serialize trigger calls to prevent concurrent Ollama requests from the same room.

**Party & combat:**
- [ ] Sync the `party` array on every DM turn (no client state drift).
- [ ] Sync `isActive` flag in real-time (each client updates UI immediately when a flag flips).
- [ ] Client-side input enforcement: disable chat input for non-active players during combat (`isActive === false` → readonly input + "waiting" overlay).
- [ ] Desktop turn-pill + mobile combat HUD (evolution of existing `HistoryPanel` and `PartyStrip` to visualize active player and turn order during combat).

**Persistence:**
- [ ] Sync server store remains `.md` files (no database, reuses `toMarkdown`/`fromMarkdown` from `session.js`).
- [ ] `SCHEMA_VERSION` in `session.js` bumped to 2 if new fields are added; old v1 sessions load with defaults for missing fields (graceful degradation).
- [ ] Test suite includes `.md` load/save round-trip for multi-player sessions.

**Rejoin & error handling:**
- [ ] Orphaned dice marker (existing `markOrphanedDice` in `session.js`) handles restored sessions correctly in a multi-client context (fresh rolls resolve; old restored rolls don't).
- [ ] Malformed messages are silently dropped; parsing never throws (existing defensive posture in `Chat.jsx`, extended to new multi-client fields).

### Player → `party`-slot mapping rule

**Binding strategy:**
1. A player submits a **display name** (freeform text, trimmed and lowercased for comparison).
2. The client checks the current `party` array for a **case-insensitive name match** (using the same normalization as `applyPartyUpdate` in `Chat.jsx`).
3. **Match found:** Player inherits the matched member's `id`, `role`, `hpPct`, `isActive` from the party block. They are now the active controller of that party member.
4. **No match:** Player is a **new member**. Their client creates a pending entry with a new UUID, empty role, 0 HP, `isActive: false`. On the next DM turn, if the DM's `party` block includes a member with the player's name, the pending entry is replaced and the player is anchored. If not included, the pending entry remains until explicitly removed or the client resets.
5. **Rejoin:** Same logic — match by name, claim the slot. The player's `id` does not change between rejoins (name is the anchor).

**Consequence:** The `party` array is the single source of truth for who exists and what state they have. The DM controls party composition; clients follow.

### Success criteria (acceptance gates for G1)

**Latency:**
- Join time: < 3 seconds (full state sync on new room-join).
- Rejoin time: < 3 seconds (reconnect + re-sync).
- Message propagation: < 500 ms (client broadcast).
- Turn-state sync (isActive flip): < 500 ms.

**Stability:**
- DM double-output: zero instances (single serialized trigger, enforced by architecture).
- Message order: preserved on all clients (server-stamped or sequenced).
- Party state convergence: within 60 seconds of no new updates (M7 gate + LWW).
- No split-brain after reconnect (server-authoritative + strictly-newer gate).

**Concurrency:**
- Max players: support 2–5 concurrent without degradation.
- Simultaneous actions (free-roam): both messages arrive, DM responds to one, other queues for next turn.
- Combat turn order: only active player can submit; transition < 1 second.

**Persistence:**
- `.md` save/continue unbroken (load from file = full state restore).
- Disconnect recovery: rejoin restores exact state, no duplication.
- Server restart: clients degrade to localStorage (single-player mode), re-sync on server recovery.

**UX:**
- Join flow < 30 seconds (room code + name + see party).
- Combat clarity (UI shows turn order, who's active, who's waiting).
- Error silence (no crashes, malformed data silently dropped).

**Backward compatibility:**
- Single-player sessions work identically to today.
- `.md` load/save round-trip identical (schema version handled gracefully).

---

## 8. References

- **MULTIPLAYER-ORCHESTRATION.md** — the authoritative orchestration plan (goals, risks, stage dependencies).
- **CLAUDE.md** — architecture, structured-block protocol (`party`/`check`/`verdict`), Phase A/B/B2 sync design, session payload shape.
- **src/components/Chat.jsx** — `applyPartyUpdate` (name-match logic), structured-block parser, Ollama POST trigger.
- **src/lib/session.js** — `serializeSession`/`deserializeSession`, `toMarkdown`/`fromMarkdown`, payload schema, `getLanHost`.
- **src/hooks/useSessionPersistence.js** — Phase B LAN sync layer (server-authoritative, 30s poll, M7 strictly-newer gate).
- **server/sync-server.mjs** — Express LAN server, per-session lock, atomic writes, per-id `.md` store.
- **Memory:** `md-save-continue-requirement.md` (overrides any plan that drops `.md` save/continue).
