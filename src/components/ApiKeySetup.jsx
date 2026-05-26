import { useState, useRef, useEffect } from 'react'
import { GENRES, getGenre } from '../lib/genres'
import { fromMarkdown, getLanHost } from '../lib/session'

const OLLAMA_MODELS = [
  { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B — Fast & capable (recommended)' },
  { value: 'qwen2.5:32b', label: 'Qwen 2.5 32B — Richer narration, slower' },
]

// Resolve sessionId for a given roomCode by querying GET /sessions from the sync
// server. Returns the matching sessionId string, or null if not found / server down.
async function resolveSessionId(roomCode) {
  if (!roomCode) return null
  try {
    const host = getLanHost(3001)
    const resp = await fetch(`http://${host}/sessions`)
    if (!resp.ok) return null
    const list = await resp.json()
    if (!Array.isArray(list)) return null
    // The server stores roomCode in the payload — match against the roomCode field.
    // Fallback: compare makeRoomCode(sessionId) client-side if roomCode field missing.
    const found = list.find(s => {
      if (s.roomCode && s.roomCode === roomCode) return true
      // Derive roomCode from sessionId (same formula as makeRoomCode) as a fallback.
      if (s.sessionId) {
        const derived = 'dnd-' + String(s.sessionId).replace(/-/g, '').slice(0, 8)
        return derived === roomCode
      }
      return false
    })
    return found?.sessionId ?? null
  } catch {
    return null
  }
}

export default function CampaignSetup({ onSetup, onJoin, onGenreChange, onRestoreSession, urlRoomCode }) {
  const [genreId, setGenreId] = useState(() => localStorage.getItem('dnd_genre') || 'dnd')
  const [name, setName] = useState(() => localStorage.getItem('dnd_campaign_name') || '')
  const [details, setDetails] = useState(() => localStorage.getItem('dnd_campaign_details') || '')
  const [model, setModel] = useState(() => localStorage.getItem('dnd_model') || 'qwen2.5:14b')
  const [context, setContext] = useState(() => localStorage.getItem('dnd_campaign_context') || '')
  const [contextFileName, setContextFileName] = useState('')
  // Phase 4 — multiplayer: optional display name for hosting
  const [hostDisplayName, setHostDisplayName] = useState('')
  // Phase 4 — multiplayer: join existing session sub-flow
  // When urlRoomCode is present, default to the join tab.
  const [tab, setTab] = useState(() => urlRoomCode ? 'join' : 'create')
  const [joinRoomCode, setJoinRoomCode] = useState(() => urlRoomCode || '')
  const [joinDisplayName, setJoinDisplayName] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joinLoading, setJoinLoading] = useState(false)
  const fileInputRef = useRef(null)

  // Prefill room code from URL param whenever it changes (first render only).
  useEffect(() => {
    if (urlRoomCode) setJoinRoomCode(urlRoomCode)
  }, [urlRoomCode])

  const genre = getGenre(genreId)

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target.result
      // A session file (contains a ```session block) → full restore, boot into play.
      // Anything else → today's behavior: load the prose as campaign context.
      const payload = fromMarkdown(text)
      if (payload && onRestoreSession) {
        onRestoreSession(payload)
        return
      }
      setContext(text)
      setContextFileName(file.name)
    }
    reader.readAsText(file)
  }

  function clearFile() {
    setContext('')
    setContextFileName('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSetup({
      genre: genreId,
      name: name.trim(),
      details: details.trim(),
      model,
      context,
      displayName: hostDisplayName.trim() || null,
    })
  }

  async function handleJoinSubmit(e) {
    e.preventDefault()
    const rc = joinRoomCode.trim()
    const dn = joinDisplayName.trim()
    if (!rc) { setJoinError('Room code is required.'); return }
    if (!dn) { setJoinError('Display name is required.'); return }
    setJoinError('')
    setJoinLoading(true)
    try {
      // Resolve roomCode → sessionId via the sync server. Graceful fallback:
      // if the server is unreachable, pass null and let the WS server reject/handle it.
      const sessionId = await resolveSessionId(rc)
      await onJoin({ roomCode: rc, displayName: dn, sessionId })
    } catch {
      setJoinError('Failed to join. Check the room code and try again.')
    } finally {
      setJoinLoading(false)
    }
  }

  return (
    <div className="setup-container">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-emblem">{genre.emblem}</div>
          <h1>{genre.appTitle}</h1>
          <p className="setup-subtitle">{genre.setupSubtitle}</p>
        </div>

        {/* Phase 4: tab switcher — create new campaign vs join existing */}
        <div className="setup-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'create'}
            className={`setup-tab ${tab === 'create' ? 'active' : ''}`}
            onClick={() => setTab('create')}
            type="button"
          >
            New Campaign
          </button>
          <button
            role="tab"
            aria-selected={tab === 'join'}
            className={`setup-tab ${tab === 'join' ? 'active' : ''}`}
            onClick={() => setTab('join')}
            type="button"
          >
            Join Session
          </button>
        </div>

        {tab === 'join' ? (
          /* ── Join existing session ── */
          <form onSubmit={handleJoinSubmit} className="setup-form">
            <div className="form-group">
              <label htmlFor="join-room-code">Room Code</label>
              <input
                id="join-room-code"
                type="text"
                value={joinRoomCode}
                onChange={e => { setJoinRoomCode(e.target.value); setJoinError('') }}
                placeholder="dnd-a1b2c3d4"
                autoFocus={!urlRoomCode}
                autoComplete="off"
              />
              <span className="form-hint">
                Ask the session host for their room code.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="join-display-name">Your Name</label>
              <input
                id="join-display-name"
                type="text"
                value={joinDisplayName}
                onChange={e => { setJoinDisplayName(e.target.value); setJoinError('') }}
                placeholder="e.g. Thorin"
                autoFocus={!!urlRoomCode}
                autoComplete="off"
                maxLength={64}
              />
              <span className="form-hint">
                How your messages appear to other players. Max 64 characters.
              </span>
            </div>

            {joinError && (
              <p className="form-error" role="alert">{joinError}</p>
            )}

            <button type="submit" className="btn-begin" disabled={joinLoading}>
              {joinLoading ? 'Joining...' : 'Join Session'}
            </button>
          </form>
        ) : (
          /* ── Create new campaign ── */
          <form onSubmit={handleSubmit} className="setup-form">
            <div className="form-group">
              <label htmlFor="genre">Genre</label>
              <select
                id="genre"
                value={genreId}
                onChange={e => { setGenreId(e.target.value); onGenreChange?.(e.target.value) }}
              >
                {Object.values(GENRES).map(g => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
              <span className="form-hint">
                Sets the Game Master's ruleset, voice, and continuity tracking.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="model">AI Model</label>
              <select id="model" value={model} onChange={e => setModel(e.target.value)}>
                {OLLAMA_MODELS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <span className="form-hint">
                Runs locally via Ollama at localhost:11434 — no API key needed.
              </span>
            </div>

            <div className="form-divider">
              <span>Campaign Details</span>
            </div>

            <div className="form-group">
              <label htmlFor="campaign-name">
                Campaign Name <span className="optional">(optional)</span>
              </label>
              <input
                id="campaign-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={genre.namePlaceholder}
                autoFocus
              />
            </div>

            <div className="form-group">
              <label htmlFor="campaign-details">
                Setting &amp; Context <span className="optional">(optional)</span>
              </label>
              <textarea
                id="campaign-details"
                value={details}
                onChange={e => setDetails(e.target.value)}
                placeholder={genre.detailsPlaceholder}
                rows={3}
              />
              <span className="form-hint">{genre.detailsHint}</span>
            </div>

            <div className="form-group">
              <label>
                Campaign Notes <span className="optional">(optional)</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt"
                onChange={handleFile}
                style={{ display: 'none' }}
                id="context-file"
              />
              {contextFileName ? (
                <div className="file-loaded">
                  <span className="file-loaded-name">📄 {contextFileName}</span>
                  <button type="button" className="file-clear-btn" onClick={clearFile}>✕</button>
                </div>
              ) : (
                <label htmlFor="context-file" className="file-upload-btn">
                  Load .md file
                </label>
              )}
              <span className="form-hint">
                Load a Markdown file — world notes / NPC lists to seed context, or a saved session
                file (with a session block) to resume exactly where you left off.
              </span>
            </div>

            {/* Phase 4: optional display name to enter multiplayer mode as host */}
            <div className="form-divider">
              <span>Multiplayer (optional)</span>
            </div>
            <div className="form-group">
              <label htmlFor="host-display-name">
                Your Name <span className="optional">(leave blank for single-player)</span>
              </label>
              <input
                id="host-display-name"
                type="text"
                value={hostDisplayName}
                onChange={e => setHostDisplayName(e.target.value)}
                placeholder="e.g. DM, or your character name"
                autoComplete="off"
                maxLength={64}
              />
              <span className="form-hint">
                Enter a name to host a multiplayer session. Others can join with your room code.
                Leave blank to play solo.
              </span>
            </div>

            <button type="submit" className="btn-begin">
              <span>{genre.emblem}</span> {genre.beginLabel}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
