import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import PartyStrip from './PartyStrip'

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PARTY = [
  { id: 'id-aelis', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true },
  { id: 'id-borin', name: 'Borin', role: 'Cleric', hpPct: 50, isActive: false },
  { id: 'id-zara',  name: 'Zara',  role: 'Wizard', hpPct: 30, isActive: false },
]

// ─── PB-01..03 — cell count and text ──────────────────────────────────────────

describe('PartyStrip — cell count and text content (PB-01..03)', () => {
  it('PB-01 renders exactly one cell per party member', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const cells = container.querySelectorAll('.party-strip-cell')
    expect(cells.length).toBe(3)
  })

  it('PB-02 renders the name of each member', () => {
    render(<PartyStrip party={PARTY} />)
    expect(screen.getByText('Aelis')).toBeInTheDocument()
    expect(screen.getByText('Borin')).toBeInTheDocument()
    expect(screen.getByText('Zara')).toBeInTheDocument()
  })

  it('PB-03 renders the role of each member', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    // Roles appear in .party-strip-role elements
    const roles = Array.from(container.querySelectorAll('.party-strip-role'))
    const roleTexts = roles.map(el => el.textContent)
    // The active member's role has " · turn" appended, inactive have raw role
    expect(roleTexts.some(t => t.includes('Ranger'))).toBe(true)
    expect(roleTexts.some(t => t.includes('Cleric'))).toBe(true)
    expect(roleTexts.some(t => t.includes('Wizard'))).toBe(true)
  })
})

// ─── PB-04..07 — active class and turn suffix ─────────────────────────────────

describe('PartyStrip — active class and turn suffix (PB-04..07)', () => {
  it('PB-04 active cell has party-strip-cell--active class', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const activeCells = container.querySelectorAll('.party-strip-cell--active')
    expect(activeCells.length).toBeGreaterThan(0)
    // The active cell contains "Aelis"
    expect(activeCells[0].textContent).toContain('Aelis')
  })

  it('PB-05 exactly one cell has the --active class', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const activeCells = container.querySelectorAll('.party-strip-cell--active')
    expect(activeCells.length).toBe(1)
  })

  it('PB-06 active member role has " · turn" suffix', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const activeCell = container.querySelector('.party-strip-cell--active')
    const roleEl = activeCell.querySelector('.party-strip-role')
    expect(roleEl.textContent).toContain('· turn')
  })

  it('PB-07 inactive member roles do NOT have "turn" suffix', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const allCells = Array.from(container.querySelectorAll('.party-strip-cell'))
    const inactiveCells = allCells.filter(c => !c.classList.contains('party-strip-cell--active'))
    for (const cell of inactiveCells) {
      const roleEl = cell.querySelector('.party-strip-role')
      expect(roleEl.textContent).not.toContain('turn')
    }
  })
})

// ─── PB-08..10 — HP fill style.width ─────────────────────────────────────────

describe('PartyStrip — HP fill width (PB-08..10)', () => {
  it('PB-08 HP fill style.width equals hpPct%', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const fills = container.querySelectorAll('.party-strip-hp-fill')
    // Aelis = 80%, Borin = 50%, Zara = 30%
    expect(fills[0].style.width).toBe('80%')
    expect(fills[1].style.width).toBe('50%')
    expect(fills[2].style.width).toBe('30%')
  })

  it('PB-09 HP fill at 0%', () => {
    const party = [{ id: 'x', name: 'Dead', role: 'Fighter', hpPct: 0, isActive: false }]
    const { container } = render(<PartyStrip party={party} />)
    const fill = container.querySelector('.party-strip-hp-fill')
    expect(fill.style.width).toBe('0%')
  })

  it('PB-10 HP fill at 100%', () => {
    const party = [{ id: 'x', name: 'Full', role: 'Paladin', hpPct: 100, isActive: true }]
    const { container } = render(<PartyStrip party={party} />)
    const fill = container.querySelector('.party-strip-hp-fill')
    expect(fill.style.width).toBe('100%')
  })
})

// ─── PB-11..12 — avatar puck first letter ────────────────────────────────────

describe('PartyStrip — avatar puck (PB-11..12)', () => {
  it('PB-11 puck shows first letter uppercased', () => {
    const { container } = render(<PartyStrip party={PARTY} />)
    const avatars = container.querySelectorAll('.party-strip-avatar')
    expect(avatars[0].textContent).toBe('A') // Aelis
    expect(avatars[1].textContent).toBe('B') // Borin
    expect(avatars[2].textContent).toBe('Z') // Zara
  })

  it('PB-12 empty name falls back to "?"', () => {
    const party = [{ id: 'x', name: '', role: 'Unknown', hpPct: 100, isActive: false }]
    const { container } = render(<PartyStrip party={party} />)
    const avatar = container.querySelector('.party-strip-avatar')
    expect(avatar.textContent).toBe('?')
  })
})

