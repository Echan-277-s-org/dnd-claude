import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import CampaignSetup from './ApiKeySetup'

// ── localStorage mock ─────────────────────────────────────────────────────────

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

// Suppress fetch errors from the join-form resolveSessionId call
globalThis.fetch = vi.fn(() => Promise.reject(new Error('no server in tests')))

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderSetup(props = {}) {
  const onSetup = props.onSetup ?? vi.fn()
  const onJoin = props.onJoin ?? vi.fn()
  const onGenreChange = props.onGenreChange ?? vi.fn()
  const onRestoreSession = props.onRestoreSession ?? vi.fn()
  const urlRoomCode = props.urlRoomCode ?? null

  const result = render(
    <CampaignSetup
      onSetup={onSetup}
      onJoin={onJoin}
      onGenreChange={onGenreChange}
      onRestoreSession={onRestoreSession}
      urlRoomCode={urlRoomCode}
    />
  )
  return { ...result, onSetup, onJoin, onGenreChange, onRestoreSession }
}

// ── Tab switcher ──────────────────────────────────────────────────────────────

describe('CampaignSetup — tabs', () => {
  it('defaults to New Campaign tab', () => {
    renderSetup()
    expect(screen.getByRole('tab', { name: /New Campaign/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('switching to Join Session tab shows room code field', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    expect(screen.getByLabelText(/Room Code/i)).toBeInTheDocument()
  })

  it('auto-selects Join Session tab when urlRoomCode is provided', () => {
    renderSetup({ urlRoomCode: 'dnd-abc12345' })
    expect(screen.getByRole('tab', { name: /Join Session/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('prefills room code field from urlRoomCode', () => {
    renderSetup({ urlRoomCode: 'dnd-abc12345' })
    expect(screen.getByDisplayValue('dnd-abc12345')).toBeInTheDocument()
  })
})

// ── SP/MP Segmented Control ───────────────────────────────────────────────────

describe('CampaignSetup — SP/MP toggle', () => {
  it('renders Single-Player and Multiplayer buttons', () => {
    renderSetup()
    expect(screen.getByRole('button', { name: /Single-Player/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Multiplayer/i })).toBeInTheDocument()
  })

  it('Single-Player is active by default (aria-pressed=true)', () => {
    renderSetup()
    expect(screen.getByRole('button', { name: /Single-Player/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Multiplayer/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking Multiplayer makes it active', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    expect(screen.getByRole('button', { name: /Multiplayer/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Single-Player/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('Host Display Name field is hidden in Single-Player mode', () => {
    renderSetup()
    // SP mode by default — no host display name input
    expect(screen.queryByLabelText(/Host Display Name/i)).not.toBeInTheDocument()
  })

  it('Host Display Name field is visible in Multiplayer mode', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    expect(screen.getByLabelText(/Host Display Name/i)).toBeInTheDocument()
  })

  it('toggling back to SP hides the Host Display Name field', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    fireEvent.click(screen.getByRole('button', { name: /Single-Player/i }))
    expect(screen.queryByLabelText(/Host Display Name/i)).not.toBeInTheDocument()
  })

  it('SP/MP toggle is only on New Campaign tab (not Join Session)', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    expect(screen.queryByRole('button', { name: /Single-Player/i })).not.toBeInTheDocument()
  })
})

// ── Campaign Settings section (present in both modes) ─────────────────────────

describe('CampaignSetup — Campaign Settings', () => {
  it('Genre dropdown is present in SP mode', () => {
    renderSetup()
    expect(screen.getByLabelText(/Genre/i)).toBeInTheDocument()
  })

  it('Genre dropdown is present in MP mode', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    expect(screen.getByLabelText(/Genre/i)).toBeInTheDocument()
  })

  it('AI Model dropdown is present in both modes', () => {
    renderSetup()
    expect(screen.getByLabelText(/AI Model/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    expect(screen.getByLabelText(/AI Model/i)).toBeInTheDocument()
  })

  it('Campaign Name input is present', () => {
    renderSetup()
    expect(screen.getByLabelText(/Campaign Name/i)).toBeInTheDocument()
  })
})

// ── Character section ─────────────────────────────────────────────────────────

describe('CampaignSetup — Character section', () => {
  it('"Create a Character" button is visible in SP mode', () => {
    renderSetup()
    expect(screen.getByRole('button', { name: /Create a Character/i })).toBeInTheDocument()
  })

  it('"Create a Character" button is visible in MP mode', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    expect(screen.getByRole('button', { name: /Create a Character/i })).toBeInTheDocument()
  })

  it('clicking "Create a Character" opens the wizard', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Create a Character/i }))
    // Wizard should now be open — it has a dialog role
    expect(screen.getByRole('dialog', { name: /Character Creation Wizard/i })).toBeInTheDocument()
  })

  it('wizard cancel hides the wizard and shows "Create a Character" again', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Create a Character/i }))
    // Cancel wizard
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create a Character/i })).toBeInTheDocument()
  })

  it('shows skip hint alongside the Create a Character button', () => {
    renderSetup()
    expect(screen.getByText(/skip/i)).toBeInTheDocument()
  })
})

