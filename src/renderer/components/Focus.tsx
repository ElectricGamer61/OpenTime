/**
 * Focus sessions, in the renderer.
 *
 * Two ways to run one, one dock: a plain timer (the setup sheet, an optional
 * length, done) and Pomodoro (alternating work/break phases with pause, skip
 * and stop). Both end up as ordinary focus sessions underneath — see
 * `usePomodoro` for exactly how a Pomodoro run maps onto `startFocus`/
 * `endFocus` without ever double-counting a minute. Everything here is
 * portalled to `document.body` for the reason every overlay in this app is —
 * `.view` animates a transform with `fill: both`, which makes it a
 * containing block for `position: fixed`.
 *
 * The dock deliberately does **not** own the plain-timer session. The
 * session lives in the main process and arrives on `status.focus`, so
 * quitting the window mid-session or reloading the renderer does not lose
 * it. A Pomodoro run's phase/pause state, by contrast, is renderer-local by
 * necessity — see `usePomodoro`.
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
import { EditError } from '../../core/edits'
import {
  MAX_POMODORO_BREAK_MINUTES,
  MAX_POMODORO_WORK_MINUTES,
  MIN_POMODORO_BREAK_MINUTES,
  MIN_POMODORO_WORK_MINUTES,
  POMODORO_PRESETS,
  validatePomodoroPlan,
} from '../../core/pomodoro'
import type { ActiveFocus, AmbientBedId } from '../../core/types'
import { createAmbientEngine, type AmbientEngine } from '../lib/ambient'
import { clock, duration, timeOfDay } from '../lib/format'
import type { MusicPlayerState } from '../lib/useMusicPlayer'
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
  IconSound,
  IconSoundOff,
  IconStop,
} from './Icons'
import { MusicPlayerControl } from './MusicPlayer'

/** Minutes a single "extend" adds. One preset, because two would be a menu. */
const EXTEND_MINUTES = 15

/**
 * The whole feature, mounted once by the shell.
 *
 * `open` is the setup sheet only — whether a session is *running* is never
 * renderer state for the plain timer (it is `app.status.focus`); for
 * Pomodoro it is `pomodoro.run`, which `App.tsx` also reads to drive the
 * rail's chip. Both are passed in rather than owned here so the two stay one
 * source of truth.
 */
