import { memo, useMemo, useState } from 'react'

import type { DaySummary } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import { dayElapsedShare, draftGoal, evaluateGoals, type GoalProgress } from '../../core/goals'
import type { Goal } from '../../core/types'
import { duration } from '../lib/format'
import { Empty } from './Empty'
import { IconEmptyRule } from './Icons'

const STATE_COPY: Record<GoalProgress['state'], { label: string; tone: string }> = {
  met: { label: 'Met', tone: 'good' },
  'on-track': { label: 'On track', tone: 'neutral' },
  behind: { label: 'Behind', tone: 'warn' },
  'at-risk': { label: 'Running hot', tone: 'warn' },
  exceeded: { label: 'Over', tone: 'bad' },
}

function hoursLabel(seconds: number): string {
  return duration(seconds)
}

/**
 * Goals, and the editor for them.
 *
 * The editor is inline rather than behind a settings page because a goal you
 * cannot adjust while looking at today's number is a goal you will not adjust at
 * all — and a stale target is worse than no target.
 */
export const GoalsCard = memo(function GoalsCard({
  goals,
  today,
  week,
  dayKey,
  dayStartHour,
  categories,
  onSave,
}: {
  goals: Goal[]
  today: DaySummary
  week: DaySummary[]
  dayKey: string
  dayStartHour: number
  categories: string[]
  onSave(goals: Goal[]): void
}) {
  const [editing, setEditing] = useState(false)

  const progress = useMemo(() => {
    const now = Date.now()
    const start = dayStartTs(dayKey, dayStartHour)
    const tracked = week.filter((d) => d.totalSeconds > 0).length
    return evaluateGoals(goals, today, week, {
      dayElapsedShare: dayElapsedShare(now, start),
      // Pace a weekly goal by tracked days so far, not by calendar days: a
      // Monday is not "1/7 behind" on a target you set for working days.
      weekElapsedShare: Math.min(1, Math.max(tracked, 1) / 5),
    })
  }, [goals, today, week, dayKey, dayStartHour])

  const patch = (id: string, next: Partial<Goal>) =>
    onSave(goals.map((g) => (g.id === id ? { ...g, ...next } : g)))

  return (
    <div className="card">
      <h2 className="card-title">
        Goals
        <button className="btn ghost small" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </h2>

      {!editing && progress.length === 0 ? (
        <Empty
          glyph={<IconEmptyRule />}
          title="No goals switched on"
          hint="Turn one on to see today measured against a target you set, rather than one somebody else picked."
        />
      ) : null}

      {!editing
        ? progress.map((p) => {
            const copy = STATE_COPY[p.state]
            return (
              <div className="goal-row" key={p.goal.id}>
                <div className="goal-head">
                  <span className="goal-name">{p.goal.name}</span>
                  <span className={`pill ${copy.tone === 'good' ? 'info' : copy.tone === 'warn' || copy.tone === 'bad' ? 'warn' : ''}`}>
                    {copy.label}
                  </span>
                </div>
                <div className="meter">
                  <i
                    style={{
                      width: `${Math.round(p.progress * 100)}%`,
                      background:
                        p.goal.direction === 'at-least' ? 'var(--productive)' : 'var(--distracting)',
                    }}
                  />
                </div>
                <div className="goal-foot">
                  {hoursLabel(p.seconds)} of {hoursLabel(p.goal.seconds)}
                  {p.goal.cadence === 'weekly' ? ' this week' : ' today'}
                  {p.remainingSeconds > 0
                    ? p.goal.direction === 'at-least'
                      ? ` · ${hoursLabel(p.remainingSeconds)} to go`
                      : ` · ${hoursLabel(p.remainingSeconds)} left`
                    : ''}
                </div>
              </div>
            )
          })
        : null}

      {editing ? (
        <div className="goal-editor">
          {goals.map((goal) => (
            <div className="goal-edit-row" key={goal.id}>
              <div className="row">
                <input
                  aria-label="Goal name"
                  value={goal.name}
                  onChange={(e) => patch(goal.id, { name: e.target.value })}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn ghost danger small"
                  aria-label={`Delete ${goal.name}`}
                  onClick={() => onSave(goals.filter((g) => g.id !== goal.id))}
                >
                  Delete
                </button>
              </div>
              <div className="row wrap">
                <select
                  aria-label="Goal direction"
                  value={goal.direction}
                  onChange={(e) => patch(goal.id, { direction: e.target.value as Goal['direction'] })}
                >
                  <option value="at-least">At least</option>
                  <option value="at-most">At most</option>
                </select>
                <select
                  aria-label="Goal target hours"
                  value={goal.seconds}
                  onChange={(e) => patch(goal.id, { seconds: Number(e.target.value) })}
                >
                  {[15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 1200, 1800, 2400].map((m) => (
                    <option key={m} value={m * 60}>
                      {m < 60 ? `${m} minutes` : `${m / 60} hours`}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Goal subject"
                  value={goal.kind === 'productivity' ? `p:${goal.target}` : `c:${goal.target}`}
                  onChange={(e) => {
                    const [kind, ...rest] = e.target.value.split(':')
                    patch(goal.id, {
                      kind: kind === 'p' ? 'productivity' : 'category',
                      target: rest.join(':'),
                    })
                  }}
                >
                  <option value="p:productive">of focus time</option>
                  <option value="p:distracting">of distraction</option>
                  <option value="p:neutral">of neutral time</option>
                  {categories.map((c) => (
                    <option key={c} value={`c:${c}`}>
                      on {c}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Goal cadence"
                  value={goal.cadence}
                  onChange={(e) => patch(goal.id, { cadence: e.target.value as Goal['cadence'] })}
                >
                  <option value="daily">per day</option>
                  <option value="weekly">per week</option>
                </select>
                <label className="goal-enable">
                  <input
                    type="checkbox"
                    checked={goal.enabled}
                    onChange={(e) => patch(goal.id, { enabled: e.target.checked })}
                  />
                  On
                </label>
              </div>
            </div>
          ))}
          <button
            className="btn"
            onClick={() => onSave([...goals, draftGoal(`g_${Date.now().toString(36)}`)])}
          >
            Add a goal
          </button>
        </div>
      ) : null}
    </div>
  )
})
