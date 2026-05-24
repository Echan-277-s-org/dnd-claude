import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import HistoryPanel from './HistoryPanel'

// party param is optional (default undefined) to preserve backward-compat for all 14 existing tests.
function renderPanel({ entities = [], sessionLog = [], isOpen = true, onToggle = () => {}, party = undefined } = {}) {
  return render(
    <HistoryPanel
      entities={entities}
      sessionLog={sessionLog}
      isOpen={isOpen}
      onToggle={onToggle}
      party={party}
    />
  )
}

// ─── Empty state placeholders ────────────────────────────────────────────────

describe('HistoryPanel — empty state', () => {
  it('shows entity placeholder when entities array is empty', () => {
    renderPanel({ entities: [] })
    expect(screen.getByText('Entities will appear as the story unfolds...')).toBeInTheDocument()
  })

  it('shows session log placeholder when sessionLog array is empty', () => {
    renderPanel({ sessionLog: [] })
    expect(screen.getByText('Your actions will be logged here...')).toBeInTheDocument()
  })

  it('shows both placeholders simultaneously when both are empty', () => {
    renderPanel()
    expect(screen.getByText('Entities will appear as the story unfolds...')).toBeInTheDocument()
    expect(screen.getByText('Your actions will be logged here...')).toBeInTheDocument()
  })
})

// ─── Entity chips ────────────────────────────────────────────────────────────

describe('HistoryPanel — entity chips', () => {
  it('renders entity chips from the entities prop', () => {
    renderPanel({ entities: ['Gareth', 'Broken Lantern'] })
    expect(screen.getByText('Gareth')).toBeInTheDocument()
    expect(screen.getByText('Broken Lantern')).toBeInTheDocument()
  })

  it('hides the entity placeholder when entities are present', () => {
    renderPanel({ entities: ['Gareth'] })
    expect(screen.queryByText('Entities will appear as the story unfolds...')).not.toBeInTheDocument()
  })

  it('renders each entity in its own chip element', () => {
    const { container } = renderPanel({ entities: ['Alma', 'Bren', 'Cira'] })
    const chips = container.querySelectorAll('.history-entity-chip')
    expect(chips.length).toBe(3)
  })

  it('renders entities in prop order', () => {
    const { container } = renderPanel({ entities: ['Alpha', 'Beta', 'Gamma'] })
    const chips = Array.from(container.querySelectorAll('.history-entity-chip'))
    expect(chips[0].textContent).toBe('Alpha')
    expect(chips[1].textContent).toBe('Beta')
    expect(chips[2].textContent).toBe('Gamma')
  })
})

// ─── Session log ─────────────────────────────────────────────────────────────

describe('HistoryPanel — session log', () => {
  const entry1 = { time: '09:30', text: 'I search for hidden doors' }
  const entry2 = { time: '09:45', text: 'I attack the goblin' }

  it('renders session log entries with timestamps', () => {
    renderPanel({ sessionLog: [entry1, entry2] })
    expect(screen.getByText('09:30')).toBeInTheDocument()
    expect(screen.getByText('09:45')).toBeInTheDocument()
  })

  it('renders session log entry text', () => {
    renderPanel({ sessionLog: [entry1] })
    expect(screen.getByText('I search for hidden doors')).toBeInTheDocument()
  })

  it('hides the log placeholder when log entries are present', () => {
    renderPanel({ sessionLog: [entry1] })
    expect(screen.queryByText('Your actions will be logged here...')).not.toBeInTheDocument()
  })

  it('renders multiple log entries in order', () => {
    const { container } = renderPanel({ sessionLog: [entry1, entry2] })
    const entries = container.querySelectorAll('.history-log-entry')
    expect(entries.length).toBe(2)
    expect(entries[0].querySelector('.history-log-time').textContent).toBe('09:30')
    expect(entries[1].querySelector('.history-log-time').textContent).toBe('09:45')
  })

  it('renders log entries with both time and text in each row', () => {
    const { container } = renderPanel({ sessionLog: [entry1] })
    const entry = container.querySelector('.history-log-entry')
    expect(entry.querySelector('.history-log-time')).toBeInTheDocument()
    expect(entry.querySelector('.history-log-text')).toBeInTheDocument()
  })
})

