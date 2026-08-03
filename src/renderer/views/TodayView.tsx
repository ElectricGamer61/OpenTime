import { useMemo, useState } from 'react'

import { summarizeDay } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import type { Session } from '../../core/types'
import { Breakdown, FocusRing, Stat } from '../components/Charts'
import { IconInfo } from '../components/Icons'
import { Inspector } from '../components/Inspector'
import { NowCard } from '../components/NowCard'
import { RefreshButton } from '../components/RefreshButton'
import { Timeline } from '../components/Timeline'
import { duration, longDate, percent } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'

export function TodayView({ app }: { app: OpenTimeState }) {
  const [selected, setSelected] = useState<Session | null>(null)
  const day = app.day
  const settings = app.settings

  // The single aggregation pass for this view. Everything below reads from it.
  const summary = useMemo(
    () => summarizeDay(day?.dayKey || '', day?.sessions || [], day?.idle || [], day?.events || []),
    [day]
  )

  if (!day || !settings) return null

  const isToday = day.dayKey === app.weekKeys[app.weekKeys.length - 1]
  const trackedShare = summary.totalSeconds
    ? summary.productiveSeconds / summary.totalSeconds
    : 0

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {isToday ? 'Today' : longDate(dayStartTs(day.dayKey, settings.dayStartHour))}
          </h1>
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

      {app.captureNotice ? (
        <div className="notice">
          <IconInfo />
          <div>
            <strong>Showing generated activity.</strong> {app.captureNotice} Everything below runs
            through the same tracking engine that real capture feeds — only the window samples are
            synthetic.
          </div>
        </div>
      ) : null}

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
          {/* The timeline is a fixed height, so without this it stretches to
              match the taller right-hand column and trails a large empty
              area under the legend on tall windows. */}
          <div className="card" style={{ alignSelf: 'start' }}>
            <h2 className="card-title">
              Timeline
              <span className="hint">Click a block to review it</span>
            </h2>
            <Timeline
              dayKey={day.dayKey}
              dayStartHour={settings.dayStartHour}
              sessions={day.sessions}
              idle={day.idle}
              events={day.events}
              projects={app.projects}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
            {/* The timeline carries two colour channels at once — fill for the
                project, left edge for how it counted — so it needs saying. */}
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
                <i style={{ background: 'var(--surface-4)' }} />
                Away
              </span>
              <span>
                <i style={{ background: 'var(--meeting)' }} />
                Calendar
              </span>
            </div>
          </div>

          <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
            <div className="card">
              <h2 className="card-title">Day balance</h2>
              <FocusRing summary={summary} />
            </div>

            <div className="card">
              <h2 className="card-title">Categories</h2>
              <Breakdown buckets={summary.byCategory} projects={app.projects} limit={6} />
            </div>

            <div className="card">
              <h2 className="card-title">Applications</h2>
              <Breakdown buckets={summary.byApp} projects={app.projects} limit={6} />
            </div>

            <div className="card">
              <h2 className="card-title">Review</h2>
              <Inspector
                session={selected}
                dayKey={day.dayKey}
                projects={app.projects}
                onApply={(request) => {
                  void app.recategorize(request)
                  setSelected(null)
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
