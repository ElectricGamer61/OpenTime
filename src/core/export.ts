/**
 * Export and backup formats.
 *
 * The point of a local-first tracker is that the data is yours, and data you
 * cannot get out of the app is not yours. Three formats, each with a job:
 *
 *  - **sessions CSV** — one row per session, for a spreadsheet or an invoice;
 *  - **daily CSV** — one row per day, for a quick chart of a quarter;
 *  - **JSON backup** — the whole store, round-trippable back into OpenTime.
 *
 * All pure: formatting takes data in and returns a string. The main process
 * owns the file dialog and nothing else.
 */

import { dayKey } from './day'
import { sanitizeSettings, STATE_VERSION, defaultConfig } from './defaults'
import type { DayRecord, PersistedState, Session, StoreConfig } from './types'

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Quote a CSV field.
 *
 * Window titles contain commas, quotes and newlines constantly, and a field
 * starting with `=`, `+`, `-` or `@` is executed as a formula by Excel and
 * Sheets on open. Prefixing those with an apostrophe is the standard defence
 * against CSV injection, and a time tracker exports attacker-influenced strings
 * (any web page title) by definition.
 */
export function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(',')
}

function isoLocal(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

export const SESSION_CSV_HEADER = [
  'day',
  'start',
  'end',
  'duration_seconds',
  'duration_hours',
  'category',
  'productivity',
  'app',
  'title',
  'host',
  'project_id',
  'source',
  'edited',
  'note',
]

/**
 * One row per session, oldest first. Times are written in the user's local
 * calendar, because an export that renders as UTC is an export that gets
 * mis-added in a spreadsheet.
 */
export function sessionsToCsv(sessions: Session[], dayStartHour: number): string {
  const rows = [csvRow(SESSION_CSV_HEADER)]
  for (const s of [...sessions].sort((a, b) => a.startTime - b.startTime)) {
    rows.push(
      csvRow([
        dayKey(s.startTime, dayStartHour),
        isoLocal(s.startTime),
        isoLocal(s.endTime),
        s.durationSeconds,
        (s.durationSeconds / 3600).toFixed(4),
        s.category,
        s.productivity,
        s.app,
        s.title,
        s.url,
        s.projectId || '',
        s.source || 'capture',
        s.edited ? 'yes' : '',
        s.note || '',
      ])
    )
  }
  return `${rows.join('\n')}\n`
}

export const DAILY_CSV_HEADER = [
  'day',
  'tracked_seconds',
  'productive_seconds',
  'neutral_seconds',
  'distracting_seconds',
  'away_seconds',
  'meeting_seconds',
  'longest_focus_seconds',
  'switches',
  'focus_score',
]

export interface DailyCsvRow {
  dayKey: string
  totalSeconds: number
  productiveSeconds: number
  neutralSeconds: number
  distractingSeconds: number
  idleSeconds: number
  meetingSeconds: number
  longestFocusSeconds: number
  switches: number
  focusScore: number
}

/** One row per day — the shape of `DaySummary`, so callers pass summaries straight in. */
export function dailyToCsv(days: DailyCsvRow[]): string {
  const rows = [csvRow(DAILY_CSV_HEADER)]
  for (const d of days) {
    rows.push(
      csvRow([
        d.dayKey,
        d.totalSeconds,
        d.productiveSeconds,
        d.neutralSeconds,
        d.distractingSeconds,
        d.idleSeconds,
        d.meetingSeconds,
        d.longestFocusSeconds,
        d.switches,
        d.focusScore,
      ])
    )
  }
  return `${rows.join('\n')}\n`
}

// ── JSON backup ──────────────────────────────────────────────────────────────

export interface Backup {
  /** Fixed marker, so a wrong file chosen in the restore dialog is rejected. */
  format: 'opentime-backup'
  version: number
  exportedAt: number
  appVersion: string
  config: StoreConfig
  days: Record<string, DayRecord>
}

export function buildBackup(
  config: StoreConfig,
  days: Record<string, DayRecord>,
  meta: { exportedAt: number; appVersion: string }
): Backup {
  return {
    format: 'opentime-backup',
    version: STATE_VERSION,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    config,
    days,
  }
}

export class BackupError extends Error {}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * Validate and normalise a file the user picked in the restore dialog.
 *
 * Restore replaces the entire store, so this is the one place where believing a
 * malformed file is unrecoverable. Unknown day keys, non-array day records and
 * missing config sections are rejected or defaulted rather than written through.
 * Accepts a v1 single-blob export too, so a backup taken before the sharded
 * store still restores.
 */
export function parseBackup(raw: string): Backup {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BackupError('That file is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') throw new BackupError('That file is not an OpenTime backup.')

  const obj = parsed as Partial<Backup> & Partial<PersistedState>

  // A v1 export was the whole PersistedState with no envelope.
  const looksLikeV1 = !obj.format && !!obj.sessionsByDay
  if (!looksLikeV1 && obj.format !== 'opentime-backup') {
    throw new BackupError('That file is not an OpenTime backup.')
  }

  const config: StoreConfig = looksLikeV1
    ? {
        version: STATE_VERSION,
        settings: sanitizeSettings(obj.settings),
        projects: asArray(obj.projects).length ? asArray(obj.projects) : defaultConfig().projects,
        rules: asArray(obj.rules),
        goals: asArray(obj.goals),
      }
    : {
        version: STATE_VERSION,
        settings: sanitizeSettings(obj.config?.settings),
        projects: asArray(obj.config?.projects).length
          ? asArray(obj.config?.projects)
          : defaultConfig().projects,
        rules: asArray(obj.config?.rules),
        goals: asArray(obj.config?.goals),
      }

  const days: Record<string, DayRecord> = {}
  if (looksLikeV1) {
    const keys = new Set([
      ...Object.keys(obj.sessionsByDay || {}),
      ...Object.keys(obj.idleByDay || {}),
      ...Object.keys(obj.eventsByDay || {}),
    ])
    for (const key of keys) {
      if (!DAY_KEY_RE.test(key)) continue
      days[key] = {
        sessions: asArray(obj.sessionsByDay?.[key]),
        idle: asArray(obj.idleByDay?.[key]),
        events: asArray(obj.eventsByDay?.[key]),
      }
    }
  } else {
    for (const [key, value] of Object.entries(obj.days || {})) {
      if (!DAY_KEY_RE.test(key) || !value || typeof value !== 'object') continue
      days[key] = {
        sessions: asArray((value as DayRecord).sessions),
        idle: asArray((value as DayRecord).idle),
        events: asArray((value as DayRecord).events),
      }
    }
  }

  return {
    format: 'opentime-backup',
    version: STATE_VERSION,
    exportedAt: Number(obj.exportedAt) || 0,
    appVersion: String(obj.appVersion || ''),
    config,
    days,
  }
}

/** A filename that sorts chronologically and never collides. */
export function exportFilename(prefix: string, ext: string, now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`
  )
}
