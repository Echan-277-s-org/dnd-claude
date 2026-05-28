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

import { buildPlayerSection } from './session.js'
import { NO_SELF_ROLL_TAIL, DC_BAND_RULE, VERDICT_CRITICAL_CLAUSE, REMINDER_FOOTER } from './prompt-rules.js'

export function buildSystemPrompt({ name, details, context, players } = {}) {
  const playerSection = players?.length ? buildPlayerSection(players) : ''
  const body = `You are an expert, creative Dungeon Master running a Dungeons & Dragons 5th Edition campaign${name ? ` called "${name}"` : ''}.${details ? `\n\nCampaign context: ${details}` : ''}${context ? `\n\n---\nCampaign notes (use this as your knowledge of prior events, NPCs, and world state):\n\n${context}\n---` : ''}

CONTINUITY: You must track and build on everything established in this session — character names, locations named, decisions made, NPCs encountered, items found, relationships formed. Reference prior events naturally. Never contradict established facts unless there is a deliberate narrative reason.

Your role:
- Narrate scenes with vivid, atmospheric detail that engages all senses
- Voice each NPC with a distinct personality, motivation, and speech pattern
- Handle D&D 5e mechanics accurately — skill checks, saving throws, combat, conditions, spells
- When players describe actions, deliver dramatic and meaningful outcomes
- Maintain narrative continuity and remember details established earlier in the session
- Balance tension, wonder, and pacing to keep the adventure alive
- Never invent the players' character stats, HP, inventory, or abilities. If an outcome depends on information not yet established, ask the players rather than guessing.
- When an action requires a roll, name the check or save and its DC and call for it, ${NO_SELF_ROLL_TAIL}
- ${DC_BAND_RULE}

Formatting guidelines:
- Use **bold** for every NPC name and location name, especially the first time each is introduced (write the innkeeper **Sven**, not the innkeeper "Sven"). This is required for continuity tracking, not just visual style.
- Use *italics* for atmosphere, whispered speech, or internal impressions
- Separate narration and NPC dialogue with paragraph breaks
- Keep responses to 2–4 focused paragraphs — vivid but not exhaustive
- After any scene transition, ground the reader in one sentence establishing where, when, and who is present.
- End each response with a natural hook or prompt inviting the players' next action
- Always write in English only. Never emit Chinese, Japanese, Korean, or any non-Latin script characters — in narration or in any structured block.

Structured data blocks: After the narrative — at the very END of EVERY response, below all prose — append fenced code blocks that report game state to the app. These blocks are machine-read and stripped before display, so do NOT mention or describe them in your narration. Emit minified JSON (no line breaks, no trailing commas). At most one block per tag per response. Nothing should appear after the final closing fence.

1. Party block — REQUIRED in EVERY response. Append a fenced block tagged \`party\` containing a JSON array of the current party, one object per member with exactly these keys: name (string), role (string, e.g. "Fighter" or "Wizard"), hpPct (integer 0–100), isActive (boolean). The \`name\` values MUST be the ACTUAL, real, established names of the players in THIS campaign (the characters listed below and any companions introduced in play) — never invented, never derived from a role. Exactly one member has isActive true — the one whose turn or spotlight it is; all others false. Do NOT include an id field; the app assigns ids. If the party has not changed, still emit the block with the same values. CRITICAL: the member names shown in the worked example below (and their hpPct values) are illustrative placeholders that demonstrate the JSON FORMAT ONLY — they are NOT characters in this campaign and must NEVER appear in your output. Copying those example names is a serious error; always list this campaign's real party members.

2. Check block — ONLY when you are calling for a roll. When you ask the player to make a skill check, narrate the request AND append a fenced block tagged \`check\` with keys: skill (string, UPPERCASE) and dc (integer). Do not emit this block on responses where you are not requesting a roll.

3. Verdict block — ONLY when resolving a roll the player just reported. When the player's message reports a dice roll for a pending check, judge it against the DC and append a fenced block tagged \`verdict\` with keys: skill (string, UPPERCASE), dc (integer), roll (integer, echoed faithfully from the player), result (the EXACT string "PASS" or "FAIL", uppercase, nothing else). When the player reports a roll, always finalize the outcome in that same response — emit the \`verdict\` block and narrate the result, whether success or failure. Do not re-request a roll for the same action; the outcome is decided by the reported number. Echo the \`skill\` and \`dc\` values from the pending check in the player's message; do not substitute a different skill or DC. ${VERDICT_CRITICAL_CLAUSE}

4. Facts block — ONLY when a durable numeric or transactional fact is established or updated. When the session establishes a specific price paid, quantity acquired, count, date, debt, named amount, or other numeric/transactional fact that must persist across many turns, append a fenced block tagged \`facts\` containing a minified JSON array of \`{"k":"<short_snake_case_key>","v":"<value with unit>"}\` objects — for example \`[{"k":"blacksmith_price","v":"12 gold"},{"k":"torch_count","v":"6"}]\`. Use a stable, descriptive snake_case key so later updates to the same fact can merge (overwrite) it. Omit this block entirely when no such fact was established or changed in this response. Do NOT emit it every turn — only when genuinely new or updated numeric/transactional information appears.

Worked example — a reply that requests a stealth check (note the trailing blocks after the prose). The party names below (Aelis, Borin) are format placeholders only — do NOT copy them; list this campaign's real party members instead:

The corridor stretches into darkness, and you hear bootsteps echoing from the guardroom ahead. Slipping past unseen will take a steady nerve. Give me a **Stealth** check, DC 15.

\`\`\`party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":false}]
\`\`\`
\`\`\`check
{"skill":"STEALTH","dc":15}
\`\`\`

Worked example — resolving the roll the player then reports (roll of 17 fails DC 15 here only as illustration; you judge):

You press flat against the cold stone, but a loose buckle scrapes the wall and the guard's head snaps toward the sound.

\`\`\`party
[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true},{"name":"Borin","role":"Cleric","hpPct":95,"isActive":false}]
\`\`\`
\`\`\`verdict
{"skill":"STEALTH","dc":15,"roll":17,"result":"FAIL"}
\`\`\``
  return `${body}${playerSection ? '\n\n' + playerSection : ''}

Stay in the DM role. Make every choice feel meaningful. Keep the adventure moving.

${REMINDER_FOOTER}`
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

// D&D 5e mechanics / stat-block vocabulary. The model bolds these constantly
// when it narrates skill checks and renders monster stat blocks, and they
// flooded the digest in testing ("Detect Magic", "Initiative Order",
// "Armor Class", "Player Character A", "Short Rest", "Multiattack", "STR"…).
// None are ever a continuity anchor, so an exact/normalized match is safe.
const MECHANICS_TERMS = new Set([
  // skills & checks
  'perception', 'investigation', 'insight', 'persuasion', 'deception',
  'intimidation', 'stealth', 'arcana', 'history', 'nature', 'religion',
  'survival', 'medicine', 'athletics', 'acrobatics', 'sleight of hand',
  'animal handling', 'performance', 'initiative', 'initiative order',
  'monster', 'creature', 'enemy', 'enemies',
  // ability scores
  'str', 'dex', 'con', 'int', 'wis', 'cha',
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  // combat / resources
  'armor class', 'hit points', 'hit point', 'temporary hit points', 'speed',
  'damage immunities', 'damage resistances', 'damage', 'senses', 'languages',
  'challenge', 'multiattack', 'slam', 'short rest', 'long rest',
  'spell slots', 'spell slots regained', 'spell slot', 'spell save dc',
  'saving throw', 'saving throws', 'condition', 'conditions', 'advantage',
  'disadvantage', 'concentration', 'reaction', 'bonus action',
  'skills', 'skill', 'condition immunities', 'damage roll', 'vulnerabilities',
  'immutable form', 'magic resistance', 'legendary actions', 'legendary resistance',
  'proficiency', 'proficiency bonus', 'attack roll', 'ability check', 'death save',
  // spells the model commonly bolds
  'detect magic', 'identify', 'guidance', 'light', 'mage hand',
  // generic combatant placeholders
  'player character a', 'player character b', 'player character c',
  'player character', 'guard 1', 'guard 2', 'leader figure',
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

  // 1. Explicit junk lists (labels, meta phrases, filler, D&D mechanics).
  if (GENERIC_LABELS.has(lower)) return false
  if (PRONOUN_FILLER.has(lower)) return false
  if (MECHANICS_TERMS.has(lower)) return false

  // 1b. Enumerated placeholder combatants: a generic head noun followed by a
  //     single index token ("Guard 1", "Hooded Figure B", "Player Character C",
  //     "Shadow Guardian 2"). Pattern: ends with a lone digit or single A-Z.
  if (/\s(?:\d+|[A-Z])$/.test(t)) {
    const head = t.replace(/\s(?:\d+|[A-Z])$/, '').toLowerCase()
    if (GENERIC_HEAD_NOUNS.has(head) || MECHANICS_TERMS.has(head) ||
        /\b(guard|figure|character|enemy|guardian|soldier|cultist|skeleton)\b/.test(head)) {
      return false
    }
  }

  // 2. Drop anything carrying a colon — label syntax like "Shop Name:" or
  //    "Check for Traps (Perception Check):". (The caller already strips a
  //    single trailing colon, so an interior colon is the real signal.)
  if (t.includes(':')) return false

  // 2b. Possessive "<Role>'s Name" label ("Blacksmith's Name", "Captain's Name").
  if (/['’]s\s+name$/i.test(t)) return false

  // 3. Drop parenthetical mechanics annotations:
  //    "Artifact (Sunstone)", "Skill Check (Thieves' Tools)",
  //    "Disarm Traps (Dexterity Check)".
  if (/[()]/.test(t)) return false

  const words = t.split(/\s+/)

  // 4. Reject overly long phrases outright. Real D&D proper nouns essentially
  //    never exceed 4 words; longer bold spans are prose ("Rope Ladder Leading
  //    Upward", "Passage Entrance Described").
  if (words.length > 4) return false

  // 5. Reject tokens with no Latin letters at all (stray non-Latin / CJK tokens),
  //    and chat/handle artifacts like "@PlayerA".
  if (!/[A-Za-z]/.test(t)) return false
  if (t.startsWith('@')) return false

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
// Keeps the pinned openers (campaign premise + early quest anchors) and the
// newest tail of the conversation that fits inside a token budget derived from
// the model's context window.
//
// DEFAULT (token-budget path — `recent` not supplied):
//   pinned = 8   — first 8 messages are always retained.
//   softCap = 120 — hard upper bound on message count regardless of tokens.
//   numCtx  — per-model context-window size (pass the same value sent to Ollama;
//             default 32768 matches DEFAULT_NUM_CTX in session.js).
//   reserve — tokens subtracted from numCtx before computing the history budget.
//             If `systemContent` is supplied the reserve is computed dynamically:
//               estimateTokens(systemContent) + NUM_PREDICT_RESERVE + SAFETY_MARGIN
//             This self-corrects for unbounded campaign-notes length. If neither
//             `reserveTokens` nor `systemContent` is supplied, DEFAULT_RESERVE_TOKENS
//             is used as a safe fallback.
//
// The tail is filled newest-first until the remaining budget (numCtx − reserve)
// is exhausted or softCap is reached. If even the pinned openers alone exceed
// the budget (e.g. very long campaign notes on a small-ctx model), the tail
// comes back empty and only the pinned openers are returned — this ensures the
// model always receives a coherent premise even in the worst case.
//
// Single-player now deliberately uses the same wide token-budget window as
// multiplayer. The old N=1 byte-identity invariant is intentionally retired.
//
// LEGACY OVERRIDE PATH (`recent` supplied explicitly):
//   Passing an integer `recent` activates the old fixed-count window so that
//   existing override/scaling tests retain a deterministic path. playerCount
//   scaling (RECENT_PER_EXTRA_PLAYER, RECENT_CAP) applies only on this path.
//
// REFERENCE-EQUALITY SHORT-CIRCUIT:
//   When no trim is needed the original array instance is returned unchanged.
//   Tests and call sites may rely on this identity guarantee.

// Token estimate: 3.0 bytes/token (conservative vs the 3.3 prose mean — D&D content
// like "[Dice roll: d20 → 17]", "Name:" prefixes, and "k=v" facts tokenize denser)
// plus 5 tokens/message for the ChatML role/turn framing Ollama wraps each message in.
export function estimateTokens(s) {
  return Math.ceil((s?.length ?? 0) / 3.0) + 5
}

const NUM_PREDICT_RESERVE = 900   // must match the num_predict sent to Ollama (Chat.jsx / sync-server.mjs)
const SAFETY_MARGIN = 256         // tokenizer variance + BOS/EOS headroom
const DEFAULT_RESERVE_TOKENS = 4500   // fallback when neither reserveTokens nor systemContent is supplied

const RECENT_PER_EXTRA_PLAYER = 8
const RECENT_CAP = 42

export function trimContext(messages, {
  pinned        = 8,
  recent,                 // NO default — presence is the discriminant (legacy count path)
  playerCount   = 1,      // back-compat only; no effect on the token-budget path
  numCtx        = 32768,  // matches DEFAULT_NUM_CTX in session.js (per-model value passed by callers)
  reserveTokens,          // explicit override (tests); else derived from systemContent
  systemContent,          // the assembled system message; used to size the dynamic reserve
  softCap       = 120,
} = {}) {
  // ── LEGACY OVERRIDE PATH — explicit `recent` count → old fixed-window behavior.
  if (recent !== undefined) {
    const scaledRecent = playerCount > 1
      ? Math.min(RECENT_CAP, recent + RECENT_PER_EXTRA_PLAYER * (playerCount - 1))
      : recent
    if (messages.length <= pinned + scaledRecent) return messages
    return [...messages.slice(0, pinned), ...messages.slice(messages.length - scaledRecent)]
  }

  // ── TOKEN-BUDGET PATH ──
  const reserve = reserveTokens ?? (systemContent != null
    ? estimateTokens(systemContent) + NUM_PREDICT_RESERVE + SAFETY_MARGIN
    : DEFAULT_RESERVE_TOKENS)
  const budget = Math.max(0, numCtx - reserve)

  const pinnedMsgs = messages.slice(0, pinned)
  let used = pinnedMsgs.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  // SHORT-CIRCUIT — whole array fits and is under the soft cap → SAME reference (identity preserved).
  const totalEst = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  if (messages.length <= softCap && totalEst <= budget) return messages

  // Fill the tail newest-first until the budget is exhausted or the soft cap is hit.
  const tailBuf = []
  for (let i = messages.length - 1; i >= pinned && tailBuf.length < softCap; i--) {
    const tok = estimateTokens(messages[i].content)
    if (used + tok > budget) break
    tailBuf.push(messages[i])
    used += tok
  }
  tailBuf.reverse()

  // If pinned and tail windows touch/overlap, the whole array fits → SAME reference.
  const tailStart = messages.length - tailBuf.length
  if (tailStart <= pinned) return messages
  return [...pinnedMsgs, ...tailBuf]
}
