// Star Wars (d20 / Saga Edition) context engine — the genre sibling of
// context.js. Same three-function interface (buildSystemPrompt, extractEntities,
// trimContext) so Chat.jsx can swap engines purely on `campaign.genre`.
//
// extractEntities is a deliberate fork of the D&D version rather than a shared
// import: the only thing that differs between genres is the rejection vocabulary
// (Saga skills/defenses/Force terms instead of 5e skills/stat-blocks), but those
// sets are module-private in context.js. context.js is also being actively
// edited on another branch, so forking here keeps the two from colliding.
// trimContext is genre-neutral and is reused directly.

export { trimContext } from './context'

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildSystemPrompt({ name, details, context } = {}) {
  return `You are an expert, creative Game Master running a Star Wars roleplaying campaign using the d20 / Saga Edition rules${name ? ` called "${name}"` : ''}.${details ? `\n\nCampaign context: ${details}` : ''}${context ? `\n\n---\nCampaign notes (use this as your knowledge of prior events, NPCs, planets, ships, factions, and galactic state):\n\n${context}\n---` : ''}

CONTINUITY: You must track and build on everything established in this session — character names, planets and locations named, ships, droids, factions, decisions made, NPCs and aliens encountered, gear and credits acquired, debts and bounties, relationships formed. Reference prior events naturally. Never contradict established facts unless there is a deliberate narrative reason.

Your role:
- Narrate scenes with vivid, cinematic Star Wars atmosphere — the hum of engines, the snap-hiss of a lightsaber, the glow of a blaster bolt, the din of a crowded cantina.
- Voice each NPC, alien, and droid with a distinct personality, motivation, and speech pattern.
- Handle Star Wars Saga Edition (d20) mechanics accurately — skill checks against a DC, attack rolls against a target's Reflex Defense, the condition track, Fortitude/Reflex/Will Defenses, hit points and damage threshold, Second Wind, and the Force (Use the Force checks, Force Points, the dark side).
- When players describe actions, deliver dramatic and meaningful outcomes.
- Maintain narrative continuity and remember details established earlier in the session.
- Never invent the players' character stats, hit points, Force Points, gear, or abilities. If an outcome depends on information not yet established, ask the players rather than guessing.
- When an action requires a roll, state which skill check or attack it is and the DC (for an attack, that it is against the target's Reflex Defense), then wait for the player's roll result before narrating the outcome — do not resolve it yourself.

Formatting guidelines:
- Use **bold** for every NPC, alien, droid, planet, ship, and faction name, especially the first time each is introduced (write the bartender **Wuher**, not the bartender "Wuher"). This is required for continuity tracking, not just visual style.
- Use *italics* for atmosphere, comm chatter, or internal impressions.
- Separate narration and NPC dialogue with paragraph breaks.
- Keep responses to 2–4 focused paragraphs — vivid but not exhaustive.
- After any scene transition, ground the reader in one sentence establishing where, when, and who is present.
- End each response with a natural hook or prompt inviting the players' next action.

Structured data blocks: After the narrative — at the very END of EVERY response, below all prose — append fenced code blocks that report game state to the app. These blocks are machine-read and stripped before display, so do NOT mention or describe them in your narration. Emit minified JSON (no line breaks, no trailing commas). At most one block per tag per response.

1. Party block — REQUIRED in EVERY response. Append a fenced block tagged \`party\` containing a JSON array of the current party, one object per member with exactly these keys: name (string), role (string, e.g. "Jedi" or "Pilot"), hpPct (integer 0–100), isActive (boolean). Exactly one member has isActive true — the one whose turn or spotlight it is; all others false. Do NOT include an id field; the app assigns ids. If the party has not changed, still emit the block with the same values.

2. Check block — ONLY when you are calling for a roll. When you ask the player to make a skill check, narrate the request AND append a fenced block tagged \`check\` with keys: skill (string, UPPERCASE) and dc (integer). Do not emit this block on responses where you are not requesting a roll.

3. Verdict block — ONLY when resolving a roll the player just reported. When the player's message reports a dice roll for a pending check, judge it against the DC and append a fenced block tagged \`verdict\` with keys: skill (string, UPPERCASE), dc (integer), roll (integer, echoed faithfully from the player), result (the EXACT string "PASS" or "FAIL", uppercase, nothing else).

Worked example — a reply that requests a stealth check (note the trailing blocks after the prose):

The corridor stretches into darkness, and you hear bootsteps echoing from the guardroom ahead. Slipping past unseen will take a steady nerve. Give me a **Stealth** check, DC 15.

\`\`\`party
[{"name":"Aelis","role":"Scout","hpPct":80,"isActive":true},{"name":"Borin","role":"Soldier","hpPct":95,"isActive":false}]
\`\`\`
\`\`\`check
{"skill":"STEALTH","dc":15}
\`\`\`

Worked example — resolving the roll the player then reports (roll of 17 fails DC 15 here only as illustration; you judge):

You press flat against the cold durasteel, but a loose buckle scrapes the bulkhead and the guard's head snaps toward the sound.

\`\`\`party
[{"name":"Aelis","role":"Scout","hpPct":80,"isActive":true},{"name":"Borin","role":"Soldier","hpPct":95,"isActive":false}]
\`\`\`
\`\`\`verdict
{"skill":"STEALTH","dc":15,"roll":17,"result":"FAIL"}
\`\`\`

Stay in the Game Master role. Make every choice feel meaningful. Keep the adventure moving.`
}

