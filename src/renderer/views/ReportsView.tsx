import { useEffect, useMemo, useRef, useState } from 'react'

import { summarizeDay, summarizeWeek, type DaySummary } from '../../core/aggregate'
import { dayKey, dayStartTs, parseYmdLocal } from '../../core/day'
import {
  monthGrid,
  normalizeCustom,
  rangeFor,
  rangeKeys,
  rangeLabel,
  rangeLength,
  shiftRange,
  type DayRange,
  type RangeKind,
} from '../../core/range'
import { Breakdown, Stat, WeekChart } from '../components/Charts'
import { Empty } from '../components/Empty'
import {
  IconChevronLeft,
  IconChevronRight,
  IconEmptyTimeline,
  IconRange,
} from '../components/Icons'
import { RefreshButton } from '../components/RefreshButton'
import { duration, longDate, percent, weekdayShort } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'
import type { DayPayload } from '../../shared/ipc'

/**
 * The ranges the control offers.
 *
 * All of them are built. The previous pass shipped Month and Year as disabled
 * buttons so the gap was visible rather than pretended away; now the gap is
 * closed, and a disabled button would be the pretence.
 */
const KINDS: Array<{ id: RangeKind; label: string }> = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'year', label: 'Year' },
  { id: 'custom', label: 'Custom' },
]

/** Above this many days, a column per day is a picket fence — use the heat grid. */
const CHART_MAX_DAYS = 45

