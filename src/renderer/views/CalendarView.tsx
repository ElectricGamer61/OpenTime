import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { summarizeDay } from '../../core/aggregate'
import { dayKey, dayStartTs, parseYmdLocal, formatYmdLocal } from '../../core/day'
import type { IdleBlock, Session } from '../../core/types'
import type { RangeKind } from '../../core/range'
import type { Slice } from '../components/Charts'
import { DayGrid } from '../components/DayGrid'
import { EntryPopover } from '../components/EntryPopover'
import {
  IconApps,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconInfo,
  IconList,
} from '../components/Icons'
import { Inspector } from '../components/Inspector'
import { RefreshButton } from '../components/RefreshButton'
import { SummaryPanel } from '../components/SummaryPanel'
import type { DayEntry, GroupMode } from '../lib/entries'
import { datedTitle } from '../lib/format'
import { categoryColors, RESERVED_COLORS } from '../lib/palette'
import type { OpenTimeState } from '../state/useOpenTime'

/** The grid's grouping tabs. "Entries" is the ungrouped-by-anything default. */
const TABS: Array<{ id: GroupMode; label: string; Icon: typeof IconList }> = [
  { id: 'category', label: 'Time entries', Icon: IconList },
  { id: 'project', label: 'Projects', Icon: IconFolder },
  { id: 'app', label: 'Apps', Icon: IconApps },
]

/**
 * Ranges the reporting layer can produce.
 *
 * Every one of these is built now. Day is this view; the rest hand off to
 * Reports, which owns the range arithmetic. The previous pass rendered Month
 * and Year disabled so the missing view was visible rather than pretended away
 * — that gap is closed, so the buttons work.
 */
const RANGES: Array<{ id: 'day' | RangeKind; label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
]

function shiftDayKey(key: string, days: number): string {
  const d = parseYmdLocal(key)
  d.setDate(d.getDate() + days)
  return formatYmdLocal(d)
}

/**
 * The day calendar: an hour grid of everything that happened, with the day's
 * numbers pinned beside it.
 *
 * This view owns two pieces of state the rest of the app does not care about —
 * which grouping the grid is drawn by, and which block is open — and derives
 * everything else from the single day payload the data hook already holds.
 */
