import { useState, useRef, useEffect } from 'react'
import DiceRoller from './DiceRoller'
import HistoryPanel from './HistoryPanel'
import CharacterPanel from './CharacterPanel'
import PartyStrip from './PartyStrip'
import DiceChip from './DiceChip'
import { getGenre } from '../lib/genres'
import { serializeSession, deserializeSession, getLanHost, toMarkdown, sessionFileName, markOrphanedDice, applyPartyUpdate } from '../lib/session'
import { useSessionPersistence } from '../hooks/useSessionPersistence'

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

export default function Chat({ campaign, onReset, character, setCharacter, party, setParty }) {
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

  // Phase B: LAN sync layer (server-authoritative when reachable; silent no-op
  // when the sync server is down — localStorage above remains the offline mirror).
  const { onNewSession } = useSessionPersistence({
    campaign, messages, setMessages, sessionLog, setSessionLog, party, setParty, isLoading,
  })
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

  const systemPrompt = buildSystemPrompt(campaign)

  async function sendMessage(text) {
    const trimmed = text.trim()
    if (!trimmed || isLoading) return

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

  // Find last assistant message index for action suggestions
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  // Phase C: derive active member from LLM-owned party state (desktop turn-pill)
  const activeMember = party.find(m => m.isActive) ?? party[0]

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
        <PartyStrip party={party} />

        {showDice && <DiceRoller onRoll={handleDiceRoll} />}

        <main className="messages-container">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="empty-emblem">{genre.emptyEmblem}</div>
              <h2>{genre.emptyTitle}</h2>
              <p>{genre.emptySubtitle}</p>
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
              return (
                <div key={i} className="message player-message">
                  <div className="message-header">
                    <span className="message-label">Player</span>
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
            placeholder={genre.inputPlaceholder}
            rows={1}
            disabled={isLoading}
          />
          <button
            className="send-btn"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isLoading}
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
