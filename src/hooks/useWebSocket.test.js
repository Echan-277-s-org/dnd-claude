// @vitest-environment jsdom
//
// useWebSocket hook unit tests — Phase 1 + Phase 2 client-side gate
//
// ALL TESTS ARE SKIPPED. No implementation exists yet (the hook does not exist).
// These skeletons define the contract for the new useWebSocket.js hook documented
// in MULTIPLAYER-ARCHITECTURE.md §7 Phase 1.
//
// Uses the Vitest built-in MockWebSocket pattern (global.WebSocket is mocked in
// the jsdom environment via vi.stubGlobal) rather than a real server, keeping this
// file in the jsdom tier.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §2.3, §5, §7 Phase 1
//   MULTIPLAYER-TEST-AUTOMATION.md §1 (unit tier), §4 (jsdom vs node-env split)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// import { renderHook, act } from '@testing-library/react'
// import { useWebSocket } from './useWebSocket'

// ─── MockWebSocket (jsdom tier) ───────────────────────────────────────────────
// A minimal WebSocket mock that exposes sent messages and lets tests simulate
// inbound server events.
//
// class MockWebSocket extends EventTarget {
//   constructor(url) {
//     super()
//     this.url = url
//     this.readyState = 0 // CONNECTING
//     MockWebSocket.instances.push(this)
//     // Simulate open on next tick
//     setTimeout(() => {
//       this.readyState = 1 // OPEN
//       this.dispatchEvent(new Event('open'))
//     }, 0)
//   }
//   send(data) { this.sent = (this.sent ?? []).concat([JSON.parse(data)]) }
//   close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
//   // Test helper: simulate a message from the server
//   receive(payload) {
//     this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(payload) }))
//   }
// }
// MockWebSocket.instances = []

// ─── fixture ──────────────────────────────────────────────────────────────────

const ROOM_CODE = 'dnd-a1b2c3d4'
const SESSION_ID = 'a1b2c3d4-0000-0000-0000-000000000000'
const DISPLAY_NAME = 'Alex'

describe.skip('useWebSocket — connection lifecycle', () => {
  beforeEach(() => {
    // MockWebSocket.instances = []
    // vi.stubGlobal('WebSocket', MockWebSocket)
  })
  afterEach(() => {
    // vi.unstubAllGlobals()
  })

  it('connects to ws://<host>:3001/ws on mount', () => {
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // const ws = MockWebSocket.instances[0]
    // expect(ws.url).toMatch(/ws:\/\/.*:3001\/ws/)
  })

  it('sends a join message immediately after open', async () => {
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // const ws = MockWebSocket.instances[0]
    // const join = ws.sent.find(m => m.type === 'join')
    // expect(join).toBeDefined()
    // expect(join.roomCode).toBe(ROOM_CODE)
    // expect(join.displayName).toBe(DISPLAY_NAME)
    // expect(join.sessionId).toBe(SESSION_ID)
  })

  it('exposes readyState as a reactive value', async () => {
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // expect(result.current.readyState).toBe(1) // OPEN
  })

  it('exposes a send() helper that wraps JSON serialization', async () => {
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // act(() => result.current.send({ type: 'action', roomCode: ROOM_CODE, payload: {} }))
    // const ws = MockWebSocket.instances[0]
    // const action = ws.sent.find(m => m.type === 'action')
    // expect(action).toBeDefined()
  })
})

describe.skip('useWebSocket — inbound event routing', () => {
  it('calls onMessage callback with parsed payload for each inbound event', async () => {
    // const onMessage = vi.fn()
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME, onMessage })
    // )
    // await act(async () => {})
    // const ws = MockWebSocket.instances[0]
    // act(() => ws.receive({ type: 'session:state', payload: { messages: [], party: [], phase: 'free-roam', turnSequence: 0 } }))
    // expect(onMessage).toHaveBeenCalledWith({ type: 'session:state', payload: expect.any(Object) })
  })

  it('session:state payload is routed to an onSessionState callback if provided', async () => {
    // const onSessionState = vi.fn()
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME, onSessionState })
    // )
    // await act(async () => {})
    // const ws = MockWebSocket.instances[0]
    // act(() => ws.receive({ type: 'session:state', payload: { messages: [], party: [] } }))
    // expect(onSessionState).toHaveBeenCalled()
  })

  it('silently ignores malformed JSON messages (does not throw)', async () => {
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // const ws = MockWebSocket.instances[0]
    // expect(() => {
    //   act(() => ws.dispatchEvent(Object.assign(new Event('message'), { data: 'not json {' })))
    // }).not.toThrow()
  })
})

describe.skip('useWebSocket — reconnect and backoff', () => {
  it('reconnects after a close event', async () => {
    // vi.useFakeTimers()
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // const firstWs = MockWebSocket.instances[0]
    // act(() => firstWs.close())
    // // Advance time past the 1s initial backoff
    // await act(async () => vi.advanceTimersByTimeAsync(1200))
    // expect(MockWebSocket.instances.length).toBe(2) // second connection attempt
    // vi.useRealTimers()
  })

  it('backoff delay increases exponentially up to 30s cap', async () => {
    // vi.useFakeTimers()
    // // Test that 5 reconnect attempts use increasing delays, capped at 30s
    // // Delays (pre-jitter): 1s, 2s, 4s, 8s, 15s, 30s (cap)
    // vi.useRealTimers()
  })

  it('sends a join message on each reconnect with the last known turnSequence', async () => {
    // After reconnect, the join message should include lastTurnSequence > 0
    // if the client has received session:state with a turnSequence.
  })
})

describe.skip('useWebSocket — poll suspension', () => {
  it('signals poll-suspend=true when WebSocket is OPEN', async () => {
    // The hook should expose a `shouldPoll` boolean (or a ref) that
    // useSessionPersistence reads to suspend the 30s interval.
    // When WebSocket is OPEN: shouldPoll === false
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // expect(result.current.shouldPoll).toBe(false)
  })

  it('signals poll-suspend=false when WebSocket is closed (poll resumes)', async () => {
    // const { result } = renderHook(() =>
    //   useWebSocket({ roomCode: ROOM_CODE, sessionId: SESSION_ID, displayName: DISPLAY_NAME })
    // )
    // await act(async () => {})
    // const ws = MockWebSocket.instances[0]
    // act(() => ws.close())
    // expect(result.current.shouldPoll).toBe(true)
  })
})

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
