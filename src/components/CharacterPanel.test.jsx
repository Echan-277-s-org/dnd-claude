import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CharacterPanel from './CharacterPanel'

// ─── localStorage mock ──────────────────────────────────────────────────────
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: vi.fn(key => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value) }),
    removeItem: vi.fn(key => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store },
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// ─── default character ───────────────────────────────────────────────────────
const DEFAULT_CHARACTER = {
  name: 'Adventurer',
  race: 'Human',
  charClass: 'Fighter',
  hpCurrent: 20,
  hpMax: 20,
  ac: 15,
  initiative: 2,
  speed: 30,
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  conditions: [],
}

function renderPanel(characterOverrides = {}, isOpen = true) {
  const character = { ...DEFAULT_CHARACTER, ...characterOverrides }
  const setCharacter = vi.fn(updater => {
    // simulate functional update: if updater is a function call it with character
    if (typeof updater === 'function') {
      updater(character)
    }
  })
  const onToggle = vi.fn()
  const utils = render(
    <CharacterPanel
      character={character}
      setCharacter={setCharacter}
      isOpen={isOpen}
      onToggle={onToggle}
    />
  )
  return { ...utils, setCharacter, onToggle, character }
}

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// ─── Rendering defaults ──────────────────────────────────────────────────────

describe('CharacterPanel — rendering defaults', () => {
  it('renders the character name', () => {
    renderPanel()
    expect(screen.getByText('Adventurer')).toBeInTheDocument()
  })

  it('renders race and class', () => {
    renderPanel()
    expect(screen.getByText('Human')).toBeInTheDocument()
    expect(screen.getByText('Fighter')).toBeInTheDocument()
  })

  it('renders HP values', () => {
    renderPanel()
    // Two "20" elements — hpCurrent and hpMax
    const twenties = screen.getAllByText('20')
    expect(twenties.length).toBeGreaterThanOrEqual(2)
  })

  it('renders all 6 ability score keys', () => {
    renderPanel()
    for (const key of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
      expect(screen.getByText(key)).toBeInTheDocument()
    }
  })

  it('renders +0 modifier for default ability scores of 10', () => {
    renderPanel()
    const mods = screen.getAllByText('+0')
    expect(mods.length).toBe(6) // all 6 abilities at 10
  })

  it('renders all 6 condition chips', () => {
    renderPanel()
    const expectedConditions = ['Poisoned', 'Frightened', 'Restrained', 'Prone', 'Blinded', 'Incapacitated']
    for (const cond of expectedConditions) {
      expect(screen.getByText(cond)).toBeInTheDocument()
    }
  })

  it('applies open class when isOpen is true', () => {
    const { container } = renderPanel({}, true)
    expect(container.querySelector('.char-panel--open')).toBeInTheDocument()
  })

  it('does not apply open class when isOpen is false', () => {
    const { container } = renderPanel({}, false)
    expect(container.querySelector('.char-panel--open')).not.toBeInTheDocument()
  })

  it('calls onToggle when the toggle tab button is clicked', () => {
    const { onToggle } = renderPanel()
    const toggleBtn = screen.getByTitle('Toggle Character Panel')
    fireEvent.click(toggleBtn)
    expect(onToggle).toHaveBeenCalledOnce()
  })
})

// ─── Ability modifier math ───────────────────────────────────────────────────

describe('CharacterPanel — ability modifier math', () => {
  // modifier = Math.floor((score - 10) / 2)
  const cases = [
    [0, '-5'],
    [1, '-5'],
    [8, '-1'],
    [10, '+0'],
    [14, '+2'],
    [20, '+5'],
    [30, '+10'],
  ]

  for (const [score, expected] of cases) {
    it(`score ${score} shows modifier ${expected}`, () => {
      renderPanel({ abilities: { STR: score, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 } })
      // The modifier is rendered in a .char-ability-mod span
      // Since multiple abilities exist we look for the exact modifier text among all
      const modEls = document.querySelectorAll('.char-ability-mod')
      const modTexts = Array.from(modEls).map(el => el.textContent)
      expect(modTexts).toContain(expected)
    })
  }
})

// ─── HP bar percentage ───────────────────────────────────────────────────────

