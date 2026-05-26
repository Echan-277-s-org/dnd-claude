import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Mock the sync API so the hook is tested in isolation (no real fetch).
vi.mock('../lib/session', async () => {
  const actual = await vi.importActual('../lib/session')
  return {
    ...actual,
    loadSyncSession: vi.fn(),
    saveSyncSession: vi.fn(),
    pollSyncSession: vi.fn(() => () => {}),
    deleteSyncSession: vi.fn(() => Promise.resolve({ ok: true })),
  }
})

import { useSessionPersistence } from './useSessionPersistence'
import {
  loadSyncSession,
  saveSyncSession,
  pollSyncSession,
  deleteSyncSession,
  serializeSession,
} from '../lib/session'

// Seed the localStorage offline mirror the M7 staleness gate reads.
function seedLocal(savedAt, messages = [{ role: 'assistant', content: 'local' }]) {
  localStorage.setItem(
    'dnd_session',
    JSON.stringify(serializeSession({ campaign, messages }, savedAt))
  )
}

const campaign = { name: 'Jaycen', genre: 'dnd', model: 'm', context: 'c', sessionId: 'sid-1' }
const baseProps = overrides => ({
  campaign,
  messages: [],
  setMessages: vi.fn(),
  sessionLog: [],
  setSessionLog: vi.fn(),
  party: [],
  setParty: vi.fn(),
  isLoading: false,
  ...overrides,
})

