import { characterToMarkdown, characterFileName } from '../lib/session'

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']

const CONDITIONS = [
  'Poisoned',
  'Frightened',
  'Restrained',
  'Prone',
  'Blinded',
  'Incapacitated',
]

function modifier(score) {
  const mod = Math.floor((score - 10) / 2)
  return mod >= 0 ? `+${mod}` : `${mod}`
}

// The in-game character sheet is READ-ONLY. The character is built in the setup
// wizard; in-session it is displayed but never edited from this panel. An
// "Export Character" action downloads the character as a re-importable .md file.
export default function CharacterPanel({ character, isOpen, onToggle }) {
  // Export the player's character to a self-contained .md handoff. Uses the SAME
  // blob/anchor download pattern as Chat.jsx's handleSaveSession; the file
  // round-trips with the wizard's ".md" import path (extractCharacterFromPayload).
  function handleExportCharacter() {
    const md = characterToMarkdown(character)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = characterFileName(character)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <aside className={`char-panel ${isOpen ? 'char-panel--open' : ''}`}>
      <div className="char-panel-inner">
        <div className="panel-header" style={{ marginBottom: '14px' }}>
          Character Sheet
        </div>

        {/* Identity */}
        <div className="char-identity">
          <span className="char-inline-value char-name">{character.name}</span>
          <div className="char-race-class">
            <span className="char-inline-value char-race">{character.race}</span>
            <span className="char-sep">/</span>
            <span className="char-inline-value char-class">{character.charClass}</span>
          </div>
        </div>

        {/* HP */}
        <div className="char-section">
          <div className="char-section-label">Hit Points</div>
          <div className="char-hp-row">
            <span className="char-inline-value char-hp-val">{character.hpCurrent}</span>
            <span className="char-hp-sep">/</span>
            <span className="char-inline-value char-hp-val char-hp-max">{character.hpMax}</span>
          </div>
          <div className="char-hp-bar-track">
            <div
              className="char-hp-bar-fill"
              style={{
                width: character.hpMax > 0
                  ? `${Math.max(0, Math.min(100, (character.hpCurrent / character.hpMax) * 100))}%`
                  : '0%',
              }}
            />
          </div>
        </div>

        {/* AC / Initiative / Speed */}
        <div className="char-section">
          <div className="char-section-label">Combat Stats</div>
          <div className="char-badges">
            {[
              { label: 'AC', key: 'ac' },
              { label: 'Init', key: 'initiative' },
              { label: 'Speed', key: 'speed' },
            ].map(({ label, key }) => (
              <div key={key} className="char-badge">
                <span className="char-inline-value char-badge-val">{character[key]}</span>
                <span className="char-badge-label">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Ability Scores */}
        <div className="char-section">
          <div className="char-section-label">Ability Scores</div>
          <div className="char-abilities-grid">
            {ABILITY_KEYS.map(key => (
              <div key={key} className="char-ability">
                <span className="char-ability-key">{key}</span>
                <span className="char-inline-value char-ability-score">{character.abilities[key]}</span>
                <span className="char-ability-mod">{modifier(character.abilities[key])}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Conditions — non-interactive display. Active conditions stay highlighted. */}
        <div className="char-section">
          <div className="char-section-label">Conditions</div>
          <div className="char-conditions">
            {CONDITIONS.map(cond => (
              <span
                key={cond}
                className={`char-condition-chip ${character.conditions.includes(cond) ? 'char-condition-chip--active' : ''}`}
              >
                {cond}
              </span>
            ))}
          </div>
        </div>

        {/* Footer actions */}
        <div className="char-panel-footer">
          <button
            type="button"
            className="char-export-btn"
            onClick={handleExportCharacter}
            title="Download this character as a re-importable .md file"
          >
            Export Character
          </button>
        </div>
      </div>

      {/* Toggle tab */}
      <button className="char-panel-toggle" onClick={onToggle} title="Toggle Character Panel">
        <span className="char-panel-toggle-icon">{isOpen ? '›' : '‹'}</span>
      </button>
    </aside>
  )
}
