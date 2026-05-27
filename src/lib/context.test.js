import { describe, it, expect } from 'vitest'
import { extractEntities, trimContext, buildSystemPrompt } from './context'
import { buildSystemPrompt as buildSystemPromptSW, trimContext as trimContextSW, extractEntities as extractEntitiesSW } from './context.starwars'
import { buildPlayerSection, fmtMod } from './session'

// ─── trimContext ─────────────────────────────────────────────────────────────

describe('trimContext', () => {
  const makeMsg = (role, i) => ({ role, content: `msg-${i}` })

  it('returns input unchanged when under or equal to pinned+recent limit', () => {
    const msgs = Array.from({ length: 22 }, (_, i) => makeMsg('user', i))
    expect(trimContext(msgs)).toBe(msgs)
  })

  it('returns exact reference equality for short arrays', () => {
    const msgs = [makeMsg('user', 0), makeMsg('assistant', 1)]
    const result = trimContext(msgs)
    expect(result).toBe(msgs)
  })

  it('pins the opening messages and keeps the recent tail when over the limit', () => {
    // pinned=4, recent=18, total > 22
    const msgs = Array.from({ length: 30 }, (_, i) => makeMsg('user', i))
    const result = trimContext(msgs)
    // First 4 opening messages must be present
    expect(result[0]).toEqual(makeMsg('user', 0))
    expect(result[1]).toEqual(makeMsg('user', 1))
    expect(result[2]).toEqual(makeMsg('user', 2))
    expect(result[3]).toEqual(makeMsg('user', 3))
    // Last 18 messages must be present (indices 12-29)
    expect(result[result.length - 1]).toEqual(makeMsg('user', 29))
    expect(result[result.length - 18]).toEqual(makeMsg('user', 12))
    // Total length = pinned(4) + recent(18) = 22
    expect(result.length).toBe(22)
  })

  it('does not double-count when messages length is exactly pinned+recent', () => {
    const msgs = Array.from({ length: 22 }, (_, i) => makeMsg('user', i))
    const result = trimContext(msgs)
    expect(result).toBe(msgs)
    expect(result.length).toBe(22)
  })

  it('respects custom pinned and recent options', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => makeMsg('user', i))
    const result = trimContext(msgs, { pinned: 2, recent: 5 })
    expect(result.length).toBe(7) // pinned=2 + recent=5
    expect(result[0]).toEqual(makeMsg('user', 0))
    expect(result[1]).toEqual(makeMsg('user', 1))
    expect(result[6]).toEqual(makeMsg('user', 19))
  })

  it('trims correctly with a single message over limit', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => makeMsg('user', i))
    const result = trimContext(msgs)
    // No messages from the middle should appear (indices 4-6 excluded)
    const contents = result.map(m => m.content)
    expect(contents).not.toContain('msg-4')
    expect(contents).not.toContain('msg-6')
  })
})

// ─── trimContext: playerCount scaling (Fix #1) ────────────────────────────────
//
// Frozen formula (Contract A §9): recent = min(42, 18 + 8·(playerCount−1)).
// N=1→18, N=2→26, N=3→34, N=4→42 (cap), N=5→42 (cap). N=1 byte-identical.

