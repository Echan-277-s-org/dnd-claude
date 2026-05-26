import { useState, useRef, useEffect, useCallback } from 'react'
import DiceRoller from './DiceRoller'
import HistoryPanel from './HistoryPanel'
import CharacterPanel from './CharacterPanel'
import PartyStrip from './PartyStrip'
import DiceChip from './DiceChip'
import { getGenre } from '../lib/genres'
import { serializeSession, deserializeSession, getLanHost, toMarkdown, sessionFileName, markOrphanedDice, applyPartyUpdate, makeRoomCode, buildPlayersForPrompt } from '../lib/session'
import { useSessionPersistence } from '../hooks/useSessionPersistence'
import { useWebSocket } from '../hooks/useWebSocket'
import { isActiveTurn } from '../lib/turnStateMachine.js'

// Phase A: localStorage key for the persisted session payload (same shape that
// Phase A2's .md and Phase B's sync server use — defined once in session.js).
const SESSION_KEY = 'dnd_session'

// ─── Structured-block parser (Phase A) ────────────────────────────────────────
// These tags carry LLM-owned data; they are NEVER rendered in the chat bubble.

const BLOCK_TAGS = ['party', 'check', 'verdict']

// One compiled regex strips all known structured blocks before display.
// The lazy [\s\S]*? + required closing ``` means an unclosed fence mid-stream
// does NOT match — safe against partial streaming chunks.
const STRIP_RE = new RegExp(
  '```(?:' + BLOCK_TAGS.join('|') + ')[\\s\\S]*?```',
  'g'
)

function stripStructuredBlocks(text) {
  return text.replace(STRIP_RE, '').trimEnd()
}

// Parameterised extractor — returns parsed JSON or null (never throws).
function extractBlock(tag, text) {
  const re = new RegExp('```' + tag + '\\s*([\\s\\S]*?)```')
  const match = text.match(re)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim())
  } catch {
    return null // malformed JSON → ignore, keep last-known state
  }
}

// `applyPartyUpdate` moved to src/lib/session.js (Phase 0) — imported above so the
// client and the server-side DM proxy share one implementation.

function parseMarkdown(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const html = escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .split('\n\n')
    .filter(p => p.trim())
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')

  // Single shared drop-cap hook: wrap the first visible letter of the first
  // paragraph in <span class="dropcap"> (matches even when the paragraph opens
  // with <strong>/<em>). Theme A illuminates this span; Theme B leaves it plain
  // and surfaces the GM identity via the [GM] HUD label instead.
  const withDropcap = html.replace(
    /^(<p>(?:<(?:strong|em|code)>)*)([^<\s])/,
    '$1<span class="dropcap">$2</span>'
  )

  return withDropcap || '<p></p>'
}

