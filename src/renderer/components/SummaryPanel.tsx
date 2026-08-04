import { memo, useMemo } from 'react'

import type { DaySummary } from '../../core/aggregate'
import { dayElapsedShare, evaluateGoal } from '../../core/goals'
import type { Goal } from '../../core/types'
import type { GroupMode } from '../lib/entries'
import { duration, percent } from '../lib/format'
import type { Slice } from './Charts'
import { Donut, StackedBar } from './Charts'
import { IconChevronRight, IconSettings } from './Icons'

const MODES: Array<{ id: GroupMode; label: string }> = [
  { id: 'category', label: 'Categories' },
  { id: 'project', label: 'Projects' },
  { id: 'app', label: 'Apps' },
]

export interface SummaryPanelProps {
  summary: DaySummary
  /** Yesterday, for the work-hours delta. Null on the earliest day held. */
  previous: DaySummary | null
  /** The trailing week, for the focus-time baseline. */
  week: DaySummary[]
  goals: Goal[]
  dayStart: number
  isToday: boolean
  mode: GroupMode
  slices: Slice[]
  onMode(mode: GroupMode): void
  onCustomize(): void
}

/**
 * The day's numbers, read top to bottom: how long you worked, against what you
 * said you wanted, what it went into, and how it was spent.
 *
 * Every figure here is derived from the same `DaySummary` the rest of the app
 * uses. Where the conventional version of this panel shows a money figure, this
 * one shows nothing: OpenTime has no rates and no clients, and inventing either
 * would make the whole column untrustworthy.
 */
export const SummaryPanel = memo(function SummaryPanel({
  summary,
  previous,
  week,
  goals,
  dayStart,
  isToday,
  mode,
  slices,
  onMode,
  onCustomize,
}: SummaryPanelProps) {
  const delta = useMemo(() => {
    if (!previous || !previous.totalSeconds) return null
    return (summary.totalSeconds - previous.totalSeconds) / previous.totalSeconds
  }, [summary, previous])

  // The first enabled daily goal is the only honest source of a target. With
  // none switched on there is nothing to be a percentage *of*, so the slot shows
  // the focus score instead of inventing an eight-hour day nobody agreed to.
  const target = useMemo(() => {
    const goal = goals.find((g) => g.enabled && g.cadence === 'daily')
    if (!goal) return null
    return evaluateGoal(goal, [summary], {
      elapsedShare: isToday ? dayElapsedShare(Date.now(), dayStart) : 1,
    })
  }, [goals, summary, isToday, dayStart])

  const focusBaseline = useMemo(() => {
    const others = week.filter((d) => d.dayKey !== summary.dayKey && d.totalSeconds > 0)
    if (!others.length) return null
    const mean = others.reduce((sum, d) => sum + d.productiveSeconds, 0) / others.length
    if (mean < 60) return null
    return (summary.productiveSeconds - mean) / mean
  }, [week, summary])

  const productiveShare = summary.totalSeconds
    ? summary.productiveSeconds / summary.totalSeconds
    : 0

  const spend: Slice[] = [
    { key: 'focus', label: 'Focus', seconds: summary.productiveSeconds, color: 'var(--productive)' },
    { key: 'neutral', label: 'Neutral', seconds: summary.neutralSeconds, color: 'var(--neutral)' },
    {
      key: 'distracting',
      label: 'Distraction',
      seconds: summary.distractingSeconds,
      color: 'var(--distracting)',
    },
    { key: 'away', label: 'Away', seconds: summary.idleSeconds, color: 'var(--surface-4)' },
  ]
  const spendTotal = spend.reduce((sum, s) => sum + s.seconds, 0)

  return (
    <aside className="summary" aria-label="Summary">
      <div className="summary-head">
        <div className="summary-crumb">
          <IconChevronRight size={13} />
          <span>Summary</span>
          <span className="sep">·</span>
          <span className="summary-crumb-day">{isToday ? 'Today' : 'This day'}</span>
        </div>
        <button className="summary-link" onClick={onCustomize} title="Goals, categories and rules">
          <IconSettings size={13} />
          Customize
        </button>
      </div>

      <div className="summary-headline">
        <div className="headline-stat">
          <div className="headline-label">Work hours</div>
          <div className="headline-value">{duration(summary.totalSeconds)}</div>
          {delta !== null ? (
            <div className={`headline-delta${delta >= 0 ? ' up' : ' down'}`}>
              {delta >= 0 ? '+' : ''}
              {Math.round(delta * 100)}% vs previous day
            </div>
          ) : (
            <div className="headline-delta muted">No previous day to compare</div>
          )}
        </div>

        <div className="headline-stat">
          <div className="headline-label">{target ? 'Percent of target' : 'Focus score'}</div>
          <div className="headline-value">
            {target ? percent(target.ratio) : summary.focusScore}
          </div>
          <div className="headline-delta muted">
            {target ? `of ${duration(target.goal.seconds)} · ${target.goal.name}` : 'out of 100'}
          </div>
        </div>
      </div>

      <div className="seg summary-seg">
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => onMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      <Donut slices={slices} />

      <div className="summary-cards">
        <div className="mini-card">
          <div className="mini-label">Percent of work day</div>
          <div className="mini-value">{percent(productiveShare)}</div>
          <div className="mini-foot">focus, of {duration(summary.totalSeconds)} tracked</div>
        </div>
        <div className="mini-card">
          <div className="mini-label">Focus time</div>
          <div className="mini-value">{duration(summary.productiveSeconds)}</div>
          {focusBaseline !== null ? (
            <div className={`mini-foot${focusBaseline >= 0 ? ' up' : ' down'}`}>
              {focusBaseline >= 0 ? '+' : ''}
              {Math.round(focusBaseline * 100)}% vs your average
            </div>
          ) : (
            <div className="mini-foot">longest block {duration(summary.longestFocusSeconds)}</div>
          )}
        </div>
      </div>

      <div className="summary-section">
        <span>Productivity metrics</span>
        <b>Total {duration(spendTotal)}</b>
      </div>
      <StackedBar slices={spend} />
    </aside>
  )
})
