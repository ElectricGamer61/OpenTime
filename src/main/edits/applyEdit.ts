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
import { sealFocus } from '../../core/focus'
import type { DayRecord, Session } from '../../core/types'
import type { SessionEdit } from '../../shared/ipc'
import type { Storage } from '../storage/Storage'

export interface ApplyEditOutcome {
  ok: boolean
  message?: string
  day?: DayRecord & { dayKey: string }
}

export async function applyEdit(
  storage: Storage,
  edit: SessionEdit
): Promise<ApplyEditOutcome> {
  const key = edit.dayKey
  const sessions = [...(await storage.getSessions(key))]
  const find = (id: string) => sessions.find((s) => s.id === id)

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
        const moved = retimeSession(target, edit.startTime, edit.endTime)
        await storage.putSessions(
          key,
          applySessionEdit(sessions, { remove: [target.id], add: [moved] })
        )
        break
      }
      case 'manual': {
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
      case 'seal-focus': {
        const sealed = sealFocus(sessions, edit.focus, edit.endTime)
        await storage.putSessions(key, sealed.sessions)
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
