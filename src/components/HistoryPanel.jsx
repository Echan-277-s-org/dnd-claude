export default function HistoryPanel({ entities, sessionLog, isOpen, onToggle }) {
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
      </div>
    </aside>
  )
}
