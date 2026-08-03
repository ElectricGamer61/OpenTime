import { memo } from 'react'

import type { TrackerStatus } from '../../core/types'
import { clock, duration } from '../lib/format'
import { useNow } from '../state/useOpenTime'

interface Props {
  status: TrackerStatus | null
  onToggle(): void
}

/**
 * The live "what am I doing right now" card. It owns the only per-second timer
 * in the app, so nothing else re-renders on the tick.
 */
export const NowCard = memo(function NowCard({ status, onToggle }: Props) {
  const now = useNow(1000)
  const current = status?.current ?? null
  const paused = !!status?.paused
  const elapsed = current ? (now - current.startTime) / 1000 : 0
  const stretch = status?.stretchStart ? (now - status.stretchStart) / 1000 : 0

  return (
    <div className="now">
      <div className={`now-beacon${paused ? ' paused' : ''}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {paused ? (
            <path d="M9 6v12M15 6v12" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" />
          ) : (
            <path
              d="M12 6.5v6l4 2.2"
              stroke="var(--accent)"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </div>

      <div className="now-body">
        <div className="now-label">{paused ? 'Paused' : current ? 'Tracking now' : 'Idle'}</div>
        <div className="now-title">
          {paused
            ? 'Tracking paused'
            : current
              ? current.category
              : 'Waiting for activity'}
        </div>
        <div className="now-meta">
          {current
            ? `${current.app}${current.url ? ` · ${current.url}` : ''}${current.title ? ` — ${current.title}` : ''}`
            : status?.demo
              ? 'Demo capture adapter — no OS window access in this environment.'
              : 'No input detected. OpenTime is watching for your return.'}
        </div>
      </div>

      <div style={{ textAlign: 'right', display: 'grid', gap: 6, justifyItems: 'end' }}>
        <div className="now-timer">{current ? clock(elapsed) : '—'}</div>
        {stretch > 60 && !paused ? (
          <span className="pill live">
            <i className="swatch" />
            {duration(stretch)} unbroken
          </span>
        ) : null}
      </div>

      <button className="btn" onClick={onToggle}>
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  )
})
