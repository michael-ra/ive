import { useState } from 'react'
import { useHomeStart } from '../components/home/HomeStartControls'
import ContinueWork from '../components/home/ContinueWork'
import { currentProjectId } from '../lib/quickStart'
import { getLanguage } from '../lib/i18n'
import '../lib/i18n/shell'

// Scaffold stub: date, the composer (Enter starts a session in the current
// project or the start folder) and the recent sessions. The home agent
// replaces this with chips, "Needs you", recent sessions and projects.
export default function HomeScreen({ onPlan, onAddProject, onFindProject, onOpenPanel, onOpenSession, onReviewTask }) {
  const [text, setText] = useState('')
  const homeStart = useHomeStart()
  void onPlan
  void onAddProject
  void onFindProject
  void onOpenSession
  void onReviewTask
  const today = new Date().toLocaleDateString(getLanguage() === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

  const submit = async (e) => {
    e?.preventDefault()
    if (homeStart.busy) return
    if (await homeStart.start({ text, workspaceId: currentProjectId() })) setText('')
  }

  return (
    <div className="ive-home flex-1 overflow-y-auto" data-home-screen="">
      <h1 className="sr-only">Home</h1>
      <div className="ive-home-inner">
        <p className="t-meta ive-home-date">{today}</p>
        <form className="x-composer ive-home-composer" onSubmit={submit}>
          <textarea
            data-home-composer
            aria-label="What do you want to work on?"
            placeholder="What do you want to work on? Type / for commands, @ for files"
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e) }
            }}
          />
          <div className="ive-home-composer-row">
            <span className="ive-header-fill" />
            <button type="submit" data-home-start className="ive-btn ive-btn--primary" disabled={homeStart.busy || !text.trim()}>Start</button>
          </div>
        </form>
        <ContinueWork onAction={onOpenPanel} />
      </div>
    </div>
  )
}
