/**
 * Focus sessions, in the renderer.
 *
 * Three surfaces, one state machine: the setup sheet, the dock that sits over
 * the app while a session runs, and the card that reports what the session
 * actually turned into. All three are portalled to `document.body` for the
 * reason every overlay in this app is — `.view` animates a transform with
 * `fill: both`, which makes it a containing block for `position: fixed`.
 *
 * The dock deliberately does **not** own the session. The session lives in the
 * main process and arrives on `status.focus`, so quitting the window mid-session
 * or reloading the renderer does not lose it, and the timer cannot drift away
 * from what will actually be written.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  AMBIENT_BEDS,
  DEFAULT_FOCUS_MINUTES,
  FOCUS_PRESET_MINUTES,
  focusProgress,
  type FocusOutcome,
} from '../../core/focus'
import type { ActiveFocus, AmbientBedId } from '../../core/types'
import { createAmbientEngine, type AmbientEngine } from '../lib/ambient'
import { clock, duration, timeOfDay } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'
import { useNow } from '../state/useOpenTime'
import { IconCheck, IconClose, IconFocus, IconPlus, IconSound, IconSoundOff, IconStop } from './Icons'

/** Minutes a single "extend" adds. One preset, because two would be a menu. */
const EXTEND_MINUTES = 15

/**
 * The whole feature, mounted once by the shell.
 *
 * `open` is the setup sheet only — whether a session is *running* is never
 * renderer state, it is `app.status.focus`.
 */
