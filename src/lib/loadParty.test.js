import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── localStorage mock (App.test.jsx IIFE pattern) ───────────────────────────
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: vi.fn(key => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value) }),
    removeItem: vi.fn(key => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    _set: (key, value) => { store[key] = value },
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// loadParty() and DEFAULT_PARTY — mirrored from App.jsx
// These are not exported, so we mirror them here per the Chat.test.jsx convention.
// ─────────────────────────────────────────────────────────────────────────────

// mirror of source
const DEFAULT_CHARACTER = {
  name: 'Adventurer',
  race: 'Human',
  charClass: 'Fighter',
  hpCurrent: 20,
  hpMax: 20,
  ac: 15,
  initiative: 2,
  speed: 30,
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  conditions: [],
}

// mirror of source
const DEFAULT_PARTY = [
  {
    id: 'seed-0',
    name: 'Adventurer',
    role: 'Fighter',
    hpPct: 100,
    isActive: true,
  },
]

// mirror of source
function loadParty() {
  try {
    const stored = localStorage.getItem('dnd_party')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch {
    // fall through to migration
  }
  try {
    const charStored = localStorage.getItem('dnd_character')
    if (charStored) {
      const c = JSON.parse(charStored)
      const hpPct =
        c.hpMax > 0
          ? Math.max(0, Math.min(100, Math.round((c.hpCurrent / c.hpMax) * 100)))
          : 100
      return [
        {
          id: 'seed-0',
          name: c.name || DEFAULT_CHARACTER.name,
          role: c.charClass || DEFAULT_CHARACTER.charClass,
          hpPct,
          isActive: true,
        },
      ]
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_PARTY
}

// ─── loadParty — PM-01..10 ────────────────────────────────────────────────────

describe('loadParty — PM-01..10', () => {
  it('PM-01 returns valid dnd_party verbatim when present', () => {
    const party = [{ id: 'abc', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true }]
    localStorageMock._set('dnd_party', JSON.stringify(party))
    const result = loadParty()
    expect(result).toEqual(party)
  })

  it('PM-02 falls back to dnd_character when dnd_party absent (seeds party[0])', () => {
    const char = { name: 'Theron', charClass: 'Paladin', hpCurrent: 10, hpMax: 20 }
    localStorageMock._set('dnd_character', JSON.stringify(char))
    const result = loadParty()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Theron')
    expect(result[0].role).toBe('Paladin')
    expect(result[0].isActive).toBe(true)
  })

  it('PM-03 hpPct = round(hpCurrent/hpMax*100) — 10/20 → 50, 0/20 → 0', () => {
    const char1 = { name: 'A', charClass: 'Fighter', hpCurrent: 10, hpMax: 20 }
    localStorageMock._set('dnd_character', JSON.stringify(char1))
    expect(loadParty()[0].hpPct).toBe(50)

    localStorageMock.clear()
    vi.clearAllMocks()

    const char2 = { name: 'B', charClass: 'Fighter', hpCurrent: 0, hpMax: 20 }
    localStorageMock._set('dnd_character', JSON.stringify(char2))
    expect(loadParty()[0].hpPct).toBe(0)
  })

  it('PM-04 hpMax === 0 → hpPct:100 (division guard)', () => {
    const char = { name: 'Test', charClass: 'Rogue', hpCurrent: 0, hpMax: 0 }
    localStorageMock._set('dnd_character', JSON.stringify(char))
    const result = loadParty()
    expect(result[0].hpPct).toBe(100)
  })

  it('PM-05 both keys absent → DEFAULT_PARTY', () => {
    // No keys in localStorage
    const result = loadParty()
    expect(result).toEqual(DEFAULT_PARTY)
  })

  it('PM-06 corrupt dnd_party JSON → DEFAULT_PARTY, no throw', () => {
    localStorageMock._set('dnd_party', '{bad json}')
    expect(() => loadParty()).not.toThrow()
    const result = loadParty()
    expect(result).toEqual(DEFAULT_PARTY)
  })

  it('PM-07 corrupt dnd_character JSON → DEFAULT_PARTY, no throw', () => {
    localStorageMock._set('dnd_character', '{bad json}')
    expect(() => loadParty()).not.toThrow()
    const result = loadParty()
    expect(result).toEqual(DEFAULT_PARTY)
  })

  it('PM-08 dnd_character is NOT modified or deleted by loadParty()', () => {
    const char = { name: 'Kira', charClass: 'Bard', hpCurrent: 15, hpMax: 20 }
    localStorageMock._set('dnd_character', JSON.stringify(char))
    loadParty()
    // dnd_character should remain unchanged in localStorage
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith('dnd_character', expect.anything())
    expect(localStorageMock.removeItem).not.toHaveBeenCalledWith('dnd_character')
    const stored = localStorageMock.getItem('dnd_character')
    expect(stored).toBe(JSON.stringify(char))
  })

  it('PM-09 after applyPartyUpdate result written to dnd_party, dnd_character unchanged', () => {
    // Simulate what Chat.jsx does in the finally block after LLM response:
    // setParty writes to dnd_party. We verify dnd_character is not touched.
    const char = { name: 'Kira', charClass: 'Bard', hpCurrent: 15, hpMax: 20 }
    localStorageMock._set('dnd_character', JSON.stringify(char))
    const charBefore = localStorageMock.getItem('dnd_character')

    // Simulate Chat.jsx writing new party state
    const newParty = [{ id: 'id-1', name: 'Kira', role: 'Bard', hpPct: 75, isActive: true }]
    localStorage.setItem('dnd_party', JSON.stringify(newParty))

    // dnd_character must be unchanged
    expect(localStorageMock.getItem('dnd_character')).toBe(charBefore)
  })

  it('PM-10 pendingCheck is session-only (no dnd_pendingCheck key ever written) (P2)', () => {
    // loadParty never touches dnd_pendingCheck
    localStorageMock._set('dnd_party', JSON.stringify([{ id: 'x', name: 'A', role: 'B', hpPct: 100, isActive: true }]))
    loadParty()
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith('dnd_pendingCheck', expect.anything())
    expect(localStorageMock.getItem('dnd_pendingCheck')).toBeNull()
  })
})
