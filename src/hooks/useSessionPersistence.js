import { useEffect, useRef, useCallback } from 'react'
import {
  serializeSession,
  deserializeSession,
  loadSyncSession,
  saveSyncSession,
  pollSyncSession,
  deleteSyncSession,
  markOrphanedDice,
} from '../lib/session'

// Phase A localStorage key — the offline mirror the M7 staleness gate reads.
const SESSION_KEY = 'dnd_session'

// Local last-saved stamp (the offline turn's savedAt). Used by the M7 gate so a
// stale server copy can never overwrite a newer turn played while offline.
function localSavedAt() {
  const local = deserializeSession(localStorage.getItem(SESSION_KEY))
  return local?.savedAt ?? null
}

// ─── useSessionPersistence (Phase B client + Phase 2 WS layer) ───────────────
// Additive layer over Chat's localStorage persistence (Phase A): localStorage is
// the offline mirror; the LAN sync server is authoritative WHEN REACHABLE,
// enforced by load order (server fetch overwrites the locally-hydrated state).
// Every network call degrades silently (session.js wraps them), so a down server
// leaves the app fully usable on localStorage + .md alone.
//
// Conflict model = handoff-first LWW: the client bases each PUT on the last
// server-stamped savedAt; a 409 is left non-destructive (local kept, the 30s
// poll reconciles). Simultaneous co-play is explicitly out of scope for v1.
//
// Phase 2 additions (all additive; single-player path is byte-for-byte unchanged):
//   - adopt(payload, source) — 'poll' keeps existing M7 logic; 'ws' uses dual-
//     authority gate (turnSequence OR savedAt).
//   - localTurnSequence ref — tracks the client's current turn counter.
//   - onSessionState — unconditional apply on join/rejoin (sentinel reset MC-7).
//   - onSessionUpdate — calls adopt(payload, 'ws').
//   - onNewSession — additionally sets localTurnSequence.current = -1.
//   - socketConnected prop — when truthy, the 30s poll interval is not started.
export function useSessionPersistence({
  campaign,
  messages,
  setMessages,
  sessionLog,
  setSessionLog,
  party,
  setParty,
  isLoading,
  socketConnected, // Phase 2: optional boolean — when truthy, skip the 30s poll
}) {
  const id = campaign?.sessionId
  const lastSavedAt = useRef(null) // last server stamp we hold — the staleness base
  const adopting = useRef(false) // suppress the save that an adopt() would trigger
  const wasLoading = useRef(false)

  // Phase 2: tracks the client's current turn counter. Initialized from the
  // persisted session on mount if available, else 0. (Initialized to 0 here;
  // mount effect rebases it from localStorage if needed.)
  const localTurnSequence = useRef(0)

  // ─── Internal apply helper ───────────────────────────────────────────────────
  // Applies state from a payload (messages, sessionLog, party) using the same
  // markOrphanedDice path as the original adopt. Does NOT touch lastSavedAt or
  // localTurnSequence — callers do that.
  function applyStateLocally(payload) {
    adopting.current = true
    if (Array.isArray(payload.messages)) setMessages(markOrphanedDice(payload.messages))
    if (Array.isArray(payload.sessionLog)) setSessionLog(payload.sessionLog)
    if (payload.party?.length) setParty(payload.party)
  }

  // ─── adopt(payload, source) ──────────────────────────────────────────────────
  // Overwrite (not merge) local state from a server payload — gated by source.
  //
  // source === 'poll' (default): preserves existing M7 strictly-greater savedAt
  //   gate. This is the UNCHANGED single-player path.
  //
  // source === 'ws': dual-authority gate (MC-6). Admits update when turnSequence
  //   advances OR savedAt is strictly newer. Same-millisecond writes (rapid DM
  //   turns) pass via the turnSequence branch.
  function adopt(payload, source = 'poll') {
    if (!payload || payload.unchanged) return

    if (source === 'ws') {
      // ── Dual-authority gate (MC-6) ─────────────────────────────────────────
      const seqNewer = typeof payload.turnSequence === 'number'
        && payload.turnSequence > (localTurnSequence.current ?? -1)
      const lsLocal = localSavedAt()
      const refLocal = lastSavedAt.current
      const localTs = lsLocal && refLocal ? (lsLocal > refLocal ? lsLocal : refLocal) : (lsLocal ?? refLocal)
      const timeNewer = payload.savedAt && payload.savedAt > (localTs ?? '')
      if (!seqNewer && !timeNewer) return

      applyStateLocally(payload)
      localTurnSequence.current = payload.turnSequence ?? localTurnSequence.current
      lastSavedAt.current = payload.savedAt ?? lastSavedAt.current
      return
    }

    // ── Poll path: UNCHANGED M7 strictly-greater savedAt gate ─────────────────
    // The staleness base is the MORE RECENT of the localStorage stamp (an offline
    // turn the server never received) and lastSavedAt.current (the new-session
    // sentinel, or the last server stamp we hold). ISO timestamps compare as strings.
    const lsLocal = localSavedAt()
    const refLocal = lastSavedAt.current
    const local = lsLocal && refLocal ? (lsLocal > refLocal ? lsLocal : refLocal) : (lsLocal ?? refLocal)
    // Strictly-newer gate (M7): when the server is NOT newer, keep local state
    // untouched. Base future PUTs on the SERVER's stamp (not local) so the offline
    // turn can overwrite the stale server copy — basing on the local stamp would
    // mismatch the stored savedAt and 409-deadlock, stranding the offline turn.
    if (local && !(payload.savedAt && payload.savedAt > local)) {
      if (payload.savedAt) lastSavedAt.current = payload.savedAt
      return
    }
    applyStateLocally(payload)
    lastSavedAt.current = payload.savedAt ?? null
  }

  // ─── onSessionState(payload) ─────────────────────────────────────────────────
  // Called when the WS receives a 'session:state' event (on join/rejoin).
  // UNCONDITIONALLY resets both ref sentinels and applies state — this is the
  // MC-7 sentinel reset. No gate check: session:state is the server's definitive
  // current view, always supersedes any local sentinel including '9999-...'.
  const onSessionState = useCallback((payload) => {
    if (!payload) return
    lastSavedAt.current = payload.savedAt ?? null
    localTurnSequence.current = payload.turnSequence ?? 0
    // Apply state unconditionally (no M7 gate).
    adopting.current = true
    if (Array.isArray(payload.messages)) setMessages(markOrphanedDice(payload.messages))
    if (Array.isArray(payload.sessionLog)) setSessionLog(payload.sessionLog)
    if (payload.party?.length) setParty(payload.party)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── onSessionUpdate(payload) ────────────────────────────────────────────────
  // Called when the WS receives a 'session:update' event (server broadcast).
  // Uses the 'ws' adopt path (dual-authority gate).
  const onSessionUpdate = useCallback((payload) => {
    adopt(payload, 'ws')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mount: adopt the server's copy when reachable (server-authoritative).
  // Also initialize localTurnSequence from localStorage if available.
  useEffect(() => {
    // Seed localTurnSequence from persisted session.
    const persisted = deserializeSession(localStorage.getItem(SESSION_KEY))
    if (persisted?.turnSequence != null) {
      localTurnSequence.current = persisted.turnSequence
    }

    let cancelled = false
    ;(async () => {
      const payload = await loadSyncSession(id)
      if (!cancelled) adopt(payload)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Push once per settled turn (loading falling edge) — never per stream delta.
  useEffect(() => {
    if (wasLoading.current && !isLoading) {
      if (adopting.current) {
        adopting.current = false // this turn's state came FROM the server; don't echo it back
      } else {
        const payload = serializeSession({ campaign, messages, sessionLog, party })
        payload.savedAt = lastSavedAt.current // base the write on what we last saw
        saveSyncSession(payload).then(res => {
          if (res.ok) lastSavedAt.current = res.savedAt
          // 409 / network error → keep local untouched; the poll reconciles.
        })
      }
    }
    wasLoading.current = isLoading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, campaign, messages, sessionLog, party])

  // Poll every 30s for a newer save from another device.
  // Phase 2: when socketConnected is truthy, skip starting the interval.
  // When absent/false (all existing tests + single-player), the poller registers
  // exactly as today with the same 3-arg signature.
  useEffect(() => {
    if (socketConnected) return // WS is live — polling is redundant; skip
    return pollSyncSession(id, () => lastSavedAt.current, payload => adopt(payload, 'poll'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, socketConnected])

  // New-session clear (SHOULD #2/#3): DELETE the server copy so another device's
  // poll can't resurrect it, and bump lastSavedAt to a future sentinel so any
  // in-flight poll's adopt() is rejected by the strictly-newer gate (the cleared
  // local state's fresh savedAt is not older than the sentinel).
  //
  // Phase 2 addition: set localTurnSequence.current = -1 so the next session:state
  // for the new room (turnSequence >= 0) passes the seqNewer check (0 > -1) and
  // breaks the deaf state caused by the '9999-...' sentinel (MC-7).
  const onNewSession = useCallback(() => {
    deleteSyncSession(id)
    lastSavedAt.current = '9999-12-31T23:59:59.999Z' // sentinel: sorts after all real ISO dates (string compare)
    localTurnSequence.current = -1 // Phase 2: any real session:state (seq >= 0) supersedes
    // No PUT fires from the clear (no loading falling edge), so nothing to suppress;
    // the sentinel makes the next poll's adopt() fail the M7 gate (no resurrection),
    // and the first real turn after this rebases on the server's post-DELETE state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return { onNewSession, onSessionState, onSessionUpdate }
}
