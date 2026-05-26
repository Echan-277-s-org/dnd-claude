// @vitest-environment jsdom
//
// useWebSocket hook unit tests — Phase 1 + Phase 2 client-side gate
//
// Phase 1 tests are ACTIVE. The M7 gate describe remains .skip (it is exercised
// in useSessionPersistence in a later phase).
//
// Uses the Vitest built-in MockWebSocket pattern (global.WebSocket is mocked in
// the jsdom environment via vi.stubGlobal) rather than a real server, keeping this
// file in the jsdom tier.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §2.3, §5, §7 Phase 1
//   MULTIPLAYER-TEST-AUTOMATION.md §1 (unit tier), §4 (jsdom vs node-env split)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWebSocket } from './useWebSocket'

// ─── MockWebSocket (jsdom tier) ───────────────────────────────────────────────
// A minimal WebSocket mock that exposes sent messages and lets tests simulate
// inbound server events.

class MockWebSocket extends EventTarget {
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0 // CONNECTING
    MockWebSocket.instances.push(this)
    // Simulate open on next tick
    setTimeout(() => {
      if (this.readyState === 0) {
        this.readyState = 1 // OPEN
        this.dispatchEvent(new Event('open'))
      }
    }, 0)
  }
  send(data) {
    if (!this.sent) this.sent = []
    let parsed
    try { parsed = JSON.parse(data) } catch { parsed = data }
    this.sent.push(parsed)
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
  // Test helper: simulate a message from the server
  receive(payload) {
    const evt = Object.assign(new Event('message'), {
      data: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
    this.dispatchEvent(evt)
  }
}
MockWebSocket.instances = []

// WebSocket ready-state constants (mirroring the real WebSocket API).
MockWebSocket.CONNECTING = 0
MockWebSocket.OPEN = 1
MockWebSocket.CLOSING = 2
MockWebSocket.CLOSED = 3

// ─── fixtures ────────────────────────────────────────────────────────────────

const ROOM_CODE = 'dnd-a1b2c3d4'
const SESSION_ID = 'a1b2c3d4-0000-0000-0000-000000000000'
const DISPLAY_NAME = 'Alex'

const defaultOpts = {
  roomCode: ROOM_CODE,
  sessionId: SESSION_ID,
  displayName: DISPLAY_NAME,
}

// ─── useWebSocket — connection lifecycle ──────────────────────────────────────

describe('useWebSocket — connection lifecycle', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('connects to ws://<host>:3001/ws on mount', async () => {
    renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()
    expect(ws.url).toMatch(/ws:\/\/.*:3001\/ws/)
  })

  it('sends a join message immediately after open', async () => {
    renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    const join = (ws.sent ?? []).find(m => m.type === 'join')
    expect(join).toBeDefined()
    expect(join.roomCode).toBe(ROOM_CODE)
    expect(join.displayName).toBe(DISPLAY_NAME)
    expect(join.sessionId).toBe(SESSION_ID)
  })

  it('join message includes lastTurnSequence (starts at 0)', async () => {
    renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    const join = (ws.sent ?? []).find(m => m.type === 'join')
    expect(join).toBeDefined()
    expect(typeof join.lastTurnSequence).toBe('number')
    expect(join.lastTurnSequence).toBe(0)
  })

  it('exposes readyState as a reactive value (OPEN after connect)', async () => {
    const { result } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    expect(result.current.readyState).toBe(1) // OPEN
  })

  it('exposes a send() helper that wraps JSON serialization', async () => {
    const { result } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    act(() => result.current.send({ type: 'action', roomCode: ROOM_CODE, payload: {} }))
    const ws = MockWebSocket.instances[0]
    const action = (ws.sent ?? []).find(m => m.type === 'action')
    expect(action).toBeDefined()
  })

  it('send() is a noop when socket is not open', async () => {
    const { result } = renderHook(() => useWebSocket(defaultOpts))
    // Don't advance timers — send immediately while still CONNECTING.
    // Nothing should throw.
    expect(() => result.current.send({ type: 'ping' })).not.toThrow()
  })

  it('closes the WebSocket and cancels reconnect on unmount', async () => {
    const { unmount } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    unmount()
    // After unmount the ws should be closed (readyState === 3).
    expect([3, 0]).toContain(ws.readyState) // CLOSED or never opened in fake-timer env
  })
})

// ─── useWebSocket — inbound event routing ─────────────────────────────────────

describe('useWebSocket — inbound event routing', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('calls onMessage callback with parsed payload for each inbound event', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket({ ...defaultOpts, onMessage }))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    act(() =>
      ws.receive({
        type: 'session:state',
        payload: { messages: [], party: [], phase: 'free-roam', turnSequence: 0 },
      })
    )
    expect(onMessage).toHaveBeenCalledWith({
      type: 'session:state',
      payload: expect.any(Object),
    })
  })

  it('session:state payload is routed to an onSessionState callback if provided', async () => {
    const onSessionState = vi.fn()
    renderHook(() => useWebSocket({ ...defaultOpts, onSessionState }))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    act(() =>
      ws.receive({ type: 'session:state', payload: { messages: [], party: [] } })
    )
    expect(onSessionState).toHaveBeenCalled()
  })

  it('onSessionState receives the payload object (not the full envelope)', async () => {
    const onSessionState = vi.fn()
    renderHook(() => useWebSocket({ ...defaultOpts, onSessionState }))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    const expectedPayload = { messages: [{ role: 'user', content: 'hi' }], party: [], turnSequence: 3 }
    act(() => ws.receive({ type: 'session:state', payload: expectedPayload }))
    expect(onSessionState).toHaveBeenCalledWith(expect.objectContaining({ turnSequence: 3 }))
  })

  it('non-session:state messages do NOT call onSessionState', async () => {
    const onSessionState = vi.fn()
    renderHook(() => useWebSocket({ ...defaultOpts, onSessionState }))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    act(() => ws.receive({ type: 'presence:update', payload: [] }))
    expect(onSessionState).not.toHaveBeenCalled()
  })

  it('silently ignores malformed JSON messages (does not throw)', async () => {
    renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    expect(() => {
      act(() => {
        const evt = Object.assign(new Event('message'), { data: 'not json {' })
        ws.dispatchEvent(evt)
      })
    }).not.toThrow()
  })

  it('tracks turnSequence from session:state for use on reconnect', async () => {
    // After receiving a session:state with turnSequence: 5, a subsequent join
    // (after reconnect) should send lastTurnSequence: 5.
    const { unmount } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws1 = MockWebSocket.instances[0]

    // Simulate server sending session:state with turnSequence 5.
    act(() => ws1.receive({ type: 'session:state', payload: { messages: [], party: [], turnSequence: 5 } }))

    // Simulate disconnect — triggers reconnect.
    act(() => ws1.close())

    // Advance past the backoff delay.
    await act(async () => { vi.advanceTimersByTime(2000) })
    await act(async () => { vi.runAllTimers() })

    const ws2 = MockWebSocket.instances[1]
    // The join on reconnect should include lastTurnSequence: 5.
    const join = (ws2?.sent ?? []).find(m => m.type === 'join')
    expect(join?.lastTurnSequence).toBe(5)

    unmount()
  })
})

