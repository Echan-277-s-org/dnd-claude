import { useState, useEffect, useCallback } from 'react'
import { getClassesForGenre, getRacesForGenre } from '../lib/characterClasses.js'
import {
  POINT_BUY_BUDGET,
  POINT_BUY_MIN,
  POINT_BUY_MAX,
  POINT_BUY_COST,
  STANDARD_ARRAY,
  STARWARS_PRESETS,
  defaultPointBuyScores,
  validatePointBuy,
  roll4d6DropLowest,
  applyRaceBonus,
} from '../lib/abilityScoreMath.js'

// ── Utility ───────────────────────────────────────────────────────────────────

const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']
const ABILITY_LABELS = { STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' }

function abilityModifier(score) {
  const mod = Math.floor((score - 10) / 2)
  return mod >= 0 ? `+${mod}` : `${mod}`
}

const TOTAL_STEPS = 6
const STEPS = {
  NAME: 1,
  RACE: 2,
  CLASS: 3,
  METHOD: 4,
  ASSIGN: 5,
  REVIEW: 6,
}

const DND_METHODS = [
  { id: 'point-buy',      label: 'Point Buy',              description: '27-point budget — precise control.' },
  { id: 'standard-array', label: 'Standard Array',         description: '[15, 14, 13, 12, 10, 8] — assign as you like.' },
  { id: 'roll-4d6',       label: 'Roll 4d6 Drop Lowest',   description: '6 rolls — each 4d6 minus the lowest die.' },
]

const SW_METHODS = [
  { id: 'balanced', label: 'Balanced', description: 'Distributed stats — versatile.' },
  { id: 'strong',   label: 'Strong',   description: 'Focus on strength and endurance.' },
  { id: 'quick',    label: 'Quick',    description: 'Focus on dexterity and wit.' },
]

// ── Initial state ─────────────────────────────────────────────────────────────

function makeInitialState(genreId) {
  return {
    step: STEPS.NAME,
    name: '',
    raceId: '',
    race: '',
    classId: '',
    charClass: '',
    abilityMethod: '',
    // For standard-array / roll-4d6: unassigned pool + assignment map
    pool: [],        // numbers available to assign
    assigned: {},    // { STR: number|null, ... }
    // For point-buy: direct scores
    pointBuyScores: defaultPointBuyScores(),
    // For SW presets: selected preset key
    swPreset: '',
    // Rolled values (only for roll-4d6)
    rolledValues: [],
  }
}

// Build the final ability scores from the assignment state, then apply race bonuses.
function deriveAbilities(state, genreId) {
  const { abilityMethod, pointBuyScores, assigned, swPreset, raceId } = state

  let base
  if (abilityMethod === 'point-buy') {
    base = { ...pointBuyScores }
  } else if (abilityMethod === 'standard-array' || abilityMethod === 'roll-4d6') {
    base = {}
    for (const key of ABILITY_KEYS) {
      base[key] = assigned[key] ?? 10
    }
  } else if (STARWARS_PRESETS[abilityMethod]) {
    base = { ...STARWARS_PRESETS[abilityMethod].scores }
  } else {
    base = { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }
  }

  return applyRaceBonus(base, raceId, genreId)
}

// ── Step Components ───────────────────────────────────────────────────────────

function StepHeader({ step, title, subtitle }) {
  return (
    <div className="wizard-step-header">
      <div className="wizard-step-badge">Step {step} / {TOTAL_STEPS}</div>
      <div className="wizard-step-title">{title}</div>
      {subtitle && <div className="wizard-step-subtitle">{subtitle}</div>}
    </div>
  )
}

function WizardNav({ onBack, onNext, nextLabel = 'Next', nextDisabled = false, onCancel, showBack = true }) {
  return (
    <div className="wizard-nav">
      {onCancel && (
        <button type="button" className="wizard-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
      <div className="wizard-nav-right">
        {showBack && (
          <button type="button" className="wizard-btn-back" onClick={onBack}>
            Back
          </button>
        )}
        <button type="button" className="wizard-btn-next" onClick={onNext} disabled={nextDisabled}>
          {nextLabel}
        </button>
      </div>
    </div>
  )
}

// Step 1: Name
function StepName({ state, onChange, onNext, onCancel }) {
  const valid = state.name.trim().length >= 1 && state.name.trim().length <= 64
  return (
    <div className="wizard-step">
      <StepHeader step={1} title="Name Your Character" />
      <div className="form-group">
        <label htmlFor="wizard-name">Character Name</label>
        <input
          id="wizard-name"
          type="text"
          value={state.name}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="e.g. Thorin, Rey, Boba Fett..."
          maxLength={64}
          autoFocus
        />
        {state.name && !valid && (
          <span className="form-hint wizard-error">Name must be 1–64 characters.</span>
        )}
      </div>
      <WizardNav onNext={onNext} nextDisabled={!valid} showBack={false} onCancel={onCancel} />
    </div>
  )
}

// Step 2: Race/Species
function StepRace({ state, genreId, onChange, onNext, onBack, onCancel }) {
  const races = getRacesForGenre(genreId)
  const label = genreId === 'starwars' ? 'Species' : 'Race'
  const selected = races.find(r => r.id === state.raceId)

  return (
    <div className="wizard-step">
      <StepHeader step={2} title={`Choose Your ${label}`} />
      <div className="form-group">
        <label htmlFor="wizard-race">{label}</label>
        <select
          id="wizard-race"
          value={state.raceId}
          onChange={e => {
            const r = races.find(r => r.id === e.target.value)
            onChange({ raceId: e.target.value, race: r?.label || '' })
          }}
        >
          <option value="">— Select {label} —</option>
          {races.map(r => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </div>
      {selected?.abilityBonuses && (
        <div className="wizard-race-bonuses">
          <span className="form-hint">
            Racial bonuses: {Object.entries(selected.abilityBonuses).map(([k, v]) => `${k} +${v}`).join(', ')}
          </span>
        </div>
      )}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!state.raceId} onCancel={onCancel} />
    </div>
  )
}

// Step 3: Class
function StepClass({ state, genreId, onChange, onNext, onBack, onCancel }) {
  const classes = getClassesForGenre(genreId)
  const selected = classes.find(c => c.id === state.classId)

  return (
    <div className="wizard-step">
      <StepHeader step={3} title="Choose Your Class" />
      <div className="form-group">
        <label htmlFor="wizard-class">Class</label>
        <select
          id="wizard-class"
          value={state.classId}
          onChange={e => {
            const c = classes.find(c => c.id === e.target.value)
            onChange({ classId: e.target.value, charClass: c?.label || '' })
          }}
        >
          <option value="">— Select Class —</option>
          {classes.map(c => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>
      {selected && (
        <div className="form-hint">
          Hit Die: d{selected.hitDieSize} &mdash; Base HP: {selected.hpBase}
        </div>
      )}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!state.classId} onCancel={onCancel} />
    </div>
  )
}

// Step 4: Ability Method
function StepMethod({ state, genreId, onChange, onNext, onBack, onCancel }) {
  const methods = genreId === 'starwars' ? SW_METHODS : DND_METHODS
  return (
    <div className="wizard-step">
      <StepHeader step={4} title="Choose Ability Score Method" />
      <div className="wizard-method-list">
        {methods.map(m => (
          <label key={m.id} className={`wizard-method-option ${state.abilityMethod === m.id ? 'wizard-method-option--selected' : ''}`}>
            <input
              type="radio"
              name="ability-method"
              value={m.id}
              checked={state.abilityMethod === m.id}
              onChange={() => onChange({ abilityMethod: m.id })}
            />
            <div>
              <div className="wizard-method-label">{m.label}</div>
              <div className="wizard-method-desc">{m.description}</div>
            </div>
          </label>
        ))}
      </div>
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!state.abilityMethod} onCancel={onCancel} />
    </div>
  )
}

// Step 5: Ability Assignment — dispatches to sub-components
function StepAssign({ state, genreId, onChange, onNext, onBack, onCancel }) {
  const { abilityMethod } = state

  if (abilityMethod === 'point-buy') {
    return <AssignPointBuy state={state} onChange={onChange} onNext={onNext} onBack={onBack} onCancel={onCancel} />
  }
  if (abilityMethod === 'standard-array') {
    return <AssignArray state={state} pool={STANDARD_ARRAY} onChange={onChange} onNext={onNext} onBack={onBack} onCancel={onCancel} />
  }
  if (abilityMethod === 'roll-4d6') {
    return <AssignRolled state={state} onChange={onChange} onNext={onNext} onBack={onBack} onCancel={onCancel} />
  }
  // Star Wars presets — simple selection
  return <AssignSWPreset state={state} genreId={genreId} onChange={onChange} onNext={onNext} onBack={onBack} onCancel={onCancel} />
}

function AssignPointBuy({ state, onChange, onNext, onBack, onCancel }) {
  const { pointBuyScores } = state
  const validation = validatePointBuy(pointBuyScores)

  function adjust(key, delta) {
    const current = pointBuyScores[key]
    const next = current + delta
    if (next < POINT_BUY_MIN || next > POINT_BUY_MAX) return
    // Check if spending more is possible
    const tentative = { ...pointBuyScores, [key]: next }
    const { spent } = validatePointBuy(tentative)
    if (spent > POINT_BUY_BUDGET) return
    onChange({ pointBuyScores: tentative })
  }

  return (
    <div className="wizard-step">
      <StepHeader step={5} title="Assign Ability Scores" subtitle="Point Buy" />
      <div className="wizard-budget-display">
        Budget: <strong>{validation.remaining}</strong> / {POINT_BUY_BUDGET} pts remaining
      </div>
      <div className="wizard-ability-grid">
        {ABILITY_KEYS.map(key => {
          const score = pointBuyScores[key]
          const canInc = score < POINT_BUY_MAX && POINT_BUY_COST[score + 1] !== undefined &&
            validatePointBuy({ ...pointBuyScores, [key]: score + 1 }).spent <= POINT_BUY_BUDGET
          const canDec = score > POINT_BUY_MIN
          return (
            <div key={key} className="wizard-ability-row">
              <span className="wizard-ability-label" title={ABILITY_LABELS[key]}>{key}</span>
              <button
                type="button"
                className="wizard-ability-btn"
                onClick={() => adjust(key, -1)}
                disabled={!canDec}
                aria-label={`Decrease ${key}`}
              >-</button>
              <span className="wizard-ability-score">{score}</span>
              <button
                type="button"
                className="wizard-ability-btn"
                onClick={() => adjust(key, 1)}
                disabled={!canInc}
                aria-label={`Increase ${key}`}
              >+</button>
              <span className="wizard-ability-mod">{abilityModifier(score)}</span>
            </div>
          )
        })}
      </div>
      {!validation.valid && validation.errors.map(err => (
        <div key={err} className="form-hint wizard-error">{err}</div>
      ))}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!validation.valid} onCancel={onCancel} />
    </div>
  )
}

function AssignArray({ state, pool, onChange, onNext, onBack, onCancel }) {
  // assigned: { STR: valueOrNull, ... }
  const { assigned } = state

  // Initialize assigned on first render if empty
  const safeAssigned = ABILITY_KEYS.reduce((acc, k) => ({ ...acc, [k]: assigned[k] ?? null }), {})

  // Compute which pool values are still unassigned
  const usedValues = ABILITY_KEYS.map(k => safeAssigned[k]).filter(v => v !== null)
  const availablePool = [...pool]
  for (const v of usedValues) {
    const idx = availablePool.indexOf(v)
    if (idx !== -1) availablePool.splice(idx, 1)
  }

  const allAssigned = ABILITY_KEYS.every(k => safeAssigned[k] !== null)

  function assign(key, value) {
    const next = { ...safeAssigned, [key]: value === '' ? null : Number(value) }
    onChange({ assigned: next })
  }

  return (
    <div className="wizard-step">
      <StepHeader step={5} title="Assign Ability Scores" subtitle="Standard Array: assign each value once" />
      <div className="wizard-array-pool">
        {pool.map((v, i) => {
          const isUsed = usedValues.includes(v) && (() => {
            // Mark a value used only if it's actually consumed once per occurrence
            const arr = [...usedValues]
            const idx = arr.indexOf(v)
            if (idx !== -1) { arr.splice(idx, 1); return true }
            return false
          })()
          return (
            <span key={i} className={`wizard-pool-chip ${usedValues.filter(u => u === v).length > pool.filter(p => p === v).length ? 'wizard-pool-chip--used' : ''}`}>
              {v}
            </span>
          )
        })}
        <span className="form-hint">Available: {availablePool.join(', ') || '(all assigned)'}</span>
      </div>
      <div className="wizard-ability-grid">
        {ABILITY_KEYS.map(key => (
          <div key={key} className="wizard-ability-row">
            <span className="wizard-ability-label" title={ABILITY_LABELS[key]}>{key}</span>
            <select
              className="wizard-ability-select"
              value={safeAssigned[key] ?? ''}
              onChange={e => assign(key, e.target.value)}
            >
              <option value="">—</option>
              {pool.map((v, i) => {
                // Only show value if it's available OR already assigned to this key
                const assignedHere = safeAssigned[key] === v
                const inAvailable = availablePool.includes(v)
                if (!assignedHere && !inAvailable) return null
                return <option key={i} value={v}>{v}</option>
              })}
            </select>
            <span className="wizard-ability-mod">
              {safeAssigned[key] !== null ? abilityModifier(safeAssigned[key]) : '—'}
            </span>
          </div>
        ))}
      </div>
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!allAssigned} onCancel={onCancel} />
    </div>
  )
}

function AssignRolled({ state, onChange, onNext, onBack, onCancel }) {
  const { assigned, rolledValues } = state

  // Generate rolls if not yet done
  const rolls = rolledValues.length === 6 ? rolledValues : []
  function reroll() {
    const newRolls = roll4d6DropLowest()
    onChange({ rolledValues: newRolls, assigned: {} })
  }

  const safeAssigned = ABILITY_KEYS.reduce((acc, k) => ({ ...acc, [k]: assigned[k] ?? null }), {})
  const usedValues = ABILITY_KEYS.map(k => safeAssigned[k]).filter(v => v !== null)
  const availablePool = [...rolls]
  for (const v of usedValues) {
    const idx = availablePool.indexOf(v)
    if (idx !== -1) availablePool.splice(idx, 1)
  }
  const allAssigned = rolls.length === 6 && ABILITY_KEYS.every(k => safeAssigned[k] !== null)

  function assign(key, value) {
    const next = { ...safeAssigned, [key]: value === '' ? null : Number(value) }
    onChange({ assigned: next })
  }

  return (
    <div className="wizard-step">
      <StepHeader step={5} title="Assign Ability Scores" subtitle="4d6 Drop Lowest" />
      {rolls.length === 0 ? (
        <div className="wizard-roll-prompt">
          <p className="form-hint">Click Roll to generate your ability scores.</p>
          <button type="button" className="wizard-btn-roll" onClick={reroll}>Roll Dice</button>
        </div>
      ) : (
        <>
          <div className="wizard-rolled-pool">
            <span className="form-hint">Your rolls:</span>
            {rolls.map((v, i) => (
              <span key={i} className="wizard-pool-chip">{v}</span>
            ))}
            <span className="form-hint">Available: {availablePool.join(', ') || '(all assigned)'}</span>
          </div>
          <div className="wizard-ability-grid">
            {ABILITY_KEYS.map(key => (
              <div key={key} className="wizard-ability-row">
                <span className="wizard-ability-label" title={ABILITY_LABELS[key]}>{key}</span>
                <select
                  className="wizard-ability-select"
                  value={safeAssigned[key] ?? ''}
                  onChange={e => assign(key, e.target.value)}
                >
                  <option value="">—</option>
                  {rolls.map((v, i) => {
                    const assignedHere = safeAssigned[key] === v
                    const inAvailable = availablePool.includes(v)
                    if (!assignedHere && !inAvailable) return null
                    return <option key={i} value={v}>{v}</option>
                  })}
                </select>
                <span className="wizard-ability-mod">
                  {safeAssigned[key] !== null ? abilityModifier(safeAssigned[key]) : '—'}
                </span>
              </div>
            ))}
          </div>
          <button type="button" className="wizard-btn-reroll" onClick={reroll}>Reroll</button>
        </>
      )}
      <WizardNav onBack={onBack} onNext={onNext} nextDisabled={!allAssigned} onCancel={onCancel} />
    </div>
  )
}

function AssignSWPreset({ state, genreId, onChange, onNext, onBack, onCancel }) {
  // Star Wars: the method IS the preset
  const preset = STARWARS_PRESETS[state.abilityMethod]
  if (!preset) return null

  return (
    <div className="wizard-step">
      <StepHeader step={5} title="Ability Scores" subtitle={`Preset: ${preset.label}`} />
      <div className="form-hint wizard-preset-desc">{preset.description}</div>
      <div className="wizard-ability-grid">
        {ABILITY_KEYS.map(key => (
          <div key={key} className="wizard-ability-row">
            <span className="wizard-ability-label" title={ABILITY_LABELS[key]}>{key}</span>
            <span className="wizard-ability-score">{preset.scores[key]}</span>
            <span className="wizard-ability-mod">{abilityModifier(preset.scores[key])}</span>
          </div>
        ))}
      </div>
      <div className="form-hint">Race bonuses will be applied in the review step.</div>
      <WizardNav onBack={onBack} onNext={onNext} onCancel={onCancel} />
    </div>
  )
}

// Step 6: Review
function StepReview({ state, genreId, onCreateCharacter, onBack, onCancel }) {
  const abilities = deriveAbilities(state, genreId)

  return (
    <div className="wizard-step">
      <StepHeader step={6} title="Review Your Character" />
      <div className="wizard-review-block">
        <div className="wizard-review-row">
          <span className="wizard-review-label">Name</span>
          <span className="wizard-review-value">{state.name}</span>
        </div>
        <div className="wizard-review-row">
          <span className="wizard-review-label">{genreId === 'starwars' ? 'Species' : 'Race'}</span>
          <span className="wizard-review-value">{state.race}</span>
        </div>
        <div className="wizard-review-row">
          <span className="wizard-review-label">Class</span>
          <span className="wizard-review-value">{state.charClass}</span>
        </div>
      </div>
      <div className="wizard-review-abilities">
        {ABILITY_KEYS.map(key => (
          <div key={key} className="wizard-review-ability">
            <span className="wizard-review-ability-key">{key}</span>
            <span className="wizard-review-ability-score">{abilities[key]}</span>
            <span className="wizard-review-ability-mod">{abilityModifier(abilities[key])}</span>
          </div>
        ))}
      </div>
      <WizardNav
        onBack={onBack}
        onNext={() => onCreateCharacter({ name: state.name, race: state.race, raceId: state.raceId, charClass: state.charClass, classId: state.classId, abilities })}
        nextLabel="Create Character"
        onCancel={onCancel}
      />
    </div>
  )
}

// ── Main Wizard Component ─────────────────────────────────────────────────────

/**
 * Multi-step character creation wizard.
 *
 * Props:
 *   genreId         — 'dnd' | 'starwars' (controls available races/classes/methods)
 *   onCreateCharacter — callback({ name, race, raceId, charClass, classId, abilities })
 *   onCancel        — callback when wizard is dismissed without creating
 */
export default function CharacterWizard({ genreId = 'dnd', onCreateCharacter, onCancel }) {
  const [state, setState] = useState(() => makeInitialState(genreId))

  // When genre changes, reset race/class selections (dropdowns repopulate)
  // but preserve name, method, and ability scores (genre-agnostic).
  useEffect(() => {
    setState(prev => ({
      ...prev,
      raceId: '',
      race: '',
      classId: '',
      charClass: '',
      // If currently on a step past class, return to class step
      step: prev.step > STEPS.CLASS ? STEPS.CLASS : prev.step,
    }))
  }, [genreId])

  // Close on Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onCancel?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  function patch(updates) {
    setState(prev => ({ ...prev, ...updates }))
  }

  function goNext() {
    setState(prev => {
      let nextStep = prev.step + 1
      // When method is a SW preset, step 5 is just display — still go through it
      return { ...prev, step: nextStep }
    })
  }

  function goBack() {
    setState(prev => ({ ...prev, step: Math.max(1, prev.step - 1) }))
  }

  // Initialise rolls when navigating to the roll-4d6 assignment step
  useEffect(() => {
    if (state.step === STEPS.ASSIGN && state.abilityMethod === 'roll-4d6' && state.rolledValues.length === 0) {
      setState(prev => ({ ...prev, rolledValues: roll4d6DropLowest() }))
    }
  }, [state.step, state.abilityMethod])

  const sharedProps = { state, genreId, onChange: patch, onNext: goNext, onBack: goBack, onCancel }

  return (
    <div className="wizard-container" role="dialog" aria-label="Character Creation Wizard">
      {state.step === STEPS.NAME   && <StepName    {...sharedProps} />}
      {state.step === STEPS.RACE   && <StepRace    {...sharedProps} />}
      {state.step === STEPS.CLASS  && <StepClass   {...sharedProps} />}
      {state.step === STEPS.METHOD && <StepMethod  {...sharedProps} />}
      {state.step === STEPS.ASSIGN && <StepAssign  {...sharedProps} />}
      {state.step === STEPS.REVIEW && (
        <StepReview state={state} genreId={genreId} onCreateCharacter={onCreateCharacter} onBack={goBack} onCancel={onCancel} />
      )}
    </div>
  )
}
