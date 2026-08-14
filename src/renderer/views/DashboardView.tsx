import { useMemo } from 'react'

import { summarizeDay } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import { FocusRing, Stat, WeekChart } from '../components/Charts'
import { FocusSessionsCard } from '../components/FocusSessionsCard'
import { InsightsCard } from '../components/InsightsCard'
import { NowCard } from '../components/NowCard'
import { RefreshButton } from '../components/RefreshButton'
import { duration, longDate, percent } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'

/**
 * The overview.
 *
 * The calendar answers "where did the day go"; this answers "how is it going" —
 * live state, the day's four headline numbers, what the week looks like around
 * it, and anything the insight engine has to say. Nothing here is a restatement
 * of the calendar's own summary column.
 */
export function DashboardView({
  app,
  onOpenCalendar,
  onStartFocus,
}: {
  app: OpenTimeState
  onOpenCalendar(): void
  onStartFocus(): void
}) {
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

  if (!day || !settings) return null

  const trackedShare = summary.totalSeconds ? summary.productiveSeconds / summary.totalSeconds : 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-sub">
            {longDate(dayStartTs(day.dayKey, settings.dayStartHour))}
            <span className="sep">·</span>
            {duration(summary.totalSeconds)} tracked
            <span className="sep">·</span>
            {summary.switches} context switches
          </p>
        </div>
        <div className="row">
          {app.status?.demo ? <span className="pill info">Demo capture</span> : null}
          <RefreshButton onRefresh={() => void app.refresh()} />
        </div>
      </div>

      <div className="grid" style={{ gap: 14 }}>
        <NowCard
          status={app.status}
          onToggle={() => void app.setTracking(app.status?.paused ? 'resume' : 'pause')}
        />

        <div className="grid cols-4">
          <Stat
            label="Tracked"
            value={duration(summary.totalSeconds)}
            foot={summary.idleSeconds ? `${duration(summary.idleSeconds)} away` : 'No time away'}
          />
          <Stat
            label="Focus time"
            value={duration(summary.productiveSeconds)}
            foot={`${percent(trackedShare)} of tracked time`}
            meter={trackedShare}
            color="var(--productive)"
          />
          <Stat
            label="Distraction"
            value={duration(summary.distractingSeconds)}
            foot={
              summary.totalSeconds
                ? `${percent(summary.distractingSeconds / summary.totalSeconds)} of tracked time`
                : 'Nothing yet'
            }
            meter={summary.totalSeconds ? summary.distractingSeconds / summary.totalSeconds : 0}
            color="var(--distracting)"
          />
          <Stat
            label="Longest deep block"
            value={duration(summary.longestFocusSeconds)}
            foot={
              summary.meetingSeconds
                ? `${duration(summary.meetingSeconds)} in meetings`
                : 'No meetings scheduled'
            }
            color="var(--accent)"
          />
        </div>

        <div className="grid cols-2">
          <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
            <div className="card">
              <h2 className="card-title">Day balance</h2>
              <FocusRing summary={summary} />
            </div>

            <FocusSessionsCard sessions={day.sessions} onStart={onStartFocus} />
          </div>

          <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
            <InsightsCard
              today={summary}
              sessions={day.sessions}
              week={weekSummaries}
              dayStartHour={settings.dayStartHour}
            />

            <div className="card">
              <h2 className="card-title">
                This week
                <span className="hint">Click a day to open it</span>
              </h2>
              <WeekChart
                days={weekSummaries}
                selected={app.selectedDay}
                dayStartHour={settings.dayStartHour}
                onSelect={(key) => {
                  app.selectDay(key)
                  onOpenCalendar()
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
