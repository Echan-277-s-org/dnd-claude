// Shared context-management logic for the D&D Campaign Assistant.
//
// These three pure functions are imported by BOTH the live app
// (src/components/Chat.jsx) and the stress-test harness
// (stress-test/harness.mjs). Keeping them in one module eliminates the
// drift risk that previously required maintaining two byte-identical copies.
//
// All functions are pure: same inputs → same outputs, no side effects.

// ─────────────────────────────────────────────────────────────────────────────
// buildSystemPrompt
// ─────────────────────────────────────────────────────────────────────────────

export function buildSystemPrompt({ name, details, context } = {}) {
  return `You are an expert, creative Dungeon Master running a Dungeons & Dragons 5th Edition campaign${name ? ` called "${name}"` : ''}.${details ? `\n\nCampaign context: ${details}` : ''}${context ? `\n\n---\nCampaign notes (use this as your knowledge of prior events, NPCs, and world state):\n\n${context}\n---` : ''}

CONTINUITY: You must track and build on everything established in this session — character names, locations named, decisions made, NPCs encountered, items found, relationships formed. Reference prior events naturally. Never contradict established facts unless there is a deliberate narrative reason.

Your role:
- Narrate scenes with vivid, atmospheric detail that engages all senses
- Voice each NPC with a distinct personality, motivation, and speech pattern
- Handle D&D 5e mechanics accurately — skill checks, saving throws, combat, conditions, spells
- When players describe actions, deliver dramatic and meaningful outcomes
- Maintain narrative continuity and remember details established earlier in the session
- Balance tension, wonder, and pacing to keep the adventure alive
- Never invent the players' character stats, HP, inventory, or abilities. If an outcome depends on information not yet established, ask the players rather than guessing.
- When an action requires a roll, state which check or save and the DC, then wait for the player's roll result before narrating the outcome — do not resolve it yourself.

Formatting guidelines:
- Use **bold** for every NPC name and location name, especially the first time each is introduced (write the innkeeper **Sven**, not the innkeeper "Sven"). This is required for continuity tracking, not just visual style.
- Use *italics* for atmosphere, whispered speech, or internal impressions
- Separate narration and NPC dialogue with paragraph breaks
- Keep responses to 2–4 focused paragraphs — vivid but not exhaustive
- After any scene transition, ground the reader in one sentence establishing where, when, and who is present.
- End each response with a natural hook or prompt inviting the players' next action

Stay in the DM role. Make every choice feel meaningful. Keep the adventure moving.`
}

// ─────────────────────────────────────────────────────────────────────────────
// extractEntities
// ─────────────────────────────────────────────────────────────────────────────
//
// Pull continuity anchors (NPC names, place names, faction/item names) from the
// DM's narration so they survive as a digest even after their messages scroll
// out of the trim window. Two capture sources, matching how the model actually
// writes: **bold** spans and double-quoted proper-noun spans.
//
// Two problems this version fixes (both proven by the stress test):
//
//   1. NOISE. The model bolds far more than entities — UI/option labels
//      ("Shop Name:", "Hook"), imperative option lists ("Disarm Traps
//      (Dexterity Check)", "Proceed Down One Path"), mechanics phrases
//      ("Skill Check (Thieves' Tools)"), and meta phrases ("Out of Character",
//      "Town Name"). These flooded the digest. We now reject them with a set of
//      shape heuristics so the digest stays mostly real entities.
//
//   2. EVICTION BY RECENCY. The old code returned `slice(-max)` — the LAST N.
//      Once the cap was hit (~turn 31 in the 4096 run) every early anchor
//      (Garret, Mira, Captain Vell, the Ash Covenant, the cracked fountain) was
//      pushed out by late one-off mentions and never recovered. We now rank by
//      mention frequency (importance) with earliest-seen as the tie-break, so a
//      recurring NPC introduced at turn 3 cannot be evicted by a turn-58 aside.

// Connectives that legitimately appear inside proper-noun titles
// ("The Forge of Embers", "Hall of Ancients", "The Broken Lantern").
const TITLE_CONNECTIVES = new Set(['of', 'the'])

