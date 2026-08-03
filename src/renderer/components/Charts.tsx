import { memo, useMemo } from 'react'

import type { Bucket, DaySummary } from '../../core/aggregate'
import type { Project } from '../../core/types'
import { duration, percent, productivityColor, weekdayShort } from '../lib/format'
import { dayStartTs } from '../../core/day'

/** Stat tile: one headline number with a supporting line and optional meter. */
export const Stat = memo(function Stat({
  label,
  value,
  foot,
  meter,
  color = 'var(--accent)',
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
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>
        {value}
      </div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
      {meter !== undefined ? (
        <div className="meter">
          <i style={{ width: `${Math.min(1, Math.max(0, meter)) * 100}%`, background: color }} />
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
  emptyLabel = 'Nothing tracked yet.',
}: {
  buckets: Bucket[]
  projects: Project[]
  limit?: number
  emptyLabel?: string
}) {
  const rows = useMemo(() => buckets.slice(0, limit), [buckets, limit])
  const colorFor = useMemo(() => {
    const byName = new Map(projects.map((p) => [p.name, p.color]))
    return (b: Bucket) => byName.get(b.key) || productivityColor(b.productivity)
  }, [projects])

  if (!rows.length) return <div className="empty">{emptyLabel}</div>

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
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{percent(b.share)}</div>
          </div>
        </div>
      ))}
    </div>
  )
})

/** Focus-score ring with a productive/neutral/distracting legend. */
export const FocusRing = memo(function FocusRing({ summary }: { summary: DaySummary }) {
  const size = 148
  const stroke = 12
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const total = summary.totalSeconds || 1

  const arcs = useMemo(() => {
    const parts = [
      { key: 'Productive', seconds: summary.productiveSeconds, color: 'var(--productive)' },
      { key: 'Neutral', seconds: summary.neutralSeconds, color: 'var(--neutral)' },
      { key: 'Distracting', seconds: summary.distractingSeconds, color: 'var(--distracting)' },
    ]
    let offset = 0
    return parts.map((p) => {
      const share = p.seconds / total
      const arc = { ...p, share, dash: share * circumference, offset: -offset * circumference }
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
            <i
              style={{ width: 8, height: 8, borderRadius: 2, background: a.color, flex: '0 0 8px' }}
            />
            {a.key}
            <b>{duration(a.seconds)}</b>
          </div>
        ))}
        <div className="legend-row">
          <i
            style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--idle)', flex: '0 0 8px' }}
          />
          Away
          <b>{duration(summary.idleSeconds)}</b>
        </div>
      </div>
    </div>
  )
})

/** Stacked weekly bars; clicking a column selects that day. */
export const WeekChart = memo(function WeekChart({
  days,
  selected,
  dayStartHour,
  onSelect,
}: {
  days: DaySummary[]
  selected: string
  dayStartHour: number
  onSelect(key: string): void
}) {
  const max = useMemo(
    () => Math.max(1, ...days.map((d) => d.totalSeconds + d.idleSeconds)),
    [days]
  )

  return (
    <div className="week">
      {days.map((d) => {
        const stackHeight = ((d.totalSeconds + d.idleSeconds) / max) * 100
        const segments = [
          { key: 'p', seconds: d.productiveSeconds, color: 'var(--productive)' },
          { key: 'n', seconds: d.neutralSeconds, color: 'var(--neutral)' },
          { key: 'd', seconds: d.distractingSeconds, color: 'var(--distracting)' },
          { key: 'i', seconds: d.idleSeconds, color: 'var(--idle)' },
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
              if (e.key === 'Enter' || e.key === ' ') onSelect(d.dayKey)
            }}
            title={`${d.dayKey} — ${duration(d.totalSeconds)} tracked, focus ${d.focusScore}`}
          >
            <div className="week-stack" style={{ height: `${Math.max(2, stackHeight)}%` }}>
              {segments.map((s) =>
                s.seconds > 0 ? (
                  <div
                    key={s.key}
                    className="week-seg"
                    style={{ height: `${(s.seconds / stackTotal) * 100}%`, background: s.color }}
                  />
                ) : null
              )}
            </div>
            <div className="week-foot">
              <b>{d.totalSeconds ? duration(d.totalSeconds) : '—'}</b>
              {weekdayShort(dayStartTs(d.dayKey, dayStartHour))}
            </div>
          </div>
        )
      })}
    </div>
  )
})
