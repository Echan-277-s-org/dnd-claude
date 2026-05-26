// HistoryPanel — left sidebar (desktop).
// party prop is optional with a safe default ([]) so existing tests that
// render without the prop continue to pass unchanged (backward-compatible).
// Phase 5: phase prop is optional (default 'free-roam'); when 'combat', renders
// a turn-order indicator showing who is currently active.

export default function HistoryPanel({ entities, sessionLog, isOpen, onToggle, party = [], phase = 'free-roam' }) {
  const isCombat = phase === 'combat'
  const activePartyMember = isCombat ? (party.find(m => m.isActive) ?? null) : null
  return (
    <aside className={`history-panel ${isOpen ? 'history-panel--open' : ''}`}>
      {/* Toggle tab */}
      <button className="history-panel-toggle" onClick={onToggle} title="Toggle History Panel">
        <span className="history-panel-toggle-icon">{isOpen ? '‹' : '›'}</span>
      </button>

      <div className="history-panel-inner">
        {/* Session Entities */}
        <div className="panel-header" style={{ marginBottom: '12px' }}>
          Session Entities
        </div>
        <div className="history-entities">
          {entities.length === 0 ? (
            <span className="history-empty-hint">Entities will appear as the story unfolds...</span>
          ) : (
            entities.map((ent, i) => (
              <span key={i} className="history-entity-chip">{ent}</span>
            ))
          )}
        </div>

        {/* Session Log */}
        <div className="panel-header" style={{ marginTop: '20px', marginBottom: '12px' }}>
          Session Log
        </div>
        <div className="history-log">
          {sessionLog.length === 0 ? (
            <span className="history-empty-hint">Your actions will be logged here...</span>
          ) : (
            sessionLog.map((entry, i) => (
              <div key={i} className="history-log-entry">
                <span className="history-log-time">{entry.time}</span>
                <span className="history-log-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>

        {/* Phase 5: Combat turn-order indicator — shown only during combat phase */}
        {isCombat && (
          <div className="history-combat-section">
            <div className="panel-header" style={{ marginTop: '20px', marginBottom: '8px' }}>
              Combat Turn
            </div>
            <div className="history-combat-active">
              {activePartyMember
                ? (
                  <span className="history-combat-active-name">
                    {/* Active player name rendered as text node — never innerHTML (XSS guard B) */}
                    {activePartyMember.name} is acting
                  </span>
                )
                : (
                  <span className="history-combat-active-name">Resolving turn…</span>
                )
              }
            </div>
          </div>
        )}

        {/* Party sub-section — at-a-glance HP for all members (README:170) */}
        {party.length > 0 && (
          <>
            <div className="panel-header" style={{ marginTop: '20px', marginBottom: '12px' }}>
              Party
            </div>
            <div className="history-party-list">
              {party.map(m => (
                <div key={m.id} className={`history-party-row${m.isActive ? ' history-party-row--active' : ''}`}>
                  <div className="history-party-row-top">
                    <span className="history-party-name">{m.name}</span>
                    <span className="history-party-role">{m.role}</span>
                  </div>
                  <div className="history-party-hp-track" aria-label={`HP: ${m.hpPct}%`}>
                    <div
                      className="history-party-hp-fill"
                      style={{ width: `${m.hpPct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
