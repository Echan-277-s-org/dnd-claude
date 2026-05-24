import { useState, useRef } from 'react'

const OLLAMA_MODELS = [
  { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B — Fast & capable (recommended)' },
  { value: 'qwen2.5:32b', label: 'Qwen 2.5 32B — Richer narration, slower' },
]

export default function CampaignSetup({ onSetup }) {
  const [name, setName] = useState('')
  const [details, setDetails] = useState('')
  const [model, setModel] = useState('qwen2.5:14b')
  const [context, setContext] = useState('')
  const [contextFileName, setContextFileName] = useState('')
  const fileInputRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setContext(ev.target.result)
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
    onSetup({ name: name.trim(), details: details.trim(), model, context })
  }

  return (
    <div className="setup-container">
      <div className="setup-card">
        <div className="setup-header">
          <div className="setup-emblem">⚔</div>
          <h1>D&D Campaign Assistant</h1>
          <p className="setup-subtitle">Your AI Dungeon Master — Powered by Ollama</p>
        </div>

        <form onSubmit={handleSubmit} className="setup-form">
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
              placeholder="The Lost Mine of Phandelver..."
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
              placeholder="Forgotten Realms, 4 players at level 3, dark and gritty tone, house rules: flanking enabled..."
              rows={3}
            />
            <span className="form-hint">
              Setting, party composition, tone, house rules — the DM will use this as context.
            </span>
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
              Load a Markdown file with session notes, NPC lists, or previous events to continue an existing campaign.
            </span>
          </div>

          <button type="submit" className="btn-begin">
            <span>⚔</span> Begin the Campaign
          </button>
        </form>
      </div>
    </div>
  )
}
