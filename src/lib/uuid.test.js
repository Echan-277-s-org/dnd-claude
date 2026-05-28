import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomUUID } from './uuid'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomUUID', () => {
  const originalRandomUUID = globalThis.crypto?.randomUUID

  afterEach(() => {
    if (originalRandomUUID) {
      globalThis.crypto.randomUUID = originalRandomUUID
    }
  })

  it('uses crypto.randomUUID when available', () => {
    const spy = vi.fn(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    globalThis.crypto.randomUUID = spy
    expect(randomUUID()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('falls back to getRandomValues when crypto.randomUUID is missing (insecure context)', () => {
    // Simulate an insecure-context browser: crypto exists, randomUUID does not.
    globalThis.crypto.randomUUID = undefined
    const id = randomUUID()
    expect(id).toMatch(UUID_V4_RE)
  })

  it('fallback produces distinct values on repeated calls', () => {
    globalThis.crypto.randomUUID = undefined
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()))
    expect(ids.size).toBe(50)
  })
})
