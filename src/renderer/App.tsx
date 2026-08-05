import type { ComponentType } from 'react'
import { useState } from 'react'

import { Wordmark } from './components/Brand'
import { Empty } from './components/Empty'
import { IconProjects, IconSettings, IconToday, IconWeek } from './components/Icons'
import { Onboarding } from './components/Onboarding'
import { duration } from './lib/format'
import type { OpenTimeState } from './state/useOpenTime'
import { useNow, useOpenTime } from './state/useOpenTime'
import { ProjectsView } from './views/ProjectsView'
import { SettingsView } from './views/SettingsView'
import { TodayView } from './views/TodayView'
import { WeekView } from './views/WeekView'

type Tab = 'today' | 'week' | 'projects' | 'settings'

const TABS: Array<{ id: Tab; label: string; Icon: ComponentType<{ className?: string }> }> = [
  { id: 'today', label: 'Today', Icon: IconToday },
  { id: 'week', label: 'This week', Icon: IconWeek },
  { id: 'projects', label: 'Projects & rules', Icon: IconProjects },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
]

export function App() {
  const app = useOpenTime()
  const [tab, setTab] = useState<Tab>('today')

  // "Click a day to open it" has to mean it: selecting a day from the weekly
  // view both loads that day and lands on the view that shows it.
  const openDay = (key: string) => {
    app.selectDay(key)
    setTab('today')
  }

  if (!app.ready) {
    return (
      <div className="app">
        <nav className="rail">
          <Wordmark />
        </nav>
        <main className="main">
          <div style={{ paddingTop: 120 }}>
            <Empty title="Opening your day…" hint="Reading today's sessions from local storage." />
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app">
      {app.firstRun ? <Onboarding app={app} /> : null}
      <nav className="rail">
        <Wordmark />
        <div className="rail-section">Workspace</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item${tab === t.id ? ' active' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            <t.Icon className="nav-icon" />
            {t.label}
          </button>
        ))}

        <RailFooter app={app} />
      </nav>

      {/* Keying on the tab remounts the subtree, which is what triggers the
          view-in transition — the point being that switching reads as a move
          rather than a repaint. */}
      <main className="main">
        <div className="view" key={tab}>
          {tab === 'today' ? <TodayView app={app} /> : null}
          {tab === 'week' ? <WeekView app={app} onOpenDay={openDay} /> : null}
          {tab === 'projects' ? <ProjectsView app={app} /> : null}
          {tab === 'settings' ? <SettingsView app={app} /> : null}
        </div>
      </main>
    </div>
  )
}

/**
 * The always-on status block at the bottom of the rail: what the engine is
 * doing, what it is doing it with, and how long the current unbroken stretch
 * has run. It owns its own tick so the rest of the shell never re-renders.
 */
function RailFooter({ app }: { app: OpenTimeState }) {
  const now = useNow(1000)
  const status = app.status
  const state = status?.paused ? 'paused' : status?.mode === 'active' ? 'tracking' : 'idle'
  const stretchSeconds = status?.stretchStart ? (now - status.stretchStart) / 1000 : 0

  return (
    <div className="rail-footer">
      <div className={`rail-status ${state}`}>
        <i className="beat" />
        {state === 'paused' ? 'Paused' : state === 'tracking' ? 'Tracking' : 'Waiting for input'}
      </div>
      {/* Only shown once the stretch is worth a number: below a minute
          `duration()` renders an em dash, which reads as an error rather than
          as "just started". */}
      {stretchSeconds >= 60 && state !== 'paused' ? (
        <div className="rail-meta">
          <span>This stretch</span>
          <span>{duration(stretchSeconds)}</span>
        </div>
      ) : null}
      {/* A timed pause is easy to forget you set; the rail is where you would
          notice it. */}
      {status?.pausedUntil ? (
        <div className="rail-meta">
          <span>Resumes</span>
          <span>
            {new Date(status.pausedUntil).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      ) : null}
      <div className="rail-meta">
        <span>Capture</span>
        <span title={status?.captureAdapter}>{status?.captureAdapter ?? '—'}</span>
      </div>
      <div className="rail-meta">
        <span>OpenTime</span>
        <span>v{app.appVersion}</span>
      </div>
    </div>
  )
}
