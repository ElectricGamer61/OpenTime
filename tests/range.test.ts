import { describe, expect, it } from 'vitest'

import {
  MAX_RANGE_DAYS,
  monthGrid,
  normalizeCustom,
  rangeContains,
  rangeFor,
  rangeKeys,
  rangeLabel,
  rangeLength,
  shiftRange,
} from '../src/core/range'

describe('rangeFor', () => {
  it('treats a week as the trailing seven days, matching the rest of the app', () => {
    const week = rangeFor('week', '2026-03-09')
    expect(week.fromKey).toBe('2026-03-03')
    expect(week.toKey).toBe('2026-03-09')
    expect(rangeLength(week)).toBe(7)
  })

  it('uses calendar months, including a short February', () => {
    expect(rangeFor('month', '2026-02-17')).toMatchObject({
      fromKey: '2026-02-01',
      toKey: '2026-02-28',
    })
    // 2028 is a leap year — the day count has to come from the calendar.
    expect(rangeFor('month', '2028-02-17').toKey).toBe('2028-02-29')
  })

  it('uses calendar quarters and years', () => {
    expect(rangeFor('quarter', '2026-05-06')).toMatchObject({
      fromKey: '2026-04-01',
      toKey: '2026-06-30',
    })
    expect(rangeFor('year', '2026-05-06')).toMatchObject({
      fromKey: '2026-01-01',
      toKey: '2026-12-31',
    })
    expect(rangeLength(rangeFor('year', '2026-05-06'))).toBe(365)
  })
})

describe('shiftRange', () => {
  it('steps a month by the calendar, not by 30 days', () => {
    const march = rangeFor('month', '2026-03-15')
    const february = shiftRange(march, -1)
    expect(february).toMatchObject({ fromKey: '2026-02-01', toKey: '2026-02-28' })
    expect(shiftRange(february, 1)).toMatchObject({ fromKey: '2026-03-01', toKey: '2026-03-31' })
  })

  it('slides a custom range by its own length, so "previous" means something', () => {
    const custom = normalizeCustom('2026-03-01', '2026-03-10')
    expect(shiftRange(custom, -1)).toMatchObject({ fromKey: '2026-02-19', toKey: '2026-02-28' })
  })

  it('steps a year across the boundary', () => {
    expect(shiftRange(rangeFor('year', '2026-06-01'), -1)).toMatchObject({
      fromKey: '2025-01-01',
      toKey: '2025-12-31',
    })
  })
})

describe('normalizeCustom', () => {
  it('swaps a reversed pair rather than refusing it', () => {
    expect(normalizeCustom('2026-03-10', '2026-03-01')).toMatchObject({
      fromKey: '2026-03-01',
      toKey: '2026-03-10',
    })
  })

  it('caps a slipped year so the store is never asked for four thousand days', () => {
    const huge = normalizeCustom('2020-01-01', '2026-01-01')
    expect(rangeLength(huge)).toBe(MAX_RANGE_DAYS)
  })
})

describe('rangeKeys and rangeContains', () => {
  it('enumerates every day inclusively', () => {
    const keys = rangeKeys({ kind: 'custom', fromKey: '2026-03-08', toKey: '2026-03-11' })
    expect(keys).toEqual(['2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11'])
  })

  it('crosses a DST boundary without dropping or duplicating a day', () => {
    // US DST starts 2026-03-08; a UTC-millisecond loop would produce 23h/25h
    // days and either skip or repeat one.
    const keys = rangeKeys(rangeFor('month', '2026-03-01'))
    expect(keys).toHaveLength(31)
    expect(new Set(keys).size).toBe(31)
  })

  it('is inclusive at both ends', () => {
    const march = rangeFor('month', '2026-03-15')
    expect(rangeContains(march, '2026-03-01')).toBe(true)
    expect(rangeContains(march, '2026-03-31')).toBe(true)
    expect(rangeContains(march, '2026-04-01')).toBe(false)
  })
})

describe('rangeLabel', () => {
  it('names a month, a quarter and a year the way people say them', () => {
    expect(rangeLabel(rangeFor('month', '2026-03-15'))).toContain('2026')
    expect(rangeLabel(rangeFor('quarter', '2026-05-01'))).toBe('Q2 2026')
    expect(rangeLabel(rangeFor('year', '2026-05-01'))).toBe('2026')
  })
})

describe('monthGrid', () => {
  it('lays a month out in whole weeks with blanks, never a neighbouring month', () => {
    const grid = monthGrid(rangeFor('month', '2026-03-01'))
    expect(grid.every((week) => week.length === 7)).toBe(true)
    const days = grid.flat().filter(Boolean)
    expect(days).toHaveLength(31)
    expect(days.every((key) => key!.startsWith('2026-03'))).toBe(true)
  })

  it('puts the first of the month in its real weekday column', () => {
    // 2026-03-01 is a Sunday, so with a Sunday-start week there is no lead.
    expect(monthGrid(rangeFor('month', '2026-03-01'))[0][0]).toBe('2026-03-01')
    // 2026-04-01 is a Wednesday: three blanks first.
    const april = monthGrid(rangeFor('month', '2026-04-01'))
    expect(april[0].slice(0, 3)).toEqual([null, null, null])
    expect(april[0][3]).toBe('2026-04-01')
  })
})
