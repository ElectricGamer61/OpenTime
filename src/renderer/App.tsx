import type { ComponentType } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { BrandMark } from './components/Brand'
import { Empty } from './components/Empty'
import { FocusMode } from './components/Focus'
import {
  IconActivity,
  IconCalendar,
  IconChevronDown,
  IconClock,
  IconCollapse,
  IconDashboard,
  IconFocus,
  IconFolder,
  IconInfo,
  IconPause,
  IconPencil,
  IconRefresh,
  IconSettings,
  IconTarget,
  IconWeek,
} from './components/Icons'
import { MusicPlayerControl } from './components/MusicPlayer'
import { Onboarding } from './components/Onboarding'
import { focusProgress } from '../core/focus'
import type { RangeKind } from '../core/range'
import type { FeedbackKind } from '../shared/ipc'
import { clock, duration } from './lib/format'
import { useMusicPlayer } from './lib/useMusicPlayer'
import { usePomodoro } from './lib/usePomodoro'
import type { OpenTimeState } from './state/useOpenTime'
import { useNow, useOpenTime } from './state/useOpenTime'
import { ActivityView } from './views/ActivityView'
import { CalendarView } from './views/CalendarView'
import { DashboardView } from './views/DashboardView'
import { GoalsView } from './views/GoalsView'
import { ProjectsView } from './views/ProjectsView'
import { ReportsView } from './views/ReportsView'
import { SettingsView } from './views/SettingsView'

export type Tab =
  | 'dashboard'
  | 'calendar'
  | 'activity'
  | 'projects'
  | 'goals'
  | 'reports'
  | 'settings'

interface NavItem {
  id: Tab
  label: string
  Icon: ComponentType<{ className?: string }>
}

/**
 * The sidebar is grouped rather than flat: what happened, what you organise it
 * into, and what you read back out of it. Groups are separated by a hairline
 * rather than a caption — captions on a seven-item rail are noise.
 */
const NAV_GROUPS: NavItem[][] = [
  [
    { id: 'dashboard', label: 'Dashboard', Icon: IconDashboard },
    { id: 'calendar', label: 'Calendar', Icon: IconCalendar },
    { id: 'activity', label: 'Activity', Icon: IconActivity },
  ],
  [
    { id: 'projects', label: 'Projects', Icon: IconFolder },
    { id: 'goals', label: 'Goals', Icon: IconTarget },
  ],
  [
    { id: 'reports', label: 'Reports', Icon: IconWeek },
    { id: 'settings', label: 'Settings', Icon: IconSettings },
  ],
]

