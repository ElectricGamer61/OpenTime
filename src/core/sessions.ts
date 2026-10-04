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
import {
  classifyProductivity,
  isPrivateSample,
  looksDistracting,
  resolveCategory,
  UNCATEGORIZED,
  type CategoryResolution,
} from './categorize'
import type {
  CategoryRule,
  IdleBlock,
  MatchSource,
  Productivity,
  Project,
  Session,
  SessionSource,
  WindowSample,
} from './types'

/** Sessions shorter than this are sampling noise and are discarded. */
export const MIN_SESSION_SECONDS = 3

/**
 * How long a window with nothing to go on stays with the project around it.
 *
 * Working on something means bouncing through windows that say nothing about
 * it: an app whose title is just its name, a new tab, a file picker. Filing
 * those minutes as Uncategorized chops one stretch of work into confetti, so
 * they stay with the project that was open, for up to this long after the
 * last window that actually named it. Past that, or on anything that looks
 * like a distraction, they are their own thing again.
 */
export const CONTEXT_CARRY_SECONDS = 5 * 60

export interface SessionBuilderOptions {
  sessionGapSeconds: number
  dayStartHour: number
  ignoredApps: string[]
  /** Titles/hosts containing any of these are never recorded. */
  ignoredTitleKeywords?: string[]
  rules: CategoryRule[]
  projects: Project[]
  /** Stamped onto every emitted session; 'capture' unless the demo generator says otherwise. */
  source?: SessionSource
  /** Injected so tests get stable ids; defaults to a time+counter id. */
  makeId?: () => string
}

interface OpenSession {
  category: string
  projectId?: string
  /** Pinned by the rule or project that filed it, when one does. */
  productivity?: Productivity
  match: MatchSource
  /** Last time a window actually pointed at this category (not carried). */
  lastSignalTime: number
  /**
   * Opened on a browser window whose address was still being read, so its
   * label is a placeholder the next real sample may replace.
   */
  provisional?: boolean
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
    // A private app or subject closes the open session immediately: the time is
    // dropped, never merged into whatever the user was doing before.
    if (isPrivateSample(sample, this.opts.ignoredApps, this.opts.ignoredTitleKeywords)) {
      return this.flush(now)
    }

    const open = this.open
    const gapSeconds = open ? (now - open.lastSampleTime) / 1000 : Infinity
    const continuing = !!open && gapSeconds <= this.opts.sessionGapSeconds

    // A page whose address has not been read yet tells us nothing new: keep
    // extending what is open (a few seconds, one poll at most) rather than
    // filing it on its title alone and then moving it once the address lands.
    if (sample.urlPending && continuing && open) {
      open.lastSampleTime = now
      return []
    }

    let resolution: CategoryResolution = resolveCategory(sample, this.opts.rules, this.opts.projects)
    const carried =
      resolution.source === 'default' &&
      continuing &&
      !!open &&
      open.category !== UNCATEGORIZED &&
      now - open.lastSignalTime <= CONTEXT_CARRY_SECONDS * 1000 &&
      !looksDistracting(sample)
    if (carried && open) {
      resolution = {
        category: open.category,
        projectId: open.projectId,
        productivity: open.productivity,
        source: 'context',
      }
    }

    // The session was opened on a page still being read; now that something
    // real is known, it takes this label from its start.
    if (continuing && open?.provisional && !sample.urlPending) {
      this.relabel(open, resolution, now)
      this.touch(open, sample, now, false)
      return []
    }

    if (!open || !continuing || resolution.category !== open.category) {
      const closed = open ? this.flush(open.lastSampleTime) : []
      this.open = {
        category: resolution.category,
        projectId: resolution.projectId,
        productivity: resolution.productivity,
        match: resolution.source,
        lastSignalTime: now,
        provisional: sample.urlPending || undefined,
        app: sample.app,
        title: sample.title || '',
        url: sample.url || '',
        startTime: now,
        lastSampleTime: now,
      }
      return closed
    }

    this.touch(open, sample, now, carried)
    return []
  }

  /** Give an open session a new label, keeping its start. */
  private relabel(open: OpenSession, resolution: CategoryResolution, now: number): void {
    open.category = resolution.category
    open.projectId = resolution.projectId
    open.productivity = resolution.productivity
    open.match = resolution.source
    open.lastSignalTime = now
    open.provisional = undefined
  }

  /**
   * Extend the open session with a sample of the same category.
   *
   * The newest window's app and title win, so the label reflects what the user
   * is looking at now; but a carried window (one that said nothing about the
   * work) does not get to rename the block it was folded into.
   */
  private touch(open: OpenSession, sample: WindowSample, now: number, carried: boolean): void {
    open.lastSampleTime = now
    if (carried) return
    open.lastSignalTime = now
    open.app = sample.app
    open.title = sample.title || open.title
    if (sample.url) open.url = sample.url
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

    const makeId = this.opts.makeId || defaultMakeId
    return splitAtDayBoundaries(open.startTime, end, this.opts.dayStartHour).map((seg) => ({
      id: makeId(),
      category: open.category,
      projectId: open.projectId,
      app: open.app,
      title: open.title,
      url: open.url,
      productivity: classifyProductivity(open, {
        category: open.category,
        productivity: open.productivity,
        source: open.match,
      }),
      match: open.match,
      startTime: seg.start,
      endTime: seg.end,
      durationSeconds: Math.round((seg.end - seg.start) / 1000),
      source: this.opts.source || 'capture',
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
