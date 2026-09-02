/**
 * The demo generator is what a reviewer (and a first-run user on a machine
 * without OS capture) actually sees, so it gets the same scrutiny as live
 * capture — an earlier version emitted only idle blocks because its samples
 * were spaced wider than the session gap and every stretch was discarded.
 */

import { describe, expect, it } from 'vitest'

import { summarizeDay } from '../src/core/aggregate'
import { dayKey } from '../src/core/day'
import { DEFAULT_PROJECTS, DEFAULT_RULES, DEFAULT_SETTINGS } from '../src/core/defaults'
import { generateDemoDay, seededRandom, shouldSeedDemo } from '../src/core/demo'

const opts = {
  dayStartHour: DEFAULT_SETTINGS.dayStartHour,
  sessionGapSeconds: DEFAULT_SETTINGS.sessionGapSeconds,
  projects: DEFAULT_PROJECTS,
  rules: DEFAULT_RULES,
}

describe('generateDemoDay', () => {
  it('produces a substantial tracked weekday, not just idle time', () => {
    const day = generateDemoDay('2026-03-12', opts) // a Thursday
    expect(day.sessions.length).toBeGreaterThan(5)
    const summary = summarizeDay('2026-03-12', day.sessions, day.idle, day.events)
    expect(summary.totalSeconds).toBeGreaterThan(3 * 3600)
    expect(summary.productiveSeconds).toBeGreaterThan(0)
    expect(summary.byCategory.length).toBeGreaterThan(1)
    expect(summary.focusScore).toBeGreaterThan(0)
  })

  it('keeps every session inside the day it is keyed to', () => {
    const day = generateDemoDay('2026-03-12', opts)
    for (const s of day.sessions) {
      expect(dayKey(s.startTime, opts.dayStartHour)).toBe('2026-03-12')
      expect(s.endTime).toBeGreaterThan(s.startTime)
    }
  })

  it('never overlaps sessions with each other', () => {
    const day = generateDemoDay('2026-03-12', opts)
    const sorted = [...day.sessions].sort((a, b) => a.startTime - b.startTime)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startTime).toBeGreaterThanOrEqual(sorted[i - 1].endTime)
    }
  })

  it('is deterministic for a given day key', () => {
    const a = generateDemoDay('2026-03-12', opts)
    const b = generateDemoDay('2026-03-12', opts)
    expect(a.sessions.map((s) => [s.category, s.durationSeconds])).toEqual(
      b.sessions.map((s) => [s.category, s.durationSeconds])
    )
  })

  it('gives different days different shapes', () => {
    const a = generateDemoDay('2026-03-12', opts)
    const b = generateDemoDay('2026-03-13', opts)
    expect(a.sessions.length).not.toBe(0)
    expect(a.sessions.map((s) => s.durationSeconds)).not.toEqual(
      b.sessions.map((s) => s.durationSeconds)
    )
  })

  it('produces a lighter weekend with no meetings', () => {
    const saturday = generateDemoDay('2026-03-14', opts)
    expect(new Date(saturday.sessions[0].startTime).getDay()).toBe(6)
    expect(saturday.events).toEqual([])
  })

  it('places calendar events inside the weekday', () => {
    const day = generateDemoDay('2026-03-12', opts)
    for (const e of day.events) expect(e.end).toBeGreaterThan(e.start)
  })
})

describe('seededRandom', () => {
  it('is reproducible and stays in [0, 1)', () => {
    const a = Array.from({ length: 50 }, seededRandom(42))
    const b = Array.from({ length: 50 }, seededRandom(42))
    expect(a).toEqual(b)
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('shouldSeedDemo', () => {
  const base = { captureIsDemo: true, seedDemoWhenUnavailable: true, storeIsEmpty: true }

  it('seeds only when capture is unavailable, the user opted in, and the store is empty', () => {
    expect(shouldSeedDemo(base)).toBe(true)
  })

  it('never seeds on a fresh install with the honest default (opted out)', () => {
    expect(shouldSeedDemo({ ...base, seedDemoWhenUnavailable: false })).toBe(false)
  })

  it('never seeds while real capture is working, opt-in or not', () => {
    expect(shouldSeedDemo({ ...base, captureIsDemo: false })).toBe(false)
  })

  it('never seeds into a store that already has real days', () => {
    expect(shouldSeedDemo({ ...base, storeIsEmpty: false })).toBe(false)
  })
})
