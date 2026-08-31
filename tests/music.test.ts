import { describe, expect, it } from 'vitest'

import { EditError } from '../src/core/edits'
import {
  DEFAULT_MUSIC_MINUTES,
  MUSIC_TRACKS,
  isMusicTrack,
  musicProgress,
  startMusicTimer,
} from '../src/core/music'

const T0 = new Date('2026-03-09T09:00:00').getTime()
const min = (n: number) => n * 60_000

describe('isMusicTrack', () => {
  it('accepts every id in MUSIC_TRACKS', () => {
    for (const t of MUSIC_TRACKS) expect(isMusicTrack(t.id)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isMusicTrack('birdsong')).toBe(false)
    expect(isMusicTrack(undefined)).toBe(false)
    expect(isMusicTrack(42)).toBe(false)
  })
})

describe('startMusicTimer', () => {
  it('defaults to lofi and the default length', () => {
    const timer = startMusicTimer({}, T0)
    expect(timer.track).toBe('lofi')
    expect(timer.plannedSeconds).toBe(DEFAULT_MUSIC_MINUTES * 60)
    expect(timer.startTime).toBe(T0)
  })

  it('falls back to lofi for an unknown track rather than throwing', () => {
    expect(startMusicTimer({ track: 'jazz' as never }, T0).track).toBe('lofi')
  })

  it('accepts every real track', () => {
    for (const t of MUSIC_TRACKS) {
      expect(startMusicTimer({ track: t.id }, T0).track).toBe(t.id)
    }
  })

  it('treats 0 minutes as open-ended, not an error', () => {
    expect(startMusicTimer({ minutes: 0 }, T0).plannedSeconds).toBe(0)
  })

  it('rejects a negative length', () => {
    expect(() => startMusicTimer({ minutes: -5 }, T0)).toThrow(EditError)
  })

  it('rejects a length past 8 hours', () => {
    expect(() => startMusicTimer({ minutes: 8 * 60 + 1 }, T0)).toThrow(EditError)
  })
})

describe('musicProgress', () => {
  it('reports zero elapsed at the start', () => {
    const timer = startMusicTimer({ minutes: 25 }, T0)
    const p = musicProgress(timer, T0)
    expect(p.elapsedSeconds).toBe(0)
    expect(p.fraction).toBe(0)
    expect(p.overrun).toBe(false)
    expect(p.openEnded).toBe(false)
  })

  it('counts down toward zero remaining', () => {
    const timer = startMusicTimer({ minutes: 25 }, T0)
    const p = musicProgress(timer, T0 + min(10))
    expect(p.elapsedSeconds).toBe(600)
    expect(p.remainingSeconds).toBe(900)
    expect(p.fraction).toBeCloseTo(10 / 25, 5)
  })

  it('reports overrun without going negative', () => {
    const timer = startMusicTimer({ minutes: 25 }, T0)
    const p = musicProgress(timer, T0 + min(30))
    expect(p.overrun).toBe(true)
    expect(p.overrunSeconds).toBe(300)
    expect(p.remainingSeconds).toBe(0)
    expect(p.fraction).toBe(1)
  })

  it('never overruns and never reports remaining time when open-ended', () => {
    const timer = startMusicTimer({ minutes: 0 }, T0)
    const p = musicProgress(timer, T0 + min(120))
    expect(p.openEnded).toBe(true)
    expect(p.overrun).toBe(false)
    expect(p.remainingSeconds).toBe(0)
    expect(p.fraction).toBe(0)
    expect(p.elapsedSeconds).toBe(7200)
  })
})
