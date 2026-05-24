import { useState } from 'react'
import CampaignSetup from './components/ApiKeySetup'
import Chat from './components/Chat'

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

function loadCharacter() {
  try {
    const stored = localStorage.getItem('dnd_character')
    if (stored) return { ...DEFAULT_CHARACTER, ...JSON.parse(stored) }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_CHARACTER
}

export default function App() {
  const [ready, setReady] = useState(() => !!localStorage.getItem('dnd_setup_done'))
  const [campaign, setCampaign] = useState(() => ({
    name: localStorage.getItem('dnd_campaign_name') || '',
    details: localStorage.getItem('dnd_campaign_details') || '',
    model: localStorage.getItem('dnd_model') || 'qwen2.5:14b',
    context: localStorage.getItem('dnd_campaign_context') || '',
  }))
  const [character, setCharacter] = useState(loadCharacter)

  function handleSetup({ name, details, model, context }) {
    localStorage.setItem('dnd_setup_done', '1')
    localStorage.setItem('dnd_campaign_name', name)
    localStorage.setItem('dnd_campaign_details', details)
    localStorage.setItem('dnd_model', model)
    localStorage.setItem('dnd_campaign_context', context)
    setCampaign({ name, details, model, context })
    setReady(true)
  }

  function handleReset() {
    localStorage.removeItem('dnd_setup_done')
    setReady(false)
  }

  if (!ready) {
    return <CampaignSetup onSetup={handleSetup} />
  }

  return (
    <Chat
      campaign={campaign}
      onReset={handleReset}
      character={character}
      setCharacter={setCharacter}
    />
  )
}