export function CalendarView({
  app,
  onCustomize,
  onOpenReports,
}: {
  app: OpenTimeState
  onCustomize(): void
  onOpenReports(kind: RangeKind): void
}) {
  const [mode, setMode] = useState<GroupMode>('category')
  const [open, setOpen] = useState<{ entry: DayEntry; anchor: DOMRect } | null>(null)
  const [editing, setEditing] = useState<{ session: Session | null; idle: IdleBlock | null } | null>(
    null
  )
  const day = app.day
  const settings = app.settings

  const summary = useMemo(
    () => summarizeDay(day?.dayKey || '', day?.sessions || [], day?.idle || [], day?.events || []),
    [day]
  )

  const weekSummaries = useMemo(
    () => app.week.map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events)),
    [app.week]
  )

  const previous = useMemo(() => {
    if (!day) return null
    const key = shiftDayKey(day.dayKey, -1)
    const found = app.week.find((d) => d.dayKey === key)
    return found ? summarizeDay(found.dayKey, found.sessions, found.idle, found.events) : null
  }, [app.week, day])

  /** Donut slices for whichever grouping the tabs are on. */
  const slices = useMemo<Slice[]>(() => {
    if (!day) return []
    const projectNames = new Map(app.projects.map((p) => [p.id, p.name]))
    const totals = new Map<string, number>()
    if (mode === 'category') for (const b of summary.byCategory) totals.set(b.key, b.seconds)
    else if (mode === 'app') for (const b of summary.byApp) totals.set(b.key, b.seconds)
    else {
      for (const s of day.sessions) {
        const name = (s.projectId && projectNames.get(s.projectId)) || 'No project'
        totals.set(name, (totals.get(name) || 0) + s.durationSeconds)
      }
    }
    const names = [...totals.keys()].sort()
    const colors = categoryColors(app.projects, names)
    return names.map((name) => ({
      key: name,
      label: name,
      seconds: totals.get(name) || 0,
      color: colors.get(name) || RESERVED_COLORS.uncategorized,
    }))
  }, [day, summary, mode, app.projects])

  /** The open entry's colour, so the popover matches the block it came from. */
  const openColor = useMemo(() => {
    if (!open) return RESERVED_COLORS.uncategorized
    if (open.entry.kind === 'away') return RESERVED_COLORS.away
    if (open.entry.kind === 'event') return RESERVED_COLORS.meeting
    return slices.find((s) => s.key === open.entry.label)?.color || RESERVED_COLORS.uncategorized
  }, [open, slices])

  const closeAll = useCallback(() => {
    setOpen(null)
    setEditing(null)
  }, [])

  // Selection belongs to a day. Leaving it open across a date change would show
  // a card describing a block that is no longer on screen.
  useEffect(() => closeAll(), [day?.dayKey, mode, closeAll])

  if (!day || !settings) return null

  const todayKey = dayKey(Date.now(), settings.dayStartHour)
  const isToday = day.dayKey === todayKey
  const dayStart = dayStartTs(day.dayKey, settings.dayStartHour)

  const deleteEntry = async () => {
    if (!open) return
    for (const session of open.entry.sessions) {
      await app.editSession({ kind: 'delete', dayKey: day.dayKey, sessionId: session.id })
    }
    closeAll()
  }

  return (
    <div className="calendar">
      <section className="calendar-main">
        <div className="grid-tabs">
          <div className="tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`tab${mode === tab.id ? ' on' : ''}`}
                onClick={() => setMode(tab.id)}
              >
                <tab.Icon size={14} />
                {tab.label}
              </button>
            ))}
          </div>
          <RefreshButton onRefresh={() => void app.refresh()} />
        </div>

        <div className="grid-datebar">
          <h1 className="grid-date">{datedTitle(dayStart)}</h1>
          <div className="grid-datenav">
            <div className="seg range-seg">
              {RANGES.map((range) => (
                <button
                  key={range.id}
                  className={range.id === 'day' ? 'on' : ''}
                  title={`${range.label} view`}
                  /* Day is already here; everything wider is Reports. */
                  onClick={
                    range.id === 'day'
                      ? undefined
                      : () => onOpenReports(range.id as RangeKind)
                  }
                >
                  {range.label}
                </button>
              ))}
            </div>
            <button
              className="icon-btn"
              title="Jump to today"
              onClick={() => app.selectDay(todayKey)}
              disabled={isToday}
            >
              <IconCalendar size={15} />
            </button>
            <button
              className="icon-btn"
              title="Previous day"
              onClick={() => app.selectDay(shiftDayKey(day.dayKey, -1))}
            >
              <IconChevronLeft size={15} />
            </button>
            <button
              className="icon-btn"
              title="Next day"
              onClick={() => app.selectDay(shiftDayKey(day.dayKey, 1))}
              disabled={isToday}
            >
              <IconChevronRight size={15} />
            </button>
          </div>
        </div>

        {app.captureNotice ? (
          <div className="notice">
            <IconInfo />
            <div>
              <strong>Showing generated activity.</strong> {app.captureNotice} Every block below ran
              through the same tracking engine real capture feeds — only the window samples are
              synthetic, and Settings can remove them.
            </div>
          </div>
        ) : app.capture?.notice ? (
          <div className="notice">
            <IconInfo />
            <div>
              <strong>Capture is limited.</strong> {app.capture.notice}{' '}
              <button className="btn ghost small" onClick={() => void app.reloadCapture()}>
                Check again
              </button>
            </div>
          </div>
        ) : null}

        <div className="grid-scroll">
          <DayGrid
            dayKey={day.dayKey}
            dayStartHour={settings.dayStartHour}
            sessions={day.sessions}
            idle={day.idle}
            events={day.events}
            projects={app.projects}
            mode={mode}
            selectedId={open?.entry.id ?? null}
            onSelect={(entry, anchor) =>
              setOpen(entry && anchor ? { entry, anchor } : null)
            }
          />
        </div>
      </section>

      <SummaryPanel
        summary={summary}
        previous={previous}
        week={weekSummaries}
        goals={app.goals}
        dayStart={dayStart}
        isToday={isToday}
        mode={mode}
        slices={slices}
        onMode={setMode}
        onCustomize={onCustomize}
      />

      {open ? (
        <EntryPopover
          entry={open.entry}
          anchor={open.anchor}
          color={openColor}
          dayTotalSeconds={summary.totalSeconds}
          onClose={closeAll}
          onEdit={() =>
            setEditing({
              // The correction panel works on one session; for a folded entry
              // that is the longest of them, which is the one a correction is
              // almost always aimed at.
              session:
                [...open.entry.sessions].sort((a, b) => b.durationSeconds - a.durationSeconds)[0] ??
                null,
              idle:
                open.entry.kind === 'away'
                  ? day.idle.find((b) => b.startTime === open.entry.start) ?? null
                  : null,
            })
          }
          onDelete={() => void deleteEntry()}
        />
      ) : null}

      {/* Portalled for the same reason as the popover — see the note there. */}
      {editing ? (
        createPortal(
        <div className="drawer-scrim" onClick={closeAll}>
          <div
            className="drawer"
            role="dialog"
            aria-label="Review this block"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <h2>Review</h2>
              <button className="icon-btn" onClick={closeAll} title="Close">
                <IconClose size={16} />
              </button>
            </div>
            <Inspector
              session={editing.session}
              idle={editing.idle}
              dayKey={day.dayKey}
              dayAnchor={dayStart + 8 * 3600_000}
              projects={app.projects}
              onApply={(request) => {
                void app.recategorize(request)
                closeAll()
              }}
              onEdit={async (edit) => {
                const result = await app.editSession(edit)
                if (result.ok) closeAll()
                return result
              }}
            />
          </div>
        </div>,
        document.body
        )
      ) : null}
    </div>
  )
}