export function App() {
  const app = useOpenTime()
  const [tab, setTab] = useState<Tab>('calendar')
  const [collapsed, setCollapsed] = useState(false)
  const [focusSetup, setFocusSetup] = useState(false)
  /** One instance, shared by the rail control and the buttons inside Focus — see `MusicPlayer.tsx`. */
  const musicPlayer = useMusicPlayer()
  /** One instance, shared by `FocusMode` and the rail chip below — see `usePomodoro`. */
  const pomodoro = usePomodoro(app)
  /** Which range Reports opens on when the calendar sends you there. */
  const [reportRange, setReportRange] = useState<RangeKind>('week')

  // Every colour is declared once with `light-dark()`, so choosing a theme is
  // only a matter of what `color-scheme` the root resolves to: no attribute
  // means "follow the OS", and the attribute pins it. This is the one owner of
  // that attribute — see the note in AGENTS.md.
  const theme = app.settings?.theme ?? 'system'
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  if (!app.ready) {
    return (
      <div className="app">
        <Titlebar />
        <div className="shell">
          <nav className="rail" />
          <main className="main">
            <Empty title="Opening your day…" hint="Reading today's sessions from local storage." />
          </main>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`app${collapsed ? ' rail-collapsed' : ''}${app.status?.focus || pomodoro.run ? ' focus-running' : ''}`}
    >
      {app.firstRun ? <Onboarding app={app} /> : null}
      <Titlebar app={app} />

      <div className="shell">
        <nav className="rail" aria-label="Main">
          <div className="rail-top">
            <div className="rail-brand">
              <BrandMark size={22} />
              <span className="nav-label">OpenTime</span>
            </div>
            <button
              className="icon-btn rail-collapse"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <IconCollapse />
            </button>
          </div>

          <div className="rail-nav">
            {NAV_GROUPS.map((group, index) => (
              <div className="rail-group" key={index}>
                {group.map((item) => (
                  <button
                    key={item.id}
                    className={`nav-item${tab === item.id ? ' active' : ''}`}
                    aria-current={tab === item.id ? 'page' : undefined}
                    onClick={() => setTab(item.id)}
                    /* Collapsed, the label is clipped away, so the tooltip and
                       the accessible name are all that name the button. */
                    title={item.label}
                  >
                    <item.Icon className="nav-icon" />
                    <span className="nav-label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <FocusButton app={app} pomodoro={pomodoro} onStart={() => setFocusSetup(true)} />
          <div className="rail-cta rail-music">
            <MusicPlayerControl player={musicPlayer} label="Music" />
          </div>
          <RailFooter app={app} />
        </nav>

        {/* Keying on the tab remounts the subtree, which is what triggers the
            view-in transition — the point being that switching reads as a move
            rather than a repaint. */}
        <main className="main">
          <div className="view" key={tab}>
            {/* The calendar manages its own two scrolling columns; every other
                view is one ordinary scrolling page, so it gets a wrapper rather
                than each view repeating the padding and the overflow. */}
            {tab === 'calendar' ? (
              <CalendarView
                app={app}
                onCustomize={() => setTab('settings')}
                onOpenReports={(kind) => {
                  setReportRange(kind)
                  setTab('reports')
                }}
              />
            ) : (
              <div className="page">
                {tab === 'dashboard' ? (
                  <DashboardView
                    app={app}
                    onOpenCalendar={() => setTab('calendar')}
                    onStartFocus={() => setFocusSetup(true)}
                  />
                ) : null}
                {tab === 'activity' ? <ActivityView app={app} /> : null}
                {tab === 'projects' ? <ProjectsView app={app} /> : null}
                {tab === 'goals' ? (
                  <GoalsView app={app} onOpenDay={() => setTab('calendar')} />
                ) : null}
                {tab === 'reports' ? (
                  <ReportsView
                    app={app}
                    /* Keyed so arriving from the calendar's range control
                       actually re-opens on that range rather than keeping
                       whatever the view was last left on. */
                    key={reportRange}
                    initialRange={reportRange}
                    onOpenDay={() => setTab('calendar')}
                  />
                ) : null}
                {tab === 'settings' ? <SettingsView app={app} /> : null}
              </div>
            )}
          </div>
        </main>
      </div>

      <FocusMode
        app={app}
        pomodoro={pomodoro}
        musicPlayer={musicPlayer}
        open={focusSetup}
        onOpenChange={setFocusSetup}
        onOpenCalendar={() => setTab('calendar')}
      />
    </div>
  )
}

/**
 * The way into a focus session, pinned above the rail's status block.
 *
 * While one is running this becomes the countdown rather than disappearing:
 * the dock already carries the controls, and a rail that silently loses a
 * button is a rail people stop trusting to hold the same things. A running
 * Pomodoro takes priority over `app.status.focus` here on purpose — during a
 * break phase `status.focus` is genuinely empty (see `usePomodoro`), and the
 * chip has to keep showing the run rather than reverting to "Start focus".
 */
function FocusButton({
  app,
  pomodoro,
  onStart,
}: {
  app: OpenTimeState
  pomodoro: ReturnType<typeof usePomodoro>
  onStart(): void
}) {
  const now = useNow(1000)
  const focus = app.status?.focus ?? null

  if (pomodoro.run) {
    const work = pomodoro.run.phase === 'work'
    return (
      <div className="rail-cta">
        <div className={`focus-chip pomodoro-chip ${pomodoro.run.phase}`} title={pomodoro.run.label}>
          <IconFocus size={16} />
          <span className="nav-label">
            <b>{clock(pomodoro.progress?.remainingSeconds ?? 0)}</b>
            {pomodoro.run.paused ? 'paused' : work ? 'work' : 'break'}
          </span>
        </div>
      </div>
    )
  }

  if (!focus) {
    return (
      <div className="rail-cta">
        <button className="btn primary focus-start" onClick={onStart}>
          <IconFocus size={16} />
          <span className="nav-label">Start focus</span>
        </button>
      </div>
    )
  }

  const progress = focusProgress(focus, now)
  return (
    <div className="rail-cta">
      <div className="focus-chip" title={focus.label}>
        <IconFocus size={16} />
        <span className="nav-label">
          <b>{clock(progress.overrun ? progress.overrunSeconds : progress.remainingSeconds)}</b>
          {progress.overrun ? 'over' : 'left'}
        </span>
      </div>
    </div>
  )
}

const MENU_WIDTH = 248
/** Kept off the window edge so the card never looks clipped. */
const MENU_MARGIN = 8

const FEEDBACK: Array<{
  kind: FeedbackKind
  label: string
  hint: string
  Icon: ComponentType<{ size?: number }>
}> = [
  { kind: 'bug', label: 'Report a bug', hint: 'Something broke or looks wrong', Icon: IconInfo },
  { kind: 'idea', label: 'Suggest an idea', hint: 'A feature or an improvement', Icon: IconPencil },
  { kind: 'question', label: 'Ask a question', hint: 'Anything else', Icon: IconRefresh },
]

/**
 * Feedback, one click from anywhere. Each choice opens a short form on GitHub
 * in the browser; the bug form arrives with the app version and OS filled in.
 * Nothing is sent from the app itself.
 */
function FeedbackMenu({ app }: { app: OpenTimeState }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Anchored before paint, for the same reason EntryPopover is: a card that
  // appears at 0,0 and then jumps under the button reads as a glitch.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const button = wrap.current?.getBoundingClientRect()
      if (!button) return
      const width = menu.current?.offsetWidth ?? MENU_WIDTH
      setPos({
        top: button.bottom + 6,
        left: Math.max(
          MENU_MARGIN,
          Math.min(button.right - width, window.innerWidth - width - MENU_MARGIN)
        ),
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className={`titlebar-link${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span>Feedback</span>
        <IconChevronDown size={13} />
      </button>

      {/* Portalled to the body like every other overlay: fixed positioning
          is only viewport-relative outside the view's transform. */}
      {open
        ? createPortal(
            <div
              className="menu-card"
              ref={menu}
              role="menu"
              aria-label="Feedback"
              style={{ width: MENU_WIDTH, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            >
              <div className="menu-head">Opens a short form on GitHub.</div>
              {FEEDBACK.map(({ kind, label, hint, Icon }) => (
                <button
                  key={kind}
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    void app.openFeedback(kind)
                    setOpen(false)
                  }}
                >
                  <Icon size={15} />
                  <span>
                    <b>{label}</b>
                    <small>{hint}</small>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

/**
 * The window's own title bar: a drag region with live tracking state, a way
 * to leave feedback, and - only when there is one - the update. On macOS the
 * traffic lights are inset into the left of it, which is why the left slot is
 * padded rather than empty.
 */
function Titlebar({ app }: { app?: OpenTimeState }) {
  return (
    <header className="titlebar">
      <div className="titlebar-left" />
      <div />
      <div className="titlebar-right">
        {app ? (
          <>
            <UpdateChip app={app} />
            <TrackingChip app={app} />
            <FeedbackMenu app={app} />
          </>
        ) : null}
      </div>
    </header>
  )
}

/**
 * A newer version, announced where it is seen but can be ignored at no cost.
 * One click downloads it and restarts into it; the data folder is never part
 * of an update.
 */
function UpdateChip({ app }: { app: OpenTimeState }) {
  const { state, version, percent, message } = app.update
  if (state === 'available' || (state === 'error' && version)) {
    return (
      <button
        className="update-chip"
        onClick={() => void app.installUpdate()}
        title={
          state === 'error'
            ? message
            : `Download OpenTime ${version} and restart into it. Your data is kept.`
        }
      >
        {state === 'error' ? 'Update failed, retry' : `Update to ${version}`}
      </button>
    )
  }
  if (state === 'downloading') {
    return <span className="update-chip busy">Downloading update {percent ?? 0}%</span>
  }
  if (state === 'installing') {
    return <span className="update-chip busy">Restarting to update…</span>
  }
  return null
}

/** Tracking state in the title bar — always visible, whatever view is open. */
function TrackingChip({ app }: { app: OpenTimeState }) {
  const status = app.status
  const paused = !!status?.paused
  const state = paused ? 'paused' : status?.mode === 'active' ? 'tracking' : 'idle'

  return (
    <button
      className={`track-chip ${state}`}
      onClick={() => void app.setTracking(paused ? 'resume' : 'pause')}
      title={paused ? 'Resume tracking' : 'Pause tracking'}
    >
      {paused ? <IconPause size={13} /> : <IconClock size={13} />}
      <span>{paused ? 'Paused' : state === 'tracking' ? 'Tracking' : 'Waiting'}</span>
    </button>
  )
}

/**
 * The rail-sized name for a capture adapter.
 *
 * Every adapter is named `kind (detail)`, so the leading word is the answer to
 * the only question the rail has room to ask: is this real capture or generated
 * activity. Anything unrecognised is shown as-is rather than guessed at.
 */
function captureKind(adapter: string | undefined): string {
  if (!adapter) return '—'
  const kind = adapter.split(' (')[0]
  if (kind === 'demo') return 'Demo'
  if (kind === 'x-win') return 'Native'
  return kind
}

/**
 * The pinned block at the bottom of the rail: what the engine is doing, how long
 * the current unbroken stretch has run, and where the data lives. It owns its
 * own tick so the rest of the shell never re-renders.
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
        <span className="nav-label">
          {state === 'paused' ? 'Paused' : state === 'tracking' ? 'Tracking' : 'Waiting for input'}
        </span>
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
        {/* The adapter names itself in full — "demo (browser preview)",
            "x-win (native)" — and the rail is ~90px wide, so the full string
            arrived as "demo (brows…". The rail carries which *kind* of capture
            is running; the exact adapter is one hover, or the Settings
            subtitle, away. */}
        <span title={status?.captureAdapter}>{captureKind(status?.captureAdapter)}</span>
      </div>
    </div>
  )
}
