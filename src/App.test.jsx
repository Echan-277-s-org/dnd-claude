import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from './App'

// ─── localStorage mock ──────────────────────────────────────────────────────
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

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock fetch to prevent any accidental Ollama calls from the Chat component
globalThis.fetch = vi.fn(() =>
  Promise.reject(new Error('fetch should not be called in App routing tests'))
)

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

describe('App — routing based on localStorage', () => {
  it('shows setup screen when dnd_setup_done is not set', () => {
    // localStorage has no dnd_setup_done
    render(<App />)
    // Setup screen has "Begin the Campaign" button and "D&D Campaign Assistant" heading
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()
  })

  it('shows chat view when dnd_setup_done is present', () => {
    localStorageMock._set('dnd_setup_done', '1')
    localStorageMock._set('dnd_campaign_name', 'Test Keep')
    localStorageMock._set('dnd_model', 'qwen2.5:14b')
    render(<App />)
    // Chat view shows the campaign name in the header
    expect(screen.getByText('Test Keep')).toBeInTheDocument()
  })

  it('shows fallback campaign name "D&D Campaign" when dnd_campaign_name is missing', () => {
    localStorageMock._set('dnd_setup_done', '1')
    render(<App />)
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
  })

  it('shows the "Dungeon Master Assistant" subtitle in chat view', () => {
    localStorageMock._set('dnd_setup_done', '1')
    render(<App />)
    expect(screen.getByText('Dungeon Master Assistant')).toBeInTheDocument()
  })

  it('transitions from setup to chat after form submission', () => {
    render(<App />)
    // We're on the setup screen
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()

    // Fill in campaign name
    const nameInput = screen.getByPlaceholderText(/The Lost Mine/i)
    fireEvent.change(nameInput, { target: { value: 'Ironhold' } })

    // Submit the form
    const submitBtn = screen.getByRole('button', { name: /Begin the Campaign/i })
    fireEvent.click(submitBtn)

    // Should now be in chat view
    expect(screen.getByText('Ironhold')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /D&D Campaign Assistant/i })).not.toBeInTheDocument()
  })

  it('sets dnd_setup_done in localStorage on setup submission', () => {
    render(<App />)
    const submitBtn = screen.getByRole('button', { name: /Begin the Campaign/i })
    fireEvent.click(submitBtn)
    expect(localStorageMock.setItem).toHaveBeenCalledWith('dnd_setup_done', '1')
  })

  it('clicking settings gear resets to setup screen', () => {
    localStorageMock._set('dnd_setup_done', '1')
    localStorageMock._set('dnd_campaign_name', 'Ironhold')
    render(<App />)
    // We're in chat view
    expect(screen.getByText('Ironhold')).toBeInTheDocument()

    // Click the settings gear
    const gearBtn = screen.getByTitle('Campaign Settings')
    fireEvent.click(gearBtn)

    // Should be back to setup screen
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()
  })

  it('removes dnd_setup_done from localStorage on reset', () => {
    localStorageMock._set('dnd_setup_done', '1')
    render(<App />)
    fireEvent.click(screen.getByTitle('Campaign Settings'))
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_setup_done')
  })
})

describe('App — EC-01 corrupt localStorage character JSON', () => {
  it('falls back to default character when dnd_character JSON is corrupt', () => {
    localStorageMock._set('dnd_setup_done', '1')
    localStorageMock._set('dnd_character', '{bad json}')
    // Should not throw
    expect(() => render(<App />)).not.toThrow()
    // App should still render the chat view
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
  })
})

describe('App — EC-02 missing campaign keys', () => {
  it('renders with fallback values when campaign name and model are absent', () => {
    localStorageMock._set('dnd_setup_done', '1')
    // No dnd_campaign_name, no dnd_model
    render(<App />)
    // Should show fallback header without crashing
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
    expect(screen.getByText('Dungeon Master Assistant')).toBeInTheDocument()
  })
})