describe('trimContext playerCount scaling', () => {
  const makeMsg = (role, i) => ({ role, content: `msg-${i}` })
  // expected recent window per the frozen capped-linear family.
  const expectedRecent = n => Math.min(42, 18 + 8 * (n - 1))

  it('N=1 (playerCount=1) is byte-identical to the unscaled default', () => {
    const msgs = Array.from({ length: 60 }, (_, i) => makeMsg('user', i))
    const withParam = trimContext(msgs, { playerCount: 1 })
    const withoutParam = trimContext(msgs)
    expect(withParam).toEqual(withoutParam)
    // pinned 4 + recent 18 = 22 messages, exactly today's behaviour.
    expect(withParam.length).toBe(22)
    // First 4 pinned + last 18 (indices 42..59).
    expect(withParam[0]).toEqual(makeMsg('user', 0))
    expect(withParam[4]).toEqual(makeMsg('user', 42))
    expect(withParam[21]).toEqual(makeMsg('user', 59))
  })

  it('N=1 short-circuit is unchanged (returns same reference when under limit)', () => {
    const msgs = Array.from({ length: 22 }, (_, i) => makeMsg('user', i))
    expect(trimContext(msgs, { playerCount: 1 })).toBe(msgs)
    // omitting playerCount must behave identically.
    expect(trimContext(msgs)).toBe(msgs)
  })

  it('scales recent for N=2,3,4,5 per the frozen formula', () => {
    for (const [n, recent] of [[2, 26], [3, 34], [4, 42], [5, 42]]) {
      expect(expectedRecent(n)).toBe(recent)
      // a generously long conversation so the window always binds.
      const msgs = Array.from({ length: 200 }, (_, i) => makeMsg('user', i))
      const result = trimContext(msgs, { playerCount: n })
      expect(result.length).toBe(4 + recent) // pinned 4 + scaled recent
      // pinned opening preserved.
      expect(result[0]).toEqual(makeMsg('user', 0))
      // tail is the last `recent` messages.
      expect(result[result.length - 1]).toEqual(makeMsg('user', 199))
      expect(result[4]).toEqual(makeMsg('user', 200 - recent))
    }
  })

  it('recent is capped at 42 (CAP) — N beyond 5 never exceeds the cap', () => {
    const msgs = Array.from({ length: 300 }, (_, i) => makeMsg('user', i))
    for (const n of [4, 5, 8, 50]) {
      const result = trimContext(msgs, { playerCount: n })
      // pinned 4 + recent capped at 42 ⇒ at most 46 messages.
      expect(result.length).toBeLessThanOrEqual(4 + 42)
      expect(result.length).toBe(46)
    }
  })

  it('recent is monotonically non-decreasing in playerCount', () => {
    const msgs = Array.from({ length: 300 }, (_, i) => makeMsg('user', i))
    let prev = 0
    for (let n = 1; n <= 8; n++) {
      const len = trimContext(msgs, { playerCount: n }).length
      expect(len).toBeGreaterThanOrEqual(prev)
      prev = len
    }
  })

  it('returned message count never exceeds pinned + recent(N)', () => {
    const msgs = Array.from({ length: 300 }, (_, i) => makeMsg('user', i))
    for (let n = 1; n <= 6; n++) {
      const result = trimContext(msgs, { playerCount: n })
      expect(result.length).toBeLessThanOrEqual(4 + expectedRecent(n))
    }
  })

  it('respects custom pinned/recent together with playerCount scaling', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => makeMsg('user', i))
    // recent base 10, +8 per extra player: N=3 ⇒ 10 + 16 = 26, capped at 42.
    const result = trimContext(msgs, { pinned: 2, recent: 10, playerCount: 3 })
    expect(result.length).toBe(2 + 26)
  })

  it('starwars trimContext === dnd trimContext for identical inputs (re-export parity)', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => makeMsg('user', i))
    for (const n of [1, 2, 4, 5]) {
      expect(trimContextSW(msgs, { playerCount: n })).toEqual(
        trimContext(msgs, { playerCount: n }),
      )
    }
    // starwars must literally be the same function reference (re-export).
    expect(trimContextSW).toBe(trimContext)
  })
})

// ─── extractEntities ─────────────────────────────────────────────────────────

