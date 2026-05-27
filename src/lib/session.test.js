import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SCHEMA_VERSION,
  getLanHost,
  serializeSession,
  deserializeSession,
  campaignToSessionId,
  sessionFileName,
  toMarkdown,
  fromMarkdown,
  loadSyncSession,
  saveSyncSession,
  pollSyncSession,
  deleteSyncSession,
  markOrphanedDice,
  extractCharacterFromPayload,
  applyPartyUpdate,
  buildPlayersForPrompt,
  buildPlayerSection,
  fmtMod,
} from './session'

// ─── fixtures ─────────────────────────────────────────────────────────────────

const CAMPAIGN = {
  name: 'Jaycen Hawke',
  genre: 'dnd',
  details: 'A grim cathedral',
  context: '**Sister Veil** tends the altar.',
  model: 'qwen2.5:14b',
  sessionId: '7f3a-uuid',
}

const STATE = {
  campaign: CAMPAIGN,
  messages: [
    { role: 'user', content: 'I push open the chapel doors.' },
    { role: 'assistant', content: 'The hinges groan. **Sister Veil** turns. Candlelight wavers.', id: 'a1' },
    { role: 'dice', die: 'd20', result: 17, check: 'PERCEPTION', verdict: 'PASS' },
  ],
  sessionLog: [{ time: '14:30', text: 'I push open the chapel doors.' }],
  party: [{ id: 'p1', name: 'Jaycen Hawke', role: 'Paladin', hpPct: 80, isActive: true }],
}

// ─── getLanHost ────────────────────────────────────────────────────────────────

describe('getLanHost', () => {
  it('falls back to localhost when no window hostname', () => {
    expect(getLanHost(3001)).toBe('localhost:3001')
    expect(getLanHost()).toBe('localhost')
  })
})

// ─── serialize / deserialize ─────────────────────────────────────────────────

describe('serializeSession', () => {
  it('produces a schemaVersion-1 payload with sessionId from campaign', () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    expect(p.schemaVersion).toBe(SCHEMA_VERSION)
    expect(p.sessionId).toBe('7f3a-uuid')
    expect(p.savedAt).toBe('2026-05-25T14:32:11Z')
    expect(p.messages).toHaveLength(3)
    expect(p.party).toHaveLength(1)
  })

  it('strips campaign fields outside the allowlist (no entities/pendingCheck leak)', () => {
    const p = serializeSession({
      ...STATE,
      campaign: { ...CAMPAIGN, secret: 'x', pendingCheck: { skill: 'X', dc: 1 } },
    })
    expect(p.campaign).not.toHaveProperty('secret')
    expect(p.campaign).not.toHaveProperty('pendingCheck')
    expect(Object.keys(p.campaign).sort()).toEqual(
      ['context', 'details', 'genre', 'model', 'name', 'sessionId']
    )
  })

  it('defaults missing arrays to [] and stamps savedAt when absent', () => {
    const p = serializeSession({ campaign: CAMPAIGN })
    expect(p.messages).toEqual([])
    expect(p.sessionLog).toEqual([])
    expect(p.party).toEqual([])
    expect(typeof p.savedAt).toBe('string')
  })
})

describe('deserializeSession', () => {
  it('round-trips a serialized payload', () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    const back = deserializeSession(JSON.stringify(p))
    expect(back).toEqual(p)
  })

  it('accepts an object as well as a string', () => {
    const p = serializeSession(STATE)
    expect(deserializeSession(p)).toEqual(p)
  })

  it('returns null on null / corrupt JSON / wrong schemaVersion', () => {
    expect(deserializeSession(null)).toBeNull()
    expect(deserializeSession('{bad json}')).toBeNull()
    expect(deserializeSession(JSON.stringify({ schemaVersion: 99 }))).toBeNull()
    expect(deserializeSession('"a string"')).toBeNull()
  })

  it('falls back to campaign.sessionId when top-level sessionId missing', () => {
    const back = deserializeSession({
      schemaVersion: 1,
      campaign: { sessionId: 'nested' },
      messages: [],
    })
    expect(back.sessionId).toBe('nested')
  })
})

// ─── filenames ─────────────────────────────────────────────────────────────────

describe('campaignToSessionId / sessionFileName', () => {
  it('kebab-cases names and trims dashes', () => {
    expect(campaignToSessionId('Jaycen Hawke!!')).toBe('jaycen-hawke')
    expect(campaignToSessionId('  --Solace--  ')).toBe('solace')
    expect(campaignToSessionId('')).toBe('session')
  })

  it('builds a dated filename', () => {
    expect(sessionFileName(CAMPAIGN, '2026-05-25T14:32:11Z')).toBe('jaycen-hawke-2026-05-25.md')
  })
})

// ─── Markdown round-trip (the A2 contract) ────────────────────────────────────

