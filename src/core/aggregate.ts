/**
 * Summary aggregation.
 *
 * Everything the dashboard shows is derived here, in one pass per input list,
 * so the renderer never loops over raw sessions inside a component body. The
 * renderer memoises these calls on `[sessions, idle, events]` identity — see
 * the performance note in the README.
 */

import { dayKey, dayStartTs } from './day'
import type { CalendarEvent, IdleBlock, Productivity, Session } from './types'

export interface Bucket {
  key: string
  label: string
  seconds: number
  /** Share of the total, 0–1. */
  share: number
  productivity: Productivity
  color?: string
}

export interface DaySummary {
  dayKey: string
  totalSeconds: number
  productiveSeconds: number
  neutralSeconds: number
  distractingSeconds: number
  idleSeconds: number
  meetingSeconds: number
  /** Longest unbroken productive stretch, in seconds. */
  longestFocusSeconds: number
  /** 0–100. Productive share, penalised by fragmentation. */
  focusScore: number
  /** Number of category switches — the fragmentation signal. */
  switches: number
  byCategory: Bucket[]
  byApp: Bucket[]
  firstActivityAt: number | null
  lastActivityAt: number | null
}

const EMPTY_SUMMARY = (key: string): DaySummary => ({
  dayKey: key,
  totalSeconds: 0,
  productiveSeconds: 0,
  neutralSeconds: 0,
  distractingSeconds: 0,
  idleSeconds: 0,
  meetingSeconds: 0,
  longestFocusSeconds: 0,
  focusScore: 0,
  switches: 0,
  byCategory: [],
  byApp: [],
  firstActivityAt: null,
  lastActivityAt: null,
})

function toBuckets(
  totals: Map<string, { seconds: number; productivity: Productivity }>,
  total: number
): Bucket[] {
  const out: Bucket[] = []
  for (const [key, v] of totals) {
    out.push({
      key,
      label: key,
      seconds: v.seconds,
      share: total > 0 ? v.seconds / total : 0,
      productivity: v.productivity,
    })
  }
  return out.sort((a, b) => b.seconds - a.seconds)
}

/**
 * Longest run of consecutive productive sessions with no more than
 * `maxGapSeconds` between them. This is what "deep work block" means here: an
 * unbroken productive stretch, not merely the longest single session.
 */
export function longestFocusRun(sessions: Session[], maxGapSeconds = 120): number {
  let best = 0
  let runStart: number | null = null
  let runEnd = 0
  for (const s of sessions) {
    if (s.productivity !== 'productive') {
      if (runStart !== null) best = Math.max(best, (runEnd - runStart) / 1000)
      runStart = null
      continue
    }
    if (runStart === null || (s.startTime - runEnd) / 1000 > maxGapSeconds) {
      if (runStart !== null) best = Math.max(best, (runEnd - runStart) / 1000)
      runStart = s.startTime
    }
    runEnd = s.endTime
  }
  if (runStart !== null) best = Math.max(best, (runEnd - runStart) / 1000)
  return Math.round(best)
}

/**
 * Focus score, 0–100.
 *
 * Base is the productive share of tracked time. It is then scaled by a
 * fragmentation factor so that the same number of productive minutes scores
 * lower when it was chopped into many short pieces — switching cost is the
 * thing this product exists to make visible.
 */
export function focusScore(params: {
  productiveSeconds: number
  totalSeconds: number
  switches: number
  longestFocusSeconds: number
}): number {
  const { productiveSeconds, totalSeconds, switches, longestFocusSeconds } = params
  if (totalSeconds <= 0) return 0
  const base = productiveSeconds / totalSeconds
  const hours = Math.max(totalSeconds / 3600, 0.25)
  const switchesPerHour = switches / hours
  // 0 switches/hr → 1.0; 30 switches/hr → 0.5; asymptotically approaches 0.
  const fragmentation = 30 / (30 + switchesPerHour)
  // A long unbroken block earns part of the fragmentation penalty back — but
  // only back, never beyond it. The score is a share of tracked time, so it
  // must never exceed the share that was actually productive.
  const depthBonus = Math.min(longestFocusSeconds / (45 * 60), 1) * 0.15
  const quality = Math.min(1, fragmentation + depthBonus)
  return Math.round(base * quality * 100)
}

export function summarizeDay(
  key: string,
  sessions: Session[],
  idle: IdleBlock[] = [],
  events: CalendarEvent[] = []
): DaySummary {
  if (!sessions.length && !idle.length && !events.length) return EMPTY_SUMMARY(key)

  const byCategory = new Map<string, { seconds: number; productivity: Productivity }>()
  const byApp = new Map<string, { seconds: number; productivity: Productivity }>()
  let total = 0
  let productive = 0
  let neutral = 0
  let distracting = 0
  let switches = 0
  let prevCategory: string | null = null
  let first: number | null = null
  let last: number | null = null

  for (const s of sessions) {
    const d = s.durationSeconds
    total += d
    if (s.productivity === 'productive') productive += d
    else if (s.productivity === 'distracting') distracting += d
    else neutral += d

    const cat = byCategory.get(s.category)
    if (cat) cat.seconds += d
    else byCategory.set(s.category, { seconds: d, productivity: s.productivity })

    const app = byApp.get(s.app)
    if (app) app.seconds += d
    else byApp.set(s.app, { seconds: d, productivity: s.productivity })

    if (prevCategory !== null && prevCategory !== s.category) switches += 1
    prevCategory = s.category

    if (first === null || s.startTime < first) first = s.startTime
    if (last === null || s.endTime > last) last = s.endTime
  }

  const idleSeconds = idle.reduce((sum, b) => sum + b.durationSeconds, 0)
  const meetingSeconds = events
    .filter((e) => !e.allDay)
    .reduce((sum, e) => sum + Math.max(0, Math.round((e.end - e.start) / 1000)), 0)
  const longest = longestFocusRun(sessions)

  return {
    dayKey: key,
    totalSeconds: total,
    productiveSeconds: productive,
    neutralSeconds: neutral,
    distractingSeconds: distracting,
    idleSeconds,
    meetingSeconds,
    longestFocusSeconds: longest,
    switches,
    focusScore: focusScore({
      productiveSeconds: productive,
      totalSeconds: total,
      switches,
      longestFocusSeconds: longest,
    }),
    byCategory: toBuckets(byCategory, total),
    byApp: toBuckets(byApp, total),
    firstActivityAt: first,
    lastActivityAt: last,
  }
}