// ─── Panel open/close state ──────────────────────────────────────────────────

describe('HistoryPanel — open/close state', () => {
  it('applies history-panel--open class when isOpen is true', () => {
    const { container } = renderPanel({ isOpen: true })
    expect(container.querySelector('.history-panel--open')).toBeInTheDocument()
  })

  it('does not apply history-panel--open when isOpen is false', () => {
    const { container } = renderPanel({ isOpen: false })
    expect(container.querySelector('.history-panel--open')).not.toBeInTheDocument()
  })

  it('shows left-angle icon when open', () => {
    renderPanel({ isOpen: true })
    // The toggle icon when open shows '‹'
    const toggleIcon = document.querySelector('.history-panel-toggle-icon')
    expect(toggleIcon.textContent).toBe('‹')
  })

  it('shows right-angle icon when closed', () => {
    renderPanel({ isOpen: false })
    const toggleIcon = document.querySelector('.history-panel-toggle-icon')
    expect(toggleIcon.textContent).toBe('›')
  })
})

// ─── Phase B — HistoryPanel party section (PH-01..06) ────────────────────────

const HIST_PARTY = [
  { id: 'id-aelis', name: 'Aelis', role: 'Ranger', hpPct: 80, isActive: true },
  { id: 'id-borin', name: 'Borin', role: 'Cleric', hpPct: 50, isActive: false },
]

describe('HistoryPanel — party section (PH-01..06)', () => {
  it('PH-01 "Party" header is present when party prop is provided', () => {
    renderPanel({ party: HIST_PARTY })
    expect(screen.getByText('Party')).toBeInTheDocument()
  })

  it('PH-02 member names are rendered in the party section', () => {
    renderPanel({ party: HIST_PARTY })
    expect(screen.getByText('Aelis')).toBeInTheDocument()
    expect(screen.getByText('Borin')).toBeInTheDocument()
  })

  it('PH-03 member roles are rendered in the party section', () => {
    const { container } = renderPanel({ party: HIST_PARTY })
    const roles = Array.from(container.querySelectorAll('.history-party-role'))
    const roleTexts = roles.map(el => el.textContent)
    expect(roleTexts).toContain('Ranger')
    expect(roleTexts).toContain('Cleric')
  })

  it('PH-04 HP fill width reflects hpPct for each member', () => {
    const { container } = renderPanel({ party: HIST_PARTY })
    const fills = container.querySelectorAll('.history-party-hp-fill')
    expect(fills[0].style.width).toBe('80%')
    expect(fills[1].style.width).toBe('50%')
  })

  it('PH-05 all 14 existing tests pass when party is undefined (backward-compat)', () => {
    // When party is not provided (undefined), HistoryPanel defaults to [] so the
    // party section is not rendered; no Party header, no member rows.
    const { container } = renderPanel({ party: undefined })
    // Party section absent
    expect(container.querySelector('.history-party-list')).toBeNull()
    // Standard sections are still present
    expect(screen.getByText('Entities will appear as the story unfolds...')).toBeInTheDocument()
    expect(screen.getByText('Your actions will be logged here...')).toBeInTheDocument()
  })

  it('PH-06 empty party array renders no member rows and no Party header', () => {
    const { container } = renderPanel({ party: [] })
    expect(container.querySelector('.history-party-list')).toBeNull()
    // Party header absent (party.length === 0 hides the section)
    const headers = Array.from(container.querySelectorAll('.panel-header'))
    const headerTexts = headers.map(h => h.textContent.trim())
    expect(headerTexts).not.toContain('Party')
  })
})