beforeEach(() => {
  localStorage.clear()
  loadSyncSession.mockResolvedValue(null)
  saveSyncSession.mockResolvedValue({ ok: true, savedAt: 'T-server' })
})
afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('useSessionPersistence', () => {
  it('adopts a server payload on mount (server-authoritative)', async () => {
    const setMessages = vi.fn()
    const setParty = vi.fn()
    loadSyncSession.mockResolvedValue({
      savedAt: 'T1',
      messages: [{ role: 'user', content: 'hi' }],
      sessionLog: [],
      party: [{ id: 'p', name: 'A', role: 'B', hpPct: 50, isActive: true }],
    })
    renderHook(() => useSessionPersistence(baseProps({ setMessages, setParty })))
    await waitFor(() => expect(setMessages).toHaveBeenCalledWith([{ role: 'user', content: 'hi' }]))
    expect(setParty).toHaveBeenCalled()
  })

  it('does nothing on mount when the server is unreachable (null)', async () => {
    const setMessages = vi.fn()
    renderHook(() => useSessionPersistence(baseProps({ setMessages })))
    await act(async () => {})
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('saves once on the loading falling edge, basing the write on the last savedAt', async () => {
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true }),
    })
    await act(async () => {}) // let mount load settle (null)
    // turn completes: true → false
    rerender(baseProps({ isLoading: false, messages: [{ role: 'assistant', content: 'x' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
    // first save bases on null (no prior server stamp)
    expect(saveSyncSession.mock.calls[0][0].savedAt).toBeNull()

    // a second turn now bases its write on the server stamp returned above
    rerender(baseProps({ isLoading: true, messages: [{ role: 'assistant', content: 'x' }] }))
    rerender(baseProps({ isLoading: false, messages: [{ role: 'assistant', content: 'y' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(2))
    expect(saveSyncSession.mock.calls[1][0].savedAt).toBe('T-server')
  })

  it('does NOT save per stream delta (no falling edge)', async () => {
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true, messages: [{ role: 'assistant', content: 'a' }] }),
    })
    await act(async () => {})
    // streaming deltas: still loading, message grows — no save
    rerender(baseProps({ isLoading: true, messages: [{ role: 'assistant', content: 'ab' }] }))
    rerender(baseProps({ isLoading: true, messages: [{ role: 'assistant', content: 'abc' }] }))
    expect(saveSyncSession).not.toHaveBeenCalled()
  })

  it('registers a poller for the session id', async () => {
    renderHook(() => useSessionPersistence(baseProps()))
    await act(async () => {})
    expect(pollSyncSession).toHaveBeenCalledWith('sid-1', expect.any(Function), expect.any(Function))
  })

  // M7 — a stale (older) server copy must NOT overwrite a newer offline turn.
  it('does NOT adopt a server payload older than the local offline turn (M7)', async () => {
    seedLocal('2026-05-25T12:00:00.000Z') // newer local turn (server PUT had failed)
    loadSyncSession.mockResolvedValue({
      savedAt: '2026-05-25T10:00:00.000Z', // older server copy
      messages: [{ role: 'assistant', content: 'STALE SERVER' }],
      sessionLog: [],
      party: [],
    })
    const setMessages = vi.fn()
    renderHook(() => useSessionPersistence(baseProps({ setMessages })))
    await act(async () => {})
    expect(setMessages).not.toHaveBeenCalled() // local turn preserved
  })

  it('DOES adopt a server payload strictly newer than local (M7 reverse)', async () => {
    seedLocal('2026-05-25T10:00:00.000Z')
    loadSyncSession.mockResolvedValue({
      savedAt: '2026-05-25T12:00:00.000Z', // newer server copy
      messages: [{ role: 'assistant', content: 'FRESH SERVER' }],
      sessionLog: [],
      party: [],
    })
    const setMessages = vi.fn()
    renderHook(() => useSessionPersistence(baseProps({ setMessages })))
    await waitFor(() =>
      expect(setMessages).toHaveBeenCalledWith([{ role: 'assistant', content: 'FRESH SERVER' }])
    )
  })

  // A 409 conflict keeps local state and leaves the next write's base unchanged.
  it('keeps local state on a 409 conflict (no adopt, base unchanged)', async () => {
    saveSyncSession.mockResolvedValue({ ok: false, conflict: true, savedAt: 'T-other' })
    const setMessages = vi.fn()
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true, setMessages }),
    })
    await act(async () => {})
    rerender(baseProps({ isLoading: false, setMessages, messages: [{ role: 'assistant', content: 'x' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
    // 409 path does not adopt the other device's copy (no setMessages from save).
    expect(setMessages).not.toHaveBeenCalled()
  })

  // marks restored bare dice chips orphaned when adopting a server payload (H4).
  it('flags restored bare dice chips orphaned on adopt (H4)', async () => {
    loadSyncSession.mockResolvedValue({
      savedAt: 'T1',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'dice', die: 'd20', result: 17 }, // bare, unresolved
      ],
      sessionLog: [],
      party: [],
    })
    const setMessages = vi.fn()
    renderHook(() => useSessionPersistence(baseProps({ setMessages })))
    await waitFor(() => expect(setMessages).toHaveBeenCalled())
    const adopted = setMessages.mock.calls[0][0]
    expect(adopted.find(m => m.role === 'dice').orphaned).toBe(true)
  })

  // onNewSession DELETEs the server copy so another device's poll can't resurrect it.
  it('onNewSession deletes the server session', async () => {
    const { result } = renderHook(() => useSessionPersistence(baseProps()))
    await act(async () => {})
    act(() => result.current.onNewSession())
    expect(deleteSyncSession).toHaveBeenCalledWith('sid-1')
  })

  // ── M7 boundary: equal savedAt must NOT adopt (strictly-greater-than gate) ──
  // If the server and local clocks agree exactly, "strictly newer" fails → keep local.
  it('does NOT adopt when server savedAt equals the local stamp (equal-timestamp boundary)', async () => {
    const stamp = '2026-05-25T10:00:00.000Z'
    seedLocal(stamp) // local = stamp
    loadSyncSession.mockResolvedValue({
      savedAt: stamp,   // server = same stamp, NOT strictly greater
      messages: [{ role: 'assistant', content: 'EQUAL SERVER' }],
      sessionLog: [],
      party: [],
    })
    const setMessages = vi.fn()
    renderHook(() => useSessionPersistence(baseProps({ setMessages })))
    await act(async () => {})
    expect(setMessages).not.toHaveBeenCalled()
  })

  // ── M7 rebase: when keeping local, lastSavedAt must advance to the server stamp ──
  // Without the rebase the next PUT would carry the local timestamp, mismatch the
  // server's stored savedAt, and 409-deadlock the offline turn.
  it('rebases lastSavedAt to the server stamp when keeping local (M7 deadlock guard)', async () => {
    const localStamp = '2026-05-25T12:00:00.000Z'
    const serverStamp = '2026-05-25T10:00:00.000Z'
    seedLocal(localStamp) // newer local
    loadSyncSession.mockResolvedValue({
      savedAt: serverStamp, // older server → M7 keeps local
      messages: [{ role: 'assistant', content: 'STALE' }],
      sessionLog: [],
      party: [],
    })
    saveSyncSession.mockResolvedValue({ ok: true, savedAt: 'T-after-push' })

    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true }),
    })
    await act(async () => {}) // mount: adopt rejected, lastSavedAt → serverStamp

    // Simulate a turn completing — the PUT must base on the server stamp, not local.
    rerender(baseProps({ isLoading: false, messages: [{ role: 'assistant', content: 'new' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
    // The savedAt sent to the server should be the server's stamp (not the local one).
    expect(saveSyncSession.mock.calls[0][0].savedAt).toBe(serverStamp)
  })

  // ── onNewSession sentinel blocks a poll adopt after clearing (resurrection guard) ─
  // After onNewSession(), lastSavedAt is set to a '9999-12-31T...' sentinel that sorts
  // AFTER every real-era ISO date under string comparison, so the M7 gate rejects an
  // in-flight poll that returns the just-deleted session — no resurrection.
  // Regression guard for the prior '+275760-...' sentinel bug, where the JS year-expansion
  // '+' prefix (ASCII 43 < '2') inverted the comparison and let stale payloads through.
  it('onNewSession sentinel blocks a poll adopt after clearing (resurrection guard)', async () => {
    loadSyncSession.mockResolvedValue({
      savedAt: '2026-05-25T10:00:00.000Z',
      messages: [{ role: 'assistant', content: 'OLD SESSION' }],
      sessionLog: [],
      party: [],
    })
    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await waitFor(() => expect(setMessages).toHaveBeenCalledTimes(1))

    act(() => result.current.onNewSession())
    setMessages.mockClear()

    const onNewer = pollSyncSession.mock.calls[0][2]
    act(() =>
      onNewer({
        savedAt: '2026-05-25T11:00:00.000Z',
        messages: [{ role: 'assistant', content: 'RESURRECTED' }],
        sessionLog: [],
        party: [],
      })
    )
    // The sentinel ('9999-...') sorts after '2026-...', so the M7 gate rejects the
    // resurrected payload — the cleared session is not restored.
    expect(setMessages).not.toHaveBeenCalled()
  })

  // ── onNewSession must NOT suppress the first real turn after clearing ──────────
  // onNewSession() deliberately does NOT set adopting.current, so the loading
  // falling-edge after the first new turn fires a real PUT (not suppressed).
  it('first real turn after onNewSession still triggers a save', async () => {
    const { result, rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: false }),
    })
    await act(async () => {}) // mount settle
    act(() => result.current.onNewSession())

    // First turn: isLoading true → false
    rerender(baseProps({ isLoading: true }))
    rerender(baseProps({ isLoading: false, messages: [{ role: 'assistant', content: 'first turn' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
  })
})

// ─── Phase 2 — dual-authority adopt gate + onSessionState sentinel reset ──────
//
// These tests exercise the ADDITIVE Phase 2 changes to useSessionPersistence.
// The same mock setup from the top of the file applies.
// Existing single-player tests above are NOT modified.
describe('useSessionPersistence Phase 2 — WS adopt gate + sentinel reset', () => {
  // (a) ws-source adopt ADMITS when turnSequence advances even if savedAt is equal or older.
  it('ws adopt: admits update when turnSequence advances even if savedAt is equal', async () => {
    // Start with a local session stamped at T1.
    seedLocal('2026-05-25T10:00:00.000Z')
    loadSyncSession.mockResolvedValue(null)

    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await act(async () => {}) // mount settle

    setMessages.mockClear()

    // Simulate a ws session:update with the SAME savedAt but a higher turnSequence.
    act(() =>
      result.current.onSessionUpdate({
        savedAt: '2026-05-25T10:00:00.000Z', // same — would fail M7 poll gate
        turnSequence: 5,                       // but seqNewer passes (5 > 0)
        messages: [{ role: 'assistant', content: 'WS UPDATE' }],
        sessionLog: [],
        party: [],
      })
    )

    // setMessages MUST have been called (update admitted via turnSequence path).
    expect(setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: 'WS UPDATE' })])
    )
  })

  // (b) onSessionState resets the sentinel so a session:state at turnSequence 0 IS applied
  //     even after onNewSession() set localTurnSequence to -1 (the MC-7 sentinel reset).
  it('onSessionState resets the sentinel — after onNewSession, a session:state at seq 0 is applied', async () => {
    loadSyncSession.mockResolvedValue(null)

    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await act(async () => {}) // mount settle

    // onNewSession sets localTurnSequence to -1 and savedAt sentinel to '9999-...'.
    act(() => result.current.onNewSession())
    setMessages.mockClear()

    // onSessionState UNCONDITIONALLY applies — no gate check.
    // A session:state at turnSequence 0 passes because onSessionState does NOT use the gate.
    act(() =>
      result.current.onSessionState({
        savedAt: '2026-05-25T10:00:00.000Z', // well below '9999-...' sentinel
        turnSequence: 0,
        messages: [{ role: 'assistant', content: 'NEW ROOM STATE' }],
        sessionLog: [],
        party: [],
      })
    )

    // setMessages MUST be called — sentinel reset, state applied.
    expect(setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: 'NEW ROOM STATE' })])
    )
  })

  // (c) poll-source payload after onNewSession is still blocked by the 9999 sentinel.
  //     Regression guard for the existing resurrection guard (the poll path must remain unchanged).
  it('poll adopt after onNewSession is still blocked by the 9999 sentinel (regression)', async () => {
    loadSyncSession.mockResolvedValue({
      savedAt: '2026-05-25T10:00:00.000Z',
      messages: [{ role: 'assistant', content: 'OLD SESSION' }],
      sessionLog: [],
      party: [],
    })
    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await waitFor(() => expect(setMessages).toHaveBeenCalledTimes(1))

    act(() => result.current.onNewSession())
    setMessages.mockClear()

    // Simulate the poll callback firing with a post-clear savedAt (still < '9999-...').
    const pollCallback = pollSyncSession.mock.calls[0][2]
    act(() =>
      pollCallback({
        savedAt: '2026-05-25T11:00:00.000Z', // newer than old session, but < '9999-...'
        messages: [{ role: 'assistant', content: 'RESURRECTED' }],
        sessionLog: [],
        party: [],
      })
    )

    // The '9999-...' sentinel blocks the poll adoption — no resurrection.
    expect(setMessages).not.toHaveBeenCalled()
  })
})

