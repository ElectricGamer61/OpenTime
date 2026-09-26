/**
 * Focus sessions, in the renderer.
 *
 * One button, one short sheet: what you are working on (optional), how long
 * (25, 45, 60 or 90 minutes, or Pomodoro), whether to block distractions, and
 * Start. Sound and music are deliberately not here: the music player lives on
 * the rail on its own, so starting to focus is one decision, not five.
 *
 * Both lengths end up as ordinary focus sessions underneath. See
 * `usePomodoro` for how a Pomodoro run maps onto `startFocus`/`endFocus`
 * without ever double-counting a minute. Everything here is portalled to
 * `document.body` for the reason every overlay in this app is: `.view`
 * animates a transform with `fill: both`, which makes it a containing block
 * for `position: fixed`.
 *
 * The dock deliberately does **not** own the plain-timer session. The session
 * lives in the main process and arrives on `status.focus`, so quitting the
 * window mid-session or reloading the renderer does not lose it. A Pomodoro
 * run's phase/pause state, by contrast, is renderer-local by necessity; see
 * `usePomodoro`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { describeBlockList } from '../../core/blocking'
import { focusProgress, type FocusOutcome } from '../../core/focus'
import { POMODORO_PRESETS } from '../../core/pomodoro'
import type { ActiveFocus } from '../../core/types'
import { clock, duration, timeOfDay } from '../lib/format'
import { usePomodoro } from '../lib/usePomodoro'
import type { OpenTimeState } from '../state/useOpenTime'
import { useNow } from '../state/useOpenTime'
import {
  IconCheck,
  IconClose,
  IconFocus,
  IconPause,
  IconPlay,
  IconPlus,
  IconSkip,
  IconStop,
} from './Icons'
import { Toggle } from './Toggle'

/** Minutes a single "extend" adds. One preset, because two would be a menu. */
const EXTEND_MINUTES = 15

/** The lengths on offer. Pomodoro is just another length, not a second mode. */
const LENGTHS = [25, 45, 60, 90, 'pomodoro'] as const
type Length = (typeof LENGTHS)[number]

/** The one Pomodoro rhythm offered: 25 minutes on, 5 off. */
const POMODORO = POMODORO_PRESETS[0]

const DEFAULT_LENGTH: Length = 45

/**
 * The whole feature, mounted once by the shell.
 *
 * `open` is the setup sheet only. Whether a session is *running* is never
 * renderer state for the plain timer (it is `app.status.focus`); for Pomodoro
 * it is `pomodoro.run`, which `App.tsx` also reads to drive the rail's chip.
 */
export function FocusMode({
  app,
  pomodoro,
  open,
  onOpenChange,
  onOpenCalendar,
}: {
  app: OpenTimeState
  pomodoro: ReturnType<typeof usePomodoro>
  open: boolean
  onOpenChange(open: boolean): void
  onOpenCalendar(): void
}) {
  const active = app.status?.focus ?? null
  const [outcome, setOutcome] = useState<FocusOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Why a finished session left nothing behind, shown in place of the report. */
  const [ended, setEnded] = useState<string | null>(null)

  const start = async (label: string, length: Length) => {
    if (length === 'pomodoro') {
      await pomodoro.start({
        label,
        workMinutes: POMODORO.workMinutes,
        breakMinutes: POMODORO.breakMinutes,
      })
      setError(null)
      onOpenChange(false)
      return
    }
    const result = await app.startFocus({ label, minutes: length })
    if (!result.ok) {
      setError(result.message || 'That session could not be started.')
      return
    }
    setError(null)
    onOpenChange(false)
  }

  const end = async () => {
    const result = await app.endFocus()
    if (!result.ok) {
      // The session is over either way; the dock has gone, and with it the
      // only place an inline error could have been read. Ending a session and
      // being told nothing is how a tracker loses trust.
      setEnded(result.message || 'That session could not be recorded.')
      return
    }
    setError(null)
    setOutcome(result.outcome ?? null)
    if (result.dayKey) app.selectDay(result.dayKey)
  }

  const showSetup = open && !active && !pomodoro.run

  return (
    <>
      {showSetup
        ? createPortal(
            <FocusSetup
              app={app}
              error={error}
              onCancel={() => {
                setError(null)
                onOpenChange(false)
              }}
              onStart={(label, length) => void start(label, length)}
            />,
            document.body
          )
        : null}

      {pomodoro.run
        ? createPortal(
            <PomodoroDock
              run={pomodoro.run}
              progress={pomodoro.progress}
              error={pomodoro.error}
              busy={pomodoro.busy}
              onPause={() => void pomodoro.pause()}
              onResume={() => void pomodoro.resume()}
              onSkip={() => void pomodoro.skip()}
              onStop={() => void pomodoro.stop()}
            />,
            document.body
          )
        : active
          ? createPortal(
              <FocusDock
                focus={active}
                error={error}
                onExtend={() => void app.extendFocus(EXTEND_MINUTES)}
                onEnd={() => void end()}
              />,
              document.body
            )
          : null}

      {ended
        ? createPortal(<FocusUnrecorded reason={ended} onClose={() => setEnded(null)} />, document.body)
        : null}

      {outcome
        ? createPortal(
            <FocusComplete
              outcome={outcome}
              onClose={() => setOutcome(null)}
              onOpenCalendar={() => {
                setOutcome(null)
                onOpenCalendar()
              }}
            />,
            document.body
          )
        : null}
    </>
  )
}

