import { describe, expect, it } from 'vitest'

import { DEFAULT_MUSIC_TRACK, MUSIC_TRACKS, clampVolume, isMusicTrack } from '../src/core/music'

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

describe('DEFAULT_MUSIC_TRACK', () => {
  it('is a real track', () => {
    expect(isMusicTrack(DEFAULT_MUSIC_TRACK)).toBe(true)
  })
})

describe('clampVolume', () => {
  it('passes ordinary values through', () => {
    expect(clampVolume(0.4)).toBe(0.4)
    expect(clampVolume(0)).toBe(0)
    expect(clampVolume(1)).toBe(1)
  })

  it('clamps out-of-range values', () => {
    expect(clampVolume(-0.5)).toBe(0)
    expect(clampVolume(1.5)).toBe(1)
  })

  it('falls back to full volume for a non-finite input rather than silencing the player', () => {
    expect(clampVolume(NaN)).toBe(1)
    expect(clampVolume(Infinity)).toBe(1)
  })
})
