import { useEffect, useState } from 'react'

import { DEFAULT_BLOCK_TARGETS, normalizeBlockTarget } from '../../core/blocking'
import type { Settings } from '../../core/types'
import { DataSettings } from '../components/DataSettings'
import { IconClose, IconInfo } from '../components/Icons'
import { Toggle } from '../components/Toggle'
import type { OpenTimeState } from '../state/useOpenTime'

function Row({
  name,
  desc,
  wide,
  text,
  children,
}: {
  name: string
  desc: string
  /** Let the control keep its natural width — for groups of buttons. */
  wide?: boolean
  /** Widen the control column — for a free-text value the reader has to read. */
  text?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`setting-row${wide ? ' wide' : ''}${text ? ' text' : ''}`}>
      <div>
        <div className="setting-name">{name}</div>
        <div className="setting-desc">{desc}</div>
      </div>
      <div>{children}</div>
    </div>
  )
}

/**
 * A list of short strings the user adds to and removes from: private apps,
 * private subjects, blocked sites. One control so all three behave alike.
 */
function ChipList({
  items,
  onChange,
  placeholder,
  empty,
  normalize = (v) => v.trim().toLowerCase(),
  removeLabel,
}: {
  items: string[]
  onChange(items: string[]): void
  placeholder: string
  empty: string
  normalize?(value: string): string
  removeLabel(item: string): string
}) {
  const [input, setInput] = useState('')
  const add = () => {
    const value = normalize(input)
    if (!value) return
    if (!items.includes(value)) onChange([...items, value])
    setInput('')
  }
  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={add} disabled={!input.trim()}>
          Add
        </button>
      </div>
      <div className="chip-list">
        {items.length === 0 ? (
          <span className="chip-empty">{empty}</span>
        ) : (
          items.map((item) => (
            <span className="chip" key={item}>
              {item}
              <button
                aria-label={removeLabel(item)}
                title={removeLabel(item)}
                onClick={() => onChange(items.filter((x) => x !== item))}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))
        )}
      </div>
    </>
  )
}

/**
 * Settings sections.
 *
 * One section on screen at a time rather than one long column. Five stacked
 * cards meant the page was mostly scrolling past things you were not looking
 * for, and on a wide window it left half the view empty next to an 820px
 * ribbon — which reads as an unfinished screen rather than a calm one.
 */
