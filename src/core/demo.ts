/**
 * Deterministic demo data.
 *
 * Used in two places:
 *  - to backfill previous days, on request, when real OS capture is
 *    unavailable (headless CI, WSL, a locked-down Wayland session), so a
 *    screenshot or a reviewer's first look is never a blank slate;
 *  - as the sample source behind the demo capture adapter.
 *
 * It never runs unasked: `shouldSeedDemo` is off by default, so a fresh
 * install with no capture starts on an honest empty dashboard rather than
 * fabricated history the user never agreed to.
 *
 * The generator is seeded, so the same day key always produces the same day —
 * screenshots and tests stay stable.
 */

import { dayStartTs } from './day'
import { SessionBuilder } from './sessions'
import type { CalendarEvent, CategoryRule, IdleBlock, Project, Session, WindowSample } from './types'

/**
 * Whether first-run seeding should fabricate backfill history right now.
 *
 * All three have to hold: capture is genuinely unavailable (seeding when
 * capture works would mix fiction into real history), the user opted in
 * (`seedDemoWhenUnavailable`, off by default), and the store is still empty
 * (seeding into a store that already has real days would misdate them as
 * belonging to the same history as fabricated ones).
 */
export function shouldSeedDemo(opts: {
  captureIsDemo: boolean
  seedDemoWhenUnavailable: boolean
  storeIsEmpty: boolean
}): boolean {
  return opts.captureIsDemo && opts.seedDemoWhenUnavailable && opts.storeIsEmpty
}

/** Small deterministic PRNG (mulberry32) - no dependency, stable across runs. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFromKey(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

interface DemoActivity {
  app: string
  titles: string[]
  url?: string
  /** Relative likelihood of being picked. */
  weight: number
  /** Typical stretch length in minutes. */
  minutes: [number, number]
}

const WORK_ACTIVITIES: DemoActivity[] = [
  { app: 'Code', titles: ['opentime - tracker.ts', 'opentime - aggregate.ts', 'opentime - App.tsx'], weight: 8, minutes: [12, 55] },
  { app: 'Windows Terminal', titles: ['pwsh - npm test', 'pwsh - git status'], weight: 4, minutes: [3, 14] },
  { app: 'chrome', titles: ['Pull requests · opentime'], url: 'github.com', weight: 5, minutes: [4, 18] },
  { app: 'chrome', titles: ['MDN Web Docs'], url: 'developer.mozilla.org', weight: 3, minutes: [3, 12] },
  { app: 'Figma', titles: ['OpenTime - Dashboard v0'], weight: 3, minutes: [10, 40] },
  { app: 'Notion', titles: ['OpenTime - roadmap', 'Weekly review'], weight: 3, minutes: [6, 22] },
  { app: 'Slack', titles: ['#opentime', 'DM - design review'], weight: 4, minutes: [3, 12] },
  { app: 'Zoom', titles: ['Weekly sync'], weight: 2, minutes: [25, 50] },
  { app: 'chrome', titles: ['Watch Later - YouTube'], url: 'youtube.com', weight: 4, minutes: [4, 22] },
  { app: 'chrome', titles: ['r/programming'], url: 'reddit.com', weight: 3, minutes: [3, 18] },
]

function pick(rng: () => number, activities: DemoActivity[]): DemoActivity {
  const total = activities.reduce((s, a) => s + a.weight, 0)
  let r = rng() * total
  for (const a of activities) {
    r -= a.weight
    if (r <= 0) return a
  }
  return activities[activities.length - 1]
}

export interface DemoDay {
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
}

/**
 * Generate one realistic tracked day. Samples are pushed through the real
 * `SessionBuilder`, so demo data is shaped by exactly the same categorisation,
 * gap-splitting and day-boundary logic as live capture.
 */
