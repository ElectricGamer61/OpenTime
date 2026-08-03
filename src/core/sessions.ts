/**
 * Session assembly — the pure heart of the capture engine.
 *
 * A `SessionBuilder` turns a stream of window samples into a stream of closed
 * `Session` records. It holds at most one open session in memory and only emits
 * when the category changes, a sampling gap opens, or the caller flushes. That
 * batching is what keeps disk writes to a handful per hour instead of one per
 * poll tick (the same design the older Norte tracker used, and the reason its
 * capture loop was cheap even though the surrounding app was not).
 *
 * No Electron, no I/O, no timers — the caller owns the clock. Everything here
 * is deterministic and directly unit-testable.
 */

import { dayKey, nextDayBoundary, DEFAULT_DAY_START_HOUR } from './day'
import { classifyProductivity, isIgnored, resolveCategory } from './categorize'
import type { CategoryRule, IdleBlock, Project, Session, WindowSample } from './types'

/** Sessions shorter than this are sampling noise and are discarded. */
export const MIN_SESSION_SECONDS = 3

export interface SessionBuilderOptions {
  sessionGapSeconds: number
  dayStartHour: number
  ignoredApps: string[]
  rules: CategoryRule[]
  projects: Project[]
  /** Injected so tests get stable ids; defaults to a time+counter id. */
  makeId?: () => string
}

interface OpenSession {
  category: string
  projectId?: string
  app: string
  title: string
  url: string
  startTime: number
  lastSampleTime: number
}

let idCounter = 0
function defaultMakeId(): string {
  idCounter += 1
  return `s_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

export class SessionBuilder {
  private open: OpenSession | null = null
  private opts: SessionBuilderOptions

  constructor(opts: SessionBuilderOptions) {
    this.opts = opts
  }

  /** Swap rules/projects/settings without losing the open session. */
  updateOptions(patch: Partial<SessionBuilderOptions>): void {
    this.opts = { ...this.opts, ...patch }
  }

  /** The session currently accumulating, or null. */
  get current(): Readonly<OpenSession> | null {
    return this.open
  }

  /**
   * Feed one window sample. Returns any sessions closed as a result — usually
   * none, one when the activity changed.
   */
  sample(sample: WindowSample, now: number): Session[] {
    if (!sample || !sample.app) return this.flush(now)
    if (isIgnored(sample.app, this.opts.ignoredApps)) return this.flush(now)

    const resolution = resolveCategory(sample, this.opts.rules, this.opts.projects)
    const url = sample.url || ''

    if (!this.open) {
      this.open = {
        category: resolution.category,
        projectId: resolution.projectId,
        app: sample.app,
        title: sample.title || '',
        url,
        startTime: now,
        lastSampleTime: now,
      }
      return []
    }

    const gapSeconds = (now - this.open.lastSampleTime) / 1000
    const changed = resolution.category !== this.open.category
    if (changed || gapSeconds > this.opts.sessionGapSeconds) {
      const closed = this.flush(this.open.lastSampleTime)
      this.open = {
        category: resolution.category,
        projectId: resolution.projectId,
        app: sample.app,
        title: sample.title || '',
        url,
        startTime: now,
        lastSampleTime: now,
      }
      return closed
    }

    // Same category: extend, and let the newest window's app/title win so the
    // label reflects what the user is looking at right now.
    this.open.lastSampleTime = now
    this.open.app = sample.app
    this.open.title = sample.title || this.open.title
    if (url) this.open.url = url
    return []
  }

  /**
   * Close the open session at `endTime` (defaults to its last sample). Returns
   * the resulting records — more than one when the session spans a day boundary.
   */
  flush(endTime?: number): Session[] {
    const open = this.open
    this.open = null
    if (!open) return []
    const end = Math.max(open.startTime, endTime ?? open.lastSampleTime)
    if ((end - open.startTime) / 1000 < MIN_SESSION_SECONDS) return []

    const resolution = resolveCategory(open, this.opts.rules, this.opts.projects)
    const makeId = this.opts.makeId || defaultMakeId
    return splitAtDayBoundaries(open.startTime, end, this.opts.dayStartHour).map((seg) => ({
      id: makeId(),
      category: open.category,
      projectId: open.projectId,
      app: open.app,
      title: open.title,
      url: open.url,
      productivity: classifyProductivity(open, {
        ...resolution,
        category: open.category,
      }),
      startTime: seg.start,
      endTime: seg.end,
      durationSeconds: Math.round((seg.end - seg.start) / 1000),
    }))
  }
}

/**
 * Split `[start, end)` at every tracking-day boundary it crosses, dropping
 * segments too short to be meaningful.
 */
export function splitAtDayBoundaries(
  start: number,
  end: number,
  dayStartHour = DEFAULT_DAY_START_HOUR
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let segStart = start
  // Bounded: every iteration advances segStart to the next boundary or to end.
  while (segStart < end) {
    const segEnd = Math.min(nextDayBoundary(segStart, dayStartHour), end)
    if ((segEnd - segStart) / 1000 >= MIN_SESSION_SECONDS) out.push({ start: segStart, end: segEnd })
    segStart = segEnd
  }
  return out
}

/** Bucket sessions into their tracking-day keys, each list sorted by start. */
export function bucketByDay(
  sessions: Session[],
  dayStartHour = DEFAULT_DAY_START_HOUR
): Record<string, Session[]> {
  const out: Record<string, Session[]> = {}
  for (const s of sessions) {
    const key = dayKey(s.startTime, dayStartHour)
    ;(out[key] ||= []).push(s)
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => a.startTime - b.startTime)
  return out
}

/** Build an idle block, or null when the gap is too short to be worth showing. */
export function makeIdleBlock(start: number, end: number, minSeconds = 60): IdleBlock | null {
  const durationSeconds = Math.round((end - start) / 1000)
  if (durationSeconds < minSeconds) return null
  return { startTime: start, endTime: end, durationSeconds }
}
