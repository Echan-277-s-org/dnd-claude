import { useState, useRef, useEffect } from 'react'
import { GENRES, getGenre } from '../lib/genres'
import { fromMarkdown, getLanHost, loadSyncSession, extractCharacterFromPayload } from '../lib/session'
import { buildCharacter } from '../lib/characterBuilder'
import CharacterWizard from './CharacterWizard'

const OLLAMA_MODELS = [
  { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B — Fast & capable (recommended)' },
  { value: 'qwen2.5:32b', label: 'Qwen 2.5 32B — Richer narration, slower' },
  { value: 'impish-qwen:14b', label: 'Impish Qwen 14B — RP-tuned, low-censorship' },
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

// Derive a SyncedCharacter from a full character object (as stored in localStorage).
// Returns the { name, race, charClass, abilities, ac, hpMax } subset.
function toSyncedSubset(char) {
  if (!char) return null
  return {
    name: char.name || 'Adventurer',
    race: char.race || 'Human',
    charClass: char.charClass || 'Fighter',
    abilities: {
      STR: Number(char.abilities?.STR) || 10,
      DEX: Number(char.abilities?.DEX) || 10,
      CON: Number(char.abilities?.CON) || 10,
      INT: Number(char.abilities?.INT) || 10,
      WIS: Number(char.abilities?.WIS) || 10,
      CHA: Number(char.abilities?.CHA) || 10,
    },
    ac: Number(char.ac) || 10,
    hpMax: Number(char.hpMax) || 10,
  }
}

// Load a character from localStorage (dnd_character). Returns null if absent.
function loadLocalCharacter() {
  try {
    const stored = localStorage.getItem('dnd_character')
    if (stored) return JSON.parse(stored)
  } catch {
    // ignore
  }
  return null
}

const ABILITY_LABELS = { STR: 'STR', DEX: 'DEX', CON: 'CON', INT: 'INT', WIS: 'WIS', CHA: 'CHA' }

// Compact read-only preview of a SyncedCharacter subset.
function CharacterPreview({ character, label }) {
  if (!character) return null
  const abilities = character.abilities || {}
  return (
    <div className="join-char-preview" aria-label={label || 'Character preview'}>
      <div className="join-char-preview-identity">
        <span className="join-char-preview-name">{character.name}</span>
        <span className="join-char-preview-meta">
          {character.race} / {character.charClass}
        </span>
      </div>
      <div className="join-char-preview-stats">
        {['STR','DEX','CON','INT','WIS','CHA'].map(k => (
          <div key={k} className="join-char-preview-ability">
            <span className="join-char-preview-ability-key">{k}</span>
            <span className="join-char-preview-ability-val">{abilities[k] ?? 10}</span>
          </div>
        ))}
      </div>
      <div className="join-char-preview-combat">
        <span className="join-char-preview-combat-item">
          <span className="join-char-preview-combat-label">AC</span>
          <span className="join-char-preview-combat-val">{character.ac ?? 10}</span>
        </span>
        <span className="join-char-preview-combat-item">
          <span className="join-char-preview-combat-label">HP</span>
          <span className="join-char-preview-combat-val">{character.hpMax ?? 10}</span>
        </span>
      </div>
    </div>
  )
}

export default function CampaignSetup({ onSetup, onJoin, onGenreChange, onRestoreSession, urlRoomCode }) {
  // genre + model are remembered tool preferences (kept across boots).
  const [genreId, setGenreId] = useState(() => localStorage.getItem('dnd_genre') || 'dnd')
  const [model, setModel] = useState(() => localStorage.getItem('dnd_model') || 'qwen2.5:14b')
  // Campaign-specific fields always start empty — no default campaign is pre-loaded.
  const [name, setName] = useState('')
  const [details, setDetails] = useState('')
  const [context, setContext] = useState('')
  const [contextFileName, setContextFileName] = useState('')

  // SP/MP toggle: 'single' | 'multi'
  const [playMode, setPlayMode] = useState('single')
  // Host display name (only used in multiplayer mode)
  const [hostDisplayName, setHostDisplayName] = useState('')

  // Phase 4 — multiplayer: join existing session sub-flow
  // When urlRoomCode is present, default to the join tab.
  const [tab, setTab] = useState(() => urlRoomCode ? 'join' : 'create')
  const [joinRoomCode, setJoinRoomCode] = useState(() => urlRoomCode || '')
  const [joinDisplayName, setJoinDisplayName] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joinLoading, setJoinLoading] = useState(false)

  // ── Join-tab character paths ───────────────────────────────────────────────
  // 'none' | 'existing' | 'wizard' | 'import'
  const [joinCharPath, setJoinCharPath] = useState('none')
  // The local character loaded from localStorage (shown in Path A preview).
  const [joinLocalChar] = useState(() => loadLocalCharacter())
  // Whether the joiner has confirmed using the local character.
  const [joinUseExisting, setJoinUseExisting] = useState(false)
  // Wizard output for Path B.
  const [joinCreatedChar, setJoinCreatedChar] = useState(null)
  // Genre of the room being joined (resolved from server, used for wizard).
  const [joinRoomGenre, setJoinRoomGenre] = useState(null)
  // Pre-fill state for the wizard (Path C — .md import seeds this).
  const [wizardInitialCharacter, setWizardInitialCharacter] = useState(null)
  // Import error message for Path C.
  const [importError, setImportError] = useState('')

  // Create-tab character wizard state
  const [showWizard, setShowWizard] = useState(false)
  const [createdCharacter, setCreatedCharacter] = useState(null)

  const fileInputRef = useRef(null)
  const joinImportRef = useRef(null)

  // Prefill room code from URL param whenever it changes (first render only).
  useEffect(() => {
    if (urlRoomCode) setJoinRoomCode(urlRoomCode)
  }, [urlRoomCode])

  // When the room code changes and is non-empty, resolve the room's genre from
  // the sync server so the wizard uses the correct race/class list.
  useEffect(() => {
    let cancelled = false
    async function fetchRoomGenre() {
      const rc = joinRoomCode.trim()
      if (!rc) { setJoinRoomGenre(null); return }
      const sessionId = await resolveSessionId(rc)
      if (cancelled || !sessionId) return
      const payload = await loadSyncSession(sessionId)
      if (!cancelled && payload?.campaign?.genre) {
        setJoinRoomGenre(payload.campaign.genre)
      }
    }
    fetchRoomGenre()
    return () => { cancelled = true }
  }, [joinRoomCode])

  const genre = getGenre(genreId)
  // The genre to pass to the wizard when in the Join tab.
  const effectiveJoinGenre = joinRoomGenre || genreId || 'dnd'

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

  function handleWizardCreate(wizardOutput) {
    setCreatedCharacter(wizardOutput)
    setShowWizard(false)
  }

  function handleWizardCancel() {
    setShowWizard(false)
  }

  // ── Join-tab wizard handlers ──────────────────────────────────────────────
  function handleJoinWizardCreate(wizardOutput) {
    setJoinCreatedChar(wizardOutput)
    setJoinCharPath('none') // close wizard, show result
  }

  function handleJoinWizardCancel() {
    // Return to the path selector
    setJoinCharPath('none')
    setWizardInitialCharacter(null)
  }

  // Path C: handle .md file import for the join tab
  function handleJoinImport(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportError('')
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target.result
      const dn = joinDisplayName.trim() || null
      try {
        const extracted = extractCharacterFromPayload(text, dn)
        if (!extracted) {
          setImportError('No character found in this file. The wizard will start empty.')
          // Open wizard with no pre-fill — graceful fallback per spec.
          setWizardInitialCharacter(null)
          setJoinCharPath('wizard')
          return
        }
        // Pre-fill the wizard and open it for review.
        setWizardInitialCharacter(extracted)
        setJoinCharPath('wizard')
      } catch {
        setImportError('Could not read the file. The wizard will start empty.')
        setWizardInitialCharacter(null)
        setJoinCharPath('wizard')
      }
    }
    reader.onerror = () => {
      setImportError('Could not read the file. The wizard will start empty.')
      setWizardInitialCharacter(null)
      setJoinCharPath('wizard')
    }
    reader.readAsText(file)
    // Reset the input so the same file can be re-imported.
    if (joinImportRef.current) joinImportRef.current.value = ''
  }

  function handleSubmit(e) {
    e.preventDefault()
    // SP mode: displayName is null → single-player (no WS opened).
    // MP mode: displayName is the trimmed host name → multiplayer.
    const displayName = playMode === 'multi' && hostDisplayName.trim()
      ? hostDisplayName.trim()
      : null
    onSetup({
      genre: genreId,
      name: name.trim(),
      details: details.trim(),
      model,
      context,
      displayName,
      character: createdCharacter || undefined,
    })
  }

  // Derive the SyncedCharacter to pass on join.
  // Returns the SyncedCharacter | null (null = use default adventurer).
  function resolveJoinCharacter() {
    // Path A: confirmed use of existing local character.
    if (joinUseExisting && joinLocalChar) {
      return toSyncedSubset(joinLocalChar)
    }
    // Path B / C: wizard was completed.
    if (joinCreatedChar) {
      const built = buildCharacter(joinCreatedChar, effectiveJoinGenre)
      return toSyncedSubset(built)
    }
    // No character chosen — use default adventurer on server.
    return null
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
      const character = resolveJoinCharacter()
      await onJoin({ roomCode: rc, displayName: dn, sessionId, character })
    } catch {
      setJoinError('Failed to join. Check the room code and try again.')
    } finally {
      setJoinLoading(false)
    }
  }

  // Render the join-tab character section (before a path is chosen or confirmed).
  function renderJoinCharSection() {
    // If wizard is open (Path B or C), show the wizard inline.
    if (joinCharPath === 'wizard') {
      return (
        <CharacterWizard
          genreId={effectiveJoinGenre}
          onCreateCharacter={handleJoinWizardCreate}
          onCancel={handleJoinWizardCancel}
          initialCharacter={wizardInitialCharacter}
        />
      )
    }

    // If a character was already created via wizard, show a summary with option to change.
    if (joinCreatedChar) {
      const built = buildCharacter(joinCreatedChar, effectiveJoinGenre)
      const subset = toSyncedSubset(built)
      return (
        <div className="form-group">
          <CharacterPreview character={subset} label="Created character preview" />
          <div className="join-char-actions">
            <button
              type="button"
              className="join-char-btn join-char-btn--secondary"
              onClick={() => {
                setJoinCreatedChar(null)
                setWizardInitialCharacter(null)
                setJoinUseExisting(false)
                setJoinCharPath('none')
              }}
            >
              Change character
            </button>
            <button
              type="button"
              className="join-char-btn join-char-btn--ghost"
              onClick={() => {
                setJoinCreatedChar(null)
                setJoinUseExisting(false)
              }}
            >
              Use default instead
            </button>
          </div>
        </div>
      )
    }

    // If the player confirmed using their existing local character, show preview + options.
    if (joinUseExisting && joinLocalChar) {
      const subset = toSyncedSubset(joinLocalChar)
      return (
        <div className="form-group">
          <CharacterPreview character={subset} label="Existing character preview" />
          <div className="join-char-actions">
            <button
              type="button"
              className="join-char-btn join-char-btn--secondary"
              onClick={() => {
                setJoinUseExisting(false)
                setJoinCharPath('none')
              }}
            >
              Change character
            </button>
            <button
              type="button"
              className="join-char-btn join-char-btn--ghost"
              onClick={() => setJoinUseExisting(false)}
            >
              Use default instead
            </button>
          </div>
        </div>
      )
    }

    // Path selector — show all three options.
    return (
      <div className="form-group">
        <div className="join-char-paths">
          {/* Path A: sync existing local character */}
          {joinLocalChar ? (
            <div className="join-char-path-card">
              <div className="join-char-path-label">Sync existing character</div>
              <CharacterPreview
                character={toSyncedSubset(joinLocalChar)}
                label="Local character preview"
              />
              <div className="join-char-path-actions">
                <button
                  type="button"
                  className="join-char-btn join-char-btn--primary"
                  onClick={() => {
                    setJoinUseExisting(true)
                    setJoinCreatedChar(null)
                  }}
                  data-testid="join-use-existing"
                >
                  Use this character
                </button>
              </div>
            </div>
          ) : null}

          {/* Path B: create a new character via wizard */}
          <div className="join-char-path-card">
            <div className="join-char-path-label">Create a character</div>
            <p className="form-hint">Build your character step-by-step with the character wizard.</p>
            <div className="join-char-path-actions">
              <button
                type="button"
                className="join-char-btn join-char-btn--primary"
                onClick={() => {
                  setJoinUseExisting(false)
                  setWizardInitialCharacter(null)
                  setJoinCharPath('wizard')
                }}
                data-testid="join-create-wizard"
              >
                Create a Character
              </button>
            </div>
          </div>

          {/* Path C: import from .md */}
          <div className="join-char-path-card">
            <div className="join-char-path-label">Import from .md file</div>
            <p className="form-hint">
              Upload a saved session file — the character will pre-fill the wizard for review.
            </p>
            {importError && (
              <p className="form-hint join-char-import-error" role="alert">{importError}</p>
            )}
            <div className="join-char-path-actions">
              <input
                ref={joinImportRef}
                type="file"
                accept=".md,.txt"
                onChange={handleJoinImport}
                style={{ display: 'none' }}
                id="join-import-file"
                data-testid="join-import-input"
              />
              <label htmlFor="join-import-file" className="join-char-btn join-char-btn--secondary join-char-import-label">
                Choose .md file
              </label>
            </div>
          </div>

          {/* Use default adventurer option */}
          <div className="join-char-path-default">
            <span className="form-hint">or </span>
            <button
              type="button"
              className="join-char-default-link"
              onClick={() => {
                setJoinUseExisting(false)
                setJoinCreatedChar(null)
              }}
              data-testid="join-use-default"
            >
              use the default adventurer
            </button>
          </div>
        </div>
      </div>
    )
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

            {/* ── Character section (Join tab) ── */}
            <div className="form-divider">
              <span>Character</span>
            </div>

            {renderJoinCharSection()}

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

            {/* SP/MP Segmented Control */}
            <div className="form-group">
              <label>Play Mode</label>
              <div className="spmp-toggle" role="group" aria-label="Play mode">
                <button
                  type="button"
                  className={`spmp-btn ${playMode === 'single' ? 'spmp-btn--active' : ''}`}
                  aria-pressed={playMode === 'single'}
                  onClick={() => setPlayMode('single')}
                >
                  Single-Player
                </button>
                <button
                  type="button"
                  className={`spmp-btn ${playMode === 'multi' ? 'spmp-btn--active' : ''}`}
                  aria-pressed={playMode === 'multi'}
                  onClick={() => setPlayMode('multi')}
                >
                  Multiplayer
                </button>
              </div>
              <span className="form-hint">
                {playMode === 'single'
                  ? 'Solo adventure — no room code, no WebSocket.'
                  : 'Host a session. Others join with your room code.'}
              </span>
            </div>

            <div className="form-divider">
              <span>Campaign Settings</span>
            </div>

            <div className="form-group">
              <label htmlFor="genre">Genre</label>
              <select
                id="genre"
                value={genreId}
                onChange={e => {
                  setGenreId(e.target.value)
                  onGenreChange?.(e.target.value)
                  // Reset created character if genre changes (races/classes differ)
                  setCreatedCharacter(null)
                  setShowWizard(false)
                }}
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

            {/* Character Section (shown in both SP and MP modes) */}
            <div className="form-divider">
              <span>Character</span>
            </div>

            {showWizard ? (
              <CharacterWizard
                genreId={genreId}
                onCreateCharacter={handleWizardCreate}
                onCancel={handleWizardCancel}
              />
            ) : (
              <div className="form-group">
                {createdCharacter ? (
                  <div className="wizard-character-summary">
                    <span className="wizard-character-name">{createdCharacter.name}</span>
                    <span className="wizard-character-meta">
                      {createdCharacter.race} / {createdCharacter.charClass}
                    </span>
                    <button
                      type="button"
                      className="wizard-character-change"
                      onClick={() => { setCreatedCharacter(null); setShowWizard(true) }}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="wizard-character-actions">
                    <button
                      type="button"
                      className="wizard-btn-open"
                      onClick={() => setShowWizard(true)}
                    >
                      Create a Character
                    </button>
                    <span className="wizard-skip-hint">
                      or skip to use the default adventurer
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Multiplayer display name (only visible in MP mode) */}
            {playMode === 'multi' && (
              <>
                <div className="form-divider">
                  <span>Multiplayer</span>
                </div>
                <div className="form-group">
                  <label htmlFor="host-display-name">
                    Host Display Name
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
                    How your messages appear to other players. Others join with your room code.
                  </span>
                </div>
              </>
            )}

            <button type="submit" className="btn-begin">
              <span>{genre.emblem}</span> {genre.beginLabel}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