export function generateDemoDay(
  key: string,
  opts: { dayStartHour: number; sessionGapSeconds: number; projects: Project[]; rules: CategoryRule[] }
): DemoDay {
  const rng = seededRandom(seedFromKey(key))
  const dayStart = dayStartTs(key, opts.dayStartHour)
  const weekday = new Date(dayStart).getDay()
  const isWeekend = weekday === 0 || weekday === 6

  const builder = new SessionBuilder({
    sessionGapSeconds: opts.sessionGapSeconds,
    dayStartHour: opts.dayStartHour,
    ignoredApps: [],
    rules: opts.rules,
    projects: opts.projects,
    // Every synthetic row says so, so demo history is never mistaken for
    // observed history - in the UI, in an export, or in a support question.
    source: 'demo',
    makeId: (() => {
      let n = 0
      return () => `demo_${key}_${n++}`
    })(),
  })

  const sessions: Session[] = []
  const idle: IdleBlock[] = []

  // Start between 8:00 and 10:00 local, later on weekends.
  const startHour = (isWeekend ? 10 : 8) + Math.floor(rng() * 2)
  let t = dayStart + (startHour - opts.dayStartHour) * 3600_000 + Math.floor(rng() * 30) * 60_000
  const endHour = isWeekend ? 15 + Math.floor(rng() * 2) : 17 + Math.floor(rng() * 3)
  const dayEnd = dayStart + (endHour - opts.dayStartHour) * 3600_000

  while (t < dayEnd) {
    const activity = pick(rng, WORK_ACTIVITIES)
    const [lo, hi] = activity.minutes
    const lengthMs = (lo + rng() * (hi - lo)) * 60_000
    const sample: WindowSample = {
      app: activity.app,
      title: activity.titles[Math.floor(rng() * activity.titles.length)],
      url: activity.url,
    }
    // Open the stretch, then close it explicitly at its end. Feeding a single
    // far-apart second sample instead would look like a sampling gap and the
    // builder would (correctly) split it into two zero-length stretches.
    const end = Math.min(t + lengthMs, dayEnd)
    sessions.push(...builder.sample(sample, t))
    sessions.push(...builder.flush(end))
    t = end

    // Occasional break away from the machine.
    if (rng() < 0.22 && t < dayEnd) {
      const awayMs = (5 + rng() * 45) * 60_000
      sessions.push(...builder.flush(t))
      const awayEnd = Math.min(t + awayMs, dayEnd)
      idle.push({
        startTime: t,
        endTime: awayEnd,
        durationSeconds: Math.round((awayEnd - t) / 1000),
      })
      t = awayEnd
    }
  }
  sessions.push(...builder.flush(Math.min(t, dayEnd)))

  return { sessions, idle, events: generateDemoEvents(key, dayStart, opts.dayStartHour, rng, isWeekend) }
}

function generateDemoEvents(
  key: string,
  dayStart: number,
  dayStartHour: number,
  rng: () => number,
  isWeekend: boolean
): CalendarEvent[] {
  if (isWeekend) return []
  const at = (hour: number, minute = 0) =>
    dayStart + (hour - dayStartHour) * 3600_000 + minute * 60_000
  const pool: Array<Omit<CalendarEvent, 'id' | 'source'>> = [
    { title: 'Standup', start: at(9, 30), end: at(9, 45) },
    { title: 'Design review', start: at(11, 0), end: at(12, 0) },
    { title: 'Focus block (held)', start: at(13, 30), end: at(15, 0) },
    { title: '1:1', start: at(16, 0), end: at(16, 30) },
  ]
  return pool
    .filter(() => rng() < 0.7)
    .map((e, i) => ({ ...e, id: `demoevt_${key}_${i}`, source: 'demo' as const, calendarName: 'Work' }))
}

/**
 * A live-ish sample stream for the demo capture adapter: picks a plausible
 * activity and sticks with it for a while, so the dashboard's "current
 * activity" behaves like the real thing rather than flickering every tick.
 */
export class DemoSampleStream {
  private rng = seededRandom(seedFromKey('opentime-live'))
  private current: DemoActivity = WORK_ACTIVITIES[0]
  private holdUntil = 0

  next(now: number): WindowSample {
    if (now >= this.holdUntil) {
      this.current = pick(this.rng, WORK_ACTIVITIES)
      const [lo, hi] = this.current.minutes
      this.holdUntil = now + (lo + this.rng() * (hi - lo)) * 60_000
    }
    const a = this.current
    return {
      app: a.app,
      title: a.titles[Math.floor(this.rng() * a.titles.length)],
      url: a.url,
    }
  }
}