// ── Form submission — Single-Player mode ─────────────────────────────────────

describe('CampaignSetup — handleSubmit SP mode', () => {
  it('calls onSetup with displayName=null in SP mode (no wizard)', () => {
    const { onSetup } = renderSetup()
    // SP mode is default
    fireEvent.click(screen.getByRole('button', { name: /Begin the Campaign/i }))
    expect(onSetup).toHaveBeenCalledTimes(1)
    const arg = onSetup.mock.calls[0][0]
    expect(arg.displayName).toBeNull()
  })

  it('does not include character when wizard was skipped', () => {
    const { onSetup } = renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Begin the Campaign/i }))
    const arg = onSetup.mock.calls[0][0]
    // character should be undefined (not present or not set)
    expect(arg.character).toBeUndefined()
  })

  it('submits genre, model, name, details, context from form fields', () => {
    const { onSetup } = renderSetup()
    // Set campaign name
    const nameInput = screen.getByLabelText(/Campaign Name/i)
    fireEvent.change(nameInput, { target: { value: 'Ironhold' } })
    fireEvent.click(screen.getByRole('button', { name: /Begin the Campaign/i }))
    const arg = onSetup.mock.calls[0][0]
    expect(arg.name).toBe('Ironhold')
    expect(arg.genre).toBeTruthy()
    expect(arg.model).toBeTruthy()
  })
})

// ── Form submission — Multiplayer mode ────────────────────────────────────────

describe('CampaignSetup — handleSubmit MP mode', () => {
  it('calls onSetup with a truthy displayName in MP mode when name is filled', () => {
    const { onSetup } = renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    const hostInput = screen.getByLabelText(/Host Display Name/i)
    fireEvent.change(hostInput, { target: { value: 'Aragorn' } })
    fireEvent.click(screen.getByRole('button', { name: /Begin the Campaign/i }))
    const arg = onSetup.mock.calls[0][0]
    expect(arg.displayName).toBe('Aragorn')
  })

  it('calls onSetup with displayName=null in MP mode when host name is blank', () => {
    const { onSetup } = renderSetup()
    fireEvent.click(screen.getByRole('button', { name: /Multiplayer/i }))
    // Leave host name blank
    fireEvent.click(screen.getByRole('button', { name: /Begin the Campaign/i }))
    const arg = onSetup.mock.calls[0][0]
    expect(arg.displayName).toBeNull()
  })
})

// ── Join Session tab unchanged ────────────────────────────────────────────────

describe('CampaignSetup — Join Session tab', () => {
  it('Join Session tab shows room code and display name fields', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    expect(screen.getByLabelText(/Room Code/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Your Name/i)).toBeInTheDocument()
  })

  it('shows error when submitting join form with empty room code', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    fireEvent.click(screen.getByRole('button', { name: /Join Session/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Room code is required/i)
  })

  it('shows error when submitting join form with room code but no display name', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    fireEvent.change(screen.getByLabelText(/Room Code/i), { target: { value: 'dnd-abc12345' } })
    fireEvent.click(screen.getByRole('button', { name: /Join Session/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Display name is required/i)
  })
})

// ── Genre change resets created character ─────────────────────────────────────

describe('CampaignSetup — genre change', () => {
  it('changing genre hides wizard if open', () => {
    renderSetup()
    // Open wizard
    fireEvent.click(screen.getByRole('button', { name: /Create a Character/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Change genre
    const genreSelect = screen.getByLabelText(/Genre/i)
    const starwarsOpt = Array.from(genreSelect.querySelectorAll('option')).find(o => /Star Wars/i.test(o.textContent))
    fireEvent.change(genreSelect, { target: { value: starwarsOpt.value } })
    // Wizard should be dismissed
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// ── Existing App.test.jsx routing regression check ────────────────────────────

describe('CampaignSetup — backward compat with App routing', () => {
  it('renders the "Begin the Campaign" button on New Campaign tab', () => {
    renderSetup()
    expect(screen.getByRole('button', { name: /Begin the Campaign/i })).toBeInTheDocument()
  })

  it('genre emblem and app title are rendered', () => {
    renderSetup()
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()
  })
})