describe('extractEntities', () => {
  const assistantMsg = content => ({ role: 'assistant', content })

  it('returns empty array for empty messages list', () => {
    expect(extractEntities([])).toEqual([])
  })

  it('ignores non-assistant messages', () => {
    const msgs = [
      { role: 'user', content: 'The innkeeper **Gareth** greets you.' },
      { role: 'dice', content: 'd20 → 18' },
    ]
    expect(extractEntities(msgs)).toEqual([])
  })

  it('extracts bolded proper names from assistant messages', () => {
    const msgs = [assistantMsg('The innkeeper **Gareth** nods at you.')]
    const result = extractEntities(msgs)
    expect(result).toContain('Gareth')
  })

  it('extracts multi-word bolded proper-noun titles', () => {
    const msgs = [assistantMsg('You enter the **Broken Lantern** tavern.')]
    expect(extractEntities(msgs)).toContain('Broken Lantern')
  })

  it('extracts "The X of Y" style location names', () => {
    const msgs = [assistantMsg('You find the **Forge of Embers** glowing red.')]
    expect(extractEntities(msgs)).toContain('Forge of Embers')
  })

  it('extracts double-quoted capitalized proper names', () => {
    const msgs = [assistantMsg('The guard calls out "Sven" from across the room.')]
    expect(extractEntities(msgs)).toContain('Sven')
  })

  it('deduplicates entities that appear multiple times', () => {
    const msgs = [
      assistantMsg('**Gareth** smiles. **Gareth** offers ale.'),
    ]
    const result = extractEntities(msgs)
    expect(result.filter(e => e === 'Gareth').length).toBe(1)
  })

  it('skips D&D mechanics terms like Perception and Armor Class', () => {
    const msgs = [assistantMsg('Make a **Perception** check. **Armor Class** is 15.')]
    const result = extractEntities(msgs)
    expect(result).not.toContain('Perception')
    expect(result).not.toContain('Armor Class')
  })

  it('skips long emphasis phrases (more than 5 words)', () => {
    const msgs = [assistantMsg('**This is a very long descriptive phrase indeed sir**')]
    expect(extractEntities(msgs)).toHaveLength(0)
  })

  it('skips generic labels like Hook, Name, Quest', () => {
    const msgs = [assistantMsg('**Hook**: Find the artifact. **Name**: unknown.')]
    const result = extractEntities(msgs)
    expect(result).not.toContain('Hook')
    expect(result).not.toContain('Name')
  })

  it('skips multi-word imperative phrases like "Proceed Down"', () => {
    // The imperative filter only fires on MULTI-WORD spans (words.length >= 2)
    // Single-word action verbs are not blocked (they fail the title-case multi-word test anyway).
    const msgs = [assistantMsg('**Proceed Down** the corridor. **Search the Area** here.')]
    const result = extractEntities(msgs)
    expect(result).not.toContain('Proceed Down')
    // "Search the Area" has a mid-phrase stopword "the" so also filtered
    expect(result).not.toContain('Search the Area')
  })

  it('skips pronoun filler words', () => {
    const msgs = [assistantMsg('"**Aye**", says the guard. "**Yes**"')]
    const result = extractEntities(msgs)
    expect(result).not.toContain('Aye')
    expect(result).not.toContain('Yes')
  })

  it('respects the max cap and keeps the highest-frequency entities', () => {
    // Build many unique entities + a high-frequency one
    const unique = Array.from({ length: 60 }, (_, i) => `**Name${i}**`).join(' ')
    const highFreq = '**Gareth** '.repeat(10)
    const msgs = [assistantMsg(highFreq + unique)]
    const result = extractEntities(msgs, 50)
    expect(result.length).toBeLessThanOrEqual(50)
    // High-frequency entity should survive capping
    expect(result).toContain('Gareth')
  })

  it('returns entities in first-seen order when under the cap', () => {
    const msgs = [assistantMsg('**Alma** arrived. Then **Bren** followed. **Cira** last.')]
    const result = extractEntities(msgs)
    const idxA = result.indexOf('Alma')
    const idxB = result.indexOf('Bren')
    const idxC = result.indexOf('Cira')
    expect(idxA).toBeLessThan(idxB)
    expect(idxB).toBeLessThan(idxC)
  })

  it('skips spans containing parentheses (mechanics annotations)', () => {
    const msgs = [assistantMsg('**Skill Check (Thieves Tools)** required.')]
    expect(extractEntities(msgs)).toHaveLength(0)
  })

  it('skips placeholder combatants like "Guard 1" and "Guard 2"', () => {
    const msgs = [assistantMsg('**Guard 1** attacks. **Guard 2** flanks.')]
    const result = extractEntities(msgs)
    expect(result).not.toContain('Guard 1')
    expect(result).not.toContain('Guard 2')
  })

  // ─── Fix #2: possessive/compound split ──────────────────────────────────────
  // A 5-word possessive bold span was silently dropped by the >4-word gate,
  // erasing both the possessor and the possessed entity. We now split on the
  // possessive 's and index each half independently.

  it('splits a possessive compound into possessor AND possessed (headline regression)', () => {
    const msgs = [assistantMsg("You arrive at **Garret Ironhand's Forge of Embers**, the heat washing over you.")]
    const result = extractEntities(msgs)
    expect(result).toContain('Garret Ironhand')
    expect(result).toContain('Forge of Embers')
  })

  it('handles a curly-apostrophe possessive identically to a straight one', () => {
    const straight = extractEntities([assistantMsg("**Garret Ironhand's Forge of Embers** burns bright.")])
    const curly = extractEntities([assistantMsg('**Garret Ironhand’s Forge of Embers** burns bright.')])
    expect(curly).toContain('Garret Ironhand')
    expect(curly).toContain('Forge of Embers')
    expect(curly).toEqual(straight)
  })

  it('gives the possessor and possessed independent frequency counts', () => {
    // Forge mentioned twice (compound + standalone), Garret once (compound only).
    const msgs = [
      assistantMsg("**Garret Ironhand's Forge of Embers** roars to life."),
      assistantMsg('The **Forge of Embers** glows again.'),
    ]
    const result = extractEntities(msgs)
    expect(result).toContain('Garret Ironhand')
    expect(result).toContain('Forge of Embers')
    expect(result.filter(e => e === 'Forge of Embers').length).toBe(1)
  })

  it('still extracts the surviving QA anchors (Ash Covenant, Ravenmoor, Mira, Captain Vell)', () => {
    const msgs = [
      assistantMsg('The **Ash Covenant** controls the town of **Ravenmoor**.'),
      assistantMsg('**Mira** the healer warns you about **Captain Vell**.'),
    ]
    const result = extractEntities(msgs)
    expect(result).toContain('Ash Covenant')
    expect(result).toContain('Ravenmoor')
    expect(result).toContain('Mira')
    expect(result).toContain('Captain Vell')
  })

  it('still rejects prose spans after the split logic (no new false positives)', () => {
    // No possessive, 4 words, mid-phrase stopword "Leading"/"on" → still prose.
    const msgs = [assistantMsg('A **Rope Ladder Leading Upward** and faint **Markings on Walls**.')]
    const result = extractEntities(msgs)
    expect(result).not.toContain('Rope Ladder Leading Upward')
    expect(result).not.toContain('Markings on Walls')
  })

  it('engine parity: context.js and context.starwars.js extract identical sets for the Garret span', () => {
    const msgs = [
      assistantMsg("You arrive at **Garret Ironhand's Forge of Embers**."),
      assistantMsg('The **Ash Covenant** watches from **Ravenmoor**.'),
      assistantMsg('**Mira** fears **Captain Vell**. A **Rope Ladder Leading Upward** sways.'),
    ]
    const dnd = extractEntities(msgs)
    const sw = extractEntitiesSW(msgs)
    expect(sw).toEqual(dnd)
    // sanity: the split actually produced the two halves
    expect(dnd).toContain('Garret Ironhand')
    expect(dnd).toContain('Forge of Embers')
  })
})

