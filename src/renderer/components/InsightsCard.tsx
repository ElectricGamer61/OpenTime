import { memo, useMemo } from 'react'

import type { DaySummary } from '../../core/aggregate'
import { buildInsights } from '../../core/insights'
import type { Session } from '../../core/types'

/**
 * The day's observations.
 *
 * Renders nothing at all — not an empty state, not a placeholder — when there is
 * nothing worth saying. A panel that is always full is a panel people stop
 * reading, and then the one day it matters they miss it too.
 */
export const InsightsCard = memo(function InsightsCard({
  today,
  sessions,
  week,
  dayStartHour,
}: {
  today: DaySummary
  sessions: Session[]
  week: DaySummary[]
  dayStartHour: number
}) {
  const insights = useMemo(
    () => buildInsights({ today, sessions, week, dayStartHour }),
    [today, sessions, week, dayStartHour]
  )

  if (!insights.length) return null

  return (
    <div className="card">
      <h2 className="card-title">What stands out</h2>
      <div className="insights">
        {insights.slice(0, 3).map((insight) => (
          <div className={`insight ${insight.tone}`} key={insight.id}>
            <div className="insight-title">{insight.title}</div>
            <div className="insight-detail">{insight.detail}</div>
          </div>
        ))}
      </div>
    </div>
  )
})