// Lowercase "function words" that, when they appear in the MIDDLE of a bolded
// span, signal a descriptive prose phrase rather than a proper name
// (e.g. "Markings on Walls", "Rope Ladder Leading Upward", "Movements in Water").
// `of`/`the` are deliberately NOT here — they are handled as title connectives.
const MID_PHRASE_STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'with',
  'from', 'by', 'into', 'before', 'after', 'down', 'up', 'through', 'over',
  'leading', 'about',
])

// Leading verbs that mark an imperative / option-list label
// ("Proceed Down One Path", "Investigate for Recent Activity", "Disarm Traps",
// "Rest Before Proceeding Further", "Check for Traps").
const IMPERATIVE_LEADS = new Set([
  'proceed', 'investigate', 'rest', 'disarm', 'check', 'interpret', 'interpreting',
  'examine', 'search', 'explore', 'attack', 'defend', 'retreat', 'continue',
  'descend', 'ascend', 'open', 'close', 'inspect', 'gather', 'prepare', 'avoid',
  'follow', 'listen', 'wait', 'roll', 'make', 'attempt', 'try', 'engage',
])

// Generic single-/multi-word category or meta labels the model emits as bold
// headers rather than story entities.
const GENERIC_LABELS = new Set([
  'hook', 'name', 'shop name', 'blacksmith name', 'tavern name', 'town name',
  'name of the tavern', 'name of the shop', 'name of the town',
  'shop', 'quest giver', 'quest sender', 'quest', 'artifact', 'faction',
  'faction warning', 'out of character', 'in character', 'combat', 'aye',
  'now', 'one of you', 'hooded figures', 'hooded figure', 'guard', 'leader',
  'leader figure', 'option', 'choices', 'note', 'reminder', 'objective',
])

// Single bland nouns that recur as scenery/mechanics rather than named anchors.
const GENERIC_HEAD_NOUNS = new Set([
  'hall', 'guard', 'leader', 'figure', 'option', 'note', 'choice', 'choices',
])

// Filler / pronoun fragments captured from quotes or bold.
const PRONOUN_FILLER = new Set([
  'one of you', 'you', 'i', 'we', 'they', 'he', 'she', 'it', 'us', 'them',
  'aye', 'now', 'well', 'yes', 'no', 'okay',
])

function looksLikeEntity(term) {
  const t = term.trim()
  if (!t) return false

  const lower = t.toLowerCase()

  // 1. Explicit junk lists (labels, meta phrases, filler).
  if (GENERIC_LABELS.has(lower)) return false
  if (PRONOUN_FILLER.has(lower)) return false

  // 2. Drop anything carrying a colon — label syntax like "Shop Name:" or
  //    "Check for Traps (Perception Check):". (The caller already strips a
  //    single trailing colon, so an interior colon is the real signal.)
  if (t.includes(':')) return false

  // 3. Drop parenthetical mechanics annotations:
  //    "Artifact (Sunstone)", "Skill Check (Thieves' Tools)",
  //    "Disarm Traps (Dexterity Check)".
  if (/[()]/.test(t)) return false

  const words = t.split(/\s+/)

  // 4. Reject overly long phrases outright. Real D&D proper nouns essentially
  //    never exceed 4 words; longer bold spans are prose ("Rope Ladder Leading
  //    Upward", "Passage Entrance Described").
  if (words.length > 4) return false

  // 5. Reject tokens with no Latin letters at all (stray CJK like "钩子").
  if (!/[A-Za-z]/.test(t)) return false

  // 6. Imperative / option-list phrases: leading word is an action verb AND the
  //    phrase is multi-word ("Disarm Traps", "Proceed Down One Path",
  //    "Interpreting the Roll", "Check for Traps").
  if (words.length >= 2 && IMPERATIVE_LEADS.has(words[0].toLowerCase())) {
    return false
  }

  // 7. Descriptive prose phrases: a lowercase prose stopword sitting in the
  //    MIDDLE ("Markings on Walls", "Subtle Movements in Water"). `of`/`the`
  //    are NOT stopwords here, so proper-noun titles ("The Forge of Embers",
  //    "Hall of Ancients", "The Broken Lantern") survive.
  if (words.length >= 3) {
    for (let i = 1; i < words.length - 1; i++) {
      if (MID_PHRASE_STOPWORDS.has(words[i].toLowerCase())) return false
    }
  }

  // 8. Single-word generic scenery / header nouns ("Hall", "Figure", "Guard").
  if (words.length === 1 && GENERIC_HEAD_NOUNS.has(lower)) return false

  // 9. Title-case requirement for multi-word spans. Every word must be either
  //    capitalized (proper-noun word) or an allowed title connective (of/the).
  //    This keeps "The Forge of Embers" / "Stone Golem" / "Weeping Arch" and
  //    drops lower-cased prose ("damp stone path") and connective-joined prose
  //    that slipped past step 7 ("Cracks and Inscriptions" — `and` is a
  //    stopword so already gone; this is the backstop).
  if (words.length >= 2) {
    const ok = words.every(w => /^[A-Z]/.test(w) || TITLE_CONNECTIVES.has(w.toLowerCase()))
    if (!ok) return false
    // A title cannot be ALL connectives, and must have a real capitalized word.
    if (!words.some(w => /^[A-Z]/.test(w))) return false
  }

  return true
}

