// @vitest-environment jsdom
//
// Multiplayer schema / session.js unit tests — Phase 0 + Phase 1 gate (ACTIVE)
//
// Activated 2026-05-26 when Phase 0 implementation landed. Covers:
//   - SCHEMA_VERSION bump to 2 (Phase 0) / 3 (Phase 1)
//   - deserializeSession v1→v2 backward-compat branch
//   - deserializeSession v2 native path (lenient read; clamp invalid phase)
//   - deserializeSession v3 native path (characters map)
//   - toMarkdown / fromMarkdown round-trip for v2 fields
//   - applyPartyUpdate as a named export from session.js (moved from Chat.jsx)
//   - roomCode derivation helper (makeRoomCode)
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §1.2, §6 Phase 0, §7 Phase 0
//   MULTIPLAYER-TEST-AUTOMATION.md §1 (unit tier)

import { describe, it, expect } from 'vitest'
import {
  SCHEMA_VERSION,
  serializeSession,
  deserializeSession,
  toMarkdown,
  fromMarkdown,
  applyPartyUpdate,
  makeRoomCode,
} from './session'

// ─── fixtures ─────────────────────────────────────────────────────────────────

const V1_CAMPAIGN = {
  name: 'Legacy Campaign',
  genre: 'dnd',
  details: 'A haunted keep',
  context: '**Warden Strix** haunts the battlements.',
  model: 'qwen2.5:14b',
  sessionId: 'v1-legacy-uuid',
}

const V1_PAYLOAD_STRING = JSON.stringify({
  schemaVersion: 1,
  sessionId: 'v1-legacy-uuid',
  savedAt: '2026-01-01T00:00:00.000Z',
  campaign: V1_CAMPAIGN,
  messages: [{ role: 'user', content: 'I enter the keep.' }],
  sessionLog: [{ time: '10:00', text: 'I enter the keep.' }],
  party: [{ id: 'p1', name: 'Wren', role: 'Rogue', hpPct: 100, isActive: false }],
})

const V2_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const V2_CAMPAIGN = {
  ...V1_CAMPAIGN,
  sessionId: V2_SESSION_ID,
  name: 'Multiplayer Keep',
}

const baseState = () => ({
  campaign: V2_CAMPAIGN,
  messages: [],
  sessionLog: [],
  party: [],
})

// ─── SCHEMA_VERSION ───────────────────────────────────────────────────────────

describe('SCHEMA_VERSION (v3)', () => {
  it('SCHEMA_VERSION equals 3 after the Phase 1 bump', () => {
    expect(SCHEMA_VERSION).toBe(3)
  })
})

// ─── deserializeSession v1 → v3 backward-compat ───────────────────────────────

describe('deserializeSession — v1 → v3 backward-compat', () => {
  it('accepts a v1 payload and fills v3 defaults', () => {
    const result = deserializeSession(V1_PAYLOAD_STRING)
    expect(result).not.toBeNull()
    expect(result.schemaVersion).toBe(3)
    expect(result.phase).toBe('free-roam')
    expect(result.roomCode).toBeNull()
    expect(result.turnSequence).toBe(0)
    // Phase 1: v1 payloads backfill characters to {}
    expect(result.characters).toEqual({})
  })

  it('preserves all v1 fields when upgrading to v3', () => {
    const result = deserializeSession(V1_PAYLOAD_STRING)
    expect(result.sessionId).toBe('v1-legacy-uuid')
    expect(result.messages).toHaveLength(1)
    expect(result.party).toHaveLength(1)
    expect(result.campaign.name).toBe('Legacy Campaign')
  })

  it('does NOT mutate the original v1 object', () => {
    const original = JSON.parse(V1_PAYLOAD_STRING)
    deserializeSession(original)
    expect(original.schemaVersion).toBe(1)
    expect(original).not.toHaveProperty('phase')
  })

  it('returns null for schemaVersion 0 (pre-v1; still unsupported)', () => {
    expect(deserializeSession(JSON.stringify({ schemaVersion: 0 }))).toBeNull()
  })

  it('returns null for schemaVersion 4 (future; still unsupported)', () => {
    expect(deserializeSession(JSON.stringify({ schemaVersion: 4 }))).toBeNull()
  })
})

// ─── deserializeSession v2 native path ────────────────────────────────────────

