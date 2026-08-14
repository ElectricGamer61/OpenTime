import { memo, useMemo } from 'react'

import type { Bucket, DaySummary } from '../../core/aggregate'
import type { Project } from '../../core/types'
import { duration, longDate, percent, productivityColor, weekdayShort } from '../lib/format'
import { dayStartTs } from '../../core/day'
import { Empty } from './Empty'

/**
 * Bar fills in the weekly stack.
 *
 * The productivity tokens are tuned to be read as an 8px swatch; at a couple of
 * hundred pixels of solid area they overwhelm everything else on the page,
 * which is the opposite of what a weekly overview is for. `color-mix` pulls
 * each one most of the way towards the card surface, so the bar keeps the hue
 * that identifies it and loses the shout — and because the mix target is a
 * theme token, the same declaration works in light and dark.
 */
const STACK_FILLS: Record<string, string> = {
  productive: 'color-mix(in srgb, var(--productive) 62%, var(--surface))',
  neutral: 'color-mix(in srgb, var(--neutral) 46%, var(--surface))',
  distracting: 'color-mix(in srgb, var(--distracting) 58%, var(--surface))',
  // Away time caps every column, so it has to read as absence rather than as a
  // solid box sitting on top of the day.
  idle: 'var(--idle)',
}

/**
 * Stat tile: one headline number with a supporting line and optional meter.
 *
 * The number itself is always ink. A row of headline figures set in saturated
 * green and red reads as a row of alerts — the colour ends up ranking nothing
 * because everything has some. The tile's colour lives in a 7px dot beside the
 * label and in the meter, which is enough to tie it to the timeline and the
 * legend without turning the dashboard into a traffic light.
 */
export const Stat = memo(function Stat({
  label,
  value,
  foot,
  meter,
  color,
}: {
  label: string
  value: string
  foot?: string
  /** 0–1 */
  meter?: number
  color?: string
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {color ? <i className="stat-dot" style={{ background: color }} /> : null}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
      {meter !== undefined ? (
        <div className="meter">
          <i
            style={{
              width: `${Math.min(1, Math.max(0, meter)) * 100}%`,
              background: color || 'var(--accent)',
            }}
          />
        </div>
      ) : null}
    </div>
  )
})

/** Horizontal breakdown list — the app/category view. */
export const Breakdown = memo(function Breakdown({
  buckets,
  projects,
  limit = 8,
  palette,
  emptyLabel = 'Nothing tracked yet.',
}: {
  buckets: Bucket[]
  projects: Project[]
  limit?: number
  /**
   * Name → colour, when the rows should be told apart by *identity* rather
   * than by productivity. The applications list needs this: every app a person
   * works in is productive, so colouring by productivity paints ten identical
   * green bars and the colour stops carrying anything.
   */
  palette?: Map<string, string>
  emptyLabel?: string
}) {
  const rows = useMemo(() => buckets.slice(0, limit), [buckets, limit])
  // Truncation must say so: a list that quietly stops reads as "that was
  // everything", which for a time tracker is a wrong answer.
  const rest = useMemo(() => {
    const hidden = buckets.slice(limit)
    return { count: hidden.length, seconds: hidden.reduce((sum, b) => sum + b.seconds, 0) }
  }, [buckets, limit])
  const colorFor = useMemo(() => {
    const byName = new Map(projects.map((p) => [p.name, p.color]))
    return (b: Bucket) =>
      palette?.get(b.key) || byName.get(b.key) || productivityColor(b.productivity)
  }, [projects, palette])

  if (!rows.length) return <Empty title={emptyLabel} />

  return (
    <div>
      {rows.map((b) => (
        <div className="bar-row" key={b.key}>
          <div>
            <div className="bar-name">
              <i className="bar-swatch" style={{ background: colorFor(b) }} />
              <span>{b.label}</span>
            </div>
            <div className="bar-track">
              <i style={{ width: `${b.share * 100}%`, background: colorFor(b) }} />
            </div>
          </div>
          <div className="bar-value">
            {duration(b.seconds)}
            <small>{percent(b.share)}</small>
          </div>
        </div>
      ))}
      {rest.count > 0 ? (
        <div className="bar-more">
          + {rest.count} more · {duration(rest.seconds)}
        </div>
      ) : null}
    </div>
  )
})

