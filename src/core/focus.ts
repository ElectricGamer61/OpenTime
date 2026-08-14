/**
 * Focus sessions.
 *
 * A focus session is a deliberate claim over a stretch of time: "for the next
 * 45 minutes I am working on the billing fix". Everything else in OpenTime
 * observes; this is the one place the user declares.
 *
 * The important decision is that a focus session is **not a second kind of
 * record**. The tracker keeps sampling throughout, exactly as it always does.
 * Ending the session *seals* it: the rows the tracker already wrote for those
 * minutes are stamped with the session's id and goal, and only the minutes
 * nothing was observed for are filled in. That is why the timeline can draw a
 * focus session as one block without the time being counted twice, and why the
 * block can still be opened to see which apps the session actually went in.
 *
 * Pure and dependency-free apart from `edits`/`sessions`; `tests/focus.test.ts`
 * pins it.
 */

import { EditError, makeEditId } from './edits'
import { MIN_SESSION_SECONDS } from './sessions'
import type { ActiveFocus, AmbientBedId, FocusMark, Session } from './types'

/** Preset lengths offered in the setup panel, in minutes. */
export const FOCUS_PRESET_MINUTES = [15, 25, 45, 60, 90] as const

/** The default a session starts at when the user does not choose. */
export const DEFAULT_FOCUS_MINUTES = 45

/** What a focus session is filed under when it has to fill in unobserved time. */
export const DEFAULT_FOCUS_CATEGORY = 'Deep Work'

/**
 * The ambient beds the session panel offers.
 *
 * Every one of these is *synthesised* in the renderer from filtered noise —
 * there are no audio files in the bundle and none are fetched, because the
 * renderer's CSP allows no external sources and because shipping somebody
 * else's recordings is a licensing problem nobody needs. The descriptions are
 * what they actually are, not what a stock library would call them.
 */
export const AMBIENT_BEDS: Array<{
  id: AmbientBedId
  label: string
  detail: string
}> = [
  { id: 'silence', label: 'Silence', detail: 'No sound at all.' },
  { id: 'rain', label: 'Rain', detail: 'Steady high band, like rain on a window.' },
  { id: 'ocean', label: 'Waves', detail: 'A slow swell that rises and falls.' },
  { id: 'cafe', label: 'Room tone', detail: 'The low hum of a busy room.' },
  { id: 'deep', label: 'Deep hum', detail: 'A dark drone with no detail to follow.' },
]

export function isAmbientBed(value: unknown): value is AmbientBedId {
  return AMBIENT_BEDS.some((bed) => bed.id === value)
}

export interface FocusStartInput {
  label?: string
  minutes?: number
  category?: string
  projectId?: string
  sound?: AmbientBedId
}

/**
 * Build the running session from what the setup panel collected.
 *
 * Everything is optional at the call site and nothing is optional afterwards:
 * a half-filled focus session is the kind of record that produces a block
 * labelled `undefined` three weeks later.
 */
export function startFocus(input: FocusStartInput, now = Date.now()): ActiveFocus {
  const minutes = Number.isFinite(input.minutes) ? Math.round(input.minutes as number) : DEFAULT_FOCUS_MINUTES
  if (minutes < 1 || minutes > 8 * 60) {
    throw new EditError('A focus session runs between 1 minute and 8 hours.')
  }
  return {
    id: makeEditId('fs'),
    label: (input.label || '').trim() || 'Focus session',
    startTime: Math.round(now),
    plannedSeconds: minutes * 60,
    category: (input.category || '').trim() || DEFAULT_FOCUS_CATEGORY,
    projectId: input.projectId || undefined,
    sound: isAmbientBed(input.sound) ? input.sound : 'silence',
  }
}

export interface FocusProgress {
  elapsedSeconds: number
  /** Never negative — an overrun reports zero remaining and `overrun` true. */
  remainingSeconds: number
  /** 0–1, clamped. */
  fraction: number
  overrun: boolean
  overrunSeconds: number
}

export function focusProgress(focus: ActiveFocus, now = Date.now()): FocusProgress {
  const elapsed = Math.max(0, Math.round((now - focus.startTime) / 1000))
  const planned = Math.max(1, focus.plannedSeconds)
  const remaining = planned - elapsed
  return {
    elapsedSeconds: elapsed,
    remainingSeconds: Math.max(0, remaining),
    fraction: Math.min(1, elapsed / planned),
    overrun: remaining < 0,
    overrunSeconds: Math.max(0, -remaining),
  }
}

function withDuration(session: Omit<Session, 'durationSeconds'>): Session {
  return {
    ...session,
    durationSeconds: Math.max(0, Math.round((session.endTime - session.startTime) / 1000)),
  }
}

function overlapSeconds(
  a: { startTime: number; endTime: number },
  b: { startTime: number; endTime: number }
): number {
  const start = Math.max(a.startTime, b.startTime)
  const end = Math.min(a.endTime, b.endTime)
  return Math.max(0, Math.round((end - start) / 1000))
}

export interface SealedFocus {
  /** The day's sessions after sealing, ascending by start. */
  sessions: Session[]
  /** Seconds the session ended up covering. */
  seconds: number
  /** Rows created to fill in time nothing was observed for. */
  filled: number
}

