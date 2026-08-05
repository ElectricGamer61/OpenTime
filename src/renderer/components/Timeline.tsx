import { memo, useMemo, useState } from 'react'

import { buildTimeline, positionEvent, timelineWindow } from '../../core/aggregate'
import type { CalendarEvent, IdleBlock, Project, Session } from '../../core/types'
import { blockFill, duration, productivityColor, timeOfDay } from '../lib/format'
import { useNow } from '../state/useOpenTime'
import { Empty } from './Empty'
import { IconEmptyTimeline } from './Icons'

const TRACK_HEIGHT = 660
/** Below this a block cannot fit two lines of text — show the label only. */
const COMPACT_PX = 34
/**
 * Below this even one line of label would spill past the block, so it renders
 * as a deliberate tick instead. This is also the clustering threshold: leaving
 * a gap between the two produced blocks big enough to escape a cluster but too
 * small to label — an empty tinted box, which reads as a rendering fault.
 */
const TINY_PX = 17
/** Only collapse a run once it is actually a run. */
const MIN_CLUSTER = 2
/** Every block keeps a clickable minimum, cluster or not. */
const MIN_BLOCK_PX = 4

interface Props {
  dayKey: string
  dayStartHour: number
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
  projects: Project[]
  /** Every selected session id — more than one is a pending merge. */
  selectedIds: string[]
  /** `additive` is a ctrl/cmd/shift click: extend the selection to merge. */
  onSelect(session: Session | null, additive: boolean): void
  /** Away blocks are selectable too — claiming one is a real correction. */
  onSelectIdle?(block: IdleBlock | null): void
}

/**
 * The day timeline with the calendar overlaid beside it.
 *
 * All geometry comes from `buildTimeline`, which returns fractional offsets —
 * this component only multiplies by a pixel height. No layout measurement, no
 * per-frame work.
 */
