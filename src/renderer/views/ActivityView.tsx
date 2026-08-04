import { useMemo, useState } from 'react'

import type { Bucket } from '../../core/aggregate'
import { summarizeDay, summarizeWeek } from '../../core/aggregate'
import { dayStartTs } from '../../core/day'
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

  if (!day || !settings) return null

  const categories = scope === 'day' ? summary.byCategory : week.byCategory
  const apps = scope === 'day' ? summary.byApp : weekApps

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">
            {longDate(dayStartTs(day.dayKey, settings.dayStartHour))}
            <span className="sep">·</span>
            {day.sessions.length} recorded sessions
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
            <Breakdown buckets={apps} projects={app.projects} limit={10} />
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">
            Recorded sessions
            <span className="hint">Every row exactly as it is stored</span>
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
