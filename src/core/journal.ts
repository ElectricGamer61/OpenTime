/**
 * The write-ahead journal's record shapes, and how one record folds into a day.
 *
 * This lives in `core/` rather than inside `FileStorage` because two readers
 * fold the same journal: the store itself on boot, and the read-only MCP server
 * (`src/mcp/`), which runs in a separate process while the app is writing and
 * so has to see the writes the app has journalled but not yet checkpointed.
 * One fold, so the two can never disagree about what a record means.
 */

import type { CalendarEvent, DayRecord, IdleBlock, Session } from './types'

/**
 * A change to one session. `null` removes a field: `undefined` cannot, because
 * JSON drops it, so a journalled "clear the project" would come back on replay
 * as "leave the project alone".
 */
export type SessionPatch = { [K in keyof Session]?: Session[K] | null }

export type JournalRecord =
  | { seq: number; op: 'appendSessions'; days: Record<string, Session[]> }
  | { seq: number; op: 'putSessions'; key: string; sessions: Session[] }
  | { seq: number; op: 'appendIdle'; key: string; block: IdleBlock }
  | { seq: number; op: 'putIdle'; key: string; blocks: IdleBlock[] }
  | { seq: number; op: 'putEvents'; key: string; events: CalendarEvent[] }
  | { seq: number; op: 'updateSession'; key: string; id: string; patch: SessionPatch }

export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

export function sortSessions(list: Session[]): Session[] {
  return list.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

/** The day keys a record touches. */
export function recordKeys(record: JournalRecord): string[] {
  const keys = record.op === 'appendSessions' ? Object.keys(record.days) : [record.key]
  return keys.filter((k) => DAY_KEY_RE.test(k))
}

/** Apply one record to one of the days it touches, in place. */
export function foldRecord(day: DayRecord, key: string, record: JournalRecord): void {
  switch (record.op) {
    case 'appendSessions': {
      const incoming = record.days[key] || []
      const list = day.sessions
      const tail = list[list.length - 1]
      list.push(...incoming)
      // Sessions arrive chronologically in the common case, so a tail check
      // beats re-sorting the day on every flush.
      if (tail && incoming.some((s) => s.startTime < tail.startTime)) sortSessions(list)
      break
    }
    case 'putSessions':
      day.sessions = sortSessions([...record.sessions])
      break
    case 'appendIdle':
      day.idle.push(record.block)
      break
    case 'putIdle':
      day.idle = [...record.blocks]
      break
    case 'putEvents':
      day.events = [...record.events]
      break
    case 'updateSession': {
      const index = day.sessions.findIndex((s) => s.id === record.id)
      if (index < 0) break
      const next: Record<string, unknown> = { ...day.sessions[index], ...record.patch, id: day.sessions[index].id }
      for (const [field, value] of Object.entries(record.patch)) {
        if (value === null) delete next[field]
      }
      day.sessions[index] = next as unknown as Session
      break
    }
  }
}

/** Parse journal text, skipping torn or foreign lines the way replay does. */
export function parseJournal(raw: string): JournalRecord[] {
  const out: JournalRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JournalRecord
      if (record && typeof record.seq === 'number') out.push(record)
    } catch {
      // A torn final line from a crash mid-append; replay skips it too.
    }
  }
  return out
}
