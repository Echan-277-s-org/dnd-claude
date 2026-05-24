// PartyStrip — mobile-only 3-cell party HUD (Phase B).
// Display-only: no click handlers, no onSetActive callback.
// The LLM owns and emits party state; this component renders it read-only.
// Rendered in Chat.jsx immediately after <header> inside .chat-container;
// visibility is controlled by the .party-strip CSS (hidden by default,
// display:grid inside @media (max-width:768px)).

export default function PartyStrip({ party = [] }) {
  return (
    <div className="party-strip" aria-label="Party status">
      {party.map(member => (
        <div
          key={member.id}
          className={`party-strip-cell${member.isActive ? ' party-strip-cell--active' : ''}`}
          aria-current={member.isActive ? 'true' : undefined}
        >
          <div className="party-strip-top">
            <div className="party-strip-avatar" aria-hidden="true">
              {member.name[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="party-strip-who">
              <span className="party-strip-name">{member.name}</span>
              <small className="party-strip-role">
                {member.role}{member.isActive ? ' · turn' : ''}
              </small>
            </div>
          </div>
          <div className="party-strip-hp-track" aria-label={`HP: ${member.hpPct}%`}>
            <div
              className="party-strip-hp-fill"
              style={{ width: `${member.hpPct}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
