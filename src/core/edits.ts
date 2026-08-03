/**
 * Manual corrections, as pure functions.
 *
 * Automatic tracking is right most of the time and wrong in ways only the user
 * can fix: a call taken away from the keyboard, one long block that was really
 * two pieces of work, a stretch recorded under the wrong app because a helper
 * window had focus. Everything here is the arithmetic behind those fixes, kept
 * out of the main process so it can be tested exhaustively without Electron.
 *
 * Invariants every function upholds:
 *  - `durationSeconds` is always recomputed, never trusted from the caller;
 *  - a corrected row is marked `edited`, so a later rules change can be made to
 *    leave human decisions alone;
 *  - results stay sorted by `startTime`, which is what the storage layer, the
 *    timeline and `longestFocusRun` all assume.
 */

import { MIN_SESSION_SECONDS } from './sessions'
import type { IdleBlock, Productivity, Session } from './types'

let editCounter = 0

/** Ids for rows a human created. Prefixed so their origin is readable on sight. */
export function makeEditId(prefix = 'm'): string {
  editCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${editCounter.toString(36)}`
}

/**
 * The single place a duration is computed. Takes a session without one so a
 * caller physically cannot construct a row whose duration disagrees with its
 * timestamps — the bug class that quietly corrupts every total downstream.
 */
function withDuration(session: Omit<Session, 'durationSeconds'>): Session {
  return {
    ...session,
    durationSeconds: Math.max(0, Math.round((session.endTime - session.startTime) / 1000)),
  }
}

export class EditError extends Error {}

/**
 * Split one session at an instant, producing the two halves.
 *
 * Rejected when the cut would leave a piece too short to be a real session —
 * silently producing a zero-length row would corrupt every downstream total.
 */
export function splitSession(session: Session, at: number): [Session, Session] {
  if (!Number.isFinite(at)) throw new EditError('Split point is not a valid time.')
  const left = Math.round((at - session.startTime) / 1000)
  const right = Math.round((session.endTime - at) / 1000)
  if (left < MIN_SESSION_SECONDS || right < MIN_SESSION_SECONDS) {
    throw new EditError('Split point is too close to the edge of the session.')
  }
  return [
    withDuration({ ...session, id: makeEditId('sp'), endTime: at, edited: true }),
    withDuration({ ...session, id: makeEditId('sp'), startTime: at, edited: true }),
  ]
}

/**
 * Merge a set of sessions into one spanning block.
 *
 * The merged row inherits the identity of the longest input, because that is the
 * one the user was thinking of when they selected the range — merging a 55-minute
 * coding block with a 20-second terminal blip should not relabel the result
 * "Terminal". Gaps inside the merged span are absorbed deliberately: the user
 * asserting "this was all one thing" is exactly the point of the action.
 */
export function mergeSessions(sessions: Session[]): Session {
  if (sessions.length < 2) throw new EditError('Merging needs at least two sessions.')
  const sorted = [...sessions].sort((a, b) => a.startTime - b.startTime)
  const dominant = sorted.reduce((best, s) => (s.durationSeconds > best.durationSeconds ? s : best))
  return withDuration({
    ...dominant,
    id: makeEditId('mg'),
    startTime: sorted[0].startTime,
    endTime: Math.max(...sorted.map((s) => s.endTime)),
    edited: true,
  })
}

export interface ManualSessionInput {
  startTime: number
  endTime: number
  category: string
  productivity?: Productivity
  app?: string
  title?: string
  projectId?: string
  note?: string
}

/**
 * Build a session the user entered by hand — the "I was in a workshop all
 * afternoon, off the laptop" case that no automatic tracker can observe.
 */
export function makeManualSession(input: ManualSessionInput): Session {
  const startTime = Math.round(input.startTime)
  const endTime = Math.round(input.endTime)
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new EditError('Manual entries need a start and an end time.')
  }
  if ((endTime - startTime) / 1000 < MIN_SESSION_SECONDS) {
    throw new EditError('Manual entries must be at least a few seconds long.')
  }
  const category = (input.category || '').trim()
  if (!category) throw new EditError('Manual entries need a category.')

  return withDuration({
    id: makeEditId('mn'),
    category,
    projectId: input.projectId,
    app: (input.app || '').trim() || 'Manual entry',
    title: (input.title || '').trim(),
    url: '',
    productivity: input.productivity || 'productive',
    startTime,
    endTime,
    source: 'manual',
    edited: true,
    note: input.note?.trim() || undefined,
  })
}

/**
 * Turn an away block into tracked work.
 *
 * Time away from the keyboard is not automatically time not working — meetings,
 * whiteboards and phone calls all look identical to an idle detector. Claiming
 * an away block is how that time gets counted, and it removes the block so the
 * same minutes are never counted twice.
 */
export function claimIdleBlock(
  block: IdleBlock,
  input: { category: string; productivity?: Productivity; projectId?: string; note?: string }
): Session {
  return makeManualSession({
    startTime: block.startTime,
    endTime: block.endTime,
    category: input.category,
    productivity: input.productivity,
    projectId: input.projectId,
    note: input.note,
    app: 'Away from keyboard',
  })
}

/** Move or resize a session, recomputing its duration. */
export function retimeSession(session: Session, startTime: number, endTime: number): Session {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new EditError('New times are not valid.')
  }
  if ((endTime - startTime) / 1000 < MIN_SESSION_SECONDS) {
    throw new EditError('A session must be at least a few seconds long.')
  }
  return withDuration({
    ...session,
    startTime: Math.round(startTime),
    endTime: Math.round(endTime),
    edited: true,
  })
}

/**
 * Insert edited rows into a day, replacing any ids they supersede.
 *
 * One helper for every edit operation, so ordering and de-duplication live in
 * exactly one place instead of being re-derived at each call site.
 */
export function applySessionEdit(
  day: Session[],
  opts: { remove?: string[]; add?: Session[] }
): Session[] {
  const removing = new Set(opts.remove || [])
  const kept = day.filter((s) => !removing.has(s.id))
  const next = [...kept, ...(opts.add || [])]
  return next.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

/** Drop an away block by its start time (idle blocks carry no id of their own). */
export function removeIdleBlock(blocks: IdleBlock[], startTime: number): IdleBlock[] {
  return blocks.filter((b) => b.startTime !== startTime)
}

/**
 * Whether two sessions overlap in time. Used to warn on manual entries that
 * would double-count minutes already tracked.
 */
export function overlaps(a: { startTime: number; endTime: number }, b: Session): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime
}

/** The stored sessions a proposed span would double-count. */
export function findOverlaps(span: { startTime: number; endTime: number }, day: Session[]): Session[] {
  return day.filter((s) => overlaps(span, s))
}
