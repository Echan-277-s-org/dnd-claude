import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
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

// ── Join-tab Character section — all three paths render ──────────────────────

describe('CampaignSetup — Join tab character paths', () => {
  function goToJoinTab() {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
  }

  it('renders "Create a Character" option in the Join tab', () => {
    goToJoinTab()
    expect(screen.getByTestId('join-create-wizard')).toBeInTheDocument()
  })

  it('renders "Choose .md file" import option in the Join tab', () => {
    goToJoinTab()
    expect(screen.getByText(/Choose \.md file/i)).toBeInTheDocument()
  })

  it('renders "use the default adventurer" option in the Join tab', () => {
    goToJoinTab()
    expect(screen.getByTestId('join-use-default')).toBeInTheDocument()
  })

  it('clicking "Create a Character" in Join tab opens the wizard', () => {
    goToJoinTab()
    fireEvent.click(screen.getByTestId('join-create-wizard'))
    expect(screen.getByRole('dialog', { name: /Character Creation Wizard/i })).toBeInTheDocument()
  })

  it('wizard cancel in Join tab closes the wizard and returns to path selector', () => {
    goToJoinTab()
    fireEvent.click(screen.getByTestId('join-create-wizard'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // Cancel the wizard
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Path selector should be back
    expect(screen.getByTestId('join-create-wizard')).toBeInTheDocument()
  })

  it('completing the wizard in Join tab shows the created character summary', () => {
    goToJoinTab()
    fireEvent.click(screen.getByTestId('join-create-wizard'))
    // Step 1: name
    fireEvent.change(screen.getByLabelText(/Character Name/i), { target: { value: 'Gandalf' } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Step 2: race — select Human
    const raceSelect = screen.getByLabelText(/Race|Species/i)
    const raceOpts = Array.from(raceSelect.querySelectorAll('option'))
    const human = raceOpts.find(o => o.textContent === 'Human')
    fireEvent.change(raceSelect, { target: { value: human.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Step 3: class — select Wizard
    const classSelect = screen.getByLabelText(/Class/i)
    const classOpts = Array.from(classSelect.querySelectorAll('option'))
    const wizard = classOpts.find(o => o.textContent === 'Wizard')
    fireEvent.change(classSelect, { target: { value: wizard.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Step 4: method — Point Buy
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Step 5: skip (all-8 valid)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    // Step 6: review and create
    fireEvent.click(screen.getByRole('button', { name: /Create Character/i }))
    // Wizard closes, character preview appears
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The character name should be visible in the preview
    expect(screen.getByText('Gandalf')).toBeInTheDocument()
  })

  it('after wizard completion, "Use default instead" resets to path selector', () => {
    goToJoinTab()
    fireEvent.click(screen.getByTestId('join-create-wizard'))
    // Quick wizard run
    fireEvent.change(screen.getByLabelText(/Character Name/i), { target: { value: 'Legolas' } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    const raceSelect = screen.getByLabelText(/Race|Species/i)
    const raceOpts = Array.from(raceSelect.querySelectorAll('option'))
    const elf = raceOpts.find(o => o.textContent === 'Elf') || raceOpts.find(o => o.value !== '')
    fireEvent.change(raceSelect, { target: { value: elf.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    const classSelect = screen.getByLabelText(/Class/i)
    const classOpts = Array.from(classSelect.querySelectorAll('option'))
    const rogue = classOpts.find(o => o.textContent === 'Rogue') || classOpts.find(o => o.value !== '')
    fireEvent.change(classSelect, { target: { value: rogue.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /Create Character/i }))
    // Now click "Use default instead"
    fireEvent.click(screen.getByRole('button', { name: /Use default instead/i }))
    // Should return to path selector
    expect(screen.getByTestId('join-create-wizard')).toBeInTheDocument()
  })
})

// ── Join-tab: Path A — sync existing local character ─────────────────────────

describe('CampaignSetup — Join tab Path A (sync existing)', () => {
  const LOCAL_CHAR = JSON.stringify({
    name: 'Thorin',
    race: 'Dwarf',
    charClass: 'Fighter',
    hpCurrent: 20,
    hpMax: 20,
    ac: 15,
    initiative: 2,
    speed: 30,
    abilities: { STR: 16, DEX: 10, CON: 14, INT: 8, WIS: 12, CHA: 10 },
    conditions: [],
  })

  beforeEach(() => {
    localStorageMock.clear()
    localStorageMock._set('dnd_character', LOCAL_CHAR)
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('no server in tests')))
  })

  it('shows "Use this character" when a local character exists', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    expect(screen.getByTestId('join-use-existing')).toBeInTheDocument()
  })

  it('shows the local character name in the preview', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    expect(screen.getByText('Thorin')).toBeInTheDocument()
  })

  it('clicking "Use this character" shows the character preview with Change option', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    fireEvent.click(screen.getByTestId('join-use-existing'))
    // Should show "Change character" button
    expect(screen.getByRole('button', { name: /Change character/i })).toBeInTheDocument()
  })

  it('confirms local character produces correct synced subset on onJoin', async () => {
    const { onJoin } = renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    // Select local character (Path A)
    fireEvent.click(screen.getByTestId('join-use-existing'))
    // Fill required join fields
    fireEvent.change(screen.getByLabelText(/Room Code/i), { target: { value: 'dnd-abc12345' } })
    fireEvent.change(screen.getByLabelText(/Your Name/i), { target: { value: 'Thorin' } })
    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Join Session/i }))
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1))
    const arg = onJoin.mock.calls[0][0]
    expect(arg.character).not.toBeNull()
    expect(arg.character.name).toBe('Thorin')
    expect(arg.character.race).toBe('Dwarf')
    expect(arg.character.charClass).toBe('Fighter')
    expect(arg.character.abilities).toHaveProperty('STR', 16)
    expect(arg.character.ac).toBe(15)
    expect(arg.character.hpMax).toBe(20)
    // Synced subset must NOT have hpCurrent, initiative, speed
    expect(arg.character).not.toHaveProperty('hpCurrent')
    expect(arg.character).not.toHaveProperty('initiative')
    expect(arg.character).not.toHaveProperty('speed')
  })
})

// ── Join-tab: "use default" sends character: null ────────────────────────────

describe('CampaignSetup — Join tab "use default" path', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('no server in tests')))
  })

  it('submitting join form with no character chosen sends character: null', async () => {
    const { onJoin } = renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    fireEvent.change(screen.getByLabelText(/Room Code/i), { target: { value: 'dnd-abc12345' } })
    fireEvent.change(screen.getByLabelText(/Your Name/i), { target: { value: 'Strider' } })
    fireEvent.click(screen.getByRole('button', { name: /Join Session/i }))
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1))
    const arg = onJoin.mock.calls[0][0]
    expect(arg.character).toBeNull()
  })

  it('"use the default adventurer" button is present in Join tab', () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    expect(screen.getByTestId('join-use-default')).toBeInTheDocument()
  })
})

