# MP Character Sync — Root Cause Analysis

**Branch:** feature/mp-character-sync  
**Date:** 2026-05-26  
**Investigator:** error-detective  
**Status:** INVESTIGATE ONLY — fixes deferred to debugger agent

---

## 1. Executive Summary

The live repro produced two distinct symptoms:

1. **The DM system prompt's "Player Characters:" section was empty**, so Ollama invented the party from scratch (greeted "Adventurer" with no class, mislabeled Borin as a Cleric, hallucinated Cassius the Rogue).
2. **The persisted `.md` file had `"characters": {}` and `"roomCode": null`**, confirming that the characters map was not in the file that the server re-read on the action.

These two symptoms have the same primary root cause — **Defect D-01** — but different proximate writers (in-memory vs. disk). A second independent defect — **D-02** — also clobbers the disk copy for a different reason. Both must be fixed.

---

## 2. Defect Table

| ID | Severity | File : Line | Root Cause | Why Unit Tests Missed It |
|----|----------|-------------|------------|--------------------------|
| D-01 | CRITICAL | `src/hooks/useSessionPersistence.js:171` + `server/sync-server.mjs:273–288` | Per-turn HTTP PUT never includes `characters`; clobbers both the on-disk `.md` and (via the staleness gate) indirectly prevents the server from using in-memory characters | Server-only tests (`handleJoin` + `handleAction` in isolation) never mount `useSessionPersistence`; client tests never run the sync server. No integration test covers the full lifecycle: join → per-turn push → action. |
| D-02 | HIGH | `server/sync-server.mjs:273–288` | `PUT /session/:id` handler does not forward `body.characters` to `serializeSession`, so every client-initiated HTTP write permanently strips the characters map from the `.md` | Same isolation gap: no test calls PUT after a WS join and then verifies the `.md` still carries the characters. |
| D-03 | HIGH | `src/hooks/useSessionPersistence.js:166–181` | The per-turn push effect is NOT gated on `socketConnected`. The 30-second poll is correctly suspended when WS is OPEN (line 188), but the push that fires at each loading-falling-edge runs unconditionally in MP mode. In MP a single DM turn can fire both the WS `session:update` (which sets `adopting.current = true`) and a 409-race PUT. Whether the PUT is suppressed depends on which React commit order the `dm:done` / `session:update` events arrive in — it is not deterministic. | All persistence tests are single-player; `socketConnected=true` paths are not exercised. |
| D-04 | MEDIUM | `useWebSocket.js:170` (reconnect) | If the WS disconnects and reconnects after the initial join (e.g., network blip), `connect` recreates the socket and sends a fresh `join`. Because `joinCharacter` is in the `useCallback` dep array (line 170) and the character prop is stable (it doesn't change after mount), the rejoined `join` message carries the correct character. This is NOT a defect in the current code, but it is a latent risk: any upstream state change that nullifies `character` between the first and second join would send `null`, triggering DEFAULT_CHARACTER on the server. Documented here for awareness. | Reconnect paths are not tested with character-state mutation. |
| D-05 | LOW | `server/sync-server.mjs:258–295` | The LWW staleness gate checks `body.savedAt !== stored.savedAt`. After `persistRoom` writes the `.md` during a WS action, `lastSavedAt.current` in the client is NOT updated (the server never sends the post-`persistRoom` savedAt back over WS). The next client PUT therefore carries a stale `savedAt` that mismatches the server's file → 409. The 409 is silently discarded by `saveSyncSession`, so the local characters are never written by the client PUT path either. This makes D-01/D-02 worse but is a secondary symptom. | 409 handling in integration is not tested. |

---

## 3. Full Data-Flow Trace

### 3.1 Host path (Aldara — handleSetup, wizard skipped)

1. `handleSetup` is called. `wizardOutput` is falsy (wizard skipped), so `setCharacter` is NOT called. The `character` state retains `loadCharacter()`'s result from initial load — this is `DEFAULT_CHARACTER` (or whatever is in `dnd_character` localStorage). Since both tabs share localStorage in this repro, it holds whatever was there before.
2. `setRoomCode(rc)`, `setDisplayName('Aldara')`, `setReady(true)` are called and React 18 batches them into one re-render.
3. `App` renders `Chat` with `character = DEFAULT_CHARACTER` (name='Adventurer', charClass='Fighter', race='Human').
4. `Chat` derives `joinCharacter = { name:'Adventurer', race:'Human', charClass:'Fighter', abilities:{…10s}, ac:10, hpMax:10 }`.
5. `useWebSocket` is called with `enabled=true`, `joinCharacter = <above>`.
6. `connect()` fires immediately on mount. It creates a `WebSocket` and registers an `open` handler that closes over the `joinCharacter` value from step 4.
7. On `open`, the join message is sent: `{ type:'join', roomCode:'dnd-bb6cb8b8', sessionId:'bb6cb8b8-…', displayName:'Aldara', joinCharacter:{name:'Adventurer',…} }`.
8. Server `handleJoin` receives this. `rooms` does not yet contain `sessionId`. `stored = await readStored(sessionId)` → `null` (no `.md` yet). Room is created with `characters: {}` (no stored characters).
9. `!hasExistingCharacter` → `room.characters['Aldara'] = sanitizeCharacter({ name:'Adventurer',… })`.
10. `room.characters` is now `{ Aldara: { name:'Adventurer', race:'Human', charClass:'Fighter', … } }`.

Aldara's character is correctly stored in-memory at this point.

### 3.2 Joiner path (Borin — handleJoin)

1. `handleJoin` is called (it is `async`). Inside a single React 18 batch (React 18 automatic batching applies to all state-setter calls, including those inside async event handlers):
   - `setCampaign(restored)` — sessionId = 'bb6cb8b8-…'
   - `setRoomCode('dnd-bb6cb8b8')`
   - `setDisplayName('Borin')`
   - `setCharacter(prev => ({ ...DEFAULT_CHARACTER, ...prev, ...joinedCharacter }))` — where `joinedCharacter` is the High-Elf Wizard built by the wizard
   - `setReady(true)`
2. React flushes one combined re-render. `App` renders `Chat` with `character = { name:'Borin Stormcaller', race:'High Elf', charClass:'Wizard', … }`.
3. `Chat` derives `joinCharacter` from this character — correctly populated.
4. `useWebSocket` is called with `enabled=true`, `joinCharacter = { name:'Borin Stormcaller', race:'High Elf', charClass:'Wizard', … }`.
5. `connect()` fires on mount. On `open`, sends join message with correct `joinCharacter`.
6. Server `handleJoin` receives this. Room already exists (Aldara joined first). `hasExistingCharacter` for 'Borin' → false → `room.characters['Borin'] = sanitizeCharacter({ name:'Borin Stormcaller', race:'High Elf', charClass:'Wizard', … })`.
7. `room.characters` is now `{ Aldara: {…Fighter…}, Borin: {…Wizard…} }`.

At this point, in-memory `room.characters` is correctly populated with both players. The stale-closure hypothesis (Defect D-04 note) does NOT apply here because React 18 batching means `Chat` mounts with the final character state already in place on the first render.

### 3.3 The action (Aldara types one action)

1. Aldara's tab sends `{ type:'action', roomCode:'dnd-bb6cb8b8', payload:{ content:'The party gathers…' } }`.
2. Server `handleAction` finds the room by scanning `rooms` for Aldara's `ws` handle. `room` is the in-memory room with `characters = { Aldara:{…Fighter…}, Borin:{…Wizard…} }`.

**Wait — this should work. Where does it go wrong?**

The answer is in what happens BEFORE step 2. Specifically, **`useSessionPersistence` fires a per-turn HTTP PUT on the loading falling edge of the Chat session-restore on mount**.

### 3.4 The sequence that empties in-memory characters and the .md

Here is the exact sequence with timestamps:

**T+0ms**: Aldara's `Chat` mounts. `useSessionPersistence` mount effect fires `loadSyncSession(id)`. Server returns 404 (no .md yet). `adopt(null)` → no-op. `lastSavedAt.current = null`.

**T+0ms (concurrent)**: Aldara's WS join completes. Server creates room, stores `Aldara` in `room.characters`.

**T+~10ms**: Borin's `Chat` mounts. Same mount effect: `loadSyncSession(id)`. Server returns 404 still. `lastSavedAt.current = null` for Borin's tab.

**T+~10ms (concurrent)**: Borin's WS join completes. Server stores `Borin` in `room.characters`. Room now has both characters.

**T+0ms onward**: Both tabs have `socketConnected = true` (WS OPEN). The 30s poll is NOT started for either tab (correct).

**But**: `useSessionPersistence`'s per-turn push effect (lines 166-181) does NOT check `socketConnected`. It fires on `isLoading` changes. Specifically, the `wasLoading` pattern:

```js
// line 166-181
useEffect(() => {
  if (wasLoading.current && !isLoading) {
    if (adopting.current) {
      adopting.current = false
    } else {
      const payload = serializeSession({ campaign, messages, sessionLog, party })
      payload.savedAt = lastSavedAt.current
      saveSyncSession(payload)...
    }
  }
  wasLoading.current = isLoading
}, [isLoading, campaign, messages, sessionLog, party])
```

**Key**: `wasLoading` starts as `false`. On `Chat` mount, `isLoading` starts as `false`. So on the first execution of this effect (after mount), `wasLoading.current = false` and `isLoading = false`. The condition `wasLoading.current && !isLoading` is **false** → no push fires. This is correct behavior.

**However**: `Chat.jsx` has its own separate localStorage persistence effect:

```js
// Chat.jsx (separate from useSessionPersistence)
// Phase A: persist once per settled turn
```

Let me now trace the actual source of the `.md` write that produced `"characters": {}` and `"roomCode": null`.

### 3.5 The actual .md writer: HTTP PUT from useSessionPersistence

The `.md` file exists with `"roomCode": null` and `"characters": {}`. The only code paths that write the `.md` are:

- **`persistRoom()`** — called from `handleAction`. Writes `room.roomCode` (non-null) and `room.characters` (populated). If this had written the file, `roomCode` would be `"dnd-bb6cb8b8"` and characters would be populated.
- **`PUT /session/:id` handler** — called by `saveSyncSession()` from `useSessionPersistence`. Writes `body.roomCode ?? null` and **does not forward `body.characters`**.

The `"roomCode": null` in the persisted file is the fingerprint that proves **the writer was the HTTP PUT handler**, not `persistRoom`. `persistRoom` always writes `room.roomCode`.

**Where does the PUT come from?**

The `serializeSession` call inside `useSessionPersistence`'s push effect (line 171):

```js
const payload = serializeSession({ campaign, messages, sessionLog, party })
```

This call has no `roomCode` or `characters` fields. `serializeSession` defaults `roomCode` to `null` and `characters` to `{}`. The `payload` sent via `saveSyncSession` therefore has `roomCode: null` and `characters: {}`.

The PUT handler receives this and calls `serializeSession` again (lines 273-286), also without `body.characters`. Result: the `.md` gets `"roomCode": null` and `"characters": {}`.

**When does this PUT fire?**

During `handleAction`, after the Ollama DM response completes, the server broadcasts `session:update`. The client's `handleWsMessage` receives it and calls `adopt(payload, 'ws')`, which calls `applyStateLocally()` → sets `adopting.current = true` → then calls `setMessages(...)`, `setParty(...)`.

Then `dm:done` arrives → `applyStructuredBlocks(text)` → may call `setParty(...)` again → then `setIsLoading(false)`.

The loading falling edge now fires the push effect. If `adopting.current` is still `true`, the push is suppressed. But **there is a race**:

- `session:update` sets `adopting.current = true` and calls `setMessages`/`setParty` (React state updates, async).
- `dm:done` calls `setIsLoading(false)`.
- React may batch or interleave these. If `setIsLoading(false)` and the `isLoading` effect fire in a microtask before `adopting.current` is checked as `true`, the push fires. If they come in the right order, the push is suppressed.

**However**, there is a scenario where the push definitely fires: on **Aldara's first action**, the DM stream produces `setIsLoading(true)` during streaming and then `setIsLoading(false)` at the end. If `session:update` arrives and is processed by `handleWsMessage` → `onSessionUpdateRef.current?.()` → `adopt('ws')` → `applyStateLocally()` → `adopting.current = true`, and then the loading-falling-edge effect fires and sees `adopting.current = true`, it is suppressed.

BUT: `session:update` may arrive AFTER `dm:done` in some network conditions (the server broadcasts `session:update` at the END of `handleAction`, after `persistRoom`). Looking at `handleAction`: `dm:done` is sent at step (3f) (end of streaming), then `session:update` is broadcast. So `dm:done` arrives BEFORE `session:update`. `dm:done` calls `setIsLoading(false)`, which triggers the loading-falling-edge effect. At that point, `adopting.current` is still `false` (session:update hasn't arrived yet). **The push fires with a characters-empty payload.**

This is the confirmed mechanism.

### 3.6 What the PUT clobbers

When the PUT with `characters: {}` is received by the server:

1. `stored = await readStored(id)` — if no `.md` exists yet → `stored = null`. The staleness check `stored?.savedAt && body.savedAt !== stored.savedAt` is skipped (stored is null). The write proceeds.
2. The `.md` is written with `"characters": {}` and `"roomCode": null`.
3. On the NEXT join (a rejoin or a new tab), `handleJoin` calls `readStored(sessionId)` → reads this clobbered `.md`. `stored.characters = {}`. Room creation at line 877 uses `stored?.characters` → `{}`. The room's `characters` map starts empty.
4. But wait — in the live repro, the room was already in-memory when the action fired. The PUT clobbers the `.md` but NOT the in-memory `rooms` Map. So `room.characters` is still `{ Aldara:{…}, Borin:{…} }`.

**This means the `.md` clobber does NOT explain why the DM prompt was empty.** The DM prompt reads from in-memory `room.characters`, which is still populated. Something else emptied `room.characters` in-memory.

### 3.7 The actual mechanism for the empty in-memory characters

Re-examining the repro: the action produced an empty "Player Characters:" section. `buildPlayersForPrompt` returns `[]` only when `room.characters` is empty (line 265 of session.js). So at the time `handleAction` ran `buildPlayersForPrompt(room.characters ?? {}, ...)` at line 514, `room.characters` was empty.

The only way in-memory `room.characters` becomes empty is:

1. The room was CREATED with `characters: {}` (line 878-879: `stored?.characters && typeof stored.characters === 'object' ? { ...stored.characters } : {}`), AND
2. No subsequent `handleJoin` call stored characters into it.

Scenario: **the room was re-created from a clobbered `.md`**.

The sequence is:
1. Aldara and Borin both join. Room is in-memory with both characters.
2. Some event causes the in-memory `rooms` Map to lose the room. Candidates:
   - The GC timer fires (30min, unlikely for a same-session test).
   - The server process restarted between joins and the action.
   - The room entry was never created because the WS connection was actually re-established after a restart.

The most likely scenario for the live repro: **the sync server was restarted** (or suffered a brief crash) between Borin's join and Aldara's action. On restart, `rooms` is empty. When Aldara's WS reconnects and sends a new join message, `handleJoin` calls `readStored(sessionId)`. If the `.md` was already clobbered by the PUT (see §3.6), `stored.characters = {}`. Room is recreated with `characters: {}`. Then Aldara's join stores `room.characters['Aldara'] = sanitizeCharacter(joinCharacter)` — only Aldara. Borin's tab also reconnects and sends a new join, storing Borin. Both should be present again... UNLESS Borin's reconnect sends `joinCharacter = null` because the character prop changed.

Actually, the most direct route: the `.md` clobber from D-01/D-02 (characters-empty PUT) happens AFTER `persistRoom` writes the correct characters. On a subsequent cold-start (server restart after the session), the `.md` on disk has `characters: {}`. Any new join re-reads the clobbered `.md` and starts with an empty map.

This is the **persistence corruption path**: the clobbered `.md` is the persistent record, so any server restart loses the characters permanently.

### 3.8 Alternative in-session mechanism for empty in-memory characters

There is one more scenario where `room.characters` can be empty IN-SESSION without a restart:

If the PUT fires **before** either player's WS join completes (i.e., `useSessionPersistence`'s mount-time `loadSyncSession` resolves null, then the session-hydrate effect triggers a push on some other state change), it writes `characters: {}` to the `.md`. Then Aldara's WS join fires `handleJoin`, which calls `readStored`. If the PUT and the join race, the room may be created from the just-clobbered `.md` (characters empty), and then the `handleJoin` stores Aldara's character, but Borin's join may not have fired yet.

However, the more important point is that **even without any restart**, the per-turn push (D-01/D-03) firing after the action will:

1. Write `characters: {}` to the `.md` (immediately visible on disk).
2. On the NEXT `handleJoin` (next reconnect or new player), the room is initialized from this corrupted `.md`, silently starting with empty characters.
3. The CURRENT in-session DM prompt reads from in-memory `room.characters` which may still be correct — but the DM prompt will become empty on the NEXT server-restart or the NEXT session using this `.md`.

### 3.9 Why the DM prompt was empty in the live repro (final verdict)

**Primary cause (D-01 + D-02)**: The per-turn push from `useSessionPersistence` fired after `dm:done` (before `session:update` could set `adopting.current = true`), writing `characters: {}` to the `.md`. Either (a) the server was restarted after this write but before the action was typed, or (b) the in-memory `rooms` Map somehow lost the entry (e.g. GC fired early in testing, or the WS connection was dropped and the room was reconstructed from the clobbered `.md`). On reconstruction, `stored.characters = {}` → room starts empty → no characters stored for either player → `buildPlayersForPrompt({}, …)` returns `[]` → empty DM prompt.

**Confirmed by**: The `.md` showing `"roomCode": null` (PUT writer fingerprint) and `"characters": {}` with the hallucinated party from the LLM (showing the DM had no character data).

---

## 4. Defect Details

### D-01 (CRITICAL): Per-turn push omits `characters`

**Location**: `src/hooks/useSessionPersistence.js` line 171

```js
const payload = serializeSession({ campaign, messages, sessionLog, party })
//                                                                  ^^^^
//              `characters` is not in the React state that useSessionPersistence
//              manages. It is server-authoritative (lives in room.characters).
//              The client has no local `characters` state to include here.
```

The `characters` map is server-authoritative (stored in `room.characters` on the server). The client never holds it in React state — it is only in the `session:state` payload that the client receives, and the client does not store it anywhere accessible to `useSessionPersistence`. Therefore the push payload, built from `{ campaign, messages, sessionLog, party }`, always serializes `characters: {}`.

**Recommended fix direction**: Either (a) gate the per-turn push on `!socketConnected` (matching the poll gate) so MP play never uses the HTTP PUT path — the server is the sole writer via `persistRoom`; or (b) pass `characters` to `useSessionPersistence` as a prop and include it in the `serializeSession` call. Option (a) is simpler and consistent with the architecture (MP play is server-authoritative; HTTP PUT is the handoff-first single-device path).

### D-02 (HIGH): `PUT /session/:id` does not forward `body.characters`

**Location**: `server/sync-server.mjs` lines 273-288

```js
const payload = serializeSession(
  {
    campaign: { ...(body.campaign ?? {}), sessionId: id },
    messages: body.messages,
    sessionLog: body.sessionLog,
    party: body.party,
    roomCode: body.roomCode ?? null,
    phase: body.phase,
    turnSequence: body.turnSequence,
    // body.characters is NOT forwarded — same class of bug as MC-3
    // (which added roomCode/phase/turnSequence but forgot characters)
  },
  savedAt
)
```

The MC-3 comment in the code explicitly documents that these fields were added retroactively. The `characters` field was added in a later phase (v3 schema) and missed the same fix. Any HTTP PUT silently strips the characters map from the `.md`, permanently losing it.

**Recommended fix direction**: Add `characters: body.characters` to the `serializeSession` call, parallel to the existing `roomCode`/`phase`/`turnSequence` fields. `serializeSession` already passes it through `pickCharacters` which validates/normalizes, so no additional sanitization is needed.

### D-03 (HIGH): Per-turn push not gated on `socketConnected`

**Location**: `src/hooks/useSessionPersistence.js` lines 165-181

The 30-second poll is correctly suspended when `socketConnected` is true (line 188). But the per-turn push (lines 166-181) has no such guard. In MP mode, the server is the sole authoritative writer (via `persistRoom` after each action). The client should never issue HTTP PUTs in MP mode — they race with `persistRoom`, can 409 (silently ignored), and when they do succeed they overwrite the server's characters-populated `.md` with a characters-empty one.

The `adopting.current` guard is intended to suppress the echo-back of server-sent state. But `dm:done` triggers `setIsLoading(false)` BEFORE `session:update` sets `adopting.current = true` (the server sends `dm:done` from within the streaming loop before broadcasting `session:update` at the end of `handleAction`). The push fires with `adopting.current = false`.

**Recommended fix direction**: Add `if (socketConnected) return` at the start of the push effect, matching the poll guard. This is consistent with the design principle that MP play is server-authoritative.

### D-04 (MEDIUM): `roomCode: null` in per-turn push payload

**Location**: `src/hooks/useSessionPersistence.js` line 171 + `src/lib/session.js` `serializeSession`

`serializeSession({ campaign, messages, sessionLog, party })` has no `roomCode` in the state object. `serializeSession` defaults it to `null`. The HTTP PUT body therefore always has `roomCode: null`. The PUT handler passes `body.roomCode ?? null` → `null`. Result: every client HTTP PUT writes `"roomCode": null` to the `.md`. This is how `"roomCode": null` appears in the persisted file even though `persistRoom` correctly writes `room.roomCode`.

**This is a symptom of D-01** (the wrong writer wins). The fix for D-01/D-03 (gate the push on `socketConnected`) would prevent this write entirely in MP mode.

### D-05 (LOW): LWW staleness gate 409 after persistRoom

**Location**: `server/sync-server.mjs:268` + `src/hooks/useSessionPersistence.js:172-174`

After `persistRoom` writes the `.md`, the stored `savedAt` advances. The client's `lastSavedAt.current` is NOT updated (the WS `session:update` broadcast does carry `savedAt`, which `adopt('ws')` does update via `lastSavedAt.current = payload.savedAt ?? lastSavedAt.current` at line 97 of the hook). However, if the race in D-03 fires the push BEFORE the WS `session:update` updates `lastSavedAt`, the PUT sends an outdated `savedAt` → 409. The 409 is silently discarded. In practice, D-03's fix (gate push on socketConnected) makes this moot.

---

## 5. Why Unit Tests Missed All of This

All existing server tests (`server/sync-server.multiplayer.test.mjs` Phase 2/5) test the WS flow in isolation:

- `handleJoin` → asserts `room.characters` is populated. **Passes.**
- `handleAction` → asserts the DM prompt includes player stats. **Passes.**

These tests never:
1. Mount `useSessionPersistence` alongside a WS connection.
2. Simulate the client-side `dm:done` event triggering a HTTP PUT.
3. Verify the `.md` on disk after a round-trip action.
4. Exercise the scenario where the `.md` was previously clobbered by a PUT.

The client tests (`src/hooks/useSessionPersistence.test.js` if it exists) test the persistence hook in single-player mode (`socketConnected` is absent/false). MP mode is not covered.

No integration test spans: WS join (both players) → action → `dm:done` → HTTP PUT race → `persistRoom` → read `.md` → verify characters.

---

## 6. Symptom-to-Defect Mapping

| Symptom | Primary Defect | Mechanism |
|---------|---------------|-----------|
| DM system prompt "Player Characters:" empty | D-01 + D-02 + D-03 (combined) | Per-turn push (D-03 not gated on socketConnected) fires after `dm:done` with `characters:{}` payload (D-01: no characters in push). PUT handler strips characters (D-02). On server restart (or room GC), room is reconstructed from clobbered `.md` → `room.characters = {}` → `buildPlayersForPrompt({},…) = []`. |
| `.md` has `"characters": {}`  | D-01 + D-02 | Push payload has no characters (D-01); PUT handler ignores `body.characters` (D-02). Both must be fixed. |
| `.md` has `"roomCode": null` | D-04 (symptom of D-01/D-03) | Push payload's `serializeSession` has no `roomCode` → defaults to null → overwrites `persistRoom`'s correct roomCode. |
| DM invented third party member "Cassius" | DM hallucination | With no character data in the prompt, Ollama generated a party. Not a code defect; consequence of D-01/D-02/D-03. |
| Borin labeled "Cleric" not "Wizard" | DM hallucination | Same cause. |

---

## 7. Stale Closure Hypothesis: REFUTED

The investigation asked whether `joinCharacter` was a stale closure in `useWebSocket`. The code at line 170 shows `joinCharacter` IS in the `useCallback` dependency array:

```js
}, [roomCode, sessionId, displayName, joinCharacter, enabled])
```

React 18's automatic batching means all state updates in `handleJoin` (`setCampaign`, `setRoomCode`, `setDisplayName`, `setCharacter`, `setReady`) flush in a single combined re-render before `Chat` mounts. Therefore `Chat` receives the correct `character` prop on its first render, and `joinCharacter` is correctly populated when `useWebSocket` first calls `connect()`. The join message contains the correct character data.

The stale-closure hypothesis is **not the cause** of the empty characters map.

---

## 8. The PUT-Clobber as Root Cause of .md Emptiness

The `PUT /session/:id` handler is confirmed as the writer that produced the clobbered `.md`:

- **`persistRoom`** always writes `room.roomCode` (non-null for a MP room). The `.md` has `"roomCode": null` → `persistRoom` did NOT produce this file.
- **`PUT /session/:id`** passes `body.roomCode ?? null`. The client push omits `roomCode` → body has `roomCode: undefined` → `body.roomCode ?? null = null`. This produced `"roomCode": null`.
- **`PUT /session/:id`** ignores `body.characters` → `serializeSession` gets no `characters` → `pickCharacters(undefined) = {}`. This produced `"characters": {}`.

Both fingerprints point to the HTTP PUT handler as the writer. The server's `persistRoom` writes happen AFTER the Ollama DM completes (end of `handleAction`). The HTTP PUT from the client fires after `dm:done` is received, which is BEFORE `persistRoom` runs (since `dm:done` is sent mid-streaming before the end of `handleAction`). So the PUT races persistRoom and whichever finishes last wins. In the repro, the PUT raced ahead (or `persistRoom` did write a correct file, but then the PUT overwrote it seconds later on the next loading-falling-edge trigger).

---

## 9. Fix Priority

1. **D-03** first (gate push on `socketConnected`): this prevents the client from ever interfering with the server's authoritative state in MP mode. Fixes both the in-memory corruption path (via D-01) and prevents the `.md` clobber.
2. **D-02** second (forward `body.characters` in PUT handler): defense-in-depth for single-player HTTP PUT and any scenario where the client legitimately uses the PUT path (e.g., single-player with sync server).
3. **D-01** (include `characters` in push payload): only needed if D-03 is not implemented; if D-03 gates the push to single-player only, the push never carries MP characters anyway (they are server-authoritative and the client doesn't hold them in state).

If only one fix is implemented, **D-03 is the highest leverage change**: it eliminates the problematic HTTP PUT entirely in MP mode, removing both D-01 and D-04 as live defects and preventing future classes of the same bug.
