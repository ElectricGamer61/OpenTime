import { useEffect, useState } from 'react'

import type { Settings } from '../../core/types'
import { DataSettings } from '../components/DataSettings'
import { IconInfo } from '../components/Icons'
import type { OpenTimeState } from '../state/useOpenTime'

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button
      className={`switch${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  )
}

function Row({
  name,
  desc,
  wide,
  children,
}: {
  name: string
  desc: string
  /** Let the control keep its natural width — for groups of buttons. */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`setting-row${wide ? ' wide' : ''}`}>
      <div>
        <div className="setting-name">{name}</div>
        <div className="setting-desc">{desc}</div>
      </div>
      <div>{children}</div>
    </div>
  )
}

export function SettingsView({ app }: { app: OpenTimeState }) {
  const [draft, setDraft] = useState<Settings | null>(app.settings)
  const [ignoreInput, setIgnoreInput] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            OpenTime v{app.appVersion} · {app.platform} · capture:{' '}
            {app.status?.captureAdapter || 'unknown'}
          </p>
        </div>
        <div className="row">
          {dirty ? <span className="pill warn">Unsaved changes</span> : null}
          <button className="btn primary" disabled={!dirty} onClick={() => void app.saveSettings(draft)}>
            Save
          </button>
        </div>
      </div>

      <div className="settings">
        <div className="card">
          <h2 className="card-title">Tracking</h2>

          <Row
            name="Sampling interval"
            desc="How often the focused window is read while you are active. Longer intervals cost less; shorter ones catch quick context switches."
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
            name="Idle threshold"
            desc="Seconds without keyboard or mouse input before the open session is closed and tracking drops to a low-cost heartbeat."
          >
            <select
              value={draft.idleThresholdSeconds}
              onChange={(e) => patch({ idleThresholdSeconds: Number(e.target.value) })}
            >
              {[60, 120, 180, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s} seconds` : `${s / 60} minutes`}
                </option>
              ))}
            </select>
          </Row>

          <Row
            name="Session gap"
            desc="A pause longer than this starts a new session even when the activity has not changed."
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
            name="Day starts at"
            desc="Your tracking day rolls over at this hour, so a late night lands on the day it belongs to."
          >
            <select
              value={draft.dayStartHour}
              onChange={(e) => patch({ dayStartHour: Number(e.target.value) })}
            >
              {[0, 2, 3, 4, 5, 6].map((h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </Row>

          <Row
            name="Focus checkpoint"
            desc="Minutes of unbroken activity before OpenTime suggests a break."
          >
            <select
              value={draft.focusBlockMinutes}
              onChange={(e) => patch({ focusBlockMinutes: Number(e.target.value) })}
            >
              {[45, 60, 75, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </Row>

          <Row
            name="Capture adapter"
            desc="Auto uses native OS window capture when available and falls back to generated demo activity when it is not."
          >
            <select
              value={draft.captureMode}
              onChange={(e) => patch({ captureMode: e.target.value as Settings['captureMode'] })}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="native">Native only</option>
              <option value="demo">Demo data</option>
            </select>
          </Row>

          <Row
            wide
            name="Capture status"
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
                {app.capture?.demo ? 'Generated' : app.capture?.notice ? 'Limited' : 'Live'}
              </span>
              <button className="btn" onClick={() => void app.reloadCapture()}>
                Check again
              </button>
            </div>
          </Row>
        </div>

        <div className="card">
          <h2 className="card-title">Privacy</h2>

          <Row
            name="Private apps"
            desc="Time in these apps is never recorded. OpenTime takes no screenshots and stores only the host of a URL, never the path."
          >
            <div />
          </Row>

          <div className="row" style={{ marginBottom: 10 }}>
            <input
              placeholder="Application name, e.g. 1Password"
              value={ignoreInput}
              onChange={(e) => setIgnoreInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !ignoreInput.trim()) return
                patch({ ignoredApps: [...draft.ignoredApps, ignoreInput.trim().toLowerCase()] })
                setIgnoreInput('')
              }}
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={() => {
                if (!ignoreInput.trim()) return
                patch({ ignoredApps: [...draft.ignoredApps, ignoreInput.trim().toLowerCase()] })
                setIgnoreInput('')
              }}
            >
              Add
            </button>
          </div>

          <div className="chip-list">
            {draft.ignoredApps.length === 0 ? (
              <span style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
                No private apps configured.
              </span>
            ) : (
              draft.ignoredApps.map((a) => (
                <span className="chip" key={a}>
                  {a}
                  <button
                    aria-label={`Stop ignoring ${a}`}
                    onClick={() =>
                      patch({ ignoredApps: draft.ignoredApps.filter((x) => x !== a) })
                    }
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>

          <Row
            name="Private subjects"
            desc="Any window whose title or web host contains one of these is never recorded, in any application. Use it for a client name, a matter number, or a health portal."
          >
            <div />
          </Row>

          <div className="row" style={{ marginBottom: 10 }}>
            <input
              placeholder="Text in a window title, e.g. Project Falcon"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !keywordInput.trim()) return
                patch({
                  ignoredTitleKeywords: [
                    ...draft.ignoredTitleKeywords,
                    keywordInput.trim().toLowerCase(),
                  ],
                })
                setKeywordInput('')
              }}
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={() => {
                if (!keywordInput.trim()) return
                patch({
                  ignoredTitleKeywords: [
                    ...draft.ignoredTitleKeywords,
                    keywordInput.trim().toLowerCase(),
                  ],
                })
                setKeywordInput('')
              }}
            >
              Add
            </button>
          </div>

          <div className="chip-list">
            {draft.ignoredTitleKeywords.length === 0 ? (
              <span style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
                No private subjects configured.
              </span>
            ) : (
              draft.ignoredTitleKeywords.map((k) => (
                <span className="chip" key={k}>
                  {k}
                  <button
                    aria-label={`Stop ignoring ${k}`}
                    onClick={() =>
                      patch({
                        ignoredTitleKeywords: draft.ignoredTitleKeywords.filter((x) => x !== k),
                      })
                    }
                  >
                    ✕
                  </button>
                </span>
              ))
            )}
          </div>
        </div>

        <DataSettings app={app} draft={draft} patch={patch} />

        <div className="card">
          <h2 className="card-title">Application</h2>
          <Row
            wide
            name="Appearance"
            desc="Follow the operating system, or pin OpenTime to one theme."
          >
            <div className="seg">
              {(['system', 'light', 'dark'] as const).map((option) => (
                <button
                  key={option}
                  className={draft.theme === option ? 'on' : ''}
                  aria-pressed={draft.theme === option}
                  onClick={() => patch({ theme: option })}
                >
                  {option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>
          </Row>
          <Row name="Launch at login" desc="Start OpenTime in the tray when you sign in.">
            <Toggle
              label="Launch at login"
              on={draft.launchAtLogin}
              onChange={(v) => patch({ launchAtLogin: v })}
            />
          </Row>
          <Row
            name="Focus notifications"
            desc="A quiet native notification at your focus checkpoint. Nothing else notifies."
          >
            <Toggle
              label="Focus notifications"
              on={draft.notificationsEnabled}
              onChange={(v) => patch({ notificationsEnabled: v })}
            />
          </Row>
        </div>

        <div className="card">
          <h2 className="card-title">Google Calendar</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: -6 }}>
            OpenTime ships no API credentials. Create a free OAuth client in your own Google Cloud
            project and paste it here — the values stay in your local settings file and are never
            sent anywhere but Google. See the README for the two-minute setup.
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

          <Row name="OAuth client ID" desc="From your own Google Cloud project.">
            <input
              value={draft.calendar.clientId}
              placeholder="…apps.googleusercontent.com"
              onChange={(e) =>
                patch({ calendar: { ...draft.calendar, clientId: e.target.value.trim() } })
              }
            />
          </Row>

          <Row name="OAuth client secret" desc="Stored locally only.">
            <input
              type="password"
              value={draft.calendar.clientSecret}
              onChange={(e) =>
                patch({ calendar: { ...draft.calendar, clientSecret: e.target.value.trim() } })
              }
            />
          </Row>

          <Row
            name="Scope"
            desc="Read-only is enough for the timeline overlay and is the lighter Google verification path."
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
      </div>
    </>
  )
}
