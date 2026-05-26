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
