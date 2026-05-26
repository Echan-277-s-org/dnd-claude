// @vitest-environment jsdom
//
// Turn/phase state-machine pure reducer tests — Phase 4/5 gate (unit tier)
//
// ALL TESTS ARE SKIPPED. No implementation exists yet.
// These tests assert the pure phase-transition logic described in
// MULTIPLAYER-ARCHITECTURE.md §4 as a standalone reducer so it can be
// tested without a real WebSocket or server.
//
// The reducer signature (subject to change during implementation):
//   phaseReducer(currentPhase, event, context) → nextPhase
//
// Where `event` is one of the wire-format message types, and `context` carries
// the party array and the acting displayName.
//
// If the final implementation embeds the state machine inside sync-server.mjs
// rather than exporting it as a standalone module, move these assertions into
// sync-server.multiplayer.test.mjs (Phase 5 describe block) instead.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §4.1, §4.2, §4.4

import { describe, it, expect } from 'vitest'
// import { phaseReducer } from './turnStateMachine'   // to-be-created module
// OR if the logic lives in sync-server.mjs:
// import { phaseReducer } from '../../server/sync-server.mjs'

const PARTY_FREE = [
  { id: 'p1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: false },
  { id: 'p2', name: 'Wren', role: 'Rogue', hpPct: 60, isActive: false },
]

const PARTY_COMBAT_THERON = [
  { id: 'p1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: true },
  { id: 'p2', name: 'Wren', role: 'Rogue', hpPct: 60, isActive: false },
]

// ─── FREE_ROAM transitions ────────────────────────────────────────────────────

describe.skip('phaseReducer — FREE_ROAM transitions', () => {
  it('FREE_ROAM + any player action → AWAITING_DM', () => {
    // const next = phaseReducer('free-roam', { type: 'action', displayName: 'Theron' }, { party: PARTY_FREE })
    // expect(next).toBe('awaiting-dm')
  })

  it('FREE_ROAM + second action while AWAITING_DM in queue → rejected with DM_BUSY', () => {
    // The queue serialization test belongs in the server integration tier.
    // Here we verify that the REDUCER itself emits the correct phase for the
    // second action when currentPhase is already awaiting-dm.
    // const next = phaseReducer('awaiting-dm', { type: 'action', displayName: 'Wren' }, { party: PARTY_FREE })
    // expect(next).toBe('DM_BUSY') // sentinel value; actual error broadcast is server concern
  })
})

// ─── AWAITING_DM transitions ──────────────────────────────────────────────────

describe.skip('phaseReducer — AWAITING_DM transitions', () => {
  it('AWAITING_DM + Ollama stream done + party all isActive:false → FREE_ROAM', () => {
    // const next = phaseReducer('awaiting-dm', { type: 'dm:done', party: PARTY_FREE }, {})
    // expect(next).toBe('free-roam')
  })

  it('AWAITING_DM + Ollama stream done + one isActive:true → COMBAT', () => {
    // const next = phaseReducer('awaiting-dm', { type: 'dm:done', party: PARTY_COMBAT_THERON }, {})
    // expect(next).toBe('combat')
  })

  it('AWAITING_DM + party block absent (no block emitted by DM) → phase unchanged (AWAITING_DM → FREE_ROAM fallback)', () => {
    // Architecture: no party block → phase unchanged; but dm:done always resolves.
    // Convention: if no party block is emitted, server falls back to free-roam.
    // const next = phaseReducer('awaiting-dm', { type: 'dm:done', party: null }, {})
    // expect(next).toBe('free-roam')
  })
})

// ─── COMBAT transitions ───────────────────────────────────────────────────────

describe.skip('phaseReducer — COMBAT transitions', () => {
  it('COMBAT + active player action → AWAITING_DM (accepted)', () => {
    // const next = phaseReducer(
    //   'combat',
    //   { type: 'action', displayName: 'Theron' },
    //   { party: PARTY_COMBAT_THERON }
    // )
    // expect(next).toBe('awaiting-dm')
  })

  it('COMBAT + non-active player action → NOT_YOUR_TURN (phase stays COMBAT)', () => {
    // const next = phaseReducer(
    //   'combat',
    //   { type: 'action', displayName: 'Wren' }, // Wren is not isActive
    //   { party: PARTY_COMBAT_THERON }
    // )
    // expect(next).toBe('NOT_YOUR_TURN')
  })

  it('COMBAT + dm:done with all isActive:false → FREE_ROAM', () => {
    // const next = phaseReducer(
    //   'combat',
    //   { type: 'dm:done', party: PARTY_FREE },
    //   { party: PARTY_FREE }
    // )
    // expect(next).toBe('free-roam')
  })

  it('COMBAT + dm:done with a NEW active member → COMBAT (turn passes)', () => {
    // const partyWrenActive = [
    //   { id: 'p1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: false },
    //   { id: 'p2', name: 'Wren',   role: 'Rogue',   hpPct: 60, isActive: true  },
    // ]
    // const next = phaseReducer(
    //   'combat',
    //   { type: 'dm:done', party: partyWrenActive },
    //   {}
    // )
    // expect(next).toBe('combat')
  })
})

// ─── RESOLVING transitions ────────────────────────────────────────────────────

describe.skip('phaseReducer — RESOLVING transitions', () => {
  it('RESOLVING + blocks parsed + persisted → FREE_ROAM (all isActive:false)', () => {
    // const next = phaseReducer('resolving', { type: 'resolved', party: PARTY_FREE }, {})
    // expect(next).toBe('free-roam')
  })

  it('RESOLVING + any player action → DM_BUSY', () => {
    // const next = phaseReducer('resolving', { type: 'action', displayName: 'Theron' }, { party: PARTY_FREE })
    // expect(next).toBe('DM_BUSY')
  })
})

// ─── reconnect / server-restart ───────────────────────────────────────────────

describe.skip('phaseReducer — reconnect restores phase from .md', () => {
  it('any state + server restart → current phase from .md store (authoritative)', () => {
    // This is a server-level concern (the server reads the .md and sends session:state).
    // The reducer test here verifies that when the server re-initialises a room, it
    // seeds phase from the deserialized payload, not from a hardcoded default.
    // const restoredPhase = 'combat'   // as read from the .md
    // const next = phaseReducer(null, { type: 'room:init', phase: restoredPhase }, {})
    // expect(next).toBe('combat')
  })
})

// ─── displayName matching (case-insensitive active-player check) ───────────────

describe.skip('active player check — case-insensitive displayName matching', () => {
  it('matches "theron" against "Theron" in the party array', () => {
    // const isActive = isActiveTurn('theron', PARTY_COMBAT_THERON)
    // expect(isActive).toBe(true)
  })

  it('does not match "wren" against "Theron" (Wren is not the active player)', () => {
    // const isActive = isActiveTurn('wren', PARTY_COMBAT_THERON)
    // expect(isActive).toBe(false)
  })

  it('returns false for a displayName not in the party at all', () => {
    // const isActive = isActiveTurn('casey', PARTY_COMBAT_THERON)
    // expect(isActive).toBe(false)
  })
})