export function FocusMode({
  app,
  open,
  onOpenChange,
  onOpenCalendar,
}: {
  app: OpenTimeState
  open: boolean
  onOpenChange(open: boolean): void
  onOpenCalendar(): void
}) {
  const active = app.status?.focus ?? null
  const [outcome, setOutcome] = useState<FocusOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Why a finished session left nothing behind, shown in place of the report. */
  const [ended, setEnded] = useState<string | null>(null)
  const [sound, setSound] = useState<AmbientBedId>('silence')
  const [muted, setMuted] = useState(false)
  const engine = useRef<AmbientEngine | null>(null)

  // The engine is built on first use, never on mount: constructing an
  // AudioContext before anyone asks for sound marks the page as playing audio
  // for the rest of its life.
  const ambient = () => {
    if (!engine.current) engine.current = createAmbientEngine()
    return engine.current
  }

  useEffect(() => () => engine.current?.dispose(), [])

  // Sound follows the session, not the sheet: a session that is over must not
  // keep playing because the completion card is still open.
  useEffect(() => {
    if (!active) {
      engine.current?.stop()
      return
    }
    ambient().play(muted ? 'silence' : sound)
  }, [active, sound, muted])

  const start = async (input: {
    label: string
    minutes: number
    projectId?: string
    sound: AmbientBedId
  }) => {
    const result = await app.startFocus(input)
    if (!result.ok) {
      setError(result.message || 'That session could not be started.')
      return
    }
    setError(null)
    setSound(input.sound)
    setMuted(false)
    onOpenChange(false)
  }

  const end = async () => {
    const result = await app.endFocus()
    engine.current?.stop()
    if (!result.ok) {
      // The session is over either way — the dock has already gone, and with it
      // the only place an inline error could have been read. Ending a session
      // and being told nothing is how a tracker loses trust, so the reason gets
      // its own sheet.
      setEnded(result.message || 'That session could not be recorded.')
      return
    }
    setError(null)
    setOutcome(result.outcome ?? null)
    if (result.dayKey) app.selectDay(result.dayKey)
  }

  return (
    <>
      {open && !active
        ? createPortal(
            <FocusSetup
              app={app}
              error={error}
              onCancel={() => {
                setError(null)
                onOpenChange(false)
              }}
              onStart={(input) => void start(input)}
            />,
            document.body
          )
        : null}

      {active
        ? createPortal(
            <FocusDock
              focus={active}
              sound={sound}
              muted={muted}
              error={error}
              onSound={(bed) => {
                setSound(bed)
                setMuted(false)
              }}
              onMute={() => setMuted((v) => !v)}
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
  onStart(input: { label: string; minutes: number; projectId?: string; sound: AmbientBedId }): void
}) {
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState<number>(DEFAULT_FOCUS_MINUTES)
  const [projectId, setProjectId] = useState('')
  const [sound, setSound] = useState<AmbientBedId>('silence')
  const input = useRef<HTMLInputElement>(null)
  const engine = useRef<AmbientEngine | null>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Auditioning a bed here is the only way to choose one honestly — the
  // difference between "Rain" and "Room tone" is not something a label carries.
  useEffect(() => {
    if (!engine.current) engine.current = createAmbientEngine()
    engine.current.setVolume(0.25)
    engine.current.play(sound)
    return () => engine.current?.stop()
  }, [sound])

  useEffect(() => () => engine.current?.dispose(), [])

  const projects = app.projects.filter((p) => !p.archived)
  const ends = Date.now() + minutes * 60_000

  return (
    <div className="drawer-scrim focus-scrim" onClick={onCancel}>
      <div
        className="focus-sheet"
        role="dialog"
        aria-label="Start a focus session"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="focus-sheet-head">
          <span className="focus-sheet-mark">
            <IconFocus size={18} />
          </span>
          <div>
            <h2>Start a focus session</h2>
            <p>Tracking keeps running throughout. This puts a name on the block.</p>
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
            placeholder="Ship the billing fix"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onStart({ label, minutes, projectId: projectId || undefined, sound })
            }}
          />
        </div>

        <div className="focus-field">
          <label>For how long?</label>
          <div className="seg focus-durations">
            {FOCUS_PRESET_MINUTES.map((preset) => (
              <button
                key={preset}
                className={minutes === preset ? 'on' : ''}
                onClick={() => setMinutes(preset)}
              >
                {preset}m
              </button>
            ))}
          </div>
          <p className="focus-hint">
            Ends around {timeOfDay(ends)}. Running past it is fine — nothing is cut off.
          </p>
        </div>

        {projects.length ? (
          <div className="focus-field">
            <label htmlFor="focus-project">Project</label>
            <select
              id="focus-project"
              className="input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="focus-field">
          <label>Sound</label>
          <div className="focus-beds">
            {AMBIENT_BEDS.map((bed) => (
              <button
                key={bed.id}
                className={`focus-bed${sound === bed.id ? ' on' : ''}`}
                onClick={() => setSound(bed.id)}
                title={bed.detail}
              >
                {/* Only silence carries a glyph: five identical speaker icons
                    in a row is decoration, and it costs the chips the width
                    they need to stay on one line. */}
                {bed.id === 'silence' ? <IconSoundOff size={15} /> : null}
                {bed.label}
              </button>
            ))}
          </div>
          <p className="focus-hint">
            Generated on this machine from filtered noise — no files, no streaming, nothing leaves
            the app.
          </p>
        </div>

        {error ? <div className="focus-error">{error}</div> : null}

        <div className="focus-sheet-foot">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => onStart({ label, minutes, projectId: projectId || undefined, sound })}
          >
            <IconFocus size={15} />
            Start {minutes}-minute session
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Running ──────────────────────────────────────────────────────────────────

function FocusDock({
  focus,
  sound,
  muted,
  error,
  onSound,
  onMute,
  onExtend,
  onEnd,
}: {
  focus: ActiveFocus
  sound: AmbientBedId
  muted: boolean
  error: string | null
  onSound(bed: AmbientBedId): void
  onMute(): void
  onExtend(): void
  onEnd(): void
}) {
  const now = useNow(1000)
  const [picking, setPicking] = useState(false)
  const progress = useMemo(() => focusProgress(focus, now), [focus, now])

  const size = 44
  const stroke = 3.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius

  return (
    <div className={`focus-dock${progress.overrun ? ' overrun' : ''}`} role="status">
      <svg className="focus-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={progress.overrun ? 'var(--productive)' : 'var(--accent)'}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${progress.fraction * circumference} ${circumference}`}
          />
        </g>
      </svg>

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
        <div className="focus-sound-wrap">
          <button
            className={`icon-btn${muted || sound === 'silence' ? '' : ' on'}`}
            onClick={() => setPicking((v) => !v)}
            title="Ambient sound"
            aria-expanded={picking}
          >
            {muted || sound === 'silence' ? <IconSoundOff size={16} /> : <IconSound size={16} />}
          </button>
          {picking ? (
            <div className="focus-sound-menu" role="menu">
              {AMBIENT_BEDS.map((bed) => (
                <button
                  key={bed.id}
                  className={sound === bed.id && !muted ? 'on' : ''}
                  onClick={() => {
                    onSound(bed.id)
                    setPicking(false)
                  }}
                >
                  <span>{bed.label}</span>
                  <small>{bed.detail}</small>
                </button>
              ))}
              <button className="focus-sound-mute" onClick={onMute}>
                {muted ? 'Unmute' : 'Mute for now'}
              </button>
            </div>
          ) : null}
        </div>

        <button className="btn ghost small" onClick={onExtend} title={`Add ${EXTEND_MINUTES} minutes`}>
          <IconPlus size={14} />
          {EXTEND_MINUTES}m
        </button>
        <button className="btn danger small" onClick={onEnd}>
          <IconStop size={13} />
          End session
        </button>
      </div>

      {error ? <div className="focus-dock-error">{error}</div> : null}
    </div>
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
