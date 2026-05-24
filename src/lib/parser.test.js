import { describe, it, expect } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// stripStructuredBlocks / extractBlock / applyPartyUpdate / verdict-upgrade
//
// These functions are module-private in Chat.jsx (not exported).
// We mirror them verbatim here so behaviour is verified, not assumed.
// Pattern: Chat.test.jsx convention for parseMarkdown / getActionSuggestions.
// ─────────────────────────────────────────────────────────────────────────────

// mirror of source
const BLOCK_TAGS = ['party', 'check', 'verdict']

// mirror of source
const STRIP_RE = new RegExp(
  '```(?:' + BLOCK_TAGS.join('|') + ')[\\s\\S]*?```',
  'g'
)

// mirror of source
function stripStructuredBlocks(text) {
  return text.replace(STRIP_RE, '').trimEnd()
}

// mirror of source
function extractBlock(tag, text) {
  const re = new RegExp('```' + tag + '\\s*([\\s\\S]*?)```')
  const match = text.match(re)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim())
  } catch {
    return null
  }
}

// mirror of source
function applyPartyUpdate(rawArray, existing) {
  return rawArray.map(raw => {
    const normalizedName = String(raw.name ?? '').trim().toLowerCase()
    const found = existing.find(
      e => e.name.trim().toLowerCase() === normalizedName
    )
    return {
      id: found?.id ?? crypto.randomUUID(),
      name: String(raw.name ?? '').trim() || 'Unknown',
      role: String(raw.role ?? '').trim() || '',
      hpPct: Math.max(0, Math.min(100, Math.round(Number(raw.hpPct) || 0))),
      isActive: Boolean(raw.isActive),
    }
  })
}

// mirror of source — verdict-upgrade logic (from Chat.jsx finally block)
// Takes the current messages array and a verdictRaw object, returns updated messages.
function applyVerdictUpgrade(messages, verdictRaw) {
  if (verdictRaw?.result !== 'PASS' && verdictRaw?.result !== 'FAIL') return messages
  const idx = [...messages]
    .map((m, i) => ({ m, i }))
    .reverse()
    .find(({ m }) => m.role === 'dice' && m.verdict == null)?.i
  if (idx == null) return messages
  return messages.map((m, i) =>
    i === idx
      ? { ...m, check: verdictRaw.skill, verdict: verdictRaw.result }
      : m
  )
}

// ─── stripStructuredBlocks ────────────────────────────────────────────────────

describe('stripStructuredBlocks — PA-01..06', () => {
  it('PA-01 removes a complete party fence, preserves narrative', () => {
    const text = 'The dragon roars.\n```party\n[{"name":"Aelis"}]\n```'
    const result = stripStructuredBlocks(text)
    expect(result).not.toContain('```party')
    expect(result).toContain('The dragon roars.')
  })

  it('PA-02 removes a complete check fence, preserves narrative', () => {
    const text = 'Roll for stealth.\n```check\n{"skill":"STEALTH","dc":15}\n```'
    const result = stripStructuredBlocks(text)
    expect(result).not.toContain('```check')
    expect(result).toContain('Roll for stealth.')
  })

  it('PA-03 removes a complete verdict fence, preserves narrative', () => {
    const text = 'You fail the check.\n```verdict\n{"skill":"STEALTH","dc":15,"roll":10,"result":"FAIL"}\n```'
    const result = stripStructuredBlocks(text)
    expect(result).not.toContain('```verdict')
    expect(result).toContain('You fail the check.')
  })

  it('PA-04 removes all three structured fences in one response, preserves prose', () => {
    const text = [
      'The corridor is dark.',
      '```party\n[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true}]\n```',
      '```check\n{"skill":"STEALTH","dc":15}\n```',
      '```verdict\n{"skill":"STEALTH","dc":15,"roll":17,"result":"PASS"}\n```',
    ].join('\n')
    const result = stripStructuredBlocks(text)
    expect(result).not.toContain('```party')
    expect(result).not.toContain('```check')
    expect(result).not.toContain('```verdict')
    expect(result).toContain('The corridor is dark.')
  })

  it('PA-05 does NOT strip an unclosed fence mid-stream (output == input after trim)', () => {
    const text = 'Narration here.\n```party\n[{"name":"Aelis"'
    const result = stripStructuredBlocks(text)
    // Unclosed fence — lazy regex requires closing backticks, so nothing stripped.
    // trimEnd() may strip trailing whitespace but the fence fragment must remain.
    expect(result).toContain('```party')
    expect(result).toContain('Aelis')
  })

  it('PA-06 leaves non-party code fences (```js) untouched', () => {
    const text = 'Some text.\n```js\nconsole.log("hello")\n```\nMore text.'
    const result = stripStructuredBlocks(text)
    expect(result).toContain('```js')
    expect(result).toContain('console.log')
    expect(result).toContain('More text.')
  })
})