// ── Join-tab: Path C — .md import pre-fills the wizard ───────────────────────

describe('CampaignSetup — Join tab Path C (.md import)', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('no server in tests')))
  })

  // Build a minimal valid .md with a session block containing a characters map.
  function makeMdWithCharacter(name = 'Frodo', race = 'Halfling', charClass = 'Rogue') {
    const payload = {
      schemaVersion: 3,
      sessionId: 'test-session-id',
      savedAt: new Date().toISOString(),
      campaign: { name: 'Test', genre: 'dnd', details: '', context: '', model: 'qwen2.5:14b', sessionId: 'test-session-id' },
      messages: [],
      sessionLog: [],
      party: [],
      roomCode: null,
      phase: 'free-roam',
      turnSequence: 0,
      characters: {
        Frodo: {
          name,
          race,
          charClass,
          abilities: { STR: 8, DEX: 14, CON: 12, INT: 10, WIS: 13, CHA: 15 },
          ac: 13,
          hpMax: 8,
        },
      },
    }
    return `# Session — Test\n\`\`\`session\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
  }

  it('uploading a valid .md opens the wizard with pre-filled name', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    // Set display name to match character key for priority (1) extraction
    fireEvent.change(screen.getByLabelText(/Your Name/i), { target: { value: 'Frodo' } })

    const mdText = makeMdWithCharacter('Frodo', 'Halfling', 'Rogue')
    const file = new File([mdText], 'session.md', { type: 'text/plain' })
    const input = screen.getByTestId('join-import-input')
    fireEvent.change(input, { target: { files: [file] } })

    // FileReader is async in jsdom — wait for wizard to appear
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Character Creation Wizard/i })).toBeInTheDocument()
    })
    // Name input inside the wizard should be pre-filled (there may be two 'Frodo' values —
    // the display name field AND the wizard name input — so we use the specific label).
    expect(screen.getByLabelText(/Character Name/i)).toHaveValue('Frodo')
  })

  it('uploading a malformed .md opens the wizard empty (graceful fallback)', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))

    const file = new File(['not a valid session file at all'], 'bad.md', { type: 'text/plain' })
    const input = screen.getByTestId('join-import-input')
    fireEvent.change(input, { target: { files: [file] } })

    // Should open wizard (not crash) — wait for FileReader to complete
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Character Creation Wizard/i })).toBeInTheDocument()
    })
    // Name field should be empty (no pre-fill from malformed file)
    const nameInput = screen.getByLabelText(/Character Name/i)
    expect(nameInput.value).toBe('')
  })

  it('uploading a blockless .md shows graceful error message and opens wizard empty', async () => {
    renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))

    // Markdown with no ```session block
    const file = new File(['# Campaign Notes\n\nSome world lore...'], 'notes.md', { type: 'text/plain' })
    const input = screen.getByTestId('join-import-input')
    fireEvent.change(input, { target: { files: [file] } })

    // Should open wizard and show an import-error message — wait for FileReader
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /Character Creation Wizard/i })).toBeInTheDocument()
    })
  })
})

