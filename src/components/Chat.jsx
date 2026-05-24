import { useState, useRef, useEffect } from 'react'
import DiceRoller from './DiceRoller'
import HistoryPanel from './HistoryPanel'
import CharacterPanel from './CharacterPanel'
import { getGenre } from '../lib/genres'

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

  return html || '<p></p>'
}

export default function Chat({ campaign, onReset, character, setCharacter }) {
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

  const systemPrompt = buildSystemPrompt(campaign)

  async function sendMessage(text) {
    const trimmed = text.trim()
    if (!trimmed || isLoading) return

    const userMsg = { role: 'user', content: trimmed }
    const apiMessages = trimContext([
      ...messages.map(m =>
        m.role === 'dice'
          ? { role: 'user', content: `[Dice roll: ${m.die} → ${m.result}]` }
          : m
      ),
      userMsg,
    ])

    const entities = extractEntities(messages)
    const systemContent = entities.length
      ? `${systemPrompt}\n\n---\nEstablished entities so far (stay consistent with these named NPCs, locations, and items): ${entities.join(', ')}.`
      : systemPrompt

    setMessages(prev => [...prev, userMsg, { role: 'assistant', content: '' }])
    setInput('')
    setIsLoading(true)

    // Log the user action to session log
    setSessionLog(prev => [
      ...prev,
      {
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: trimmed.slice(0, 60),
      },
    ])

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
      let fullText = ''
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
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = { role: 'assistant', content: fullText }
                return updated
              })
            }
          } catch {
            // incomplete JSON chunk — skip
          }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `*The DM's voice fades into silence...*\n\n**Error:** ${err.message}`,
          error: true,
        }
        return updated
      })
    } finally {
      setIsLoading(false)
      textareaRef.current?.focus()
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
    <div className="app-layout">
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
              const showSuggestions = isLastAssistant && !isLoading && msg.content.length > 0

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
