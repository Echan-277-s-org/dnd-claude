import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from './App'
import Chat from './components/Chat'

// ─── localStorage mock ──────────────────────────────────────────────────────
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: vi.fn(key => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value) }),
    removeItem: vi.fn(key => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    _set: (key, value) => { store[key] = value },
    _get: key => store[key],
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock fetch to prevent any accidental Ollama / sync-server calls from Chat.
globalThis.fetch = vi.fn(() =>
  Promise.reject(new Error('fetch should not be called in App routing tests'))
)

// crypto.randomUUID is used by handleSetup (fresh sessionId) and loadSessionId.
// jsdom provides it, but stub a deterministic value so we can assert the mint.
if (!globalThis.crypto) globalThis.crypto = {}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto.randomUUID = () => '00000000-0000-0000-0000-000000000000'
}

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// ─── Helper: drive the setup form to reach the Chat view ─────────────────────
// The app ALWAYS opens on the setup screen now (no auto-boot). To reach Chat we
// fill the campaign name (optional) and submit "Begin the Campaign".
function beginCampaign(name) {
  if (name != null) {
    const nameInput = screen.getByPlaceholderText(/The Lost Mine/i)
    fireEvent.change(nameInput, { target: { value: name } })
  }
  fireEvent.click(screen.getByRole('button', { name: /Begin the Campaign/i }))
}

describe('App — always opens on the setup screen (no auto-boot)', () => {
  it('shows the setup screen on boot when localStorage is empty', () => {
    render(<App />)
    // Setup screen has the "D&D Campaign Assistant" heading and "Begin the Campaign" button.
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Begin the Campaign/i })).toBeInTheDocument()
  })

  it('still shows the setup screen on boot even with a prior persisted session', () => {
    // dnd_setup_done was REMOVED; a prior session must NOT auto-resume.
    localStorageMock._set('dnd_session', '{"schemaVersion":3,"messages":[]}')
    localStorageMock._set('dnd_campaign_name', 'Old Keep')
    render(<App />)
    // No auto-boot — the setup screen renders, not the chat header.
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()
    expect(screen.queryByText('Old Keep')).not.toBeInTheDocument()
  })

  it('transitions from setup to chat after submitting the form (with a name)', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()

    beginCampaign('Ironhold')

    // Should now be in chat view — the campaign name appears in the header.
    expect(screen.getByText('Ironhold')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /D&D Campaign Assistant/i })).not.toBeInTheDocument()
  })

  it('shows fallback campaign name "D&D Campaign" in chat when no name was entered', () => {
    render(<App />)
    // Submit without entering a name (field starts empty).
    beginCampaign()
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
  })

  it('shows the "Dungeon Master Assistant" subtitle in chat view', () => {
    render(<App />)
    beginCampaign()
    expect(screen.getByText('Dungeon Master Assistant')).toBeInTheDocument()
  })
})

// ─── handleSetup contract (replaces the old dnd_setup_done contract) ─────────
// dnd_setup_done is gone. The new contract: handleSetup mints a FRESH
// dnd_session_id, clears the persisted dnd_session, and transitions to chat.

describe('App — handleSetup localStorage contract', () => {
  it('mints a fresh dnd_session_id into localStorage on submission', () => {
    crypto.randomUUID = vi.fn(() => 'fresh-uuid-1234')
    render(<App />)
    beginCampaign()
    expect(localStorageMock.setItem).toHaveBeenCalledWith('dnd_session_id', 'fresh-uuid-1234')
    expect(localStorageMock._get('dnd_session_id')).toBe('fresh-uuid-1234')
  })

  it('clears the persisted dnd_session on submission (clean slate)', () => {
    localStorageMock._set('dnd_session', '{"schemaVersion":3,"messages":[]}')
    render(<App />)
    beginCampaign()
    // handleSetup drops the prior session so the sync server can't re-pull it under
    // the old id. (Chat re-persists a fresh empty session on mount — that's the new
    // session, not the cleared one — so we assert the clear ACTION, not final state.)
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_session')
  })

  it('does NOT write a dnd_setup_done key (key was removed)', () => {
    render(<App />)
    beginCampaign()
    // The removed key must never be written.
    const setupDoneWrites = localStorageMock.setItem.mock.calls.filter(
      ([key]) => key === 'dnd_setup_done'
    )
    expect(setupDoneWrites).toHaveLength(0)
  })

  it('clears dnd_character and dnd_party when no wizard character was created', () => {
    // The no-wizard branch resets character/party to defaults.
    localStorageMock._set('dnd_character', '{"name":"Stale"}')
    localStorageMock._set('dnd_party', '[{"id":"x","name":"Stale"}]')
    render(<App />)
    beginCampaign()
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_character')
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_party')
  })

  it('clicking the settings gear returns to the setup screen', () => {
    render(<App />)
    beginCampaign('Ironhold')
    // We're in chat view.
    expect(screen.getByText('Ironhold')).toBeInTheDocument()

    // Click the settings gear → back to setup.
    fireEvent.click(screen.getByTitle('Campaign Settings'))
    expect(screen.getByRole('heading', { name: /D&D Campaign Assistant/i })).toBeInTheDocument()
  })
})

describe('App — EC-01 corrupt localStorage character JSON', () => {
  it('falls back to default character when dnd_character JSON is corrupt (no crash)', () => {
    localStorageMock._set('dnd_character', '{bad json}')
    // Boot (setup screen) must not throw on the corrupt key.
    expect(() => render(<App />)).not.toThrow()
    // Reach chat by submitting the form; still renders the fallback header.
    beginCampaign()
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
  })
})

