import { useState, useRef, useEffect } from 'react'
import DiceRoller from './DiceRoller'
import HistoryPanel from './HistoryPanel'
import CharacterPanel from './CharacterPanel'
import { getGenre } from '../lib/genres'

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

// Reconcile incoming LLM party data with existing IDs so React keys stay stable.
// Matches by normalized (lowercased/trimmed) name. New members get a UUID.
// Guards every field defensively; zero-member arrays must be rejected BEFORE calling.
function applyPartyUpdate(rawArray, existing) {
  return rawArray.map(raw => {
    const normalizedName = String(raw.name ?? '').trim().toLowerCase()
    const found = existing.find(
      e => e.name.trim().toLowerCase() === normalizedName
    )
    return {
      id: found?.id ?? crypto.randomUUID(),
      name: String(raw.name ?? '').trim() || 'Unknown',
      role: String(raw.role ?? '').trim() || '',
      hpPct: Math.max(0, Math.min(100, Math.round(Number(raw.hpPct) || 0))),
      isActive: Boolean(raw.isActive),
    }
  })
}

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
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [showDice, setShowDice] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showCharacter, setShowCharacter] = useState(false)
  const [entities, setEntities] = useState([])
  const [sessionLog, setSessionLog] = useState([])
  // pendingCheck is session-only (not persisted). Cleared when the roll is sent or on new session.
  const [pendingCheck, setPendingCheck] = useState(null)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
      const ollamaHost = `${window.location.hostname}:11434`
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
            .find(({ m }) => m.role === 'dice' && m.verdict == null)?.i
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

  function handleNewSession() {
    if (messages.length === 0 || window.confirm('Start a new session? The current conversation will be cleared.')) {
      setMessages([])
      setEntities([])
      setSessionLog([])
      setPendingCheck(null)
    }
  }

  // Find last assistant message index for action suggestions
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

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
      />

      <div className="chat-container">
        <header className="chat-header">
          <div className="header-left">
            <span className="header-emblem">{genre.emblem}</span>
            <div className="header-title">
              <span className="campaign-name">{campaign.name || genre.headerDefaultName}</span>
              <span className="header-subtitle">{genre.headerSubtitle}</span>
            </div>
          </div>
          <div className="header-actions">
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
            <button className="icon-btn" onClick={handleNewSession} title="New Session">
              🗑
            </button>
            <button className="icon-btn" onClick={onReset} title="Campaign Settings">
              ⚙
            </button>
          </div>
        </header>

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
              const isCrit = msg.die === 'd20' && msg.result === 20
              const isFumble = msg.die === 'd20' && msg.result === 1
              return (
                <div
                  key={i}
                  className={`dice-result ${isCrit ? 'crit' : ''} ${isFumble ? 'fumble' : ''}`}
                >
                  <span className="dice-result-icon">🎲</span>
                  <span>
                    {msg.die} → <strong>{msg.result}</strong>
                    {isCrit && ' — Critical Hit!'}
                    {isFumble && ' — Critical Fail!'}
                  </span>
                </div>
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
