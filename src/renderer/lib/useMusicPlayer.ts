/**
 * Background audio: music tracks and ambient sounds, in one player.
 *
 * One instance is created by the shell (`App.tsx`) for the rail's Music
 * control. It is deliberately not part of Focus: starting to focus is one
 * decision, and what to listen to is a separate one you can make any time.
 *
 * Two engines sit underneath, because the two kinds of audio are made
 * differently (`music.ts` renders tracks, `ambient.ts` shapes filtered noise),
 * but only one sound ever plays at a time. Each engine is built on first use,
 * never on mount: constructing an `AudioContext` before anyone asks for sound
 * marks the page as playing audio for the rest of its life.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { DEFAULT_MUSIC_TRACK, clampVolume, isMusicTrack, type PlayerSound } from '../../core/music'
import { createAmbientEngine, type AmbientEngine } from './ambient'
import { createMusicEngine, type MusicEngine } from './music'

export interface MusicPlayerState {
  track: PlayerSound
  playing: boolean
  volume: number
  /** Play this sound (switching from whatever was playing). */
  setTrack(track: PlayerSound): void
  toggle(): void
  setVolume(volume: number): void
}

export function useMusicPlayer(): MusicPlayerState {
  const [track, setTrackState] = useState<PlayerSound>(DEFAULT_MUSIC_TRACK)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolumeState] = useState(0.5)
  const music = useRef<MusicEngine | null>(null)
  const ambient = useRef<AmbientEngine | null>(null)

  const musicEngine = () => (music.current ??= createMusicEngine())
  const ambientEngine = () => (ambient.current ??= createAmbientEngine())

  useEffect(
    () => () => {
      music.current?.dispose()
      ambient.current?.dispose()
    },
    []
  )

  useEffect(() => {
    music.current?.setVolume(volume)
    ambient.current?.setVolume(volume)
  }, [volume])

  useEffect(() => {
    if (!playing) {
      music.current?.play(null)
      ambient.current?.stop()
      return
    }
    if (isMusicTrack(track)) {
      ambient.current?.stop()
      const engine = musicEngine()
      engine.setVolume(volume)
      engine.play(track)
    } else {
      music.current?.play(null)
      const engine = ambientEngine()
      engine.setVolume(volume)
      engine.play(track)
    }
    // Volume is applied by its own effect; depending on it here would restart
    // the sound on every slider movement.
  }, [playing, track])

  const setTrack = useCallback((next: PlayerSound) => {
    setTrackState(next)
    setPlaying(true)
  }, [])

  const toggle = useCallback(() => setPlaying((v) => !v), [])

  const setVolume = useCallback((next: number) => setVolumeState(clampVolume(next)), [])

  return { track, playing, volume, setTrack, toggle, setVolume }
}
