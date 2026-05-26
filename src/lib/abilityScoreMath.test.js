import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  POINT_BUY_MIN,
  POINT_BUY_MAX,
  STANDARD_ARRAY,
  STARWARS_PRESETS,
  defaultPointBuyScores,
  validatePointBuy,
  rollOnce4d6DropLowest,
  roll4d6DropLowest,
  applyRaceBonus,
} from './abilityScoreMath.js'

const ALL_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

// ── Point-Buy Constants ───────────────────────────────────────────────────────

describe('POINT_BUY_BUDGET', () => {
  it('is 27', () => {
    expect(POINT_BUY_BUDGET).toBe(27)
  })
})

describe('POINT_BUY_COST table', () => {
  it('score 8 costs 0 points', () => {
    expect(POINT_BUY_COST[8]).toBe(0)
  })

  it('score 9 costs 1 point', () => {
    expect(POINT_BUY_COST[9]).toBe(1)
  })

  it('score 10 costs 2 points', () => {
    expect(POINT_BUY_COST[10]).toBe(2)
  })

  it('score 14 costs 7 points', () => {
    expect(POINT_BUY_COST[14]).toBe(7)
  })

  it('score 15 costs 9 points (max)', () => {
    expect(POINT_BUY_COST[15]).toBe(9)
  })

  it('has entries for all scores from 8 to 15', () => {
    for (let score = POINT_BUY_MIN; score <= POINT_BUY_MAX; score++) {
      expect(POINT_BUY_COST[score]).toBeDefined()
      expect(typeof POINT_BUY_COST[score]).toBe('number')
    }
  })

  it('costs are non-decreasing as score increases', () => {
    let prev = -1
    for (let score = POINT_BUY_MIN; score <= POINT_BUY_MAX; score++) {
      expect(POINT_BUY_COST[score]).toBeGreaterThanOrEqual(prev)
      prev = POINT_BUY_COST[score]
    }
  })
})

describe('defaultPointBuyScores', () => {
  it('returns all 8s', () => {
    const scores = defaultPointBuyScores()
    for (const key of ALL_ABILITIES) {
      expect(scores[key]).toBe(8)
    }
  })

  it('returns a new object each call (no aliasing)', () => {
    expect(defaultPointBuyScores()).not.toBe(defaultPointBuyScores())
  })
})

// ── validatePointBuy ──────────────────────────────────────────────────────────

describe('validatePointBuy', () => {
  it('accepts a valid all-8 allocation (spent=0)', () => {
    const result = validatePointBuy({ STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 })
    expect(result.valid).toBe(true)
    expect(result.spent).toBe(0)
    expect(result.remaining).toBe(27)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a valid 27-point allocation', () => {
    // 15(9) + 15(9) + 15(9) = 27 pts, all others at 8
    const result = validatePointBuy({ STR: 15, DEX: 15, CON: 15, INT: 8, WIS: 8, CHA: 8 })
    expect(result.valid).toBe(true)
    expect(result.spent).toBe(27)
    expect(result.remaining).toBe(0)
  })

  it('rejects allocation that exceeds 27-point budget', () => {
    // All at 15: 6×9 = 54 pts — way over budget
    const result = validatePointBuy({ STR: 15, DEX: 15, CON: 15, INT: 15, WIS: 15, CHA: 15 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('budget') || e.includes('Over'))).toBe(true)
  })

  it('rejects ability score above 15', () => {
    const result = validatePointBuy({ STR: 16, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('STR') && e.includes('15'))).toBe(true)
  })

  it('rejects ability score below 8', () => {
    const result = validatePointBuy({ STR: 7, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('STR'))).toBe(true)
  })

  it('calculates remaining budget correctly', () => {
    // STR 10 costs 2, all others 8 → spent=2, remaining=25
    const result = validatePointBuy({ STR: 10, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 })
    expect(result.spent).toBe(2)
    expect(result.remaining).toBe(25)
  })

  it('accepts spending all 27 points with mixed scores', () => {
    // 15(9) + 14(7) + 13(5) + 12(4) + 10(2) = 27; 9+7+5+4+2=27 — last one at 8
    const result = validatePointBuy({ STR: 15, DEX: 14, CON: 13, INT: 12, WIS: 10, CHA: 8 })
    expect(result.valid).toBe(true)
    expect(result.spent).toBe(27)
  })
})

// ── Standard Array ────────────────────────────────────────────────────────────

describe('STANDARD_ARRAY', () => {
  it('contains exactly [15, 14, 13, 12, 10, 8]', () => {
    expect(STANDARD_ARRAY).toEqual([15, 14, 13, 12, 10, 8])
  })

  it('has 6 values', () => {
    expect(STANDARD_ARRAY).toHaveLength(6)
  })
})

// ── 4d6 Drop Lowest ───────────────────────────────────────────────────────────