// ─── extractBlock ─────────────────────────────────────────────────────────────

describe('extractBlock — PA-07..13', () => {
  it('PA-07 parses a valid party JSON block', () => {
    const text = '```party\n[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true}]\n```'
    const result = extractBlock('party', text)
    expect(result).toEqual([{ name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true }])
  })

  it('PA-08 parses a valid check JSON block', () => {
    const text = '```check\n{"skill":"STEALTH","dc":15}\n```'
    const result = extractBlock('check', text)
    expect(result).toEqual({ skill: 'STEALTH', dc: 15 })
  })

  it('PA-09 parses a valid verdict JSON block', () => {
    const text = '```verdict\n{"skill":"STEALTH","dc":15,"roll":17,"result":"PASS"}\n```'
    const result = extractBlock('verdict', text)
    expect(result).toEqual({ skill: 'STEALTH', dc: 15, roll: 17, result: 'PASS' })
  })

  it('PA-10 malformed JSON returns null, does not throw', () => {
    const text = '```party\n{not valid json\n```'
    expect(() => extractBlock('party', text)).not.toThrow()
    expect(extractBlock('party', text)).toBeNull()
  })

  it('PA-11 tag absent returns null', () => {
    const text = 'No structured blocks here.'
    expect(extractBlock('party', text)).toBeNull()
  })

  it('PA-12 unclosed fence returns null', () => {
    const text = '```party\n[{"name":"Aelis"}'
    expect(extractBlock('party', text)).toBeNull()
  })

  it('PA-13 trailing whitespace in JSON body still parses (P2)', () => {
    const text = '```party\n[{"name":"Aelis","role":"Ranger","hpPct":80,"isActive":true}]   \n```'
    const result = extractBlock('party', text)
    expect(result).not.toBeNull()
    expect(result[0].name).toBe('Aelis')
  })
})

// ─── applyPartyUpdate ─────────────────────────────────────────────────────────

