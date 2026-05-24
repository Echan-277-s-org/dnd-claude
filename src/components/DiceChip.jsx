// DiceChip — renders a dice roll message (Phase D).
// Bare state   {die, result}                    → "d20  17"
// Resolved     {die, result, check, verdict}    → "[d20] STEALTH 17 PASS/FAIL"
//
// Both states are valid markup; the chip upgrades automatically when the
// LLM emits a verdict block and Chat.jsx updates the message in place.
// Crit/fumble modifier classes are preserved (d20=20 / d20=1).

export default function DiceChip({ die, result, check, verdict }) {
  const isCrit   = die === 'd20' && result === 20
  const isFumble = die === 'd20' && result === 1

  const modifierClass = isCrit
    ? ' dice-chip--crit'
    : isFumble
      ? ' dice-chip--fumble'
      : ''

  const verdictClass = verdict === 'PASS'
    ? 'dice-chip-verdict dice-chip-verdict--pass'
    : verdict === 'FAIL'
      ? 'dice-chip-verdict dice-chip-verdict--fail'
      : ''

  return (
    <div className={`dice-chip${modifierClass}`} role="status" aria-label={
      verdict
        ? `${die} rolled ${result} — ${check} ${verdict}`
        : `${die} rolled ${result}`
    }>
      {/* Die tile */}
      <span className="dice-chip-tile">{die}</span>

      {/* Check label — only rendered when present */}
      {check && (
        <span className="dice-chip-check">{check}</span>
      )}

      {/* Numeric result */}
      <span className={`dice-chip-result${isCrit ? ' dice-chip-result--crit' : ''}${isFumble ? ' dice-chip-result--fumble' : ''}`}>
        {result}
        {isCrit && <span className="dice-chip-crit-label"> CRIT</span>}
        {isFumble && <span className="dice-chip-fumble-label"> FUMBLE</span>}
      </span>

      {/* Verdict — only rendered when resolved */}
      {verdict && (
        <span className={verdictClass}>{verdict}</span>
      )}
    </div>
  )
}