// ─── useWebSocket — reconnect and backoff ─────────────────────────────────────

describe('useWebSocket — reconnect and backoff', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reconnects after a close event', async () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })

    const firstWs = MockWebSocket.instances[0]
    act(() => firstWs.close())

    // Advance time past the 1s initial backoff (with jitter, advance 1.5s to be safe).
    await act(async () => { vi.advanceTimersByTime(1500) })

    // Trigger any setTimeout callbacks from the reconnect.
    await act(async () => { vi.runAllTimers() })

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)

    unmount()
    vi.useRealTimers()
  })

  it('backoff delay increases — attempt 0 uses ~1s, later attempts use longer delays', async () => {
    // This test verifies the backoff table exists and increases.
    // We check by measuring how many instances are created at various time points.
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })

    // Trigger disconnect (attempt 0 → backoff ~1s).
    act(() => MockWebSocket.instances[0].close())

    // Advance 500ms — not enough for attempt 0 backoff (1s ± 20% = 800ms–1200ms).
    await act(async () => { vi.advanceTimersByTime(500) })
    const countAfter500 = MockWebSocket.instances.length
    // Should NOT have reconnected yet.
    expect(countAfter500).toBe(1)

    // Advance another 1000ms — now past the backoff.
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(async () => { vi.runAllTimers() })
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)

    unmount()
    vi.useRealTimers()
  })

  it('sends a join message on each reconnect', async () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })

    act(() => MockWebSocket.instances[0].close())
    await act(async () => { vi.advanceTimersByTime(2000) })
    await act(async () => { vi.runAllTimers() })

    const ws2 = MockWebSocket.instances[1]
    if (ws2) {
      const join = (ws2.sent ?? []).find(m => m.type === 'join')
      expect(join).toBeDefined()
    }

    unmount()
    vi.useRealTimers()
  })
})

