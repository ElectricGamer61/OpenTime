import type { ComponentType } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { BrandMark, TitleWordmark } from './components/Brand'
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
  IconFolderOpen,
  IconPause,
  IconSettings,
  IconTarget,
  IconWeek,
} from './components/Icons'
import { Onboarding } from './components/Onboarding'
import { focusProgress } from '../core/focus'
import type { RangeKind } from '../core/range'
import { clock, duration } from './lib/format'
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
      className={`app${collapsed ? ' rail-collapsed' : ''}${app.status?.focus ? ' focus-running' : ''}`}
    >
      {app.firstRun ? <Onboarding app={app} /> : null}
      <Titlebar app={app} onSettings={() => setTab('settings')} />

      <div className="shell">
        <nav className="rail" aria-label="Main">
          <div className="rail-top">
            <Workspace app={app} />
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

          <FocusButton app={app} onStart={() => setFocusSetup(true)} />
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
                {tab === 'goals' ? <GoalsView app={app} /> : null}
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
 * button is a rail people stop trusting to hold the same things.
 */
function FocusButton({ app, onStart }: { app: OpenTimeState; onStart(): void }) {
  const now = useNow(1000)
  const focus = app.status?.focus ?? null

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

const WORKSPACE_MENU_WIDTH = 264
/**
 * Kept off the window edge so the card never looks clipped. Matches the rail's
 * own padding, so at any ordinary width the card lines up with its trigger and
 * the clamp only bites on a window too narrow to hold it.
 */
const WORKSPACE_MENU_MARGIN = 8

/**
 * The workspace switcher.
 *
 * There is exactly one workspace and there always will be — the store is a
 * folder on this machine, and accounts are on the "not built on purpose" list.
 * So rather than a fake switcher, the chevron opens what a switcher would be
 * hiding: where the data actually is.
 */
function Workspace({ app }: { app: OpenTimeState }) {
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
      const width = menu.current?.offsetWidth ?? WORKSPACE_MENU_WIDTH
      const height = menu.current?.offsetHeight ?? 160
      const edge = WORKSPACE_MENU_MARGIN
      setPos({
        top: Math.min(button.bottom + 6, Math.max(edge, window.innerHeight - height - edge)),
        left: Math.max(edge, Math.min(button.left, window.innerWidth - width - edge)),
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
    <div className="workspace-wrap" ref={wrap}>
      <button
        className={`workspace${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Where this workspace lives"
      >
        <span className="workspace-avatar">
          <BrandMark size={15} />
        </span>
        <span className="workspace-name">Personal</span>
        <IconChevronDown className="workspace-caret" />
      </button>

      {/*
       * Portalled to the body, like every other overlay in the app. The rail is
       * `overflow: hidden` — it has to be, so the collapse animation does not
       * spill — and the card is wider than the rail, so rendered in place it was
       * sliced off mid-sentence at the rail's right edge. Fixed positioning is
       * viewport-relative only outside the view's transform; see EntryPopover.
       */}
      {open
        ? createPortal(
            <div
              className="workspace-menu"
              ref={menu}
              role="dialog"
              aria-label="Workspace"
              style={{
                width: WORKSPACE_MENU_WIDTH,
                top: pos?.top ?? -9999,
                left: pos?.left ?? -9999,
              }}
            >
              <div className="workspace-menu-head">
                This workspace is a folder on this machine.
              </div>
              <div className="workspace-path" title={app.dataDirectory}>
                {app.dataDirectory}
              </div>
              <button
                className="workspace-action"
                onClick={() => {
                  void app.revealDataFolder()
                  setOpen(false)
                }}
              >
                <IconFolderOpen size={15} />
                Open data folder
              </button>
              <div className="workspace-menu-foot">
                OpenTime v{app.appVersion} · {app.platform}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

/**
 * The window's own title bar: a drag region carrying the wordmark, with live
 * tracking state and a way into Settings on the right. On macOS the traffic
 * lights are inset into the left of it, which is why the left slot is padded
 * rather than empty.
 */
function Titlebar({ app, onSettings }: { app?: OpenTimeState; onSettings?(): void }) {
  return (
    <header className="titlebar">
      <div className="titlebar-left" />
      <TitleWordmark />
      <div className="titlebar-right">
        {app ? (
          <>
            <TrackingChip app={app} />
            <button className="titlebar-link" onClick={onSettings} title="Settings">
              <IconSettings size={15} />
              <span>Settings</span>
            </button>
          </>
        ) : null}
      </div>
    </header>
  )
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
        <span title={status?.captureAdapter}>{status?.captureAdapter ?? '—'}</span>
      </div>
    </div>
  )
}