/** Focus-score ring with a productive/neutral/distracting legend. */
export const FocusRing = memo(function FocusRing({ summary }: { summary: DaySummary }) {
  const size = 152
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const total = summary.totalSeconds || 1
  /** Hairline of track showing between arcs, so the segments read as parts. */
  const GAP = 2.5

  const arcs = useMemo(() => {
    const parts = [
      { key: 'Productive', seconds: summary.productiveSeconds, color: 'var(--productive)' },
      { key: 'Neutral', seconds: summary.neutralSeconds, color: 'var(--neutral)' },
      { key: 'Distracting', seconds: summary.distractingSeconds, color: 'var(--distracting)' },
    ]
    let offset = 0
    return parts.map((p) => {
      const share = p.seconds / total
      const length = share * circumference
      const arc = {
        ...p,
        share,
        // Never let the gap eat the whole segment — a sliver still has to be
        // visible, so short arcs simply lose their gap instead.
        dash: Math.max(0.5, length - (length > GAP * 2 ? GAP : 0)),
        offset: -offset * circumference,
      }
      offset += share
      return arc
    })
  }, [summary, total, circumference])

  return (
    <div className="ring-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Focus score">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-3)"
            strokeWidth={stroke}
          />
          {arcs.map((a) =>
            a.share > 0.001 ? (
              <circle
                key={a.key}
                className="ring-arc"
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={a.color}
                strokeWidth={stroke}
                strokeLinecap="butt"
                strokeDasharray={`${a.dash} ${circumference - a.dash}`}
                strokeDashoffset={a.offset}
              />
            ) : null
          )}
        </g>
        <text x="50%" y="48%" textAnchor="middle" className="ring-center">
          {summary.focusScore}
        </text>
        <text x="50%" y="62%" textAnchor="middle" className="ring-caption">
          Focus score
        </text>
      </svg>
      <div className="legend">
        {arcs.map((a) => (
          <div className="legend-row" key={a.key}>
            <i style={{ background: a.color }} />
            {a.key}
            <b>{duration(a.seconds)}</b>
          </div>
        ))}
        <div className="legend-row">
          <i style={{ background: 'var(--surface-4)' }} />
          Away
          <b>{duration(summary.idleSeconds)}</b>
        </div>
      </div>
    </div>
  )
})

export interface Slice {
  key: string
  label: string
  seconds: number
  color: string
}

/**
 * Donut with a legend beside it.
 *
 * Unlike `FocusRing` this takes arbitrary slices, because the summary panel
 * switches between categories, projects and apps — a fixed three-arc ring
 * cannot express any of those. Slices past `limit` are folded into one "Other"
 * arc rather than drawn as unreadable slivers.
 */
export const Donut = memo(function Donut({
  slices,
  limit = 5,
  emptyLabel = 'Nothing tracked yet.',
}: {
  slices: Slice[]
  limit?: number
  emptyLabel?: string
}) {
  const size = 112
  const stroke = 12
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const GAP = 3

  const { rows, total } = useMemo(() => {
    const sorted = [...slices].filter((s) => s.seconds > 0).sort((a, b) => b.seconds - a.seconds)
    const head = sorted.slice(0, limit)
    const tail = sorted.slice(limit)
    if (tail.length) {
      head.push({
        key: '__other',
        label: `${tail.length} more`,
        seconds: tail.reduce((sum, s) => sum + s.seconds, 0),
        color: 'var(--surface-4)',
      })
    }
    return { rows: head, total: head.reduce((sum, s) => sum + s.seconds, 0) }
  }, [slices, limit])

  const arcs = useMemo(() => {
    let offset = 0
    return rows.map((row) => {
      const share = total > 0 ? row.seconds / total : 0
      const length = share * circumference
      const arc = {
        ...row,
        share,
        // A sliver still has to be visible, so short arcs lose their gap
        // rather than being eaten by it.
        dash: Math.max(0.5, length - (length > GAP * 2 ? GAP : 0)),
        offset: -offset * circumference,
      }
      offset += share
      return arc
    })
  }, [rows, total, circumference])

  if (!rows.length) return <Empty title={emptyLabel} />

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Breakdown">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-3)"
            strokeWidth={stroke}
          />
          {arcs.map((a) =>
            a.share > 0.001 ? (
              <circle
                key={a.key}
                className="ring-arc"
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={a.color}
                strokeWidth={stroke}
                strokeLinecap="butt"
                strokeDasharray={`${a.dash} ${circumference - a.dash}`}
                strokeDashoffset={a.offset}
              />
            ) : null
          )}
        </g>
        <text x="50%" y="49%" textAnchor="middle" className="donut-center">
          {duration(total)}
        </text>
        <text x="50%" y="63%" textAnchor="middle" className="ring-caption">
          tracked
        </text>
      </svg>
      <div className="donut-legend">
        {arcs.map((a) => (
          <div className="legend-row" key={a.key}>
            <i style={{ background: a.color }} />
            <span className="legend-name" title={a.label}>
              {a.label}
            </span>
            <b>{duration(a.seconds)}</b>
          </div>
        ))}
      </div>
    </div>
  )
})

