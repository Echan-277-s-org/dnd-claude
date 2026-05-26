// ─── LAN sync server (Phase B) ────────────────────────────────────────────────
// A dumb persistence relay for cross-device handoff over the home LAN. It stores
// each session as a `.md` file (the same self-contained, LLM-loadable format the
// app saves) by reusing the ONE serialize layer in src/lib/session.js — so the
// server's store is itself a folder of resumable handoffs, no second format.
//
// Implements all 6 MUST-FIX from CROSS-DEVICE-SYNC-EVALUATION.md §2:
//   M1 stable id (the client sends campaign.sessionId as :id — never a name slug)
//   M2 campaign travels in the payload (handled by the serialize layer)
//   M3 CORS + OPTIONS preflight
//   M4 path-traversal guard on :id
//   M5 atomic writes (temp+rename) + per-session lock + server-stamped savedAt
//   M6 is a client concern (persist per turn) — see useSessionPersistence.js
//
// No auth / plain http: acceptable on a trusted LAN (backend-developer NICE tier).

import express from 'express'
import cors from 'cors'
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { toMarkdown, fromMarkdown, serializeSession } from '../src/lib/session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.resolve(__dirname, 'sessions')
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function createSyncServer({ sessionsDir = DEFAULT_DIR } = {}) {
  // M4 — resolve a path-safe filename for an id, or null if it escapes the dir.
  function sessionPath(id) {
    if (!ID_RE.test(String(id ?? ''))) return null
    const p = path.resolve(sessionsDir, `${id}.md`)
    if (path.dirname(p) !== path.resolve(sessionsDir)) return null
    return p
  }

  async function readStored(id) {
    const p = sessionPath(id)
    if (!p) return null
    try {
      // Single async read (no existsSync TOCTOU, no event-loop block in the
      // /sessions loop): ENOENT → missing; any other read/parse error → missing.
      return fromMarkdown(await readFile(p, 'utf8'))
    } catch {
      return null // missing / corrupt / unreadable → treat as missing
    }
  }

  // M5 — serialize writes per id so two concurrent PUTs can't both pass the
  // staleness check and clobber (TOCTOU). Each id has a tail promise we chain on.
  const locks = new Map()
  function withLock(id, fn) {
    const prev = locks.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const guarded = next.catch(() => {})
    locks.set(id, guarded)
    // Drop the entry once this tail settles IF nothing newer chained on after us,
    // so the Map can't grow unbounded over long uptime (many distinct ids).
    guarded.then(() => {
      if (locks.get(id) === guarded) locks.delete(id)
    })
    return next
  }

  const app = express()
  app.use(cors({ origin: true })) // M3 — reflect origin + answer OPTIONS preflight
  app.use(express.json({ limit: '12mb' }))

  // Slugs + savedAt for a future "continue session" picker.
  app.get('/sessions', async (_req, res) => {
    try {
      const files = await readdir(sessionsDir)
      const out = []
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        const p = await readStored(f.slice(0, -3))
        if (p) out.push({ sessionId: p.sessionId, name: p.campaign?.name ?? '', savedAt: p.savedAt })
      }
      res.json(out)
    } catch {
      res.json([])
    }
  })

  app.get('/session/:id', async (req, res) => {
    const id = req.params.id
    if (!sessionPath(id)) return res.status(400).json({ error: 'invalid id' })
    const stored = await readStored(id)
    if (!stored) return res.status(404).json({ error: 'not found' })
    // ?since=<ISO> — skip shipping the full history when unchanged (perf).
    if (req.query.since && stored.savedAt === req.query.since) return res.status(304).end()
    res.json(stored)
  })

  app.put('/session/:id', (req, res, next) => {
    const id = req.params.id
    if (!sessionPath(id)) return res.status(400).json({ error: 'invalid id' })
    const body = req.body
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid body' })

    return withLock(id, async () => {
      const stored = await readStored(id)
      // Staleness (LWW): the client must base its write on the stored savedAt.
      // A mismatch means someone else wrote since → 409, no clobber (M5).
      if (stored?.savedAt && body.savedAt !== stored.savedAt) {
        res.status(409).json({ savedAt: stored.savedAt })
        return
      }
      const savedAt = new Date().toISOString() // server-stamped (clock-skew safe)
      const payload = serializeSession(
        {
          // sessionId is taken from the path (already validated), never trusted from body.
          campaign: { ...(body.campaign ?? {}), sessionId: id },
          messages: body.messages,
          sessionLog: body.sessionLog,
          party: body.party,
        },
        savedAt
      )
      const p = sessionPath(id)
      const tmp = `${p}.${randomUUID()}.tmp`
      await writeFile(tmp, toMarkdown(payload), 'utf8')
      await rename(tmp, p) // atomic swap — a crash never leaves a half-written file
      res.json({ savedAt })
    }).catch(next)
  })

  // handleNewSession server-clear (SHOULD-FIX, cheap to include).
  app.delete('/session/:id', (req, res, next) => {
    const id = req.params.id
    const p = sessionPath(id)
    if (!p) return res.status(400).json({ error: 'invalid id' })
    return withLock(id, async () => {
      try {
        await unlink(p)
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err // already gone is success; other errors bubble
      }
      res.status(204).end()
    }).catch(next)
  })

  // Error middleware last — bad JSON from express.json(), write failures, etc.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return
    const bad = err?.type === 'entity.parse.failed' || err?.status === 400
    res.status(bad ? 400 : 500).json({ error: bad ? 'invalid JSON' : 'server error' })
  })

  return app
}

// Start only when run directly (not when imported by tests).
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const PORT = process.env.SYNC_PORT || 3001
  await mkdir(DEFAULT_DIR, { recursive: true })
  createSyncServer().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`dnd-claude sync server listening on http://0.0.0.0:${PORT}`)
  })
}
