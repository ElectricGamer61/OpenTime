import { describe, expect, it } from 'vitest'

import {
  assignLanes,
  buildEntries,
  describeEntry,
  groupKeyFor,
} from '../src/renderer/lib/entries'
import type { CalendarEvent, IdleBlock, Productivity, Session } from '../src/core/types'

const T0 = new Date('2026-03-09T09:00:00').getTime()

let counter = 0
function session(
  offsetMinutes: number,
  minutes: number,
  patch: Partial<Session> = {}
): Session {
  const startTime = T0 + offsetMinutes * 60_000
  const endTime = startTime + minutes * 60_000
  counter += 1
  return {
    id: `s${counter}`,
    category: 'Deep Work',
    app: 'Code',
    title: 'opentime — App.tsx',
    url: '',
    productivity: 'productive' as Productivity,
    startTime,
    endTime,
    durationSeconds: minutes * 60,
    ...patch,
  }
}

const OPTS = { mode: 'category' as const }

describe('groupKeyFor', () => {
  it('groups by project or by app', () => {
    const s = session(0, 10, { projectId: 'p1', app: 'Figma', category: 'Design' })
    expect(groupKeyFor(s, 'category')).toBe('Design')
    expect(groupKeyFor(s, 'app')).toBe('Figma')
  })
})

describe('buildEntries', () => {
  it('folds adjacent sessions of one group into a single entry', () => {
    const entries = buildEntries([session(0, 20), session(21, 25)], OPTS)
    expect(entries).toHaveLength(1)
    expect(entries[0].seconds).toBe(45 * 60)
    expect(entries[0].sessions).toHaveLength(2)
  })

  it('sums the folded durations rather than measuring end minus start', () => {
    // A minute of unobserved gap sits between these two; crediting it would be
    // the exact bug the tracking engine goes out of its way to avoid.
    const entries = buildEntries([session(0, 20), session(21, 20)], OPTS)
    expect(entries[0].seconds).toBe(40 * 60)
    expect(entries[0].end - entries[0].start).toBe(41 * 60_000)
  })

  it('does not fold across a gap wider than the merge window', () => {
    const entries = buildEntries([session(0, 20), session(40, 20)], OPTS)
    expect(entries).toHaveLength(2)
  })

  it('does not fold two stretches with a different category between them', () => {
    const entries = buildEntries(
      [session(0, 10), session(10, 5, { category: 'Email' }), session(15, 10)],
      OPTS
    )
    expect(entries.map((e) => e.label)).toEqual(['Deep Work', 'Email', 'Deep Work'])
  })

  it('reports the dominant productivity, not the first one seen', () => {
    const entries = buildEntries(
      [
        session(0, 5, { category: 'Mixed', productivity: 'neutral' }),
        session(5, 40, { category: 'Mixed', productivity: 'productive' }),
      ],
      OPTS
    )
    expect(entries[0].productivity).toBe('productive')
  })

  it('breaks an entry down by app, preferring the host when there is one', () => {
    const entries = buildEntries(
      [
        session(0, 30, { category: 'Research', app: 'Code' }),
        session(30, 10, { category: 'Research', app: 'chrome', url: 'github.com' }),
      ],
      OPTS
    )
    expect(entries[0].apps).toEqual([
      { name: 'Code', seconds: 1800, share: 0.75 },
      { name: 'github.com', seconds: 600, share: 0.25 },
    ])
  })

  it('carries away blocks and timed calendar events as entries of their own', () => {
    const idle: IdleBlock[] = [
      { startTime: T0 + 60 * 60_000, endTime: T0 + 90 * 60_000, durationSeconds: 1800 },
    ]
    const events: CalendarEvent[] = [
      {
        id: 'e1',
        title: 'Standup',
        start: T0,
        end: T0 + 15 * 60_000,
        source: 'manual',
      },
      { id: 'e2', title: 'Holiday', start: T0, end: T0, allDay: true, source: 'manual' },
    ]
    const entries = buildEntries([session(0, 10)], { ...OPTS, idle, events })
    const kinds = entries.map((e) => e.kind).sort()
    expect(kinds).toEqual(['away', 'event', 'session'])
    // An all-day event has no position on an hour grid, so it is not drawn.
    expect(entries.some((e) => e.label === 'Holiday')).toBe(false)
  })

  it('is empty for an empty day rather than throwing', () => {
    expect(buildEntries([], OPTS)).toEqual([])
  })

  it('flags an entry as demo only when every session in it is', () => {
    const mixed = buildEntries(
      [session(0, 10, { source: 'demo' }), session(10, 10, { source: 'capture' })],
      OPTS
    )
    expect(mixed[0].demo).toBe(false)
    const all = buildEntries([session(0, 10, { source: 'demo' })], OPTS)
    expect(all[0].demo).toBe(true)
  })
})