// ─────────────────────────────────────────────────────────────────────────────
// extractEntities — continuity-anchor extraction tuned for Star Wars Saga
// ─────────────────────────────────────────────────────────────────────────────

// Connectives that legitimately appear inside proper-noun titles
// ("The Wheel of Fortune", "Order of the Sith", "Knights of the Old Republic").
const TITLE_CONNECTIVES = new Set(['of', 'the'])

// Lowercase function words that, mid-span, signal descriptive prose rather than
// a proper name ("Crates on the Dock", "Smoke Rising from the Engine").
const MID_PHRASE_STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'with',
  'from', 'by', 'into', 'before', 'after', 'down', 'up', 'through', 'over',
  'leading', 'about', 'toward', 'towards',
])

// Leading verbs that mark an imperative / option-list label
// ("Slice the Console", "Scan for Lifeforms", "Take Cover Behind Crates").
const IMPERATIVE_LEADS = new Set([
  'proceed', 'investigate', 'rest', 'disarm', 'check', 'interpret', 'interpreting',
  'examine', 'search', 'explore', 'attack', 'defend', 'retreat', 'continue',
  'descend', 'ascend', 'open', 'close', 'inspect', 'gather', 'prepare', 'avoid',
  'follow', 'listen', 'wait', 'roll', 'make', 'attempt', 'try', 'engage',
  // Star Wars-flavored option-list verbs
  'fire', 'shoot', 'blast', 'dodge', 'slice', 'sneak', 'scan', 'pilot', 'fly',
  'land', 'dock', 'jump', 'board', 'sabotage', 'negotiate', 'bribe', 'ignite',
])

// Generic category / meta labels the model emits as bold headers, not story
// entities.
const GENERIC_LABELS = new Set([
  'hook', 'name', 'ship name', 'planet name', 'system name', 'cantina name',
  'station name', 'name of the ship', 'name of the planet', 'name of the cantina',
  'shop', 'vendor', 'quest giver', 'quest sender', 'quest', 'mission', 'objective',
  'bounty', 'reward', 'artifact', 'faction', 'faction warning', 'out of character',
  'in character', 'combat', 'aye', 'now', 'one of you', 'hooded figures',
  'hooded figure', 'guard', 'leader', 'leader figure', 'option', 'choices',
  'note', 'reminder', 'contact', 'patron', 'employer',
])

// Single bland nouns that recur as scenery/mechanics rather than named anchors.
const GENERIC_HEAD_NOUNS = new Set([
  'guard', 'leader', 'figure', 'option', 'note', 'choice', 'choices',
  'trooper', 'soldier', 'patron', 'crowd',
])

// Star Wars Saga Edition mechanics / stat-block vocabulary. The model bolds
// these when narrating checks and stat blocks; none is ever a continuity anchor,
// so an exact/normalized match is safe to drop.
const MECHANICS_TERMS = new Set([
  // skills
  'acrobatics', 'climb', 'deception', 'endurance', 'gather information',
  'initiative', 'jump', 'knowledge', 'mechanics', 'perception', 'persuasion',
  'pilot', 'ride', 'stealth', 'survival', 'swim', 'treat injury',
  'use computer', 'use the force',
  // ability scores
  'str', 'dex', 'con', 'int', 'wis', 'cha',
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  // defenses, combat, resources
  'reflex defense', 'fortitude defense', 'will defense', 'reflex', 'fortitude',
  'will', 'hit points', 'hit point', 'damage threshold', 'damage reduction',
  'damage', 'condition track', 'second wind', 'base attack bonus',
  'attack roll', 'ranged attack', 'melee attack', 'skill check', 'ability check',
  'saving throw', 'initiative check', 'speed', 'senses', 'languages',
  'challenge level', 'force point', 'force points', 'destiny point',
  'destiny', 'dark side', 'dark side score', 'the force', 'force power',
  'use the force check',
  // common Force powers the model bolds as mechanics
  'force lightning', 'mind trick', 'force grip', 'move object', 'force push',
  // generic combatant placeholders
  'stormtrooper a', 'stormtrooper b', 'player character a', 'player character b',
  'player character c', 'player character', 'trooper 1', 'trooper 2',
  'guard 1', 'guard 2', 'leader figure',
])

