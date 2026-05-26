// Derives a full CHARACTER_OBJECT from wizard output.
// Pure function — no React, no side effects.

import { getClassesForGenre } from './characterClasses.js'

/** DEFAULT_CHARACTER shape — used when wizard output is absent. */
export const DEFAULT_CHARACTER = {
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

/**
 * Calculate the D&D ability modifier for a score.
 * @param {number} score
 * @returns {number}
 */
function abilityModifier(score) {
  return Math.floor((score - 10) / 2)
}

/**
 * Build a full CHARACTER_OBJECT from wizard output.
 *
 * @param {object|null|undefined} wizardOutput
 *   { name: string, race: string, raceId: string, charClass: string, classId: string, abilities: { STR, DEX, CON, INT, WIS, CHA } }
 * @param {string} [genreId='dnd']
 * @returns {object} Full CHARACTER_OBJECT
 */
export function buildCharacter(wizardOutput, genreId = 'dnd') {
  if (!wizardOutput) return { ...DEFAULT_CHARACTER }

  const { name, race, raceId, charClass, classId, abilities } = wizardOutput

  // Locate class record for hpBase
  const classes = getClassesForGenre(genreId)
  const classRecord = classes.find(c => c.id === classId) ||
                      classes.find(c => c.label === charClass)

  const hpBase = classRecord?.hpBase ?? 8
  const conMod = abilityModifier(abilities?.CON ?? 10)
  const dexMod = abilityModifier(abilities?.DEX ?? 10)

  // HP floors at 1 even with heavily negative CON mod
  const hpMax = Math.max(1, hpBase + conMod)

  // Speed: genre-specific constant (simplified v1)
  const speed = genreId === 'starwars' ? 6 : 30

  return {
    name: name || DEFAULT_CHARACTER.name,
    race: race || DEFAULT_CHARACTER.race,
    charClass: charClass || DEFAULT_CHARACTER.charClass,
    hpCurrent: hpMax,
    hpMax,
    ac: 10 + dexMod,
    initiative: dexMod,
    speed,
    abilities: {
      STR: abilities?.STR ?? 10,
      DEX: abilities?.DEX ?? 10,
      CON: abilities?.CON ?? 10,
      INT: abilities?.INT ?? 10,
      WIS: abilities?.WIS ?? 10,
      CHA: abilities?.CHA ?? 10,
    },
    conditions: [],
  }
}
