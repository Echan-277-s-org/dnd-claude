import { useState, useRef } from 'react'
import { GENRES, getGenre } from '../lib/genres'
import { fromMarkdown } from '../lib/session'

const OLLAMA_MODELS = [
  { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B — Fast & capable (recommended)' },
  { value: 'qwen2.5:32b', label: 'Qwen 2.5 32B — Richer narration, slower' },
]

export default function CampaignSetup({ onSetup, onGenreChange, onRestoreSession }) {
  const [genreId, setGenreId] = useState(() => localStorage.getItem('dnd_genre') || 'dnd')
  const [name, setName] = useState(() => localStorage.getItem('dnd_campaign_name') || '')
  const [details, setDetails] = useState(() => localStorage.getItem('dnd_campaign_details') || '')
  const [model, setModel] = useState(() => localStorage.getItem('dnd_model') || 'qwen2.5:14b')
  const [context, setContext] = useState(() => localStorage.getItem('dnd_campaign_context') || '')
  const [contextFileName, setContextFileName] = useState('')
  const fileInputRef = useRef(null)

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
    onSetup({ genre: genreId, name: name.trim(), details: details.trim(), model, context })
  }

  return (
    <div className="setup-container">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-emblem">{genre.emblem}</div>
          <h1>{genre.appTitle}</h1>
          <p className="setup-subtitle">{genre.setupSubtitle}</p>
        </div>

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

          <button type="submit" className="btn-begin">
            <span>{genre.emblem}</span> {genre.beginLabel}
          </button>
        </form>
      </div>
    </div>
  )
}