// ─── buildSystemPrompt ────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const p = buildSystemPrompt({})
    expect(typeof p).toBe('string')
    expect(p.length).toBeGreaterThan(0)
  })

  it('includes the campaign name when provided', () => {
    const p = buildSystemPrompt({ name: 'The Lost Mine' })
    expect(p).toContain('The Lost Mine')
  })

  it('includes campaign details when provided', () => {
    const p = buildSystemPrompt({ details: 'Dark and gritty tone' })
    expect(p).toContain('Dark and gritty tone')
  })

  it('includes context notes when provided', () => {
    const p = buildSystemPrompt({ context: 'Session 1: party met Gareth.' })
    expect(p).toContain('Session 1: party met Gareth.')
  })

  it('omits campaign name section when name is empty', () => {
    const withName = buildSystemPrompt({ name: 'TestCampaign' })
    const withoutName = buildSystemPrompt({ name: '' })
    expect(withName).toContain('TestCampaign')
    expect(withoutName).not.toContain('"TestCampaign"')
  })

  it('handles undefined input gracefully', () => {
    expect(() => buildSystemPrompt(undefined)).not.toThrow()
    expect(() => buildSystemPrompt({})).not.toThrow()
  })
})

// ─── Phase A0 — Party/check/verdict prompt instructions (PP-01..07) ──────────