export interface WeekSummary {
  days: DaySummary[]
  totalSeconds: number
  productiveSeconds: number
  distractingSeconds: number
  averageFocusScore: number
  bestDay: DaySummary | null
  byCategory: Bucket[]
}

export function summarizeWeek(days: DaySummary[]): WeekSummary {
  const totals = new Map<string, { seconds: number; productivity: Productivity }>()
  let total = 0
  let productive = 0
  let distracting = 0
  let scoreSum = 0
  let scoredDays = 0
  let best: DaySummary | null = null

  for (const d of days) {
    total += d.totalSeconds
    productive += d.productiveSeconds
    distracting += d.distractingSeconds
    if (d.totalSeconds > 0) {
      scoreSum += d.focusScore
      scoredDays += 1
      if (!best || d.focusScore > best.focusScore) best = d
    }
    for (const b of d.byCategory) {
      const cur = totals.get(b.key)
      if (cur) cur.seconds += b.seconds
      else totals.set(b.key, { seconds: b.seconds, productivity: b.productivity })
    }
  }

  return {
    days,
    totalSeconds: total,
    productiveSeconds: productive,
    distractingSeconds: distracting,
    averageFocusScore: scoredDays ? Math.round(scoreSum / scoredDays) : 0,
    bestDay: best,
    byCategory: toBuckets(totals, total),
  }
}

/** One rendered block on the day timeline. */
export interface TimelineBlock {
  id: string
  kind: 'session' | 'idle'
  label: string
  sublabel: string
  start: number
  end: number
  durationSeconds: number
  productivity: Productivity | 'idle'
  /** Fractional offset from the start of the timeline window, 0–1. */
  offset: number
  /** Fractional height/width of the block, 0–1. */
  size: number
}

/**
 * Merge sessions and idle blocks into positioned timeline blocks.
 *
 * `windowStart`/`windowEnd` are epoch ms; positions are precomputed fractions so
 * the renderer only ever multiplies by a pixel height.
 */
export function buildTimeline(
  sessions: Session[],
  idle: IdleBlock[],
  windowStart: number,
  windowEnd: number
): TimelineBlock[] {
  const span = Math.max(1, windowEnd - windowStart)
  const blocks: TimelineBlock[] = []

  for (const s of sessions) {
    blocks.push({
      id: s.id,
      kind: 'session',
      label: s.category,
      sublabel: s.url || s.app,
      start: s.startTime,
      end: s.endTime,
      durationSeconds: s.durationSeconds,
      productivity: s.productivity,
      offset: (s.startTime - windowStart) / span,
      size: (s.endTime - s.startTime) / span,
    })
  }
  for (const b of idle) {
    blocks.push({
      id: `idle_${b.startTime}`,
      kind: 'idle',
      label: 'Away',
      sublabel: 'No input detected',
      start: b.startTime,
      end: b.endTime,
      durationSeconds: b.durationSeconds,
      productivity: 'idle',
      offset: (b.startTime - windowStart) / span,
      size: (b.endTime - b.startTime) / span,
    })
  }
  return blocks.sort((a, b) => a.start - b.start)
}

/** The [start, end) epoch-ms window a day's timeline should span. */
export function timelineWindow(
  key: string,
  dayStartHour: number,
  sessions: Session[]
): { start: number; end: number } {
  const dayStart = dayStartTs(key, dayStartHour)
  const dayEnd = dayStart + 24 * 3600 * 1000
  if (!sessions.length) {
    // Default to a readable working window rather than a mostly-empty 24 hours.
    return { start: dayStart + 4 * 3600 * 1000, end: dayStart + 18 * 3600 * 1000 }
  }
  const first = sessions[0].startTime
  const last = sessions[sessions.length - 1].endTime
  const pad = 30 * 60 * 1000
  return {
    start: Math.max(dayStart, first - pad),
    end: Math.min(dayEnd, Math.max(last + pad, first + 2 * 3600 * 1000)),
  }
}

/** Position a calendar event within a timeline window. */
export function positionEvent(
  event: CalendarEvent,
  windowStart: number,
  windowEnd: number
): { offset: number; size: number } {
  const span = Math.max(1, windowEnd - windowStart)
  const start = Math.max(event.start, windowStart)
  const end = Math.min(event.end, windowEnd)
  return { offset: (start - windowStart) / span, size: Math.max(0, end - start) / span }
}

/** Which day key a summary belongs to, for callers holding only sessions. */
export function summarizeSessionsByDay(
  sessions: Session[],
  dayStartHour: number
): Map<string, Session[]> {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    const key = dayKey(s.startTime, dayStartHour)
    const list = map.get(key)
    if (list) list.push(s)
    else map.set(key, [s])
  }
  return map
}