// ── Setup ────────────────────────────────────────────────────────────────────

function FocusSetup({
  app,
  error,
  onCancel,
  onStart,
}: {
  app: OpenTimeState
  error: string | null
  onCancel(): void
  onStart(label: string, length: Length): void
}) {
  const [label, setLabel] = useState('')
  const [length, setLength] = useState<Length>(DEFAULT_LENGTH)
  const input = useRef<HTMLInputElement>(null)
  const settings = app.settings

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const blocking = settings?.blocking
  const blockList = describeBlockList(blocking?.targets ?? [])
  const setBlocking = (enabled: boolean) => {
    if (!settings) return
    // Saved straight away: this is the same setting as in Settings, not a
    // per-session option that would quietly disagree with it.
    void app.saveSettings({ ...settings, blocking: { ...settings.blocking, enabled } })
  }

  const submit = () => onStart(label, length)

  return (
    <div className="drawer-scrim focus-scrim" onClick={onCancel}>
      <div
        className="focus-sheet"
        role="dialog"
        aria-label="Start focus"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="focus-sheet-head">
          <span className="focus-sheet-mark">
            <IconFocus size={18} />
          </span>
          <div>
            <h2>Start focus</h2>
            <p>Pick how long, then get to work. Tracking keeps running either way.</p>
          </div>
          <button className="icon-btn" onClick={onCancel} title="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="focus-field">
          <label htmlFor="focus-goal">What are you working on?</label>
          <input
            id="focus-goal"
            ref={input}
            className="input"
            value={label}
            maxLength={90}
            placeholder="Optional, e.g. Write the report"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </div>

        <div className="focus-field">
          <label>How long?</label>
          <div className="seg grow focus-lengths" role="radiogroup" aria-label="Length">
            {LENGTHS.map((option) => (
              <button
                key={option}
                role="radio"
                aria-checked={length === option}
                className={length === option ? 'on' : ''}
                onClick={() => setLength(option)}
              >
                {option === 'pomodoro' ? 'Pomodoro' : `${option} min`}
              </button>
            ))}
          </div>
          <p className="focus-hint">
            {length === 'pomodoro'
              ? `${POMODORO.workMinutes} minutes of focus, then a ${POMODORO.breakMinutes}-minute break, repeating until you stop.`
              : `Ends at ${timeOfDay(Date.now() + length * 60_000)}. You can stop early or add more time.`}
          </p>
        </div>

        {blocking ? (
          <label className="focus-option">
            <div>
              <b>Block distractions</b>
              <span>
                {blockList
                  ? `Covers ${blockList} while you focus.`
                  : 'Your block list is empty. Add sites in Settings.'}
              </span>
            </div>
            <Toggle label="Block distractions" on={blocking.enabled} onChange={setBlocking} />
          </label>
        ) : null}

        {error ? <div className="focus-error">{error}</div> : null}

        <div className="focus-sheet-foot">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            <IconFocus size={15} />
            Start focusing
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Running: plain timer ────────────────────────────────────────────────────

function FocusDock({
  focus,
  error,
  onExtend,
  onEnd,
}: {
  focus: ActiveFocus
  error: string | null
  onExtend(): void
  onEnd(): void
}) {
  const now = useNow(1000)
  const progress = useMemo(() => focusProgress(focus, now), [focus, now])

  return (
    <div className={`focus-dock${progress.overrun ? ' overrun' : ''}`} role="status">
      <FocusRing fraction={progress.fraction} overrun={progress.overrun} />

      <div className="focus-dock-text">
        <div className="focus-dock-label" title={focus.label}>
          {focus.label}
        </div>
        <div className="focus-dock-time">
          <b>{progress.overrun ? clock(progress.overrunSeconds) : clock(progress.remainingSeconds)}</b>
          <span>
            {progress.overrun
              ? `over ${duration(focus.plannedSeconds)}`
              : `left of ${duration(focus.plannedSeconds)}`}
          </span>
        </div>
      </div>

      <div className="focus-dock-actions">
        <button className="btn ghost small" onClick={onExtend} title={`Add ${EXTEND_MINUTES} minutes`}>
          <IconPlus size={14} />
          {EXTEND_MINUTES} min
        </button>
        <button className="btn danger small" onClick={onEnd}>
          <IconStop size={13} />
          End
        </button>
      </div>

      {error ? <div className="focus-dock-error">{error}</div> : null}
    </div>
  )
}

// ── Running: Pomodoro ───────────────────────────────────────────────────────

function PomodoroDock({
  run,
  progress,
  error,
  busy,
  onPause,
  onResume,
  onSkip,
  onStop,
}: {
  run: NonNullable<ReturnType<typeof usePomodoro>['run']>
  progress: ReturnType<typeof usePomodoro>['progress']
  error: string | null
  /** A phase transition is in flight. Pause/Resume/Skip wait for it; Stop may always interrupt. */
  busy: boolean
  onPause(): void
  onResume(): void
  onSkip(): void
  onStop(): void
}) {
  const work = run.phase === 'work'

  return (
    <div className={`focus-dock pomodoro-dock ${run.phase}${run.paused ? ' paused' : ''}`} role="status">
      <FocusRing fraction={progress?.fraction ?? 0} overrun={false} tone={work ? 'work' : 'break'} />

      <div className="focus-dock-text">
        <div className="focus-dock-label" title={run.label}>
          <span className={`pomodoro-phase-badge ${run.phase}`}>{work ? 'Focus' : 'Break'}</span>
          {run.label || 'Pomodoro'}
        </div>
        <div className="focus-dock-time">
          <b>{clock(progress?.remainingSeconds ?? 0)}</b>
          <span>{run.paused ? 'paused' : work ? 'until your break' : 'until you focus again'}</span>
        </div>
      </div>

      <div className="focus-dock-actions">
        <button
          className="icon-btn"
          onClick={run.paused ? onResume : onPause}
          title={run.paused ? 'Resume' : 'Pause'}
          disabled={busy}
        >
          {run.paused ? <IconPlay size={16} /> : <IconPause size={16} />}
        </button>
        <button
          className="btn ghost small"
          onClick={onSkip}
          title={work ? 'Start the break now' : 'End the break now'}
          disabled={busy}
        >
          <IconSkip size={14} />
          Skip
        </button>
        <button className="btn danger small" onClick={onStop}>
          <IconStop size={13} />
          Stop
        </button>
      </div>

      {error ? <div className="focus-dock-error">{error}</div> : null}
    </div>
  )
}

/** The progress ring both docks share — a plain circle, coloured by what it means right now. */
function FocusRing({
  fraction,
  overrun,
  tone,
}: {
  fraction: number
  overrun: boolean
  tone?: 'work' | 'break'
}) {
  const size = 44
  const stroke = 3.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const color = tone === 'break' ? 'var(--neutral)' : overrun ? 'var(--productive)' : 'var(--accent)'

  return (
    <svg className="focus-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${fraction * circumference} ${circumference}`}
        />
      </g>
    </svg>
  )
}

/**
 * The session ended but nothing was written.
 *
 * The only way this happens today is a session shorter than a minute, which the
 * store refuses on purpose. It still deserves a sheet: the alternative is a
 * countdown that simply vanishes, which reads as lost work rather than as a
 * session too short to be worth a block.
 */
function FocusUnrecorded({ reason, onClose }: { reason: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="drawer-scrim focus-scrim" onClick={onClose}>
      <div
        className="focus-sheet done"
        role="dialog"
        aria-label="Focus session not recorded"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="focus-done-head">
          <span className="focus-done-mark muted">
            <IconClose size={20} />
          </span>
          <h2>Nothing to record</h2>
          <p>{reason}</p>
        </div>
        <p className="focus-hint">
          Your tracked time is untouched — a focus session only puts a name on minutes that were
          already being recorded.
        </p>
        <div className="focus-sheet-foot">
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Completion ───────────────────────────────────────────────────────────────

function FocusComplete({
  outcome,
  onClose,
  onOpenCalendar,
}: {
  outcome: FocusOutcome
  onClose(): void
  onOpenCalendar(): void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const share = outcome.plannedSeconds ? outcome.actualSeconds / outcome.plannedSeconds : 0
  const total = outcome.apps.reduce((sum, a) => sum + a.seconds, 0) || 1

  return (
    <div className="drawer-scrim focus-scrim" onClick={onClose}>
      <div
        className="focus-sheet done"
        role="dialog"
        aria-label="Focus session complete"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="focus-done-head">
          <span className="focus-done-mark">
            <IconCheck size={20} />
          </span>
          <h2>{outcome.label}</h2>
          <p>
            {duration(outcome.actualSeconds)} recorded
            {outcome.plannedSeconds
              ? ` of ${duration(outcome.plannedSeconds)} planned (${Math.round(share * 100)}%)`
              : ''}
            .
          </p>
        </div>

        {outcome.apps.length ? (
          <div className="focus-done-apps">
            <div className="focus-done-caption">Where it went</div>
            {outcome.apps.slice(0, 6).map((row) => (
              <div className="bar-row" key={row.name}>
                <div>
                  <div className="bar-name">
                    <span>{row.name}</span>
                  </div>
                  <div className="bar-track">
                    <i style={{ width: `${(row.seconds / total) * 100}%`, background: 'var(--accent)' }} />
                  </div>
                </div>
                <div className="bar-value">{duration(row.seconds)}</div>
              </div>
            ))}
          </div>
        ) : null}

        <p className="focus-hint">
          It is on your timeline as one block, and the apps above are still underneath it.
        </p>

        <div className="focus-sheet-foot">
          <button className="btn ghost" onClick={onClose}>
            Done
          </button>
          <button className="btn primary" onClick={onOpenCalendar}>
            See it on the calendar
          </button>
        </div>
      </div>
    </div>
  )
}