describe('buildSystemPrompt — party/check/verdict instructions (PP-01..07)', () => {
  it('PP-01 dnd prompt includes party instruction tokens (party + hpPct)', () => {
    const p = buildSystemPrompt({})
    expect(p).toContain('party')
    expect(p).toContain('hpPct')
  })

  it('PP-02 dnd prompt includes check instruction tokens (check + dc)', () => {
    const p = buildSystemPrompt({})
    expect(p).toContain('check')
    expect(p).toContain('dc')
  })

  it('PP-03 dnd prompt includes verdict instruction tokens (verdict + PASS + FAIL)', () => {
    const p = buildSystemPrompt({})
    expect(p).toContain('verdict')
    expect(p).toContain('PASS')
    expect(p).toContain('FAIL')
  })

  it('PP-04 starwars prompt includes the same three groups of tokens', () => {
    const p = buildSystemPromptSW({})
    expect(p).toContain('party')
    expect(p).toContain('hpPct')
    expect(p).toContain('check')
    expect(p).toContain('dc')
    expect(p).toContain('verdict')
    expect(p).toContain('PASS')
    expect(p).toContain('FAIL')
  })

  it('PP-05 party-block instruction text byte-identical across engines', () => {
    // Extract the section that starts with the party block instruction and ends
    // before the check block instruction. Compare both engines to each other.
    const dnd = buildSystemPrompt({})
    const sw = buildSystemPromptSW({})
    // Token that appears in both party-block instructions
    const partyToken = 'hpPct'
    const dndIdx = dnd.indexOf(partyToken)
    const swIdx = sw.indexOf(partyToken)
    expect(dndIdx).toBeGreaterThan(-1)
    expect(swIdx).toBeGreaterThan(-1)
    // Extract a 50-char window around the hpPct token and compare
    const dndSnippet = dnd.slice(dndIdx, dndIdx + 50)
    const swSnippet = sw.slice(swIdx, swIdx + 50)
    expect(dndSnippet).toBe(swSnippet)
  })

  it('PP-06 check/verdict instruction text byte-identical across engines', () => {
    const dnd = buildSystemPrompt({})
    const sw = buildSystemPromptSW({})
    // The verdict result token is shared between both engines
    const verdictToken = '"PASS" or "FAIL"'
    expect(dnd).toContain(verdictToken)
    expect(sw).toContain(verdictToken)
    // Confirm the same substring occurs in both (byte-identical for the verdict spec)
    const dndIdx = dnd.indexOf(verdictToken)
    const swIdx = sw.indexOf(verdictToken)
    const dndSnippet = dnd.slice(dndIdx, dndIdx + 60)
    const swSnippet = sw.slice(swIdx, swIdx + 60)
    expect(dndSnippet).toBe(swSnippet)
  })

  it('PP-07 buildSystemPrompt(undefined) does not throw (regression)', () => {
    expect(() => buildSystemPrompt(undefined)).not.toThrow()
    expect(() => buildSystemPromptSW(undefined)).not.toThrow()
  })
})

// ─── Phase 4 — buildSystemPrompt players param ────────────────────────────────

// Shared fixture for player-section tests. Enough to produce a non-trivial prompt.
const PLAYER_A = {
  name: 'Jaycen',
  race: 'Human',
  charClass: 'Paladin',
  abilities: { STR: 16, DEX: 10, CON: 14, INT: 10, WIS: 12, CHA: 14 },
  ac: 18,
  hpMax: 45,
  hpCurrent: 36,
  conditions: [],
}

const PLAYER_B = {
  name: 'Wren',
  race: 'Elf',
  charClass: 'Rogue',
  abilities: { STR: 8, DEX: 17, CON: 12, INT: 13, WIS: 11, CHA: 10 },
  ac: 14,
  hpMax: 28,
  hpCurrent: 28,
  conditions: ['Poisoned'],
}

describe('buildSystemPrompt — Phase 4: byte-identical-when-empty invariant', () => {
  it('no players arg: output byte-identical to pre-change baseline', () => {
    const campaign = { name: 'TestCamp', details: 'Dark tone', context: 'Gareth waits.' }
    const baseline = buildSystemPrompt(campaign)          // old call site shape
    const withUndefined = buildSystemPrompt({ ...campaign })  // players not set
    const withEmpty = buildSystemPrompt({ ...campaign, players: [] })
    expect(withUndefined).toBe(baseline)
    expect(withEmpty).toBe(baseline)
  })

  it('players: undefined → DM prompt does NOT contain "Player Characters:"', () => {
    const p = buildSystemPrompt({ name: 'X' })
    expect(p).not.toContain('Player Characters:')
  })

  it('players: [] → DM prompt does NOT contain "Player Characters:"', () => {
    const p = buildSystemPrompt({ name: 'X', players: [] })
    expect(p).not.toContain('Player Characters:')
  })

  it('same result from both engines for no-players call (byte-identical body structure)', () => {
    // Engine-specific text differs by design, but we confirm neither adds player section.
    const dnd = buildSystemPrompt({})
    const sw = buildSystemPromptSW({})
    expect(dnd).not.toContain('Player Characters:')
    expect(sw).not.toContain('Player Characters:')
  })
})

