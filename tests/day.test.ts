import { describe, expect, it } from 'vitest'

import { dayKey, dayKeyRange, dayStartTs, lastNDayKeys, nextDayBoundary, parseYmdLocal } from '../src/core/day'

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

describe('dayKey', () => {
  it('buckets an afternoon into its own calendar date', () => {
    expect(dayKey(at(2026, 3, 14, 15), 4)).toBe('2026-03-14')
  })

  it('buckets 1am into the previous day when the day starts at 4am', () => {
    expect(dayKey(at(2026, 3, 14, 1), 4)).toBe('2026-03-13')
  })

  it('rolls over exactly at the boundary hour', () => {
    expect(dayKey(at(2026, 3, 14, 3, 59), 4)).toBe('2026-03-13')
    expect(dayKey(at(2026, 3, 14, 4, 0), 4)).toBe('2026-03-14')
  })

  it('uses local calendar fields, not UTC — the bug the predecessor had to migrate away from', () => {
    const ts = at(2026, 12, 31, 23, 30)
    // Whatever the machine timezone, a local 11:30pm on the 31st belongs to
    // the 31st. A toISOString()-based key would say the 1st for UTC-negative
    // offsets.
    expect(dayKey(ts, 4)).toBe('2026-12-31')
  })
})

describe('nextDayBoundary', () => {
  it('returns today’s boundary when the instant is before it', () => {
    expect(nextDayBoundary(at(2026, 3, 14, 1), 4)).toBe(at(2026, 3, 14, 4))
  })

  it('returns tomorrow’s boundary when the instant is after it', () => {
    expect(nextDayBoundary(at(2026, 3, 14, 10), 4)).toBe(at(2026, 3, 15, 4))
  })

  it('is strictly after the instant, even exactly on a boundary', () => {
    const boundary = at(2026, 3, 14, 4)
    expect(nextDayBoundary(boundary, 4)).toBe(at(2026, 3, 15, 4))
  })
})

describe('day key ranges', () => {
  it('is inclusive of both ends', () => {
    expect(dayKeyRange('2026-03-12', '2026-03-15')).toEqual([
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
      '2026-03-15',
    ])
  })

  it('crosses a month boundary', () => {
    expect(dayKeyRange('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ])
  })

  it('lastNDayKeys ends at the given key', () => {
    const keys = lastNDayKeys(7, '2026-03-14')
    expect(keys).toHaveLength(7)
    expect(keys[6]).toBe('2026-03-14')
    expect(keys[0]).toBe('2026-03-08')
  })
})

describe('dayStartTs', () => {
  it('is the boundary hour of the keyed local date', () => {
    expect(dayStartTs('2026-03-14', 4)).toBe(at(2026, 3, 14, 4))
  })

  it('round-trips with parseYmdLocal', () => {
    expect(parseYmdLocal('2026-03-14').getDate()).toBe(14)
  })
})
