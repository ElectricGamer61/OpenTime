import { useState } from 'react'

import { Wordmark } from './components/Brand'
import { duration } from './lib/format'
import { useOpenTime } from './state/useOpenTime'
import { ProjectsView } from './views/ProjectsView'
import { SettingsView } from './views/SettingsView'
import { TodayView } from './views/TodayView'
import { WeekView } from './views/WeekView'

type Tab = 'today' | 'week' | 'projects' | 'settings'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'projects', label: 'Projects & rules' },
  { id: 'settings', label: 'Settings' },
]

export function App() {
  const app = useOpenTime()
  const [tab, setTab] = useState<Tab>('today')

  if (!app.ready) {
    return (
      <div className="app">
        <nav className="rail">
          <Wordmark />
        </nav>
        <main className="main">
          <div className="empty">Loading your day…</div>
        </main>
      </div>
    )
  }

  const status = app.status

  return (
    <div className="app">
      <nav className="rail">
        <Wordmark />
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <i className="dot" />
            {t.label}
          </button>
        ))}

        <div className="rail-footer">
          <div>
            {status?.paused
              ? 'Paused'
              : status?.mode === 'active'
                ? 'Tracking'
                : 'Idle — waiting for input'}
          </div>
          <div>{status?.captureAdapter}</div>
          {status?.stretchStart ? (
            <div>{duration((Date.now() - status.stretchStart) / 1000)} in this stretch</div>
          ) : null}
          <div>v{app.appVersion}</div>
        </div>
      </nav>

      <main className="main">
        {tab === 'today' ? <TodayView app={app} /> : null}
        {tab === 'week' ? <WeekView app={app} /> : null}
        {tab === 'projects' ? <ProjectsView app={app} /> : null}
        {tab === 'settings' ? <SettingsView app={app} /> : null}
      </main>
    </div>
  )
}