export default function Chat({
  campaign,
  onReset,
  character,
  setCharacter,
  party,
  setParty,
  // Phase 4: multiplayer identity. Both null → single-player (no WS opened).
  roomCode,
  displayName,
}) {
  const genre = getGenre(campaign.genre)
  const { buildSystemPrompt, extractEntities, trimContext } = genre.engine
  // Phase A: hydrate messages + sessionLog from the persisted payload so a
  // refresh survives. One parse, shared by both lazy initializers.
  const stored = deserializeSession(localStorage.getItem(SESSION_KEY))
  // H4: a restored session often ends on an unresolved roll. Flag those bare dice
  // chips `orphaned` so the verdict parser can't later stamp PASS/FAIL onto them.
  const [messages, setMessages] = useState(() => markOrphanedDice(stored?.messages ?? []))
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showDice, setShowDice] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showCharacter, setShowCharacter] = useState(false)
  const [entities, setEntities] = useState(() =>
    stored?.messages ? extractEntities(stored.messages) : []
  )
  const [sessionLog, setSessionLog] = useState(() => stored?.sessionLog ?? [])
  // pendingCheck is session-only (not persisted). Cleared when the roll is sent or on new session.
  // SHOULD #1 (review): it is intentionally NOT reconstructed on load. The skill/DC
  // signal does not survive serialization — the ```check block is stripped from the
  // persisted assistant content (stripStructuredBlocks), and pendingCheck is already
  // cleared at roll-send time, so a saved session never carries a live check to restore.
  // Reviewers also ruled out persisting the raw value (cross-device "answered-twice"
  // hazard). It self-heals: the DM re-emits a ```check block on the next turn.
  const [pendingCheck, setPendingCheck] = useState(null)

  // Phase 4: multiplayer presence — list of { displayName, status } from server.
  const [presence, setPresence] = useState([])

  // Phase 5: server-authoritative phase ('free-roam' | 'combat' | 'awaiting-dm' | 'resolving').
  // Driven by session:update and session:state events from the server.
  // Single-player: stays 'free-roam' (never updated via WS).
  const [serverPhase, setServerPhase] = useState('free-roam')

  // ─── Multiplayer mode predicate (§3.7, MC-5) ────────────────────────────────
  // MULTIPLAYER iff the WebSocket is OPEN *and* the server has confirmed the room
  // is joined (first session:state received). `roomJoined` is set true only on
  // the first session:state event; reset on WS close or onNewSession.
  // SINGLE-PLAYER DEFAULT: when roomCode or displayName is null the WS is never
  // mounted (useWebSocket is called conditionally only when both are set),
  // wsState stays CLOSED, and roomJoinedRef stays false → isMultiplayerMode() === false.
  const wsReadyStateRef = useRef(WebSocket.CLOSED)
  const roomJoinedRef = useRef(false)
  function isMultiplayerMode() {
    return wsReadyStateRef.current === WebSocket.OPEN && roomJoinedRef.current === true
  }

  // ─── Multiplayer WS message handler ─────────────────────────────────────────
  // Called by useWebSocket for every inbound message. Routes events to the correct
  // state setters. All MP strings are applied as React state (text nodes in render)
  // — never via dangerouslySetInnerHTML.
  const handleWsMessage = useCallback(({ type, payload }) => {
    try {
      if (type === 'session:update') {
        // Incremental server broadcast: route through the dual-authority adopt
        // gate in useSessionPersistence (turnSequence OR savedAt check, MC-6).
        // onSessionUpdateRef is wired after both hooks mount (below).
        onSessionUpdateRef.current?.(payload)
        // Phase 5: track server phase for combat HUD + input gating.
        if (payload?.phase) {
          setServerPhase(payload.phase)
        }
        // If the server phase returns to a resting phase, loading is done.
        if (payload?.phase && payload.phase !== 'awaiting-dm' && payload.phase !== 'resolving') {
          setIsLoading(false)
        }
      } else if (type === 'dm:delta') {
        // Streaming DM chunk: accumulate into the assistant message by assistantId.
        const { delta, assistantId } = payload ?? {}
        if (typeof delta === 'string' && delta && assistantId) {
          setIsLoading(true)
          setMessages(prev => {
            // Find the message by assistantId or the last assistant message being built.
            const idx = prev.findIndex(m => m.id === assistantId)
            if (idx !== -1) {
              const updated = [...prev]
              const current = updated[idx]
              const newContent = (current.content || '') + delta
              updated[idx] = { ...current, content: stripStructuredBlocks(newContent) }
              return updated
            }
            // Message not yet added — append a new streaming assistant message.
            return [...prev, { role: 'assistant', content: stripStructuredBlocks(delta), id: assistantId }]
          })
        }
      } else if (type === 'dm:done') {
        // DM stream complete. Apply structured blocks from fullText, finalize loading.
        const { fullText, error, partial } = payload ?? {}
        const text = fullText || partial || ''
        if (error) {
          // Show error on the last assistant message.
          setMessages(prev => {
            const last = [...prev].reverse().find(m => m.role === 'assistant')
            if (!last) return prev
            return prev.map(m =>
              m.id === last.id
                ? { ...m, content: `*The DM's voice fades into silence...*\n\n**Error:** The DM encountered an error.`, error: true }
                : m
            )
          })
        } else {
          // Apply structured blocks from the full text.
          applyStructuredBlocks(text)
        }
        setIsLoading(false)
      } else if (type === 'presence:update') {
        // Update presence list (array of { displayName, status }).
        // All displayName strings are stored in state and rendered as React text nodes.
        if (Array.isArray(payload)) {
          setPresence(payload)
        }
      } else if (type === 'error') {
        // Server-sent error (DM_BUSY, NOT_YOUR_TURN, etc.). Show feedback.
        // Input is re-enabled by the subsequent session:update phase change.
        const code = payload?.code
        if (code === 'DM_BUSY') {
          // DM is busy — user tried to send while a turn was in progress.
          // isLoading stays true; the server will send session:update when done.
        }
        // Other errors (NAME_TAKEN, RATE_LIMITED) are surfaced in the server's join
        // flow — they arrive before roomJoined is set so they don't reach here in practice.
      }
    } catch {
      // Never let a WS message handler crash the component.
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Multiplayer session:state handler ──────────────────────────────────────
  // Wired to useWebSocket's onSessionState. Called on join/rejoin with the full
  // server snapshot. Sets roomJoined=true (flips isMultiplayerMode to true).
  const handleSessionState = useCallback((payload) => {
    try {
      roomJoinedRef.current = true
      wsReadyStateRef.current = WebSocket.OPEN
      // Apply the full snapshot (messages, party) via the session persistence hook.
      onSessionStateRef.current?.(payload)
      // Phase 5: restore server phase from session:state (MC-7 sentinel reset).
      if (payload?.phase) {
        setServerPhase(payload.phase)
      }
      // Also update local presence if the snapshot contains connections.
      // (presence:update follows immediately from the server anyway)
    } catch {
      // defensive
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refs so handleWsMessage can call session persistence callbacks without
  // stale closures or circular dependency (the WS handler is created before
  // the persistence hook runs, so we wire via refs updated after both mount).
  const onSessionStateRef = useRef(null)
  const onSessionUpdateRef = useRef(null)

  // Phase 4: `isMultiplayer` is true only when both roomCode and displayName are
  // set (the user actively joined or hosted a room). When false (single-player
  // default), `enabled=false` is passed to useWebSocket so it is a complete noop:
  // no WebSocket object is ever created, readyState stays CLOSED.
  // ABSOLUTE CONSTRAINT: single-player default — no WS opened, isMultiplayerMode()
  // always false — is enforced by enabled=false alone. The hook is ALWAYS called
  // (hooks must not be conditional), but it does nothing when disabled.
  const isMultiplayer = !!(roomCode && displayName)

  // mp-character-sync: derive the static SyncedCharacter subset from the full local
  // character. Only the fields defined in the locked contract are forwarded; all
  // other local fields (hpCurrent, initiative, speed, conditions) stay local.
  // When the character prop is absent/null, joinCharacter is null and the server
  // will use DEFAULT_CHARACTER.
  const joinCharacter = character
    ? {
        name: character.name ?? 'Adventurer',
        race: character.race ?? 'Human',
        charClass: character.charClass ?? 'Fighter',
        abilities: character.abilities
          ? {
              STR: character.abilities.STR ?? 10,
              DEX: character.abilities.DEX ?? 10,
              CON: character.abilities.CON ?? 10,
              INT: character.abilities.INT ?? 10,
              WIS: character.abilities.WIS ?? 10,
              CHA: character.abilities.CHA ?? 10,
            }
          : { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        ac: character.ac ?? 10,
        hpMax: character.hpMax ?? 10,
      }
    : null

  const { readyState: wsReadyState, send: wsSend, shouldPoll } = useWebSocket({
    roomCode: roomCode ?? '',
    sessionId: campaign.sessionId,
    displayName: displayName ?? '',
    joinCharacter: isMultiplayer ? joinCharacter : null,
    onMessage: handleWsMessage,
    onSessionState: handleSessionState,
    enabled: isMultiplayer,
  })

  // Keep wsReadyStateRef in sync with the hook's readyState so isMultiplayerMode()
  // always reflects the actual socket state.
  useEffect(() => {
    wsReadyStateRef.current = wsReadyState
    if (wsReadyState !== WebSocket.OPEN) {
      // On close/disconnect, reset roomJoined so isMultiplayerMode() flips false
      // synchronously — the mode boundary invariant (§3.7).
      roomJoinedRef.current = false
    }
  }, [wsReadyState])

  // Phase B: LAN sync layer (server-authoritative when reachable; silent no-op
  // when the sync server is down — localStorage above remains the offline mirror).
  const { onNewSession, onSessionState, onSessionUpdate } = useSessionPersistence({
    campaign, messages, setMessages, sessionLog, setSessionLog, party, setParty, isLoading,
    socketConnected: isMultiplayer && wsReadyState === WebSocket.OPEN,
    // D-01: thread characters + roomCode into the push payload so a SP-with-sync PUT
    // does not strip them. In SP (roomCode=null), characters is {} (server-authoritative
    // in MP; client never holds the full map as local React state).
    characters: {}, // characters are server-authoritative; the client doesn't hold them
    roomCode: roomCode ?? null,
  })

  // Wire the session persistence callbacks to the WS handler via refs so the
  // WS message handler can call them without circular dependency.
  onSessionStateRef.current = onSessionState
  onSessionUpdateRef.current = onSessionUpdate

  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Phase A: persist once per settled turn — NOT per stream delta (perf MUST-FIX).
  // Gated on !isLoading so the 30–80 setMessages/sec during streaming write nothing;
  // when a turn ends, isLoading flips false in the SAME commit as the final
  // messages/party update, so this runs exactly once with complete state.
  // try/catch handles QuotaExceededError by trimming the oldest messages and retrying.
  useEffect(() => {
    if (isLoading) return
    const persist = msgs => {
      const payload = serializeSession({ campaign, messages: msgs, sessionLog, party })
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload))
    }
    try {
      persist(messages)
    } catch (err) {
      if (err?.name === 'QuotaExceededError') {
        try {
          // Drop the oldest third and retry once; better a trimmed log than none.
          persist(messages.slice(Math.floor(messages.length / 3)))
        } catch {
          // give up silently — the in-memory session is still intact
        }
      }
    }
  }, [isLoading, messages, sessionLog, party, campaign])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }, [input])

  useEffect(() => {
    if (!isLoading) textareaRef.current?.focus()
  }, [isLoading])

  // Phase 4: pass per-player character data to the DM prompt so it can reference
  // stats, HP, and AC. Build a characters-map from the local `character` prop
  // (the static synced subset keyed by the character's own name), then derive
  // the PlayerEntry[] with live HP from the current party array.
  // When character is absent or party is empty, players=[] → prompt unchanged.
  const localCharactersMap = character
    ? { [character.name ?? 'Adventurer']: {
        name: character.name ?? 'Adventurer',
        race: character.race ?? 'Human',
        charClass: character.charClass ?? 'Fighter',
        abilities: character.abilities ?? { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        ac: character.ac ?? 10,
        hpMax: character.hpMax ?? 10,
      } }
    : {}
  const players = buildPlayersForPrompt(localCharactersMap, party)
  const systemPrompt = buildSystemPrompt({ ...campaign, players })

  // ─── Post-stream structured-block apply ─────────────────────────────────────
  // Shared by both the single-player finally block and the multiplayer dm:done handler.
  function applyStructuredBlocks(fullText) {
    // 1. party — always applied when present and non-empty
    const partyRaw = extractBlock('party', fullText)
    if (partyRaw && Array.isArray(partyRaw) && partyRaw.length > 0) {
      setParty(prev => {
        const next = applyPartyUpdate(partyRaw, prev)
        localStorage.setItem('dnd_party', JSON.stringify(next))
        return next
      })
    }

    // 2. check — store as pendingCheck; cleared when roll is sent to LLM
    const checkRaw = extractBlock('check', fullText)
    if (checkRaw?.skill && checkRaw?.dc != null) {
      setPendingCheck({
        skill: String(checkRaw.skill).toUpperCase(),
        dc: Number(checkRaw.dc),
      })
    }

    // 3. verdict — find the most-recent dice message with no verdict and upgrade it
    const verdictRaw = extractBlock('verdict', fullText)
    if (verdictRaw?.result === 'PASS' || verdictRaw?.result === 'FAIL') {
      setMessages(prev => {
        const idx = [...prev]
          .map((m, i) => ({ m, i }))
          .reverse()
          .find(({ m }) => m.role === 'dice' && m.verdict == null && !m.orphaned)?.i
        if (idx == null) return prev
        return prev.map((m, i) =>
          i === idx
            ? { ...m, check: verdictRaw.skill, verdict: verdictRaw.result }
            : m
        )
      })
    }
  }

  async function sendMessage(text) {
    const trimmed = text.trim()
    if (!trimmed || isLoading) return

    // ─── Multiplayer branch (§3.2 / §3.7) — LIVE in Phase 4 ────────────────────
    // In multiplayer mode the client NEVER calls Ollama directly. It sends the
    // action over the WebSocket; the server runs the single DM trigger and drives
    // isLoading + message accumulation via dm:delta / dm:done broadcasts.
    // isMultiplayerMode() is true only after the first session:state — see §3.7.
    if (isMultiplayerMode()) {
      const rc = roomCode || campaign.roomCode
      wsSend({
        type: 'action',
        roomCode: rc,
        payload: { content: trimmed, type: 'user', pendingCheck: pendingCheck ?? null },
        // displayName intentionally omitted — server uses connection-bound identity.
      })
      setInput('')
      // No local isLoading toggle / Ollama fetch here — dm:delta/dm:done from the
      // server drive loading + accumulation uniformly across all clients.
      return
    }

    const userMsg = { role: 'user', content: trimmed }
    // Find index of the most recent dice message so we can fold pendingCheck into it.
    const lastDiceIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'dice') return i
      }
      return -1
    })()

    // Serialize messages for the LLM. The most-recent dice roll carries pendingCheck
    // context so the LLM can judge the roll against the DC.
    const apiMessages = trimContext([
      ...messages.map((m, i) => {
        if (m.role !== 'dice') return m
        const checkCtx =
          i === lastDiceIdx && pendingCheck
            ? ` | pending check: ${pendingCheck.skill} DC ${pendingCheck.dc}`
            : ''
        return { role: 'user', content: `[Dice roll: ${m.die} → ${m.result}${checkCtx}]` }
      }),
      userMsg,
    ])

    const entities = extractEntities(messages)
    const systemContent = entities.length
      ? `${systemPrompt}\n\n---\nEstablished entities so far (stay consistent with these named NPCs, locations, and items): ${entities.join(', ')}.`
      : systemPrompt

    const assistantId = crypto.randomUUID()
    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '', id: assistantId }])
    setInput('')
    setIsLoading(true)
    // Clear pendingCheck after the message is queued — the check context was folded
    // into the dice line above; clearing now ensures the next roll starts fresh.
    if (pendingCheck) setPendingCheck(null)

    // Log the user action to session log
    setSessionLog(prev => [
      ...prev,
      {
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: trimmed.slice(0, 60),
      },
    ])

    // Hoist fullText so the finally block can read it for structured-block extraction.
    let fullText = ''

    try {
      const ollamaHost = getLanHost(11434)
      const response = await fetch(`http://${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: campaign.model || 'qwen2.5:14b',
          stream: true,
          messages: [
            { role: 'system', content: systemContent },
            ...apiMessages,
          ],
          options: {
            num_ctx: 8192,
            num_predict: 900,
            temperature: 0.8,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.15,
            repeat_last_n: 256,
          },
        }),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Ollama ${response.status}: ${body}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // keep the trailing incomplete line for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            const delta = event.message?.content
            if (delta) {
              fullText += delta
              // Strip structured blocks before display — they must never appear in the bubble.
              // Unclosed fences mid-stream pass through harmlessly (lazy regex requires closing ```).
              const displayText = stripStructuredBlocks(fullText)
              setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: displayText } : m))
            }
          } catch {
            // incomplete JSON chunk — skip
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === assistantId ? {
        ...m,
        content: `*The DM's voice fades into silence...*\n\n**Error:** ${err.message}`,
        error: true,
      } : m))
    } finally {
      setIsLoading(false)

      // ── Post-stream structured-block apply (all three tags, in order) ──────
      // fullText holds the raw LLM output including any structured fences.
      // Each extractBlock call is defensive: returns null on missing/malformed.
      applyStructuredBlocks(fullText)

      // Update entities after streaming completes
      setMessages(prev => {
        setEntities(extractEntities(prev))
        return prev
      })
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  function handleDiceRoll(die, result) {
    setMessages(prev => [...prev, { role: 'dice', die, result }])
  }

  // Phase A2: download the current session as a self-contained Markdown handoff
  // (prose DM brief + lossless ```session block). pendingCheck is session-only —
  // passed so it shows as a prose line for an LLM reading the file, never machine-stored.
  function handleSaveSession() {
    const payload = serializeSession({ campaign, messages, sessionLog, party })
    const md = toMarkdown(payload, pendingCheck)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = sessionFileName(campaign, payload.savedAt)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function handleNewSession() {
    if (messages.length === 0 || window.confirm('Start a new session? The current conversation will be cleared.')) {
      setMessages([])
      setEntities([])
      setSessionLog([])
      setPendingCheck(null)
      localStorage.removeItem(SESSION_KEY)
      onNewSession() // DELETE the server copy + guard against an in-flight poll resurrecting it
    }
  }

  // Phase 4: derive the computed room code for sharing (host display).
  // The room code shown is the one passed from App, or derived from sessionId.
  const sharedRoomCode = roomCode || makeRoomCode(campaign.sessionId)

  // Find last assistant message index for action suggestions
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  // Phase C: derive active member from LLM-owned party state (desktop turn-pill)
  const activeMember = party.find(m => m.isActive) ?? party[0]

  // Phase 5: combat turn gating.
  // myDisplayName is the connection-bound identity; it drives the turn check.
  // Single-player: isMultiplayer is false → myTurn stays true (input always enabled).
  // Multiplayer free-roam: phase !== 'combat' → myTurn is true.
  // Multiplayer combat: myTurn is true only if this player's name matches isActive member.
  const myDisplayName = isMultiplayer ? (displayName ?? '') : ''
  const myTurn = !isMultiplayer || serverPhase !== 'combat' || isActiveTurn(myDisplayName, party)

  // Input is disabled when:
  //   (a) local isLoading (streaming in progress — both single-player and MP)
  //   (b) multiplayer phase is awaiting-dm / resolving (whole-room lock)
  //   (c) multiplayer combat and it's not this player's turn
  const inputBusy = isLoading ||
    (isMultiplayer && (serverPhase === 'awaiting-dm' || serverPhase === 'resolving'))
  const inputDisabled = inputBusy || (isMultiplayer && !myTurn)

  // Placeholder text: shows the active player's name when it's not our turn in combat.
  const activeName = party.find(m => m.isActive)?.name ?? ''
  const inputPlaceholder = isMultiplayer && serverPhase === 'combat' && !myTurn
    ? `Waiting for ${activeName}'s action…`
    : genre.inputPlaceholder

  return (
    <div
      className="app-layout"
      style={{
        '--history-width': showHistory ? 'var(--panel-width)' : '0px',
        '--char-width': showCharacter ? 'var(--panel-width)' : '0px',
      }}
    >
      <HistoryPanel
        entities={entities}
        sessionLog={sessionLog}
        isOpen={showHistory}
        onToggle={() => setShowHistory(s => !s)}
        party={party}
        phase={serverPhase}
      />

      <div className="chat-container">
        <header className="chat-header">
          <div className="header-left">
            {/* Phase C: live-status dot — desktop-only (hidden on mobile via CSS) */}
            <span className="header-status-dot" aria-hidden="true" />
            <span className="header-emblem">{genre.emblem}</span>
            <div className="header-title">
              <span className="campaign-name">{campaign.name || genre.headerDefaultName}</span>
              <span className="header-subtitle">{genre.headerSubtitle}</span>
            </div>
          </div>
          <div className="header-actions">
            {/* Phase 4: multiplayer presence pill — shown when in multiplayer mode */}
            {isMultiplayer && (
              <div className="mp-presence" aria-label="Connected players">
                {presence.length > 0
                  ? presence.map(p => (
                      <span
                        key={p.displayName}
                        className={`mp-player-chip mp-player-chip--${p.status === 'connected' ? 'connected' : 'disconnected'}`}
                        title={p.status === 'connected' ? 'Connected' : 'Disconnected'}
                      >
                        {/* XSS safe: all strings are React text nodes, never innerHTML */}
                        <span
                          className="mp-status-dot"
                          aria-hidden="true"
                        />
                        {p.displayName}
                      </span>
                    ))
                  : null}
              </div>
            )}
            {/* Phase 4: room code sharing affordance (shown when multiplayer) */}
            {isMultiplayer && (
              <div className="room-code-display" title="Share this room code with other players">
                <span className="room-code-label">Room: </span>
                <span className="room-code-value">{sharedRoomCode}</span>
              </div>
            )}
            {/* Phase C: turn-pill — desktop-only (hidden on mobile via CSS) */}
            {activeMember && (
              <div className="turn-pill" aria-label={`${activeMember.name}'s turn`}>
                <span className="turn-pill-dot" aria-hidden="true" />
                {activeMember.name}&apos;s turn
              </div>
            )}
            <button
              className={`icon-btn ${showHistory ? 'active' : ''}`}
              onClick={() => setShowHistory(s => !s)}
              title="Campaign History"
            >
              📜
            </button>
            <button
              className={`icon-btn ${showDice ? 'active' : ''}`}
              onClick={() => setShowDice(s => !s)}
              title="Dice Roller"
            >
              🎲
            </button>
            <button
              className={`icon-btn ${showCharacter ? 'active' : ''}`}
              onClick={() => setShowCharacter(s => !s)}
              title="Character Sheet"
            >
              🧙
            </button>
            <button
              className="icon-btn"
              onClick={handleSaveSession}
              disabled={messages.length === 0}
              title="Save session (.md)"
            >
              💾
            </button>
            <button className="icon-btn" onClick={handleNewSession} title="New Session">
              🗑
            </button>
            <button className="icon-btn" onClick={onReset} title="Campaign Settings">
              ⚙
            </button>
          </div>
        </header>

        {/* Phase B: mobile-only party strip — visibility controlled by CSS media query */}
        {/* Phase 5: pass phase so PartyStrip can dim inactive cells in combat */}
        <PartyStrip party={party} phase={serverPhase} />

        {showDice && <DiceRoller onRoll={handleDiceRoll} />}

        <main className="messages-container">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-emblem">{genre.emptyEmblem}</div>
              <h2>{genre.emptyTitle}</h2>
              <p>{genre.emptySubtitle}</p>
              {/* Phase 4: show room code in the empty state when multiplayer */}
              {isMultiplayer && (
                <p className="mp-share-hint">
                  Share room code <strong>{sharedRoomCode}</strong> with your players.
                </p>
              )}
              <div className="starter-prompts">
                {genre.starterPrompts.map(prompt => (
                  <button key={prompt} className="starter-btn" onClick={() => sendMessage(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            if (msg.role === 'dice') {
              // Phase D: DiceChip replaces the old inline dice-result div.
              // Bare state {die, result} renders the chip without check/verdict.
              // Resolved state {die, result, check, verdict} renders the full chip.
              return (
                <DiceChip
                  key={i}
                  die={msg.die}
                  result={msg.result}
                  check={msg.check}
                  verdict={msg.verdict}
                />
              )
            }

            if (msg.role === 'user') {
              // Phase 4: player messages are labeled with the sender's displayName
              // when available. The label is rendered as a React text node — never
              // dangerouslySetInnerHTML (XSS guard, security item B).
              const senderLabel = msg.senderName || (displayName && isMultiplayer ? displayName : 'Player')
              return (
                <div key={i} className="message player-message">
                  <div className="message-header">
                    <span className="message-label">{senderLabel}</span>
                    <span className="message-avatar">⚔</span>
                  </div>
                  <div className="message-bubble">{msg.content}</div>
                </div>
              )
            }

            if (msg.role === 'assistant') {
              const isLast = i === messages.length - 1
              const isEmpty = msg.content === ''
              const isLastAssistant = i === lastAssistantIndex
              const showSuggestions = isLastAssistant && !isLoading && msg.content.length > 0 && !msg.error

              return (
                <div key={i} className={`message dm-message ${msg.error ? 'error' : ''}`}>
                  <div className="message-header">
                    <span className="message-avatar">{genre.gmAvatar}</span>
                    <span className="message-label dm-label">{genre.gmName}</span>
                  </div>
                  <div className="message-bubble dm-bubble">
                    {isEmpty && isLast && isLoading ? (
                      <span className="typing-dots"><span /><span /><span /></span>
                    ) : (
                      <>
                        <div
                          className="message-content"
                          dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.content) }}
                        />
                        {isLast && isLoading && !isEmpty && (
                          <span className="cursor-blink">▋</span>
                        )}
                      </>
                    )}
                  </div>
                  {showSuggestions && (
                    <div className="action-suggestions">
                      {genre.getActionSuggestions(msg.content).map(action => (
                        <button
                          key={action}
                          className="action-btn"
                          onClick={() => sendMessage(action)}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            }

            return null
          })}

          <div ref={messagesEndRef} />
        </main>

        <footer className="input-area">
          <textarea
            ref={textareaRef}
            className="message-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            rows={1}
            disabled={inputDisabled}
          />
          <button
            className="send-btn"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || inputDisabled}
            title="Send (Enter)"
          >
            ➤
          </button>
        </footer>
      </div>

      <CharacterPanel
        character={character}
        setCharacter={setCharacter}
        isOpen={showCharacter}
        onToggle={() => setShowCharacter(s => !s)}
      />
    </div>
  )
}
