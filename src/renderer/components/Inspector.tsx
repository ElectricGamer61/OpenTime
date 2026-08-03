import { memo, useEffect, useState } from 'react'

import type { Productivity, Project, Session } from '../../core/types'
import type { RecategorizeRequest } from '../../shared/ipc'
import { duration, timeOfDay } from '../lib/format'
import { Empty } from './Empty'
import { IconEmptyPointer } from './Icons'

const LEVELS: Productivity[] = ['productive', 'neutral', 'distracting']

/**
 * The correction panel: pick a block, retag it, and optionally teach OpenTime
 * to make the same call automatically next time. Rules learned here are the
 * top-priority layer in the categoriser, so a correction is permanent.
 */
export const Inspector = memo(function Inspector({
  session,
  dayKey,
  projects,
  onApply,
}: {
  session: Session | null
  dayKey: string
  projects: Project[]
  onApply(request: RecategorizeRequest): void
}) {
  const [category, setCategory] = useState('')
  const [productivity, setProductivity] = useState<Productivity>('neutral')
  const [remember, setRemember] = useState<'none' | 'app' | 'keyword'>('none')

  useEffect(() => {
    if (!session) return
    setCategory(session.category)
    setProductivity(session.productivity)
    setRemember('none')
  }, [session])

  if (!session) {
    return (
      <Empty
        glyph={<IconEmptyPointer />}
        title="Nothing selected"
        hint="Pick a block on the timeline to retag it, or teach OpenTime a rule that handles it from now on."
      />
    )
  }

  const dirty = category !== session.category || productivity !== session.productivity
  const target = remember === 'app' ? session.app : session.url || session.app

  return (
    /* Keyed on the session so switching blocks replays the panel's fade-in —
       otherwise a click on a different block silently swaps the text and it
       is easy to miss that anything changed. */
    <div className="inspector" key={session.id}>
      <div className="inspector-head">
        <div className="inspector-title">{session.title || session.app}</div>
        <div className="inspector-sub">
          {session.app}
          {session.url ? ` · ${session.url}` : ''}
        </div>
        <div className="inspector-when">
          {timeOfDay(session.startTime)} – {timeOfDay(session.endTime)} ·{' '}
          {duration(session.durationSeconds)}
        </div>
      </div>

      <div className="field">
        <label htmlFor="insp-category">Category</label>
        <input
          id="insp-category"
          list="opentime-categories"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="opentime-categories">
          {projects.map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
      </div>

      <div className="field">
        <label>Counts as</label>
        <div className="seg grow">
          {LEVELS.map((level) => (
            <button
              key={level}
              className={productivity === level ? 'on' : ''}
              onClick={() => setProductivity(level)}
            >
              {level[0].toUpperCase() + level.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Remember this</label>
        <div className="seg grow">
          <button className={remember === 'none' ? 'on' : ''} onClick={() => setRemember('none')}>
            Just this block
          </button>
          <button className={remember === 'app' ? 'on' : ''} onClick={() => setRemember('app')}>
            Whole app
          </button>
          <button
            className={remember === 'keyword' ? 'on' : ''}
            onClick={() => setRemember('keyword')}
          >
            Matching text
          </button>
        </div>
        {remember !== 'none' ? (
          <div className="hint">
            Future activity matching <b>{target}</b> will be tagged “{category || session.category}”.
          </div>
        ) : null}
      </div>

      <div className="row">
        <button
          className="btn primary"
          disabled={!dirty && remember === 'none'}
          onClick={() =>
            onApply({
              dayKey,
              sessionId: session.id,
              category: category || session.category,
              productivity,
              rememberAs: remember === 'none' ? undefined : remember,
            })
          }
        >
          Apply
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            setCategory(session.category)
            setProductivity(session.productivity)
            setRemember('none')
          }}
        >
          Reset
        </button>
      </div>
    </div>
  )
})
