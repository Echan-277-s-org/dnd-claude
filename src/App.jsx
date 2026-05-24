import { useState, useEffect } from 'react'
import CampaignSetup from './components/ApiKeySetup'
import Chat from './components/Chat'

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

export default function App() {
  const [ready, setReady] = useState(() => !!localStorage.getItem('dnd_setup_done'))
  const [campaign, setCampaign] = useState(() => ({
    genre: localStorage.getItem('dnd_genre') || 'dnd',
    name: localStorage.getItem('dnd_campaign_name') || '',
    details: localStorage.getItem('dnd_campaign_details') || '',
    model: localStorage.getItem('dnd_model') || 'qwen2.5:14b',
    context: localStorage.getItem('dnd_campaign_context') || '',
  }))
  const [character, setCharacter] = useState(loadCharacter)
  // party is LLM-driven (display cache). loadParty() migrates from dnd_character on first boot.
  const [party, setParty] = useState(loadParty)
  // Tracks the genre selected on the setup screen so the theme previews before "Begin".
  const [draftGenre, setDraftGenre] = useState(campaign.genre)

  // Reflect the active genre onto <html data-theme> so App.css theme blocks apply.
  useEffect(() => {
    const activeGenre = ready ? campaign.genre : draftGenre
    document.documentElement.dataset.theme = THEME_FOR_GENRE[activeGenre] || 'dnd'
  }, [ready, campaign.genre, draftGenre])

  function handleSetup({ genre, name, details, model, context }) {
    localStorage.setItem('dnd_setup_done', '1')
    localStorage.setItem('dnd_genre', genre)
    localStorage.setItem('dnd_campaign_name', name)
    localStorage.setItem('dnd_campaign_details', details)
    localStorage.setItem('dnd_model', model)
    localStorage.setItem('dnd_campaign_context', context)
    setCampaign({ genre, name, details, model, context })
    setReady(true)
  }

  function handleReset() {
    localStorage.removeItem('dnd_setup_done')
    setReady(false)
  }

  if (!ready) {
    return <CampaignSetup onSetup={handleSetup} onGenreChange={setDraftGenre} />
  }

  return (
    <Chat
      campaign={campaign}
      onReset={handleReset}
      character={character}
      setCharacter={setCharacter}
      party={party}
      setParty={setParty}
    />
  )
}