describe('buildSystemPrompt — Phase 4: player section injection', () => {
  it('players present: prompt contains "Player Characters:" section', () => {
    const p = buildSystemPrompt({ name: 'X', players: [PLAYER_A] })
    expect(p).toContain('Player Characters:')
    expect(p).toContain('Jaycen')
  })

  it('player section appears BEFORE the closing persona sentence', () => {
    const p = buildSystemPrompt({ players: [PLAYER_A] })
    const sectionIdx = p.indexOf('Player Characters:')
    const personaIdx = p.indexOf('Stay in the DM role.')
    expect(sectionIdx).toBeGreaterThan(-1)
    expect(personaIdx).toBeGreaterThan(-1)
    expect(sectionIdx).toBeLessThan(personaIdx)
  })

  it('starwars engine: player section appears BEFORE the closing persona sentence', () => {
    const p = buildSystemPromptSW({ players: [PLAYER_A] })
    const sectionIdx = p.indexOf('Player Characters:')
    const personaIdx = p.indexOf('Stay in the Game Master role.')
    expect(sectionIdx).toBeGreaterThan(-1)
    expect(personaIdx).toBeGreaterThan(-1)
    expect(sectionIdx).toBeLessThan(personaIdx)
  })

  it('player line includes name, class, race, all 6 abilities with modifiers, AC, and HP', () => {
    const p = buildSystemPrompt({ players: [PLAYER_A] })
    expect(p).toContain('Jaycen (Paladin Human)')
    expect(p).toContain('STR 16(+3)')
    expect(p).toContain('DEX 10(+0)')
    expect(p).toContain('CON 14(+2)')
    expect(p).toContain('INT 10(+0)')
    expect(p).toContain('WIS 12(+1)')
    expect(p).toContain('CHA 14(+2)')
    expect(p).toContain('AC 18')
    expect(p).toContain('HP 36/45')
  })

  it('conditions are included in the player line when present', () => {
    const p = buildSystemPrompt({ players: [PLAYER_B] })
    expect(p).toContain('[Poisoned]')
  })

  it('no conditions appended when conditions array is empty', () => {
    const line = buildPlayerSection([PLAYER_A])
    expect(line).not.toContain('[')
  })
})

describe('buildSystemPrompt — Phase 4: section-level genre parity (PP-05/PP-06 style)', () => {
  it('both engines produce byte-identical "Player Characters:" section for same input', () => {
    const players = [PLAYER_A, PLAYER_B]
    const dnd = buildSystemPrompt({ players })
    const sw = buildSystemPromptSW({ players })

    // Extract the player section from each prompt (from "Player Characters:" to end, before the persona line).
    const extractSection = prompt => {
      const start = prompt.indexOf('\nPlayer Characters:\n')
      if (start === -1) return null
      // Section ends at the double-newline that precedes the closing persona line.
      const afterSection = prompt.indexOf('\n\nStay in the', start)
      return afterSection !== -1 ? prompt.slice(start, afterSection) : prompt.slice(start)
    }

    const dndSection = extractSection(dnd)
    const swSection = extractSection(sw)
    expect(dndSection).not.toBeNull()
    expect(swSection).not.toBeNull()
    expect(dndSection).toBe(swSection)
  })
})