describe('toMarkdown / fromMarkdown', () => {
  it('renders prose sections + a lossless session block', () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    const md = toMarkdown(p)
    expect(md).toContain('# Session — Jaycen Hawke')
    expect(md).toContain('## Continue from here')
    expect(md).toContain('campaigns/jaycen-hawke.md')
    expect(md).toContain('## Where we are')
    expect(md).toContain('| Jaycen Hawke | Paladin | 80% | ▶ |')
    expect(md).toContain('**You:** I push open the chapel doors.')
    expect(md).toContain('🎲 d20 → 17 · PERCEPTION → **PASS**')
    expect(md).toContain('```session')
  })

  it('is lossless: fromMarkdown(toMarkdown(p)) === p', () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    const back = fromMarkdown(toMarkdown(p))
    expect(back).toEqual(p)
  })

  it('surfaces pendingCheck as a prose line but never in the block', () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    const md = toMarkdown(p, { skill: 'PERCEPTION', dc: 15 })
    expect(md).toContain('**Pending check:** PERCEPTION DC 15')
    const back = fromMarkdown(md)
    expect(back).not.toHaveProperty('pendingCheck')
  })

  it('fromMarkdown returns null for a file with no session block (prose-only)', () => {
    expect(fromMarkdown('# Just notes\n\n**Sister Veil** guards the altar.')).toBeNull()
    expect(fromMarkdown(123)).toBeNull()
  })

  it('fromMarkdown returns null for a malformed session block', () => {
    expect(fromMarkdown('```session\n{ not json }\n```')).toBeNull()
  })

  it('fromMarkdown returns null for a truncated block with no closing fence', () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    const md = toMarkdown(p)
    const truncated = md.replace(/```\s*$/, '') // drop the trailing closing fence
    expect(fromMarkdown(truncated)).toBeNull()
  })

  it('handles an empty session gracefully', () => {
    const p = serializeSession({ campaign: CAMPAIGN })
    const md = toMarkdown(p)
    expect(md).toContain('No narration yet')
    expect(md).toContain('No messages yet')
    expect(fromMarkdown(md)).toEqual(p)
  })
})

// ─── Phase A reload path (persist → hydrate via mock Storage) ─────────────────
// Mirrors what Chat.jsx does: on a settled turn it writes serializeSession(...)
// to 'dnd_session'; on boot it hydrates messages/sessionLog from
// deserializeSession(localStorage.getItem('dnd_session')).

describe('Phase A reload path', () => {
  const store = (() => {
    let s = {}
    return {
      getItem: k => s[k] ?? null,
      setItem: (k, v) => { s[k] = String(v) },
      removeItem: k => { delete s[k] },
      clear: () => { s = {} },
    }
  })()

  beforeEach(() => store.clear())

  it('survives a refresh: persisted messages + sessionLog rehydrate', () => {
    // turn settles → Chat persists
    store.setItem('dnd_session', JSON.stringify(serializeSession(STATE)))
    // boot → Chat hydrates
    const hydrated = deserializeSession(store.getItem('dnd_session'))
    expect(hydrated.messages).toEqual(STATE.messages)
    expect(hydrated.sessionLog).toEqual(STATE.sessionLog)
    expect(hydrated.party).toEqual(STATE.party)
  })

  it('empty storage hydrates to no messages (fresh session)', () => {
    expect(deserializeSession(store.getItem('dnd_session'))).toBeNull()
  })

  it('New Session clears the key → next boot is empty', () => {
    store.setItem('dnd_session', JSON.stringify(serializeSession(STATE)))
    store.removeItem('dnd_session') // handleNewSession
    expect(deserializeSession(store.getItem('dnd_session'))).toBeNull()
  })
})

// ─── markOrphanedDice (H4) ────────────────────────────────────────────────────

describe('markOrphanedDice', () => {
  it('flags bare (unresolved) dice messages orphaned', () => {
    const out = markOrphanedDice([
      { role: 'user', content: 'hi' },
      { role: 'dice', die: 'd20', result: 17 }, // bare
    ])
    expect(out[0]).toEqual({ role: 'user', content: 'hi' }) // untouched
    expect(out[1].orphaned).toBe(true)
  })

  it('leaves already-resolved dice messages alone', () => {
    const resolved = { role: 'dice', die: 'd20', result: 17, check: 'PERCEPTION', verdict: 'PASS' }
    const out = markOrphanedDice([resolved])
    expect(out[0].orphaned).toBeUndefined()
  })

  it('is defensive: non-array → []', () => {
    expect(markOrphanedDice(null)).toEqual([])
    expect(markOrphanedDice(undefined)).toEqual([])
  })
})

// ─── sync API (mocked fetch) ──────────────────────────────────────────────────

describe('sync API', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loadSyncSession rejects an unsafe id without calling fetch', async () => {
    expect(await loadSyncSession('../../etc')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loadSyncSession returns the payload on 200', async () => {
    const p = serializeSession(STATE, '2026-05-25T14:32:11Z')
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => p })
    const result = await loadSyncSession('7f3a-uuid')
    expect(result).toEqual(p)
  })

  it('loadSyncSession returns {unchanged} on 304', async () => {
    fetch.mockResolvedValue({ ok: false, status: 304 })
    expect(await loadSyncSession('7f3a-uuid', '2026-05-25T14:32:11Z')).toEqual({ unchanged: true })
  })

  it('loadSyncSession returns null on 404 / network error', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404 })
    expect(await loadSyncSession('7f3a-uuid')).toBeNull()
    fetch.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await loadSyncSession('7f3a-uuid')).toBeNull()
  })

  it('saveSyncSession returns {ok, savedAt} on success', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ savedAt: 'stamp' }) })
    const p = serializeSession(STATE)
    expect(await saveSyncSession(p)).toEqual({ ok: true, savedAt: 'stamp' })
  })

  it('saveSyncSession flags a 409 conflict (non-destructive)', async () => {
    fetch.mockResolvedValue({ status: 409, json: async () => ({ savedAt: 'newer' }) })
    const p = serializeSession(STATE)
    expect(await saveSyncSession(p)).toEqual({ ok: false, conflict: true, savedAt: 'newer' })
  })

  it('saveSyncSession degrades to {ok:false} on network error', async () => {
    fetch.mockRejectedValue(new Error('down'))
    expect(await saveSyncSession(serializeSession(STATE))).toEqual({ ok: false })
  })

  it('saveSyncSession rejects an unsafe id without fetch', async () => {
    expect(await saveSyncSession({ sessionId: 'bad/../id' })).toEqual({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('deleteSyncSession DELETEs a safe id and degrades on error', async () => {
    fetch.mockResolvedValue({ ok: true, status: 204 })
    expect(await deleteSyncSession('7f3a-uuid')).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/session/7f3a-uuid'), { method: 'DELETE' })
    fetch.mockRejectedValue(new Error('down'))
    expect(await deleteSyncSession('7f3a-uuid')).toEqual({ ok: false })
  })

  it('deleteSyncSession rejects an unsafe id without fetch', async () => {
    expect(await deleteSyncSession('bad/../id')).toEqual({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  // When the server responds 404 (file already gone — ENOENT-equivalent) the
  // DELETE should still degrade gracefully to { ok: false }, not throw.
  it('deleteSyncSession degrades gracefully on a 404 response (server ENOENT)', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404 })
    expect(await deleteSyncSession('7f3a-uuid')).toEqual({ ok: false })
  })

  it('pollSyncSession fires onNewer only when savedAt advances', async () => {
    vi.useFakeTimers()
    const p = { ...serializeSession(STATE), savedAt: 'T2' }
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => p })
    const onNewer = vi.fn()
    let current = 'T1'
    const stop = pollSyncSession('7f3a-uuid', () => current, onNewer, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onNewer).toHaveBeenCalledWith(p)
    stop()
    vi.useRealTimers()
  })
})

// ─── Phase 1 — v3 schema: characters map ─────────────────────────────────────

const SYNCED_CHAR = {
  name: 'Jaycen Hawke',
  race: 'Human',
  charClass: 'Paladin',
  abilities: { STR: 16, DEX: 10, CON: 14, INT: 10, WIS: 12, CHA: 14 },
  ac: 18,
  hpMax: 45,
}

const CHARS_MAP = { Alex: SYNCED_CHAR }

// ─── v1 / v2 / v3 deserialization ────────────────────────────────────────────

describe('Phase 1 — deserializeSession: v1 / v2 / v3 version handling', () => {
  it('v1 payload: does not throw, backfills characters to {}', () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'v1-id',
      savedAt: '2026-01-01T00:00:00.000Z',
      campaign: { name: 'Old', genre: 'dnd', model: 'q', sessionId: 'v1-id' },
      messages: [],
      sessionLog: [],
      party: [],
    })
    const result = deserializeSession(v1)
    expect(result).not.toBeNull()
    expect(result.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.characters).toEqual({})
    // Party rows untouched — no character fields added
    expect(result.party).toEqual([])
  })

  it('v2 payload: does not throw, backfills characters to {}', () => {
    const v2 = {
      schemaVersion: 2,
      sessionId: 'v2-id',
      savedAt: '2026-05-01T00:00:00.000Z',
      campaign: { name: 'MP', genre: 'dnd', model: 'q', sessionId: 'v2-id' },
      messages: [],
      sessionLog: [],
      party: [{ id: 'p1', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: false }],
      roomCode: 'dnd-v2v2v2v2',
      phase: 'free-roam',
      turnSequence: 5,
    }
    const result = deserializeSession(v2)
    expect(result).not.toBeNull()
    expect(result.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.characters).toEqual({})
    // Party rows exactly as-is — no character fields added to rows
    expect(result.party).toHaveLength(1)
    expect(result.party[0]).not.toHaveProperty('charClass')
    expect(result.party[0]).not.toHaveProperty('abilities')
  })

  it('v3 payload: reads characters map without backfill', () => {
    const v3 = {
      schemaVersion: 3,
      sessionId: 'v3-id',
      savedAt: '2026-05-26T00:00:00.000Z',
      campaign: { name: 'Chars', genre: 'dnd', model: 'q', sessionId: 'v3-id' },
      messages: [],
      sessionLog: [],
      party: [],
      roomCode: null,
      phase: 'free-roam',
      turnSequence: 0,
      characters: CHARS_MAP,
    }
    const result = deserializeSession(v3)
    expect(result).not.toBeNull()
    expect(result.schemaVersion).toBe(3)
    expect(result.characters).toEqual(CHARS_MAP)
  })

  it('schemaVersion > 3 returns null (existing invariant)', () => {
    expect(deserializeSession({ schemaVersion: 4 })).toBeNull()
    expect(deserializeSession({ schemaVersion: 99 })).toBeNull()
  })
})

// ─── characters field in serialize / deserialize ──────────────────────────────

describe('Phase 1 — serialize → deserialize round-trips characters', () => {
  it('serializeSession carries characters (default {})', () => {
    const p = serializeSession({ campaign: CAMPAIGN })
    expect(p.characters).toEqual({})
  })

  it('serializeSession carries a supplied characters map', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP })
    expect(p.characters).toEqual(CHARS_MAP)
  })

  it('characters map survives a serialize → deserialize round-trip', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP }, '2026-05-26T00:00:00.000Z')
    const back = deserializeSession(p)
    expect(back.characters).toEqual(CHARS_MAP)
  })

  it('unknown fields in a character entry are stripped (allowlist)', () => {
    const dirty = {
      schemaVersion: 3,
      sessionId: 'x',
      savedAt: 'T',
      campaign: {},
      messages: [],
      sessionLog: [],
      party: [],
      characters: {
        Alex: { ...SYNCED_CHAR, secretKey: 'evil', hpCurrent: 999, conditions: ['poisoned'] },
      },
    }
    const result = deserializeSession(dirty)
    // allowlist: name, race, charClass, abilities, ac, hpMax — no extras
    expect(result.characters.Alex).not.toHaveProperty('secretKey')
    expect(result.characters.Alex).not.toHaveProperty('conditions')
    expect(result.characters.Alex).toHaveProperty('name')
    expect(result.characters.Alex).toHaveProperty('abilities')
  })
})

// ─── .md round-trip: toMarkdown / fromMarkdown preserves characters ────────────

describe('Phase 1 — .md round-trip preserves characters', () => {
  it('toMarkdown includes characters in the authoritative session block', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP }, '2026-05-26T00:00:00.000Z')
    const md = toMarkdown(p)
    expect(md).toContain('"characters"')
    expect(md).toContain('Jaycen Hawke')
  })

  it('toMarkdown emits an informational characters prose section when characters are present', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP }, '2026-05-26T00:00:00.000Z')
    const md = toMarkdown(p)
    expect(md).toContain('## Player Characters')
    expect(md).toContain('| Alex |')
    expect(md).toContain('Paladin')
  })

  it('toMarkdown does NOT emit a characters prose section when characters is empty', () => {
    const p = serializeSession({ campaign: CAMPAIGN }, '2026-05-26T00:00:00.000Z')
    const md = toMarkdown(p)
    expect(md).not.toContain('## Player Characters')
  })

  it('fromMarkdown(toMarkdown(p)) restores characters losslessly', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP }, '2026-05-26T00:00:00.000Z')
    const back = fromMarkdown(toMarkdown(p))
    expect(back).toEqual(p)
    expect(back.characters).toEqual(CHARS_MAP)
  })

  it('.md with no characters block (v1/v2 format) loads with characters backfilled to {}', () => {
    const v1Block = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'v1-md-id',
      savedAt: '2026-01-01T00:00:00.000Z',
      campaign: CAMPAIGN,
      messages: [],
      sessionLog: [],
      party: [],
    })
    const md = `# Session — Legacy\n\n\`\`\`session\n${v1Block}\n\`\`\`\n`
    const result = fromMarkdown(md)
    expect(result).not.toBeNull()
    expect(result.characters).toEqual({})
  })
})