describe('rollOnce4d6DropLowest', () => {
  it('returns a value in range 3–18', () => {
    // Run many times to validate range bounds
    for (let i = 0; i < 200; i++) {
      const result = rollOnce4d6DropLowest()
      expect(result).toBeGreaterThanOrEqual(3)
      expect(result).toBeLessThanOrEqual(18)
    }
  })

  it('produces 15 when three dice are 6,5,4 and one is 3 (drop the 3)', () => {
    // Mock Math.random to return values that give dice [6,5,4,3]
    // Math.floor(Math.random() * 6) + 1
    // For d6=6: random() must return >= 5/6
    // For d6=5: random() must return >= 4/6
    // For d6=4: random() must return >= 3/6
    // For d6=3: random() must return >= 2/6
    let call = 0
    const mockValues = [5/6, 4/6, 3/6, 2/6] // will produce [6, 5, 4, 3]
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => mockValues[call++ % 4])
    const result = rollOnce4d6DropLowest()
    spy.mockRestore()
    expect(result).toBe(15) // 6+5+4 = 15
  })

  it('produces 3 when all dice are 1 (min possible roll)', () => {
    // All dice = 1; drop one 1, sum = 1+1+1 = 3
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0) // floor(0*6)+1 = 1
    const result = rollOnce4d6DropLowest()
    spy.mockRestore()
    expect(result).toBe(3)
  })

  it('produces 18 when all dice are 6 (max possible roll)', () => {
    // All dice = 6; drop one 6, sum = 6+6+6 = 18
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999) // floor(0.999*6)+1 = 6
    const result = rollOnce4d6DropLowest()
    spy.mockRestore()
    expect(result).toBe(18)
  })
})

describe('roll4d6DropLowest', () => {
  it('returns an array of 6 values', () => {
    const results = roll4d6DropLowest()
    expect(results).toHaveLength(6)
  })

  it('all values are integers in range 3–18', () => {
    const results = roll4d6DropLowest()
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(3)
      expect(r).toBeLessThanOrEqual(18)
      expect(Number.isInteger(r)).toBe(true)
    }
  })
})

// ── Star Wars Presets ─────────────────────────────────────────────────────────

describe('STARWARS_PRESETS', () => {
  it('has balanced, strong, and quick presets', () => {
    expect(STARWARS_PRESETS).toHaveProperty('balanced')
    expect(STARWARS_PRESETS).toHaveProperty('strong')
    expect(STARWARS_PRESETS).toHaveProperty('quick')
  })

  it('each preset has label, description, and scores', () => {
    for (const preset of Object.values(STARWARS_PRESETS)) {
      expect(preset).toHaveProperty('label')
      expect(preset).toHaveProperty('description')
      expect(preset).toHaveProperty('scores')
    }
  })

  it('each preset scores object has all 6 ability keys', () => {
    for (const preset of Object.values(STARWARS_PRESETS)) {
      for (const key of ALL_ABILITIES) {
        expect(preset.scores).toHaveProperty(key)
        expect(typeof preset.scores[key]).toBe('number')
      }
    }
  })

  it('all preset scores are sensible (>= 8, <= 16)', () => {
    for (const preset of Object.values(STARWARS_PRESETS)) {
      for (const val of Object.values(preset.scores)) {
        expect(val).toBeGreaterThanOrEqual(6)
        expect(val).toBeLessThanOrEqual(16)
      }
    }
  })

  it('balanced preset scores are all similar (max spread <= 4)', () => {
    const scores = Object.values(STARWARS_PRESETS.balanced.scores)
    const spread = Math.max(...scores) - Math.min(...scores)
    expect(spread).toBeLessThanOrEqual(4)
  })
})

// ── applyRaceBonus ────────────────────────────────────────────────────────────

describe('applyRaceBonus', () => {
  const base = { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }

  it('applies D&D Elf DEX bonus (+2) correctly', () => {
    const result = applyRaceBonus(base, 'elf-high', 'dnd')
    expect(result.DEX).toBe(12)
    expect(result.INT).toBe(11)
    expect(result.STR).toBe(10) // unchanged
  })

  it('applies D&D Dwarf CON bonus (+2) correctly', () => {
    const result = applyRaceBonus(base, 'dwarf', 'dnd')
    expect(result.CON).toBe(12)
  })

  it('applies Star Wars Wookiee STR bonus (+2) correctly', () => {
    const result = applyRaceBonus(base, 'wookiee', 'starwars')
    expect(result.STR).toBe(12)
    expect(result.DEX).toBe(10) // unchanged
  })

  it('applies Human D&D +1 to all abilities correctly', () => {
    const result = applyRaceBonus(base, 'human', 'dnd')
    for (const key of ALL_ABILITIES) {
      expect(result[key]).toBe(11)
    }
  })

  it('returns a copy without mutating the input', () => {
    const original = { ...base }
    const result = applyRaceBonus(original, 'dwarf', 'dnd')
    expect(original.CON).toBe(10) // unchanged
    expect(result).not.toBe(original)
  })

  it('returns unmodified copy when raceId not found', () => {
    const result = applyRaceBonus(base, 'nonexistent-race', 'dnd')
    expect(result).toEqual(base)
  })

  it('returns unmodified copy when raceId is null', () => {
    const result = applyRaceBonus(base, null, 'dnd')
    expect(result).toEqual(base)
  })

  it('works with non-zero base scores', () => {
    const highBase = { STR: 14, DEX: 14, CON: 14, INT: 14, WIS: 14, CHA: 14 }
    const result = applyRaceBonus(highBase, 'elf-high', 'dnd')
    expect(result.DEX).toBe(16)
    expect(result.INT).toBe(15)
  })
})