// ─── Phase 7 — M7 gate blocks stale WS session:update adoption ───────────────
//
// Referenced by server/sync-server.multiplayer.test.mjs Phase 7 it() #5.
// Exercises the dual-authority gate (ws source) exhaustively:
//   - REJECTS when neither turnSequence NOR savedAt advance (true stale)
//   - ADMITS when turnSequence advances even if savedAt stays the same
//   - REJECTS when savedAt is stale AND turnSequence equals local (equal-seq boundary)
describe('Phase 7 — M7 gate blocks stale WS session:update adoption', () => {
  it('ws adopt: REJECTS an update when neither turnSequence nor savedAt advance', async () => {
    const stamp = '2026-05-25T10:00:00.000Z'
    seedLocal(stamp)
    loadSyncSession.mockResolvedValue(null)

    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await act(async () => {}) // mount settle

    // First feed a legitimate update to set the internal refs
    act(() =>
      result.current.onSessionState({
        savedAt: stamp,
        turnSequence: 3,
        messages: [{ role: 'assistant', content: 'Current state' }],
        sessionLog: [],
        party: [],
      })
    )
    setMessages.mockClear()

    // Now send a stale session:update — same savedAt, same turnSequence (neither advances)
    act(() =>
      result.current.onSessionUpdate({
        savedAt: stamp,         // not newer
        turnSequence: 3,        // not greater
        messages: [{ role: 'assistant', content: 'STALE WS UPDATE' }],
        sessionLog: [],
        party: [],
      })
    )

    // The dual-authority gate must block it — setMessages must NOT be called
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('ws adopt: ADMITS an update when only turnSequence advances (same savedAt)', async () => {
    const stamp = '2026-05-25T10:00:00.000Z'
    loadSyncSession.mockResolvedValue(null)

    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await act(async () => {}) // mount settle

    // Establish current state at turnSequence 2
    act(() =>
      result.current.onSessionState({
        savedAt: stamp,
        turnSequence: 2,
        messages: [{ role: 'assistant', content: 'Turn 2' }],
        sessionLog: [],
        party: [],
      })
    )
    setMessages.mockClear()

    // An update with the SAME savedAt but a HIGHER turnSequence must be admitted
    act(() =>
      result.current.onSessionUpdate({
        savedAt: stamp,         // same — would fail the savedAt branch alone
        turnSequence: 3,        // seqNewer passes (3 > 2)
        messages: [{ role: 'assistant', content: 'Turn 3 via seq' }],
        sessionLog: [],
        party: [],
      })
    )

    expect(setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: 'Turn 3 via seq' })])
    )
  })

  it('ws adopt: REJECTS a stale savedAt with an equal turnSequence', async () => {
    const stamp = '2026-05-25T10:00:00.000Z'
    const olderStamp = '2026-05-25T09:00:00.000Z'
    loadSyncSession.mockResolvedValue(null)

    const setMessages = vi.fn()
    const { result } = renderHook(() =>
      useSessionPersistence(baseProps({ setMessages }))
    )
    await act(async () => {}) // mount settle

    // Establish current state: seq=5, saved at stamp
    act(() =>
      result.current.onSessionState({
        savedAt: stamp,
        turnSequence: 5,
        messages: [{ role: 'assistant', content: 'Current' }],
        sessionLog: [],
        party: [],
      })
    )
    setMessages.mockClear()

    // An update with an OLDER savedAt and the SAME turnSequence — neither branch passes
    act(() =>
      result.current.onSessionUpdate({
        savedAt: olderStamp,    // older — timeNewer fails
        turnSequence: 5,        // equal — seqNewer fails (5 > 5 is false)
        messages: [{ role: 'assistant', content: 'STALE OLDER' }],
        sessionLog: [],
        party: [],
      })
    )

    // Both gates fail → update must be rejected
    expect(setMessages).not.toHaveBeenCalled()
  })
})

