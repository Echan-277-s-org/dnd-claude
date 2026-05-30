import { useState, useMemo } from 'react'

// ─── Pregame Lobby ───────────────────────────────────────────────────────────
// Multiplayer-only gathering screen shown while the server room is in the 'lobby'
// phase. Players review the party roster + characters and toggle their ready
// state; the host (first joiner) starts the adventure once every connected player
// is ready. All server strings render as React text nodes (never innerHTML).
//
// Props:
//   genre          — active genre engine (emblem, gmName, …)
//   campaignName   — display name for the campaign
//   roomCode       — shareable room code (dnd-<8hex>)
//   myDisplayName  — this client's connection-bound name
//   players        — [{ displayName, status, ready, isHost, character }]
//   host           — host displayName (or null)
//   allReady       — server-computed: every connected player is ready
//   onToggleReady(ready) — toggle this client's ready flag
//   onStart()      — host launches the game
export default function Lobby({
  genre,
  campaignName,
  roomCode,
  myDisplayName,
  players = [],
  host,
  allReady = false,
  onToggleReady,
  onStart,
}) {
  const [copied, setCopied] = useState(false)

  const norm = (s) => String(s ?? '').trim().toLowerCase()

  const me = useMemo(
    () => players.find((p) => norm(p.displayName) === norm(myDisplayName)) ?? null,
    [players, myDisplayName]
  )
  const iAmHost = me ? me.isHost === true : norm(host) === norm(myDisplayName)
  const myReady = me?.ready === true

  const connected = players.filter((p) => p.status === 'connected')
  const readyCount = connected.filter((p) => p.ready).length
  const canStart = iAmHost && allReady && connected.length > 0

  const copyRoom = async () => {
    try {
      await navigator.clipboard?.writeText(roomCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable (insecure context / denied) — non-fatal
    }
  }

  const charSummary = (character) => {
    if (!character) return 'Default adventurer'
    const race = character.race ?? ''
    const cls = character.charClass ?? ''
    const label = `${race} ${cls}`.trim()
    return label || 'Adventurer'
  }

  return (
    <div className="app-layout lobby-layout">
      <div className="lobby">
        <div className="lobby-card" role="group" aria-label="Pregame lobby">
          <header className="lobby-header">
            <span className="lobby-emblem" aria-hidden="true">{genre?.emblem}</span>
            <div className="lobby-title">
              <h1 className="lobby-heading">Gathering the Party</h1>
              <p className="lobby-subtitle">{campaignName}</p>
            </div>
          </header>

          <div className="lobby-roomcode">
            <span className="lobby-roomcode-label">Room code</span>
            <button
              type="button"
              className="lobby-roomcode-value"
              onClick={copyRoom}
              title="Copy room code"
              aria-label={`Room code ${roomCode}. Click to copy.`}
            >
              <span className="lobby-roomcode-text">{roomCode}</span>
              <span className="lobby-roomcode-copy">{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            <p className="lobby-share-hint">Share this code so others can join the party.</p>
          </div>

          <div className="lobby-roster" aria-label="Party roster">
            <div className="lobby-roster-head">
              <span>Party ({connected.length})</span>
              <span className="lobby-ready-count">{readyCount}/{connected.length} ready</span>
            </div>
            <ul className="lobby-player-list">
              {players.map((p) => {
                const isMe = norm(p.displayName) === norm(myDisplayName)
                const disconnected = p.status !== 'connected'
                return (
                  <li
                    key={p.displayName}
                    className={`lobby-player${disconnected ? ' lobby-player--gone' : ''}${p.ready ? ' lobby-player--ready' : ''}`}
                  >
                    <span
                      className={`lobby-player-status lobby-player-status--${disconnected ? 'gone' : 'here'}`}
                      aria-hidden="true"
                    />
                    <span className="lobby-player-main">
                      <span className="lobby-player-name">
                        {p.displayName}
                        {isMe && <span className="lobby-tag lobby-tag--you">you</span>}
                        {p.isHost && <span className="lobby-tag lobby-tag--host" title="Host">host</span>}
                      </span>
                      <span className="lobby-player-char">{charSummary(p.character)}</span>
                    </span>
                    <span className={`lobby-player-ready${p.ready ? ' is-ready' : ''}`}>
                      {disconnected ? 'away' : p.ready ? '✓ ready' : 'not ready'}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>

          <div className="lobby-actions">
            <button
              type="button"
              className={`lobby-ready-btn${myReady ? ' is-ready' : ''}`}
              onClick={() => onToggleReady?.(!myReady)}
              aria-pressed={myReady}
            >
              {myReady ? "✓ I'm ready" : "Ready up"}
            </button>

            {iAmHost ? (
              <button
                type="button"
                className="lobby-start-btn"
                onClick={() => onStart?.()}
                disabled={!canStart}
                title={canStart ? 'Start the adventure' : 'Waiting for all players to ready up'}
              >
                Start Adventure
              </button>
            ) : (
              <p className="lobby-waiting" aria-live="polite">
                Waiting for {host ? <strong>{host}</strong> : 'the host'} to start…
              </p>
            )}
          </div>

          {iAmHost && !canStart && (
            <p className="lobby-hint" aria-live="polite">
              Everyone must ready up before you can start.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
