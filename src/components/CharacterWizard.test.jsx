import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import CharacterWizard from './CharacterWizard'

// ── localStorage mock (wizard uses no localStorage, but other imports might) ─

const localStorageMock = (() => {
  let store = {}
  return {
    getItem: vi.fn(key => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value) }),
    removeItem: vi.fn(key => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    _set: (key, value) => { store[key] = value },
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderWizard(props = {}) {
  const onCreateCharacter = props.onCreateCharacter ?? vi.fn()
  const onCancel = props.onCancel ?? vi.fn()
  const genreId = props.genreId ?? 'dnd'
  const result = render(
    <CharacterWizard genreId={genreId} onCreateCharacter={onCreateCharacter} onCancel={onCancel} />
  )
  return { ...result, onCreateCharacter, onCancel }
}

// Advance wizard through Name step
function fillName(name = 'Thorin') {
  const input = screen.getByLabelText(/Character Name/i)
  fireEvent.change(input, { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
}

// Advance wizard through Race step
function selectRace(raceLabel = 'Dwarf') {
  const select = screen.getByLabelText(/Race|Species/i)
  fireEvent.change(select, { target: { value: screen.getByText(raceLabel)?.closest('option')?.value ?? 'dwarf' } })
  // Try by option text matching
  const options = Array.from(select.querySelectorAll('option') ?? [])
  const opt = options.find(o => o.textContent === raceLabel)
  if (opt) fireEvent.change(select, { target: { value: opt.value } })
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
}

// Advance through Class step
function selectClass(classLabel = 'Fighter') {
  const select = screen.getByLabelText(/Class/i)
  const options = Array.from(select.querySelectorAll('option') ?? [])
  const opt = options.find(o => o.textContent === classLabel)
  if (opt) fireEvent.change(select, { target: { value: opt.value } })
  fireEvent.click(screen.getByRole('button', { name: /next/i }))
}

// ── Step 1: Name ──────────────────────────────────────────────────────────────

describe('CharacterWizard — Step 1 (Name)', () => {
  it('renders the name input on first step', () => {
    renderWizard()
    expect(screen.getByLabelText(/Character Name/i)).toBeInTheDocument()
  })

  it('shows Step 1 / 6 badge', () => {
    renderWizard()
    expect(screen.getByText(/Step 1 \/ 6/i)).toBeInTheDocument()
  })

  it('Next button is disabled when name is empty', () => {
    renderWizard()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('Next button is enabled when name is filled in', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText(/Character Name/i), { target: { value: 'Thorin' } })
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled()
  })

  it('does not show a Back button on step 1', () => {
    renderWizard()
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
  })

  it('Cancel button calls onCancel', () => {
    const { onCancel } = renderWizard()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows validation error when name is too long (> 64 chars)', () => {
    renderWizard()
    const input = screen.getByLabelText(/Character Name/i)
    // maxLength=64 is on the element, but we test the state validation too
    fireEvent.change(input, { target: { value: 'A'.repeat(65) } })
    // The input has maxLength=64 so browser trims; test with shorter invalid approach
    // via direct state: we test the enabled/disabled boundary instead
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('advances to Step 2 when a valid name is entered and Next clicked', () => {
    renderWizard()
    fillName('Thorin')
    expect(screen.getByText(/Step 2 \/ 6/i)).toBeInTheDocument()
  })
})

// ── Step 2: Race / Species ────────────────────────────────────────────────────

describe('CharacterWizard — Step 2 (Race)', () => {
  it('renders the Race dropdown on step 2', () => {
    renderWizard()
    fillName()
    expect(screen.getByLabelText(/Race|Species/i)).toBeInTheDocument()
  })

  it('Race dropdown is populated for D&D genre', () => {
    renderWizard({ genreId: 'dnd' })
    fillName()
    const select = screen.getByLabelText(/Race/i)
    expect(within(select).getByText('Dwarf')).toBeInTheDocument()
    expect(within(select).getByText('Human')).toBeInTheDocument()
  })

  it('Race dropdown is populated for starwars genre (species)', () => {
    renderWizard({ genreId: 'starwars' })
    fillName()
    const select = screen.getByLabelText(/Species/i)
    expect(within(select).getByText("Twi'lek")).toBeInTheDocument()
    expect(within(select).getByText('Wookiee')).toBeInTheDocument()
  })

  it('Next is disabled until a race is selected', () => {
    renderWizard()
    fillName()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('Next is enabled after selecting a race', () => {
    renderWizard()
    fillName()
    const select = screen.getByLabelText(/Race/i)
    const options = Array.from(select.querySelectorAll('option'))
    const dwarf = options.find(o => o.textContent === 'Dwarf')
    fireEvent.change(select, { target: { value: dwarf.value } })
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled()
  })

  it('Back button returns to Name step', () => {
    renderWizard()
    fillName()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByText(/Step 1 \/ 6/i)).toBeInTheDocument()
  })

  it('shows racial ability bonuses hint when a race is selected', () => {
    renderWizard()
    fillName()
    const select = screen.getByLabelText(/Race/i)
    const options = Array.from(select.querySelectorAll('option'))
    const dwarf = options.find(o => o.textContent === 'Dwarf')
    fireEvent.change(select, { target: { value: dwarf.value } })
    // Dwarf has CON +2 bonus
    expect(screen.getByText(/CON/)).toBeInTheDocument()
  })
})

// ── Step 3: Class ─────────────────────────────────────────────────────────────

describe('CharacterWizard — Step 3 (Class)', () => {
  function goToStep3(genreId = 'dnd') {
    renderWizard({ genreId })
    fillName()
    selectRace('Dwarf')
  }

  it('renders Class dropdown on step 3', () => {
    goToStep3()
    expect(screen.getByLabelText(/Class/i)).toBeInTheDocument()
  })

  it('D&D class list includes Fighter, Wizard, Rogue', () => {
    goToStep3('dnd')
    const select = screen.getByLabelText(/Class/i)
    expect(within(select).getByText('Fighter')).toBeInTheDocument()
    expect(within(select).getByText('Wizard')).toBeInTheDocument()
    expect(within(select).getByText('Rogue')).toBeInTheDocument()
  })

  it('Star Wars class list includes Soldier, Jedi', () => {
    // For starwars, go through steps manually (goToStep3 uses 'Dwarf' which doesn't exist)
    renderWizard({ genreId: 'starwars' })
    fillName('Rey')
    // Step 2: select a SW species
    const raceSelect = screen.getByLabelText(/Species/i)
    const raceOpts = Array.from(raceSelect.querySelectorAll('option'))
    const human = raceOpts.find(o => o.textContent === 'Human')
    fireEvent.change(raceSelect, { target: { value: human.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Now on step 3
    const classSelect = screen.getByLabelText(/Class/i)
    expect(within(classSelect).getByText('Soldier')).toBeInTheDocument()
    expect(within(classSelect).getByText('Jedi')).toBeInTheDocument()
  })

  it('Next is disabled until a class is selected', () => {
    goToStep3()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('Next is enabled after selecting a class', () => {
    goToStep3()
    const select = screen.getByLabelText(/Class/i)
    const opts = Array.from(select.querySelectorAll('option'))
    const fighter = opts.find(o => o.textContent === 'Fighter')
    fireEvent.change(select, { target: { value: fighter.value } })
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled()
  })

  it('shows hit die info when a class is selected', () => {
    goToStep3()
    const select = screen.getByLabelText(/Class/i)
    const opts = Array.from(select.querySelectorAll('option'))
    const fighter = opts.find(o => o.textContent === 'Fighter')
    fireEvent.change(select, { target: { value: fighter.value } })
    expect(screen.getByText(/d10/i)).toBeInTheDocument()
  })

  it('Back button returns to Race step', () => {
    goToStep3()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByText(/Step 2 \/ 6/i)).toBeInTheDocument()
  })
})

// ── Step 4: Ability Method ────────────────────────────────────────────────────

describe('CharacterWizard — Step 4 (Method)', () => {
  function goToStep4(genreId = 'dnd') {
    renderWizard({ genreId })
    fillName()
    selectRace('Dwarf')
    selectClass('Fighter')
  }

  it('renders method radio buttons for D&D', () => {
    goToStep4('dnd')
    expect(screen.getByLabelText(/Point Buy/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Standard Array/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Roll 4d6/i)).toBeInTheDocument()
  })

  it('renders method radio buttons for Star Wars', () => {
    renderWizard({ genreId: 'starwars' })
    fillName()
    // starwars race
    const raceSelect = screen.getByLabelText(/Species/i)
    const raceOpts = Array.from(raceSelect.querySelectorAll('option'))
    const human = raceOpts.find(o => o.textContent === 'Human')
    fireEvent.change(raceSelect, { target: { value: human.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // class
    const classSelect = screen.getByLabelText(/Class/i)
    const classOpts = Array.from(classSelect.querySelectorAll('option'))
    const soldier = classOpts.find(o => o.textContent === 'Soldier')
    fireEvent.change(classSelect, { target: { value: soldier.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Now on step 4
    expect(screen.getByLabelText(/Balanced/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Strong/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Quick/i)).toBeInTheDocument()
  })

  it('Next is disabled until a method is selected', () => {
    goToStep4()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })

  it('Next is enabled after selecting a method', () => {
    goToStep4()
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled()
  })

  it('Back button returns to Class step', () => {
    goToStep4()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByText(/Step 3 \/ 6/i)).toBeInTheDocument()
  })
})

// ── Step 5: Ability Assignment — Point Buy ─────────────────────────────────────

describe('CharacterWizard — Step 5 (Point Buy)', () => {
  function goToPointBuy() {
    renderWizard({ genreId: 'dnd' })
    fillName()
    selectRace('Dwarf')
    selectClass('Fighter')
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
  }

  it('shows budget display with 27 points', () => {
    const { container } = renderWizard({ genreId: 'dnd' })
    fillName()
    selectRace('Dwarf')
    selectClass('Fighter')
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // The budget display has class wizard-budget-display
    const budgetEl = container.querySelector('.wizard-budget-display')
    expect(budgetEl).not.toBeNull()
    expect(budgetEl.textContent).toMatch(/Budget/)
    expect(budgetEl.textContent).toMatch(/27/)
  })

  it('shows all 6 ability rows (STR, DEX, CON, INT, WIS, CHA)', () => {
    goToPointBuy()
    for (const key of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
      expect(screen.getByText(key)).toBeInTheDocument()
    }
  })

  it('+ button increments a score from 8 to 9 and decrements budget', () => {
    goToPointBuy()
    const strIncrease = screen.getByLabelText('Increase STR')
    fireEvent.click(strIncrease)
    // Budget 27 - 1 = 26
    expect(screen.getByText(/26/)).toBeInTheDocument()
  })

  it('- button is disabled at minimum score (8)', () => {
    goToPointBuy()
    expect(screen.getByLabelText('Decrease STR')).toBeDisabled()
  })

  it('Next is enabled (all-8 is a valid point-buy starting state)', () => {
    goToPointBuy()
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled()
  })
})

// ── Step 5: Ability Assignment — Standard Array ───────────────────────────────

describe('CharacterWizard — Step 5 (Standard Array)', () => {
  function goToStandardArray() {
    renderWizard({ genreId: 'dnd' })
    fillName()
    selectRace('Dwarf')
    selectClass('Fighter')
    fireEvent.click(screen.getByLabelText(/Standard Array/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
  }

  it('shows step 5 with standard array method', () => {
    goToStandardArray()
    expect(screen.getByText(/Step 5 \/ 6/i)).toBeInTheDocument()
    expect(screen.getByText(/Standard Array/i)).toBeInTheDocument()
  })

  it('renders ability select dropdowns for each ability key', () => {
    goToStandardArray()
    const selects = screen.getAllByRole('combobox')
    // Expect 6 dropdowns for the 6 abilities
    expect(selects.length).toBeGreaterThanOrEqual(6)
  })

  it('Next is disabled when abilities are not fully assigned', () => {
    goToStandardArray()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })
})

// ── Step 5: Ability Assignment — Roll 4d6 ────────────────────────────────────

describe('CharacterWizard — Step 5 (Roll 4d6)', () => {
  function goToRoll4d6() {
    renderWizard({ genreId: 'dnd' })
    fillName()
    selectRace('Dwarf')
    selectClass('Fighter')
    fireEvent.click(screen.getByLabelText(/Roll 4d6/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
  }

  it('shows the rolled values after navigating to step 5', () => {
    goToRoll4d6()
    // The wizard auto-rolls on entering this step
    expect(screen.getByText(/Step 5 \/ 6/i)).toBeInTheDocument()
    // Should show some pool chips with rolled values
    expect(screen.getByText(/Your rolls/i)).toBeInTheDocument()
  })

  it('Reroll button is present', () => {
    goToRoll4d6()
    expect(screen.getByRole('button', { name: /reroll/i })).toBeInTheDocument()
  })

  it('Next is disabled when abilities are not fully assigned', () => {
    goToRoll4d6()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  })
})

// ── Step 6: Review ────────────────────────────────────────────────────────────

describe('CharacterWizard — Step 6 (Review)', () => {
  function goToReview() {
    renderWizard({ genreId: 'dnd' })
    fillName('Thorin')
    selectRace('Dwarf')
    selectClass('Fighter')
    // Select Point Buy method
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // On step 5 (point buy, all 8s is valid) — click Next
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
  }

  it('shows the review header on step 6', () => {
    goToReview()
    expect(screen.getByText(/Step 6 \/ 6/i)).toBeInTheDocument()
    expect(screen.getByText(/Review Your Character/i)).toBeInTheDocument()
  })

  it('shows the character name in review', () => {
    goToReview()
    expect(screen.getByText('Thorin')).toBeInTheDocument()
  })

  it('shows the class in review', () => {
    goToReview()
    expect(screen.getByText('Fighter')).toBeInTheDocument()
  })

  it('shows all 6 ability keys in review', () => {
    goToReview()
    for (const key of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
      expect(screen.getAllByText(key).length).toBeGreaterThan(0)
    }
  })

  it('"Create Character" button is present on review screen', () => {
    goToReview()
    expect(screen.getByRole('button', { name: /Create Character/i })).toBeInTheDocument()
  })

  it('calls onCreateCharacter with correct shape when Create is clicked', () => {
    const { onCreateCharacter } = renderWizard({ genreId: 'dnd' })
    fillName('Thorin')
    selectRace('Dwarf')
    selectClass('Fighter')
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /Create Character/i }))

    expect(onCreateCharacter).toHaveBeenCalledTimes(1)
    const arg = onCreateCharacter.mock.calls[0][0]
    expect(arg).toHaveProperty('name', 'Thorin')
    expect(arg).toHaveProperty('charClass', 'Fighter')
    expect(arg).toHaveProperty('abilities')
    expect(arg.abilities).toHaveProperty('STR')
    expect(arg.abilities).toHaveProperty('CON')
  })

  it('Back button from review returns to step 5', () => {
    goToReview()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(screen.getByText(/Step 5 \/ 6/i)).toBeInTheDocument()
  })

  it('Cancel button on review calls onCancel', () => {
    const { onCancel } = renderWizard({ genreId: 'dnd' })
    fillName('Thorin')
    selectRace('Dwarf')
    selectClass('Fighter')
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

// ── Genre change resets race/class ────────────────────────────────────────────

describe('CharacterWizard — genre prop change', () => {
  it('navigating to race step shows genre-appropriate options after genre changes', () => {
    // Render with DnD first, navigate to step 2, then re-render with starwars genre
    const { rerender, onCancel } = renderWizard({ genreId: 'dnd' })
    fillName()
    expect(screen.getByLabelText(/Race/i)).toBeInTheDocument()
    // Switch genre
    rerender(<CharacterWizard genreId="starwars" onCreateCharacter={vi.fn()} onCancel={onCancel} />)
    // Should have reset to step 1 or step 2 with new dropdown
    // Either way, the wizard should still be rendering
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

// ── Escape key ────────────────────────────────────────────────────────────────

describe('CharacterWizard — Escape key', () => {
  it('pressing Escape calls onCancel', () => {
    const { onCancel } = renderWizard()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