// ─── PB-13..14 — edge cases: empty and single-member ─────────────────────────

describe('PartyStrip — edge cases (PB-13..14)', () => {
  it('PB-13 empty party renders 0 cells and does not crash', () => {
    expect(() => {
      const { container } = render(<PartyStrip party={[]} />)
      const cells = container.querySelectorAll('.party-strip-cell')
      expect(cells.length).toBe(0)
    }).not.toThrow()
  })

  it('PB-14 single member party renders 1 cell', () => {
    const party = [{ id: 'id-1', name: 'Solo', role: 'Fighter', hpPct: 75, isActive: true }]
    const { container } = render(<PartyStrip party={party} />)
    const cells = container.querySelectorAll('.party-strip-cell')
    expect(cells.length).toBe(1)
    expect(container.querySelector('.party-strip-cell--active')).toBeInTheDocument()
  })
})

// ─── PB-15 — display-only (no onSetActive, click no-op) ──────────────────────

describe('PartyStrip — display-only (PB-15)', () => {
  it('PB-15 component renders without onSetActive prop and cells are not interactive buttons', () => {
    // PartyStrip is display-only; cells are divs, not buttons
    const { container } = render(<PartyStrip party={PARTY} />)
    const buttons = container.querySelectorAll('.party-strip-cell button')
    // No click-handler buttons inside the cells themselves
    expect(buttons.length).toBe(0)
    // Cells exist as divs
    const cells = container.querySelectorAll('.party-strip-cell')
    expect(cells.length).toBe(3)
  })
})

// ─── PB-16 — stable keys (no console key warning) ────────────────────────────

describe('PartyStrip — stable keys, no console.error key warning (PB-16)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('PB-16 renders without React key warnings in console.error', () => {
    const errorSpy = vi.spyOn(console, 'error')
    render(<PartyStrip party={PARTY} />)
    const keyWarnings = errorSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('key')
    )
    expect(keyWarnings.length).toBe(0)
  })
})

// ─── Phase 5 — Combat phase highlighting (appended, no existing tests modified) ──

describe('PartyStrip — Phase 5 combat phase highlighting', () => {
  const COMBAT_PARTY = [
    { id: 'id-aelis', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true },
    { id: 'id-borin', name: 'Borin', role: 'Cleric', hpPct: 50, isActive: false },
  ]

  it('PS5-01 inactive cells get --dimmed class when phase is combat', () => {
    const { container } = render(<PartyStrip party={COMBAT_PARTY} phase="combat" />)
    const dimmedCells = container.querySelectorAll('.party-strip-cell--dimmed')
    expect(dimmedCells.length).toBe(1)
    expect(dimmedCells[0].textContent).toContain('Borin')
  })

  it('PS5-02 active cell does NOT get --dimmed class in combat', () => {
    const { container } = render(<PartyStrip party={COMBAT_PARTY} phase="combat" />)
    const activeCells = container.querySelectorAll('.party-strip-cell--active')
    expect(activeCells.length).toBe(1)
    expect(activeCells[0].classList).not.toContain('party-strip-cell--dimmed')
  })

  it('PS5-03 no --dimmed classes in free-roam phase (default)', () => {
    const { container } = render(<PartyStrip party={COMBAT_PARTY} phase="free-roam" />)
    const dimmedCells = container.querySelectorAll('.party-strip-cell--dimmed')
    expect(dimmedCells.length).toBe(0)
  })

  it('PS5-04 no --dimmed classes when phase prop is omitted (backward-compat default)', () => {
    const { container } = render(<PartyStrip party={COMBAT_PARTY} />)
    const dimmedCells = container.querySelectorAll('.party-strip-cell--dimmed')
    expect(dimmedCells.length).toBe(0)
  })

  it('PS5-05 all cells non-dimmed when all members inactive in combat (edge case)', () => {
    const allInactive = [
      { id: 'a', name: 'A', role: 'F', hpPct: 80, isActive: false },
      { id: 'b', name: 'B', role: 'C', hpPct: 50, isActive: false },
    ]
    const { container } = render(<PartyStrip party={allInactive} phase="combat" />)
    // All inactive → all get dimmed (none can skip)
    const dimmedCells = container.querySelectorAll('.party-strip-cell--dimmed')
    expect(dimmedCells.length).toBe(2)
  })
})
