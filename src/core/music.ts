/**
 * Ambient music tracks.
 *
 * Deliberately not a timer. It used to be — a countdown with its own dock,
 * competing with Focus for the same "start something" moment on the rail.
 * That was two primary actions doing similar-looking things, which is worse
 * than one. Music is now just a background player: pick a track, play or
 * pause it, set a volume. It never touches tracked time, never seals
 * anything, and carries no category or project — it is closer to a car radio
 * than to `focus.ts`. That is also why the player state lives entirely in the
 * renderer (`src/renderer/lib/music.ts` for the audio, `MusicPlayer.tsx` for
 * the UI) rather than in the main process: nothing here has to survive a
 * reload for a record to stay correct, because there is no record.
 *
 * Pure and dependency-free; `tests/music.test.ts` pins it.
 */

import type { AmbientBedId } from './types'

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

/** The track a fresh player opens on. */
export const DEFAULT_MUSIC_TRACK: MusicTrackId = 'lofi'

/**
 * Ambient sounds, played by the same player as the tracks. They used to be a
 * separate "Sound" choice inside Focus, next to a separate "Music" button,
 * which put two audio controls in the one place that should be about starting
 * to work. They share `AmbientBedId` with the focus model so an old session
 * record still reads, but only the player offers them now.
 */
export type AmbientSoundId = Exclude<AmbientBedId, 'silence'>

export const AMBIENT_SOUNDS: Array<{ id: AmbientSoundId; label: string; detail: string }> = [
  { id: 'rain', label: 'Rain', detail: 'Steady rain on a window.' },
  { id: 'ocean', label: 'Waves', detail: 'A slow swell that rises and falls.' },
  { id: 'cafe', label: 'Room tone', detail: 'The low hum of a busy room.' },
  { id: 'deep', label: 'Deep hum', detail: 'A dark drone with nothing to follow.' },
]

/** Anything the player can play. */
export type PlayerSound = MusicTrackId | AmbientSoundId

/** The label of any sound the player knows. */
export function soundLabel(id: PlayerSound): string {
  return (
    MUSIC_TRACKS.find((t) => t.id === id)?.label ??
    AMBIENT_SOUNDS.find((s) => s.id === id)?.label ??
    id
  )
}

/** Clamp a volume slider's raw input into the 0–1 the audio engine expects. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}
