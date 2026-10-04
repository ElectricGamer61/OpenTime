import { useEffect, useState, type ReactNode } from 'react'

import type { Settings } from '../../core/types'
import type { OpenTimeState } from '../state/useOpenTime'
import { BrandMark } from './Brand'
import {
  IconCalendar,
  IconCheck,
  IconDashboard,
  IconFocus,
  IconFolder,
  IconTarget,
  IconWeek,
} from './Icons'
import { Toggle } from './Toggle'

/**
 * First run: four short screens, about thirty seconds.
 *
 * 1. What OpenTime is, and whether tracking works on this machine.
 * 2. Where everything is.
 * 3. The handful of choices worth making up front: theme, start at sign-in,
 *    break reminders, distraction blocking, update checks.
 * 4. Done - it is already tracking.
 *
 * Choosing is saved together with the "done" marker in one write
 * (`completeOnboarding`), so it shows exactly once, survives updates (the
 * marker lives in the data folder, not the program), and cannot half-finish.
 * Skipping is completing with the suggested choices.
 */

type Theme = Settings['theme']

const STEPS = ['welcome', 'tour', 'setup', 'done'] as const

export function Onboarding({ app }: { app: OpenTimeState }) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Settings | null>(() =>
    app.settings
      ? {
          ...app.settings,
          // Suggested defaults for a new install. Each is visible, with a
          // switch, on the "Make it yours" screen before anything is saved.
          launchAtLogin: true,
          notificationsEnabled: true,
          checkForUpdates: true,
        }
      : null
  )

  // Preview the theme while choosing it. App.tsx owns the attribute once the
  // choice is saved; until then this does, and puts it back if it unmounts.
  const theme = draft?.theme
  useEffect(() => {
    const root = document.documentElement
    if (!theme || theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  if (!draft) return null
  const patch = (p: Partial<Settings>) => setDraft({ ...draft, ...p })

  const finish = async () => {
    setBusy(true)
    await app.completeOnboarding(draft)
  }

  const last = step === STEPS.length - 1
  const next = () => (last ? void finish() : setStep(step + 1))

  return (
    <div className="onboard-backdrop" role="dialog" aria-modal="true" aria-label="Welcome to OpenTime">
      <div className="onboard" data-step={STEPS[step]}>
        <div className="onboard-body" key={step}>
          {step === 0 ? <Welcome app={app} /> : null}
          {step === 1 ? <Tour /> : null}
          {step === 2 ? <Setup draft={draft} patch={patch} /> : null}
          {step === 3 ? <Done /> : null}
        </div>

        <div className="onboard-foot">
          <div className="onboard-dots" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((id, i) => (
              <i key={id} className={i === step ? 'on' : i < step ? 'done' : ''} />
            ))}
          </div>
          <div className="onboard-actions">
            {step > 0 && !last ? (
              <button className="btn ghost" onClick={() => setStep(step - 1)} disabled={busy}>
                Back
              </button>
            ) : null}
            {step < 2 ? (
              <button className="btn ghost" onClick={() => void finish()} disabled={busy}>
                Skip
              </button>
            ) : null}
            <button className="btn primary" onClick={next} disabled={busy} autoFocus>
              {step === 0 ? 'Get started' : last ? 'Start using OpenTime' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Welcome({ app }: { app: OpenTimeState }) {
  const [checking, setChecking] = useState(false)
  const capture = app.capture
  const ok = !!capture && !capture.demo && !capture.notice

  const retry = async () => {
    setChecking(true)
    await app.reloadCapture()
    setChecking(false)
  }

  return (
    <>
      <div className="onboard-hero">
        <BrandMark size={64} tile />
        <h1 className="onboard-title">Welcome to OpenTime</h1>
        <p className="onboard-sub">
          See where your time really goes. OpenTime tracks it for you, automatically.
        </p>
      </div>

      <ul className="onboard-points">
        <Point title="Automatic" body="It notices which app or site you're using. Nothing to start or stop." />
        <Point
          title="Private"
          body="No screenshots, no keystrokes, no account. Everything stays on this computer."
        />
        <Point title="Free and open source" body="No subscription. Export or delete your data anytime." />
      </ul>

      <div className={`onboard-status ${ok ? 'ok' : 'warn'}`}>
        <i className="beat" />
        <span>
          {ok
            ? 'Ready to track on this computer.'
            : capture?.notice || 'Automatic tracking is not available on this computer yet.'}
        </span>
        {!ok ? (
          <button className="btn" onClick={() => void retry()} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        ) : null}
      </div>
    </>
  )
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <li>
      <span className="onboard-tick">
        <IconCheck size={14} />
      </span>
      <div>
        <b>{title}</b>
        <span>{body}</span>
      </div>
    </li>
  )
}

const TOUR: Array<{ icon: ReactNode; name: string; body: string }> = [
  {
    icon: <IconDashboard />,
    name: 'Today',
    body: 'How today is going: time tracked, focus and your top apps.',
  },
  {
    icon: <IconCalendar />,
    name: 'Calendar',
    body: 'Your day hour by hour. Click any block to move it to a project or fix its times.',
  },
  {
    icon: <IconFolder />,
    name: 'Projects',
    body: 'Add what you work on. OpenTime files your time there by itself, and learns when you correct it.',
  },
  {
    icon: <IconFocus />,
    name: 'Start focus',
    body: 'Name a task, pick a timer or Pomodoro, and optionally block distractions.',
  },
  {
    icon: <IconWeek />,
    name: 'Reports',
    body: 'Any week, month or year, and where the time went.',
  },
  {
    icon: <IconTarget />,
    name: 'Goals',
    body: 'Set a target, like 4 hours of focus a day, and watch your pace.',
  },
]

function Tour() {
  return (
    <>
      <h1 className="onboard-title">Here's where everything is</h1>
      <p className="onboard-sub">Everything lives in the sidebar on the left.</p>
      <ul className="onboard-tour">
        {TOUR.map((item) => (
          <li key={item.name}>
            <span className="onboard-tour-icon">{item.icon}</span>
            <div>
              <b>{item.name}</b>
              <span>{item.body}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="onboard-tip">
        Closing the window keeps OpenTime tracking in the tray.{' '}
        <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>O</kbd> opens it, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+
        <kbd>P</kbd> pauses it.
      </p>
    </>
  )
}

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Match system' },
]

function Setup({ draft, patch }: { draft: Settings; patch(p: Partial<Settings>): void }) {
  return (
    <>
      <h1 className="onboard-title">Make it yours</h1>
      <p className="onboard-sub">You can change any of this later in Settings.</p>

      <div className="onboard-themes" role="radiogroup" aria-label="Appearance">
        {THEMES.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={draft.theme === t.id}
            className={`onboard-theme${draft.theme === t.id ? ' on' : ''}`}
            onClick={() => patch({ theme: t.id })}
          >
            <span className={`onboard-swatch ${t.id}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="onboard-options">
        <Option
          name="Start when I sign in"
          desc="Runs quietly in the tray so no time is missed."
          on={draft.launchAtLogin}
          onChange={(v) => patch({ launchAtLogin: v })}
        />
        <Option
          name="Break reminders"
          desc={`A gentle nudge after ${draft.focusBlockMinutes} minutes without a break.`}
          on={draft.notificationsEnabled}
          onChange={(v) => patch({ notificationsEnabled: v })}
        />
        <Option
          name="Block distractions during focus"
          desc="Covers sites like YouTube and Reddit while a focus session runs. Edit the list in Settings."
          on={draft.blocking.enabled}
          onChange={(v) => patch({ blocking: { ...draft.blocking, enabled: v } })}
        />
        <Option
          name="Tell me about updates"
          desc="Checks GitHub for a new version now and then. Sends nothing about you."
          on={draft.checkForUpdates}
          onChange={(v) => patch({ checkForUpdates: v })}
        />
      </div>
    </>
  )
}

function Option({
  name,
  desc,
  on,
  onChange,
}: {
  name: string
  desc: string
  on: boolean
  onChange(v: boolean): void
}) {
  return (
    <label className="onboard-option">
      <div>
        <b>{name}</b>
        <span>{desc}</span>
      </div>
      <Toggle label={name} on={on} onChange={onChange} />
    </label>
  )
}

function Done() {
  return (
    <div className="onboard-hero">
      <span className="onboard-done-mark">
        <IconCheck size={28} />
      </span>
      <h1 className="onboard-title">You're all set</h1>
      <p className="onboard-sub">
        OpenTime is tracking now. Use your computer as usual and your day will fill in on the
        Calendar within a few minutes.
      </p>
      <p className="onboard-tip">
        Something confusing or broken? <b>Settings → Send feedback</b> goes straight to the people
        building it.
      </p>
    </div>
  )
}
