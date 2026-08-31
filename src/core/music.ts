/**
 * The Music timer.
 *
 * Distinct from a focus session on purpose: this is background listening with
 * a countdown, not a claim over tracked time. It never touches a day's
 * sessions, never seals anything, and carries no category or project — it is
 * closer to a kitchen timer with a soundtrack than to `focus.ts`. That is why
 * it lives entirely in the renderer (`src/renderer/lib/music.ts` for the
 * audio, `MusicTimer.tsx` for the UI) rather than in the main process: nothing
 * here has to survive a reload for the record to stay correct, because there
 * is no record.
 *
 * Pure and dependency-free; `tests/music.test.ts` pins it.
 */

import { EditError } from './edits'

/** See `docs/audio-licenses.md` for what each of these actually is and where it came from. */
export type MusicTrackId = 'lofi' | 'whale' | 'alpha' | 'classical'

export const MUSIC_TRACKS: Array<{ id: MusicTrackId; label: string; detail: string }> = [
  { id: 'lofi', label: 'Lo-fi', detail: 'Soft chords and tape hiss, generated on this machine.' },
  {
    id: 'whale',
    label: 'Whale song',
    detail: 'A public-domain NOAA recording of a humpback whale off Alaska.',
  },
  {
    id: 'alpha',
    label: 'Alpha waves',
    detail: 'A gentle binaural tone around 10Hz. Best with headphones.',
  },
  { id: 'classical', label: 'Classical', detail: 'A calm original piano motif, generated on this machine.' },
]

export function isMusicTrack(value: unknown): value is MusicTrackId {
  return MUSIC_TRACKS.some((t) => t.id === value)
}

/** Preset lengths offered in the setup panel, in minutes. 0 is "until stopped". */
export const MUSIC_PRESET_MINUTES = [0, 15, 25, 45, 60] as const

/** The default a timer starts at when the user does not choose. */
export const DEFAULT_MUSIC_MINUTES = 25

export interface MusicStartInput {
  track?: MusicTrackId
  minutes?: number
}

/** A music timer running right now. Held in the renderer, never on disk. */
export interface ActiveMusicTimer {
  track: MusicTrackId
  /** Epoch ms. */
  startTime: number
  /** Planned length in seconds. 0 means open-ended — runs until stopped. */
  plannedSeconds: number
}

export function startMusicTimer(input: MusicStartInput, now = Date.now()): ActiveMusicTimer {
  const minutes = Number.isFinite(input.minutes) ? Math.round(input.minutes as number) : DEFAULT_MUSIC_MINUTES
  if (minutes < 0 || minutes > 8 * 60) {
    throw new EditError('A music timer runs up to 8 hours, or open-ended.')
  }
  return {
    track: isMusicTrack(input.track) ? input.track : 'lofi',
    startTime: Math.round(now),
    plannedSeconds: minutes * 60,
  }
}

export interface MusicProgress {
  elapsedSeconds: number
  /** Always 0 when the timer is open-ended. */
  remainingSeconds: number
  /** 0–1, clamped. Always 0 when the timer is open-ended. */
  fraction: number
  overrun: boolean
  overrunSeconds: number
  /** True when the timer has no planned length and runs until stopped. */
  openEnded: boolean
}

export function musicProgress(timer: ActiveMusicTimer, now = Date.now()): MusicProgress {
  const elapsed = Math.max(0, Math.round((now - timer.startTime) / 1000))
  const openEnded = timer.plannedSeconds <= 0
  if (openEnded) {
    return {
      elapsedSeconds: elapsed,
      remainingSeconds: 0,
      fraction: 0,
      overrun: false,
      overrunSeconds: 0,
      openEnded,
    }
  }
  const remaining = timer.plannedSeconds - elapsed
  return {
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, remaining),
    fraction: Math.min(1, elapsed / timer.plannedSeconds),
    overrun: remaining < 0,
    overrunSeconds: Math.max(0, -remaining),
    openEnded,
  }
}
