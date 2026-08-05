import { useEffect, useMemo, useRef, useState } from 'react'

import { summarizeDay } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import type { IdleBlock, Session } from '../../core/types'
import { Breakdown, FocusRing, Stat } from '../components/Charts'
import { GoalsCard } from '../components/GoalsCard'
import { IconInfo } from '../components/Icons'
import { InsightsCard } from '../components/InsightsCard'
import { Inspector } from '../components/Inspector'
import { NowCard } from '../components/NowCard'
import { RefreshButton } from '../components/RefreshButton'
import { Timeline } from '../components/Timeline'
import { duration, longDate, percent } from '../lib/format'
import type { OpenTimeState } from '../state/useOpenTime'

export function TodayView({ app }: { app: OpenTimeState }) {
  const [selected, setSelected] = useState<Session | null>(null)
  const [selectedIdle, setSelectedIdle] = useState<IdleBlock | null>(null)
  const reviewRef = useRef<HTMLDivElement>(null)
  const day = app.day
  const settings = app.settings

  // The review panel sits at the bottom of the right-hand column, usually far
  // below the fold — without this, clicking a timeline block looks like it did
  // nothing at all. `nearest` means an already-visible panel never moves.
  useEffect(() => {
    if (!selected && !selectedIdle) return
    reviewRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }, [selected, selectedIdle])

  // The single aggregation pass for this view. Everything below reads from it.
  const summary = useMemo(
    () => summarizeDay(day?.dayKey || '', day?.sessions || [], day?.idle || [], day?.events || []),
    [day]
  )

  // The trailing week, summarised once — goals and the baseline insight both
  // need it, and neither should aggregate inside a component body.
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

  const todayKey = app.weekKeys[app.weekKeys.length - 1]
  const isToday = day.dayKey === todayKey
  const trackedShare = summary.totalSeconds
    ? summary.productiveSeconds / summary.totalSeconds
    : 0

  const hasSelection = !!(selected || selectedIdle)
  const reviewCard = (
    <div className="card" ref={reviewRef} key="review">
      <h2 className="card-title">Review</h2>
      <Inspector
        session={selected}
        idle={selectedIdle}
        dayKey={day.dayKey}
        dayAnchor={dayStartTs(day.dayKey, settings.dayStartHour) + 8 * 3600_000}
        projects={app.projects}
        onApply={(request) => {
          void app.recategorize(request)
          setSelected(null)
        }}
        onEdit={async (edit) => {
          const result = await app.editSession(edit)
          if (result.ok) {
            setSelected(null)
            setSelectedIdle(null)
          }
          return result
        }}
      />
    </div>
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {isToday ? 'Today' : longDate(dayStartTs(day.dayKey, settings.dayStartHour))}
          </h1>
          <p className="page-sub">
            {/* On a past day the title already is the date; repeating it here
                would say the same thing twice in adjacent lines. */}
            {isToday ? (
              <>
                {longDate(dayStartTs(day.dayKey, settings.dayStartHour))}
                <span className="sep">·</span>
              </>
            ) : null}
            {duration(summary.totalSeconds)} tracked
            <span className="sep">·</span>
            {summary.switches} context switches
          </p>
        </div>
        <div className="row">
          {app.status?.demo ? <span className="pill info">Demo capture</span> : null}
          {/* Reviewing a past day happens on this tab, so without this the only
              way back to today is a detour through the weekly chart. */}
          {!isToday ? (
            <button className="btn ghost" onClick={() => app.selectDay(todayKey)}>
              Back to today
            </button>
          ) : null}
          <RefreshButton onRefresh={() => void app.refresh()} />
        </div>
      </div>

      {app.captureNotice ? (
        <div className="notice">
          <IconInfo />
          <div>
            <strong>Showing generated activity.</strong> {app.captureNotice} Everything below runs
            through the same tracking engine that real capture feeds — only the window samples are
            synthetic. Settings can remove the generated history at any time.
          </div>
        </div>
      ) : app.capture?.notice ? (
        // Capture is live but degraded — worth naming, and fixable in place.
        <div className="notice">
          <IconInfo />
          <div>
            <strong>Capture is limited.</strong> {app.capture.notice}{' '}
            <button className="btn ghost small" onClick={() => void app.reloadCapture()}>
              Check again
            </button>
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
              onSelectIdle={setSelectedIdle}
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
            {/* With a block selected, the review panel moves to the top of
                this column so the editor sits beside the timeline being
                edited; unselected, it waits at the bottom as an affordance
                rather than claiming the dashboard's best slot with an empty
                state. Keys keep the moved card's identity stable. */}
            {hasSelection ? reviewCard : null}

            <InsightsCard
              key="insights"
              today={summary}
              sessions={day.sessions}
              week={weekSummaries}
              dayStartHour={settings.dayStartHour}
            />

            <div className="card" key="balance">
              <h2 className="card-title">Day balance</h2>
              <FocusRing summary={summary} />
            </div>

            <GoalsCard
              key="goals"
              goals={app.goals}
              today={summary}
              week={weekSummaries}
              dayKey={day.dayKey}
              dayStartHour={settings.dayStartHour}
              categories={categories}
              onSave={(goals) => void app.saveGoals(goals)}
            />

            <div className="card" key="categories">
              <h2 className="card-title">Categories</h2>
              <Breakdown buckets={summary.byCategory} projects={app.projects} limit={6} />
            </div>

            <div className="card" key="applications">
              <h2 className="card-title">Applications</h2>
              <Breakdown buckets={summary.byApp} projects={app.projects} limit={6} />
            </div>

            {!hasSelection ? reviewCard : null}
          </div>
        </div>
      </div>
    </>
  )
}
