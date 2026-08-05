/**
 * Tracking-day math.
 *
 * Adapted from the day-boundary helper in the older Norte tracker
 * (`electron/norte-date.js`), which learned the hard way that formatting a day
 * key via `toISOString()` buckets by the *UTC* day — that rolls the tracking day
 * at the wrong local hour for any non-UTC timezone and strands late-night
 * sessions on the wrong date. Everything here is local-time only, and the
 * boundary hour is a setting rather than a hard-coded 3am.
 *
 * Pure functions, no Electron imports, so they are unit-testable with plain node.
 */

export const DEFAULT_DAY_START_HOUR = 4

/** `YYYY-MM-DD` for a Date, using its local calendar fields. */
export function formatYmdLocal(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  )
}

/** Parse `YYYY-MM-DD` as a *local* midnight Date (not UTC). */
export function parseYmdLocal(key: string): Date {
  const [y, m, d] = String(key).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

/**
 * The tracking-day key an instant belongs to. Times before `dayStartHour`
 * local belong to the previous calendar date.
 */
export function dayKey(ts: number = Date.now(), dayStartHour = DEFAULT_DAY_START_HOUR): string {
  return formatYmdLocal(new Date(ts - dayStartHour * 60 * 60 * 1000))
}

/**
 * Epoch ms of the first day boundary strictly after `ts`. Used to split a
 * session that spans midnight-ish so each day's ledger only ever holds time
 * that belongs to that day.
 */
export function nextDayBoundary(ts: number, dayStartHour = DEFAULT_DAY_START_HOUR): number {
  const d = new Date(ts)
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), dayStartHour, 0, 0, 0)
  if (b.getTime() <= ts) b.setDate(b.getDate() + 1)
  return b.getTime()
}

/** Epoch ms at which the tracking day `key` starts. */
export function dayStartTs(key: string, dayStartHour = DEFAULT_DAY_START_HOUR): number {
  const d = parseYmdLocal(key)
  d.setHours(dayStartHour, 0, 0, 0)
  return d.getTime()
}

/** Epoch ms at which the tracking day `key` ends (exclusive). */
export function dayEndTs(key: string, dayStartHour = DEFAULT_DAY_START_HOUR): number {
  const d = parseYmdLocal(key)
  d.setHours(dayStartHour, 0, 0, 0)
  d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** Whether an instant falls inside the tracking day `key`. */
export function dayContains(key: string, ts: number, dayStartHour = DEFAULT_DAY_START_HOUR): boolean {
  return ts >= dayStartTs(key, dayStartHour) && ts < dayEndTs(key, dayStartHour)
}

/**
 * The instant a wall-clock `HH:MM` refers to *within* the tracking day `key`.
 *
 * A tracking day runs from `dayStartHour` on its own date through to
 * `dayStartHour` the next morning, so an hour earlier than the boundary belongs
 * to the following calendar date. Anchoring on the calendar date instead files
 * a 2am entry on the previous tracking day while the UI says otherwise — the
 * same local-vs-boundary mistake `dayKey` exists to prevent.
 */
export function timeWithinDay(
  key: string,
  hours: number,
  minutes: number,
  dayStartHour = DEFAULT_DAY_START_HOUR
): number {
  const d = parseYmdLocal(key)
  if (hours < dayStartHour) d.setDate(d.getDate() + 1)
  d.setHours(hours, minutes, 0, 0)
  return d.getTime()
}

/** Inclusive list of day keys between two keys, ascending. */
export function dayKeyRange(startKey: string, endKey: string): string[] {
  const out: string[] = []
  const end = parseYmdLocal(endKey)
  for (const d = parseYmdLocal(startKey); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(formatYmdLocal(d))
  }
  return out
}

/** The `count` day keys ending at (and including) `endKey`. */
export function lastNDayKeys(count: number, endKey: string): string[] {
  const d = parseYmdLocal(endKey)
  d.setDate(d.getDate() - (count - 1))
  return dayKeyRange(formatYmdLocal(d), endKey)
}
