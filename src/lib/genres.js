// Genre registry. Each entry bundles a prompt engine (buildSystemPrompt /
// extractEntities / trimContext) with the genre-specific UI strings so the app
// can run as either a D&D or a Star Wars mode off a single `campaign.genre`.

import * as dndEngine from './context.js'
import * as starwarsEngine from './context.starwars.js'

const dndCombat = ['attack', 'sword', 'enemy', 'creature', 'monster', 'fight', 'weapon', 'combat', 'battle', 'strike']
const dndSocial = ['says', 'asks', 'merchant', 'guard', 'innkeeper', 'tavern', 'town', 'village', 'noble', 'coin', 'price']
const dndExploration = ['door', 'chest', 'hallway', 'dungeon', 'trap', 'ruin', 'passage', 'stairs', 'forest', 'cave']

const swCombat = ['blaster', 'lightsaber', 'stormtrooper', 'trooper', 'droid', 'fire', 'shoot', 'fight', 'battle', 'attack', 'dogfight', 'turbolaser', 'saber']
const swSocial = ['says', 'asks', 'cantina', 'bartender', 'broker', 'hutt', 'smuggler', 'credits', 'deal', 'bounty', 'senator', 'patron']
const swExploration = ['door', 'console', 'hangar', 'corridor', 'ship', 'hyperspace', 'station', 'ruins', 'temple', 'jungle', 'airlock', 'cockpit']

function matcher(combat, social, exploration, combatActions, socialActions, exploreActions) {
  return (text) => {
    const lower = text.toLowerCase()
    if (combat.some(kw => lower.includes(kw))) return combatActions
    if (social.some(kw => lower.includes(kw))) return socialActions
    if (exploration.some(kw => lower.includes(kw))) return exploreActions
    return ['Describe my action', 'Ask the GM', 'Roll for it', 'What do I know?']
  }
}

export const GENRES = {
  dnd: {
    id: 'dnd',
    label: 'Dungeons & Dragons (5e)',
    engine: dndEngine,
    emblem: '⚔',
    gmAvatar: '📜',
    emptyEmblem: '🗺',
    appTitle: 'D&D Campaign Assistant',
    setupSubtitle: 'Your AI Dungeon Master — Powered by Ollama',
    gmName: 'Dungeon Master',
    headerDefaultName: 'D&D Campaign',
    headerSubtitle: 'Dungeon Master Assistant',
    namePlaceholder: 'The Lost Mine of Phandelver...',
    detailsPlaceholder: 'Forgotten Realms, 4 players at level 3, dark and gritty tone, house rules: flanking enabled...',
    detailsHint: 'Setting, party composition, tone, house rules — the DM will use this as context.',
    beginLabel: 'Begin the Campaign',
    inputPlaceholder: 'Describe your action, ask the DM, or speak as your character... (Enter to send, Shift+Enter for newline)',
    emptyTitle: 'Your adventure awaits...',
    emptySubtitle: 'Describe your first action, ask the DM a question, or set the scene.',
    starterPrompts: [
      'Begin the adventure — set the scene and describe where we are.',
      'The party enters a dimly lit tavern. What do we see?',
      'We arrive at the dungeon entrance. What dangers await?',
    ],
    getActionSuggestions: matcher(
      dndCombat, dndSocial, dndExploration,
      ['Attack', 'Cast a Spell', 'Take Cover', 'Flee'],
      ['Persuade', 'Intimidate', 'Ask a question', 'Offer coin'],
      ['Search the area', 'Listen carefully', 'Examine it closely', 'Proceed cautiously'],
    ),
  },

  starwars: {
    id: 'starwars',
    label: 'Star Wars (d20 / Saga Edition)',
    engine: starwarsEngine,
    emblem: '✦',
    gmAvatar: '🛰',
    emptyEmblem: '🚀',
    appTitle: 'Star Wars Campaign Assistant',
    setupSubtitle: 'Your AI Game Master — Powered by Ollama',
    gmName: 'Game Master',
    headerDefaultName: 'Star Wars Campaign',
    headerSubtitle: 'Game Master Assistant',
    namePlaceholder: 'Shadows of the Outer Rim...',
    detailsPlaceholder: 'Rebellion era, 4 players, gritty smuggler tone aboard the freighter Kestrel, hunted by an Imperial ISB agent...',
    detailsHint: 'Era, party, tone, ship — the GM will use this as context.',
    beginLabel: 'Begin the Campaign',
    inputPlaceholder: 'Describe your action, ask the GM, or speak as your character... (Enter to send, Shift+Enter for newline)',
    emptyTitle: 'A long time ago, in a galaxy far, far away...',
    emptySubtitle: 'Describe your first action, ask the GM a question, or set the scene.',
    starterPrompts: [
      'Begin the adventure — set the scene and describe where we are.',
      'Our ship drops out of hyperspace above a contested world. What do we see?',
      'We step into a crowded cantina on the edge of the Outer Rim. Who is here?',
    ],
    getActionSuggestions: matcher(
      swCombat, swSocial, swExploration,
      ['Fire my blaster', 'Use the Force', 'Take Cover', 'Retreat'],
      ['Persuade', 'Intimidate', 'Deceive', 'Offer credits'],
      ['Search the area', 'Slice the console', 'Scan for danger', 'Proceed cautiously'],
    ),
  },
}

export function getGenre(id) {
  return GENRES[id] || GENRES.dnd
}
