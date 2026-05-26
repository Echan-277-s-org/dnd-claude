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

// ─── useSessionPersistence (Phase B client) ───────────────────────────────────
// Additive layer over Chat's localStorage persistence (Phase A): localStorage is
// the offline mirror; the LAN sync server is authoritative WHEN REACHABLE,
// enforced by load order (server fetch overwrites the locally-hydrated state).
// Every network call degrades silently (session.js wraps them), so a down server
// leaves the app fully usable on localStorage + .md alone.
//
// Conflict model = handoff-first LWW: the client bases each PUT on the last
// server-stamped savedAt; a 409 is left non-destructive (local kept, the 30s
// poll reconciles). Simultaneous co-play is explicitly out of scope for v1.
export function useSessionPersistence({
  campaign,
  messages,
  setMessages,
  sessionLog,
  setSessionLog,
  party,
  setParty,
  isLoading,
}) {
  const id = campaign?.sessionId
  const lastSavedAt = useRef(null) // last server stamp we hold — the staleness base
  const adopting = useRef(false) // suppress the save that an adopt() would trigger
  const wasLoading = useRef(false)

  // Overwrite (not merge) local state from a server payload — but only when the
  // server copy is STRICTLY NEWER than what we hold locally (M7). Without this
  // gate, a turn played while the server was down (saved to localStorage, PUT
  // failed silently so lastSavedAt never advanced) would be discarded on the
  // next mount when the older server copy is adopted unconditionally.
  function adopt(payload) {
    if (!payload || payload.unchanged) return
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
    adopting.current = true
    if (Array.isArray(payload.messages)) setMessages(markOrphanedDice(payload.messages))
    if (Array.isArray(payload.sessionLog)) setSessionLog(payload.sessionLog)
    if (payload.party?.length) setParty(payload.party)
    lastSavedAt.current = payload.savedAt ?? null
  }

  // Mount: adopt the server's copy when reachable (server-authoritative).
  useEffect(() => {
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
  useEffect(() => {
    return pollSyncSession(id, () => lastSavedAt.current, adopt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // New-session clear (SHOULD #2/#3): DELETE the server copy so another device's
  // poll can't resurrect it, and bump lastSavedAt to a future sentinel so any
  // in-flight poll's adopt() is rejected by the strictly-newer gate (the cleared
  // local state's fresh savedAt is not older than the sentinel).
  const onNewSession = useCallback(() => {
    deleteSyncSession(id)
    lastSavedAt.current = '9999-12-31T23:59:59.999Z' // sentinel: sorts after all real ISO dates (string compare)
    // No PUT fires from the clear (no loading falling edge), so nothing to suppress;
    // the sentinel makes the next poll's adopt() fail the M7 gate (no resurrection),
    // and the first real turn after this rebases on the server's post-DELETE state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return { onNewSession }
}