// ─── D-03: per-turn push suppressed when socketConnected (MP server-authoritative) ──
//
// In multiplayer the server writes the .md via persistRoom; the client must NOT
// issue HTTP PUTs (they race and clobber characters/roomCode). Mirror the poll's
// socketConnected guard on the push effect.
//
// INVARIANT: wasLoading.current and adopting.current bookkeeping must STILL run on
// every render even when socketConnected=true — only the network call is suppressed.
describe('D-03 — per-turn push suppressed when socketConnected=true', () => {
  // When WS is OPEN (socketConnected=true), a loading falling edge must NOT call
  // saveSyncSession. The server's persistRoom is the sole writer in MP.
  it('does NOT call saveSyncSession on loading falling edge when socketConnected=true', async () => {
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true, socketConnected: true }),
    })
    await act(async () => {}) // let mount settle

    // Falling edge: isLoading true → false while WS is OPEN
    rerender(baseProps({
      isLoading: false,
      socketConnected: true,
      messages: [{ role: 'assistant', content: 'dm response' }],
    }))
    await act(async () => {})

    // No PUT must fire — server handles persistence in MP
    expect(saveSyncSession).not.toHaveBeenCalled()
  })

  // When WS is NOT open (socketConnected=false/absent), the push MUST still fire
  // (existing single-player behavior unchanged).
  it('DOES call saveSyncSession on loading falling edge when socketConnected=false (SP unchanged)', async () => {
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true, socketConnected: false }),
    })
    await act(async () => {})

    rerender(baseProps({
      isLoading: false,
      socketConnected: false,
      messages: [{ role: 'assistant', content: 'dm response' }],
    }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
  })

  // Transition: WS disconnects (socketConnected flips false) — the NEXT falling edge
  // after disconnect should fire a PUT (back to SP-with-sync path).
  it('resumes push after socketConnected transitions true → false', async () => {
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: false, socketConnected: true }),
    })
    await act(async () => {})

    // Simulate a turn while WS is OPEN — no PUT
    rerender(baseProps({ isLoading: true, socketConnected: true }))
    rerender(baseProps({ isLoading: false, socketConnected: true, messages: [{ role: 'assistant', content: 'turn1' }] }))
    await act(async () => {})
    expect(saveSyncSession).not.toHaveBeenCalled()

    // WS closes, next turn should fire PUT
    rerender(baseProps({ isLoading: true, socketConnected: false, messages: [{ role: 'assistant', content: 'turn1' }] }))
    rerender(baseProps({ isLoading: false, socketConnected: false, messages: [{ role: 'assistant', content: 'turn2' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
  })

  // Bookkeeping invariant: wasLoading and adopting.current still update correctly
  // when socketConnected=true so that the subsequent turn (after disconnect) behaves
  // correctly — adopting.current must be cleared on an adopt-cycle, wasLoading must track.
  it('adopting.current is cleared on a WS-sourced adopt even when socketConnected=true (bookkeeping)', async () => {
    const setMessages = vi.fn()
    const { result, rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: false, socketConnected: true, setMessages }),
    })
    await act(async () => {})

    // Simulate the WS session:update setting adopting.current (via onSessionUpdate)
    // and then the loading falling edge (dm:done) clearing it — no PUT, but
    // adopting.current must be reset so the NEXT (post-disconnect) turn can push.
    act(() =>
      result.current.onSessionUpdate({
        savedAt: '2026-05-25T10:00:00.000Z',
        turnSequence: 1,
        messages: [{ role: 'assistant', content: 'WS UPDATE' }],
        sessionLog: [],
        party: [],
      })
    )

    // Falling edge while socketConnected=true — adopting.current SHOULD be cleared,
    // no PUT fired.
    rerender(baseProps({ isLoading: true, socketConnected: true, setMessages }))
    rerender(baseProps({ isLoading: false, socketConnected: true, setMessages, messages: [{ role: 'assistant', content: 'WS UPDATE' }] }))
    await act(async () => {})
    expect(saveSyncSession).not.toHaveBeenCalled()

    // Now WS closes. The NEXT turn's falling edge must fire a PUT (adopting.current
    // was already cleared by the previous falling-edge pass, so no suppression).
    rerender(baseProps({ isLoading: true, socketConnected: false, setMessages, messages: [{ role: 'assistant', content: 'WS UPDATE' }] }))
    rerender(baseProps({ isLoading: false, socketConnected: false, setMessages, messages: [{ role: 'assistant', content: 'offline turn' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))
  })
})

// ─── D-01: characters + roomCode props forwarded in the push payload ──────────
//
// The push payload previously used serializeSession({campaign,messages,sessionLog,party})
// which defaults characters:{} and roomCode:null. Now the hook accepts these as
// optional props and threads them into the serializeSession call.
describe('D-01 — push payload carries characters and roomCode props', () => {
  it('push payload includes characters when provided', async () => {
    const chars = { Alice: { name: 'Alice', charClass: 'Rogue', race: 'Elf', abilities: { STR: 10, DEX: 16, CON: 12, INT: 12, WIS: 10, CHA: 14 }, ac: 14, hpMax: 30 } }
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true, characters: chars, roomCode: 'dnd-abc123' }),
    })
    await act(async () => {})

    rerender(baseProps({ isLoading: false, characters: chars, roomCode: 'dnd-abc123', messages: [{ role: 'assistant', content: 'x' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))

    const pushedPayload = saveSyncSession.mock.calls[0][0]
    // characters map must survive the push — pickCharacters normalizes it
    expect(Object.keys(pushedPayload.characters ?? {}).length).toBeGreaterThan(0)
    expect(pushedPayload.roomCode).toBe('dnd-abc123')
  })

  it('push payload defaults characters:{} and roomCode:null when props absent (backward-compat)', async () => {
    const { rerender } = renderHook(props => useSessionPersistence(props), {
      initialProps: baseProps({ isLoading: true }),
      // No characters or roomCode props — existing SP callers
    })
    await act(async () => {})

    rerender(baseProps({ isLoading: false, messages: [{ role: 'assistant', content: 'x' }] }))
    await waitFor(() => expect(saveSyncSession).toHaveBeenCalledTimes(1))

    const pushedPayload = saveSyncSession.mock.calls[0][0]
    expect(pushedPayload.characters).toEqual({})
    expect(pushedPayload.roomCode).toBeNull()
  })
})
