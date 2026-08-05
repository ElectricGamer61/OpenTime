import { memo, useMemo } from 'react'

import { buildTimeline, positionEvent, timelineWindow } from '../../core/aggregate'
import type { CalendarEvent, IdleBlock, Project, Session } from '../../core/types'
import { blockFill, duration, productivityColor, timeOfDay } from '../lib/format'
import { useNow } from '../state/useOpenTime'
import { Empty } from './Empty'
import { IconEmptyTimeline } from './Icons'

const TRACK_HEIGHT = 620
/** Below this a block cannot fit two lines of text — show the label only. */
const COMPACT_PX = 36
/** Below this even one line would spill past the block — show a colour bar.
    Raising this trades a clipped descender for an unlabelled stripe, which is
    the worse of the two: an anonymous bar tells the reader nothing at all. */
const TINY_PX = 18

interface Props {
  dayKey: string
  dayStartHour: number
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
  projects: Project[]
  selectedId: string | null
  onSelect(session: Session | null): void
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
  selectedId,
  onSelect,
  onSelectIdle,
}: Props) {
  const window = useMemo(
    () => timelineWindow(dayKey, dayStartHour, sessions),
    [dayKey, dayStartHour, sessions]
  )

  const blocks = useMemo(
    () => buildTimeline(sessions, idle, window.start, window.end),
    [sessions, idle, window]
  )

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

        {blocks.map((b) => {
          // One pixel of air between neighbours so adjacent blocks read as
          // separate stretches rather than one continuous slab.
          const height = Math.max(4, b.size * TRACK_HEIGHT - 1)
          const accent =
            b.kind === 'idle' ? '#3a465a' : productivityColor(b.productivity)
          const session = b.kind === 'session' ? sessions.find((s) => s.id === b.id) : null
          const block = b.kind === 'idle' ? idle.find((i) => i.startTime === b.start) : null
          const describe = `${b.label} · ${duration(b.durationSeconds)} · ${timeOfDay(b.start)}–${timeOfDay(b.end)}`
          const select = () => {
            onSelect(session ?? null)
            onSelectIdle?.(block ?? null)
          }
          return (
            <div
              key={b.id}
              className={`block${b.kind === 'idle' ? ' idle' : ''}${
                selectedId === b.id ? ' selected' : ''
              }`}
              style={{
                top: b.offset * TRACK_HEIGHT,
                height,
                background: b.kind === 'idle' ? undefined : blockFill(projectColorFor(b.label)),
                borderLeftColor: accent,
              }}
              role="button"
              tabIndex={0}
              aria-label={describe}
              onClick={select}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault() // Space must activate, not scroll the page.
                select()
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
