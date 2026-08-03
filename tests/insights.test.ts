import { describe, expect, it } from 'vitest'

import { summarizeDay } from '../src/core/aggregate'
import { buildInsights, buildRangeInsights, hourlyFocus, peakFocusWindow } from '../src/core/insights'
import type { CalendarEvent, Session } from '../src/core/types'

const at = (h: number, m = 0) => new Date(2026, 2, 14, h, m, 0, 0).getTime()

function session(id: string, from: number, to: number, patch: Partial<Session> = {}): Session {
  return {
    id,
    category: 'Deep Work',
    app: 'Code',
    title: '',
    url: '',
    productivity: 'productive',
    startTime: from,
    endTime: to,
    durationSeconds: Math.round((to - from) / 1000),
    ...patch,
  }
}

const ids = (list: { id: string }[]) => list.map((i) => i.id)

/** Two hours split into forty three-minute pieces, alternating category. */
function choppedUpDay(): Session[] {
  const sessions: Session[] = []
  for (let i = 0; i < 40; i++) {
    const start = at(9) + i * 3 * 60_000
    sessions.push(
      session(`s${i}`, start, start + 3 * 60_000, {
        category: i % 2 ? 'Deep Work' : 'Communication',
        productivity: i % 2 ? 'productive' : 'neutral',
      })
    )
  }
  return sessions
}

describe('hourlyFocus', () => {
  it('spreads a session across every hour it touches', () => {
    const hours = hourlyFocus([session('a', at(9, 30), at(11, 30))])
    expect(hours[9]).toBe(1800)
    expect(hours[10]).toBe(3600)
    expect(hours[11]).toBe(1800)
    expect(hours[12]).toBe(0)
  })

  it('counts only productive time', () => {
    const hours = hourlyFocus([
      session('a', at(9), at(10), { productivity: 'distracting' }),
      session('b', at(10), at(11), { productivity: 'neutral' }),
    ])
    expect(hours.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('peakFocusWindow', () => {
  it('finds the densest three-hour run', () => {
    const peak = peakFocusWindow([session('a', at(9), at(12)), session('b', at(16), at(16, 30))])
    expect(peak?.startHour).toBe(9)
    expect(peak?.seconds).toBe(3 * 3600)
  })

  it('returns nothing when there is no productive time at all', () => {
    expect(peakFocusWindow([session('a', at(9), at(12), { productivity: 'neutral' })])).toBeNull()
  })
})

describe('buildInsights', () => {
  const dayStartHour = 4

  it('says nothing at all about a barely-tracked day', () => {
    const sessions = [session('a', at(9), at(9, 5))]
    const summary = summarizeDay('2026-03-14', sessions)
    expect(buildInsights({ today: summary, sessions, week: [], dayStartHour })).toEqual([])
  })

  it('names the peak window on a solid day', () => {
    const sessions = [session('a', at(9), at(12)), session('b', at(13), at(15))]
    const summary = summarizeDay('2026-03-14', sessions)
    const insights = buildInsights({ today: summary, sessions, week: [], dayStartHour })
    expect(ids(insights)).toContain('peak-window')
  })

  it('calls out fragmentation rather than a deep block when the day was chopped up', () => {
    const sessions = choppedUpDay()
    const summary = summarizeDay('2026-03-14', sessions)
    const insights = buildInsights({ today: summary, sessions, week: [], dayStartHour })
    expect(ids(insights)).toContain('fragmentation')
    expect(ids(insights)).not.toContain('deep-block')
  })

  it('celebrates one long unbroken block on a calm day', () => {
    const sessions = [session('a', at(9), at(12))]
    const summary = summarizeDay('2026-03-14', sessions)
    expect(ids(buildInsights({ today: summary, sessions, week: [], dayStartHour }))).toContain(
      'deep-block'
    )
  })

  it('flags a day mostly eaten by meetings', () => {
    const sessions = [session('a', at(9), at(13))]
    const events: CalendarEvent[] = [
      { id: 'e1', title: 'All hands', start: at(9), end: at(11, 30), source: 'google' },
    ]
    const summary = summarizeDay('2026-03-14', sessions, [], events)
    expect(ids(buildInsights({ today: summary, sessions, week: [], dayStartHour }))).toContain(
      'meeting-load'
    )
  })

  it('names the biggest distraction by category', () => {
    const sessions = [
      session('a', at(9), at(12)),
      session('b', at(13), at(14), { category: 'Breaks', productivity: 'distracting' }),
    ]
    const summary = summarizeDay('2026-03-14', sessions)
    const insights = buildInsights({ today: summary, sessions, week: [], dayStartHour })
    const top = insights.find((i) => i.id === 'top-distraction')
    expect(top?.title).toContain('Breaks')
  })

  it('compares against the user’s own recent baseline, not a fixed ideal', () => {
    const sessions = [session('a', at(9), at(17))]
    const summary = summarizeDay('2026-03-14', sessions)
    const week = ['2026-03-10', '2026-03-11', '2026-03-12'].map((key) =>
      summarizeDay(key, [session(`p-${key}`, at(9), at(11))])
    )
    const insights = buildInsights({ today: summary, sessions, week, dayStartHour })
    const baseline = insights.find((i) => i.id === 'baseline')
    expect(baseline?.tone).toBe('good')
  })

  it('ranks the most important insight first', () => {
    const sessions = choppedUpDay()
    const summary = summarizeDay('2026-03-14', sessions)
    const insights = buildInsights({ today: summary, sessions, week: [], dayStartHour })
    expect(insights[0].weight).toBeGreaterThanOrEqual(insights[insights.length - 1].weight)
  })
})

describe('buildRangeInsights', () => {
  it('says nothing about a range with almost no data', () => {
    expect(buildRangeInsights([summarizeDay('2026-03-14', [])], 4)).toEqual([])
  })

  it('notices that no day in the range had a deep block', () => {
    const days = ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'].map((key) =>
      summarizeDay(key, [
        session(`a-${key}`, at(9), at(9, 20)),
        session(`b-${key}`, at(10), at(10, 20), { category: 'Communication', productivity: 'neutral' }),
        session(`c-${key}`, at(11), at(11, 20)),
      ])
    )
    expect(buildRangeInsights(days, 4).map((i) => i.id)).toContain('range-no-deep')
  })

  it('reports a heavily scheduled period', () => {
    const days = ['2026-03-10', '2026-03-11'].map((key) =>
      summarizeDay(key, [session(`a-${key}`, at(9), at(13))], [], [
        { id: `e-${key}`, title: 'Sync', start: at(9), end: at(11), source: 'google' },
      ])
    )
    expect(buildRangeInsights(days, 4).map((i) => i.id)).toContain('range-meetings')
  })
})
