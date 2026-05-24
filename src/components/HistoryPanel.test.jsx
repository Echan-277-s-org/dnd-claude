import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import HistoryPanel from './HistoryPanel'

function renderPanel({ entities = [], sessionLog = [], isOpen = true, onToggle = () => {} } = {}) {
  return render(
    <HistoryPanel
      entities={entities}
      sessionLog={sessionLog}
      isOpen={isOpen}
      onToggle={onToggle}
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