export const Timeline = memo(function Timeline({
  dayKey,
  dayStartHour,
  sessions,
  idle,
  events,
  projects,
  selectedIds,
  onSelect,
  onSelectIdle,
}: Props) {
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const window = useMemo(
    () => timelineWindow(dayKey, dayStartHour, sessions),
    [dayKey, dayStartHour, sessions]
  )

  const blocks = useMemo(
    () => buildTimeline(sessions, idle, window.start, window.end),
    [sessions, idle, window]
  )

  /** Ids of clusters the reader has opened up. */
  const [expanded, setExpanded] = useState<string[]>([])

  /**
   * Group runs of unreadably short blocks into one band.
   *
   * A busy hour of quick context switches renders as a dozen 4px stripes: no
   * label fits, none is clickable, and the eye reads the whole hour as a
   * rendering fault rather than as what it is. Collapsing the run into a single
   * band labelled with its count and total says *more* than the stripes did,
   * and clicking it puts the real blocks back — so nothing is hidden, only
   * folded.
   */
  const rows = useMemo(() => {
    type Row =
      | { kind: 'block'; block: (typeof blocks)[number]; height: number; top: number }
      | {
          kind: 'cluster'
          id: string
          top: number
          height: number
          members: typeof blocks
          seconds: number
        }

    const out: Row[] = []
    const px = (b: (typeof blocks)[number]) => Math.max(MIN_BLOCK_PX, b.size * TRACK_HEIGHT - 1)

    for (let i = 0; i < blocks.length; ) {
      if (px(blocks[i]) >= TINY_PX) {
        out.push({ kind: 'block', block: blocks[i], height: px(blocks[i]), top: blocks[i].offset * TRACK_HEIGHT })
        i += 1
        continue
      }
      let j = i
      while (j < blocks.length && px(blocks[j]) < TINY_PX) j += 1
      const run = blocks.slice(i, j)
      const id = `cl_${run[0].id}`
      if (run.length < MIN_CLUSTER || expanded.includes(id)) {
        for (const b of run) out.push({ kind: 'block', block: b, height: px(b), top: b.offset * TRACK_HEIGHT })
      } else {
        const top = run[0].offset * TRACK_HEIGHT
        const end = run[run.length - 1].offset * TRACK_HEIGHT + px(run[run.length - 1])
        out.push({
          kind: 'cluster',
          id,
          top,
          // The band must be tall enough to read even when the run it stands
          // for is thinner than its own label.
          height: Math.max(20, end - top),
          members: run,
          seconds: run.reduce((sum, b) => sum + b.durationSeconds, 0),
        })
      }
      i = j
    }
    return out
  }, [blocks, expanded])

  // Project colour identifies *what* the block was; productivity colour says
  // how it counted. Both are needed, so they get separate visual channels.
  const projectColorFor = useMemo(() => {
    const byName = new Map(projects.map((p) => [p.name, p.color]))
    return (label: string) => byName.get(label) || '#64748b'
  }, [projects])

  // Whole hours carry the labels; half hours get a much fainter rule so the
  // eye can judge a 20-minute block without counting pixels.
  const hours = useMemo(() => {
    const out: Array<{ ts: number; offset: number; half: boolean }> = []
    const span = window.end - window.start
    const first = new Date(window.start)
    first.setMinutes(0, 0, 0)
    for (let ts = first.getTime(); ts <= window.end; ts += 1800_000) {
      if (ts < window.start) continue
      out.push({ ts, offset: (ts - window.start) / span, half: new Date(ts).getMinutes() === 30 })
    }
    return out
  }, [window])

  // A minute of resolution is all the "you are here" line can show, so it
  // re-renders once a minute rather than once a second.
  const now = useNow(60_000)
  const nowOffset =
    now >= window.start && now <= window.end ? (now - window.start) / (window.end - window.start) : null

  const positionedEvents = useMemo(
    () =>
      events
        .filter((e) => !e.allDay && e.end > window.start && e.start < window.end)
        .map((e) => ({ event: e, ...positionEvent(e, window.start, window.end) })),
    [events, window]
  )

  if (!sessions.length && !idle.length) {
    return (
      <Empty
        glyph={<IconEmptyTimeline />}
        title="Nothing tracked for this day"
        hint="Once OpenTime sees window activity, your day fills in here automatically."
      />
    )
  }

  return (
    <div className="timeline" style={{ height: TRACK_HEIGHT }}>
      <div className="timeline-hours">
        {hours
          .filter((h) => !h.half)
          .map((h) => (
            <div className="hour-tick" key={h.ts} style={{ top: h.offset * TRACK_HEIGHT }}>
              {timeOfDay(h.ts)}
            </div>
          ))}
      </div>

      <div className="timeline-track">
        {hours.map((h) => (
          <div
            className={`hour-line${h.half ? ' half' : ''}`}
            key={h.ts}
            style={{ top: h.offset * TRACK_HEIGHT }}
          />
        ))}

        {nowOffset !== null ? (
          <div className="now-line" style={{ top: nowOffset * TRACK_HEIGHT }} aria-hidden="true" />
        ) : null}

        {rows.map((row) => {
          if (row.kind === 'cluster') {
            const label = `${row.members.length} short blocks · ${duration(row.seconds)}`
            return (
              <div
                key={row.id}
                className="block cluster"
                style={{ top: row.top, height: row.height }}
                role="button"
                tabIndex={0}
                aria-label={`${label}. Activate to show them individually.`}
                title={`${label} — click to expand`}
                onClick={() => setExpanded((prev) => [...prev, row.id])}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  setExpanded((prev) => [...prev, row.id])
                }}
              >
                {/* A few ticks in the members' own colours, so the band still
                    says what kind of time it stands for. */}
                <span className="cluster-ticks" aria-hidden="true">
                  {row.members.slice(0, 5).map((m) => (
                    <i
                      key={m.id}
                      style={{
                        background:
                          m.kind === 'idle' ? 'var(--idle-line)' : projectColorFor(m.label),
                      }}
                    />
                  ))}
                </span>
                {row.height >= TINY_PX ? <span className="cluster-text">{label}</span> : null}
              </div>
            )
          }

          const b = row.block
          const height = row.height
          const accent = b.kind === 'idle' ? undefined : productivityColor(b.productivity)
          const session = b.kind === 'session' ? sessions.find((s) => s.id === b.id) : null
          const block = b.kind === 'idle' ? idle.find((i) => i.startTime === b.start) : null
          const describe = `${b.label} · ${duration(b.durationSeconds)} · ${timeOfDay(b.start)}–${timeOfDay(b.end)}`
          const select = (additive: boolean) => {
            onSelect(session ?? null, additive)
            // An additive pick is building a merge set; clearing the away block
            // then would drop the panel back to a single-block view.
            if (!additive || !session) onSelectIdle?.(block ?? null)
          }
          // Too short for a label: a pale empty box reads as a rendering fault,
          // whereas a solid rounded tick reads as a deliberate mark. Only ever
          // a lone short block — a run of them is a cluster by now.
          const tick = height < TINY_PX
          return (
            <div
              key={b.id}
              className={`block${b.kind === 'idle' ? ' idle' : ''}${tick ? ' tick' : ''}${
                selected.has(b.id) ? ' selected' : ''
              }`}
              style={{
                top: row.top,
                height,
                background:
                  b.kind === 'idle'
                    ? undefined
                    : tick
                      ? projectColorFor(b.label)
                      : blockFill(projectColorFor(b.label)),
                // The rail is a pseudo-element, so the productivity colour is
                // handed to CSS as a variable rather than a border.
                ['--block-rail' as string]: accent,
              }}
              role="button"
              tabIndex={0}
              aria-label={describe}
              onClick={(e) => select(e.ctrlKey || e.metaKey || e.shiftKey)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault() // Space must activate, not scroll the page.
                select(e.ctrlKey || e.metaKey || e.shiftKey)
              }}
              title={describe}
            >
              {height >= TINY_PX ? <div className="block-label">{b.label}</div> : null}
              {height >= COMPACT_PX ? (
                <div className="block-sub">
                  {duration(b.durationSeconds)} · {b.sublabel}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div>
        <div className="timeline-col-head">Calendar</div>
        <div className="timeline-events" style={{ height: TRACK_HEIGHT }}>
          {positionedEvents.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Nothing scheduled.
            </div>
          ) : (
            positionedEvents.map(({ event, offset, size }) => {
              const height = Math.max(18, size * TRACK_HEIGHT)
              return (
                <div
                  key={event.id}
                  className="event"
                  style={{ top: offset * TRACK_HEIGHT, height }}
                  title={`${event.title} · ${timeOfDay(event.start)}–${timeOfDay(event.end)}`}
                >
                  <div className="event-title">{event.title}</div>
                  {/* Same rule as session blocks: a second line that cannot fit
                      is clipped mid-letter, which reads as a rendering bug. The
                      hover title still carries the times. */}
                  {height >= COMPACT_PX ? (
                    <div className="event-time">
                      {timeOfDay(event.start)} – {timeOfDay(event.end)}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
})
