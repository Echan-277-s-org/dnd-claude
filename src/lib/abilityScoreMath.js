// Ability score math: point-buy, standard array, 4d6-drop-lowest, Star Wars presets.
// Pure functions — no React, no side effects. Uses Math.random (mockable in tests).

import { getRacesForGenre } from './characterClasses.js'

// ── D&D 5e Point-Buy ─────────────────────────────────────────────────────────

/** D&D 5e 27-point budget, base score of 8 for each ability. */
export const POINT_BUY_BUDGET = 27

/** Minimum and maximum scores reachable via point-buy before race bonuses. */
export const POINT_BUY_MIN = 8
export const POINT_BUY_MAX = 15

/**
 * Cost in budget points to raise an ability score from 8 to the given value.
 * Cost is cumulative: e.g. score 10 costs 2 pts total (1 for 9, +1 for 10).
 * Scores below 8 or above 15 are invalid — cost table returns null for them.
 */
export const POINT_BUY_COST = {
  8:  0,
  9:  1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
}

/**
 * Returns the default ability scores for point-buy (all 8).
 * @returns {{ STR, DEX, CON, INT, WIS, CHA }}
 */
export function defaultPointBuyScores() {
  return { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 }
}

/**
 * Validate a set of ability scores against D&D 5e point-buy rules.
 * @param {{ STR, DEX, CON, INT, WIS, CHA }} abilityScores
 * @returns {{ valid: boolean, spent: number, remaining: number, errors: string[] }}
 */
export function validatePointBuy(abilityScores) {
  const keys = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
  const errors = []
  let spent = 0

  for (const key of keys) {
    const score = abilityScores[key]
    if (score < POINT_BUY_MIN) {
      errors.push(`${key} cannot be below ${POINT_BUY_MIN}`)
      continue
    }
    if (score > POINT_BUY_MAX) {
      errors.push(`${key} cannot exceed ${POINT_BUY_MAX} (before racial bonuses)`)
      continue
    }
    spent += POINT_BUY_COST[score] ?? 0
  }

  if (spent > POINT_BUY_BUDGET) {
    errors.push(`Over budget: spent ${spent} of ${POINT_BUY_BUDGET} points`)
  }

  const remaining = POINT_BUY_BUDGET - spent
  return { valid: errors.length === 0, spent, remaining, errors }
}

// ── D&D 5e Standard Array ────────────────────────────────────────────────────

/** The standard D&D 5e predefined array: assign these six values to any abilities. */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8]

// ── D&D 5e Roll 4d6 Drop Lowest ──────────────────────────────────────────────

/**
 * Roll a single d6. Uses Math.random for easy test mocking.
 * @returns {number} 1–6
 */
function rollD6() {
  return Math.floor(Math.random() * 6) + 1
}

/**
 * Roll 4d6, drop the lowest die, return the sum (one ability score roll).
 * Result is in range 3–18.
 * @returns {number}
 */
export function rollOnce4d6DropLowest() {
  const dice = [rollD6(), rollD6(), rollD6(), rollD6()]
  const min = Math.min(...dice)
  const minIndex = dice.indexOf(min)
  const kept = dice.filter((_, i) => i !== minIndex)
  return kept.reduce((a, b) => a + b, 0)
}

/**
 * Generate 6 ability score rolls using 4d6-drop-lowest.
 * @returns {number[]} Array of 6 values, each in range 3–18.
 */
export function roll4d6DropLowest() {
  return Array.from({ length: 6 }, () => rollOnce4d6DropLowest())
}

// ── Star Wars Simple Build Presets ────────────────────────────────────────────

/**
 * Star Wars d20 simplified ability presets (no point-buy complexity).
 * Arrays are in ABILITY_KEYS order: [STR, DEX, CON, INT, WIS, CHA].
 */
export const STARWARS_PRESETS = {
  balanced: {
    label: 'Balanced',
    description: 'Distributed stats — versatile but no specialization.',
    scores: { STR: 12, DEX: 12, CON: 12, INT: 11, WIS: 10, CHA: 9 },
  },
  strong: {
    label: 'Strong',
    description: 'Focus on strength and endurance — melee or heavy weapons.',
    scores: { STR: 14, DEX: 10, CON: 13, INT: 10, WIS: 10, CHA: 8 },
  },
  quick: {
    label: 'Quick',
    description: 'Focus on dexterity and wit — pilots, scouts, and scoundrels.',
    scores: { STR: 9, DEX: 13, CON: 12, INT: 13, WIS: 11, CHA: 8 },
  },
}

// ── Race Bonus Application ────────────────────────────────────────────────────

/**
 * Apply racial ability bonuses to a base ability score set.
 * Bonuses are additive; no cap is applied here (wizards may apply a cap externally).
 *
 * @param {{ STR, DEX, CON, INT, WIS, CHA }} baseScores  Base ability scores.
 * @param {string} raceId   Race/species ID (must match a record in characterClasses.js).
 * @param {string} genreId  Genre ('dnd' or 'starwars') for lookup.
 * @returns {{ STR, DEX, CON, INT, WIS, CHA }} New scores with bonuses applied.
 */
export function applyRaceBonus(baseScores, raceId, genreId) {
  const races = getRacesForGenre(genreId)
  const race = races.find(r => r.id === raceId)
  if (!race || !race.abilityBonuses) return { ...baseScores }

  const result = { ...baseScores }
  for (const [key, bonus] of Object.entries(race.abilityBonuses)) {
    if (key in result) {
      result[key] = result[key] + bonus
    }
  }
  return result
}