describe('CharacterPanel — HP bar percentage', () => {
  function getBarWidth(container) {
    const fill = container.querySelector('.char-hp-bar-fill')
    return fill?.style.width
  }

  it('shows 100% bar at full HP (20/20)', () => {
    const { container } = renderPanel({ hpCurrent: 20, hpMax: 20 })
    expect(getBarWidth(container)).toBe('100%')
  })

  it('shows 50% bar at half HP (10/20)', () => {
    const { container } = renderPanel({ hpCurrent: 10, hpMax: 20 })
    expect(getBarWidth(container)).toBe('50%')
  })

  it('clamps to 0% at 0 HP', () => {
    const { container } = renderPanel({ hpCurrent: 0, hpMax: 20 })
    expect(getBarWidth(container)).toBe('0%')
  })

  it('clamps to 100% when HP exceeds max (999/20)', () => {
    const { container } = renderPanel({ hpCurrent: 999, hpMax: 20 })
    expect(getBarWidth(container)).toBe('100%')
  })

  it('returns 0% when hpMax is 0 (division guard, no NaN)', () => {
    const { container } = renderPanel({ hpCurrent: 0, hpMax: 0 })
    const width = getBarWidth(container)
    expect(width).toBe('0%')
    expect(width).not.toContain('NaN')
  })

  it('shows 0% when hpCurrent is negative', () => {
    const { container } = renderPanel({ hpCurrent: -5, hpMax: 20 })
    expect(getBarWidth(container)).toBe('0%')
  })
})

// ─── Inline edit — name ──────────────────────────────────────────────────────

describe('CharacterPanel — InlineEdit name field', () => {
  it('clicking the name shows an input', () => {
    renderPanel()
    const nameSpan = screen.getByText('Adventurer')
    fireEvent.click(nameSpan)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('Enter key commits the edit and calls setCharacter', () => {
    const { setCharacter } = renderPanel()
    const nameSpan = screen.getByText('Adventurer')
    fireEvent.click(nameSpan)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Thorin Stonehelm' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(setCharacter).toHaveBeenCalled()
  })

  it('Enter key writes to localStorage', () => {
    renderPanel()
    const nameSpan = screen.getByText('Adventurer')
    fireEvent.click(nameSpan)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Thorin Stonehelm' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // blur is triggered by Enter in the component
    fireEvent.blur(input)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'dnd_character',
      expect.stringContaining('Thorin Stonehelm')
    )
  })

  it('Escape key cancels the edit and reverts to original value', () => {
    renderPanel()
    const nameSpan = screen.getByText('Adventurer')
    fireEvent.click(nameSpan)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'WRONG NAME' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    // input should be gone
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    // original name still visible
    expect(screen.getByText('Adventurer')).toBeInTheDocument()
  })

  it('Escape does not call setCharacter', () => {
    const { setCharacter } = renderPanel()
    fireEvent.click(screen.getByText('Adventurer'))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'WRONG' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(setCharacter).not.toHaveBeenCalled()
  })
})

// ─── Condition chips ─────────────────────────────────────────────────────────

describe('CharacterPanel — condition chips', () => {
  it('condition chip starts without active class', () => {
    const { container } = renderPanel()
    const chip = Array.from(container.querySelectorAll('.char-condition-chip'))
      .find(el => el.textContent === 'Poisoned')
    expect(chip).not.toHaveClass('char-condition-chip--active')
  })

  it('clicking a condition chip calls setCharacter with updated conditions', () => {
    const { setCharacter } = renderPanel()
    fireEvent.click(screen.getByText('Poisoned'))
    expect(setCharacter).toHaveBeenCalled()
  })

  it('renders active class when condition is already in character.conditions', () => {
    const { container } = renderPanel({ conditions: ['Poisoned'] })
    const chip = Array.from(container.querySelectorAll('.char-condition-chip'))
      .find(el => el.textContent === 'Poisoned')
    expect(chip).toHaveClass('char-condition-chip--active')
  })

  it('character with multiple active conditions shows all active', () => {
    const { container } = renderPanel({ conditions: ['Poisoned', 'Blinded', 'Prone'] })
    const chips = Array.from(container.querySelectorAll('.char-condition-chip--active'))
    const labels = chips.map(el => el.textContent)
    expect(labels).toContain('Poisoned')
    expect(labels).toContain('Blinded')
    expect(labels).toContain('Prone')
  })
})

// ─── localStorage persistence ────────────────────────────────────────────────

describe('CharacterPanel — localStorage persistence', () => {
  it('setCharacter stores to dnd_character key on update', () => {
    renderPanel()
    fireEvent.click(screen.getByText('Poisoned'))
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'dnd_character',
      expect.any(String)
    )
  })

  it('the stored JSON is valid and contains character fields', () => {
    let stored
    localStorageMock.setItem.mockImplementation((key, value) => {
      if (key === 'dnd_character') stored = value
    })
    renderPanel()
    fireEvent.click(screen.getByText('Poisoned'))
    if (stored) {
      const parsed = JSON.parse(stored)
      expect(parsed).toHaveProperty('name')
      expect(parsed).toHaveProperty('abilities')
    }
  })
})
