/**
 * Turning the store into a file's worth of bytes.
 *
 * Separated from `main.ts` so the payload can be tested against real storage;
 * the main process keeps only the parts that need Electron — the save dialog and
 * the write itself.
 *
 * Days are read one at a time rather than all at once, so exporting a year does
 * not require a year of history to fit in memory.
 */

import { summarizeDay } from '../../core/aggregate'
import { dayKeyRange } from '../../core/day'
import { buildBackup, dailyToCsv, sessionsToCsv } from '../../core/export'
import type { DayRecord, Session } from '../../core/types'
import type { ExportFormat, ExportRequest } from '../../shared/ipc'
import type { Storage } from '../storage/Storage'

/** The day keys an export request covers, clipped to what actually exists. */
export function resolveRange(storage: Storage, request: ExportRequest): string[] {
  const all = storage.listDayKeys()
  if (!all.length) return []
  const from = request.fromKey || all[0]
  const to = request.toKey || all[all.length - 1]
  const wanted = new Set(dayKeyRange(from, to))
  return all.filter((k) => wanted.has(k))
}

export interface ExportPayload {
  contents: string
  /** Rows for a session export, days for the others — the number worth reporting. */
  count: number
  /** What `count` counts, for the confirmation message. */
  unit: 'sessions' | 'days'
}

export async function buildExportPayload(
  storage: Storage,
  request: ExportRequest,
  meta: { exportedAt: number; appVersion: string }
): Promise<ExportPayload> {
  const keys = resolveRange(storage, request)
  const dayStartHour = storage.getSettings().dayStartHour

  if (request.format === 'backup-json') {
    const days: Record<string, DayRecord> = {}
    for (const key of keys) days[key] = await storage.getDay(key)
    return {
      contents: JSON.stringify(buildBackup(storage.getConfig(), days, meta), null, 2),
      count: keys.length,
      unit: 'days',
    }
  }

  if (request.format === 'sessions-csv') {
    const sessions: Session[] = []
    for (const key of keys) sessions.push(...(await storage.getSessions(key)))
    return { contents: sessionsToCsv(sessions, dayStartHour), count: sessions.length, unit: 'sessions' }
  }

  const summaries = []
  for (const key of keys) {
    const record = await storage.getDay(key)
    summaries.push(summarizeDay(key, record.sessions, record.idle, record.events))
  }
  return { contents: dailyToCsv(summaries), count: summaries.length, unit: 'days' }
}

/** Default filename stem and file-dialog filter for each format. */
export const FORMAT_SPEC: Record<ExportFormat, { prefix: string; ext: string; filterName: string }> =
  {
    'sessions-csv': { prefix: 'opentime-sessions', ext: 'csv', filterName: 'CSV' },
    'daily-csv': { prefix: 'opentime-daily', ext: 'csv', filterName: 'CSV' },
    'backup-json': { prefix: 'opentime-backup', ext: 'json', filterName: 'JSON' },
  }