const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'focus', label: 'Focus & blocking' },
  { id: 'tracking', label: 'Tracking' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'data', label: 'Your data' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'about', label: 'Updates & feedback' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsView({ app }: { app: OpenTimeState }) {
  const [section, setSection] = useState<SectionId>('general')
  const [draft, setDraft] = useState<Settings | null>(app.settings)
  const [calendarMessage, setCalendarMessage] = useState('')

  useEffect(() => setDraft(app.settings), [app.settings])

  /**
   * Preview the theme while it is still a draft.
   *
   * Every other setting on this page is invisible until saved, but a theme you
   * cannot see is a theme you cannot choose. Leaving the page without saving
   * puts the stored theme back, so the preview never outlives the decision.
   */
  const draftTheme = draft?.theme
  const savedTheme = app.settings?.theme
  useEffect(() => {
    const root = document.documentElement
    const apply = (value: string | undefined) => {
      if (!value || value === 'system') root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', value)
    }
    apply(draftTheme)
    return () => apply(savedTheme)
  }, [draftTheme, savedTheme])

  if (!draft) return null

  const dirty = JSON.stringify(draft) !== JSON.stringify(app.settings)
  const patch = (p: Partial<Settings>) => setDraft({ ...draft, ...p })

  const runCalendar = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setCalendarMessage('Working…')
    const result = await fn()
    setCalendarMessage(result.message)
  }

  const missingDefaults = DEFAULT_BLOCK_TARGETS.filter((t) => !draft.blocking.targets.includes(t))

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            OpenTime {app.appVersion} · tracking with {app.status?.captureAdapter || 'unknown'}
          </p>
        </div>
        <div className="row">
          {dirty ? (
            <>
              <span className="pill warn">Unsaved changes</span>
              <button className="btn ghost" onClick={() => setDraft(app.settings)}>
                Discard
              </button>
            </>
          ) : null}
          <button className="btn primary" disabled={!dirty} onClick={() => void app.saveSettings(draft)}>
            Save
          </button>
        </div>
      </div>

      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? 'on' : ''}
              aria-current={section === item.id ? 'true' : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          <div className="card" hidden={section !== 'general'}>
            <h2 className="card-title">General</h2>
            <Row wide name="Appearance" desc="Light, dark, or follow your computer's setting.">
              <div className="seg">
                {(['light', 'dark', 'system'] as const).map((option) => (
                  <button
                    key={option}
                    className={draft.theme === option ? 'on' : ''}
                    aria-pressed={draft.theme === option}
                    onClick={() => patch({ theme: option })}
                  >
                    {option === 'system' ? 'Match system' : option[0].toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
            </Row>
            <Row
              name="Start when I sign in"
              desc="OpenTime starts quietly in the tray, so no time goes untracked."
            >
              <Toggle
                label="Start when I sign in"
                on={draft.launchAtLogin}
                onChange={(v) => patch({ launchAtLogin: v })}
              />
            </Row>
            <Row
              name="Idle after"
              desc="With no keyboard or mouse input for this long, you're marked away and the clock stops."
            >
              <select
                value={draft.idleThresholdSeconds}
                onChange={(e) => patch({ idleThresholdSeconds: Number(e.target.value) })}
              >
                {[60, 120, 180, 300, 600].map((s) => (
                  <option key={s} value={s}>
                    {s / 60} {s === 60 ? 'minute' : 'minutes'}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              name="Day starts at"
              desc="Your day rolls over at this hour, so a late night counts toward the day it belongs to."
            >
              <select
                value={draft.dayStartHour}
                onChange={(e) => patch({ dayStartHour: Number(e.target.value) })}
              >
                {[0, 2, 3, 4, 5, 6].map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? 'Midnight' : `${h}:00 AM`}
                  </option>
                ))}
              </select>
            </Row>
          </div>

          <div className="card" hidden={section !== 'focus'}>
            <h2 className="card-title">Break reminders</h2>
            <Row
              name="Remind me to take breaks"
              desc="A quiet notification after a long stretch without a break. Nothing else ever notifies."
            >
              <Toggle
                label="Remind me to take breaks"
                on={draft.notificationsEnabled}
                onChange={(v) => patch({ notificationsEnabled: v })}
              />
            </Row>
            <Row name="Remind me after" desc="Minutes of unbroken activity before the reminder.">
              <select
                value={draft.focusBlockMinutes}
                disabled={!draft.notificationsEnabled}
                onChange={(e) => patch({ focusBlockMinutes: Number(e.target.value) })}
              >
                {[45, 60, 75, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </Row>

            <h2 className="card-title card-title-gap">Distraction blocking</h2>
            <Row
              name="Block distractions during focus sessions"
              desc="While a focus session runs, anything on the list below is covered by a reminder to get back to work. Close the tab or switch apps and it goes away. Outside focus sessions, nothing is ever blocked."
            >
              <Toggle
                label="Block distractions during focus sessions"
                on={draft.blocking.enabled}
                onChange={(v) => patch({ blocking: { ...draft.blocking, enabled: v } })}
              />
            </Row>
            <div className="setting-sub" aria-disabled={!draft.blocking.enabled}>
              <div className="setting-name">Blocked sites and apps</div>
              <div className="setting-desc">
                A website like <code>youtube.com</code> (covers its subdomains too), or an app name
                like <code>steam</code>.
              </div>
              <ChipList
                items={draft.blocking.targets}
                onChange={(targets) => patch({ blocking: { ...draft.blocking, targets } })}
                normalize={normalizeBlockTarget}
                placeholder="Add a website or app, e.g. youtube.com"
                empty="Nothing on the list yet."
                removeLabel={(t) => `Unblock ${t}`}
              />
              {missingDefaults.length ? (
                <div className="suggest-row">
                  <span>Suggestions:</span>
                  {missingDefaults.map((t) => (
                    <button
                      key={t}
                      className="chip suggest"
                      onClick={() =>
                        patch({ blocking: { ...draft.blocking, targets: [...draft.blocking.targets, t] } })
                      }
                    >
                      + {t}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="card" hidden={section !== 'tracking'}>
            <h2 className="card-title">Tracking</h2>
            <Row
              wide
              name="Status"
              desc={
                app.capture?.notice ||
                `Reading the focused window through ${app.capture?.adapter || 'the system'}.`
              }
            >
              <div className="row">
                {/* Generated capture is working as designed on a machine that
                    cannot expose the focused window, so it is a fact to state,
                    not a fault to flag in red. Only a degraded *real* adapter
                    warrants the warning tone. */}
                <span
                  className={`pill ${
                    app.capture?.demo ? 'muted' : app.capture?.notice ? 'warn' : 'live'
                  }`}
                >
                  {app.capture?.demo ? 'Generated' : app.capture?.notice ? 'Limited' : 'Working'}
                </span>
                <button className="btn" onClick={() => void app.reloadCapture()}>
                  Check again
                </button>
              </div>
            </Row>

            <details className="advanced">
              <summary>Advanced</summary>
              <Row
                name="Check the active window every"
                desc="Shorter catches quick app switches; longer uses a little less power."
              >
                <select
                  value={draft.pollIntervalSeconds}
                  onChange={(e) => patch({ pollIntervalSeconds: Number(e.target.value) })}
                >
                  {[2, 5, 10, 15, 30].map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </select>
              </Row>
              <Row
                name="Session gap"
                desc="A pause longer than this starts a new block even when the app has not changed."
              >
                <select
                  value={draft.sessionGapSeconds}
                  onChange={(e) => patch({ sessionGapSeconds: Number(e.target.value) })}
                >
                  {[30, 60, 120, 300].map((s) => (
                    <option key={s} value={s}>
                      {s} seconds
                    </option>
                  ))}
                </select>
              </Row>
              <Row
                name="Capture method"
                desc="Automatic reads your real activity when this computer allows it. Demo generates example activity, for trying OpenTime out."
              >
                <select
                  value={draft.captureMode}
                  onChange={(e) => patch({ captureMode: e.target.value as Settings['captureMode'] })}
                >
                  <option value="auto">Automatic (recommended)</option>
                  <option value="native">Real activity only</option>
                  <option value="demo">Demo data</option>
                </select>
              </Row>
            </details>
          </div>

          <div className="card" hidden={section !== 'privacy'}>
            <h2 className="card-title">Privacy</h2>
            <p className="card-lede">
              OpenTime never takes screenshots or records keystrokes, and keeps only the site name of a
              web address, never the full link. Everything stays on this computer.
            </p>

            <div className="setting-sub">
              <div className="setting-name">Private apps</div>
              <div className="setting-desc">Time in these apps is never recorded at all.</div>
              <ChipList
                items={draft.ignoredApps}
                onChange={(ignoredApps) => patch({ ignoredApps })}
                placeholder="App name, e.g. 1Password"
                empty="No private apps."
                removeLabel={(a) => `Stop ignoring ${a}`}
              />
            </div>

            <div className="setting-sub">
              <div className="setting-name">Private subjects</div>
              <div className="setting-desc">
                Any window whose title or website contains one of these is never recorded, in any app.
                Good for a client name or a health portal.
              </div>
              <ChipList
                items={draft.ignoredTitleKeywords}
                onChange={(ignoredTitleKeywords) => patch({ ignoredTitleKeywords })}
                placeholder="Text in a window title, e.g. Project Falcon"
                empty="No private subjects."
                removeLabel={(k) => `Stop ignoring ${k}`}
              />
            </div>
          </div>

          <div hidden={section !== 'data'}>
            <DataSettings app={app} draft={draft} patch={patch} />
          </div>

          <div className="card" hidden={section !== 'calendar'}>
            <h2 className="card-title">Google Calendar</h2>
            <p className="card-lede">
              Show your meetings beside your tracked time. OpenTime ships no API credentials: create a
              free OAuth client in your own Google Cloud project and paste it here (the README walks
              through it). The values stay on this computer and are only ever sent to Google.
            </p>

            <Row name="Status" desc={draft.calendar.connected ? 'Connected.' : 'Not connected.'}>
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => void runCalendar(app.connectCalendar)}
                  disabled={!draft.calendar.clientId || !draft.calendar.clientSecret}
                >
                  {draft.calendar.connected ? 'Reconnect' : 'Connect'}
                </button>
                {draft.calendar.connected ? (
                  <>
                    <button className="btn" onClick={() => void runCalendar(app.syncCalendar)}>
                      Sync
                    </button>
                    <button
                      className="btn ghost danger"
                      onClick={() => void runCalendar(app.disconnectCalendar)}
                    >
                      Disconnect
                    </button>
                  </>
                ) : null}
              </div>
            </Row>

            <Row text name="OAuth client ID" desc="From your own Google Cloud project.">
              <input
                value={draft.calendar.clientId}
                placeholder="…apps.googleusercontent.com"
                onChange={(e) =>
                  patch({ calendar: { ...draft.calendar, clientId: e.target.value.trim() } })
                }
              />
            </Row>

            <Row text name="OAuth client secret" desc="Stored on this computer only.">
              <input
                type="password"
                placeholder="Paste the client secret"
                value={draft.calendar.clientSecret}
                onChange={(e) =>
                  patch({ calendar: { ...draft.calendar, clientSecret: e.target.value.trim() } })
                }
              />
            </Row>

            <Row
              name="Access"
              desc="Read-only is all the calendar view needs, and the lighter Google approval."
            >
              <select
                value={draft.calendar.scope}
                onChange={(e) =>
                  patch({
                    calendar: {
                      ...draft.calendar,
                      scope: e.target.value as typeof draft.calendar.scope,
                    },
                  })
                }
              >
                <option value="calendar.readonly">Read-only</option>
                <option value="calendar">Read and write</option>
              </select>
            </Row>

            {calendarMessage ? (
              <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
                <IconInfo />
                <div>{calendarMessage}</div>
              </div>
            ) : null}
          </div>

          <div className="card" hidden={section !== 'about'}>
            <h2 className="card-title">Updates</h2>
            <Row
              name="Check for updates automatically"
              desc="Now and then, asks GitHub whether a newer OpenTime exists. Nothing about you is sent. Updating never touches your data."
            >
              <Toggle
                label="Check for updates automatically"
                on={draft.checkForUpdates}
                onChange={(v) => patch({ checkForUpdates: v })}
              />
            </Row>
            <Row wide name={`You have OpenTime ${app.appVersion}`} desc={updateLine(app)}>
              <UpdateAction app={app} />
            </Row>

            <h2 className="card-title card-title-gap">Feedback</h2>
            <p className="card-lede">
              Found a bug, missing something, or just confused? Each button opens a short form on
              GitHub. Nothing is sent until you submit it there.
            </p>
            <div className="row feedback-row">
              <button className="btn" onClick={() => void app.openFeedback('bug')}>
                Report a bug
              </button>
              <button className="btn" onClick={() => void app.openFeedback('idea')}>
                Suggest an idea
              </button>
              <button className="btn" onClick={() => void app.openFeedback('question')}>
                Ask a question
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/** One sentence on where updating stands. */
function updateLine(app: OpenTimeState): string {
  const u = app.update
  switch (u.state) {
    case 'checking':
      return 'Checking GitHub…'
    case 'none':
      return 'This is the latest version.'
    case 'available':
      return `Version ${u.version} is ready to install. Your data is kept.`
    case 'downloading':
      return `Downloading ${u.version}… ${u.percent ?? 0}%`
    case 'installing':
      return 'Restarting into the new version…'
    case 'error':
      return u.message || 'The update check failed.'
    case 'unsupported':
      return 'This copy updates by installing the newest version from GitHub.'
    default:
      return 'Check whenever you like.'
  }
}

function UpdateAction({ app }: { app: OpenTimeState }) {
  const u = app.update
  if (u.state === 'available') {
    return (
      <button className="btn primary" onClick={() => void app.installUpdate()}>
        Update now
      </button>
    )
  }
  const busy = u.state === 'checking' || u.state === 'downloading' || u.state === 'installing'
  return (
    <button className="btn" disabled={busy} onClick={() => void app.checkForUpdates()}>
      {u.state === 'unsupported' ? 'Open downloads page' : 'Check now'}
    </button>
  )
}
