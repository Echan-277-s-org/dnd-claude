// ─── Waiting Room ────────────────────────────────────────────────────────────
// Shown to a LATE joiner — a player who joined a multiplayer game that is already
// underway. They hold here, seeing the live party, until the host admits them
// (server flips their `admitted` flag, Chat swaps in the play screen). The initial
// party never sees this (they were admitted when the host started); single-player
// never reaches it. All server strings render as React text nodes (never innerHTML).
//
// Props:
//   genre         — active genre engine (emblem, …)
//   campaignName  — display name for the campaign
//   roomCode      — the room code (shared display)
//   myDisplayName — this client's connection-bound name
//   party         — live LLM-owned party array [{ name, role, hpPct, isActive }]
//   host          — host displayName (or null)
export default function WaitingRoom({ genre, campaignName, roomCode, myDisplayName, party = [], host }) {
  return (
    <div className="app-layout lobby-layout">
      <div className="lobby">
        <div className="lobby-card waiting-card" role="group" aria-label="Waiting room">
          <header className="lobby-header">
            <span className="lobby-emblem" aria-hidden="true">{genre?.emblem}</span>
            <div className="lobby-title">
              <h1 className="lobby-heading">The adventure is underway</h1>
              <p className="lobby-subtitle">{campaignName}</p>
            </div>
          </header>

          <div className="waiting-spinner" aria-hidden="true">
            <span className="waiting-dot" />
            <span className="waiting-dot" />
            <span className="waiting-dot" />
          </div>

          <p className="waiting-message" aria-live="polite">
            Waiting for {host ? <strong>{host}</strong> : 'the host'} to admit you as <strong>{myDisplayName}</strong>…
          </p>

          {party.length > 0 && (
            <div className="lobby-roster" aria-label="Current party">
              <div className="lobby-roster-head">
                <span>In the party ({party.length})</span>
              </div>
              <ul className="lobby-player-list">
                {party.map((m, i) => (
                  <li key={m.id ?? m.name ?? i} className="lobby-player">
                    <span className="lobby-player-status lobby-player-status--here" aria-hidden="true" />
                    <span className="lobby-player-main">
                      <span className="lobby-player-name">{m.name}</span>
                      {m.role && <span className="lobby-player-char">{m.role}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="lobby-hint">Room <strong>{roomCode}</strong> · you'll join automatically once admitted.</p>
        </div>
      </div>
    </div>
  )
}