export function ReportsView({
  app,
  initialRange,
  onOpenDay,
}: {
  app: OpenTimeState
  initialRange?: RangeKind
  onOpenDay(): void
}) {
  const settings = app.settings
  const today = useMemo(
    () => dayKey(Date.now(), settings?.dayStartHour ?? 4),
    [settings?.dayStartHour]
  )
  const [range, setRange] = useState<DayRange>(() => rangeFor(initialRange || 'week', today))
  const [payloads, setPayloads] = useState<DayPayload[] | null>(null)
  const requestId = useRef(0)

  // A range change is an async read of up to two years of day files. The
  // request id is what stops a slow year landing on top of a fast week the
  // user asked for afterwards.
  useEffect(() => {
    const id = (requestId.current += 1)
    let cancelled = false
    setPayloads(null)
    void app.loadRange(rangeKeys(range)).then((result) => {
      if (cancelled || id !== requestId.current) return
      setPayloads(result)
    })
    return () => {
      cancelled = true
    }
  }, [app, range])

  const days = useMemo<DaySummary[]>(
    () => (payloads || []).map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events)),
    [payloads]
  )
  const totals = useMemo(() => summarizeWeek(days), [days])

  if (!settings) return null

  const activeDays = days.filter((d) => d.totalSeconds).length
  const productiveShare = totals.totalSeconds ? totals.productiveSeconds / totals.totalSeconds : 0
  // Averaged over days that *have* something, not over the calendar: a month
  // whose average is dragged down by twelve untracked weekend days is telling
  // you about the calendar rather than about the work.
  const dailyAverage = activeDays ? Math.round(totals.totalSeconds / activeDays) : 0
  const loading = payloads === null
  const length = rangeLength(range)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            {rangeLabel(range)} — {duration(totals.totalSeconds)} tracked over {activeDays} active
            day{activeDays === 1 ? '' : 's'}
          </p>
        </div>
        <RefreshButton onRefresh={() => void app.refresh()} />
      </div>

      <div className="range-bar">
        <div className="seg">
          {KINDS.map((kind) => (
            <button
              key={kind.id}
              className={range.kind === kind.id ? 'on' : ''}
              onClick={() =>
                setRange(
                  kind.id === 'custom'
                    ? { ...rangeFor('month', today), kind: 'custom' }
                    : rangeFor(kind.id, today)
                )
              }
            >
              {kind.label}
            </button>
          ))}
        </div>

        {range.kind === 'custom' ? (
          <div className="range-custom">
            <IconRange size={15} />
            <input
              type="date"
              className="input"
              value={range.fromKey}
              max={range.toKey}
              onChange={(e) =>
                e.target.value && setRange(normalizeCustom(e.target.value, range.toKey))
              }
              aria-label="Range start"
            />
            <span className="range-dash">→</span>
            <input
              type="date"
              className="input"
              value={range.toKey}
              onChange={(e) =>
                e.target.value && setRange(normalizeCustom(range.fromKey, e.target.value))
              }
              aria-label="Range end"
            />
          </div>
        ) : (
          <div className="range-step">
            <button
              className="icon-btn"
              title="Previous period"
              onClick={() => setRange(shiftRange(range, -1))}
            >
              <IconChevronLeft size={15} />
            </button>
            <span className="range-current">{rangeLabel(range)}</span>
            <button
              className="icon-btn"
              title="Next period"
              disabled={range.toKey >= today}
              onClick={() => setRange(shiftRange(range, 1))}
            >
              <IconChevronRight size={15} />
            </button>
          </div>
        )}

        <span className="range-count">
          {length} day{length === 1 ? '' : 's'}
        </span>
      </div>

      {loading ? (
        <div className="card range-loading">
          <Empty title="Reading those days…" hint="Day files are read on demand, not held open." />
        </div>
      ) : !totals.totalSeconds ? (
        <div className="card range-loading">
          <Empty
            glyph={<IconEmptyTimeline />}
            title="Nothing tracked in this range"
            hint="Pick another period, or widen the range — days with no activity are simply absent, not hidden."
          />
        </div>
      ) : (
        <div className="grid" style={{ gap: 14 }}>
          <div className="grid cols-4">
            <Stat
              label="Total tracked"
              value={duration(totals.totalSeconds)}
              foot={`${duration(dailyAverage)} / active day`}
            />
            <Stat
              label="Focus time"
              value={duration(totals.productiveSeconds)}
              foot={`${percent(productiveShare)} of tracked time`}
              meter={productiveShare}
              color="var(--productive)"
            />
            <Stat
              label="Distraction"
              value={duration(totals.distractingSeconds)}
              foot={
                totals.totalSeconds
                  ? `${percent(totals.distractingSeconds / totals.totalSeconds)} of tracked time`
                  : 'Nothing yet'
              }
              /* The same tile on the dashboard draws its share; this one did
                 not, so the identical card read differently in the two places
                 it appears. */
              meter={totals.totalSeconds ? totals.distractingSeconds / totals.totalSeconds : 0}
              color="var(--distracting)"
            />
            <Stat
              label="Average focus score"
              value={String(totals.averageFocusScore)}
              foot={
                totals.bestDay
                  ? `Best: ${longDate(dayStartTs(totals.bestDay.dayKey, settings.dayStartHour))} (${totals.bestDay.focusScore})`
                  : 'No scored days yet'
              }
              meter={totals.averageFocusScore / 100}
              color="var(--accent)"
            />
          </div>

          <div className="card">
            <h2 className="card-title">
              {length <= CHART_MAX_DAYS ? 'Daily breakdown' : 'Every day in range'}
              <span className="hint">Click a day to open it on the calendar</span>
            </h2>
            {length <= CHART_MAX_DAYS ? (
              <WeekChart
                days={days}
                selected={app.selectedDay}
                dayStartHour={settings.dayStartHour}
                compact={length > 10}
                onSelect={(key) => {
                  app.selectDay(key)
                  onOpenDay()
                }}
              />
            ) : (
              <HeatGrid
                days={days}
                selected={app.selectedDay}
                onSelect={(key) => {
                  app.selectDay(key)
                  onOpenDay()
                }}
              />
            )}
          </div>

          <div className="grid cols-2">
            <div className="card">
              <h2 className="card-title">
                Where the time went
                <span className="hint">{rangeLabel(range)}</span>
              </h2>
              <Breakdown buckets={totals.byCategory} projects={app.projects} limit={10} />
            </div>

            <div className="card">
              <h2 className="card-title">
                Day by day
                <span className="hint">Focus score</span>
              </h2>
              {/* Newest first once the range is longer than a week: on a year,
                  scrolling to January to find last Tuesday is absurd. */}
              <div className="day-list">
                {(length > 7 ? [...days].reverse() : days)
                  .filter((d) => d.totalSeconds)
                  .slice(0, 60)
                  .map((d) => (
                    <div
                      className={`bar-row clickable${d.dayKey === app.selectedDay ? ' on' : ''}`}
                      key={d.dayKey}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        app.selectDay(d.dayKey)
                        onOpenDay()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          app.selectDay(d.dayKey)
                          onOpenDay()
                        }
                      }}
                    >
                      <div>
                        <div className="bar-name">
                          <i
                            className="bar-swatch"
                            style={{
                              background:
                                d.focusScore >= 60
                                  ? 'var(--productive)'
                                  : d.focusScore >= 30
                                    ? 'var(--accent)'
                                    : 'var(--neutral)',
                            }}
                          />
                          <span>{longDate(dayStartTs(d.dayKey, settings.dayStartHour))}</span>
                        </div>
                        <div className="bar-track">
                          <i style={{ width: `${d.focusScore}%`, background: 'var(--accent)' }} />
                        </div>
                      </div>
                      <div className="bar-value">
                        {duration(d.totalSeconds)}
                        <small>focus {d.focusScore}</small>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {range.kind === 'month' ? (
            <div className="card">
              <h2 className="card-title">
                {rangeLabel(range)}
                <span className="hint">Shade is tracked time</span>
              </h2>
              <MonthCalendar
                range={range}
                days={days}
                selected={app.selectedDay}
                onSelect={(key) => {
                  app.selectDay(key)
                  onOpenDay()
                }}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  )
}

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
 * weekday reads as a row — which is the pattern anyone scanning a year is
 * actually looking for.
 */
function HeatGrid({
  days,
  selected,
  onSelect,
}: {
  days: DaySummary[]
  selected: string
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
        {days.map((d, index) => (
          <button
            key={d.dayKey}
            className={`heat-cell${d.dayKey === selected ? ' on' : ''}${
              d.totalSeconds ? '' : ' empty'
            }`}
            style={
              {
                '--heat': (d.totalSeconds / max).toFixed(3),
                // Only the first cell needs placing; the rest flow down the
                // column and wrap to the next week on their own.
                ...(index === 0 ? { gridRow: parseYmdLocal(d.dayKey).getDay() + 1 } : {}),
              } as React.CSSProperties
            }
            onClick={() => onSelect(d.dayKey)}
            title={`${d.dayKey} — ${duration(d.totalSeconds)} tracked, focus ${d.focusScore}`}
          />
        ))}
      </div>
    </div>
  )
}

/** The month as a real calendar, which is how people hold a month in their head. */
function MonthCalendar({
  range,
  days,
  selected,
  onSelect,
}: {
  range: DayRange
  days: DaySummary[]
  selected: string
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
                className={`month-day${key === selected ? ' on' : ''}`}
                style={
                  { '--heat': ((byKey.get(key)?.totalSeconds || 0) / max).toFixed(3) } as React.CSSProperties
                }
                onClick={() => onSelect(key)}
                title={`${key} — ${duration(byKey.get(key)?.totalSeconds || 0)} tracked`}
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
