import { useMemo } from 'react'

import { summarizeDay } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import { WeekChart } from '../components/Charts'
import { GoalsCard } from '../components/GoalsCard'
import { duration, longDate } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'

/**
 * Goals get their own page rather than a corner of the dashboard because the
 * editor is the point: a target you cannot adjust where you read it is a target
 * that goes stale, and a stale target is worse than none.
 */
export function GoalsView({ app, onOpenDay }: { app: OpenTimeState; onOpenDay(): void }) {
  const day = app.day
  const settings = app.settings

  const summary = useMemo(
    () => summarizeDay(day?.dayKey || '', day?.sessions || [], day?.idle || [], day?.events || []),
    [day]
  )

  const weekSummaries = useMemo(
    () => app.week.map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events)),
    [app.week]
  )

  const categories = useMemo(() => {
    const names = new Set(app.projects.map((p) => p.name))
    for (const bucket of summary.byCategory) names.add(bucket.key)
    return [...names].sort()
  }, [app.projects, summary])

  if (!day || !settings) return null

  const enabled = app.goals.filter((g) => g.enabled).length

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Goals</h1>
          <p className="page-sub">
            {longDate(dayStartTs(day.dayKey, settings.dayStartHour))}
            <span className="sep">·</span>
            {enabled} of {app.goals.length} switched on
            <span className="sep">·</span>
            {duration(summary.productiveSeconds)} of focus today
          </p>
        </div>
      </div>

      <div className="goals-layout">
        <GoalsCard
          goals={app.goals}
          today={summary}
          week={weekSummaries}
          dayKey={day.dayKey}
          dayStartHour={settings.dayStartHour}
          categories={categories}
          onSave={(goals) => void app.saveGoals(goals)}
        />

        <div className="goals-side">
          <div className="card">
            <h2 className="card-title">
              The week a target is set against
              {/* Short form on purpose: this column is half the width of the
                  one Reports uses, and the long form wrapped the whole
                  header onto two lines. */}
              <span className="hint">Click a day to open it</span>
            </h2>
            {/* A goal is a claim about a normal week, so the week has to be on
                the same screen — otherwise the number gets picked out of the
                air and then quietly ignored. */}
            <WeekChart
              days={weekSummaries}
              selected={day.dayKey}
              dayStartHour={settings.dayStartHour}
              /* Selecting without navigating is what the dashboard and reports
                 charts avoid: the day silently changes underneath a view that
                 does not show days, so the promise in the hint above goes
                 unkept and the click reads as broken. */
              onSelect={(key) => {
                app.selectDay(key)
                onOpenDay()
              }}
            />
          </div>

          <div className="card">
            <h2 className="card-title">Why there are no streaks</h2>
            <p className="prose">
              A goal here is a floor or a ceiling on a slice of time, paced against how much of the
              window has actually elapsed — so a weekly target is never reported as “behind” on a
              Monday morning by construction. There is nothing to break, nothing to lose, and both
              starter goals ship switched off. Goals that arrive pre-enabled are goals somebody
              else set for you, and the first thing anyone does with those is stop believing the
              number.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
