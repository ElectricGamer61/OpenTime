/**
 * Applying a correction to the store.
 *
 * Lives outside `main.ts` so it can be tested against a real `Storage` without
 * Electron — these are the operations that overwrite automatically captured
 * history, and untested write paths over someone's history are not acceptable.
 *
 * Every branch ends in a single `putSessions`/`putIdle` for the affected day, so
 * a correction is one journalled write that either lands completely or not at
 * all. Validation lives in `core/edits.ts`; this decides only which rows go in
 * and which come out.
 */

import {
  applySessionEdit,
  claimIdleBlock,
  EditError,
  findOverlaps,
  makeManualSession,
  mergeSessions,
  removeIdleBlock,
  retimeSession,
  splitSession,
} from '../../core/edits'
import { dayContains, dayEndTs, dayStartTs } from '../../core/day'
import type { DayRecord, Session } from '../../core/types'
import type { SessionEdit } from '../../shared/ipc'
import type { Storage } from '../storage/Storage'

export interface ApplyEditOutcome {
  ok: boolean
  message?: string
  day?: DayRecord & { dayKey: string }
}

/**
 * "Sat 14 Mar, 04:00" — for an error message about a day boundary.
 *
 * The date matters here: a tracking day's two bounds are the same wall-clock
 * hour, so printing the time alone reads as the nonsensical "04:00 to 04:00".
 */
function whenLabel(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date}, ${time}`
}

export async function applyEdit(
  storage: Storage,
  edit: SessionEdit
): Promise<ApplyEditOutcome> {
  const key = edit.dayKey
  const dayStartHour = storage.getSettings().dayStartHour
  const sessions = [...(await storage.getSessions(key))]
  const find = (id: string) => sessions.find((s) => s.id === id)

  /**
   * Refuse a span that does not belong to the day it is being written into.
   *
   * A day file whose rows disagree with `dayKey()` is the bug class `day.ts`
   * exists to prevent: the totals for that day include time that belongs to
   * another one, and any re-aggregation from timestamps contradicts the store.
   * The caller is trusted for *which* day, so this is the last line of defence.
   */
  const mustBeInDay = (startTime: number, endTime: number): string | null => {
    // Malformed times are `core/edits`' to reject, with better wording.
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
    // `endTime` is exclusive, so a span ending exactly on the boundary is fine.
    if (dayContains(key, startTime, dayStartHour) && endTime <= dayEndTs(key, dayStartHour)) return null
    return (
      `That time is outside the tracking day being edited, which runs ` +
      `${whenLabel(dayStartTs(key, dayStartHour))} to ${whenLabel(dayEndTs(key, dayStartHour))}. ` +
      'Open the day it belongs to and add it there.'
    )
  }

  try {
    switch (edit.kind) {
      case 'split': {
        const target = find(edit.sessionId)
        if (!target) return { ok: false, message: 'That session is no longer there.' }
        const [a, b] = splitSession(target, edit.at)
        await storage.putSessions(
          key,
          applySessionEdit(sessions, { remove: [target.id], add: [a, b] })
        )
        break
      }
      case 'merge': {
        const targets = edit.sessionIds.map(find).filter((s): s is Session => !!s)
        if (targets.length < 2) return { ok: false, message: 'Select at least two sessions to merge.' }
        const merged = mergeSessions(targets)
        await storage.putSessions(
          key,
          applySessionEdit(sessions, { remove: targets.map((s) => s.id), add: [merged] })
        )
        break
      }
      case 'delete': {
        if (!find(edit.sessionId)) return { ok: false, message: 'That session is no longer there.' }
        await storage.putSessions(key, applySessionEdit(sessions, { remove: [edit.sessionId] }))
        break
      }
      case 'retime': {
        const target = find(edit.sessionId)
        if (!target) return { ok: false, message: 'That session is no longer there.' }
        const outside = mustBeInDay(edit.startTime, edit.endTime)
        if (outside) return { ok: false, message: outside }
        const moved = retimeSession(target, edit.startTime, edit.endTime)
        await storage.putSessions(
          key,
          applySessionEdit(sessions, { remove: [target.id], add: [moved] })
        )
        break
      }
      case 'manual': {
        const outside = mustBeInDay(edit.startTime, edit.endTime)
        if (outside) return { ok: false, message: outside }
        const created = makeManualSession(edit)
        const clashes = findOverlaps(created, sessions)
        if (clashes.length) {
          return {
            ok: false,
            message:
              `That overlaps ${clashes.length} tracked session${clashes.length > 1 ? 's' : ''}. ` +
              'Adjust the times, or delete what is there first.',
          }
        }
        await storage.putSessions(key, applySessionEdit(sessions, { add: [created] }))
        break
      }
      case 'claim-idle': {
        const idle = await storage.getIdle(key)
        const block = idle.find((b) => b.startTime === edit.idleStart)
        if (!block) return { ok: false, message: 'That away block is no longer there.' }
        const created = claimIdleBlock(block, edit)
        await storage.putSessions(key, applySessionEdit(sessions, { add: [created] }))
        // Removing the block is what stops the same minutes being counted twice.
        await storage.putIdle(key, removeIdleBlock(idle, edit.idleStart))
        break
      }
    }
  } catch (err) {
    // Validation failures are user-facing copy, not stack traces.
    if (err instanceof EditError) return { ok: false, message: err.message }
    throw err
  }

  return { ok: true, day: { dayKey: key, ...(await storage.getDay(key)) } }
}
