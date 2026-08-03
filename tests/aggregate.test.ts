import { describe, expect, it } from 'vitest'

import {
  buildTimeline,
  focusScore,
  longestFocusRun,
  positionEvent,
  summarizeDay,
  summarizeWeek,
  timelineWindow,
} from '../src/core/aggregate'
import type { CalendarEvent, Productivity, Session } from '../src/core/types'

const at = (h: number, min = 0) => new Date(2026, 2, 14, h, min, 0, 0).getTime()

let counter = 0
function session(
  category: string,
  productivity: Productivity,
  startHour: number,
  minutes: number,
  app = category
): Session {
  const startTime = at(startHour, 0) + 0
  return {
    id: `s${counter++}`,
    category,
    app,
    title: '',
    url: '',
    productivity,
    startTime,
    endTime: startTime + minutes * 60_000,
    durationSeconds: minutes * 60,
  }
}

function span(
  category: string,
  productivity: Productivity,
  start: number,
  end: number,
  app = category
): Session {
  return {
    id: `s${counter++}`,
    category,
    app,
    title: '',
    url: '',
    productivity,
    startTime: start,
    endTime: end,
    durationSeconds: Math.round((end - start) / 1000),
  }
}

describe('summarizeDay', () => {
  it('returns a zeroed summary for an empty day', () => {
    const summary = summarizeDay('2026-03-14', [], [], [])
    expect(summary.totalSeconds).toBe(0)
    expect(summary.focusScore).toBe(0)
    expect(summary.byCategory).toEqual([])
    expect(summary.firstActivityAt).toBeNull()
  })

  it('totals productive, neutral and distracting time separately', () => {
    const summary = summarizeDay('2026-03-14', [
      session('Engineering', 'productive', 9, 60),
      session('Comms', 'neutral', 10, 30),
      session('Breaks', 'distracting', 11, 15),
    ])
    expect(summary.totalSeconds).toBe(105 * 60)
    expect(summary.productiveSeconds).toBe(60 * 60)
    expect(summary.neutralSeconds).toBe(30 * 60)
    expect(summary.distractingSeconds).toBe(15 * 60)
  })

  it('groups by category and by app, sorted by time descending', () => {
    const summary = summarizeDay('2026-03-14', [
      session('Engineering', 'productive', 9, 30, 'Code'),
      session('Engineering', 'productive', 10, 45, 'Terminal'),
      session('Comms', 'neutral', 11, 20, 'Slack'),
    ])
    expect(summary.byCategory.map((b) => b.key)).toEqual(['Engineering', 'Comms'])
    expect(summary.byCategory[0].seconds).toBe(75 * 60)
    expect(summary.byCategory[0].share).toBeCloseTo(75 / 95, 5)
    expect(summary.byApp.map((b) => b.key)).toEqual(['Terminal', 'Code', 'Slack'])
  })

  it('counts a context switch only when the category actually changes', () => {
    const summary = summarizeDay('2026-03-14', [
      session('Engineering', 'productive', 9, 30, 'Code'),
      session('Engineering', 'productive', 10, 30, 'Terminal'),
      session('Comms', 'neutral', 11, 10, 'Slack'),
      session('Engineering', 'productive', 12, 30, 'Code'),
    ])
    expect(summary.switches).toBe(2)
  })

  it('sums idle blocks and non-all-day calendar events', () => {
    const events: CalendarEvent[] = [
      { id: 'e1', title: 'Standup', start: at(9, 30), end: at(9, 45), source: 'manual' },
      { id: 'e2', title: 'Holiday', start: at(0), end: at(23), allDay: true, source: 'manual' },
    ]
    const summary = summarizeDay(
      '2026-03-14',
      [session('Engineering', 'productive', 9, 60)],
      [{ startTime: at(12), endTime: at(13), durationSeconds: 3600 }],
      events
    )
    expect(summary.idleSeconds).toBe(3600)
    expect(summary.meetingSeconds).toBe(15 * 60)
  })

  it('tracks the first and last activity of the day', () => {
    const summary = summarizeDay('2026-03-14', [
      session('Engineering', 'productive', 9, 60),
      session('Comms', 'neutral', 16, 30),
    ])
    expect(summary.firstActivityAt).toBe(at(9))
    expect(summary.lastActivityAt).toBe(at(16) + 30 * 60_000)
  })
})

describe('longestFocusRun', () => {
  it('joins adjacent productive sessions into one run', () => {
    const run = longestFocusRun([
      span('Eng', 'productive', at(9), at(9, 50)),
      span('Eng', 'productive', at(9, 51), at(10, 30)),
    ])
    expect(run).toBe(90 * 60)
  })

  it('breaks the run when a non-productive session interrupts it', () => {
    const run = longestFocusRun([
      span('Eng', 'productive', at(9), at(9, 30)),
      span('Breaks', 'distracting', at(9, 30), at(9, 40)),
      span('Eng', 'productive', at(9, 40), at(10, 0)),
    ])
    expect(run).toBe(30 * 60)
  })

  it('breaks the run when the gap between productive sessions is too long', () => {
    const run = longestFocusRun(
      [
        span('Eng', 'productive', at(9), at(9, 30)),
        span('Eng', 'productive', at(11), at(11, 20)),
      ],
      120
    )
    expect(run).toBe(30 * 60)
  })

  it('is zero when nothing productive happened', () => {
    expect(longestFocusRun([span('Breaks', 'distracting', at(9), at(10))])).toBe(0)
  })
})

