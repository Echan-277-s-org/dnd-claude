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

export { trimContext } from './context.js'
import { buildPlayerSection } from './session.js'

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildSystemPrompt({ name, details, context, players } = {}) {
  const playerSection = players?.length ? buildPlayerSection(players) : ''
  const body = `You are an expert, creative Game Master running a Star Wars roleplaying campaign using the d20 / Saga Edition rules${name ? ` called "${name}"` : ''}.${details ? `\n\nCampaign context: ${details}` : ''}${context ? `\n\n---\nCampaign notes (use this as your knowledge of prior events, NPCs, planets, ships, factions, and galactic state):\n\n${context}\n---` : ''}

CONTINUITY: You must track and build on everything established in this session — character names, planets and locations named, ships, droids, factions, decisions made, NPCs and aliens encountered, gear and credits acquired, debts and bounties, relationships formed. Reference prior events naturally. Never contradict established facts unless there is a deliberate narrative reason.

Your role:
- Narrate scenes with vivid, cinematic Star Wars atmosphere — the hum of engines, the snap-hiss of a lightsaber, the glow of a blaster bolt, the din of a crowded cantina.
- Voice each NPC, alien, and droid with a distinct personality, motivation, and speech pattern.
- Handle Star Wars Saga Edition (d20) mechanics accurately — skill checks against a DC, attack rolls against a target's Reflex Defense, the condition track, Fortitude/Reflex/Will Defenses, hit points and damage threshold, Second Wind, and the Force (Use the Force checks, Force Points, the dark side).
- When players describe actions, deliver dramatic and meaningful outcomes.
- Maintain narrative continuity and remember details established earlier in the session.
- Never invent the players' character stats, hit points, Force Points, gear, or abilities. If an outcome depends on information not yet established, ask the players rather than guessing.
- When an action requires a roll, state which skill check or attack it is and the DC (for an attack, that it is against the target's Reflex Defense) and call for it, then leave the outcome open for the player to roll — do not resolve it yourself. You NEVER roll dice or state a die result; the PLAYER rolls every die. Do not narrate success or failure (and do not roll initiative or any other die) until the player reports their number on a later turn; only then do you narrate the result. Calling for a check is not resolving it. (You still append the required blocks as normal — the \`party\` block on every response, and the \`check\` block when you call for a roll.)
- Difficulty Classes (DC) follow 5e: Very Easy 5, Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30. Default routine actions to DC 10–15: a typical lock, sneaking past distracted guards, persuading a wary NPC, searching a room, or climbing a rough wall are all DC 15 (or DC 10 if conditions favor the character) — NOT 17, 18, or 20. Reserve DC 20+ ONLY for genuinely difficult feats (scaling a sheer wet cliff, swaying a hostile zealot). If you are unsure, use 15. Do not set DC 16–19 for ordinary tasks; round down to 15.

Formatting guidelines:
- Use **bold** for every NPC, alien, droid, planet, ship, and faction name, especially the first time each is introduced (write the bartender **Wuher**, not the bartender "Wuher"). This is required for continuity tracking, not just visual style.
- Use *italics* for atmosphere, comm chatter, or internal impressions.
- Separate narration and NPC dialogue with paragraph breaks.
- Keep responses to 2–4 focused paragraphs — vivid but not exhaustive.
- After any scene transition, ground the reader in one sentence establishing where, when, and who is present.
- End each response with a natural hook or prompt inviting the players' next action.

Structured data blocks: After the narrative — at the very END of EVERY response, below all prose — append fenced code blocks that report game state to the app. These blocks are machine-read and stripped before display, so do NOT mention or describe them in your narration. Emit minified JSON (no line breaks, no trailing commas). At most one block per tag per response. Nothing should appear after the final closing fence.

1. Party block — REQUIRED in EVERY response. Append a fenced block tagged \`party\` containing a JSON array of the current party, one object per member with exactly these keys: name (string), role (string, e.g. "Jedi" or "Pilot"), hpPct (integer 0–100), isActive (boolean). Exactly one member has isActive true — the one whose turn or spotlight it is; all others false. Do NOT include an id field; the app assigns ids. If the party has not changed, still emit the block with the same values.

2. Check block — ONLY when you are calling for a roll. When you ask the player to make a skill check, narrate the request AND append a fenced block tagged \`check\` with keys: skill (string, UPPERCASE) and dc (integer). Do not emit this block on responses where you are not requesting a roll.

3. Verdict block — ONLY when resolving a roll the player just reported. When the player's message reports a dice roll for a pending check, judge it against the DC and append a fenced block tagged \`verdict\` with keys: skill (string, UPPERCASE), dc (integer), roll (integer, echoed faithfully from the player), result (the EXACT string "PASS" or "FAIL", uppercase, nothing else). When the player reports a roll, always finalize the outcome in that same response — emit the \`verdict\` block and narrate the result, whether success or failure. Do not re-request a roll for the same action; the outcome is decided by the reported number. Echo the \`skill\` and \`dc\` values from the pending check in the player's message; do not substitute a different skill or DC. CRITICAL: emit a \`verdict\` block ONLY when the player's most recent message literally contains a rolled number (a dice-roll line such as "d20 → 14" or "I rolled 12"). If the player only described an action and reported NO number, you must NOT invent or assume a roll and must NOT emit a \`verdict\` — instead call for the check (the \`check\` block) and let them roll. The \`roll\` value must always be a number the player gave you, never one you chose.

4. Facts block — ONLY when a durable numeric or transactional fact is established or updated. When the session establishes a specific price paid in credits, quantity of cargo or supplies, parsec distances, bounty amounts, debt tallies, named quantities, or other numeric/transactional facts that must persist across many turns, append a fenced block tagged \`facts\` containing a minified JSON array of \`{"k":"<short_snake_case_key>","v":"<value with unit>"}\` objects — for example \`[{"k":"bounty_reward","v":"5000 credits"},{"k":"fuel_cells","v":"3"}]\`. Use a stable, descriptive snake_case key so later updates to the same fact can merge (overwrite) it. Omit this block entirely when no such fact was established or changed in this response. Do NOT emit it every turn — only when genuinely new or updated numeric/transactional information appears.

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
\`\`\``
  return `${body}${playerSection ? '\n\n' + playerSection : ''}

Stay in the Game Master role. Make every choice feel meaningful. Keep the adventure moving.

REMINDER — before you finish: your response is INVALID unless it includes the \`party\` block — a \`\`\`party fenced block listing EVERY party member with name, role, hpPct, isActive. Append it now, after the prose, even if nothing changed, and even if you are also emitting a \`check\` or \`verdict\` block. The \`party\` block is MANDATORY on EVERY turn, no exceptions — never end a response without it.`
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

  const index = (term) => {
    if (!looksLikeEntity(term)) return
    const key = term.toLowerCase()
    const existing = stats.get(key)
    if (existing) {
      existing.count++
    } else {
      stats.set(key, { term, order: order++, count: 1 })
    }
  }

  const add = (raw) => {
    const term = raw.trim().replace(/[,.;:!?]+$/, '').trim()
    if (!term) return

    // Possessive/compound split (Fix #2). A bold span like
    // "Garret Ironhand's Forge of Embers" is TWO entities: the possessor
    // ("Garret Ironhand") and the possessed ("Forge of Embers"). Split on the
    // first possessive 's / ’s and index each half INDEPENDENTLY so each can
    // earn its own frequency count and digest slot. Done before the >4-word
    // gate in looksLikeEntity (which would otherwise reject the whole 5-word
    // span and lose both). Each half is still validated by looksLikeEntity, so
    // the prose/imperative/stopword/title-case guards (steps 6/7/9) still fire
    // per half — no false-positive hole. The "<Role>'s Name" label form is
    // already rejected up-front by looksLikeEntity step 2b on the whole span.
    // Kept behaviorally identical to context.js (engine-parity gate, §6).
    const poss = term.match(/^(.+?)['’]s\s+(.+)$/)
    if (poss && !/['’]s\s+name$/i.test(term)) {
      const possessor = poss[1].trim()
      const possessed = poss[2].trim()
      if (possessor) index(possessor)
      if (possessed) add(possessed) // recurse: handles chained possessives
      return
    }

    index(term)
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
