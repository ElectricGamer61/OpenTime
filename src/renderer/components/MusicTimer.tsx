/**
 * The Music timer, in the renderer.
 *
 * Deliberately not a variant of `Focus.tsx`. A focus session is a claim over
 * tracked time and has to survive the window reloading, so it lives in the
 * main process; a music timer is background listening with a countdown and
 * has no consequence for the timeline at all, so it lives entirely here.
 * Ending it, closing the window, or reloading just stops the sound — there is
 * nothing to seal and nothing to lose.
 *
 * Same two surfaces as Focus for the same reason: a setup sheet and a dock
 * that sits over the app while it runs, both portalled to `document.body` —
 * see the note at the top of `Focus.tsx` for why `position: fixed` needs that
 * here.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  DEFAULT_MUSIC_MINUTES,
  MUSIC_PRESET_MINUTES,
  MUSIC_TRACKS,
  musicProgress,
  startMusicTimer,
  type ActiveMusicTimer,
  type MusicTrackId,
} from '../../core/music'
import { clock, duration, timeOfDay } from '../lib/format'
import { createMusicEngine, type MusicEngine } from '../lib/music'
import { useNow } from '../state/useOpenTime'
import { IconClose, IconMusic, IconPlus, IconSound, IconSoundOff, IconStop } from './Icons'

/** Minutes a single "extend" adds. Meaningless for an open-ended timer, so the dock hides it there. */
const EXTEND_MINUTES = 15

export function MusicMode({
  open,
  onOpenChange,
  onActiveChange,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  /** Told about the running timer so the rail button can show it — see `MusicButton`. */
  onActiveChange?(active: ActiveMusicTimer | null): void
}) {
  const [active, setActive] = useState<ActiveMusicTimer | null>(null)
  const [muted, setMuted] = useState(false)
  const engine = useRef<MusicEngine | null>(null)

  useEffect(() => onActiveChange?.(active), [active, onActiveChange])

  // Built on first use, never on mount — see `ambient.ts` for why constructing
  // an `AudioContext` before anyone asks for sound is the wrong moment.
  const music = () => {
    if (!engine.current) engine.current = createMusicEngine()
    return engine.current
  }

  useEffect(() => () => engine.current?.dispose(), [])

  useEffect(() => {
    if (!active) {
      engine.current?.stop()
      return
    }
    music().play(muted ? null : active.track)
  }, [active, muted])

  const start = (input: { track: MusicTrackId; minutes: number }) => {
    setActive(startMusicTimer(input))
    setMuted(false)
    onOpenChange(false)
  }

  const setTrack = (track: MusicTrackId) => setActive((prev) => (prev ? { ...prev, track } : prev))

  const extend = () =>
    setActive((prev) =>
      prev && prev.plannedSeconds > 0 ? { ...prev, plannedSeconds: prev.plannedSeconds + EXTEND_MINUTES * 60 } : prev
    )

  const end = () => {
    engine.current?.stop()
    setActive(null)
  }

  return (
    <>
      {open && !active
        ? createPortal(
            <MusicSetup onCancel={() => onOpenChange(false)} onStart={start} />,
            document.body
          )
        : null}

      {active
        ? createPortal(
            <MusicDock
              timer={active}
              muted={muted}
              onTrack={setTrack}
              onMute={() => setMuted((v) => !v)}
              onExtend={extend}
              onEnd={end}
            />,
            document.body
          )
        : null}
    </>
  )
}

// ── Setup ────────────────────────────────────────────────────────────────────