export function FocusMode({
  app,
  pomodoro,
  musicPlayer,
  open,
  onOpenChange,
  onOpenCalendar,
}: {
  app: OpenTimeState
  pomodoro: ReturnType<typeof usePomodoro>
  musicPlayer: MusicPlayerState
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

  // Sound follows whichever kind of session is actually running — a plain
  // timer's own choice, or a Pomodoro run's — and stops the moment neither
  // is, including across a Pomodoro's break phases where there is no active
  // `status.focus` at all but the run has not ended.
  const runningSound = pomodoro.run?.sound ?? sound
  useEffect(() => {
    if (!active && !pomodoro.run) {
      engine.current?.stop()
      return
    }
    ambient().play(muted ? 'silence' : runningSound)
  }, [active, pomodoro.run, runningSound, muted])

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

  const startPomodoro = async (input: {
    label: string
    projectId?: string
    sound: AmbientBedId
    workMinutes: number
    breakMinutes: number
  }) => {
    await pomodoro.start(input)
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

  const showSetup = open && !active && !pomodoro.run

  return (
    <>
      {showSetup
        ? createPortal(
            <FocusSetup
              app={app}
              musicPlayer={musicPlayer}
              error={error}
              onCancel={() => {
                setError(null)
                onOpenChange(false)
              }}
              onStart={(input) => void start(input)}
              onStartPomodoro={(input) => void startPomodoro(input)}
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
              musicPlayer={musicPlayer}
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
                sound={sound}
                muted={muted}
                error={error}
                musicPlayer={musicPlayer}
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

type FocusSetupMode = 'timer' | 'pomodoro'
type PomodoroPresetChoice = (typeof POMODORO_PRESETS)[number]['id'] | 'custom'

function FocusSetup({
  app,
  musicPlayer,
  error,
  onCancel,
  onStart,
  onStartPomodoro,
}: {
  app: OpenTimeState
  musicPlayer: MusicPlayerState
  error: string | null
  onCancel(): void
  onStart(input: { label: string; minutes: number; projectId?: string; sound: AmbientBedId }): void
  onStartPomodoro(input: {
    label: string
    projectId?: string
    sound: AmbientBedId
    workMinutes: number
    breakMinutes: number
  }): void
}) {
  const [mode, setMode] = useState<FocusSetupMode>('timer')
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState<number>(DEFAULT_FOCUS_MINUTES)
  const [preset, setPreset] = useState<PomodoroPresetChoice>(POMODORO_PRESETS[0].id)
  const [customWork, setCustomWork] = useState(POMODORO_PRESETS[0].workMinutes)
  const [customBreak, setCustomBreak] = useState(POMODORO_PRESETS[0].breakMinutes)
  const [planError, setPlanError] = useState<string | null>(null)
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

  const activePreset = POMODORO_PRESETS.find((p) => p.id === preset)
  const workMinutes = activePreset ? activePreset.workMinutes : customWork
  const breakMinutes = activePreset ? activePreset.breakMinutes : customBreak

  const submitPomodoro = () => {
    try {
      const plan = validatePomodoroPlan({ workMinutes, breakMinutes })
      setPlanError(null)
      onStartPomodoro({ label, projectId: projectId || undefined, sound, ...plan })
    } catch (e) {
      setPlanError(e instanceof EditError ? e.message : 'That timing is not usable.')
    }
  }

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

        <div className="seg grow focus-mode-seg">
          <button className={mode === 'timer' ? 'on' : ''} onClick={() => setMode('timer')}>
            Timer
          </button>
          <button className={mode === 'pomodoro' ? 'on' : ''} onClick={() => setMode('pomodoro')}>
            Pomodoro
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
              if (e.key !== 'Enter') return
              if (mode === 'timer') onStart({ label, minutes, projectId: projectId || undefined, sound })
              else submitPomodoro()
            }}
          />
        </div>

        {mode === 'timer' ? (
          <div className="focus-field">
            <label>For how long?</label>
            <div className="seg focus-durations">
              {FOCUS_PRESET_MINUTES.map((p) => (
                <button key={p} className={minutes === p ? 'on' : ''} onClick={() => setMinutes(p)}>
                  {p}m
                </button>
              ))}
            </div>
            <p className="focus-hint">
              Ends around {timeOfDay(ends)}. Running past it is fine — nothing is cut off.
            </p>
          </div>
        ) : (
          <div className="focus-field">
            <label>Work / break</label>
            <div className="seg focus-durations">
              {POMODORO_PRESETS.map((p) => (
                <button key={p.id} className={preset === p.id ? 'on' : ''} onClick={() => setPreset(p.id)}>
                  {p.label}
                </button>
              ))}
              <button className={preset === 'custom' ? 'on' : ''} onClick={() => setPreset('custom')}>
                Custom
              </button>
            </div>
            {preset === 'custom' ? (
              <div className="pomodoro-custom">
                <label>
                  Work
                  <input
                    type="number"
                    className="input"
                    min={MIN_POMODORO_WORK_MINUTES}
                    max={MAX_POMODORO_WORK_MINUTES}
                    value={customWork}
                    onChange={(e) => setCustomWork(Number(e.target.value))}
                  />
                  <span>min</span>
                </label>
                <label>
                  Break
                  <input
                    type="number"
                    className="input"
                    min={MIN_POMODORO_BREAK_MINUTES}
                    max={MAX_POMODORO_BREAK_MINUTES}
                    value={customBreak}
                    onChange={(e) => setCustomBreak(Number(e.target.value))}
                  />
                  <span>min</span>
                </label>
              </div>
            ) : null}
            <p className="focus-hint">
              {workMinutes}m of work, then a {breakMinutes}m break, repeating until you stop it. Only
              the work blocks are tracked as focus time.
            </p>
            {planError ? <div className="focus-error">{planError}</div> : null}
          </div>
        )}

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

        <div className="focus-field">
          <label>Music</label>
          <MusicPlayerControl player={musicPlayer} label="Play music" />
          <p className="focus-hint">
            A separate ambient player, independent of this session — it never affects tracked time.
          </p>
        </div>

        {error ? <div className="focus-error">{error}</div> : null}

        <div className="focus-sheet-foot">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          {mode === 'timer' ? (
            <button
              className="btn primary"
              onClick={() => onStart({ label, minutes, projectId: projectId || undefined, sound })}
            >
              <IconFocus size={15} />
              Start {minutes}-minute session
            </button>
          ) : (
            <button className="btn primary" onClick={submitPomodoro}>
              <IconFocus size={15} />
              Start Pomodoro
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Running: plain timer ────────────────────────────────────────────────────

function FocusDock({
  focus,
  sound,
  muted,
  error,
  musicPlayer,
  onSound,
  onMute,
  onExtend,
  onEnd,
}: {
  focus: ActiveFocus
  sound: AmbientBedId
  muted: boolean
  error: string | null
  musicPlayer: MusicPlayerState
  onSound(bed: AmbientBedId): void
  onMute(): void
  onExtend(): void
  onEnd(): void
}) {
  const now = useNow(1000)
  const [picking, setPicking] = useState(false)
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

        <MusicPlayerControl player={musicPlayer} label="Music" compact />

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

// ── Running: Pomodoro ───────────────────────────────────────────────────────

function PomodoroDock({
  run,
  progress,
  error,
  busy,
  musicPlayer,
  onPause,
  onResume,
  onSkip,
  onStop,
}: {
  run: NonNullable<ReturnType<typeof usePomodoro>['run']>
  progress: ReturnType<typeof usePomodoro>['progress']
  error: string | null
  /** A phase transition is in flight — Pause/Resume/Skip are disabled so a double-click can't race it. Stop stays live: it is always allowed to interrupt. */
  busy: boolean
  musicPlayer: MusicPlayerState
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
          <span className={`pomodoro-phase-badge ${run.phase}`}>{work ? 'Work' : 'Break'}</span>
          {run.label}
        </div>
        <div className="focus-dock-time">
          <b>{clock(progress?.remainingSeconds ?? 0)}</b>
          <span>{run.paused ? 'paused' : work ? `left of ${run.workMinutes}m work` : `left of ${run.breakMinutes}m break`}</span>
        </div>
      </div>

      <div className="focus-dock-actions">
        <MusicPlayerControl player={musicPlayer} label="Music" compact />

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
          title={`Skip to ${work ? 'break' : 'work'}`}
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
