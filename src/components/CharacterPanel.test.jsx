import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CharacterPanel from './CharacterPanel'
import { characterFileName } from '../lib/session'

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

// CharacterPanel is now READ-ONLY: it accepts { character, isOpen, onToggle } and
// never mutates the character. We still pass a setCharacter spy so tests can assert
// it is NEVER called (no write path remains).
function renderPanel(characterOverrides = {}, isOpen = true) {
  const character = { ...DEFAULT_CHARACTER, ...characterOverrides }
  const setCharacter = vi.fn()
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

// ─── Read-only identity (was: InlineEdit name field) ──────────────────────────
// The panel is now read-only. Name/race/class render as display text; there is no
// inline edit, clicking a value does NOT open an input, mutate state, or persist.

describe('CharacterPanel — read-only identity (no inline edit)', () => {
  it('renders the name as static text, not an editable control', () => {
    renderPanel()
    // The name is a display span (no input/textbox in the panel).
    expect(screen.getByText('Adventurer')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('clicking the name does NOT reveal an input (read-only)', () => {
    renderPanel()
    fireEvent.click(screen.getByText('Adventurer'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('clicking the name does NOT call setCharacter', () => {
    const { setCharacter } = renderPanel()
    fireEvent.click(screen.getByText('Adventurer'))
    expect(setCharacter).not.toHaveBeenCalled()
  })

  it('clicking the name does NOT write to localStorage', () => {
    renderPanel()
    fireEvent.click(screen.getByText('Adventurer'))
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('renders race/class as static display values', () => {
    renderPanel({ race: 'Elf', charClass: 'Wizard' })
    expect(screen.getByText('Elf')).toBeInTheDocument()
    expect(screen.getByText('Wizard')).toBeInTheDocument()
    // Clicking them also reveals no editable control.
    fireEvent.click(screen.getByText('Elf'))
    fireEvent.click(screen.getByText('Wizard'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

// ─── Condition chips — non-interactive ────────────────────────────────────────
// Chips display state only. Active conditions stay highlighted; clicking a chip
// does nothing (no state mutation, no localStorage write).

describe('CharacterPanel — condition chips (non-interactive)', () => {
  it('a non-active condition chip has no active class', () => {
    const { container } = renderPanel()
    const chip = Array.from(container.querySelectorAll('.char-condition-chip'))
      .find(el => el.textContent === 'Poisoned')
    expect(chip).not.toHaveClass('char-condition-chip--active')
  })

  it('clicking a condition chip does NOT call setCharacter (read-only)', () => {
    const { setCharacter } = renderPanel()
    fireEvent.click(screen.getByText('Poisoned'))
    expect(setCharacter).not.toHaveBeenCalled()
  })

  it('clicking a condition chip does NOT toggle its active class', () => {
    const { container } = renderPanel()
    const chip = Array.from(container.querySelectorAll('.char-condition-chip'))
      .find(el => el.textContent === 'Poisoned')
    fireEvent.click(chip)
    // Still inactive — clicking is inert.
    expect(chip).not.toHaveClass('char-condition-chip--active')
  })

  it('clicking a condition chip does NOT write to localStorage', () => {
    renderPanel()
    fireEvent.click(screen.getByText('Poisoned'))
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('renders active class when condition is already in character.conditions', () => {
    const { container } = renderPanel({ conditions: ['Poisoned'] })
    const chip = Array.from(container.querySelectorAll('.char-condition-chip'))
      .find(el => el.textContent === 'Poisoned')
    expect(chip).toHaveClass('char-condition-chip--active')
  })

  it('an active condition chip STAYS highlighted after a click (no toggle off)', () => {
    const { container } = renderPanel({ conditions: ['Poisoned'] })
    const chip = Array.from(container.querySelectorAll('.char-condition-chip'))
      .find(el => el.textContent === 'Poisoned')
    fireEvent.click(chip)
    // Active stays highlighted — clicking does not clear it.
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

// ─── No localStorage writes (panel is read-only) ──────────────────────────────
// The write paths (update/updateAbility/toggleCondition) were removed. The panel
// never persists to dnd_character.

describe('CharacterPanel — read-only, never persists', () => {
  it('rendering the panel performs no localStorage write', () => {
    renderPanel()
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
  })

  it('clicking values and condition chips performs no localStorage write', () => {
    renderPanel({ conditions: ['Poisoned'] })
    fireEvent.click(screen.getByText('Adventurer'))
    fireEvent.click(screen.getByText('Poisoned'))
    fireEvent.click(screen.getByText('Frightened'))
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith(
      'dnd_character',
      expect.any(String)
    )
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
  })
})

// ─── Export Character (req 5) ─────────────────────────────────────────────────
// The footer has an "Export Character" button that downloads the character as a
// re-importable .md via the blob/anchor pattern (characterToMarkdown +
// characterFileName). We mock URL.createObjectURL/revokeObjectURL (jsdom lacks
// them) and spy on the anchor click to assert the download is wired.

describe('CharacterPanel — Export Character button', () => {
  let createObjURL
  let revokeObjURL
  let clickSpy

  beforeEach(() => {
    createObjURL = vi.fn(() => 'blob:mock-url')
    revokeObjURL = vi.fn()
    // jsdom does not implement these — define them so the handler runs.
    globalThis.URL.createObjectURL = createObjURL
    globalThis.URL.revokeObjectURL = revokeObjURL
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    clickSpy.mockRestore()
    delete globalThis.URL.createObjectURL
    delete globalThis.URL.revokeObjectURL
  })

  it('renders the Export Character button in the footer', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: /Export Character/i })).toBeInTheDocument()
  })

  it('clicking Export Character triggers a blob download (createObjectURL + anchor click)', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Export Character/i }))
    // A blob URL is created and the synthesized anchor is clicked to start the download.
    expect(createObjURL).toHaveBeenCalledTimes(1)
    // The blob passed to createObjectURL is a markdown Blob.
    const blobArg = createObjURL.mock.calls[0][0]
    expect(blobArg).toBeInstanceOf(Blob)
    expect(blobArg.type).toContain('text/markdown')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    // The object URL is revoked after the click (no leak).
    expect(revokeObjURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('the download filename is derived from the character name (characterFileName)', () => {
    let downloadName
    // Capture the anchor's download attribute at click time.
    clickSpy.mockImplementation(function () {
      downloadName = this.getAttribute('download')
    })
    renderPanel({ name: 'Tharivol' })
    fireEvent.click(screen.getByRole('button', { name: /Export Character/i }))
    expect(downloadName).toBe(characterFileName({ name: 'Tharivol' }))
    expect(downloadName).toBe('tharivol.md')
  })

  it('exporting does NOT write to localStorage (read-only)', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Export Character/i }))
    expect(localStorageMock.setItem).not.toHaveBeenCalled()
  })
})
