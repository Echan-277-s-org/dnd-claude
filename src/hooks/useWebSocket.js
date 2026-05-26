// ─── useWebSocket.js — Phase 1 WebSocket connection manager ──────────────────
// Connects to the sync server's /ws endpoint on mount, sends a join message,
// and exposes a reactive readyState, a send() helper, and a shouldPoll signal
// so useSessionPersistence can suspend the 30s poll when the socket is open.
//
// Reconnect: exponential backoff 1s → 2s → 4s → 8s → 15s → 30s (cap), ±20% jitter.
// On each reconnect, sends a fresh join message with the last known turnSequence.
//
// Phase 4 addition: `enabled` flag (default true). When false (i.e. when
// roomCode/displayName are absent — single-player default), the hook is a noop:
// no WebSocket object is ever created, readyState stays CLOSED, shouldPoll = true.
// This preserves the ABSOLUTE CONSTRAINT that the default single-player path
// opens zero WebSocket connections.
//
// References:
//   MULTIPLAYER-ARCHITECTURE.md §2.3, §5.2, §7 Phase 1

import { useEffect, useRef, useState, useCallback } from 'react'
import { getLanHost } from '../lib/session.js'

// Backoff schedule (ms) — indices correspond to attempt number; cap at last entry.
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 15000, 30000]
const JITTER = 0.2 // ±20%

function backoffDelay(attempt) {
  const base = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)]
  const jitter = base * JITTER * (Math.random() * 2 - 1)
  return Math.round(base + jitter)
}

const WS_PORT = 3001

/**
 * useWebSocket({ roomCode, sessionId, displayName, onMessage, onSessionState, enabled })
 *
 * Returns:
 *   { readyState, send, shouldPoll }
 *
 * - readyState: WebSocket.CONNECTING (0) | OPEN (1) | CLOSING (2) | CLOSED (3)
 * - send(obj): JSON-serializes obj and sends over the WebSocket (noop if not OPEN)
 * - shouldPoll: false when OPEN (poll suspended), true otherwise (poll runs)
 *
 * When `enabled` is false (the single-player default), no WebSocket is created.
 * readyState = CLOSED, shouldPoll = true — byte-for-byte matching the pre-Phase-4
 * single-player behavior.
 */
export function useWebSocket({
  roomCode,
  sessionId,
  displayName,
  onMessage,
  onSessionState,
  enabled = true,
} = {}) {
  const [readyState, setReadyState] = useState(WebSocket.CLOSED)

  // Track the latest turnSequence received from server so rejoins are informed.
  const lastTurnSequenceRef = useRef(0)

  // Refs so reconnect timer + ws instance don't become stale in closures.
  const wsRef = useRef(null)
  const attemptRef = useRef(0)
  const reconnectTimerRef = useRef(null)
  const unmountedRef = useRef(false)

  // Stable references to callbacks so we don't re-create the WS on every render.
  const onMessageRef = useRef(onMessage)
  const onSessionStateRef = useRef(onSessionState)
  useEffect(() => { onMessageRef.current = onMessage }, [onMessage])
  useEffect(() => { onSessionStateRef.current = onSessionState }, [onSessionState])

  const connect = useCallback(() => {
    // Phase 4: never connect when disabled (single-player default).
    if (!enabled) return
    if (unmountedRef.current) return
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const url = `ws://${getLanHost(WS_PORT)}/ws`
    let ws
    try {
      ws = new WebSocket(url)
    } catch {
      // Construction failed (e.g. invalid URL in test env) — schedule retry.
      scheduleReconnect()
      return
    }
    wsRef.current = ws
    setReadyState(WebSocket.CONNECTING)

    ws.addEventListener('open', () => {
      if (unmountedRef.current || ws !== wsRef.current) { ws.close(); return }
      attemptRef.current = 0 // reset backoff on successful connect
      setReadyState(WebSocket.OPEN)

      // Send join message immediately after open.
      try {
        ws.send(JSON.stringify({
          type: 'join',
          roomCode,
          sessionId,
          displayName,
          lastTurnSequence: lastTurnSequenceRef.current,
        }))
      } catch {
        // best-effort
      }
    })

    ws.addEventListener('message', evt => {
      if (unmountedRef.current || ws !== wsRef.current) return
      let parsed
      try {
        parsed = JSON.parse(evt.data)
      } catch {
        // Silently ignore malformed JSON — never throw (sec item F).
        return
      }

      // Track turnSequence from any inbound session:state or session:update.
      if (
        parsed?.type === 'session:state' || parsed?.type === 'session:update'
      ) {
        const seq = parsed?.payload?.turnSequence
        if (typeof seq === 'number' && seq > lastTurnSequenceRef.current) {
          lastTurnSequenceRef.current = seq
        }
      }

      // Route to onMessage callback.
      try {
        onMessageRef.current?.({ type: parsed?.type, payload: parsed?.payload ?? parsed })
      } catch {
        // Callback errors must not crash the WS handler.
      }

      // Route session:state to dedicated onSessionState callback.
      if (parsed?.type === 'session:state') {
        try {
          onSessionStateRef.current?.(parsed?.payload)
        } catch {
          // idem
        }
      }
    })

    ws.addEventListener('close', () => {
      if (unmountedRef.current) return
      if (ws !== wsRef.current) return
      setReadyState(WebSocket.CLOSED)
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // The 'close' event fires after 'error'; let the close handler drive reconnect.
      if (!unmountedRef.current && ws === wsRef.current) {
        setReadyState(WebSocket.CLOSED)
      }
    })
  }, [roomCode, sessionId, displayName, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleReconnect() {
    if (unmountedRef.current) return
    if (!enabled) return // Phase 4: never reconnect when disabled
    const delay = backoffDelay(attemptRef.current)
    attemptRef.current += 1
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      connect()
    }, delay)
  }

  // Connect on mount, cleanup on unmount.
  useEffect(() => {
    unmountedRef.current = false
    if (enabled) {
      connect()
    }
    return () => {
      unmountedRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      const ws = wsRef.current
      wsRef.current = null
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
    }
  }, [connect, enabled])

  // send() helper — JSON-serializes and sends. Noop if socket is not open.
  const send = useCallback(obj => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(obj))
    } catch {
      // best-effort
    }
  }, [])

  // shouldPoll: true when the socket is NOT open (poll should run as fallback).
  const shouldPoll = readyState !== WebSocket.OPEN

  return { readyState, send, shouldPoll }
}
