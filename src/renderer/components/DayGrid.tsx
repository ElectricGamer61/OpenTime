import { memo, useMemo } from 'react'

import { dayStartTs } from '../../core/day'
import type { CalendarEvent, IdleBlock, Project, Session } from '../../core/types'
import type { DayEntry, GroupMode } from '../lib/entries'
import { assignLanes, buildEntries } from '../lib/entries'
import { duration, timeOfDay } from '../lib/format'
import { categoryColors, edgeOn, inkOn, RESERVED_COLORS, rgba, subInkOn } from '../lib/palette'
import { useNow } from '../state/useOpenTime'
import { Empty } from './Empty'
import { IconEmptyTimeline } from './Icons'

/**
 * Pixels per hour.
 *
 * Set by the shortest block that still has to be legible rather than by how
 * much of the day fits on screen: at 96px an hour, a ten-minute stretch is 16px
 * and still carries its label. Dropping to 68 turned every short session into
 * an anonymous stripe, which tells the reader nothing at all.
 */
const HOUR_PX = 96
/** Columns the grid will draw before the smallest groups start sharing one. */
const MAX_LANES = 5
/** Below this a block cannot fit its time range; below the last, no text at all. */
const ROOMY_PX = 62
const COMPACT_PX = 38
const TINY_PX = 17

export interface DayGridProps {
  dayKey: string
  dayStartHour: number
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
  projects: Project[]
  mode: GroupMode
  selectedId: string | null
  onSelect(entry: DayEntry | null, anchor: DOMRect | null): void
}

/** Whole-hour bounds around everything the day contains, with an hour of air. */
function hourWindow(
  dayKey: string,
  dayStartHour: number,
  entries: DayEntry[]
): { start: number; end: number } {
  const anchor = dayStartTs(dayKey, dayStartHour)
  const floorHour = (ts: number) => {
    const d = new Date(ts)
    d.setMinutes(0, 0, 0)
    return d.getTime()
  }
  if (!entries.length) {
    // A readable working window rather than a mostly-empty twenty-four hours.
    return { start: floorHour(anchor) + 8 * 3600_000, end: floorHour(anchor) + 20 * 3600_000 }
  }
  const first = Math.min(...entries.map((e) => e.start))
  const last = Math.max(...entries.map((e) => e.end))
  return {
    start: floorHour(first) - 3600_000,
    end: floorHour(last) + 2 * 3600_000,
  }
}

/**
 * The day grid.
 *
 * An hour ruler down the left, one column per group of work, and a rounded
 * block for every entry positioned by the clock. Geometry is a multiply — there
 * is no measurement pass and no resize observer, which is what keeps a scroll
 * through a busy day free of layout work.
 */
