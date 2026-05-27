import { useState, useEffect } from 'react'
import CampaignSetup from './components/ApiKeySetup'
import Chat from './components/Chat'
import { serializeSession } from './lib/session'
import { makeRoomCode } from './lib/session'
import { buildCharacter } from './lib/characterBuilder'

// Genre drives the visual theme — there is no independent theme toggle.
const THEME_FOR_GENRE = { dnd: 'dnd', starwars: 'void' }

const DEFAULT_CHARACTER = {
  name: 'Adventurer',
  race: 'Human',
  charClass: 'Fighter',
  hpCurrent: 20,
  hpMax: 20,
  ac: 15,
  initiative: 2,
  speed: 30,
  abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
  conditions: [],
}

// DEFAULT_PARTY is the display-cache seed used when no prior data exists.
// The LLM overwrites it after the first response; this prevents a blank strip.
const DEFAULT_PARTY = [
  {
    id: 'seed-0',
    name: 'Adventurer',
    role: 'Fighter',
    hpPct: 100,
    isActive: true,
  },
]

function loadCharacter() {
  try {
    const stored = localStorage.getItem('dnd_character')
    if (stored) return { ...DEFAULT_CHARACTER, ...JSON.parse(stored) }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_CHARACTER
}

// loadParty() migration:
// 1. Return dnd_party if present and parseable.
// 2. Else derive a single-member seed from dnd_character.
// 3. Else return DEFAULT_PARTY.
// dnd_character is never deleted — this is a read-only migration.
function loadParty() {
  try {
    const stored = localStorage.getItem('dnd_party')
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch {
    // fall through to migration
  }
  try {
    const charStored = localStorage.getItem('dnd_character')
    if (charStored) {
      const c = JSON.parse(charStored)
      const hpPct =
        c.hpMax > 0
          ? Math.max(0, Math.min(100, Math.round((c.hpCurrent / c.hpMax) * 100)))
          : 100
      return [
        {
          id: 'seed-0',
          name: c.name || DEFAULT_CHARACTER.name,
          role: c.charClass || DEFAULT_CHARACTER.charClass,
          hpPct,
          isActive: true,
        },
      ]
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_PARTY
}

// Stable per-campaign sync identity (M1). Minted once and persisted; reused on
// every boot. Used as the cross-device sync key — must NOT be a name slug (slug
// collisions) nor minted per-device (split-brain: each device writes a different
// file and silently never finds the session).
function loadSessionId() {
  let id = localStorage.getItem('dnd_session_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('dnd_session_id', id)
  }
  return id
}

// Read ?room= from the current URL, if present. Safe across SSR/test environments.
function readRoomParam() {
  try {
    const search =
      typeof window !== 'undefined' ? window.location.search : ''
    const params = new URLSearchParams(search)
    const r = params.get('room')
    return r && r.trim() ? r.trim() : null
  } catch {
    return null
  }
}

export default function App() {
  // Phase 4: read ?room= once on mount — if present the user is joining an
  // existing session. This does NOT auto-boot single-player (ready stays false
  // until the join form is submitted or the user creates a new campaign).
  // SINGLE-PLAYER DEFAULT: when there is NO ?room= the urlRoomCode is null and
  // the entire multiplayer branch is dormant — byte-for-byte identical to before.
  const [urlRoomCode] = useState(() => readRoomParam())

  // The app ALWAYS opens on the setup screen on every boot — no auto-resume of the
  // last session. A campaign only loads via a freshly created campaign, a loaded
  // .md restore, or a ?room= join (which still routes through the join form because
  // that path keys off urlRoomCode, not `ready`).
  const [ready, setReady] = useState(false)
  const [campaign, setCampaign] = useState(() => ({
    genre: localStorage.getItem('dnd_genre') || 'dnd',
    name: localStorage.getItem('dnd_campaign_name') || '',
    details: localStorage.getItem('dnd_campaign_details') || '',
    model: localStorage.getItem('dnd_model') || 'qwen2.5:14b',
    context: localStorage.getItem('dnd_campaign_context') || '',
    sessionId: loadSessionId(),
  }))
  const [character, setCharacter] = useState(loadCharacter)
  // party is LLM-driven (display cache). loadParty() migrates from dnd_character on first boot.
  const [party, setParty] = useState(loadParty)
  // Tracks the genre selected on the setup screen so the theme previews before "Begin".
  const [draftGenre, setDraftGenre] = useState(campaign.genre)

  // Phase 4: multiplayer identity. Only set when the user actively joins or creates
  // a room with a displayName. Null means single-player mode — no WS is opened.
  const [roomCode, setRoomCode] = useState(null)
  const [displayName, setDisplayName] = useState(null)

  // Reflect the active genre onto <html data-theme> so App.css theme blocks apply.
  useEffect(() => {
    const activeGenre = ready ? campaign.genre : draftGenre
    document.documentElement.dataset.theme = THEME_FOR_GENRE[activeGenre] || 'dnd'
  }, [ready, campaign.genre, draftGenre])

  function handleSetup({ genre, name, details, model, context, displayName: dn, character: wizardOutput }) {
    localStorage.setItem('dnd_genre', genre)
    localStorage.setItem('dnd_campaign_name', name)
    localStorage.setItem('dnd_campaign_details', details)
    localStorage.setItem('dnd_model', model)
    localStorage.setItem('dnd_campaign_context', context)
    // Clean slate: mint a FRESH sessionId and persist it so the sync server can't
    // re-pull the prior session under the old id. Drop the persisted session payload
    // for the same reason.
    const sessionId = crypto.randomUUID()
    localStorage.setItem('dnd_session_id', sessionId)
    localStorage.removeItem('dnd_session')
    const rc = makeRoomCode(sessionId)
    setCampaign({ genre, name, details, model, context, sessionId })

    // Phase 5 & 6: if the wizard produced output, build the full character and seed
    // the party display cache. Otherwise reset identity to the defaults so a freshly
    // created campaign never inherits the previous character/party.
    if (wizardOutput) {
      const builtChar = buildCharacter(wizardOutput, genre)
      localStorage.setItem('dnd_character', JSON.stringify(builtChar))
      const partyEntry = [{
        id: 'seed-0',
        name: builtChar.name,
        role: builtChar.charClass,
        hpPct: 100,
        isActive: true,
      }]
      localStorage.setItem('dnd_party', JSON.stringify(partyEntry))
      setCharacter(builtChar)
      setParty(partyEntry)
    } else {
      localStorage.removeItem('dnd_character')
      localStorage.removeItem('dnd_party')
      setCharacter(DEFAULT_CHARACTER)
      setParty(DEFAULT_PARTY)
    }

    // Phase 4: if the host supplied a display name, enter multiplayer mode.
    // Otherwise stay single-player (roomCode/displayName remain null → no WS opened).
    if (dn && dn.trim()) {
      setRoomCode(rc)
      setDisplayName(dn.trim())
    } else {
      setRoomCode(null)
      setDisplayName(null)
    }
    setReady(true)
  }

  // Phase 4: join an existing room by roomCode + displayName.
  // The join screen resolves sessionId by querying GET /sessions and filtering by
  // roomCode. If resolution fails the join form can fall back to passing null
  // (the WS server will reject with invalid_room, surfaced to the user).
  //
  // mp-character-sync: the locked contract adds an optional `character` field
  // (SyncedCharacter | null). When provided, it is applied to the character state so
  // Chat can forward it to useWebSocket as joinCharacter. When null, the existing
  // loadCharacter() / DEFAULT_CHARACTER fallback keeps its value (no overwrite).
  async function handleJoin({ roomCode: rc, displayName: dn, sessionId: sid, character: joinedCharacter }) {
    // Use the resolved sessionId as the campaign's session identity.
    const sessionId = sid || loadSessionId()
    const restored = {
      genre: localStorage.getItem('dnd_genre') || 'dnd',
      name: localStorage.getItem('dnd_campaign_name') || '',
      details: localStorage.getItem('dnd_campaign_details') || '',
      model: localStorage.getItem('dnd_model') || 'qwen2.5:14b',
      context: localStorage.getItem('dnd_campaign_context') || '',
      sessionId,
    }
    localStorage.setItem('dnd_session_id', sessionId)
    setCampaign(restored)
    setRoomCode(rc)
    setDisplayName(dn.trim())
    // Apply the joiner's character if provided. Merge with DEFAULT_CHARACTER so
    // all required fields (hpCurrent, initiative, speed) remain intact.
    if (joinedCharacter) {
      setCharacter(prev => ({ ...DEFAULT_CHARACTER, ...prev, ...joinedCharacter }))
    }
    // When joinedCharacter is null, the existing character state (from loadCharacter()
    // or a prior session) remains unchanged — no overwrite.
    setReady(true)
  }

  // Phase A2: restore a full session from a loaded .md file (one that contains a
  // ```session block). Persists through the same localStorage keys Chat hydrates
  // from, adopts the file's campaign (incl. its sessionId — M2), and boots
  // straight into play, skipping the setup form.
  function handleRestoreSession(payload) {
    const c = payload.campaign ?? {}
    const sessionId = c.sessionId || loadSessionId()
    const restored = {
      genre: c.genre || 'dnd',
      name: c.name || '',
      details: c.details || '',
      model: c.model || 'qwen2.5:14b',
      context: c.context || '',
      sessionId,
    }
    localStorage.setItem('dnd_genre', restored.genre)
    localStorage.setItem('dnd_campaign_name', restored.name)
    localStorage.setItem('dnd_campaign_details', restored.details)
    localStorage.setItem('dnd_model', restored.model)
    localStorage.setItem('dnd_campaign_context', restored.context)
    localStorage.setItem('dnd_session_id', sessionId)
    localStorage.setItem(
      'dnd_session',
      JSON.stringify(
        serializeSession(
          { campaign: restored, messages: payload.messages, sessionLog: payload.sessionLog, party: payload.party },
          payload.savedAt
        )
      )
    )
    if (payload.party?.length) localStorage.setItem('dnd_party', JSON.stringify(payload.party))
    setCampaign(restored)
    if (payload.party?.length) setParty(payload.party)
    // Restoring a .md always boots single-player (no displayName prompt here).
    setRoomCode(null)
    setDisplayName(null)
    setReady(true)
  }

  function handleReset() {
    setRoomCode(null)
    setDisplayName(null)
    setReady(false)
  }

  if (!ready) {
    return (
      <CampaignSetup
        onSetup={handleSetup}
        onJoin={handleJoin}
        onGenreChange={setDraftGenre}
        onRestoreSession={handleRestoreSession}
        urlRoomCode={urlRoomCode}
      />
    )
  }

  return (
    <Chat
      campaign={campaign}
      onReset={handleReset}
      character={character}
      setCharacter={setCharacter}
      party={party}
      setParty={setParty}
      roomCode={roomCode}
      displayName={displayName}
    />
  )
}