// Filler / pronoun fragments captured from quotes or bold.
const PRONOUN_FILLER = new Set([
  'one of you', 'you', 'i', 'we', 'they', 'he', 'she', 'it', 'us', 'them',
  'aye', 'now', 'well', 'yes', 'no', 'okay', 'welcome', 'greetings', 'hello',
  'farewell', 'thanks', 'please', 'wait', 'stop', 'halt',
])

function looksLikeEntity(term) {
  const t = term.trim()
  if (!t) return false

  const lower = t.toLowerCase()

  // 1. Explicit junk lists (labels, meta phrases, filler, Saga mechanics).
  if (GENERIC_LABELS.has(lower)) return false
  if (PRONOUN_FILLER.has(lower)) return false
  if (MECHANICS_TERMS.has(lower)) return false

  // 1b. Enumerated placeholder combatants ("Trooper 1", "Stormtrooper B",
  //     "Pirate C"). Pattern: ends with a lone digit or single A-Z.
  if (/\s(?:\d+|[A-Z])$/.test(t)) {
    const head = t.replace(/\s(?:\d+|[A-Z])$/, '').toLowerCase()
    if (GENERIC_HEAD_NOUNS.has(head) || MECHANICS_TERMS.has(head) ||
        /\b(guard|figure|character|enemy|trooper|stormtrooper|clone|soldier|pirate|thug|droid|battle droid)\b/.test(head)) {
      return false
    }
  }

  // 2. Drop anything carrying a colon — label syntax like "Ship Name:".
  if (t.includes(':')) return false

  // 2b. Possessive "<Role>'s Name" label ("Captain's Name", "Pilot's Name").
  if (/['’]s\s+name$/i.test(t)) return false

  // 3. Drop parenthetical mechanics annotations:
  //    "Console (Use Computer)", "Slice (Mechanics Check)".
  if (/[()]/.test(t)) return false

  const words = t.split(/\s+/)

  // 4. Reject overly long phrases. Real proper nouns essentially never exceed
  //    4 words; longer bold spans are prose.
  if (words.length > 4) return false

  // 5. Reject tokens with no Latin letters at all, and chat/handle artifacts.
  if (!/[A-Za-z]/.test(t)) return false
  if (t.startsWith('@')) return false

  // 6. Imperative / option-list phrases: leading action verb + multi-word
  //    ("Slice the Console", "Scan for Lifeforms").
  if (words.length >= 2 && IMPERATIVE_LEADS.has(words[0].toLowerCase())) {
    return false
  }

  // 7. Descriptive prose phrases: a lowercase prose stopword in the MIDDLE
  //    ("Crates on the Dock"). `of`/`the` are title connectives, not stopwords,
  //    so proper-noun titles ("Order of the Sith") survive.
  if (words.length >= 3) {
    for (let i = 1; i < words.length - 1; i++) {
      if (MID_PHRASE_STOPWORDS.has(words[i].toLowerCase())) return false
    }
  }

  // 8. Single-word generic scenery / header nouns ("Guard", "Figure").
  if (words.length === 1 && GENERIC_HEAD_NOUNS.has(lower)) return false

  // 9. Title-case requirement for multi-word spans. Every word must be either
  //    capitalized or an allowed connective (of/the).
  if (words.length >= 2) {
    const ok = words.every(w => /^[A-Z]/.test(w) || TITLE_CONNECTIVES.has(w.toLowerCase()))
    if (!ok) return false
    if (!words.some(w => /^[A-Z]/.test(w))) return false
  }

  return true
}

export function extractEntities(messages, max = 50) {
  const stats = new Map() // key -> { term, order, count }
  let order = 0

  const add = (raw) => {
    const term = raw.trim().replace(/[,.;:!?]+$/, '').trim()
    if (!term) return
    if (!looksLikeEntity(term)) return
    const key = term.toLowerCase()
    const existing = stats.get(key)
    if (existing) {
      existing.count++
    } else {
      stats.set(key, { term, order: order++, count: 1 })
    }
  }

  const isProperName = (s) => {
    const words = s.trim().replace(/[,.]+$/, '').trim().split(/\s+/)
    if (words.length < 1 || words.length > 3) return false
    return words.every(w => /^[A-Z][\p{L}'’-]*$/u.test(w))
  }

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.content) continue
    for (const match of m.content.matchAll(/\*\*([^*\n]+)\*\*/g)) {
      const term = match[1].trim()
      if (!term || term.split(/\s+/).length > 5) continue
      add(term)
    }
    for (const match of m.content.matchAll(/["“”]([^"“”\n]{1,40})["“”]/g)) {
      if (isProperName(match[1])) add(match[1])
    }
  }

  const all = [...stats.values()]

  if (all.length <= max) {
    return all.sort((a, b) => a.order - b.order).map(e => e.term)
  }

  const survivors = all
    .slice()
    .sort((a, b) => (b.count - a.count) || (a.order - b.order))
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map(e => e.term)

  return survivors
}
