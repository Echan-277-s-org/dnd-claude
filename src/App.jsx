import { useState } from 'react'
import CampaignSetup from './components/ApiKeySetup'
import Chat from './components/Chat'

export default function App() {
  const [ready, setReady] = useState(() => !!localStorage.getItem('dnd_setup_done'))
  const [campaign, setCampaign] = useState(() => ({
    name: localStorage.getItem('dnd_campaign_name') || '',
    details: localStorage.getItem('dnd_campaign_details') || '',
    model: localStorage.getItem('dnd_model') || 'qwen2.5:14b',
    context: localStorage.getItem('dnd_campaign_context') || '',
  }))

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

  return <Chat campaign={campaign} onReset={handleReset} />
}
