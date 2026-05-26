// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSyncServer } from './sync-server.mjs'

let server, base, dir

const ID = 'test-7f3a-uuid'
const payload = id => ({
  campaign: { name: 'Jaycen Hawke', genre: 'dnd', model: 'qwen2.5:14b', context: 'lore', sessionId: id },
  messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'The doors groan.' }],
  sessionLog: [{ time: '14:30', text: 'hi' }],
  party: [{ id: 'p1', name: 'Jaycen', role: 'Paladin', hpPct: 80, isActive: true }],
})

const put = (id, body) =>
  fetch(`${base}/session/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dnd-sync-'))
  await new Promise(resolve => {
    server = createSyncServer({ sessionsDir: dir }).listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise(r => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  for (const f of await readdir(dir)) await rm(path.join(dir, f), { force: true })
})

describe('sync server', () => {
  it('PUT a new session → 200 {savedAt}; GET returns it with server sessionId', async () => {
    const res = await put(ID, { ...payload(ID), savedAt: null })
    expect(res.status).toBe(200)
    const { savedAt } = await res.json()
    expect(typeof savedAt).toBe('string')

    const got = await (await fetch(`${base}/session/${ID}`)).json()
    expect(got.savedAt).toBe(savedAt)
    expect(got.sessionId).toBe(ID)
    expect(got.campaign.sessionId).toBe(ID)
    expect(got.messages).toHaveLength(2)
    expect(got.campaign.context).toBe('lore') // M2 — campaign travels
  })

  it('stores a real .md file with a session block (LLM-loadable)', async () => {
    await put(ID, { ...payload(ID), savedAt: null })
    const files = await readdir(dir)
    expect(files).toContain(`${ID}.md`)
  })

  it('GET missing → 404', async () => {
    expect((await fetch(`${base}/session/nope`)).status).toBe(404)
  })

  it('GET ?since=<current savedAt> → 304', async () => {
    const { savedAt } = await (await put(ID, { ...payload(ID), savedAt: null })).json()
    const res = await fetch(`${base}/session/${ID}?since=${encodeURIComponent(savedAt)}`)
    expect(res.status).toBe(304)
  })

  it('stale PUT (wrong base savedAt) → 409 with current savedAt, no clobber', async () => {
    const { savedAt } = await (await put(ID, { ...payload(ID), savedAt: null })).json()
    const res = await put(ID, { ...payload(ID), savedAt: 'stale-stamp' })
    expect(res.status).toBe(409)
    expect((await res.json()).savedAt).toBe(savedAt)
    // original survives
    const got = await (await fetch(`${base}/session/${ID}`)).json()
    expect(got.savedAt).toBe(savedAt)
  })

  it('correct base savedAt → 200 and advances savedAt', async () => {
    const first = await (await put(ID, { ...payload(ID), savedAt: null })).json()
    const second = await (await put(ID, { ...payload(ID), savedAt: first.savedAt })).json()
    expect(second.savedAt).not.toBe(first.savedAt)
  })

  it('M4 — path-traversal id is rejected with 400', async () => {
    const res = await fetch(`${base}/session/${encodeURIComponent('../../package')}`)
    expect(res.status).toBe(400)
  })

  it('M5 — concurrent first-writes: lock yields exactly one 200 + one 409', async () => {
    const [a, b] = await Promise.all([
      put(ID, { ...payload(ID), savedAt: null }),
      put(ID, { ...payload(ID), savedAt: null }),
    ])
    const codes = [a.status, b.status].sort()
    expect(codes).toEqual([200, 409])
  })

  it('M3 — CORS reflects Origin', async () => {
    const res = await fetch(`${base}/session/${ID}`, { headers: { Origin: 'http://192.168.1.9:5173' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://192.168.1.9:5173')
  })

  it('malformed JSON body → 400', async () => {
    const res = await fetch(`${base}/session/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    expect(res.status).toBe(400)
  })

  it('DELETE clears the session → subsequent GET 404', async () => {
    await put(ID, { ...payload(ID), savedAt: null })
    expect((await fetch(`${base}/session/${ID}`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${base}/session/${ID}`)).status).toBe(404)
  })

  it('no .tmp files remain after a write (atomic rename)', async () => {
    await put(ID, { ...payload(ID), savedAt: null })
    const files = await readdir(dir)
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
  })
})
