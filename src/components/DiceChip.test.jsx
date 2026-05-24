import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DiceChip from './DiceChip'

// ─────────────────────────────────────────────────────────────────────────────
// DiceChip — Phase D component tests (PD-01..14)
// ─────────────────────────────────────────────────────────────────────────────

describe('DiceChip — bare state (die + result only) (PD-01..04)', () => {
  it('PD-01 bare state shows the die label', () => {
    render(<DiceChip die="d20" result={17} />)
    // The die tile renders the die string
    expect(screen.getByText('d20')).toBeInTheDocument()
  })

  it('PD-02 bare state shows the numeric result', () => {
    render(<DiceChip die="d20" result={17} />)
    // The result number is in a span
    const resultEl = document.querySelector('.dice-chip-result')
    expect(resultEl).not.toBeNull()
    expect(resultEl.textContent).toContain('17')
  })

  it('PD-03 bare state shows no check label', () => {
    const { container } = render(<DiceChip die="d20" result={17} />)
    expect(container.querySelector('.dice-chip-check')).toBeNull()
  })

  it('PD-04 bare state shows no verdict element', () => {
    const { container } = render(<DiceChip die="d20" result={17} />)
    // No verdict span rendered when verdict prop is absent
    const verdictEl = container.querySelector('.dice-chip-verdict')
    expect(verdictEl).toBeNull()
  })
})

describe('DiceChip — resolved state (die + result + check + verdict) (PD-05..10)', () => {
  it('PD-05 resolved state shows the check label', () => {
    render(<DiceChip die="d20" result={17} check="STEALTH" verdict="PASS" />)
    expect(screen.getByText('STEALTH')).toBeInTheDocument()
  })

  it('PD-06 resolved state shows the numeric result', () => {
    render(<DiceChip die="d20" result={17} check="STEALTH" verdict="PASS" />)
    const resultEl = document.querySelector('.dice-chip-result')
    expect(resultEl.textContent).toContain('17')
  })

  it('PD-07 FAIL verdict applies dice-chip-verdict--fail class', () => {
    const { container } = render(<DiceChip die="d20" result={5} check="STEALTH" verdict="FAIL" />)
    const verdictEl = container.querySelector('.dice-chip-verdict')
    expect(verdictEl).not.toBeNull()
    expect(verdictEl.classList.contains('dice-chip-verdict--fail')).toBe(true)
  })

  it('PD-08 PASS verdict applies dice-chip-verdict--pass class', () => {
    const { container } = render(<DiceChip die="d20" result={18} check="PERCEPTION" verdict="PASS" />)
    const verdictEl = container.querySelector('.dice-chip-verdict')
    expect(verdictEl).not.toBeNull()
    expect(verdictEl.classList.contains('dice-chip-verdict--pass')).toBe(true)
  })

  it('PD-09 verdict text content is "FAIL" when FAIL', () => {
    render(<DiceChip die="d20" result={5} check="STEALTH" verdict="FAIL" />)
    const verdictEl = document.querySelector('.dice-chip-verdict')
    expect(verdictEl.textContent).toBe('FAIL')
  })

  it('PD-10 verdict text content is "PASS" when PASS', () => {
    render(<DiceChip die="d20" result={18} check="PERCEPTION" verdict="PASS" />)
    const verdictEl = document.querySelector('.dice-chip-verdict')
    expect(verdictEl.textContent).toBe('PASS')
  })
})

describe('DiceChip — no-crash and root class (PD-11, PD-14)', () => {
  it('PD-11 renders without crash with only die and result (no check/verdict)', () => {
    expect(() => render(<DiceChip die="d6" result={4} />)).not.toThrow()
  })

  it('PD-14 root element has class "dice-chip"', () => {
    const { container } = render(<DiceChip die="d20" result={10} />)
    expect(container.querySelector('.dice-chip')).toBeInTheDocument()
  })
})

describe('DiceChip — crit and fumble classes (PD-12..13)', () => {
  it('PD-12 d20 result=20 applies dice-chip--crit class to root', () => {
    const { container } = render(<DiceChip die="d20" result={20} />)
    const root = container.querySelector('.dice-chip')
    expect(root.classList.contains('dice-chip--crit')).toBe(true)
  })

  it('PD-13 d20 result=1 applies dice-chip--fumble class to root', () => {
    const { container } = render(<DiceChip die="d20" result={1} />)
    const root = container.querySelector('.dice-chip')
    expect(root.classList.contains('dice-chip--fumble')).toBe(true)
  })

  it('d20 normal result applies neither crit nor fumble class', () => {
    const { container } = render(<DiceChip die="d20" result={10} />)
    const root = container.querySelector('.dice-chip')
    expect(root.classList.contains('dice-chip--crit')).toBe(false)
    expect(root.classList.contains('dice-chip--fumble')).toBe(false)
  })

  it('non-d20 result=20 does NOT apply crit class (crit only for d20)', () => {
    const { container } = render(<DiceChip die="d6" result={20} />)
    const root = container.querySelector('.dice-chip')
    expect(root.classList.contains('dice-chip--crit')).toBe(false)
  })
})