export function extractEntities(messages, max = 50) {
  // Track, per normalized key: the canonical display term, first-seen order,
  // and a mention count across the whole session.
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

  // A double-quoted span counts as a name only if it's 1–3 words, each
  // capitalized, with no mid-string sentence punctuation — keeps "Sven"/"Tomas"
  // but rejects dialogue like "Please help!" or "Well, now,".
  const isProperName = (s) => {
    const words = s.trim().replace(/[,.]+$/, '').trim().split(/\s+/)
    if (words.length < 1 || words.length > 3) return false
    return words.every(w => /^[A-Z][\p{L}'’-]*$/u.test(w))
  }

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.content) continue
    for (const match of m.content.matchAll(/\*\*([^*\n]+)\*\*/g)) {
      const term = match[1].trim()
      if (!term || term.split(/\s+/).length > 5) continue // skip long emphasis phrases
      add(term)
    }
    for (const match of m.content.matchAll(/["“”]([^"“”\n]{1,40})["“”]/g)) {
      if (isProperName(match[1])) add(match[1])
    }
  }

  const all = [...stats.values()]

  // Under the cap: keep everything, but emit in first-seen order so the digest
  // reads as a stable timeline of the campaign.
  if (all.length <= max) {
    return all.sort((a, b) => a.order - b.order).map(e => e.term)
  }

  // Over the cap: keep the highest-VALUE entities, where value = mention count
  // (an anchor referenced many times is a continuity backbone), tie-broken by
  // earliest-seen (continuity anchors are introduced early). This guarantees a
  // recurring early NPC is never evicted by a one-off late mention. The survivors
  // are then re-sorted into first-seen order for a readable digest.
  const survivors = all
    .slice()
    .sort((a, b) => (b.count - a.count) || (a.order - b.order))
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map(e => e.term)

  return survivors
}

// ─────────────────────────────────────────────────────────────────────────────
// trimContext
// ─────────────────────────────────────────────────────────────────────────────
//
// Pin the opening messages (campaign premise + quest hook + quest-giver) and
// keep the most-recent tail. pinned=4 covers the FIRST TWO exchanges
// (user+assistant ×2), so the Turn-2 premise/quest-giver (e.g. Elder Sorcha)
// survives long sessions instead of being evicted. The length guard prevents
// pinned and recent from double-counting on short conversations.

export function trimContext(messages, { pinned = 4, recent = 18 } = {}) {
  if (messages.length <= pinned + recent) return messages
  return [...messages.slice(0, pinned), ...messages.slice(messages.length - recent)]
}
