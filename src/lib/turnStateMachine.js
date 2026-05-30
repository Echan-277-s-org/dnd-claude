// ─── Turn/Phase State Machine (Phase 5) ────────────────────────────────────
// Pure reducer — no React, no Node, no side effects.
// Shared by the client (browser) and the server (Node ESM import) so the
// phase-transition logic lives in ONE place.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §4.1, §4.2, §4.4
//
// Sentinel return values (never persisted, never broadcast as a real phase):
//   'DM_BUSY'       — action rejected; DM trigger is already in flight
//   'NOT_YOUR_TURN' — combat action rejected; sender is not the active member
//   'NOT_STARTED'   — action rejected; the room is still in the pregame lobby

/**
 * isActiveTurn(displayName, party) → boolean
 *
 * Returns true iff some party member has isActive === true AND
 * member.name (trimmed, lowercased) matches displayName (trimmed, lowercased).
 *
 * Returns false when:
 *   - party is absent/empty
 *   - displayName is absent/falsy
 *   - no member with isActive === true matches the displayName
 *
 * Case-insensitive and whitespace-trim-insensitive (security item C).
 */
export function isActiveTurn(displayName, party) {
  if (!displayName) return false
  if (!Array.isArray(party) || party.length === 0) return false
  const needle = String(displayName).trim().toLowerCase()
  if (!needle) return false
  return party.some(
    m => m.isActive === true &&
      String(m.name ?? '').trim().toLowerCase() === needle
  )
}

/**
 * phaseReducer(currentPhase, event, context = {}) → nextPhase | sentinel
 *
 * Pure phase-transition reducer. Never mutates; always returns a string.
 *
 * @param {string|null} currentPhase - current phase string (or null on first init)
 * @param {{ type: string, displayName?: string, party?: object[], phase?: string }} event
 * @param {{ party?: object[] }} [context] - room context (party for active-turn check)
 * @returns {string} next phase, or a sentinel string if the action is rejected
 *
 * Transition table (MULTIPLAYER-ARCHITECTURE.md §4.2):
 *
 * | From            | Event type        | Guard                          | To              |
 * |-----------------|-------------------|--------------------------------|-----------------|
 * | free-roam       | action            | —                              | awaiting-dm     |
 * | awaiting-dm     | action            | —                              | DM_BUSY         |
 * | resolving       | action            | —                              | DM_BUSY         |
 * | awaiting-dm     | dm:done / resolved| party has isActive?            | combat / free-roam |
 * | resolving       | dm:done / resolved| party has isActive?            | combat / free-roam |
 * | combat          | dm:done / resolved| party has isActive?            | combat / free-roam |
 * | combat          | action            | isActiveTurn(dn, ctx.party)?   | awaiting-dm / NOT_YOUR_TURN |
 * | lobby           | start             | —                              | free-roam       |
 * | lobby           | action            | —                              | NOT_STARTED     |
 * | null/undefined  | room:init         | —                              | event.phase     |
 * | any             | (other)           | —                              | currentPhase (unchanged) |
 */
export function phaseReducer(currentPhase, event, context = {}) {
  const { type } = event ?? {}

  // ── room:init — authoritative phase restore from .md (server restart / reconnect)
  if ((currentPhase == null) && type === 'room:init') {
    return event.phase ?? 'free-roam'
  }

  // ── start — host launches the adventure from the pregame lobby.
  if (type === 'start') {
    return currentPhase === 'lobby' ? 'free-roam' : currentPhase
  }

  switch (type) {
    case 'action': {
      // Pregame lobby: no actions are accepted until the host starts the game.
      if (currentPhase === 'lobby') {
        return 'NOT_STARTED'
      }
      if (currentPhase === 'free-roam') {
        return 'awaiting-dm'
      }
      if (currentPhase === 'awaiting-dm' || currentPhase === 'resolving') {
        return 'DM_BUSY'
      }
      if (currentPhase === 'combat') {
        // Only the connection-bound active player may act in combat.
        const { displayName } = event ?? {}
        const partyToCheck = context?.party ?? []
        if (isActiveTurn(displayName, partyToCheck)) {
          return 'awaiting-dm'
        }
        return 'NOT_YOUR_TURN'
      }
      // Unknown current phase — unchanged
      return currentPhase
    }

    case 'dm:done':
    case 'resolved': {
      // Applies from awaiting-dm, resolving, OR combat (turn passes).
      if (
        currentPhase === 'awaiting-dm' ||
        currentPhase === 'resolving' ||
        currentPhase === 'combat'
      ) {
        const party = event?.party
        if (Array.isArray(party) && party.some(m => m.isActive)) {
          return 'combat'
        }
        return 'free-roam'
      }
      return currentPhase
    }

    default:
      return currentPhase
  }
}
