/**
 * Reporting ranges.
 *
 * Storage and export have always spanned arbitrary day keys; what was missing
 * was the arithmetic for the periods a person actually asks for — "this month",
 * "the quarter", "those two weeks in March" — and a way to step through them.
 * That is all this is: pure day-key math, no data access, no React.
 *
 * Everything is expressed in **tracking-day keys**, never in timestamps, because
 * the tracking day rolls at a configurable hour and every other part of the app
 * already agrees on the key as the unit. `tests/range.test.ts` pins it.
 */

import { dayKeyRange, formatYmdLocal, parseYmdLocal } from './day'

export type RangeKind = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom'

export interface DayRange {
  kind: RangeKind
  /** Inclusive, `YYYY-MM-DD`. */
  fromKey: string
  /** Inclusive, `YYYY-MM-DD`. */
  toKey: string
}

/** How many days a range covers, inclusive. */
export function rangeLength(range: DayRange): number {
  const from = parseYmdLocal(range.fromKey).getTime()
  const to = parseYmdLocal(range.toKey).getTime()
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1)
}

export function rangeKeys(range: DayRange): string[] {
  return dayKeyRange(range.fromKey, range.toKey)
}

/**
 * The range of `kind` containing `anchorKey`.
 *
 * Weeks are the **trailing seven days** rather than Monday-to-Sunday, because
 * that is what the rest of the app already means by "this week" and two
 * different weeks in one product is a bug people report as bad data. Months,
 * quarters and years are calendar periods, which is what those words mean
 * everywhere.
 */
export function rangeFor(kind: RangeKind, anchorKey: string): DayRange {
  const anchor = parseYmdLocal(anchorKey)
  switch (kind) {
    case 'day':
      return { kind, fromKey: anchorKey, toKey: anchorKey }
    case 'week': {
      const from = new Date(anchor)
      from.setDate(from.getDate() - 6)
      return { kind, fromKey: formatYmdLocal(from), toKey: anchorKey }
    }
    case 'month': {
      const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
      const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
      return { kind, fromKey: formatYmdLocal(from), toKey: formatYmdLocal(to) }
    }
    case 'quarter': {
      const first = Math.floor(anchor.getMonth() / 3) * 3
      const from = new Date(anchor.getFullYear(), first, 1)
      const to = new Date(anchor.getFullYear(), first + 3, 0)
      return { kind, fromKey: formatYmdLocal(from), toKey: formatYmdLocal(to) }
    }
    case 'year': {
      const from = new Date(anchor.getFullYear(), 0, 1)
      const to = new Date(anchor.getFullYear(), 11, 31)
      return { kind, fromKey: formatYmdLocal(from), toKey: formatYmdLocal(to) }
    }
    default:
      return { kind: 'custom', fromKey: anchorKey, toKey: anchorKey }
  }
}

/**
 * Step a range one period back or forward.
 *
 * A custom range keeps its own length and slides by it, which is the only
 * behaviour that makes "previous" mean anything for a span somebody chose.
 */
export function shiftRange(range: DayRange, direction: -1 | 1): DayRange {
  if (range.kind === 'custom' || range.kind === 'week' || range.kind === 'day') {
    const days = rangeLength(range) * direction
    const from = parseYmdLocal(range.fromKey)
    const to = parseYmdLocal(range.toKey)
    from.setDate(from.getDate() + days)
    to.setDate(to.getDate() + days)
    return { ...range, fromKey: formatYmdLocal(from), toKey: formatYmdLocal(to) }
  }
  const anchor = parseYmdLocal(range.fromKey)
  const months = range.kind === 'month' ? 1 : range.kind === 'quarter' ? 3 : 12
  anchor.setMonth(anchor.getMonth() + months * direction)
  return rangeFor(range.kind, formatYmdLocal(anchor))
}

/** Whether `key` sits inside the range, inclusive. */
export function rangeContains(range: DayRange, key: string): boolean {
  return key >= range.fromKey && key <= range.toKey
}

/**
 * Clamp a hand-typed custom range into something that can be asked for.
 *
 * Reversed dates are swapped rather than refused — somebody typing the end
 * first is not making a mistake worth an error message — and the span is capped
 * so a slipped keystroke in the year field cannot ask the store for four
 * thousand days.
 */
export const MAX_RANGE_DAYS = 732

export function normalizeCustom(fromKey: string, toKey: string): DayRange {
  const [a, b] = fromKey <= toKey ? [fromKey, toKey] : [toKey, fromKey]
  const from = parseYmdLocal(a)
  const to = parseYmdLocal(b)
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
  if (days > MAX_RANGE_DAYS) {
    const capped = new Date(from)
    capped.setDate(capped.getDate() + MAX_RANGE_DAYS - 1)
    return { kind: 'custom', fromKey: a, toKey: formatYmdLocal(capped) }
  }
  return { kind: 'custom', fromKey: a, toKey: b }
}

const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const SHORT_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const SHORT_YEAR_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** What the range is called on screen. */
export function rangeLabel(range: DayRange): string {
  const from = parseYmdLocal(range.fromKey)
  const to = parseYmdLocal(range.toKey)
  if (range.kind === 'day') return SHORT_YEAR_FMT.format(from)
  if (range.kind === 'month') return MONTH_FMT.format(from)
  if (range.kind === 'quarter') {
    return `Q${Math.floor(from.getMonth() / 3) + 1} ${from.getFullYear()}`
  }
  if (range.kind === 'year') return String(from.getFullYear())
  const sameYear = from.getFullYear() === to.getFullYear()
  return `${SHORT_FMT.format(from)} – ${sameYear ? SHORT_FMT.format(to) : SHORT_YEAR_FMT.format(to)}${
    sameYear ? ` ${to.getFullYear()}` : ''
  }`
}

/**
 * The weeks of a month, as a calendar grid of day keys.
 *
 * Leading and trailing cells are `null` rather than the neighbouring month's
 * days: a heat grid that quietly shows five days of March under the heading
 * "April" is a grid people mis-read once and stop trusting.
 */
export function monthGrid(range: DayRange, weekStartsOn = 0): Array<Array<string | null>> {
  const from = parseYmdLocal(range.fromKey)
  const to = parseYmdLocal(range.toKey)
  const cells: Array<string | null> = []
  const lead = (from.getDay() - weekStartsOn + 7) % 7
  for (let i = 0; i < lead; i += 1) cells.push(null)
  for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    cells.push(formatYmdLocal(d))
  }
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}
