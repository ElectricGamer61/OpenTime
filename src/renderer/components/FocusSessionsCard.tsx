import { memo, useMemo } from 'react'

import type { Session } from '../../core/types'
import { duration, timeOfDay } from '../lib/format'
import { Empty } from './Empty'
import { IconFocus } from './Icons'

interface Row {
  id: string
  label: string
  plannedSeconds: number
  seconds: number
  start: number
  end: number
}

/**
 * The day's focus sessions, read back out of the sessions they sealed.
 *
 * There is no separate store of focus sessions to read — a sealed session *is*
 * the marked rows — so this is a grouping rather than a query. That is the
 * point of the design: there is exactly one record of what happened, and both
 * the timeline and this card are views of it.
 */
export const FocusSessionsCard = memo(function FocusSessionsCard({
  sessions,
  onStart,
}: {
  sessions: Session[]
  onStart(): void
}) {
  const rows = useMemo(() => {
    const byId = new Map<string, Row>()
    for (const s of sessions) {
      if (!s.focus) continue
      const found = byId.get(s.focus.id)
      if (found) {
        found.seconds += s.durationSeconds
        found.start = Math.min(found.start, s.startTime)
        found.end = Math.max(found.end, s.endTime)
      } else {
        byId.set(s.focus.id, {
          id: s.focus.id,
          label: s.focus.label,
          plannedSeconds: s.focus.plannedSeconds,
          seconds: s.durationSeconds,
          start: s.startTime,
          end: s.endTime,
        })
      }
    }
    return [...byId.values()].sort((a, b) => a.start - b.start)
  }, [sessions])

  return (
    <div className="card">
      <h2 className="card-title">
        Focus sessions
        <span className="hint">{rows.length ? `${rows.length} today` : 'Today'}</span>
      </h2>

      {rows.length ? (
        <div className="focus-list">
          {rows.map((row) => {
            const share = row.plannedSeconds ? Math.min(1, row.seconds / row.plannedSeconds) : 1
            return (
              <div className="focus-list-row" key={row.id}>
                <span className="focus-list-mark">
                  <IconFocus size={14} />
                </span>
                <div>
                  <div className="focus-list-name">{row.label}</div>
                  <div className="bar-track">
                    <i style={{ width: `${share * 100}%`, background: 'var(--accent)' }} />
                  </div>
                  <div className="focus-list-when">
                    {timeOfDay(row.start)} – {timeOfDay(row.end)}
                    {row.plannedSeconds ? ` · planned ${duration(row.plannedSeconds)}` : ''}
                  </div>
                </div>
                <span className="focus-list-len">{duration(row.seconds)}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <Empty
          glyph={<IconFocus size={30} />}
          title="No focus sessions today"
          hint="Start one to put your own name on a stretch of work. Tracking runs either way."
          action={
            <button className="btn primary small" onClick={onStart}>
              Start focus session
            </button>
          }
        />
      )}
    </div>
  )
})
