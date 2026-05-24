import { useState, useEffect } from 'react'

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

function InlineEdit({ value, onChange, className, type = 'text', style }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  if (editing) {
    return (
      <input
        type={type}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          const final = type === 'number' ? Number(draft) || 0 : draft
          onChange(final)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') e.target.blur()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        className={`char-inline-input ${className || ''}`}
        style={style}
        autoFocus
      />
    )
  }

  return (
    <span
      className={`char-inline-value ${className || ''}`}
      style={style}
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value}
    </span>
  )
}

export default function CharacterPanel({ character, setCharacter, isOpen, onToggle }) {
  function update(patch) {
    setCharacter(prev => {
      const next = { ...prev, ...patch }
      localStorage.setItem('dnd_character', JSON.stringify(next))
      return next
    })
  }

  function updateAbility(key, val) {
    const abilities = { ...character.abilities, [key]: Number(val) || 0 }
    update({ abilities })
  }

  function toggleCondition(cond) {
    const active = character.conditions.includes(cond)
      ? character.conditions.filter(c => c !== cond)
      : [...character.conditions, cond]
    update({ conditions: active })
  }

  return (
    <aside className={`char-panel ${isOpen ? 'char-panel--open' : ''}`}>
      <div className="char-panel-inner">
        <div className="panel-header" style={{ marginBottom: '14px' }}>
          Character Sheet
        </div>

        {/* Identity */}
        <div className="char-identity">
          <InlineEdit
            value={character.name}
            onChange={v => update({ name: v })}
            className="char-name"
          />
          <div className="char-race-class">
            <InlineEdit
              value={character.race}
              onChange={v => update({ race: v })}
              className="char-race"
            />
            <span className="char-sep">/</span>
            <InlineEdit
              value={character.charClass}
              onChange={v => update({ charClass: v })}
              className="char-class"
            />
          </div>
        </div>

        {/* HP */}
        <div className="char-section">
          <div className="char-section-label">Hit Points</div>
          <div className="char-hp-row">
            <InlineEdit
              value={character.hpCurrent}
              onChange={v => update({ hpCurrent: Number(v) || 0 })}
              type="number"
              className="char-hp-val"
            />
            <span className="char-hp-sep">/</span>
            <InlineEdit
              value={character.hpMax}
              onChange={v => update({ hpMax: Number(v) || 0 })}
              type="number"
              className="char-hp-val char-hp-max"
            />
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
                <InlineEdit
                  value={character[key]}
                  onChange={v => update({ [key]: Number(v) || 0 })}
                  type="number"
                  className="char-badge-val"
                />
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
                <InlineEdit
                  value={character.abilities[key]}
                  onChange={v => updateAbility(key, v)}
                  type="number"
                  className="char-ability-score"
                />
                <span className="char-ability-mod">{modifier(character.abilities[key])}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Conditions */}
        <div className="char-section">
          <div className="char-section-label">Conditions</div>
          <div className="char-conditions">
            {CONDITIONS.map(cond => (
              <button
                key={cond}
                className={`char-condition-chip ${character.conditions.includes(cond) ? 'char-condition-chip--active' : ''}`}
                onClick={() => toggleCondition(cond)}
              >
                {cond}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Toggle tab */}
      <button className="char-panel-toggle" onClick={onToggle} title="Toggle Character Panel">
        <span className="char-panel-toggle-icon">{isOpen ? '›' : '‹'}</span>
      </button>
    </aside>
  )
}
