/**
 * The two whole-period layouts: a month as a real calendar, and a year as a
 * cell per day. Shared by the Calendar's Month and Year views and by Reports,
 * so the same period looks the same wherever it is opened.
 */

import { useMemo } from 'react'

import type { DaySummary } from '../../core/aggregate'
import { parseYmdLocal } from '../../core/day'
import { monthGrid, type DayRange } from '../../core/range'
import { duration, weekdayShort } from '../lib/format'

/** Shared scale for both grids: a day's share of the busiest day in range. */
function useHeat(days: DaySummary[]) {
  return useMemo(() => {
    const byKey = new Map(days.map((d) => [d.dayKey, d]))
    const max = Math.max(1, ...days.map((d) => d.totalSeconds))
    return { byKey, max }
  }, [days])
}

/**
 * A cell per day laid out in week columns, for ranges too long for a column
 * chart.
 *
 * Deliberately not a column chart with 365 one-pixel bars: at that width the
 * chart cannot be read *or* clicked. Weeks run down the columns rather than
 * across the rows so a year is seven rows tall instead of fifty-two, and so a
 * weekday reads as a row - which is the pattern anyone scanning a year is
 * actually looking for.
 */
export function HeatGrid({
  days,
  selected,
  todayKey,
  onSelect,
}: {
  days: DaySummary[]
  selected: string
  /** Days after this have not happened yet: drawn dimmed, and not clickable. */
  todayKey?: string
  onSelect(key: string): void
}) {
  const { max } = useHeat(days)
  const months = useMemo(() => {
    // One label per month, placed on the column its first day falls in.
    const out: Array<{ label: string; column: number }> = []
    let lead = 0
    days.forEach((d, index) => {
      const date = parseYmdLocal(d.dayKey)
      if (index === 0) lead = date.getDay()
      if (date.getDate() !== 1 && index !== 0) return
      out.push({
        label: date.toLocaleDateString(undefined, { month: 'short' }),
        column: Math.floor((index + lead) / 7) + 1,
      })
    })
    return out
  }, [days])

  return (
    <div className="heat-wrap">
      <div className="heat-months">
        {months.map((m) => (
          <span key={`${m.label}-${m.column}`} style={{ gridColumn: m.column }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heat-grid">
        {days.map((d, index) => {
          const future = !!todayKey && d.dayKey > todayKey
          return (
          <button
            key={d.dayKey}
            className={`heat-cell${d.dayKey === selected ? ' on' : ''}${
              d.totalSeconds ? '' : ' empty'
            }${future ? ' future' : ''}`}
            disabled={future}
            style={
              {
                '--heat': (d.totalSeconds / max).toFixed(3),
                // Only the first cell needs placing; the rest flow down the
                // column and wrap to the next week on their own.
                ...(index === 0 ? { gridRow: parseYmdLocal(d.dayKey).getDay() + 1 } : {}),
              } as React.CSSProperties
            }
            onClick={() => onSelect(d.dayKey)}
            title={future ? `${d.dayKey}, still to come` : `${d.dayKey}: ${duration(d.totalSeconds)} tracked, focus ${d.focusScore}`}
          />
          )
        })}
      </div>
    </div>
  )
}

/** The month as a real calendar, which is how people hold a month in their head. */
export function MonthCalendar({
  range,
  days,
  selected,
  todayKey,
  onSelect,
}: {
  range: DayRange
  days: DaySummary[]
  selected: string
  /** Days after this have not happened yet: drawn dimmed, and not clickable. */
  todayKey?: string
  onSelect(key: string): void
}) {
  const { byKey, max } = useHeat(days)
  const weeks = useMemo(() => monthGrid(range), [range])
  const headings = useMemo(() => {
    // Derived from the first week of the grid rather than hard-coded, so the
    // column headings cannot disagree with the cells under them.
    const first = weeks[0] || []
    return first.map((key, index) => {
      if (key) return weekdayShort(parseYmdLocal(key).getTime())
      // Leading blanks: walk back from the first real day in the row.
      const anchor = first.find((k): k is string => !!k)
      if (!anchor) return ''
      const d = parseYmdLocal(anchor)
      d.setDate(d.getDate() - (first.indexOf(anchor) - index))
      return weekdayShort(d.getTime())
    })
  }, [weeks])

  return (
    <div className="month-cal">
      <div className="month-head">
        {headings.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
      {weeks.map((week, i) => (
        <div className="month-week" key={i}>
          {week.map((key, j) =>
            key ? (
              <button
                key={key}
                className={`month-day${key === selected ? ' on' : ''}${
                  todayKey && key > todayKey ? ' future' : ''
                }`}
                disabled={!!todayKey && key > todayKey}
                style={
                  { '--heat': ((byKey.get(key)?.totalSeconds || 0) / max).toFixed(3) } as React.CSSProperties
                }
                onClick={() => onSelect(key)}
                title={
                  todayKey && key > todayKey
                    ? `${key}, still to come`
                    : `${key}: ${duration(byKey.get(key)?.totalSeconds || 0)} tracked`
                }
              >
                <span className="month-daynum">{parseYmdLocal(key).getDate()}</span>
                <span className="month-daytime">
                  {byKey.get(key)?.totalSeconds ? duration(byKey.get(key)!.totalSeconds) : ''}
                </span>
              </button>
            ) : (
              <span className="month-day blank" key={`b${j}`} />
            )
          )}
        </div>
      ))}
    </div>
  )
}