describe('focusScore', () => {
  it('is zero with no tracked time', () => {
    expect(focusScore({ productiveSeconds: 0, totalSeconds: 0, switches: 0, longestFocusSeconds: 0 })).toBe(0)
  })

  it('penalises the same productive time when it is more fragmented', () => {
    const calm = focusScore({
      productiveSeconds: 4 * 3600,
      totalSeconds: 5 * 3600,
      switches: 5,
      longestFocusSeconds: 2 * 3600,
    })
    const scattered = focusScore({
      productiveSeconds: 4 * 3600,
      totalSeconds: 5 * 3600,
      switches: 120,
      longestFocusSeconds: 10 * 60,
    })
    expect(calm).toBeGreaterThan(scattered)
  })

  it('rewards more productive time at equal fragmentation', () => {
    const base = { totalSeconds: 5 * 3600, switches: 10, longestFocusSeconds: 3600 }
    expect(focusScore({ ...base, productiveSeconds: 4 * 3600 })).toBeGreaterThan(
      focusScore({ ...base, productiveSeconds: 1 * 3600 })
    )
  })

  it('never exceeds the productive share of tracked time', () => {
    // A perfect, unbroken day still cannot score above its productive share.
    const score = focusScore({
      productiveSeconds: 3 * 3600,
      totalSeconds: 6 * 3600,
      switches: 0,
      longestFocusSeconds: 3 * 3600,
    })
    expect(score).toBeLessThanOrEqual(50)
  })

  it('stays within 0–100', () => {
    const score = focusScore({
      productiveSeconds: 8 * 3600,
      totalSeconds: 8 * 3600,
      switches: 0,
      longestFocusSeconds: 8 * 3600,
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})

describe('summarizeWeek', () => {
  it('rolls up totals and averages only over days with tracked time', () => {
    const days = [
      summarizeDay('2026-03-13', [session('Engineering', 'productive', 9, 120)]),
      summarizeDay('2026-03-14', [session('Comms', 'neutral', 9, 60)]),
      summarizeDay('2026-03-15', []),
    ]
    const week = summarizeWeek(days)
    expect(week.totalSeconds).toBe(180 * 60)
    expect(week.productiveSeconds).toBe(120 * 60)
    // The empty day must not drag the average down.
    expect(week.averageFocusScore).toBe(
      Math.round((days[0].focusScore + days[1].focusScore) / 2)
    )
    expect(week.bestDay?.dayKey).toBe('2026-03-13')
    expect(week.byCategory.map((b) => b.key)).toEqual(['Engineering', 'Comms'])
  })

  it('handles a week with no data at all', () => {
    const week = summarizeWeek([summarizeDay('2026-03-15', [])])
    expect(week.totalSeconds).toBe(0)
    expect(week.averageFocusScore).toBe(0)
    expect(week.bestDay).toBeNull()
  })
})

describe('buildTimeline', () => {
  it('positions blocks as fractions of the window and sorts by start', () => {
    const windowStart = at(9)
    const windowEnd = at(11)
    const blocks = buildTimeline(
      [span('Eng', 'productive', at(10), at(10, 30))],
      [{ startTime: at(9), endTime: at(9, 30), durationSeconds: 1800 }],
      windowStart,
      windowEnd
    )
    expect(blocks.map((b) => b.kind)).toEqual(['idle', 'session'])
    expect(blocks[0].offset).toBe(0)
    expect(blocks[0].size).toBeCloseTo(0.25, 5)
    expect(blocks[1].offset).toBeCloseTo(0.5, 5)
  })
})

describe('timelineWindow', () => {
  it('falls back to a readable working window when nothing was tracked', () => {
    const win = timelineWindow('2026-03-14', 4, [])
    expect(win.end).toBeGreaterThan(win.start)
    expect((win.end - win.start) / 3600_000).toBe(14)
  })

  it('pads around the tracked range', () => {
    const sessions = [span('Eng', 'productive', at(9), at(17))]
    const win = timelineWindow('2026-03-14', 4, sessions)
    expect(win.start).toBe(at(8, 30))
    expect(win.end).toBe(at(17, 30))
  })
})

describe('positionEvent', () => {
  it('clamps an event that overhangs the window', () => {
    const { offset, size } = positionEvent(
      { id: 'e', title: 'Long', start: at(8), end: at(12), source: 'manual' },
      at(9),
      at(11)
    )
    expect(offset).toBe(0)
    expect(size).toBe(1)
  })
})