function MusicSetup({
  onCancel,
  onStart,
}: {
  onCancel(): void
  onStart(input: { track: MusicTrackId; minutes: number }): void
}) {
  const [track, setTrack] = useState<MusicTrackId>('lofi')
  const [minutes, setMinutes] = useState<number>(DEFAULT_MUSIC_MINUTES)
  const engine = useRef<MusicEngine | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Auditioning a track here is the only honest way to choose one — see the
  // identical note in `Focus.tsx`'s setup sheet.
  useEffect(() => {
    if (!engine.current) engine.current = createMusicEngine()
    engine.current.setVolume(0.25)
    engine.current.play(track)
    return () => engine.current?.stop()
  }, [track])

  useEffect(() => () => engine.current?.dispose(), [])

  const ends = minutes > 0 ? Date.now() + minutes * 60_000 : null

  return (
    <div className="drawer-scrim focus-scrim" onClick={onCancel}>
      <div
        className="focus-sheet"
        role="dialog"
        aria-label="Start the music timer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="focus-sheet-head">
          <span className="focus-sheet-mark">
            <IconMusic size={18} />
          </span>
          <div>
            <h2>Music timer</h2>
            <p>Background listening with a countdown. Nothing here touches your tracked time.</p>
          </div>
          <button className="icon-btn" onClick={onCancel} title="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="focus-field">
          <label>Track</label>
          <div className="focus-beds music-tracks">
            {MUSIC_TRACKS.map((t) => (
              <button
                key={t.id}
                className={`focus-bed${track === t.id ? ' on' : ''}`}
                onClick={() => setTrack(t.id)}
                title={t.detail}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="focus-hint">{MUSIC_TRACKS.find((t) => t.id === track)?.detail}</p>
        </div>

        <div className="focus-field">
          <label>For how long?</label>
          <div className="seg focus-durations">
            {MUSIC_PRESET_MINUTES.map((preset) => (
              <button
                key={preset}
                className={minutes === preset ? 'on' : ''}
                onClick={() => setMinutes(preset)}
              >
                {preset === 0 ? 'Until stopped' : `${preset}m`}
              </button>
            ))}
          </div>
          <p className="focus-hint">
            {ends ? `Ends around ${timeOfDay(ends)}. Running past it is fine.` : 'Plays until you stop it.'}
          </p>
        </div>

        <div className="focus-sheet-foot">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onStart({ track, minutes })}>
            <IconMusic size={15} />
            Start
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Running ──────────────────────────────────────────────────────────────────

function MusicDock({
  timer,
  muted,
  onTrack,
  onMute,
  onExtend,
  onEnd,
}: {
  timer: ActiveMusicTimer
  muted: boolean
  onTrack(track: MusicTrackId): void
  onMute(): void
  onExtend(): void
  onEnd(): void
}) {
  const now = useNow(1000)
  const [picking, setPicking] = useState(false)
  const progress = useMemo(() => musicProgress(timer, now), [timer, now])
  const label = MUSIC_TRACKS.find((t) => t.id === timer.track)?.label ?? timer.track

  const size = 44
  const stroke = 3.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius

  return (
    <div className={`focus-dock music-dock${progress.overrun ? ' overrun' : ''}`} role="status">
      {progress.openEnded ? (
        <span className="music-dock-mark">
          <IconMusic size={18} />
        </span>
      ) : (
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
      )}

      <div className="focus-dock-text">
        <div className="focus-dock-label" title={label}>
          {label}
        </div>
        <div className="focus-dock-time">
          {progress.openEnded ? (
            <>
              <b>{clock(progress.elapsedSeconds)}</b>
              <span>elapsed</span>
            </>
          ) : (
            <>
              <b>{clock(progress.overrun ? progress.overrunSeconds : progress.remainingSeconds)}</b>
              <span>
                {progress.overrun ? `over ${duration(timer.plannedSeconds)}` : `left of ${duration(timer.plannedSeconds)}`}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="focus-dock-actions">
        <div className="focus-sound-wrap">
          <button
            className={`icon-btn${muted ? '' : ' on'}`}
            onClick={() => setPicking((v) => !v)}
            title="Track"
            aria-expanded={picking}
          >
            {muted ? <IconSoundOff size={16} /> : <IconSound size={16} />}
          </button>
          {picking ? (
            <div className="focus-sound-menu" role="menu">
              {MUSIC_TRACKS.map((t) => (
                <button
                  key={t.id}
                  className={timer.track === t.id && !muted ? 'on' : ''}
                  onClick={() => {
                    onTrack(t.id)
                    setPicking(false)
                  }}
                >
                  <span>{t.label}</span>
                  <small>{t.detail}</small>
                </button>
              ))}
              <button className="focus-sound-mute" onClick={onMute}>
                {muted ? 'Unmute' : 'Mute for now'}
              </button>
            </div>
          ) : null}
        </div>

        {progress.openEnded ? null : (
          <button className="btn ghost small" onClick={onExtend} title={`Add ${EXTEND_MINUTES} minutes`}>
            <IconPlus size={14} />
            {EXTEND_MINUTES}m
          </button>
        )}
        <button className="btn danger small" onClick={onEnd}>
          <IconStop size={13} />
          Stop
        </button>
      </div>
    </div>
  )
}
