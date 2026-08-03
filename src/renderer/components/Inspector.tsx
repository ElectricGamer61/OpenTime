import { memo, useEffect, useState } from 'react'

import type { IdleBlock, Productivity, Project, Session } from '../../core/types'
import type { EditResult, RecategorizeRequest, SessionEdit } from '../../shared/ipc'
import { duration, timeOfDay } from '../lib/format'
import { Empty } from './Empty'
import { IconEmptyPointer } from './Icons'

const LEVELS: Productivity[] = ['productive', 'neutral', 'distracting']

/** `HH:MM` from a timestamp, for a native time input. */
function toTimeInput(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Read `HH:MM` back onto the calendar date of `anchor`.
 *
 * Anchoring on the block being edited rather than on "today" is what makes this
 * correct while reviewing a previous day — and what stops a 1am correction on a
 * late-night session landing 24 hours away.
 */
function fromTimeInput(value: string, anchor: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const d = new Date(anchor)
  d.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return d.getTime()
}

export interface InspectorProps {
  session: Session | null
  idle: IdleBlock | null
  dayKey: string
  /** Anchor for manual entries when nothing is selected — the day being viewed. */
  dayAnchor: number
  projects: Project[]
  onApply(request: RecategorizeRequest): void
  onEdit(edit: SessionEdit): Promise<EditResult>
}

/**
 * The correction panel.
 *
 * Automatic capture gets the shape of a day roughly right and the details
 * regularly wrong, so every kind of wrongness needs a fix here: the wrong label
 * (retag), the wrong boundaries (split), a block that should not exist (delete),
 * time the machine could not see (manual entry), and time away that was actually
 * work (claim an away block). Rules learned here are the top-priority layer in
 * the categoriser, so a correction is permanent.
 */
export const Inspector = memo(function Inspector({
  session,
  idle,
  dayKey,
  dayAnchor,
  projects,
  onApply,
  onEdit,
}: InspectorProps) {
  const [category, setCategory] = useState('')
  const [productivity, setProductivity] = useState<Productivity>('neutral')
  const [remember, setRemember] = useState<'none' | 'app' | 'keyword'>('none')
  const [note, setNote] = useState('')
  const [splitAt, setSplitAt] = useState('')
  const [mode, setMode] = useState<'retag' | 'split' | 'manual'>('retag')
  const [manual, setManual] = useState({ start: '', end: '', category: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    setMode('retag')
    if (session) {
      setCategory(session.category)
      setProductivity(session.productivity)
      setNote(session.note || '')
      setSplitAt(toTimeInput(session.startTime + (session.endTime - session.startTime) / 2))
      setRemember('none')
      return
    }
    if (idle) {
      setCategory('')
      setProductivity('productive')
      setNote('')
    }
  }, [session, idle])

  const submit = async (edit: SessionEdit) => {
    setError('')
    const result = await onEdit(edit)
    if (!result.ok) setError(result.message || 'That edit could not be applied.')
  }

  // ── Away block: claim it as work ───────────────────────────────────────────
  if (!session && idle) {
    return (
      <div className="inspector">
        <div className="inspector-head">
          <div className="inspector-title">Away from the keyboard</div>
          <div className="inspector-when">
            {timeOfDay(idle.startTime)} – {timeOfDay(idle.endTime)} ·{' '}
            {duration(idle.durationSeconds)}
          </div>
        </div>

        <div className="hint">
          Time away from the keyboard is not automatically time not working. If this was a meeting,
          a whiteboard or a call, claim it — the away block is replaced, so nothing is counted twice.
        </div>

        <div className="field">
          <label htmlFor="insp-idle-category">Count this as</label>
          <input
            id="insp-idle-category"
            list="opentime-categories"
            placeholder="Meetings"
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

        <div className="row">
          <button
            className="btn primary"
            disabled={!category.trim()}
            onClick={() =>
              void submit({
                kind: 'claim-idle',
                dayKey,
                idleStart: idle.startTime,
                category: category.trim(),
                productivity,
              })
            }
          >
            Claim this time
          </button>
        </div>
        {error ? <div className="inspector-error">{error}</div> : null}
      </div>
    )
  }

  // ── Nothing selected: add time the machine could not see ───────────────────
  if (!session) {
    if (mode !== 'manual') {
      return (
        <div className="inspector">
          <Empty
            glyph={<IconEmptyPointer />}
            title="Nothing selected"
            hint="Pick a block on the timeline to retag, split or delete it — or record time OpenTime could not see."
          />
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn ghost" onClick={() => setMode('manual')}>
              Add time manually
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="inspector">
        <div className="inspector-title">Add time manually</div>
        <div className="hint">
          For work that happened away from this machine — a workshop, a phone call, a whiteboard
          session. It is stored as a manual entry and labelled as one in exports.
        </div>

        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="insp-manual-start">From</label>
            <input
              id="insp-manual-start"
              type="time"
              value={manual.start}
              onChange={(e) => setManual({ ...manual, start: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="insp-manual-end">To</label>
            <input
              id="insp-manual-end"
              type="time"
              value={manual.end}
              onChange={(e) => setManual({ ...manual, end: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="insp-manual-category">Category</label>
          <input
            id="insp-manual-category"
            list="opentime-categories"
            value={manual.category}
            onChange={(e) => setManual({ ...manual, category: e.target.value })}
          />
          <datalist id="opentime-categories">
            {projects.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </div>

        <div className="row">
          <button
            className="btn primary"
            disabled={!manual.start || !manual.end || !manual.category.trim()}
            onClick={() => {
              const start = fromTimeInput(manual.start, dayAnchor)
              const end = fromTimeInput(manual.end, dayAnchor)
              if (start === null || end === null) {
                setError('Those times could not be read.')
                return
              }
              void submit({
                kind: 'manual',
                dayKey,
                startTime: start,
                endTime: end,
                category: manual.category.trim(),
                productivity: 'productive',
              }).then(() => setManual({ start: '', end: '', category: '' }))
            }}
          >
            Add entry
          </button>
          <button className="btn ghost" onClick={() => setMode('retag')}>
            Cancel
          </button>
        </div>
        {error ? <div className="inspector-error">{error}</div> : null}
      </div>
    )
  }

  // ── A session is selected ──────────────────────────────────────────────────
  const dirty =
    category !== session.category ||
    productivity !== session.productivity ||
    note !== (session.note || '')
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
          {session.source === 'manual' ? ' · added by hand' : ''}
          {session.source === 'demo' ? ' · demo data' : ''}
        </div>
      </div>

      {mode === 'split' ? (
        <>
          <div className="field">
            <label htmlFor="insp-split">Split at</label>
            <input
              id="insp-split"
              type="time"
              value={splitAt}
              onChange={(e) => setSplitAt(e.target.value)}
            />
            <div className="hint">
              Both halves keep this block’s label. Retag one of them afterwards.
            </div>
          </div>
          <div className="row">
            <button
              className="btn primary"
              onClick={() => {
                const at = fromTimeInput(splitAt, session.startTime)
                if (at === null) {
                  setError('That time could not be read.')
                  return
                }
                void submit({ kind: 'split', dayKey, sessionId: session.id, at })
              }}
            >
              Split
            </button>
            <button className="btn ghost" onClick={() => setMode('retag')}>
              Cancel
            </button>
          </div>
          {error ? <div className="inspector-error">{error}</div> : null}
        </>
      ) : (
        <>
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
            <label htmlFor="insp-note">Note</label>
            <input
              id="insp-note"
              placeholder="What was this, in your words?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
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
                  note,
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
                setNote(session.note || '')
                setRemember('none')
              }}
            >
              Reset
            </button>
          </div>

          <div className="row inspector-actions">
            <button className="btn ghost small" onClick={() => setMode('split')}>
              Split…
            </button>
            <button
              className="btn ghost danger small"
              onClick={() => void submit({ kind: 'delete', dayKey, sessionId: session.id })}
            >
              Delete block
            </button>
          </div>
          {error ? <div className="inspector-error">{error}</div> : null}
        </>
      )}
    </div>
  )
})
