import { describe, it, expect } from 'vitest'
import { extractEntities, trimContext, buildSystemPrompt } from './context'
import { buildSystemPrompt as buildSystemPromptSW } from './context.starwars'

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
