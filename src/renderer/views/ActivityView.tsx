import { useMemo, useState } from 'react'

import type { Bucket } from '../../core/aggregate'
import { summarizeDay, summarizeWeek } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
import { rangeLabel } from '../../core/range'
import { Breakdown } from '../components/Charts'
import { Empty } from '../components/Empty'
import { RefreshButton } from '../components/RefreshButton'
import { duration, longDate, percent, timeOfDay } from '../lib/format'
import { categoryColors } from '../lib/palette'
import type { OpenTimeState } from '../state/useOpenTime'

/**
 * The raw record.
 *
 * The calendar shows folded entries because a grid of fifty slivers is
 * unreadable; this view deliberately does not fold, because the one question the
 * calendar cannot answer is "what actually got recorded". Everything here is one
 * row per stored session.
 */
export function ActivityView({ app }: { app: OpenTimeState }) {
  const [scope, setScope] = useState<'day' | 'week'>('day')
  const day = app.day
  const settings = app.settings

  const summary = useMemo(
    () => summarizeDay(day?.dayKey || '', day?.sessions || [], day?.idle || [], day?.events || []),
    [day]
  )

  const week = useMemo(
    () => summarizeWeek(app.week.map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events))),
    [app.week]
  )

  const weekApps = useMemo(() => {
    const totals = new Map<string, Bucket>()
    for (const payload of app.week) {
      for (const s of payload.sessions) {
        const found = totals.get(s.app)
        if (found) found.seconds += s.durationSeconds
        else
          totals.set(s.app, {
            key: s.app,
            label: s.app,
            seconds: s.durationSeconds,
            share: 0,
            productivity: s.productivity,
          })
      }
    }
    const all = [...totals.values()]
    const total = all.reduce((sum, b) => sum + b.seconds, 0) || 1
    return all.map((b) => ({ ...b, share: b.seconds / total })).sort((a, b) => b.seconds - a.seconds)
  }, [app.week])

  const colors = useMemo(
    () => categoryColors(app.projects, [...new Set((day?.sessions || []).map((s) => s.category))].sort()),
    [app.projects, day]
  )

  /** Apps are coloured by name, not by productivity — see `Breakdown`. */
  const appColors = useMemo(
    () =>
      categoryColors(
        [],
        [...new Set([...summary.byApp, ...weekApps].map((b) => b.key))].sort()
      ),
    [summary, weekApps]
  )

  if (!day || !settings) return null

  const categories = scope === 'day' ? summary.byCategory : week.byCategory
  const apps = scope === 'day' ? summary.byApp : weekApps

  const dayLabel = longDate(dayStartTs(day.dayKey, settings.dayStartHour))
  /*
   * The scope control moves the two breakdowns onto the week, so the subtitle
   * has to move with them. Left on the day it flatly contradicted the numbers
   * underneath it — a header reading "Friday · 20 recorded sessions" above a
   * chart totalling the whole week.
   */
  const weekKeys = app.week.map((d) => d.dayKey).filter(Boolean)
  const weekSessions = app.week.reduce((sum, d) => sum + d.sessions.length, 0)
  const scoped =
    scope === 'day' || weekKeys.length === 0
      ? { title: dayLabel, count: day.sessions.length, unit: 'recorded sessions' }
      : {
          title: rangeLabel({
            kind: 'week',
            fromKey: weekKeys[0],
            toKey: weekKeys[weekKeys.length - 1],
          }),
          count: weekSessions,
          unit: `recorded sessions over ${weekKeys.length} days`,
        }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">
            {scoped.title}
            <span className="sep">·</span>
            {scoped.count} {scoped.unit}
          </p>
        </div>
        <div className="row">
          <div className="seg">
            <button className={scope === 'day' ? 'on' : ''} onClick={() => setScope('day')}>
              This day
            </button>
            <button className={scope === 'week' ? 'on' : ''} onClick={() => setScope('week')}>
              This week
            </button>
          </div>
          <RefreshButton onRefresh={() => void app.refresh()} />
        </div>
      </div>

      <div className="grid" style={{ gap: 14 }}>
        <div className="grid cols-2">
          <div className="card">
            <h2 className="card-title">Categories</h2>
            <Breakdown buckets={categories} projects={app.projects} limit={10} />
          </div>
          <div className="card">
            <h2 className="card-title">Applications</h2>
            <Breakdown buckets={apps} projects={app.projects} palette={appColors} limit={10} />
          </div>
        </div>

        <div className="card">
          {/* The table is always one day, whatever the breakdowns are scoped
              to — a week of unfolded rows is a scroll, not a record. So it
              names its day rather than leaving the reader to assume it
              followed the toggle. */}
          <h2 className="card-title">
            Recorded sessions
            <span className="hint">{dayLabel} · every row exactly as it is stored</span>
          </h2>
          {day.sessions.length ? (
            <div className="session-table">
              {day.sessions.map((s) => (
                <div className="session-row" key={s.id}>
                  <span className="session-time">
                    {timeOfDay(s.startTime)} – {timeOfDay(s.endTime)}
                  </span>
                  <span className="session-cat">
                    <i style={{ background: colors.get(s.category) || 'var(--surface-4)' }} />
                    {s.category}
                  </span>
                  <span className="session-title" title={s.title}>
                    {s.title || s.app}
                  </span>
                  <span className="session-app">{s.url || s.app}</span>
                  <span className="session-len">{duration(s.durationSeconds)}</span>
                  <span className={`session-flag ${s.productivity}`}>
                    {percent(summary.totalSeconds ? s.durationSeconds / summary.totalSeconds : 0)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="Nothing recorded for this day"
              hint="Sessions appear here the moment OpenTime sees window activity."
            />
          )}
        </div>
      </div>
    </>
  )
}