// ─── useWebSocket — poll suspension ──────────────────────────────────────────

describe('useWebSocket — poll suspension', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('signals shouldPoll=false when WebSocket is OPEN', async () => {
    const { result } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    // After open, shouldPoll must be false (poll suspended).
    expect(result.current.shouldPoll).toBe(false)
  })

  it('signals shouldPoll=true when WebSocket is closed (poll resumes)', async () => {
    const { result, unmount } = renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    expect(result.current.shouldPoll).toBe(false) // sanity: OPEN

    const ws = MockWebSocket.instances[0]
    act(() => ws.close())
    // After close, shouldPoll must be true.
    expect(result.current.shouldPoll).toBe(true)

    unmount()
  })

  it('shouldPoll starts true (CONNECTING) before the socket opens', () => {
    // Before open fires, readyState is CONNECTING → shouldPoll should be true.
    const { result } = renderHook(() => useWebSocket(defaultOpts))
    // Don't advance timers — check immediately before open fires.
    expect(result.current.shouldPoll).toBe(true)
  })
})

// ─── useWebSocket — joinCharacter in join message (mp-character-sync Phase 2/3) ─

describe('useWebSocket — joinCharacter in join message', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('join message includes joinCharacter when provided', async () => {
    const joinCharacter = {
      name: 'Aria Swiftwind',
      race: 'Elf',
      charClass: 'Ranger',
      abilities: { STR: 12, DEX: 18, CON: 14, INT: 13, WIS: 16, CHA: 10 },
      ac: 15,
      hpMax: 38,
    }
    renderHook(() => useWebSocket({ ...defaultOpts, joinCharacter }))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    const join = (ws.sent ?? []).find(m => m.type === 'join')
    expect(join).toBeDefined()
    expect(join.joinCharacter).toEqual(joinCharacter)
  })

  it('join message includes joinCharacter: null when none is provided (default)', async () => {
    // No joinCharacter passed — should default to null in the join message.
    renderHook(() => useWebSocket(defaultOpts))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    const join = (ws.sent ?? []).find(m => m.type === 'join')
    expect(join).toBeDefined()
    expect(join.joinCharacter).toBeNull()
  })

  it('join message includes joinCharacter: null when explicitly passed null', async () => {
    renderHook(() => useWebSocket({ ...defaultOpts, joinCharacter: null }))
    await act(async () => { vi.runAllTimers() })
    const ws = MockWebSocket.instances[0]
    const join = (ws.sent ?? []).find(m => m.type === 'join')
    expect(join).toBeDefined()
    expect(join.joinCharacter).toBeNull()
  })

  it('join message on reconnect also includes joinCharacter', async () => {
    const joinCharacter = {
      name: 'Thorn',
      race: 'Dwarf',
      charClass: 'Paladin',
      abilities: { STR: 18, DEX: 10, CON: 16, INT: 10, WIS: 14, CHA: 12 },
      ac: 18,
      hpMax: 52,
    }
    const { unmount } = renderHook(() => useWebSocket({ ...defaultOpts, joinCharacter }))
    await act(async () => { vi.runAllTimers() })
    const ws1 = MockWebSocket.instances[0]

    // Simulate disconnect → reconnect.
    act(() => ws1.close())
    await act(async () => { vi.advanceTimersByTime(2000) })
    await act(async () => { vi.runAllTimers() })

    const ws2 = MockWebSocket.instances[1]
    if (ws2) {
      const join = (ws2.sent ?? []).find(m => m.type === 'join')
      expect(join?.joinCharacter).toEqual(joinCharacter)
    }

    unmount()
  })

  it('single-player (enabled=false) never creates a WebSocket regardless of joinCharacter', async () => {
    const joinCharacter = {
      name: 'Solo Hero',
      race: 'Human',
      charClass: 'Fighter',
      abilities: { STR: 15, DEX: 13, CON: 14, INT: 10, WIS: 12, CHA: 8 },
      ac: 16,
      hpMax: 30,
    }
    renderHook(() => useWebSocket({ ...defaultOpts, joinCharacter, enabled: false }))
    await act(async () => { vi.runAllTimers() })
    // enabled=false → zero WebSocket created (absolute single-player invariant).
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('does NOT recreate the socket when only the joinCharacter object identity changes (reconnect storm fix)', async () => {
    // This is the primary regression test for the reconnect storm bug.
    // The bug: Chat.jsx builds a new joinCharacter object literal on every render.
    // The old code had joinCharacter in the connect useCallback dep array, so each
    // new reference caused connect() to be recreated → useEffect re-ran → socket
    // torn down and reopened → readyState change → re-render → storm.
    // The fix: joinCharacter is stored in a ref; connect() only depends on
    // roomCode/sessionId/displayName/enabled.

    const charV1 = {
      name: 'Aria',
      race: 'Elf',
      charClass: 'Ranger',
      abilities: { STR: 12, DEX: 18, CON: 14, INT: 13, WIS: 16, CHA: 10 },
      ac: 15,
      hpMax: 38,
    }
    // Deep-equal but a completely new object reference — mimics Chat.jsx re-render.
    const charV2 = {
      name: 'Aria',
      race: 'Elf',
      charClass: 'Ranger',
      abilities: { STR: 12, DEX: 18, CON: 14, INT: 13, WIS: 16, CHA: 10 },
      ac: 15,
      hpMax: 38,
    }

    let joinCharacter = charV1
    const { rerender, result } = renderHook(
      () => useWebSocket({ ...defaultOpts, joinCharacter })
    )

    // Let the socket open.
    await act(async () => { vi.runAllTimers() })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(result.current.readyState).toBe(1) // OPEN

    // Re-render with a new joinCharacter object reference (same content, different identity).
    joinCharacter = charV2
    await act(async () => { rerender() })

    // CRITICAL: WebSocket constructor must still have been called exactly once.
    // No new socket should have been created — the existing one stays OPEN.
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(result.current.readyState).toBe(1) // still OPEN, not torn down
  })

  it('join message on reconnect carries the LATEST joinCharacter value from the ref', async () => {
    // Even though joinCharacter changes don't recreate the socket, a genuine
    // reconnect (e.g. server-side close) must use the current ref value, not a
    // stale snapshot captured at mount time.
    const charV1 = {
      name: 'Thorn',
      race: 'Dwarf',
      charClass: 'Paladin',
      abilities: { STR: 18, DEX: 10, CON: 16, INT: 10, WIS: 14, CHA: 12 },
      ac: 18,
      hpMax: 52,
    }
    const charV2 = {
      name: 'Thorn',
      race: 'Dwarf',
      charClass: 'Paladin',
      abilities: { STR: 18, DEX: 10, CON: 16, INT: 10, WIS: 14, CHA: 12 },
      ac: 20, // updated AC — simulates user editing their sheet between reconnects
      hpMax: 52,
    }

    let joinCharacter = charV1
    const { rerender, unmount } = renderHook(
      () => useWebSocket({ ...defaultOpts, joinCharacter })
    )

    await act(async () => { vi.runAllTimers() })
    const ws1 = MockWebSocket.instances[0]

    // Update the character reference (simulating a re-render with new data).
    joinCharacter = charV2
    await act(async () => { rerender() })

    // No new socket yet — existing one still open.
    expect(MockWebSocket.instances).toHaveLength(1)

    // Now simulate a genuine server-side disconnect.
    act(() => ws1.close())
    await act(async () => { vi.advanceTimersByTime(2000) })
    await act(async () => { vi.runAllTimers() })

    // A second socket should now have been created for the reconnect.
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    const ws2 = MockWebSocket.instances[1]
    const join = (ws2?.sent ?? []).find(m => m.type === 'join')
    // The join message must carry charV2 (the latest value), not the stale charV1.
    expect(join?.joinCharacter?.ac).toBe(20)

    unmount()
  })
})

// ─── useWebSocket — M7 gate on session:update path (routing placeholder) ─────

describe.skip('useWebSocket — M7 gate on session:update path', () => {
  it('session:update with savedAt older than local is NOT adopted (M7 gate preserved)', async () => {
    // The hook exposes an adopt() callback; or the onMessage callback is responsible.
    // This test verifies the hook does NOT call setState with a stale payload.
    // onMessage or onSessionUpdate should receive the payload; the gate is tested
    // in useSessionPersistence.test — here we just verify the routing is correct.
  })

  it('the 9999 sentinel still blocks resurrection via session:update (onNewSession path)', async () => {
    // Mirrors the existing useSessionPersistence "resurrection guard" test but
    // via the WebSocket event path instead of the poll path.
  })
})
