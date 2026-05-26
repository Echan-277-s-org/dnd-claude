// ─── session.js — one serialize layer, three surfaces ─────────────────────────
// The SAME payload shape feeds localStorage (Phase A), the .md file (Phase A2),
// and the LAN sync server (Phase B). Defined once here so the three surfaces
// can never drift. All functions are pure (no React) and defensive (never throw
// on bad input — return null / a safe default), mirroring the parser in Chat.jsx.
//
// Payload shape (schemaVersion 1):
//   { sessionId, schemaVersion, savedAt,
//     campaign: { name, genre, details, context, model, sessionId },
//     messages: [...], sessionLog: [...], party: [...] }
//
// Excluded by design: `entities` (re-derived via extractEntities — a pure
// function of messages) and `pendingCheck` (session-only; surfaced as a prose
// line by toMarkdown so an LLM still sees it, but never machine-restored in v1).

export const SCHEMA_VERSION = 1

// Campaign fields that travel with a session. Anything outside this list
// (e.g. transient UI flags) is intentionally dropped.
const CAMPAIGN_KEYS = ['name', 'genre', 'details', 'context', 'model', 'sessionId']

// ─── LAN host helper (DRY — replaces inline window.location.hostname) ─────────
// Used for both the Ollama host (Chat.jsx) and the sync server. Falls back to
// localhost when there is no window (tests / SSR).
export function getLanHost(port) {
  const host =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : 'localhost'
  return port != null ? `${host}:${port}` : host
}

function pickCampaign(campaign) {
  const c = campaign ?? {}
  const out = {}
  for (const k of CAMPAIGN_KEYS) {
    if (c[k] != null) out[k] = c[k]
  }
  return out
}

// ─── serialize / deserialize — the canonical payload ──────────────────────────

// Build a payload from live app state. `savedAt` may be supplied (server-stamped)
// or defaults to now. `sessionId` comes from the campaign (minted at setup).
export function serializeSession(state, savedAt) {
  const { campaign, messages, sessionLog, party } = state ?? {}
  return {
    sessionId: campaign?.sessionId ?? null,
    schemaVersion: SCHEMA_VERSION,
    savedAt: savedAt ?? new Date().toISOString(),
    campaign: pickCampaign(campaign),
    messages: Array.isArray(messages) ? messages : [],
    sessionLog: Array.isArray(sessionLog) ? sessionLog : [],
    party: Array.isArray(party) ? party : [],
  }
}

// Parse a stored payload (string or object) back into a normalized payload.
// Returns null on any failure or an incompatible schemaVersion — callers keep
// their last-known state (same contract as the structured-block parser).
export function deserializeSession(raw) {
  if (raw == null) return null
  let obj
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  if (obj.schemaVersion !== SCHEMA_VERSION) return null
  return {
    sessionId: obj.sessionId ?? obj.campaign?.sessionId ?? null,
    schemaVersion: SCHEMA_VERSION,
    savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : null,
    campaign: pickCampaign(obj.campaign),
    messages: Array.isArray(obj.messages) ? obj.messages : [],
    sessionLog: Array.isArray(obj.sessionLog) ? obj.sessionLog : [],
    party: Array.isArray(obj.party) ? obj.party : [],
  }
}

// ─── Dice-chip hydration guard (H4) ──────────────────────────────────────────
// A saved session naturally ends on an unresolved roll. On restore that bare
// dice chip would be the verdict parser's "most-recent dice with verdict==null"
// target, so the NEXT turn's verdict block would stamp PASS/FAIL onto an old,
// unrelated roll (often scrolled off-screen — invisible corruption). Mark every
// restored bare dice message `orphaned` so the parser skips it; fresh in-session
// rolls have no flag and resolve normally. Pure, reused by both restore surfaces
// (Chat.jsx hydrate + useSessionPersistence adopt).
export function markOrphanedDice(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map(m =>
    m?.role === 'dice' && m.verdict == null ? { ...m, orphaned: true } : m
  )
}

// ─── Markdown (Phase A2) — self-contained, LLM-loadable handoff ───────────────

// A short slug for filenames (campaign name → kebab). Display/label only.
export function campaignToSessionId(name) {
  return (
    String(name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'session'
  )
}

// Suggested download filename for a save, e.g. "jaycen-hawke-2026-05-25.md".
export function sessionFileName(campaign, savedAt) {
  const date = (savedAt ?? new Date().toISOString()).slice(0, 10)
  return `${campaignToSessionId(campaign?.name)}-${date}.md`
}

// First 1–3 sentences of the latest GM line — the "where we are" recap.
function deriveRecap(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.content && !m.error) {
      const text = m.content.replace(/\s+/g, ' ').trim()
      const sentences = text.match(/[^.!?]+[.!?]+/g)
      const recap = sentences ? sentences.slice(0, 2).join(' ').trim() : text
      return recap.length > 400 ? recap.slice(0, 397) + '…' : recap
    }
  }
  return '_(No narration yet — the session is just beginning.)_'
}

function partyTable(party) {
  if (!party?.length) return '_(No party members tracked.)_'
  const rows = party.map(
    m =>
      `| ${m.name || '—'} | ${m.role || '—'} | ${m.hpPct == null ? '—' : m.hpPct + '%'} | ${m.isActive ? '▶' : ''} |`
  )
  return ['| Name | Role | HP | Turn |', '|------|------|----|------|', ...rows].join('\n')
}