export const DayGrid = memo(function DayGrid({
  dayKey,
  dayStartHour,
  sessions,
  idle,
  events,
  projects,
  mode,
  selectedId,
  onSelect,
}: DayGridProps) {
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  const layout = useMemo(() => {
    const entries = buildEntries(sessions, { mode, projectNames, idle, events })
    return assignLanes(entries, MAX_LANES)
  }, [sessions, idle, events, mode, projectNames])

  const colors = useMemo(() => {
    const labels = layout.entries.filter((e) => e.kind === 'session').map((e) => e.label)
    return categoryColors(projects, [...new Set(labels)].sort())
  }, [layout, projects])

  const colorOf = (entry: DayEntry) => {
    if (entry.kind === 'away') return RESERVED_COLORS.away
    if (entry.kind === 'event') return RESERVED_COLORS.meeting
    return colors.get(entry.label) || RESERVED_COLORS.uncategorized
  }

  const window = useMemo(
    () => hourWindow(dayKey, dayStartHour, layout.entries),
    [dayKey, dayStartHour, layout]
  )

  const hours = useMemo(() => {
    const out: number[] = []
    for (let ts = window.start; ts <= window.end; ts += 3600_000) out.push(ts)
    return out
  }, [window])

  // A minute of resolution is all the "you are here" line can show, so it
  // re-renders once a minute rather than once a second.
  const now = useNow(60_000)
  const nowTop =
    now >= window.start && now <= window.end
      ? ((now - window.start) / 3600_000) * HOUR_PX
      : null

  if (!sessions.length && !idle.length && !events.length) {
    return (
      <div className="daygrid-empty">
        <Empty
          glyph={<IconEmptyTimeline />}
          title="Nothing tracked for this day"
          hint="Once OpenTime sees window activity, your day fills in here automatically."
        />
      </div>
    )
  }

  const lanes = layout.laneCount
  const trackHeight = (hours.length - 1) * HOUR_PX

  return (
    <div className="daygrid">
      <div className="daygrid-ruler" style={{ height: trackHeight + HOUR_PX / 2 }}>
        {hours.map((ts, index) => (
          <span className="daygrid-hour" key={ts} style={{ top: index * HOUR_PX }}>
            {timeOfDay(ts)}
          </span>
        ))}
      </div>

      <div className="daygrid-track" style={{ height: trackHeight + HOUR_PX / 2 }}>
        {hours.map((ts, index) => (
          <div className="daygrid-line" key={ts} style={{ top: index * HOUR_PX }} />
        ))}

        {nowTop !== null ? (
          <div className="daygrid-now" style={{ top: nowTop }} aria-hidden="true" />
        ) : null}

        {layout.entries.map((entry) => {
          const top = ((entry.start - window.start) / 3600_000) * HOUR_PX
          const span = ((entry.end - entry.start) / 3600_000) * HOUR_PX
          // A pixel of air between neighbours so two touching blocks read as
          // two stretches rather than one slab.
          const height = Math.max(18, span - 2)
          const color = colorOf(entry)
          const selected = selectedId === entry.id
          // Which text line, if any, shares the bottom row with the pinned
          // duration. Only that line reserves clearance for it — see the
          // .pad-range / .pad-apps rules.
          const padRange = height >= COMPACT_PX && height < 56
          const padApps = height >= ROOMY_PX && height < 68 && entry.apps.length > 0

          return (
            <button
              key={entry.id}
              /* A short block gets tighter type and padding rather than losing
                 its label: an unnamed stripe tells the reader nothing. */
              className={`entry ${entry.kind}${height < COMPACT_PX ? ' slim' : ''}${
                padRange ? ' pad-range' : ''
              }${padApps ? ' pad-apps' : ''}${selected ? ' selected' : ''}`}
              style={{
                top,
                height,
                /* A symmetric 3px gutter each side — the old 2/4 split made
                   every lane look a pixel off its neighbour. */
                left: `calc(${(entry.lane / lanes) * 100}% + 3px)`,
                width: `calc(${100 / lanes}% - 6px)`,
                '--fill': color,
                '--edge': edgeOn(color),
                '--ink': inkOn(color),
                '--sub-ink': subInkOn(color),
                '--glow': rgba(color, 0.4),
              } as React.CSSProperties}
              onClick={(e) => onSelect(entry, e.currentTarget.getBoundingClientRect())}
              title={`${entry.label} · ${timeOfDay(entry.start)}–${timeOfDay(entry.end)} · ${duration(
                entry.seconds
              )}`}
            >
              <i className="entry-edge" aria-hidden="true" />
              {height >= TINY_PX ? <span className="entry-title">{entry.label}</span> : null}
              {height >= COMPACT_PX ? (
                <span className="entry-range">
                  {timeOfDay(entry.start)} - {timeOfDay(entry.end)}
                </span>
              ) : null}
              {height >= ROOMY_PX && entry.apps.length ? (
                <span className="entry-apps">{entry.apps.map((a) => a.name).join(' · ')}</span>
              ) : null}
              {height >= COMPACT_PX ? (
                <span className="entry-duration">{duration(entry.seconds)}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
})