describe('buildSystemPrompt — Phase 4: budget enforcement', () => {
  it('all 5 players are present and section stays within 1000 chars (worst-case)', () => {
    // Worst-case: long names, long race/class strings, high ability scores
    const makeLongPlayer = (i) => ({
      name: `Adventurer${i}`,
      race: 'Dragonborn',
      charClass: 'Artificer',
      abilities: { STR: 20, DEX: 20, CON: 20, INT: 20, WIS: 20, CHA: 20 },
      ac: 20,
      hpMax: 100,
      hpCurrent: 100,
      conditions: [],
    })
    const fivePlayers = Array.from({ length: 5 }, (_, i) => makeLongPlayer(i + 1))
    const section = buildPlayerSection(fivePlayers)
    // All 5 players must appear — none silently dropped
    for (let i = 1; i <= 5; i++) {
      expect(section).toContain(`Adventurer${i}`)
    }
    // Section stays within the new budget (1000 chars)
    expect(section.length).toBeLessThanOrEqual(1000)
  })

  it('all 4 players present with worst-case long names/conditions', () => {
    const makeLongPlayer = (i) => ({
      name: `VeryLongAdventurerName${i}`,
      race: 'Dragonborn',
      charClass: 'Artificer',
      abilities: { STR: 20, DEX: 20, CON: 20, INT: 20, WIS: 20, CHA: 20 },
      ac: 20,
      hpMax: 999,
      hpCurrent: 999,
      conditions: ['Poisoned', 'Frightened'],
    })
    const fourPlayers = Array.from({ length: 4 }, (_, i) => makeLongPlayer(i + 1))
    const section = buildPlayerSection(fourPlayers)
    // All 4 players must appear
    for (let i = 1; i <= 4; i++) {
      expect(section).toContain(`VeryLongAdventurerName${i}`)
    }
    expect(section.length).toBeLessThanOrEqual(1000)
  })

  it('players beyond 5 are silently dropped by the 5-player cap', () => {
    const players = Array.from({ length: 8 }, (_, i) => ({
      name: `P${i + 1}`,
      race: 'Human',
      charClass: 'Fighter',
      abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
      ac: 10,
      hpMax: 20,
      hpCurrent: 20,
      conditions: [],
    }))
    const section = buildPlayerSection(players)
    // Players 6–8 are always dropped (hard 5-player cap applied first)
    expect(section).not.toContain('P6')
    expect(section).not.toContain('P8')
    // All players 1–5 must be present
    for (let i = 1; i <= 5; i++) {
      expect(section).toContain(`P${i}`)
    }
    // Section stays within budget
    expect(section.length).toBeLessThanOrEqual(1000)
  })
})

describe('fmtMod — modifier formula', () => {
  it('score 10 → +0', () => expect(fmtMod(10)).toBe('+0'))
  it('score 11 → +0', () => expect(fmtMod(11)).toBe('+0'))
  it('score 12 → +1', () => expect(fmtMod(12)).toBe('+1'))
  it('score 16 → +3', () => expect(fmtMod(16)).toBe('+3'))
  it('score 20 → +5', () => expect(fmtMod(20)).toBe('+5'))
  it('score 8 → -1', () => expect(fmtMod(8)).toBe('-1'))
  it('score 3 → -4', () => expect(fmtMod(3)).toBe('-4'))
  it('score 9 → -1', () => expect(fmtMod(9)).toBe('-1'))
})

// ─── Fix #3: facts block prompt instructions (PP-08..14) ──────────────────────
// Verify both engines include the facts block instruction and that it is wired
// consistently (same discipline as party/check/verdict).

describe('buildSystemPrompt — Fix #3: facts block instruction (PP-08..14)', () => {
  it('PP-08 dnd prompt includes the "facts" block tag reference', () => {
    const p = buildSystemPrompt({})
    // The instruction names the block tag (appears as `facts` in the rendered prompt)
    expect(p).toContain('facts')
    // Specifically the "4. Facts block" numbered instruction
    expect(p).toContain('Facts block')
  })

  it('PP-09 dnd prompt mentions numeric/transactional facts (price/quantity)', () => {
    const p = buildSystemPrompt({})
    // The instruction should name typical numeric/transactional facts
    expect(p).toContain('price')
    expect(p).toContain('numeric')
  })

  it('PP-10 dnd prompt includes the k/v schema example keys', () => {
    const p = buildSystemPrompt({})
    // The instruction shows the {k,v} object shape with example key names
    expect(p).toContain('blacksmith_price')
    expect(p).toContain('snake_case')
  })

  it('PP-11 starwars prompt includes the "facts" block tag reference', () => {
    const p = buildSystemPromptSW({})
    // The instruction names the block tag and the numbered instruction
    expect(p).toContain('facts')
    expect(p).toContain('Facts block')
  })

  it('PP-12 starwars prompt mentions credits (genre-appropriate numeric fact)', () => {
    const p = buildSystemPromptSW({})
    expect(p).toContain('credits')
  })

  it('PP-13 starwars prompt includes the k/v schema example keys', () => {
    const p = buildSystemPromptSW({})
    // The instruction shows the {k,v} object shape with genre-appropriate example key
    expect(p).toContain('bounty_reward')
    expect(p).toContain('snake_case')
  })

  it('PP-14 both engines include the "snake_case" key-naming discipline', () => {
    const dnd = buildSystemPrompt({})
    const sw = buildSystemPromptSW({})
    // Both should mention snake_case (for key naming guidance)
    expect(dnd).toContain('snake_case')
    expect(sw).toContain('snake_case')
  })
})
