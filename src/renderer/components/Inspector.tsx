import { memo, useEffect, useState } from 'react'

import { timeWithinDay } from '../../core/day'
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

export interface InspectorProps {
  /** The block being edited — the last one clicked. */
  session: Session | null
  /** Every selected session; two or more unlocks merging. */
  selection: Session[]
  idle: IdleBlock | null
  dayKey: string
  /** Rollover hour, so an entered time lands on the right tracking day. */
  dayStartHour: number
  projects: Project[]
  onApply(request: RecategorizeRequest): void
  onEdit(edit: SessionEdit): Promise<EditResult>
}

/**
 * The correction panel.
 *
 * Automatic capture gets the shape of a day roughly right and the details
 * regularly wrong, so every kind of wrongness needs a fix here: the wrong label
 * (retag), the wrong boundaries (split or retime), a block that should not exist
 * (delete), two blocks that were really one (merge), time the machine could not
 * see (manual entry), and time away that was actually work (claim an away
 * block). Rules learned here are the top-priority layer in the categoriser, so a
 * correction is permanent.
 */
export const Inspector = memo(function Inspector({
  session,
  selection,
  idle,
  dayKey,
  dayStartHour,
  projects,
  onApply,
  onEdit,
}: InspectorProps) {
  const [category, setCategory] = useState('')
  const [productivity, setProductivity] = useState<Productivity>('neutral')
  const [remember, setRemember] = useState<'none' | 'app' | 'keyword'>('none')
  const [note, setNote] = useState('')
  const [splitAt, setSplitAt] = useState('')
  const [times, setTimes] = useState({ start: '', end: '' })
  const [mode, setMode] = useState<'retag' | 'split' | 'retime' | 'manual'>('retag')
  const [manual, setManual] = useState({ start: '', end: '', category: '' })
  const [error, setError] = useState('')

  /**
   * Read `HH:MM` back onto the tracking day being edited.
   *
   * A tracking day runs from the rollover hour through to the same hour the next
   * morning, so `timeWithinDay` is what puts a 1am correction on the day the UI
   * is showing rather than 23 hours away on the previous one.
   */
  const fromTimeInput = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!match) return null
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 23 || minutes > 59) return null
    return timeWithinDay(dayKey, hours, minutes, dayStartHour)
  }

  useEffect(() => {
    setError('')
    setMode('retag')
    if (session) {
      setCategory(session.category)
      setProductivity(session.productivity)
      setNote(session.note || '')
      setSplitAt(toTimeInput(session.startTime + (session.endTime - session.startTime) / 2))
      setTimes({ start: toTimeInput(session.startTime), end: toTimeInput(session.endTime) })
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

  // ── Two or more blocks picked: merge them ──────────────────────────────────
  if (selection.length > 1) {
    const sorted = [...selection].sort((a, b) => a.startTime - b.startTime)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const spanSeconds = Math.round((last.endTime - first.startTime) / 1000)
    const trackedSeconds = sorted.reduce((sum, s) => sum + s.durationSeconds, 0)
    const absorbed = spanSeconds - trackedSeconds

    return (
      <div className="inspector">
        <div className="inspector-head">
          <div className="inspector-title">{selection.length} blocks selected</div>
          <div className="inspector-when">
            {timeOfDay(first.startTime)} – {timeOfDay(last.endTime)} · {duration(spanSeconds)}
          </div>
        </div>

        <div className="hint">
          Merging keeps the label of the longest block and spans from the first start to the last
          end.
          {/* Absorbing a gap adds time that was never observed, so it has to be
              stated before the click rather than discovered in the totals. */}
          {absorbed > 30 ? (
            <>
              {' '}
              The gaps between them — <b>{duration(absorbed)}</b> — are absorbed into the merged
              block.
            </>
          ) : null}
        </div>

        <div className="merge-list">
          {sorted.map((s) => (
            <div className="merge-item" key={s.id}>
              <span className="merge-item-name">{s.category}</span>
              <span className="merge-item-time">
                {timeOfDay(s.startTime)} · {duration(s.durationSeconds)}
              </span>
            </div>
          ))}
        </div>

        <div className="row">
          <button
            className="btn primary"
            onClick={() =>
              void submit({ kind: 'merge', dayKey, sessionIds: sorted.map((s) => s.id) })
            }
          >
            Merge into one block
          </button>
        </div>
        {error ? <div className="inspector-error">{error}</div> : null}
      </div>
    )
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
            hint="Pick a block on the timeline to retag, retime, split or delete it. Ctrl-click a second block to merge them — or record time OpenTime could not see."
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
              const start = fromTimeInput(manual.start)
              const end = fromTimeInput(manual.end)
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
                const at = fromTimeInput(splitAt)
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
      ) : mode === 'retime' ? (
        <>
          <div className="hint">
            Move the boundaries when the capture caught the wrong moment — a meeting that started
            before you opened the laptop, or a block that ran on after you stopped.
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="insp-retime-start">From</label>
              <input
                id="insp-retime-start"
                type="time"
                value={times.start}
                onChange={(e) => setTimes({ ...times, start: e.target.value })}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="insp-retime-end">To</label>
              <input
                id="insp-retime-end"
                type="time"
                value={times.end}
                onChange={(e) => setTimes({ ...times, end: e.target.value })}
              />
            </div>
          </div>
          <div className="row">
            <button
              className="btn primary"
              onClick={() => {
                const start = fromTimeInput(times.start)
                const end = fromTimeInput(times.end)
                if (start === null || end === null) {
                  setError('Those times could not be read.')
                  return
                }
                void submit({
                  kind: 'retime',
                  dayKey,
                  sessionId: session.id,
                  startTime: start,
                  endTime: end,
                })
              }}
            >
              Save times
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
            <button className="btn ghost small" onClick={() => setMode('retime')}>
              Retime…
            </button>
            <button
              className="btn ghost danger small"
              onClick={() => void submit({ kind: 'delete', dayKey, sessionId: session.id })}
            >
              Delete block
            </button>
          </div>
          <div className="inspector-tip">
            Ctrl-click another block on the timeline to merge it with this one.
          </div>
          {error ? <div className="inspector-error">{error}</div> : null}
        </>
      )}
    </div>
  )
})
