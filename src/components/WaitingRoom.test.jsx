import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import WaitingRoom from './WaitingRoom'

const GENRE = { emblem: '⚔️' }
const PARTY = [
  { id: 'a', name: 'Thorin', role: 'Fighter', hpPct: 80, isActive: true },
  { id: 'b', name: 'Mara', role: 'Cleric', hpPct: 60, isActive: false },
]

function renderWaiting(overrides = {}) {
  return render(
    <WaitingRoom
      genre={GENRE}
      campaignName="The Sunken Keep"
      roomCode="dnd-a1b2c3d4"
      myDisplayName="Cassian"
      party={PARTY}
      host="Eldric"
      {...overrides}
    />
  )
}

describe('WaitingRoom', () => {
  it('shows the campaign and an "underway" heading', () => {
    renderWaiting()
    expect(screen.getByText('The adventure is underway')).toBeTruthy()
    expect(screen.getByText('The Sunken Keep')).toBeTruthy()
  })

  it('names the host and the local player in the waiting message', () => {
    renderWaiting()
    expect(screen.getByText('Eldric')).toBeTruthy()  // host (distinct from party members)
    expect(screen.getByText('Cassian')).toBeTruthy() // local player
    expect(screen.getByText(/Waiting for/)).toBeTruthy()
  })

  it('lists the current party so the late joiner sees who is playing', () => {
    renderWaiting()
    expect(screen.getByText(/In the party/)).toBeTruthy()
    expect(screen.getByText('Mara')).toBeTruthy()
    expect(screen.getByText('Fighter')).toBeTruthy()
  })

  it('falls back to "the host" when no host name is known', () => {
    renderWaiting({ host: null })
    expect(screen.getByText(/the host/)).toBeTruthy()
  })

  it('does not render a party section when the party is empty', () => {
    renderWaiting({ party: [] })
    expect(screen.queryByText(/In the party/)).toBeNull()
  })
})