function transcript(messages) {
  const lines = messages
    .map(m => {
      if (m.role === 'user') return `**You:** ${m.content}`
      if (m.role === 'assistant') {
        if (!m.content) return null
        return `**GM:** ${m.content}`
      }
      if (m.role === 'dice') {
        const base = `> 🎲 ${m.die} → ${m.result}`
        if (m.check && m.verdict) return `${base} · ${m.check} → **${m.verdict}**`
        return base
      }
      return null
    })
    .filter(Boolean)
  return lines.length ? lines.join('\n\n') : '_(No messages yet.)_'
}

// Render a payload as a self-contained Markdown handoff. The prose is a complete
// DM brief; the trailing ```session fence is the lossless machine payload.
// `pendingCheck` (session-only) is accepted purely to surface it as a prose line.
export function toMarkdown(payload, pendingCheck) {
  const p = payload ?? {}
  const c = p.campaign ?? {}
  const meta = [
    `saved ${p.savedAt ?? new Date().toISOString()}`,
    `genre: ${c.genre ?? '—'}`,
    `model: ${c.model ?? '—'}`,
    `sessionId: ${p.sessionId ?? c.sessionId ?? '—'}`,
  ].join(' · ')

  const notesRef = c.name
    ? ` Pair this with the campaign notes (\`campaigns/${campaignToSessionId(c.name)}.md\`).`
    : ''

  const pendingLine =
    pendingCheck?.skill && pendingCheck?.dc != null
      ? `\n**Pending check:** ${pendingCheck.skill} DC ${pendingCheck.dc}\n`
      : ''

  const block = JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      sessionId: p.sessionId ?? c.sessionId ?? null,
      savedAt: p.savedAt ?? new Date().toISOString(),
      campaign: pickCampaign(c),
      messages: p.messages ?? [],
      sessionLog: p.sessionLog ?? [],
      party: p.party ?? [],
    },
    null,
    2
  )

  return `# Session — ${c.name || 'Untitled Campaign'}
<!-- ${meta} -->

## Continue from here
You are the Game Master. Below is the story so far and the current state — pick up as DM from the last line.${notesRef}

## Where we are
${deriveRecap(p.messages ?? [])}

## Party
${partyTable(p.party ?? [])}
${pendingLine}
## Transcript
${transcript(p.messages ?? [])}

\`\`\`session
${block}
\`\`\`
`
}

// Extract & parse the ```session block from a Markdown file. Returns a
// normalized payload (via deserializeSession) or null if the file has no valid
// block — letting "Load .md file" fall back to today's prose→context behavior.
export function fromMarkdown(text) {
  if (typeof text !== 'string') return null
  const match = text.match(/```session\s*([\s\S]*?)```/)
  if (!match) return null
  return deserializeSession(match[1].trim())
}

// ─── Sync API (Phase B) — talks to the LAN sync server ────────────────────────
// All network calls are wrapped so a down/unreachable server degrades gracefully
// (returns null / a status object) rather than throwing — the app stays usable
// on localStorage + .md alone.

const SYNC_PORT = 3001

function syncUrl(path) {
  return `http://${getLanHost(SYNC_PORT)}${path}`
}

const safeId = id => /^[A-Za-z0-9_-]{1,128}$/.test(String(id ?? ''))

// Fetch a session by id. Returns the payload, or null (404 / network error /
// invalid id). Pass `since` (ISO) to short-circuit when unchanged → returns
// { unchanged: true } so the poller can skip a redundant overwrite.
export async function loadSyncSession(id, since) {
  if (!safeId(id)) return null
  try {
    const qs = since ? `?since=${encodeURIComponent(since)}` : ''
    const res = await fetch(syncUrl(`/session/${id}${qs}`))
    if (res.status === 304) return { unchanged: true }
    if (!res.ok) return null
    return deserializeSession(await res.json())
  } catch {
    return null // server down — caller keeps local state
  }
}

// Push a payload. Returns { ok, savedAt } on success, { conflict: true,
// savedAt } on a 409 stale write, or { ok: false } on network error.
export async function saveSyncSession(payload) {
  const id = payload?.sessionId
  if (!safeId(id)) return { ok: false }
  try {
    const res = await fetch(syncUrl(`/session/${id}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}))
      return { ok: false, conflict: true, savedAt: body.savedAt ?? null }
    }
    if (!res.ok) return { ok: false }
    const body = await res.json().catch(() => ({}))
    return { ok: true, savedAt: body.savedAt ?? null }
  } catch {
    return { ok: false }
  }
}

// Delete a session on the server (called when the user starts a new session, so
// another device's poll can't resurrect the cleared session). Degrades silently
// — a down server just means the stale copy lingers until it's overwritten.
export async function deleteSyncSession(id) {
  if (!safeId(id)) return { ok: false }
  try {
    const res = await fetch(syncUrl(`/session/${id}`), { method: 'DELETE' })
    return { ok: res.ok }
  } catch {
    return { ok: false }
  }
}

// Poll for a newer save every `intervalMs`. Calls onNewer(payload) when the
// server's savedAt advances past `getSavedAt()`. Returns a cleanup function.
export function pollSyncSession(id, getSavedAt, onNewer, intervalMs = 30000) {
  if (!safeId(id)) return () => {}
  let cancelled = false
  const tick = async () => {
    const result = await loadSyncSession(id, getSavedAt())
    if (cancelled || !result || result.unchanged) return
    if (result.savedAt && result.savedAt !== getSavedAt()) onNewer(result)
  }
  const handle = setInterval(tick, intervalMs)
  return () => {
    cancelled = true
    clearInterval(handle)
  }
}