// ── Join-tab: wizard produces correct synced subset on onJoin ─────────────────

describe('CampaignSetup — Join tab wizard → onJoin character payload', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('no server in tests')))
  })

  it('wizard output is converted to synced subset on join submit', async () => {
    const { onJoin } = renderSetup()
    fireEvent.click(screen.getByRole('tab', { name: /Join Session/i }))
    // Open wizard (Path B)
    fireEvent.click(screen.getByTestId('join-create-wizard'))
    // Complete wizard: name=Arwen, race=High Elf, class=Ranger, point-buy (all-8)
    fireEvent.change(screen.getByLabelText(/Character Name/i), { target: { value: 'Arwen' } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    const raceSelect = screen.getByLabelText(/Race|Species/i)
    const raceOpts = Array.from(raceSelect.querySelectorAll('option'))
    const elf = raceOpts.find(o => o.textContent === 'High Elf')
    fireEvent.change(raceSelect, { target: { value: elf.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    const classSelect = screen.getByLabelText(/Class/i)
    const classOpts = Array.from(classSelect.querySelectorAll('option'))
    const ranger = classOpts.find(o => o.textContent === 'Ranger')
    fireEvent.change(classSelect, { target: { value: ranger.value } })
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByLabelText(/Point Buy/i))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    fireEvent.click(screen.getByRole('button', { name: /Create Character/i }))
    // Fill room/name and submit
    fireEvent.change(screen.getByLabelText(/Room Code/i), { target: { value: 'dnd-abc12345' } })
    fireEvent.change(screen.getByLabelText(/Your Name/i), { target: { value: 'Arwen' } })
    fireEvent.click(screen.getByRole('button', { name: /Join Session/i }))
    await waitFor(() => expect(onJoin).toHaveBeenCalledTimes(1))
    const arg = onJoin.mock.calls[0][0]
    expect(arg.character).not.toBeNull()
    expect(arg.character.name).toBe('Arwen')
    expect(arg.character.charClass).toBe('Ranger')
    expect(arg.character).toHaveProperty('abilities')
    expect(arg.character.abilities).toHaveProperty('STR')
    expect(arg.character).toHaveProperty('ac')
    expect(arg.character).toHaveProperty('hpMax')
    // Synced subset — no local-only fields
    expect(arg.character).not.toHaveProperty('hpCurrent')
    expect(arg.character).not.toHaveProperty('initiative')
    expect(arg.character).not.toHaveProperty('speed')
  })
})
