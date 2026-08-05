import { useMemo } from 'react'

import { summarizeDay, summarizeWeek } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import { Breakdown, Stat, WeekChart } from '../components/Charts'
import { RefreshButton } from '../components/RefreshButton'
import { duration, longDate, percent } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'

export function WeekView({
  app,
  onOpenDay,
}: {
  app: OpenTimeState
  /** Selects the day and navigates to the view that shows it. */
  onOpenDay(key: string): void
}) {
  const settings = app.settings

  const days = useMemo(
    () => app.week.map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events)),
    [app.week]
  )
  const week = useMemo(() => summarizeWeek(days), [days])

  if (!settings) return null

  const productiveShare = week.totalSeconds ? week.productiveSeconds / week.totalSeconds : 0
  const dailyAverage = days.length ? Math.round(week.totalSeconds / days.length) : 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">This week</h1>
          <p className="page-sub">
            {duration(week.totalSeconds)} tracked over {days.filter((d) => d.totalSeconds).length}{' '}
            active days
          </p>
        </div>
        <RefreshButton onRefresh={() => void app.refresh()} />
      </div>

      <div className="grid" style={{ gap: 14 }}>
        <div className="grid cols-4">
          <Stat label="Total tracked" value={duration(week.totalSeconds)} foot={`${duration(dailyAverage)} / day`} />
          <Stat
            label="Focus time"
            value={duration(week.productiveSeconds)}
            foot={`${percent(productiveShare)} of tracked time`}
            meter={productiveShare}
            color="var(--productive)"
          />
          <Stat
            label="Distraction"
            value={duration(week.distractingSeconds)}
            foot={
              week.totalSeconds
                ? `${percent(week.distractingSeconds / week.totalSeconds)} of tracked time`
                : 'Nothing yet'
            }
            color="var(--distracting)"
          />
          <Stat
            label="Average focus score"
            value={String(week.averageFocusScore)}
            foot={
              week.bestDay
                ? `Best: ${longDate(dayStartTs(week.bestDay.dayKey, settings.dayStartHour))} (${week.bestDay.focusScore})`
                : 'No scored days yet'
            }
            meter={week.averageFocusScore / 100}
            color="var(--accent)"
          />
        </div>

        <div className="card">
          <h2 className="card-title">
            Daily breakdown
            <span className="hint">Click a day to open it</span>
          </h2>
          <WeekChart
            days={days}
            selected={app.selectedDay}
            dayStartHour={settings.dayStartHour}
            onSelect={onOpenDay}
          />
          {/* Each column stacks four things and the away segment caps every
              one of them, so without this the grey top reads as an empty
              container rather than as time away. */}
          <div className="timeline-legend">
            <span>
              <i style={{ background: 'var(--productive)' }} />
              Productive
            </span>
            <span>
              <i style={{ background: 'var(--neutral)' }} />
              Neutral
            </span>
            <span>
              <i style={{ background: 'var(--distracting)' }} />
              Distracting
            </span>
            <span>
              <i style={{ background: 'var(--idle)' }} />
              Away
            </span>
          </div>
        </div>

        <div className="grid cols-2">
          <div className="card">
            <h2 className="card-title">Where the week went</h2>
            <Breakdown buckets={week.byCategory} projects={app.projects} limit={10} />
          </div>

          <div className="card">
            <h2 className="card-title">
              Day by day
              <span className="hint">Focus score</span>
            </h2>
            {days.map((d) => (
              <div
                className={`bar-row clickable${d.dayKey === app.selectedDay ? ' on' : ''}`}
                key={d.dayKey}
                role="button"
                tabIndex={0}
                onClick={() => onOpenDay(d.dayKey)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault() // Space must activate, not scroll the page.
                  onOpenDay(d.dayKey)
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
                    <i
                      style={{
                        width: `${d.focusScore}%`,
                        background: 'var(--accent)',
                      }}
                    />
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
    </>
  )
}