/**
 * Stamp a finished focus session onto the day it ran in.
 *
 * Three cases, and the ordering between them is the whole design:
 *
 *  - A session entirely inside the window is stamped as it is.
 *  - A session straddling an edge is **split at the edge**, so the minutes
 *    before you started and after you stopped are not claimed. Splitting is
 *    skipped when it would leave a piece too short to be a session at all —
 *    those go whole to whichever side holds most of them, because a
 *    two-second orphan row is worse than a two-second boundary error.
 *  - Time inside the window that nothing was observed for is filled with a
 *    manual row. Without this a session run against a machine that could not
 *    capture would seal to nothing at all.
 */
export function sealFocus(
  sessions: Session[],
  focus: ActiveFocus,
  endTime: number,
  makeId: (prefix?: string) => string = makeEditId
): SealedFocus {
  const start = Math.round(focus.startTime)
  const end = Math.round(endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new EditError('That focus session has no usable times.')
  }
  if ((end - start) / 1000 < MIN_SESSION_SECONDS) {
    throw new EditError('That focus session was too short to record.')
  }

  const span = { startTime: start, endTime: end }
  const mark: FocusMark = { id: focus.id, label: focus.label, plannedSeconds: focus.plannedSeconds }
  const stamp = (session: Session): Session => ({
    ...session,
    focus: mark,
    projectId: focus.projectId ?? session.projectId,
    edited: true,
  })

  const out: Session[] = []
  /** Windows inside the span already accounted for, so gaps can be found. */
  const claimed: Array<{ startTime: number; endTime: number }> = []

  for (const session of sessions) {
    const inside = overlapSeconds(session, span)
    if (inside <= 0) {
      // Not our business — but drop a stale mark if this row belonged to a
      // previous run of the same session id.
      out.push(session.focus?.id === focus.id ? { ...session, focus: undefined } : session)
      continue
    }

    const head = session.startTime < start ? Math.round((start - session.startTime) / 1000) : 0
    const tail = session.endTime > end ? Math.round((session.endTime - end) / 1000) : 0
    const splittable =
      (head === 0 || head >= MIN_SESSION_SECONDS) &&
      (tail === 0 || tail >= MIN_SESSION_SECONDS) &&
      inside >= MIN_SESSION_SECONDS

    if (!splittable) {
      // Majority rule: the row goes wholly in or wholly out.
      if (inside * 2 >= session.durationSeconds) {
        out.push(stamp(session))
        claimed.push({ startTime: session.startTime, endTime: session.endTime })
      } else {
        out.push(session)
      }
      continue
    }

    if (head > 0) {
      out.push(
        withDuration({ ...session, id: makeId('sp'), endTime: start, edited: true, focus: undefined })
      )
    }
    const middle = withDuration({
      ...session,
      id: head > 0 || tail > 0 ? makeId('sp') : session.id,
      startTime: Math.max(session.startTime, start),
      endTime: Math.min(session.endTime, end),
    })
    out.push(stamp(middle))
    claimed.push({ startTime: middle.startTime, endTime: middle.endTime })
    if (tail > 0) {
      out.push(
        withDuration({ ...session, id: makeId('sp'), startTime: end, edited: true, focus: undefined })
      )
    }
  }

  // Fill whatever the tracker never saw. Sorted-merge first, so overlapping
  // claims (which the store should not hold, but might) cannot open a fake gap.
  claimed.sort((a, b) => a.startTime - b.startTime)
  let cursor = start
  let filled = 0
  const gaps: Array<{ startTime: number; endTime: number }> = []
  for (const window of claimed) {
    if (window.startTime > cursor) gaps.push({ startTime: cursor, endTime: Math.min(window.startTime, end) })
    cursor = Math.max(cursor, Math.min(window.endTime, end))
  }
  if (cursor < end) gaps.push({ startTime: cursor, endTime: end })

  for (const gap of gaps) {
    if ((gap.endTime - gap.startTime) / 1000 < MIN_SESSION_SECONDS) continue
    filled += 1
    out.push(
      withDuration({
        id: makeId('fc'),
        category: focus.category,
        projectId: focus.projectId,
        app: 'Focus session',
        title: focus.label,
        url: '',
        productivity: 'productive',
        startTime: gap.startTime,
        endTime: gap.endTime,
        source: 'manual',
        edited: true,
        focus: mark,
      })
    )
  }

  const sorted = out.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
  return {
    sessions: sorted,
    seconds: sorted
      .filter((s) => s.focus?.id === focus.id)
      .reduce((sum, s) => sum + s.durationSeconds, 0),
    filled,
  }
}

/** What the post-session card reports back. */
export interface FocusOutcome {
  label: string
  plannedSeconds: number
  actualSeconds: number
  /** Apps and sites the session actually went in, largest first. */
  apps: Array<{ name: string; seconds: number }>
}

/** Read a sealed session back out of a day, for the "how did that go" card. */
export function focusOutcome(sessions: Session[], focusId: string): FocusOutcome | null {
  const rows = sessions.filter((s) => s.focus?.id === focusId)
  if (!rows.length) return null
  const totals = new Map<string, number>()
  for (const row of rows) {
    const name = row.url || row.app || 'Unknown'
    totals.set(name, (totals.get(name) || 0) + row.durationSeconds)
  }
  return {
    label: rows[0].focus?.label || 'Focus session',
    plannedSeconds: rows[0].focus?.plannedSeconds || 0,
    actualSeconds: rows.reduce((sum, s) => sum + s.durationSeconds, 0),
    apps: [...totals.entries()]
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds),
  }
}