// ─── extractCharacterFromPayload ──────────────────────────────────────────────

describe('Phase 1 — extractCharacterFromPayload', () => {
  const CHAR_B = {
    name: 'Wren',
    race: 'Elf',
    charClass: 'Rogue',
    abilities: { STR: 8, DEX: 17, CON: 12, INT: 13, WIS: 11, CHA: 10 },
    ac: 14,
    hpMax: 28,
  }
  const TWO_CHARS = { Alex: SYNCED_CHAR, Wren: CHAR_B }

  // Precedence (1): exact displayName match
  it('precedence 1 — returns characters[displayName] when exact key matches', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: TWO_CHARS })
    const c = extractCharacterFromPayload(p, 'Alex')
    expect(c).toEqual(SYNCED_CHAR)
  })

  it('precedence 1 — returns the correct entry for the second displayName', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: TWO_CHARS })
    const c = extractCharacterFromPayload(p, 'Wren')
    expect(c).toEqual(CHAR_B)
  })

  // Precedence (2): first characters entry when displayName not found
  it('precedence 2 — returns the first characters entry when displayName is absent', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP })
    const c = extractCharacterFromPayload(p, 'NoSuchPlayer')
    expect(c).toEqual(SYNCED_CHAR)
  })

  it('precedence 2 — returns the first characters entry when displayName is null', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP })
    const c = extractCharacterFromPayload(p, null)
    expect(c).toEqual(SYNCED_CHAR)
  })

  // Precedence (3): derive from first party row when characters is empty
  it('precedence 3 — derives from first party row when characters map is empty', () => {
    const p = serializeSession({
      campaign: CAMPAIGN,
      characters: {},
      party: [{ id: 'p1', name: 'Elara', role: 'Wizard', hpPct: 100, isActive: false }],
    })
    const c = extractCharacterFromPayload(p, 'SomeName')
    expect(c).not.toBeNull()
    expect(c.name).toBe('Elara')
    expect(c.charClass).toBe('Wizard')
    expect(c.race).toBe('Human')
  })

  // Graceful null on malformed / blockless input
  it('returns null for a markdown string with no session block', () => {
    const result = extractCharacterFromPayload('# Just notes\n\nNo block here.', 'Alex')
    expect(result).toBeNull()
  })

  it('returns null for malformed JSON in session block', () => {
    const result = extractCharacterFromPayload('```session\n{ not json }\n```', 'Alex')
    expect(result).toBeNull()
  })

  it('returns null for null input', () => {
    expect(extractCharacterFromPayload(null, 'Alex')).toBeNull()
  })

  it('returns null for a payload with no party and no characters', () => {
    const p = serializeSession({ campaign: CAMPAIGN })
    const c = extractCharacterFromPayload(p, 'Alex')
    expect(c).toBeNull()
  })

  it('accepts a markdown string and extracts from the session block', () => {
    const p = serializeSession({ campaign: CAMPAIGN, characters: CHARS_MAP }, '2026-05-26T00:00:00.000Z')
    const md = toMarkdown(p)
    const c = extractCharacterFromPayload(md, 'Alex')
    expect(c).toEqual(SYNCED_CHAR)
  })
})