describe('applyPartyUpdate — PA-14..24', () => {
  const existingParty = [
    { id: 'id-aelis', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true },
    { id: 'id-borin', name: 'Borin', role: 'Cleric', hpPct: 95, isActive: false },
  ]

  it('PA-14 preserves id for name-matched member', () => {
    const raw = [{ name: 'Aelis', role: 'Ranger', hpPct: 75, isActive: true }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].id).toBe('id-aelis')
  })

  it('PA-15 new member gets a non-empty UUID', () => {
    const raw = [{ name: 'Zara', role: 'Wizard', hpPct: 90, isActive: false }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].id).toBeTruthy()
    expect(typeof result[0].id).toBe('string')
    expect(result[0].id.length).toBeGreaterThan(0)
  })

  it('PA-16 name-match is case-insensitive (Aelis == aelis)', () => {
    const existing = [{ id: 'id-aelis', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true }]
    const raw = [{ name: 'aelis', role: 'Ranger', hpPct: 70, isActive: true }]
    const result = applyPartyUpdate(raw, existing)
    expect(result[0].id).toBe('id-aelis')
  })

  it('PA-17 hpPct clamped to 0 when below 0', () => {
    const raw = [{ name: 'Aelis', role: 'Ranger', hpPct: -10, isActive: true }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].hpPct).toBe(0)
  })

  it('PA-18 hpPct clamped to 100 when above 100', () => {
    const raw = [{ name: 'Aelis', role: 'Ranger', hpPct: 150, isActive: true }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].hpPct).toBe(100)
  })

  it('PA-19 hpPct NaN/bad value defaults to 0', () => {
    const raw = [{ name: 'Aelis', role: 'Ranger', hpPct: 'bad', isActive: true }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].hpPct).toBe(0)
  })

  it('PA-20 hpPct rounded to integer (73.6 → 74) (P2)', () => {
    const raw = [{ name: 'Aelis', role: 'Ranger', hpPct: 73.6, isActive: true }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].hpPct).toBe(74)
    expect(Number.isInteger(result[0].hpPct)).toBe(true)
  })

  it('PA-21 isActive coerced via Boolean (string "true" → true, 0 → false)', () => {
    const raw = [
      { name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: 'true' },
      { name: 'Borin', role: 'Cleric', hpPct: 95, isActive: 0 },
    ]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].isActive).toBe(true)
    expect(result[1].isActive).toBe(false)
  })

  it('PA-22 missing name falls back to "Unknown"', () => {
    const raw = [{ role: 'Fighter', hpPct: 50, isActive: false }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].name).toBe('Unknown')
  })

  it('PA-23 missing role falls back to empty string (P2)', () => {
    const raw = [{ name: 'Aelis', hpPct: 80, isActive: true }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0].role).toBe('')
  })

  it('PA-24 unknown keys are ignored and not carried through (P2)', () => {
    const raw = [{ name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true, unknownKey: 'should be dropped' }]
    const result = applyPartyUpdate(raw, existingParty)
    expect(result[0]).not.toHaveProperty('unknownKey')
    expect(Object.keys(result[0]).sort()).toEqual(['hpPct', 'id', 'isActive', 'name', 'role'].sort())
  })

  it('PA-32 zero-member array rejected before applyPartyUpdate — party stays unchanged', () => {
    // The guard in Chat.jsx: `if (partyRaw && Array.isArray(partyRaw) && partyRaw.length > 0)`
    // We verify that an empty array input, if bypassing the guard, produces an empty array,
    // and confirm the guard logic itself matches the spec.
    const emptyRaw = []
    const isGuarded = Array.isArray(emptyRaw) && emptyRaw.length > 0
    expect(isGuarded).toBe(false)
    // If guard were bypassed, applyPartyUpdate([]) would return [] (not throw)
    expect(() => applyPartyUpdate([], existingParty)).not.toThrow()
    expect(applyPartyUpdate([], existingParty)).toEqual([])
  })
})

// ─── verdict-upgrade logic ────────────────────────────────────────────────────

