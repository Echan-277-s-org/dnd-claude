import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Lobby from './Lobby'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const GENRE = { emblem: '⚔️', gmName: 'Dungeon Master' }

const PLAYERS = [
  {
    displayName: 'Alex',
    status: 'connected',
    ready: false,
    isHost: true,
    character: { race: 'Elf', charClass: 'Ranger' },
  },
  {
    displayName: 'Bo',
    status: 'connected',
    ready: true,
    isHost: false,
    character: { race: 'Dwarf', charClass: 'Cleric' },
  },
]

function renderLobby(overrides = {}) {
  const props = {
    genre: GENRE,
    campaignName: 'The Sunken Keep',
    roomCode: 'dnd-a1b2c3d4',
    myDisplayName: 'Alex',
    players: PLAYERS,
    host: 'Alex',
    allReady: false,
    onToggleReady: vi.fn(),
    onStart: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<Lobby {...props} />) }
}

// ─── Roster rendering ─────────────────────────────────────────────────────────

describe('Lobby — roster', () => {
  it('renders the campaign name, room code, and every player', () => {
    renderLobby()
    expect(screen.getByText('The Sunken Keep')).toBeTruthy()
    expect(screen.getByText('dnd-a1b2c3d4')).toBeTruthy()
    expect(screen.getByText('Alex')).toBeTruthy()
    expect(screen.getByText('Bo')).toBeTruthy()
  })

  it('shows each player\'s character summary (race + class)', () => {
    renderLobby()
    expect(screen.getByText('Elf Ranger')).toBeTruthy()
    expect(screen.getByText('Dwarf Cleric')).toBeTruthy()
  })

  it('falls back to "Default adventurer" when a player has no character', () => {
    renderLobby({
      players: [{ displayName: 'Cy', status: 'connected', ready: false, isHost: true, character: null }],
      myDisplayName: 'Cy',
      host: 'Cy',
    })
    expect(screen.getByText('Default adventurer')).toBeTruthy()
  })

  it('tags the host and the local player', () => {
    renderLobby()
    expect(screen.getByText('host')).toBeTruthy()
    expect(screen.getByText('you')).toBeTruthy()
  })

  it('shows a ready count over connected players', () => {
    renderLobby()
    expect(screen.getByText('1/2 ready')).toBeTruthy()
  })
})

// ─── Ready toggle ─────────────────────────────────────────────────────────────

describe('Lobby — ready toggle', () => {
  it('clicking ready up calls onToggleReady(true) when not yet ready', () => {
    const { props } = renderLobby() // Alex is not ready
    fireEvent.click(screen.getByText('Ready up'))
    expect(props.onToggleReady).toHaveBeenCalledWith(true)
  })

  it('shows the ready state and toggles back to false', () => {
    const readyMe = [{ ...PLAYERS[0], ready: true }, PLAYERS[1]]
    const { props } = renderLobby({ players: readyMe })
    const btn = screen.getByText("✓ I'm ready")
    fireEvent.click(btn)
    expect(props.onToggleReady).toHaveBeenCalledWith(false)
  })
})

// ─── Host start gating ────────────────────────────────────────────────────────

describe('Lobby — host start gating', () => {
  it('host sees a Start button disabled until everyone is ready', () => {
    renderLobby({ allReady: false })
    const start = screen.getByText('Start Adventure')
    expect(start.disabled).toBe(true)
  })

  it('host can start once allReady is true', () => {
    const { props } = renderLobby({
      allReady: true,
      players: [{ ...PLAYERS[0], ready: true }, PLAYERS[1]],
    })
    const start = screen.getByText('Start Adventure')
    expect(start.disabled).toBe(false)
    fireEvent.click(start)
    expect(props.onStart).toHaveBeenCalledTimes(1)
  })

  it('a non-host sees a waiting message and no Start button', () => {
    renderLobby({ myDisplayName: 'Bo', host: 'Alex' })
    expect(screen.queryByText('Start Adventure')).toBeNull()
    expect(screen.getByText(/Waiting for/)).toBeTruthy()
  })
})
