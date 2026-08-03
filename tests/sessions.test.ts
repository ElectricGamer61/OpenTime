import { describe, expect, it } from 'vitest'

import { dayKey } from '../src/core/day'
import {
  bucketByDay,
  makeIdleBlock,
  MIN_SESSION_SECONDS,
  SessionBuilder,
  splitAtDayBoundaries,
} from '../src/core/sessions'
import type { CategoryRule, Project } from '../src/core/types'

const projects: Project[] = [
  { id: 'p1', name: 'Engineering', color: '#fff', keywords: ['code', 'terminal'] },
  { id: 'p2', name: 'Comms', color: '#fff', keywords: ['slack', 'mail'] },
]
const rules: CategoryRule[] = []

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

function builder(overrides: Partial<ConstructorParameters<typeof SessionBuilder>[0]> = {}) {
  let n = 0
  return new SessionBuilder({
    sessionGapSeconds: 60,
    dayStartHour: 4,
    ignoredApps: [],
    rules,
    projects,
    makeId: () => `id${n++}`,
    ...overrides,
  })
}

describe('SessionBuilder', () => {
  it('holds one session open across repeated samples of the same activity', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    expect(b.sample({ app: 'Code', title: 'a.ts' }, t0)).toEqual([])
    expect(b.sample({ app: 'Code', title: 'b.ts' }, t0 + 5000)).toEqual([])
    expect(b.sample({ app: 'Code', title: 'c.ts' }, t0 + 10_000)).toEqual([])
    expect(b.current?.category).toBe('Engineering')
    // Nothing has been emitted yet — this is the batching that keeps writes rare.
    const closed = b.flush(t0 + 10_000)
    expect(closed).toHaveLength(1)
    expect(closed[0].durationSeconds).toBe(10)
  })

  it('closes the open session when the category changes', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    b.sample({ app: 'Code', title: 'a.ts' }, t0 + 60_000)
    const closed = b.sample({ app: 'Slack', title: '#general' }, t0 + 65_000)
    expect(closed).toHaveLength(1)
    expect(closed[0].category).toBe('Engineering')
    // The closed session ends at its last sample, not at the new one's start.
    expect(closed[0].endTime).toBe(t0 + 60_000)
    expect(b.current?.category).toBe('Comms')
  })

  it('does not split when the app changes but the category does not', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    const closed = b.sample({ app: 'Windows Terminal', title: 'npm test' }, t0 + 5000)
    expect(closed).toEqual([])
    expect(b.current?.app).toBe('Windows Terminal')
  })

  it('splits when the sampling gap exceeds the configured threshold', () => {
    const b = builder({ sessionGapSeconds: 60 })
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    b.sample({ app: 'Code', title: 'a.ts' }, t0 + 30_000)
    const closed = b.sample({ app: 'Code', title: 'a.ts' }, t0 + 120_000)
    expect(closed).toHaveLength(1)
    // The closed stretch ends at its last sample — the 90s gap is not tracked time.
    expect(closed[0].durationSeconds).toBe(30)
    expect(b.current?.startTime).toBe(t0 + 120_000)
  })

  it('discards sub-threshold noise', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    expect(b.flush(t0 + (MIN_SESSION_SECONDS - 1) * 1000)).toEqual([])
  })

  it('records nothing for an ignored app and closes any open session', () => {
    const b = builder({ ignoredApps: ['1password'] })
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    const closed = b.sample({ app: '1Password', title: 'Vault' }, t0 + 30_000)
    expect(closed).toHaveLength(1)
    expect(closed[0].category).toBe('Engineering')
    expect(b.current).toBeNull()
    // Feeding the ignored app again records nothing at all.
    expect(b.sample({ app: '1Password', title: 'Vault' }, t0 + 35_000)).toEqual([])
    expect(b.flush(t0 + 40_000)).toEqual([])
  })

  it('splits a session that crosses the day boundary into two dated records', () => {
    const b = builder({ dayStartHour: 4 })
    const start = at(2026, 3, 14, 2) // 2am — belongs to the 13th
    const end = at(2026, 3, 14, 6) // 6am — belongs to the 14th
    b.sample({ app: 'Code', title: 'late night' }, start)
    const closed = b.flush(end)
    expect(closed).toHaveLength(2)
    expect(dayKey(closed[0].startTime, 4)).toBe('2026-03-13')
    expect(dayKey(closed[1].startTime, 4)).toBe('2026-03-14')
    expect(closed[0].endTime).toBe(closed[1].startTime)
    expect(closed[0].durationSeconds + closed[1].durationSeconds).toBe(4 * 3600)
  })

  it('stamps productivity from the resolved category', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    expect(b.flush(t0 + 60_000)[0].productivity).toBe('productive')
  })

  it('flushing twice does not double-emit', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a.ts' }, t0)
    expect(b.flush(t0 + 60_000)).toHaveLength(1)
    expect(b.flush(t0 + 60_000)).toEqual([])
  })

  it('picks up new rules mid-session without dropping the open stretch', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Figma', title: 'Dashboard' }, t0)
    b.sample({ app: 'Figma', title: 'Dashboard' }, t0 + 30_000)
    expect(b.current?.category).toBe('Uncategorized')
    b.updateOptions({
      rules: [{ id: 'r', kind: 'app', match: 'figma', category: 'Design' }],
    })
    const closed = b.sample({ app: 'Figma', title: 'Dashboard' }, t0 + 35_000)
    // The category changed under it, so the old stretch closes cleanly.
    expect(closed).toHaveLength(1)
    expect(b.current?.category).toBe('Design')
  })
})

describe('splitAtDayBoundaries', () => {
  it('returns a single segment when no boundary is crossed', () => {
    const start = at(2026, 3, 14, 9)
    expect(splitAtDayBoundaries(start, start + 3600_000, 4)).toEqual([
      { start, end: start + 3600_000 },
    ])
  })

  it('splits a multi-day span at every boundary', () => {
    const start = at(2026, 3, 13, 20)
    const end = at(2026, 3, 15, 10)
    const segments = splitAtDayBoundaries(start, end, 4)
    expect(segments).toHaveLength(3)
    expect(segments[0].end).toBe(at(2026, 3, 14, 4))
    expect(segments[1].end).toBe(at(2026, 3, 15, 4))
    expect(segments[2].end).toBe(end)
  })

  it('produces no segments for a zero-length span', () => {
    const start = at(2026, 3, 14, 9)
    expect(splitAtDayBoundaries(start, start, 4)).toEqual([])
  })
})

describe('bucketByDay', () => {
  it('groups sessions by tracking day and sorts each day', () => {
    const b = builder()
    const t0 = at(2026, 3, 14, 9)
    b.sample({ app: 'Code', title: 'a' }, t0)
    const first = b.flush(t0 + 60_000)
    b.sample({ app: 'Slack', title: 'b' }, t0 + 120_000)
    const second = b.flush(t0 + 180_000)
    const buckets = bucketByDay([...second, ...first], 4)
    expect(Object.keys(buckets)).toEqual(['2026-03-14'])
    expect(buckets['2026-03-14'].map((s) => s.category)).toEqual(['Engineering', 'Comms'])
  })
})

describe('makeIdleBlock', () => {
  it('returns a block for a real absence', () => {
    const start = at(2026, 3, 14, 12)
    expect(makeIdleBlock(start, start + 600_000)).toMatchObject({ durationSeconds: 600 })
  })

  it('discards a gap too short to be worth showing', () => {
    const start = at(2026, 3, 14, 12)
    expect(makeIdleBlock(start, start + 10_000)).toBeNull()
  })
})