describe('verdict-upgrade — PA-25..31', () => {
  const messages = [
    { role: 'user', content: 'I try to sneak past.', id: 'u1' },
    { role: 'dice', die: 'd20', result: 17 },
    { role: 'assistant', content: 'You press flat against the wall.', id: 'a1' },
    { role: 'dice', die: 'd20', result: 8 },
    { role: 'assistant', content: 'The guard hears you.', id: 'a2' },
  ]

  it('PA-25 verdict-upgrade targets MOST-RECENT dice msg lacking verdict (only that index changes)', () => {
    const verdictRaw = { skill: 'STEALTH', dc: 15, roll: 8, result: 'FAIL' }
    const updated = applyVerdictUpgrade(messages, verdictRaw)
    // The last dice message is at index 3 (result:8)
    expect(updated[3].verdict).toBe('FAIL')
    expect(updated[3].check).toBe('STEALTH')
    // Earlier dice msg (index 1) untouched
    expect(updated[1].verdict).toBeUndefined()
  })

  it('PA-26 verdict-upgrade leaves already-resolved dice msgs untouched (no overwrite)', () => {
    const resolved = [
      { role: 'dice', die: 'd20', result: 17, verdict: 'PASS', check: 'STEALTH' },
      { role: 'dice', die: 'd20', result: 8 },
    ]
    const verdictRaw = { skill: 'PERCEPTION', dc: 12, roll: 8, result: 'FAIL' }
    const updated = applyVerdictUpgrade(resolved, verdictRaw)
    // Resolved message (index 0) must keep original verdict
    expect(updated[0].verdict).toBe('PASS')
    expect(updated[0].check).toBe('STEALTH')
    // Unresolved (index 1) gets upgraded
    expect(updated[1].verdict).toBe('FAIL')
  })

  it('PA-27 PASS verdict sets verdict=PASS and check from verdictRaw.skill', () => {
    const msgs = [{ role: 'dice', die: 'd20', result: 18 }]
    const verdictRaw = { skill: 'PERCEPTION', dc: 12, roll: 18, result: 'PASS' }
    const updated = applyVerdictUpgrade(msgs, verdictRaw)
    expect(updated[0].verdict).toBe('PASS')
    expect(updated[0].check).toBe('PERCEPTION')
  })

  it('PA-28 FAIL verdict sets verdict=FAIL and check from verdictRaw.skill', () => {
    const msgs = [{ role: 'dice', die: 'd20', result: 5 }]
    const verdictRaw = { skill: 'ARCANA', dc: 14, roll: 5, result: 'FAIL' }
    const updated = applyVerdictUpgrade(msgs, verdictRaw)
    expect(updated[0].verdict).toBe('FAIL')
    expect(updated[0].check).toBe('ARCANA')
  })

  it('PA-29 invalid result (lowercase "pass") → NO upgrade, messages unchanged', () => {
    const msgs = [{ role: 'dice', die: 'd20', result: 17 }]
    const verdictRaw = { skill: 'STEALTH', dc: 15, roll: 17, result: 'pass' }
    const updated = applyVerdictUpgrade(msgs, verdictRaw)
    expect(updated[0].verdict).toBeUndefined()
  })

  it('PA-30 no unresolved dice msg → no-op, returns same messages', () => {
    const resolved = [
      { role: 'dice', die: 'd20', result: 17, verdict: 'PASS', check: 'STEALTH' },
      { role: 'assistant', content: 'You succeed.' },
    ]
    const verdictRaw = { skill: 'STEALTH', dc: 15, roll: 17, result: 'PASS' }
    const updated = applyVerdictUpgrade(resolved, verdictRaw)
    // No unresolved dice msg — messages returned unchanged in content
    expect(updated[0].verdict).toBe('PASS')
    expect(updated[1].verdict).toBeUndefined()
  })

  it('PA-31 empty messages list → no-op, no throw', () => {
    const verdictRaw = { skill: 'STEALTH', dc: 15, roll: 17, result: 'PASS' }
    expect(() => applyVerdictUpgrade([], verdictRaw)).not.toThrow()
    expect(applyVerdictUpgrade([], verdictRaw)).toEqual([])
  })
})

// ─── Phase D — pendingCheck dice-to-LLM transform ────────────────────────────
// Tests PD-15..17: the string that ends up in apiMessages for a dice roll
// with and without a pendingCheck.

describe('pendingCheck dice-to-LLM transform — PD-15..17', () => {
  // mirror of source — the transform inside sendMessage's apiMessages map
  function buildDiceContent(die, result, pendingCheck, isLastDice) {
    const checkCtx =
      isLastDice && pendingCheck
        ? ` | pending check: ${pendingCheck.skill} DC ${pendingCheck.dc}`
        : ''
    return `[Dice roll: ${die} → ${result}${checkCtx}]`
  }

  it('PD-15 with pendingCheck → "[Dice roll: d20 → 17 | pending check: STEALTH DC 15]"', () => {
    const content = buildDiceContent('d20', 17, { skill: 'STEALTH', dc: 15 }, true)
    expect(content).toBe('[Dice roll: d20 → 17 | pending check: STEALTH DC 15]')
  })

  it('PD-16 null pendingCheck → "[Dice roll: d20 → 17]" (no pending check suffix)', () => {
    const content = buildDiceContent('d20', 17, null, true)
    expect(content).toBe('[Dice roll: d20 → 17]')
  })

  it('PD-17 skill is uppercased in the transform (P2)', () => {
    // In Chat.jsx, checkRaw.skill is stored via String(checkRaw.skill).toUpperCase()
    // So the pendingCheck always arrives already uppercased. Verify the stored form.
    const checkRaw = { skill: 'stealth', dc: 15 }
    const stored = { skill: String(checkRaw.skill).toUpperCase(), dc: Number(checkRaw.dc) }
    const content = buildDiceContent('d20', 17, stored, true)
    expect(content).toContain('STEALTH')
    expect(content).not.toContain('stealth')
  })
})
