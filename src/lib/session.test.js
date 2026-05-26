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