// ─── Phase 4 — applyPartyUpdate: conditions normalization (Refactor 2) ────────

describe('Phase 4 — applyPartyUpdate: conditions normalization', () => {
  const BASE_ROW = { name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true }

  it('raw conditions array is normalized: trimmed, empties dropped, kept', () => {
    const result = applyPartyUpdate([
      { ...BASE_ROW, conditions: ['  Poisoned  ', '', 'Frightened'] },
    ], [])
    expect(result[0].conditions).toEqual(['Poisoned', 'Frightened'])
  })

  it('raw conditions array is capped at 10 entries', () => {
    const many = Array.from({ length: 15 }, (_, i) => `Cond${i}`)
    const result = applyPartyUpdate([{ ...BASE_ROW, conditions: many }], [])
    expect(result[0].conditions).toHaveLength(10)
  })

  it('each condition is capped at 64 characters', () => {
    const longCond = 'x'.repeat(100)
    const result = applyPartyUpdate([{ ...BASE_ROW, conditions: [longCond] }], [])
    expect(result[0].conditions[0]).toHaveLength(64)
  })

  it('when raw.conditions is absent (DM omits field), existing conditions are preserved', () => {
    const existing = [{ id: 'e1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: ['Blinded'] }]
    const result = applyPartyUpdate([{ name: 'Jaycen', role: 'Paladin', hpPct: 70, isActive: true }], existing)
    // conditions field is absent from raw → preserve existing
    expect(result[0].conditions).toEqual(['Blinded'])
  })

  it('when raw.conditions is null (DM omits), existing conditions are preserved', () => {
    const existing = [{ id: 'e1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: ['Prone'] }]
    const result = applyPartyUpdate([{ ...BASE_ROW, conditions: null }], existing)
    expect(result[0].conditions).toEqual(['Prone'])
  })

  it('when raw.conditions is a non-array value (string), treat as absent → preserve existing', () => {
    const existing = [{ id: 'e1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: ['Restrained'] }]
    const result = applyPartyUpdate([{ ...BASE_ROW, conditions: 'Poisoned' }], existing)
    expect(result[0].conditions).toEqual(['Restrained'])
  })

  it('new party member with no prior row defaults conditions to []', () => {
    const result = applyPartyUpdate([BASE_ROW], [])
    expect(result[0].conditions).toEqual([])
  })

  it('raw conditions array with explicit empty array clears existing conditions', () => {
    const existing = [{ id: 'e1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: ['Blinded'] }]
    const result = applyPartyUpdate([{ ...BASE_ROW, conditions: [] }], existing)
    // Empty array IS a valid array → clears (not preserve path)
    expect(result[0].conditions).toEqual([])
  })

  it('all five existing party-row fields are unchanged by conditions addition', () => {
    const result = applyPartyUpdate([{ name: 'Aelis', role: 'Ranger', hpPct: 75, isActive: false, conditions: [] }], [])
    expect(result[0]).toHaveProperty('id')
    expect(result[0].name).toBe('Aelis')
    expect(result[0].role).toBe('Ranger')
    expect(result[0].hpPct).toBe(75)
    expect(result[0].isActive).toBe(false)
    expect(result[0].conditions).toEqual([])
  })

  it('hpCurrent is NEVER added to the party row', () => {
    const result = applyPartyUpdate([{ ...BASE_ROW, conditions: [] }], [])
    expect(result[0]).not.toHaveProperty('hpCurrent')
  })

  it('round-trip: serialize → deserialize preserves conditions on party rows', () => {
    const party = [{ id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: ['Poisoned'] }]
    const p = serializeSession({ campaign: CAMPAIGN, party })
    const back = deserializeSession(p)
    expect(back.party[0].conditions).toEqual(['Poisoned'])
  })
})

// ─── Phase 4 — buildPlayersForPrompt ──────────────────────────────────────────

describe('Phase 4 — buildPlayersForPrompt', () => {
  const CHAR_A = {
    name: 'Jaycen',
    race: 'Human',
    charClass: 'Paladin',
    abilities: { STR: 16, DEX: 10, CON: 14, INT: 10, WIS: 12, CHA: 14 },
    ac: 18,
    hpMax: 45,
  }

  const CHAR_B = {
    name: 'Wren',
    race: 'Elf',
    charClass: 'Rogue',
    abilities: { STR: 8, DEX: 17, CON: 12, INT: 13, WIS: 11, CHA: 10 },
    ac: 14,
    hpMax: 28,
  }

  it('returns [] when characters is empty {}', () => {
    expect(buildPlayersForPrompt({}, [])).toEqual([])
  })

  it('returns [] when characters is null/undefined', () => {
    expect(buildPlayersForPrompt(null, [])).toEqual([])
    expect(buildPlayersForPrompt(undefined, [])).toEqual([])
  })

  it('returns [] when characters is an array (wrong type)', () => {
    expect(buildPlayersForPrompt([], [])).toEqual([])
  })

  it('merges static character with live party row for hpCurrent derivation', () => {
    const chars = { Alex: CHAR_A }
    const party = [{ id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: [] }]
    const players = buildPlayersForPrompt(chars, party)
    expect(players).toHaveLength(1)
    expect(players[0].name).toBe('Jaycen')
    expect(players[0].hpMax).toBe(45)
    // hpCurrent = round(80/100 * 45) = round(36) = 36
    expect(players[0].hpCurrent).toBe(36)
    expect(players[0].charClass).toBe('Paladin')
    expect(players[0].race).toBe('Human')
    expect(players[0].ac).toBe(18)
  })

  it('hpCurrent defaults to hpMax when party row is absent (hpPct=100)', () => {
    const chars = { Alex: CHAR_A }
    const players = buildPlayersForPrompt(chars, []) // no matching party row
    expect(players[0].hpCurrent).toBe(45) // 100% of hpMax
  })

  it('conditions from party row are included, default [] when absent', () => {
    const chars = { Alex: CHAR_A }
    const party = [{ id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: ['Poisoned'] }]
    const players = buildPlayersForPrompt(chars, party)
    expect(players[0].conditions).toEqual(['Poisoned'])
  })

  it('conditions defaults to [] when party row has no conditions field', () => {
    const chars = { Alex: CHAR_A }
    // party row without conditions (e.g. a pre-conditions row)
    const party = [{ id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true }]
    const players = buildPlayersForPrompt(chars, party)
    expect(players[0].conditions).toEqual([])
  })

  it('name matching is case-insensitive and whitespace-trimmed', () => {
    const chars = { Alex: { ...CHAR_A, name: '  Jaycen  ' } }
    // Party row has exact lower-case name
    const party = [{ id: 'p1', name: 'jaycen', role: 'Paladin', hpPct: 50, isActive: true, conditions: [] }]
    const players = buildPlayersForPrompt(chars, party)
    expect(players[0].hpCurrent).toBe(Math.round(50 / 100 * 45))
  })

  it('hpPct=0 → hpCurrent=0', () => {
    const chars = { Alex: CHAR_A }
    const party = [{ id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 0, isActive: false, conditions: [] }]
    const players = buildPlayersForPrompt(chars, party)
    expect(players[0].hpCurrent).toBe(0)
  })

  it('hpPct=100 → hpCurrent=hpMax', () => {
    const chars = { Alex: CHAR_B }
    const party = [{ id: 'p1', name: 'Wren', role: 'Rogue', hpPct: 100, isActive: true, conditions: [] }]
    const players = buildPlayersForPrompt(chars, party)
    expect(players[0].hpCurrent).toBe(28)
  })

  it('multiple characters: both appear in result', () => {
    const chars = { Alex: CHAR_A, Wren: CHAR_B }
    const party = [
      { id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true, conditions: [] },
      { id: 'p2', name: 'Wren', role: 'Rogue', hpPct: 60, isActive: false, conditions: [] },
    ]
    const players = buildPlayersForPrompt(chars, party)
    expect(players).toHaveLength(2)
    const names = players.map(p => p.name)
    expect(names).toContain('Jaycen')
    expect(names).toContain('Wren')
  })

  it('never throws on any input combination', () => {
    expect(() => buildPlayersForPrompt(null, null)).not.toThrow()
    expect(() => buildPlayersForPrompt({}, null)).not.toThrow()
    expect(() => buildPlayersForPrompt({ x: null }, [])).not.toThrow()
    expect(() => buildPlayersForPrompt({ x: {} }, [null, undefined])).not.toThrow()
  })
})

// ─── Phase 4 — buildPlayerSection ────────────────────────────────────────────

describe('Phase 4 — buildPlayerSection', () => {
  const PLAYER = {
    name: 'Aelis',
    race: 'Elf',
    charClass: 'Ranger',
    abilities: { STR: 12, DEX: 16, CON: 14, INT: 10, WIS: 14, CHA: 10 },
    ac: 15,
    hpMax: 32,
    hpCurrent: 24,
    conditions: [],
  }

  it('returns "" for null/undefined/empty input', () => {
    expect(buildPlayerSection(null)).toBe('')
    expect(buildPlayerSection(undefined)).toBe('')
    expect(buildPlayerSection([])).toBe('')
  })

  it('header is "\\nPlayer Characters:\\n"', () => {
    const s = buildPlayerSection([PLAYER])
    expect(s.startsWith('\nPlayer Characters:\n')).toBe(true)
  })

  it('player line format: "name (Class Race): STR s(±m), …; AC a, HP cur/max"', () => {
    const s = buildPlayerSection([PLAYER])
    expect(s).toContain('Aelis (Ranger Elf)')
    expect(s).toContain('STR 12(+1)')
    expect(s).toContain('DEX 16(+3)')
    expect(s).toContain('AC 15')
    expect(s).toContain('HP 24/32')
  })

  it('conditions appended when non-empty', () => {
    const s = buildPlayerSection([{ ...PLAYER, conditions: ['Blinded', 'Prone'] }])
    expect(s).toContain('[Blinded, Prone]')
  })

  it('no conditions bracket when empty', () => {
    const s = buildPlayerSection([PLAYER])
    expect(s).not.toContain('[')
  })

  it('all 5 players present and section <= 1000 chars for 5 worst-case players', () => {
    const worst = Array.from({ length: 5 }, (_, i) => ({
      name: `Adventurer${i}`,
      race: 'Dragonborn',
      charClass: 'Artificer',
      abilities: { STR: 20, DEX: 20, CON: 20, INT: 20, WIS: 20, CHA: 20 },
      ac: 20,
      hpMax: 100,
      hpCurrent: 100,
      conditions: [],
    }))
    const s = buildPlayerSection(worst)
    // All 5 players must appear — none silently dropped
    for (let i = 0; i < 5; i++) {
      expect(s).toContain(`Adventurer${i}`)
    }
    expect(s.length).toBeLessThanOrEqual(1000)
  })

  it('all 4 players present with long names and conditions', () => {
    const worst = Array.from({ length: 4 }, (_, i) => ({
      name: `VeryLongAdventurerName${i}`,
      race: 'Dragonborn',
      charClass: 'Artificer',
      abilities: { STR: 20, DEX: 20, CON: 20, INT: 20, WIS: 20, CHA: 20 },
      ac: 20,
      hpMax: 999,
      hpCurrent: 999,
      conditions: ['Poisoned', 'Frightened'],
    }))
    const s = buildPlayerSection(worst)
    for (let i = 0; i < 4; i++) {
      expect(s).toContain(`VeryLongAdventurerName${i}`)
    }
    expect(s.length).toBeLessThanOrEqual(1000)
  })
})

// ─── Phase 6 — Integration / back-compat tests ────────────────────────────────

// G-C2: back-compat — v1 and v2 `.md` through fromMarkdown
describe('Phase 6 (G-C2) — v1 and v2 .md back-compat through fromMarkdown', () => {
  it('v2 .md (with roomCode/phase/turnSequence, no characters) loads without throw, characters defaults to {}', () => {
    const v2Block = JSON.stringify({
      schemaVersion: 2,
      sessionId: 'v2-md-backcompat',
      savedAt: '2026-05-01T12:00:00.000Z',
      campaign: {
        name: 'Road to Ruin',
        genre: 'dnd',
        details: 'A grim road',
        context: '**Mira** waits at the crossroads.',
        model: 'qwen2.5:14b',
        sessionId: 'v2-md-backcompat',
      },
      messages: [
        { role: 'user', content: 'I step out of the tavern.' },
        { role: 'assistant', content: 'The cold air greets you.', id: 'a1' },
      ],
      sessionLog: [{ time: '09:00', text: 'I step out of the tavern.' }],
      party: [
        { id: 'p1', name: 'Mira', role: 'Ranger', hpPct: 90, isActive: false },
      ],
      roomCode: 'dnd-v2mdtest',
      phase: 'free-roam',
      turnSequence: 3,
      // No "characters" field — v2 era
    })
    const md = `# Session — Road to Ruin\n\n\`\`\`session\n${v2Block}\n\`\`\`\n`
    // Must not throw
    let result
    expect(() => { result = fromMarkdown(md) }).not.toThrow()
    expect(result).not.toBeNull()
    // characters backfilled to {}
    expect(result.characters).toEqual({})
    // Party rows intact, no character fields added
    expect(result.party).toHaveLength(1)
    expect(result.party[0].name).toBe('Mira')
    expect(result.party[0]).not.toHaveProperty('charClass')
    expect(result.party[0]).not.toHaveProperty('abilities')
    // v2 fields preserved / upgraded to v3
    expect(result.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.roomCode).toBe('dnd-v2mdtest')
    expect(result.turnSequence).toBe(3)
    expect(result.messages).toHaveLength(2)
  })

  it('v1 .md (no v2 fields) loads without throw, characters defaults to {}', () => {
    const v1Block = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'v1-md-backcompat',
      savedAt: '2026-01-15T08:00:00.000Z',
      campaign: {
        name: 'Ancient Halls',
        genre: 'dnd',
        details: 'Deep ruins',
        context: '**Eldrin** guards the gate.',
        model: 'qwen2.5:14b',
        sessionId: 'v1-md-backcompat',
      },
      messages: [{ role: 'user', content: 'I descend the stairs.' }],
      sessionLog: [],
      party: [
        { id: 'e1', name: 'Eldrin', role: 'Wizard', hpPct: 70, isActive: false },
      ],
    })
    const md = `# Session — Ancient Halls\n\n\`\`\`session\n${v1Block}\n\`\`\`\n`
    let result
    expect(() => { result = fromMarkdown(md) }).not.toThrow()
    expect(result).not.toBeNull()
    expect(result.characters).toEqual({})
    expect(result.party).toHaveLength(1)
    expect(result.party[0].name).toBe('Eldrin')
    expect(result.schemaVersion).toBe(SCHEMA_VERSION)
  })
})

// G-C2 + import flow: extractCharacterFromPayload with v1/v2 .md strings
describe('Phase 6 (G-C2 + import flow) — extractCharacterFromPayload on v1/v2 .md', () => {
  it('v3 .md with characters map: extracts by displayName key match', () => {
    const char = {
      name: 'Ryn Silverthorn',
      race: 'Elf',
      charClass: 'Rogue',
      abilities: { STR: 8, DEX: 17, CON: 12, INT: 14, WIS: 13, CHA: 10 },
      ac: 14,
      hpMax: 28,
    }
    const p = serializeSession({ campaign: CAMPAIGN, characters: { Ryn: char } }, '2026-05-26T00:00:00.000Z')
    const md = toMarkdown(p)
    const result = extractCharacterFromPayload(md, 'Ryn')
    expect(result).not.toBeNull()
    expect(result.name).toBe('Ryn Silverthorn')
    expect(result.charClass).toBe('Rogue')
  })

  it('v2 .md (no characters block): derives from first party row', () => {
    const v2Block = JSON.stringify({
      schemaVersion: 2,
      sessionId: 'v2-derive-test',
      savedAt: '2026-05-01T00:00:00.000Z',
      campaign: CAMPAIGN,
      messages: [],
      sessionLog: [],
      party: [{ id: 'p1', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: false }],
      roomCode: null,
      phase: 'free-roam',
      turnSequence: 2,
    })
    const md = `# Session\n\`\`\`session\n${v2Block}\n\`\`\``
    const result = extractCharacterFromPayload(md, 'AnyPlayer')
    expect(result).not.toBeNull()
    // Derived from the first party row
    expect(result.name).toBe('Aelis')
    expect(result.charClass).toBe('Ranger')
    expect(result.race).toBe('Human') // default race for derived character
  })

  it('v1 .md (no characters block): derives from first party row', () => {
    const v1Block = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'v1-derive-test',
      savedAt: '2026-01-01T00:00:00.000Z',
      campaign: CAMPAIGN,
      messages: [],
      sessionLog: [],
      party: [{ id: 'p1', name: 'Gareth', role: 'Fighter', hpPct: 100, isActive: false }],
    })
    const md = `# Session\n\`\`\`session\n${v1Block}\n\`\`\``
    const result = extractCharacterFromPayload(md, 'PlayerX')
    expect(result).not.toBeNull()
    expect(result.name).toBe('Gareth')
    expect(result.charClass).toBe('Fighter')
  })

  it('malformed .md: returns null gracefully (no throw)', () => {
    expect(() => extractCharacterFromPayload('{bad json}', 'Alex')).not.toThrow()
    expect(extractCharacterFromPayload('{bad json}', 'Alex')).toBeNull()
  })

  it('blockless .md: returns null gracefully (no throw)', () => {
    const prose = '# Campaign Notes\n\nSome lore here. No session block.'
    expect(() => extractCharacterFromPayload(prose, 'Alex')).not.toThrow()
    expect(extractCharacterFromPayload(prose, 'Alex')).toBeNull()
  })
})

// ─── CHANGE 2c (M2) — pickCharacters / deserializeSession: proto-pollution guard ─
describe('M2 — pickCharacters/deserializeSession skips reserved prototype keys', () => {
  it('deserializeSession with a __proto__ key in characters does not pollute Object.prototype', () => {
    const before = Object.prototype.toString
    const raw = {
      schemaVersion: 3,
      sessionId: 'test-proto-guard',
      savedAt: '2026-01-01T00:00:00.000Z',
      campaign: { name: 'Test', genre: 'dnd', sessionId: 'test-proto-guard' },
      messages: [],
      sessionLog: [],
      party: [],
      characters: {
        // A key that would pollute Object.prototype on an ordinary object.
        __proto__: { name: 'Evil', race: 'Human', charClass: 'Fighter',
          abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, ac: 10, hpMax: 10 },
        Alex: { name: 'Alex', race: 'Human', charClass: 'Fighter',
          abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, ac: 10, hpMax: 10 },
      },
    }
    const result = deserializeSession(raw)
    // Object.prototype must not be polluted.
    expect(Object.prototype.toString).toBe(before)
    expect(result).not.toBeNull()
    // The reserved key must be dropped.
    expect(result.characters).not.toHaveProperty('__proto__')
    // The valid key must be kept.
    expect(result.characters).toHaveProperty('Alex')
  })

  it('deserializeSession with a "constructor" key in characters drops it', () => {
    const raw = {
      schemaVersion: 3,
      sessionId: 'test-constructor-guard',
      savedAt: '2026-01-01T00:00:00.000Z',
      campaign: { name: 'Test', genre: 'dnd', sessionId: 'test-constructor-guard' },
      messages: [],
      sessionLog: [],
      party: [],
      characters: {
        constructor: { name: 'Hack', race: 'Human', charClass: 'Fighter',
          abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, ac: 10, hpMax: 10 },
        Beth: { name: 'Beth', race: 'Elf', charClass: 'Ranger',
          abilities: { STR: 10, DEX: 14, CON: 12, INT: 12, WIS: 14, CHA: 10 }, ac: 14, hpMax: 35 },
      },
    }
    const result = deserializeSession(raw)
    expect(result.characters).not.toHaveProperty('constructor')
    expect(result.characters).toHaveProperty('Beth')
    expect(result.characters.Beth.charClass).toBe('Ranger')
  })

  it('serializeSession with a __proto__ key in characters drops it on round-trip', () => {
    // Ensures that even a client that somehow has __proto__ in its characters state
    // cannot persist it through the serialize/deserialize cycle.
    const state = {
      campaign: { name: 'Test', genre: 'dnd', sessionId: 'proto-rt-test' },
      messages: [],
      sessionLog: [],
      party: [],
      // Simulate a payload with a reserved key (rare but possible if the map was built with Object.assign).
      characters: Object.assign(Object.create(null), {
        Alex: { name: 'Alex', race: 'Human', charClass: 'Fighter',
          abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, ac: 10, hpMax: 10 },
      }),
    }
    const p = serializeSession(state)
    expect(p.characters).toHaveProperty('Alex')
    // JSON round-trip: JSON.stringify handles null-proto objects correctly.
    const json = JSON.stringify(p)
    const back = deserializeSession(JSON.parse(json))
    expect(back.characters).toHaveProperty('Alex')
  })
})

// G-C3: single-player unaffected — buildPlayersForPrompt + buildPlayerSection with null/empty
describe('Phase 6 (G-C3) — single-player path: no characters → prompt unchanged', () => {
  it('buildPlayersForPrompt with no characters returns [] (SP path unaffected)', () => {
    // In single-player, characters is {} or null — must return [] without throwing
    expect(buildPlayersForPrompt({}, [])).toEqual([])
    expect(buildPlayersForPrompt(null, [])).toEqual([])
    expect(buildPlayersForPrompt(undefined, [])).toEqual([])
  })

  it('buildPlayerSection([]) returns empty string (no player section injected in SP)', () => {
    expect(buildPlayerSection([])).toBe('')
    expect(buildPlayerSection(null)).toBe('')
    expect(buildPlayerSection(undefined)).toBe('')
  })

  it('serializeSession without characters field defaults characters to {} (SP round-trip)', () => {
    // SP sessions have no characters map — must serialize/deserialize cleanly
    const p = serializeSession({ campaign: CAMPAIGN, messages: [], party: [] })
    expect(p.characters).toEqual({})
    const back = deserializeSession(p)
    expect(back.characters).toEqual({})
    expect(back.party).toEqual([])
  })
})

