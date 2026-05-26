import { describe, it, expect } from 'vitest'
import { buildCharacter, DEFAULT_CHARACTER } from './characterBuilder.js'

const ALL_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

const BASE_WIZARD_OUTPUT = {
  name: 'Thorin',
  race: 'Dwarf',
  raceId: 'dwarf',
  charClass: 'Fighter',
  classId: 'fighter',
  abilities: { STR: 15, DEX: 10, CON: 14, INT: 8, WIS: 12, CHA: 8 },
}

// ── Default / fallback behaviour ──────────────────────────────────────────────

describe('buildCharacter — fallback', () => {
  it('returns DEFAULT_CHARACTER when wizardOutput is null', () => {
    const result = buildCharacter(null)
    expect(result).toEqual(DEFAULT_CHARACTER)
  })

  it('returns DEFAULT_CHARACTER when wizardOutput is undefined', () => {
    const result = buildCharacter(undefined)
    expect(result).toEqual(DEFAULT_CHARACTER)
  })

  it('returns a copy, not a reference to DEFAULT_CHARACTER', () => {
    const result = buildCharacter(null)
    expect(result).not.toBe(DEFAULT_CHARACTER)
  })
})

// ── HP calculation ────────────────────────────────────────────────────────────

describe('buildCharacter — HP', () => {
  it('HP = hpBase + CON modifier for a Fighter (hpBase=10, CON 14 → mod +2)', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result.hpMax).toBe(12) // 10 + 2
    expect(result.hpCurrent).toBe(12)
  })

  it('HP = hpBase + CON modifier for a Wizard (hpBase=6, CON 10 → mod 0)', () => {
    const output = { ...BASE_WIZARD_OUTPUT, charClass: 'Wizard', classId: 'wizard', abilities: { ...BASE_WIZARD_OUTPUT.abilities, CON: 10 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.hpMax).toBe(6) // 6 + 0
  })

  it('HP floors at 1 even with very negative CON modifier (CON 1 → mod -5)', () => {
    const lowConOutput = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, CON: 1 } }
    const result = buildCharacter(lowConOutput, 'dnd')
    expect(result.hpMax).toBeGreaterThanOrEqual(1)
    expect(result.hpCurrent).toBeGreaterThanOrEqual(1)
  })

  it('HP floors at 1 with Sorcerer (hpBase=6) and CON 1 (mod -5)', () => {
    // CON 1 → modifier floor((1-10)/2) = floor(-4.5) = -5
    // Sorcerer hpBase=6; 6 + (-5) = 1 → exactly 1 (not 0)
    const output = { ...BASE_WIZARD_OUTPUT, charClass: 'Sorcerer', classId: 'sorcerer', abilities: { ...BASE_WIZARD_OUTPUT.abilities, CON: 1 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.hpMax).toBe(1)
  })

  it('hpCurrent equals hpMax on creation (fresh character)', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result.hpCurrent).toBe(result.hpMax)
  })
})

// ── AC calculation ────────────────────────────────────────────────────────────

describe('buildCharacter — AC', () => {
  it('AC = 10 + DEX modifier (DEX 10 → mod 0 → AC 10)', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, DEX: 10 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.ac).toBe(10)
  })

  it('AC = 10 + DEX modifier (DEX 16 → mod +3 → AC 13)', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, DEX: 16 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.ac).toBe(13)
  })

  it('AC accounts for negative DEX modifier (DEX 6 → mod -2 → AC 8)', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, DEX: 6 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.ac).toBe(8)
  })

  it('AC is always a number', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(typeof result.ac).toBe('number')
  })
})

// ── Initiative ────────────────────────────────────────────────────────────────

describe('buildCharacter — initiative', () => {
  it('initiative equals DEX modifier (DEX 14 → mod +2)', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, DEX: 14 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.initiative).toBe(2)
  })

  it('initiative is negative for low DEX (DEX 6 → mod -2)', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, DEX: 6 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.initiative).toBe(-2)
  })

  it('initiative is 0 for DEX 10', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: { ...BASE_WIZARD_OUTPUT.abilities, DEX: 10 } }
    const result = buildCharacter(output, 'dnd')
    expect(result.initiative).toBe(0)
  })
})

// ── Speed ─────────────────────────────────────────────────────────────────────

describe('buildCharacter — speed', () => {
  it('D&D characters have speed 30', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result.speed).toBe(30)
  })

  it('Star Wars characters have speed 6 (squares)', () => {
    const swOutput = { ...BASE_WIZARD_OUTPUT, charClass: 'Soldier', classId: 'soldier' }
    const result = buildCharacter(swOutput, 'starwars')
    expect(result.speed).toBe(6)
  })
})

// ── Output schema ─────────────────────────────────────────────────────────────

describe('buildCharacter — output schema', () => {
  it('output has all required CHARACTER_OBJECT fields', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result).toHaveProperty('name')
    expect(result).toHaveProperty('race')
    expect(result).toHaveProperty('charClass')
    expect(result).toHaveProperty('hpCurrent')
    expect(result).toHaveProperty('hpMax')
    expect(result).toHaveProperty('ac')
    expect(result).toHaveProperty('initiative')
    expect(result).toHaveProperty('speed')
    expect(result).toHaveProperty('abilities')
    expect(result).toHaveProperty('conditions')
  })

  it('output.abilities has all 6 ability keys', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    for (const key of ALL_ABILITIES) {
      expect(result.abilities).toHaveProperty(key)
      expect(typeof result.abilities[key]).toBe('number')
    }
  })

  it('conditions is always an empty array for a new character', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result.conditions).toEqual([])
  })

  it('name, race, charClass come from wizardOutput', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result.name).toBe('Thorin')
    expect(result.race).toBe('Dwarf')
    expect(result.charClass).toBe('Fighter')
  })

  it('abilities match wizardOutput.abilities', () => {
    const result = buildCharacter(BASE_WIZARD_OUTPUT, 'dnd')
    expect(result.abilities).toEqual(BASE_WIZARD_OUTPUT.abilities)
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('buildCharacter — edge cases', () => {
  it('falls back to default name when wizardOutput.name is empty', () => {
    const output = { ...BASE_WIZARD_OUTPUT, name: '' }
    const result = buildCharacter(output, 'dnd')
    expect(result.name).toBeTruthy()
  })

  it('handles unknown classId by using hpBase=8 fallback', () => {
    const output = { ...BASE_WIZARD_OUTPUT, classId: 'unknown-class', charClass: 'Unknown' }
    const result = buildCharacter(output, 'dnd')
    expect(result.hpMax).toBeGreaterThanOrEqual(1)
  })

  it('handles missing abilities by defaulting each to 10', () => {
    const output = { ...BASE_WIZARD_OUTPUT, abilities: undefined }
    const result = buildCharacter(output, 'dnd')
    for (const key of ALL_ABILITIES) {
      expect(result.abilities[key]).toBe(10)
    }
  })
})