/** One horizontal stacked bar with a legend under it. */
export const StackedBar = memo(function StackedBar({ slices }: { slices: Slice[] }) {
  const rows = useMemo(() => slices.filter((s) => s.seconds > 0), [slices])
  const total = useMemo(() => rows.reduce((sum, s) => sum + s.seconds, 0), [rows])

  if (!total) return <Empty title="Nothing tracked yet." />

  return (
    <div className="stacked">
      <div className="stacked-bar">
        {rows.map((row) => (
          <i
            key={row.key}
            style={{ width: `${(row.seconds / total) * 100}%`, background: row.color }}
            title={`${row.label} · ${duration(row.seconds)}`}
          />
        ))}
      </div>
      <div className="stacked-legend">
        {rows.map((row) => (
          <div className="legend-row" key={row.key}>
            <i style={{ background: row.color }} />
            <span className="legend-name">{row.label}</span>
            <b>{duration(row.seconds)}</b>
          </div>
        ))}
      </div>
    </div>
  )
})

/** Stacked weekly bars; clicking a column selects that day. */
export const WeekChart = memo(function WeekChart({
  days,
  selected,
  dayStartHour,
  compact = false,
  onSelect,
}: {
  days: DaySummary[]
  selected: string
  dayStartHour: number
  /** Narrow columns and a date-only foot, for a month rather than a week. */
  compact?: boolean
  onSelect(key: string): void
}) {
  const max = useMemo(
    () => Math.max(1, ...days.map((d) => d.totalSeconds + d.idleSeconds)),
    [days]
  )

  return (
    <div className={`week${compact ? ' compact' : ''}`}>
      {days.map((d) => {
        const stackHeight = ((d.totalSeconds + d.idleSeconds) / max) * 100
        const segments = [
          { key: 'p', seconds: d.productiveSeconds, fill: STACK_FILLS.productive },
          { key: 'n', seconds: d.neutralSeconds, fill: STACK_FILLS.neutral },
          { key: 'd', seconds: d.distractingSeconds, fill: STACK_FILLS.distracting },
          { key: 'i', seconds: d.idleSeconds, fill: STACK_FILLS.idle },
        ]
        const stackTotal = Math.max(1, d.totalSeconds + d.idleSeconds)
        return (
          <div
            key={d.dayKey}
            className={`week-col${d.dayKey === selected ? ' active' : ''}`}
            onClick={() => onSelect(d.dayKey)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault() // Space must activate, not scroll the page.
              onSelect(d.dayKey)
            }}
            title={`${longDate(dayStartTs(d.dayKey, dayStartHour))} — ${duration(d.totalSeconds)} tracked, focus ${d.focusScore}`}
          >
            <div className="week-stack" style={{ height: `${Math.max(2, stackHeight)}%` }}>
              {segments.map((s) =>
                s.seconds > 0 ? (
                  <div
                    key={s.key}
                    className="week-seg"
                    style={{ height: `${(s.seconds / stackTotal) * 100}%`, background: s.fill }}
                  />
                ) : null
              )}
            </div>
            <div className="week-foot">
              {compact ? (
                // A month of "7h 26m" labels is a wall of numbers nobody
                // reads; the date is the only thing that identifies the column.
                <b>{Number(d.dayKey.slice(-2))}</b>
              ) : (
                <>
                  <b>{d.totalSeconds ? duration(d.totalSeconds) : '—'}</b>
                  {weekdayShort(dayStartTs(d.dayKey, dayStartHour))}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
})
