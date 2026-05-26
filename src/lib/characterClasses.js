// Genre-aware class/race data for the character creation wizard.
// Pure data — no React, no side effects.

// ── D&D 5e Classes (12 standard PHB classes) ────────────────────────────────

export const DND_CLASSES = [
  { id: 'barbarian', label: 'Barbarian', hpBase: 12, hitDieSize: 12, quickAbilities: { STR: 2, CON: 1 } },
  { id: 'bard',      label: 'Bard',      hpBase: 8,  hitDieSize: 8,  quickAbilities: { CHA: 2, DEX: 1 } },
  { id: 'cleric',    label: 'Cleric',    hpBase: 8,  hitDieSize: 8,  quickAbilities: { WIS: 2, CON: 1 } },
  { id: 'druid',     label: 'Druid',     hpBase: 8,  hitDieSize: 8,  quickAbilities: { WIS: 2, CON: 1 } },
  { id: 'fighter',   label: 'Fighter',   hpBase: 10, hitDieSize: 10, quickAbilities: { STR: 2, CON: 1 } },
  { id: 'monk',      label: 'Monk',      hpBase: 8,  hitDieSize: 8,  quickAbilities: { DEX: 2, WIS: 1 } },
  { id: 'paladin',   label: 'Paladin',   hpBase: 10, hitDieSize: 10, quickAbilities: { STR: 2, CHA: 1 } },
  { id: 'ranger',    label: 'Ranger',    hpBase: 10, hitDieSize: 10, quickAbilities: { DEX: 2, WIS: 1 } },
  { id: 'rogue',     label: 'Rogue',     hpBase: 8,  hitDieSize: 8,  quickAbilities: { DEX: 2, INT: 1 } },
  { id: 'sorcerer',  label: 'Sorcerer',  hpBase: 6,  hitDieSize: 6,  quickAbilities: { CHA: 2, CON: 1 } },
  { id: 'warlock',   label: 'Warlock',   hpBase: 8,  hitDieSize: 8,  quickAbilities: { CHA: 2, CON: 1 } },
  { id: 'wizard',    label: 'Wizard',    hpBase: 6,  hitDieSize: 6,  quickAbilities: { INT: 2, WIS: 1 } },
]

// ── D&D 5e Races (10 core races) ────────────────────────────────────────────

export const DND_RACES = [
  { id: 'human',       label: 'Human',      abilityBonuses: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 } },
  { id: 'elf-high',    label: 'High Elf',   abilityBonuses: { DEX: 2, INT: 1 } },
  { id: 'elf-wood',    label: 'Wood Elf',   abilityBonuses: { DEX: 2, WIS: 1 } },
  { id: 'elf-dark',    label: 'Dark Elf',   abilityBonuses: { DEX: 2, CHA: 1 } },
  { id: 'dwarf',       label: 'Dwarf',      abilityBonuses: { CON: 2, WIS: 1 } },
  { id: 'halfling',    label: 'Halfling',   abilityBonuses: { DEX: 2, CHA: 1 } },
  { id: 'dragonborn',  label: 'Dragonborn', abilityBonuses: { STR: 2, CHA: 1 } },
  { id: 'gnome',       label: 'Gnome',      abilityBonuses: { INT: 2, CON: 1 } },
  { id: 'half-elf',    label: 'Half-Elf',   abilityBonuses: { CHA: 2, DEX: 1, WIS: 1 } },
  { id: 'half-orc',    label: 'Half-Orc',   abilityBonuses: { STR: 2, CON: 1 } },
  { id: 'tiefling',    label: 'Tiefling',   abilityBonuses: { INT: 1, CHA: 2 } },
]

// ── Star Wars d20 Saga Edition Classes (6 core) ──────────────────────────────

export const STARWARS_CLASSES = [
  { id: 'soldier',    label: 'Soldier',    hpBase: 8, hitDieSize: 8,  quickAbilities: { STR: 2, CON: 1 } },
  { id: 'scoundrel',  label: 'Scoundrel',  hpBase: 6, hitDieSize: 6,  quickAbilities: { DEX: 2, CHA: 1 } },
  { id: 'scout',      label: 'Scout',      hpBase: 8, hitDieSize: 8,  quickAbilities: { DEX: 2, WIS: 1 } },
  { id: 'jedi',       label: 'Jedi',       hpBase: 8, hitDieSize: 8,  quickAbilities: { WIS: 2, STR: 1 } },
  { id: 'smuggler',   label: 'Smuggler',   hpBase: 6, hitDieSize: 6,  quickAbilities: { CHA: 2, DEX: 1 } },
  { id: 'gunslinger', label: 'Gunslinger', hpBase: 8, hitDieSize: 8,  quickAbilities: { DEX: 2, CON: 1 } },
]

// ── Star Wars Species (8 core) ────────────────────────────────────────────────

export const STARWARS_SPECIES = [
  { id: 'human',       label: 'Human',       abilityBonuses: { CHA: 2 } },
  { id: 'wookiee',     label: 'Wookiee',     abilityBonuses: { STR: 2 } },
  { id: 'twilek',      label: "Twi'lek",     abilityBonuses: { DEX: 2 } },
  { id: 'bothan',      label: 'Bothan',      abilityBonuses: { INT: 2 } },
  { id: 'droid',       label: 'Droid',       abilityBonuses: { INT: 2 } },
  { id: 'moncal',      label: 'Mon Calamari', abilityBonuses: { WIS: 2 } },
  { id: 'ewok',        label: 'Ewok',        abilityBonuses: { DEX: 2 } },
  { id: 'zabrak',      label: 'Zabrak',      abilityBonuses: { CON: 2 } },
]

// ── Genre accessors ───────────────────────────────────────────────────────────

/**
 * Returns the class list for the given genre.
 * Falls back to D&D classes for unknown genre IDs.
 * @param {string} genreId
 * @returns {Array}
 */
export function getClassesForGenre(genreId) {
  if (genreId === 'starwars') return STARWARS_CLASSES
  return DND_CLASSES // default: dnd (and any unknown genreId)
}

/**
 * Returns the race/species list for the given genre.
 * Falls back to D&D races for unknown genre IDs.
 * @param {string} genreId
 * @returns {Array}
 */
export function getRacesForGenre(genreId) {
  if (genreId === 'starwars') return STARWARS_SPECIES
  return DND_RACES // default: dnd (and any unknown genreId)
}