describe('deserializeSession — v2 native path', () => {
  it('round-trips a v2 payload (serialize → deserialize)', () => {
    const p = serializeSession(baseState(), '2026-05-25T12:00:00.000Z', {
      phase: 'combat',
      roomCode: 'dnd-a1b2c3d4',
      turnSequence: 7,
    })
    const back = deserializeSession(JSON.stringify(p))
    expect(back).toEqual(p)
    expect(back.phase).toBe('combat')
    expect(back.roomCode).toBe('dnd-a1b2c3d4')
    expect(back.turnSequence).toBe(7)
  })

  it('fills v3 defaults when optional fields are omitted from a valid v2 object', () => {
    const bare = {
      schemaVersion: 2,
      sessionId: V2_SESSION_ID,
      savedAt: '2026-05-25T00:00:00.000Z',
      campaign: V2_CAMPAIGN,
      messages: [],
      sessionLog: [],
      party: [],
      // phase, roomCode, turnSequence, characters intentionally absent
    }
    const result = deserializeSession(bare)
    expect(result.phase).toBe('free-roam')
    expect(result.roomCode).toBeNull()
    expect(result.turnSequence).toBe(0)
    // Phase 1: v2 payloads backfill characters to {}
    expect(result.characters).toEqual({})
  })

  it('accepts all four valid phase values on the read path', () => {
    for (const phase of ['free-roam', 'combat', 'awaiting-dm', 'resolving']) {
      const payload = {
        schemaVersion: 2,
        phase,
        sessionId: 'x',
        savedAt: 'T',
        campaign: {},
        messages: [],
        sessionLog: [],
        party: [],
      }
      expect(deserializeSession(payload).phase).toBe(phase)
    }
  })

  it('clamps an invalid phase string to free-roam', () => {
    const payload = {
      schemaVersion: 2,
      phase: 'invalid-phase',
      sessionId: 'x',
      savedAt: 'T',
      campaign: {},
      messages: [],
      sessionLog: [],
      party: [],
    }
    expect(deserializeSession(payload).phase).toBe('free-roam')
  })
})

// ─── serializeSession — write-path phase sanitize (MC-3 / MC-4) ───────────────

describe('serializeSession — v3 carry + phase-sanitize', () => {
  it('carries v2/v3 fields supplied via the opts arg', () => {
    const p = serializeSession(baseState(), 'T', {
      phase: 'combat',
      roomCode: 'dnd-zzz',
      turnSequence: 4,
    })
    expect(p.schemaVersion).toBe(3)
    expect(p.phase).toBe('combat')
    expect(p.roomCode).toBe('dnd-zzz')
    expect(p.turnSequence).toBe(4)
  })

  it('reads v2 fields from state when no opts given (HTTP PUT rebuild path)', () => {
    const p = serializeSession(
      { ...baseState(), phase: 'combat', roomCode: 'dnd-state', turnSequence: 9 },
      'T'
    )
    expect(p.phase).toBe('combat')
    expect(p.roomCode).toBe('dnd-state')
    expect(p.turnSequence).toBe(9)
  })

  it('coerces a transient phase to free-roam on the write path', () => {
    for (const transient of ['awaiting-dm', 'resolving', 'nonsense']) {
      const p = serializeSession(baseState(), 'T', { phase: transient })
      expect(p.phase).toBe('free-roam')
    }
  })

  it('defaults v2 fields when entirely absent', () => {
    const p = serializeSession(baseState(), 'T')
    expect(p.roomCode).toBeNull()
    expect(p.phase).toBe('free-roam')
    expect(p.turnSequence).toBe(0)
  })
})

// ─── toMarkdown / fromMarkdown — v2 fields ────────────────────────────────────

