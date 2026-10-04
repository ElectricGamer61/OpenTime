import { memo } from 'react'

import type { TrackerStatus } from '../../core/types'
import { clock, duration } from '../lib/format'
import { useNow } from '../state/useOpenTime'
import { IconClock, IconPause } from './Icons'

interface Props {
  status: TrackerStatus | null
  onToggle(): void
}

/**
 * The live "what am I doing right now" card — the one hero surface in the app.
 * It owns the only per-second timer, so nothing else re-renders on the tick.
 */
export const NowCard = memo(function NowCard({ status, onToggle }: Props) {
  const now = useNow(1000)
  const current = status?.current ?? null
  const paused = !!status?.paused
  const elapsed = current ? (now - current.startTime) / 1000 : 0
  const stretch = status?.stretchStart ? (now - status.stretchStart) / 1000 : 0

  // The detail line is the part most likely to be empty, so it always falls
  // through to something that explains *why* rather than going blank.
  const detail = current
    ? [current.app, current.url, current.title].filter(Boolean).join(' · ')
    : status?.demo
      ? 'Showing example activity: this computer does not let OpenTime read windows.'
      : 'No input detected. OpenTime is watching for your return.'

  return (
    <section className={`now${paused ? ' is-paused' : ''}`} aria-label="Current activity">
      <div className={`now-beacon${paused ? ' paused' : ''}`}>
        {paused ? <IconPause /> : <IconClock />}
      </div>

      <div className="now-body">
        <div className="now-label">{paused ? 'Paused' : current ? 'Tracking now' : 'Idle'}</div>
        <div className="now-title">
          {paused ? 'Tracking paused' : current ? current.category : 'Waiting for activity'}
        </div>
        <div className="now-meta" title={detail}>
          {detail}
        </div>
      </div>

      <div className="now-right">
        <div className={`now-timer${current ? '' : ' dim'}`}>{current ? clock(elapsed) : '-'}</div>
        {stretch >= 60 && !paused ? (
          <span className="pill live">
            <i className="swatch" />
            {duration(stretch)} unbroken
          </span>
        ) : null}
      </div>

      <button className="btn" onClick={onToggle}>
        {paused ? 'Resume' : 'Pause'}
      </button>
    </section>
  )
})