describe('App — EC-02 missing campaign keys', () => {
  it('renders chat with fallback values when campaign name and model are absent', () => {
    // No dnd_campaign_name, no dnd_model.
    render(<App />)
    beginCampaign()
    // Should show fallback header without crashing.
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
    expect(screen.getByText('Dungeon Master Assistant')).toBeInTheDocument()
  })
})

// ─── Phase C — Header pill/dot (PC-01..05) ───────────────────────────────────
// The header status-dot and turn-pill render from the LLM-owned `party` prop on
// Chat. The app no longer auto-boots with a seeded dnd_party, so these tests
// render <Chat> directly with the party prop (the same prop App passes down).
// Use a distinct party member name "Zara" to avoid getByText collisions.

describe('App — header status dot and turn-pill (PC-01..05)', () => {
  const ZARA_PARTY = [
    { id: 'id-zara', name: 'Zara', role: 'Wizard', hpPct: 90, isActive: true },
    { id: 'id-borin', name: 'Borin', role: 'Cleric', hpPct: 70, isActive: false },
  ]

  const CAMPAIGN = {
    genre: 'dnd',
    name: 'Spire',
    details: '',
    model: 'qwen2.5:14b',
    context: '',
    sessionId: 'pc-session-id',
  }

  function renderChat(party) {
    return render(
      <Chat
        campaign={CAMPAIGN}
        onReset={vi.fn()}
        character={{
          name: 'Zara',
          race: 'Human',
          charClass: 'Wizard',
          hpCurrent: 20,
          hpMax: 20,
          ac: 15,
          initiative: 2,
          speed: 30,
          abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
          conditions: [],
        }}
        setCharacter={vi.fn()}
        party={party}
        setParty={vi.fn()}
        roomCode={null}
        displayName={null}
      />
    )
  }

  it('PC-01 .header-status-dot is present when party is populated', () => {
    const { container } = renderChat(ZARA_PARTY)
    expect(container.querySelector('.header-status-dot')).toBeInTheDocument()
  })

  it('PC-02 .turn-pill is present when party is populated', () => {
    const { container } = renderChat(ZARA_PARTY)
    expect(container.querySelector('.turn-pill')).toBeInTheDocument()
  })

  it('PC-03 turn-pill text contains the isActive member name', () => {
    const { container } = renderChat(ZARA_PARTY)
    // activeMember is Zara (isActive:true); pill has aria-label "Zara's turn".
    const pill = container.querySelector('.turn-pill')
    expect(pill).not.toBeNull()
    expect(pill.getAttribute('aria-label')).toBe("Zara's turn")
  })

  it('PC-04 turn-pill falls back to party[0].name when no member is active', () => {
    const noActiveParty = [
      { id: 'id-zara', name: 'Zara', role: 'Wizard', hpPct: 90, isActive: false },
      { id: 'id-borin', name: 'Borin', role: 'Cleric', hpPct: 70, isActive: false },
    ]
    const { container } = renderChat(noActiveParty)
    // No isActive member → activeMember = party[0] = Zara; pill aria-label = "Zara's turn".
    const pill = container.querySelector('.turn-pill')
    expect(pill).not.toBeNull()
    expect(pill.getAttribute('aria-label')).toBe("Zara's turn")
  })

  it('PC-05 boot-and-begin still routes to chat with the fallback header (regression check)', () => {
    // Verifies the standard setup→chat flow is unaffected by the party-rendering tests.
    localStorageMock._set('dnd_character', '{bad json}')
    expect(() => render(<App />)).not.toThrow()
    beginCampaign()
    expect(screen.getByText('D&D Campaign')).toBeInTheDocument()
  })
})

// ─── handleSetup with wizard character (Phases 5 & 6) ────────────────────────
// The no-wizard submit path resets identity to defaults; we exercise it via the
// real CampaignSetup form (which submits with no `character`).

describe('App — handleSetup with wizard character (Phases 5 & 6)', () => {
  it('no-wizard submit mints a fresh session id and clears the persisted session', () => {
    crypto.randomUUID = vi.fn(() => 'wizard-path-uuid')
    localStorageMock._set('dnd_session', '{"schemaVersion":3,"messages":[]}')
    render(<App />)
    beginCampaign('Ironhold')
    expect(localStorageMock._get('dnd_session_id')).toBe('wizard-path-uuid')
    // The prior session is cleared during setup (Chat then persists a fresh one on mount).
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_session')
    // And we are in chat view.
    expect(screen.getByText('Ironhold')).toBeInTheDocument()
  })

  it('no-wizard submit boots single-player and routes to chat (SP routing regression)', () => {
    render(<App />)
    beginCampaign('Ironhold')
    // Should be in chat view — not setup screen.
    expect(screen.getByText('Ironhold')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /D&D Campaign Assistant/i })).not.toBeInTheDocument()
  })

  it('handleSetup without a wizard character resets dnd_character/dnd_party (no crash)', () => {
    localStorageMock._set('dnd_character', '{"name":"Stale"}')
    localStorageMock._set('dnd_party', '[{"id":"x","name":"Stale"}]')
    render(<App />)
    beginCampaign()
    // No-wizard branch removes the prior character/party so the new campaign starts clean.
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_character')
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('dnd_party')
    // Still transitions to chat.
    expect(screen.queryByRole('heading', { name: /D&D Campaign Assistant/i })).not.toBeInTheDocument()
  })
})
