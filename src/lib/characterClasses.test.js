import { describe, it, expect } from 'vitest'
import {
  DND_CLASSES,
  DND_RACES,
  STARWARS_CLASSES,
  STARWARS_SPECIES,
  getClassesForGenre,
  getRacesForGenre,
} from './characterClasses.js'

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

// ── D&D Classes ───────────────────────────────────────────────────────────────

describe('DND_CLASSES', () => {
  it('has 12 classes', () => {
    expect(DND_CLASSES).toHaveLength(12)
  })

  it('every class has required fields: id, label, hpBase, hitDieSize', () => {
    for (const c of DND_CLASSES) {
      expect(c).toHaveProperty('id')
      expect(c).toHaveProperty('label')
      expect(c).toHaveProperty('hpBase')
      expect(c).toHaveProperty('hitDieSize')
    }
  })

  it('every class has hpBase between 6 and 12 inclusive', () => {
    for (const c of DND_CLASSES) {
      expect(c.hpBase).toBeGreaterThanOrEqual(6)
      expect(c.hpBase).toBeLessThanOrEqual(12)
    }
  })

  it('every class has hitDieSize of 6, 8, 10, or 12', () => {
    const valid = [6, 8, 10, 12]
    for (const c of DND_CLASSES) {
      expect(valid).toContain(c.hitDieSize)
    }
  })

  it('includes Fighter with hpBase 10 and hitDieSize 10', () => {
    const fighter = DND_CLASSES.find(c => c.id === 'fighter')
    expect(fighter).toBeDefined()
    expect(fighter.hpBase).toBe(10)
    expect(fighter.hitDieSize).toBe(10)
  })

  it('includes Wizard with hpBase 6 and hitDieSize 6', () => {
    const wizard = DND_CLASSES.find(c => c.id === 'wizard')
    expect(wizard).toBeDefined()
    expect(wizard.hpBase).toBe(6)
    expect(wizard.hitDieSize).toBe(6)
  })

  it('includes Barbarian with hpBase 12 and hitDieSize 12', () => {
    const barbarian = DND_CLASSES.find(c => c.id === 'barbarian')
    expect(barbarian).toBeDefined()
    expect(barbarian.hpBase).toBe(12)
    expect(barbarian.hitDieSize).toBe(12)
  })

  it('all ids are unique', () => {
    const ids = DND_CLASSES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── D&D Races ─────────────────────────────────────────────────────────────────

describe('DND_RACES', () => {
  it('has at least 10 races', () => {
    expect(DND_RACES.length).toBeGreaterThanOrEqual(10)
  })

  it('every race has id and label', () => {
    for (const r of DND_RACES) {
      expect(r).toHaveProperty('id')
      expect(r).toHaveProperty('label')
    }
  })

  it('every race with abilityBonuses has only valid ability keys', () => {
    for (const r of DND_RACES) {
      if (r.abilityBonuses) {
        for (const key of Object.keys(r.abilityBonuses)) {
          expect(ABILITY_KEYS).toContain(key)
        }
      }
    }
  })

  it('ability bonus values are positive integers', () => {
    for (const r of DND_RACES) {
      if (r.abilityBonuses) {
        for (const val of Object.values(r.abilityBonuses)) {
          expect(val).toBeGreaterThan(0)
          expect(Number.isInteger(val)).toBe(true)
        }
      }
    }
  })

  it('includes Human with bonuses for each ability', () => {
    const human = DND_RACES.find(r => r.id === 'human')
    expect(human).toBeDefined()
    expect(human.abilityBonuses).toBeDefined()
  })

  it('includes Dwarf with CON bonus', () => {
    const dwarf = DND_RACES.find(r => r.id === 'dwarf')
    expect(dwarf).toBeDefined()
    expect(dwarf.abilityBonuses?.CON).toBeGreaterThan(0)
  })

  it('all ids are unique', () => {
    const ids = DND_RACES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── Star Wars Classes ─────────────────────────────────────────────────────────

describe('STARWARS_CLASSES', () => {
  it('has 6 classes', () => {
    expect(STARWARS_CLASSES).toHaveLength(6)
  })

  it('every SW class has id, label, hpBase, hitDieSize', () => {
    for (const c of STARWARS_CLASSES) {
      expect(c).toHaveProperty('id')
      expect(c).toHaveProperty('label')
      expect(c).toHaveProperty('hpBase')
      expect(c).toHaveProperty('hitDieSize')
    }
  })

  it('every SW class has hpBase between 6 and 8 inclusive', () => {
    for (const c of STARWARS_CLASSES) {
      expect(c.hpBase).toBeGreaterThanOrEqual(6)
      expect(c.hpBase).toBeLessThanOrEqual(8)
    }
  })

  it('includes Soldier with hpBase 8', () => {
    const soldier = STARWARS_CLASSES.find(c => c.id === 'soldier')
    expect(soldier).toBeDefined()
    expect(soldier.hpBase).toBe(8)
  })

  it('includes Jedi', () => {
    expect(STARWARS_CLASSES.find(c => c.id === 'jedi')).toBeDefined()
  })

  it('all ids are unique', () => {
    const ids = STARWARS_CLASSES.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── Star Wars Species ─────────────────────────────────────────────────────────

describe('STARWARS_SPECIES', () => {
  it('has 8 species', () => {
    expect(STARWARS_SPECIES).toHaveLength(8)
  })

  it('every SW species has id, label, and abilityBonuses', () => {
    for (const s of STARWARS_SPECIES) {
      expect(s).toHaveProperty('id')
      expect(s).toHaveProperty('label')
      expect(s).toHaveProperty('abilityBonuses')
    }
  })

  it('every SW species has at least one ability bonus', () => {
    for (const s of STARWARS_SPECIES) {
      expect(Object.keys(s.abilityBonuses).length).toBeGreaterThan(0)
    }
  })

  it('ability bonus keys are valid ability names', () => {
    for (const s of STARWARS_SPECIES) {
      for (const key of Object.keys(s.abilityBonuses)) {
        expect(ABILITY_KEYS).toContain(key)
      }
    }
  })

  it('includes Wookiee with STR bonus', () => {
    const wookiee = STARWARS_SPECIES.find(s => s.id === 'wookiee')
    expect(wookiee).toBeDefined()
    expect(wookiee.abilityBonuses?.STR).toBeGreaterThan(0)
  })

  it('all ids are unique', () => {
    const ids = STARWARS_SPECIES.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ── Genre Accessors ───────────────────────────────────────────────────────────

describe('getClassesForGenre', () => {
  it('returns DND_CLASSES for dnd genre', () => {
    expect(getClassesForGenre('dnd')).toBe(DND_CLASSES)
  })

  it('returns STARWARS_CLASSES for starwars genre', () => {
    expect(getClassesForGenre('starwars')).toBe(STARWARS_CLASSES)
  })

  it('falls back to DND_CLASSES for unknown genre id', () => {
    expect(getClassesForGenre('unknown')).toBe(DND_CLASSES)
    expect(getClassesForGenre('')).toBe(DND_CLASSES)
    expect(getClassesForGenre(null)).toBe(DND_CLASSES)
    expect(getClassesForGenre(undefined)).toBe(DND_CLASSES)
  })
})

describe('getRacesForGenre', () => {
  it('returns DND_RACES for dnd genre', () => {
    expect(getRacesForGenre('dnd')).toBe(DND_RACES)
  })

  it('returns STARWARS_SPECIES for starwars genre', () => {
    expect(getRacesForGenre('starwars')).toBe(STARWARS_SPECIES)
  })

  it('falls back to DND_RACES for unknown genre id', () => {
    expect(getRacesForGenre('unknown')).toBe(DND_RACES)
    expect(getRacesForGenre('')).toBe(DND_RACES)
    expect(getRacesForGenre(null)).toBe(DND_RACES)
  })
})
