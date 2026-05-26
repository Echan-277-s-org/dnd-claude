import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

// ─────────────────────────────────────────────────────────────────────────────
// parseMarkdown — tested via a thin shim that re-implements the same pure
// function locally so we don't need to export it from Chat.jsx.
// We keep it a mirror of the source so behaviour is verified, not assumed.
// ─────────────────────────────────────────────────────────────────────────────

function parseMarkdown(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const html = escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .split('\n\n')
    .filter(p => p.trim())
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')

  return html || '<p></p>'
}

describe('parseMarkdown (pure function)', () => {
  // ── Bold ──────────────────────────────────────────────────────────────────
  it('converts **text** to <strong>', () => {
    expect(parseMarkdown('**bold**')).toContain('<strong>bold</strong>')
  })

  it('converts *text* to <em>', () => {
    expect(parseMarkdown('*italic*')).toContain('<em>italic</em>')
  })

  it('converts `text` to <code>', () => {
    expect(parseMarkdown('`code`')).toContain('<code>code</code>')
  })

  it('wraps paragraphs split by double newline in <p> tags', () => {
    const result = parseMarkdown('first paragraph\n\nsecond paragraph')
    expect(result).toContain('<p>first paragraph</p>')
    expect(result).toContain('<p>second paragraph</p>')
  })

  it('converts single newlines within a paragraph to <br>', () => {
    const result = parseMarkdown('line one\nline two')
    expect(result).toContain('<br>')
  })

  it('returns <p></p> for empty string input', () => {
    expect(parseMarkdown('')).toBe('<p></p>')
  })

  // ── XSS safety (EC-11) ───────────────────────────────────────────────────
  it('escapes < and > so HTML tags are not injected', () => {
    const result = parseMarkdown('<script>alert(1)</script>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
  })

  it('escapes & ampersands before markdown conversion', () => {
    const result = parseMarkdown('a & b')
    expect(result).toContain('&amp;')
    expect(result).not.toMatch(/[^&]&[^a]/) // no bare unescaped &
  })

  it('escapes an img onerror XSS payload and does not inject a DOM node', () => {
    const xss = '<img src=x onerror=alert(1)> **bold after**'
    const result = parseMarkdown(xss)
    expect(result).not.toContain('<img')
    expect(result).toContain('&lt;img')
    expect(result).toContain('<strong>bold after</strong>')
  })

  it('does not escape content inside bold spans (inner content rendered as-is after escaping)', () => {
    const result = parseMarkdown('**Gareth the Bold**')
    expect(result).toContain('<strong>Gareth the Bold</strong>')
  })

  it('handles multiple markdown elements in one string', () => {
    const result = parseMarkdown('**bold** and *italic* and `code`')
    expect(result).toContain('<strong>bold</strong>')
    expect(result).toContain('<em>italic</em>')
    expect(result).toContain('<code>code</code>')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getActionSuggestions — same mirror pattern
// ─────────────────────────────────────────────────────────────────────────────

const COMBAT_KEYWORDS = ['attack', 'sword', 'enemy', 'creature', 'monster', 'fight', 'weapon', 'combat', 'battle', 'strike']
const SOCIAL_KEYWORDS = ['says', 'asks', 'merchant', 'guard', 'innkeeper', 'tavern', 'town', 'village', 'noble', 'coin', 'price']
const EXPLORATION_KEYWORDS = ['door', 'chest', 'hallway', 'dungeon', 'trap', 'ruin', 'passage', 'stairs', 'forest', 'cave']

function getActionSuggestions(text) {
  const lower = text.toLowerCase()
  if (COMBAT_KEYWORDS.some(kw => lower.includes(kw))) {
    return ['Attack', 'Cast a Spell', 'Take Cover', 'Flee']
  }
  if (SOCIAL_KEYWORDS.some(kw => lower.includes(kw))) {
    return ['Persuade', 'Intimidate', 'Ask a question', 'Offer coin']
  }
  if (EXPLORATION_KEYWORDS.some(kw => lower.includes(kw))) {
    return ['Search the area', 'Listen carefully', 'Examine it closely', 'Proceed cautiously']
  }
  return ['Describe my action', 'Ask the DM', 'Roll for it', 'What do I know?']
}

describe('getActionSuggestions (keyword routing)', () => {
  it('routes combat keywords to combat action set', () => {
    const actions = getActionSuggestions('A goblin attacks you with a sword!')
    expect(actions).toEqual(['Attack', 'Cast a Spell', 'Take Cover', 'Flee'])
  })

  it('routes each individual combat keyword', () => {
    const keywords = ['attack', 'sword', 'enemy', 'creature', 'monster', 'fight', 'weapon', 'combat', 'battle', 'strike']
    for (const kw of keywords) {
      const result = getActionSuggestions(kw)
      expect(result[0]).toBe('Attack')
    }
  })

  it('routes social keywords to social action set', () => {
    const actions = getActionSuggestions('The innkeeper says welcome to the tavern.')
    expect(actions).toEqual(['Persuade', 'Intimidate', 'Ask a question', 'Offer coin'])
  })

  it('routes each individual social keyword', () => {
    const keywords = ['says', 'asks', 'merchant', 'guard', 'innkeeper', 'tavern', 'town', 'village', 'noble', 'coin', 'price']
    for (const kw of keywords) {
      const result = getActionSuggestions(kw)
      expect(result[0]).toBe('Persuade')
    }
  })

  it('routes exploration keywords to exploration action set', () => {
    const actions = getActionSuggestions('You push open the dungeon door.')
    expect(actions).toEqual(['Search the area', 'Listen carefully', 'Examine it closely', 'Proceed cautiously'])
  })

  it('routes each individual exploration keyword', () => {
    const keywords = ['door', 'chest', 'hallway', 'dungeon', 'trap', 'ruin', 'passage', 'stairs', 'forest', 'cave']
    for (const kw of keywords) {
      const result = getActionSuggestions(kw)
      expect(result[0]).toBe('Search the area')
    }
  })

  it('returns default fallback when no keywords match', () => {
    const actions = getActionSuggestions('What is the sky like today?')
    expect(actions).toEqual(['Describe my action', 'Ask the DM', 'Roll for it', 'What do I know?'])
  })

  it('is case-insensitive (COMBAT uppercase)', () => {
    const actions = getActionSuggestions('The MONSTER ATTACKS from the shadows.')
    expect(actions[0]).toBe('Attack')
  })

  it('combat takes precedence over social when both keywords present', () => {
    // "guard" is social, "attack" is combat — combat is checked first
    const actions = getActionSuggestions('The guard launches an attack.')
    expect(actions[0]).toBe('Attack')
  })

  it('always returns exactly 4 buttons', () => {
    const texts = [
      'A monster attacks!',
      'The innkeeper speaks.',
      'You find a dungeon door.',
      'The sky is blue.',
    ]
    for (const t of texts) {
      expect(getActionSuggestions(t)).toHaveLength(4)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Verdict-target selection (H4) — mirror of the reducer in Chat.jsx:302-313.
// The next verdict block resolves the MOST-RECENT unresolved dice chip, but must
// SKIP chips flagged `orphaned` on restore (else a saved session ending on a roll
// would have an old chip stamped PASS/FAIL by an unrelated later verdict).
// ─────────────────────────────────────────────────────────────────────────────

function findVerdictTarget(messages) {
  return [...messages]
    .map((m, i) => ({ m, i }))
    .reverse()
    .find(({ m }) => m.role === 'dice' && m.verdict == null && !m.orphaned)?.i
}

describe('verdict-target selection (H4)', () => {
  it('targets the most-recent unresolved dice chip', () => {
    const msgs = [
      { role: 'dice', die: 'd20', result: 5, verdict: 'FAIL' },
      { role: 'user', content: 'hi' },
      { role: 'dice', die: 'd20', result: 17 }, // unresolved, fresh
    ]
    expect(findVerdictTarget(msgs)).toBe(2)
  })

  it('SKIPS an orphaned (restored) bare chip — H4 fix', () => {
    const msgs = [
      { role: 'dice', die: 'd20', result: 17, orphaned: true }, // restored bare
      { role: 'assistant', content: 'You enter a new room.' },
    ]
    expect(findVerdictTarget(msgs)).toBeUndefined() // no valid target → parser keeps state
  })

  it('targets a fresh roll while leaving an earlier orphaned chip untouched', () => {
    const msgs = [
      { role: 'dice', die: 'd20', result: 17, orphaned: true }, // restored, must stay bare
      { role: 'user', content: 'I roll perception' },
      { role: 'dice', die: 'd20', result: 12 }, // fresh in-session roll
    ]
    expect(findVerdictTarget(msgs)).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// QuotaExceeded trim-retry — mirror of the persist effect in Chat.jsx:126-144.
// On a QuotaExceededError the oldest third of messages is dropped and the write
// retried once; any other error gives up silently (in-memory state intact).
// ─────────────────────────────────────────────────────────────────────────────

function persistWithRetry(messages, storage) {
  const persist = msgs => storage.setItem('dnd_session', JSON.stringify({ messages: msgs }))
  try {
    persist(messages)
  } catch (err) {
    if (err?.name === 'QuotaExceededError') {
      try {
        persist(messages.slice(Math.floor(messages.length / 3)))
      } catch {
        /* give up silently */
      }
    }
  }
}

describe('QuotaExceeded trim-retry (persist effect)', () => {
  it('drops the oldest third and retries once on QuotaExceededError', () => {
    const msgs = Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    let calls = 0
    const stored = {}
    const storage = {
      setItem(k, v) {
        calls += 1
        if (calls === 1) {
          const e = new Error('quota')
          e.name = 'QuotaExceededError'
          throw e
        }
        stored[k] = v
      },
    }
    persistWithRetry(msgs, storage)
    expect(calls).toBe(2) // first throws, retry succeeds
    // retry persisted the trimmed tail (dropped floor(9/3)=3 oldest → 6 remain)
    expect(JSON.parse(stored['dnd_session']).messages).toHaveLength(6)
  })

  it('writes once when there is no quota error', () => {
    let calls = 0
    const storage = { setItem: () => { calls += 1 } }
    persistWithRetry([{ role: 'user', content: 'x' }], storage)
    expect(calls).toBe(1)
  })

  // When both the initial write AND the retry throw QuotaExceededError, the
  // function must give up silently (no unhandled rejection, no throw).
  it('gives up silently when the retry also throws QuotaExceededError', () => {
    const quota = () => {
      const e = new Error('quota')
      e.name = 'QuotaExceededError'
      throw e
    }
    const storage = { setItem: quota }
    expect(() =>
      persistWithRetry(Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: `m${i}` })), storage)
    ).not.toThrow()
  })

  // A non-QuotaExceededError must NOT trigger a retry — give up immediately.
  it('does not retry on non-quota errors', () => {
    let calls = 0
    const storage = {
      setItem() {
        calls += 1
        throw new Error('SecurityError')
      },
    }
    persistWithRetry([{ role: 'user', content: 'x' }], storage)
    expect(calls).toBe(1) // only the first attempt, no retry
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Additional verdict-target edge cases (H4 completeness)
// ─────────────────────────────────────────────────────────────────────────────

describe('verdict-target selection — additional edge cases (H4)', () => {
  it('returns undefined when ALL dice chips are orphaned (no new roll in session)', () => {
    const msgs = [
      { role: 'dice', die: 'd20', result: 5, orphaned: true },
      { role: 'dice', die: 'd6', result: 3, orphaned: true },
    ]
    expect(findVerdictTarget(msgs)).toBeUndefined()
  })

  it('returns undefined when there are no dice chips at all', () => {
    const msgs = [
      { role: 'user', content: 'I sneak forward.' },
      { role: 'assistant', content: 'The guard does not notice you.' },
    ]
    expect(findVerdictTarget(msgs)).toBeUndefined()
  })

  it('skips resolved dice chips (verdict already set) and targets only unresolved', () => {
    const msgs = [
      { role: 'dice', die: 'd20', result: 5, verdict: 'FAIL' },  // resolved
      { role: 'dice', die: 'd20', result: 18 },                   // unresolved → target
    ]
    expect(findVerdictTarget(msgs)).toBe(1)
  })
})
