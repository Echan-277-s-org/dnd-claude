// @vitest-environment jsdom
//
// Turn/phase state-machine pure reducer tests — Phase 4/5 gate (unit tier)
//
// All describes are now ACTIVE (no skip). The module under test is the new
// pure reducer src/lib/turnStateMachine.js.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §4.1, §4.2, §4.4

import { describe, it, expect } from 'vitest'
import { phaseReducer, isActiveTurn } from './turnStateMachine.js'

const PARTY_FREE = [
  { id: 'p1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: false },
  { id: 'p2', name: 'Wren', role: 'Rogue', hpPct: 60, isActive: false },
]

const PARTY_COMBAT_THERON = [
  { id: 'p1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: true },
  { id: 'p2', name: 'Wren', role: 'Rogue', hpPct: 60, isActive: false },
]

// ─── FREE_ROAM transitions ────────────────────────────────────────────────────

describe('phaseReducer — FREE_ROAM transitions', () => {
  it('FREE_ROAM + any player action → AWAITING_DM', () => {
    const next = phaseReducer('free-roam', { type: 'action', displayName: 'Theron' }, { party: PARTY_FREE })
    expect(next).toBe('awaiting-dm')
  })

  it('FREE_ROAM + second action while AWAITING_DM in queue → rejected with DM_BUSY', () => {
    // The queue serialization test belongs in the server integration tier.
    // Here we verify that the REDUCER itself emits the correct phase for the
    // second action when currentPhase is already awaiting-dm.
    const next = phaseReducer('awaiting-dm', { type: 'action', displayName: 'Wren' }, { party: PARTY_FREE })
    expect(next).toBe('DM_BUSY') // sentinel value; actual error broadcast is server concern
  })
})

// ─── AWAITING_DM transitions ──────────────────────────────────────────────────

describe('phaseReducer — AWAITING_DM transitions', () => {
  it('AWAITING_DM + Ollama stream done + party all isActive:false → FREE_ROAM', () => {
    const next = phaseReducer('awaiting-dm', { type: 'dm:done', party: PARTY_FREE }, {})
    expect(next).toBe('free-roam')
  })

  it('AWAITING_DM + Ollama stream done + one isActive:true → COMBAT', () => {
    const next = phaseReducer('awaiting-dm', { type: 'dm:done', party: PARTY_COMBAT_THERON }, {})
    expect(next).toBe('combat')
  })

  it('AWAITING_DM + party block absent (no block emitted by DM) → phase unchanged (AWAITING_DM → FREE_ROAM fallback)', () => {
    // Architecture: no party block → phase unchanged; but dm:done always resolves.
    // Convention: if no party block is emitted, server falls back to free-roam.
    const next = phaseReducer('awaiting-dm', { type: 'dm:done', party: null }, {})
    expect(next).toBe('free-roam')
  })
})

// ─── COMBAT transitions ───────────────────────────────────────────────────────

describe('phaseReducer — COMBAT transitions', () => {
  it('COMBAT + active player action → AWAITING_DM (accepted)', () => {
    const next = phaseReducer(
      'combat',
      { type: 'action', displayName: 'Theron' },
      { party: PARTY_COMBAT_THERON }
    )
    expect(next).toBe('awaiting-dm')
  })

  it('COMBAT + non-active player action → NOT_YOUR_TURN (phase stays COMBAT)', () => {
    const next = phaseReducer(
      'combat',
      { type: 'action', displayName: 'Wren' }, // Wren is not isActive
      { party: PARTY_COMBAT_THERON }
    )
    expect(next).toBe('NOT_YOUR_TURN')
  })

  it('COMBAT + dm:done with all isActive:false → FREE_ROAM', () => {
    const next = phaseReducer(
      'combat',
      { type: 'dm:done', party: PARTY_FREE },
      { party: PARTY_FREE }
    )
    expect(next).toBe('free-roam')
  })

  it('COMBAT + dm:done with a NEW active member → COMBAT (turn passes)', () => {
    const partyWrenActive = [
      { id: 'p1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: false },
      { id: 'p2', name: 'Wren',   role: 'Rogue',   hpPct: 60, isActive: true  },
    ]
    const next = phaseReducer(
      'combat',
      { type: 'dm:done', party: partyWrenActive },
      {}
    )
    expect(next).toBe('combat')
  })
})

// ─── RESOLVING transitions ────────────────────────────────────────────────────

describe('phaseReducer — RESOLVING transitions', () => {
  it('RESOLVING + blocks parsed + persisted → FREE_ROAM (all isActive:false)', () => {
    const next = phaseReducer('resolving', { type: 'resolved', party: PARTY_FREE }, {})
    expect(next).toBe('free-roam')
  })

  it('RESOLVING + any player action → DM_BUSY', () => {
    const next = phaseReducer('resolving', { type: 'action', displayName: 'Theron' }, { party: PARTY_FREE })
    expect(next).toBe('DM_BUSY')
  })
})

// ─── reconnect / server-restart ───────────────────────────────────────────────

describe('phaseReducer — reconnect restores phase from .md', () => {
  it('any state + server restart → current phase from .md store (authoritative)', () => {
    // This is a server-level concern (the server reads the .md and sends session:state).
    // The reducer test here verifies that when the server re-initialises a room, it
    // seeds phase from the deserialized payload, not from a hardcoded default.
    const restoredPhase = 'combat'   // as read from the .md
    const next = phaseReducer(null, { type: 'room:init', phase: restoredPhase }, {})
    expect(next).toBe('combat')
  })
})

// ─── displayName matching (case-insensitive active-player check) ───────────────

describe('active player check — case-insensitive displayName matching', () => {
  it('matches "theron" against "Theron" in the party array', () => {
    const active = isActiveTurn('theron', PARTY_COMBAT_THERON)
    expect(active).toBe(true)
  })

  it('does not match "wren" against "Theron" (Wren is not the active player)', () => {
    const active = isActiveTurn('wren', PARTY_COMBAT_THERON)
    expect(active).toBe(false)
  })

  it('returns false for a displayName not in the party at all', () => {
    const active = isActiveTurn('casey', PARTY_COMBAT_THERON)
    expect(active).toBe(false)
  })

  it('returns false when displayName is absent/null', () => {
    expect(isActiveTurn(null, PARTY_COMBAT_THERON)).toBe(false)
    expect(isActiveTurn(undefined, PARTY_COMBAT_THERON)).toBe(false)
    expect(isActiveTurn('', PARTY_COMBAT_THERON)).toBe(false)
  })

  it('returns false when party is empty or absent', () => {
    expect(isActiveTurn('Theron', [])).toBe(false)
    expect(isActiveTurn('Theron', null)).toBe(false)
    expect(isActiveTurn('Theron', undefined)).toBe(false)
  })

  it('matches even when displayName has leading/trailing whitespace', () => {
    expect(isActiveTurn('  Theron  ', PARTY_COMBAT_THERON)).toBe(true)
  })

  it('matches uppercase displayName against mixed-case party member name', () => {
    expect(isActiveTurn('THERON', PARTY_COMBAT_THERON)).toBe(true)
  })
})
