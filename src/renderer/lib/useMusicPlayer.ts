/**
 * Ambient music playback state, shared by every surface that can reach it.
 *
 * One instance is created by the shell (`App.tsx`) and handed down to both
 * the rail's small player control and the button inside Focus that opens the
 * same popover — see `MusicPlayer.tsx`. Sharing one instance is what keeps
 * this to one `AudioContext` and one track playing at a time, however many
 * places can open the popover.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { DEFAULT_MUSIC_TRACK, clampVolume, type MusicTrackId } from '../../core/music'
import { createMusicEngine, type MusicEngine } from './music'

export interface MusicPlayerState {
  track: MusicTrackId
  playing: boolean
  volume: number
  setTrack(track: MusicTrackId): void
  toggle(): void
  setVolume(volume: number): void
}

export function useMusicPlayer(): MusicPlayerState {
  const [track, setTrackState] = useState<MusicTrackId>(DEFAULT_MUSIC_TRACK)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolumeState] = useState(0.5)
  const engine = useRef<MusicEngine | null>(null)

  // Built on first use, never on mount — see the identical note in `Focus.tsx`
  // for why constructing an `AudioContext` before anyone asks for sound is
  // the wrong moment.
  const player = () => {
    if (!engine.current) engine.current = createMusicEngine()
    return engine.current
  }

  useEffect(() => () => engine.current?.dispose(), [])

  useEffect(() => {
    player().setVolume(volume)
  }, [volume])

  useEffect(() => {
    player().play(playing ? track : null)
  }, [playing, track])

  const setTrack = useCallback((next: MusicTrackId) => {
    setTrackState(next)
    setPlaying(true)
  }, [])

  const toggle = useCallback(() => setPlaying((v) => !v), [])

  const setVolume = useCallback((next: number) => setVolumeState(clampVolume(next)), [])

  return { track, playing, volume, setTrack, toggle, setVolume }
}