describe('assignLanes', () => {
  const day = () =>
    buildEntries(
      [
        session(0, 120, { category: 'Deep Work' }),
        session(130, 60, { category: 'Design' }),
        session(200, 30, { category: 'Email' }),
        session(240, 20, { category: 'Research' }),
        session(270, 10, { category: 'Breaks' }),
        session(290, 5, { category: 'Admin' }),
      ],
      OPTS
    )

  it('gives the biggest groups a column each, ordered by time spent', () => {
    const { entries, laneCount } = assignLanes(day(), 5)
    expect(laneCount).toBe(5)
    const lane = (label: string) => entries.find((e) => e.label === label)?.lane
    expect(lane('Deep Work')).toBe(0)
    expect(lane('Design')).toBe(1)
    expect(lane('Email')).toBe(2)
  })

  it('sits the overflow groups together in the last column', () => {
    const { entries } = assignLanes(day(), 5)
    expect(entries.find((e) => e.label === 'Breaks')?.lane).toBe(4)
    expect(entries.find((e) => e.label === 'Admin')?.lane).toBe(4)
  })

  it('keeps every entry of one group in the same column', () => {
    const entries = buildEntries(
      [session(0, 30), session(60, 30), session(120, 30, { category: 'Email' })],
      OPTS
    )
    const laid = assignLanes(entries, 5).entries.filter((e) => e.label === 'Deep Work')
    expect(new Set(laid.map((e) => e.lane)).size).toBe(1)
  })

  it('spends one column on the calendar rather than adding a sixth', () => {
    const events: CalendarEvent[] = [
      { id: 'e1', title: 'Standup', start: T0, end: T0 + 15 * 60_000, source: 'manual' },
    ]
    const withEvents = buildEntries(
      [
        session(0, 120, { category: 'Deep Work' }),
        session(130, 60, { category: 'Design' }),
        session(200, 30, { category: 'Email' }),
        session(240, 20, { category: 'Research' }),
        session(270, 10, { category: 'Breaks' }),
      ],
      { ...OPTS, events }
    )
    const { entries, laneCount } = assignLanes(withEvents, 5)
    expect(laneCount).toBe(5)
    expect(entries.find((e) => e.kind === 'event')?.lane).toBe(4)
    // Five categories now share four columns, so the smallest doubles up.
    expect(entries.find((e) => e.label === 'Breaks')?.lane).toBe(3)
  })

  // Empty columns beside a single entry read as missing data rather than as a
  // quiet day.
  it('narrows to the number of groups the day actually has', () => {
    expect(assignLanes(buildEntries([session(0, 60)], OPTS), 5).laneCount).toBe(1)
  })

  it('always leaves at least one column to draw into', () => {
    expect(assignLanes([], 5).laneCount).toBe(1)
    expect(assignLanes(day(), 0).laneCount).toBe(1)
  })
})

describe('describeEntry', () => {
  it('describes a folded entry from counts it can derive', () => {
    const entry = buildEntries(
      [
        session(0, 30, { title: 'opentime — tracker.ts' }),
        session(31, 10, { app: 'chrome', url: 'github.com', title: 'Pull requests' }),
      ],
      OPTS
    )[0]
    const text = describeEntry(entry)
    expect(text).toContain('2 stretches')
    expect(text).toContain('longest 30m')
    expect(text).toContain('across 2 apps')
    expect(text).toContain('opentime — tracker.ts')
  })

  it('says so plainly for a single stretch', () => {
    expect(describeEntry(buildEntries([session(0, 30)], OPTS)[0])).toContain(
      'One unbroken stretch'
    )
  })

  it('has something to say about away and calendar rows too', () => {
    const idle: IdleBlock[] = [
      { startTime: T0, endTime: T0 + 600_000, durationSeconds: 600 },
    ]
    const away = buildEntries([], { ...OPTS, idle })[0]
    expect(describeEntry(away)).toMatch(/No input/)
  })
})
