const DICE = [
  { die: 'd4',   sides: 4,   icon: '▲' },
  { die: 'd6',   sides: 6,   icon: '⬡' },
  { die: 'd8',   sides: 8,   icon: '◆' },
  { die: 'd10',  sides: 10,  icon: '◈' },
  { die: 'd12',  sides: 12,  icon: '⬟' },
  { die: 'd20',  sides: 20,  icon: '⬡' },
  { die: 'd100', sides: 100, icon: '%' },
]

export default function DiceRoller({ onRoll }) {
  function roll({ die, sides }) {
    const result = Math.floor(Math.random() * sides) + 1
    onRoll(die, result)
  }

  return (
    <div className="dice-panel">
      <div className="dice-panel-title">Roll the Dice</div>
      <div className="dice-grid">
        {DICE.map(d => (
          <button key={d.die} className="die-btn" onClick={() => roll(d)} title={`Roll ${d.die}`}>
            <span className="die-icon">{d.icon}</span>
            <span className="die-label">{d.die}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