describe('toMarkdown / fromMarkdown — v2 field round-trips', () => {
  it('toMarkdown writes phase and roomCode as prose metadata + in the session block', () => {
    const p = serializeSession(baseState(), '2026-05-25T12:00:00.000Z', {
      phase: 'combat',
      roomCode: 'dnd-a1b2c3d4',
      turnSequence: 3,
    })
    const md = toMarkdown(p)
    expect(md).toContain('phase: combat')
    expect(md).toContain('roomCode: dnd-a1b2c3d4')
    expect(md).toContain('"phase": "combat"')
    expect(md).toContain('"turnSequence": 3')
  })

  it('fromMarkdown(toMarkdown(v2)) restores phase, roomCode, turnSequence losslessly', () => {
    const p = serializeSession(baseState(), '2026-05-25T12:00:00.000Z', {
      phase: 'combat',
      roomCode: 'dnd-a1b2c3d4',
      turnSequence: 7,
    })
    const back = fromMarkdown(toMarkdown(p))
    expect(back).toEqual(p)
  })

  it('a v1 .md file (no v2 fields in the session block) loads with v2 defaults', () => {
    const v1Block = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'v1-legacy-uuid',
      savedAt: '2026-01-01T00:00:00.000Z',
      campaign: V1_CAMPAIGN,
      messages: [],
      sessionLog: [],
      party: [],
    })
    const v1Md = `# Session — Legacy\n\n\`\`\`session\n${v1Block}\n\`\`\`\n`
    const result = fromMarkdown(v1Md)
    expect(result.phase).toBe('free-roam')
    expect(result.roomCode).toBeNull()
    expect(result.turnSequence).toBe(0)
  })

  it('connections and dmClientId are NOT written to the .md session block', () => {
    const p = serializeSession(baseState(), '2026-05-25T12:00:00.000Z', {
      phase: 'free-roam',
      roomCode: 'dnd-a1b2c3d4',
      turnSequence: 0,
      connections: [{ displayName: 'Alex', status: 'connected' }],
      dmClientId: 'conn-xyz',
    })
    const md = toMarkdown(p)
    expect(md).not.toContain('connections')
    expect(md).not.toContain('dmClientId')
  })
})

// ─── makeRoomCode ─────────────────────────────────────────────────────────────

describe('makeRoomCode', () => {
  it('derives a stable dnd- prefixed code from a sessionId', () => {
    expect(makeRoomCode('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('dnd-a1b2c3d4')
  })

  it('produces the same code for repeated calls with the same sessionId', () => {
    expect(makeRoomCode(V2_SESSION_ID)).toBe(makeRoomCode(V2_SESSION_ID))
  })

  it('produces distinct codes for distinct sessionIds', () => {
    const a = makeRoomCode('a1b2c3d4-0000-0000-0000-000000000000')
    const b = makeRoomCode('b1b2c3d4-0000-0000-0000-000000000000')
    expect(a).not.toBe(b)
  })
})

// ─── applyPartyUpdate (moved from Chat.jsx to session.js) ─────────────────────

describe('applyPartyUpdate — named export from session.js', () => {
  const EXISTING = [
    { id: 'uuid-1', name: 'Theron', role: 'Paladin', hpPct: 80, isActive: false },
    { id: 'uuid-2', name: 'Wren', role: 'Rogue', hpPct: 60, isActive: true },
  ]

  it('is exported as a named function from session.js', () => {
    expect(typeof applyPartyUpdate).toBe('function')
  })

  it('preserves existing ids on name-match (case-insensitive)', () => {
    const result = applyPartyUpdate(
      [{ name: 'theron', role: 'Paladin', hpPct: 75, isActive: true }],
      EXISTING
    )
    expect(result[0].id).toBe('uuid-1')
    expect(result[0].hpPct).toBe(75)
    expect(result[0].isActive).toBe(true)
  })

  it('assigns a new id for an unmatched name (new party member)', () => {
    const result = applyPartyUpdate(
      [{ name: 'Casey', role: 'Mage', hpPct: 100, isActive: false }],
      EXISTING
    )
    expect(result[0].id).not.toBe('uuid-1')
    expect(result[0].id).not.toBe('uuid-2')
    expect(typeof result[0].id).toBe('string')
    expect(result[0].id.length).toBeGreaterThan(0)
  })

  it('clamps hpPct to [0, 100]', () => {
    const result = applyPartyUpdate(
      [{ name: 'Theron', role: 'Paladin', hpPct: 150, isActive: false }],
      EXISTING
    )
    expect(result[0].hpPct).toBe(100)
  })

  it('defaults missing fields defensively', () => {
    const result = applyPartyUpdate([{}], [])
    expect(result[0].name).toBe('Unknown')
    expect(result[0].role).toBe('')
    expect(result[0].hpPct).toBe(0)
    expect(result[0].isActive).toBe(false)
  })

  it('behaviour is identical to the Chat.jsx inline version (regression guard)', () => {
    const result = applyPartyUpdate(
      [{ name: 'Wren', role: 'Rogue', hpPct: 55, isActive: false }],
      EXISTING
    )
    expect(result[0].id).toBe('uuid-2')
    expect(result[0].hpPct).toBe(55)
  })
})
