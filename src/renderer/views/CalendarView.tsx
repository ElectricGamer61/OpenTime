import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { DaySummary } from '../../core/aggregate'
import { summarizeDay } from '../../core/aggregate'
import { dayKey, dayStartTs, parseYmdLocal, formatYmdLocal } from '../../core/day'
import { rangeFor, rangeLabel, type RangeKind } from '../../core/range'
import type { IdleBlock, Session } from '../../core/types'
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
import { datedTitle, duration, weekdayShort } from '../lib/format'
import { categoryColors, RESERVED_COLORS } from '../lib/palette'
import type { OpenTimeState } from '../state/useOpenTime'

/** The grid's grouping tabs. "Entries" is the ungrouped-by-anything default. */
const TABS: Array<{ id: GroupMode; label: string; Icon: typeof IconList }> = [
  { id: 'category', label: 'Time entries', Icon: IconList },
  { id: 'project', label: 'Projects', Icon: IconFolder },
  { id: 'app', label: 'Apps', Icon: IconApps },
]

/**
 * Ranges this bar can switch to.
 *
 * Day and Week both stay on this view — Week swaps the hour grid for a strip
 * of the trailing seven days, and picking one drops straight back to Day. A
 * bug report is exactly what happens if this ever regresses: Week used to
 * hand off to Reports like Month and Year still do, which meant clicking it
 * silently left the calendar for an unrelated section of the app. Month and
 * Year are real periods with their own layouts (a calendar grid, a heat
 * grid) that this view has no room for, so those still open in Reports, and
 * say so in their tooltip.
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
  /** Day shows the hour grid below; week swaps it for a strip of the trailing seven days. Never leaves this view. */
  const [rangeMode, setRangeMode] = useState<'day' | 'week'>('day')
  const [open, setOpen] = useState<{ entry: DayEntry; anchor: DOMRect } | null>(null)
  const [editing, setEditing] = useState<{
    session: Session | null
    idle: IdleBlock | null
    /**
     * Every session the correction applies to. One entry is the ordinary case;
     * two or more is a merge, and is only ever built by ctrl-clicking, because
     * a folded entry opening straight into "merge these" would put the retag
     * flow — the one people actually use — behind an extra click.
     */
    selection: Session[]
    /** The entry ids behind `selection`, so the grid can draw them as held. */
    entryIds: string[]
  } | null>(null)
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

  /** Held-for-merge entries, only worth drawing once there are two of them. */
  const pickedIds = useMemo(
    () => new Set(editing && editing.selection.length > 1 ? editing.entryIds : []),
    [editing]
  )

  const closeAll = useCallback(() => {
    setOpen(null)
    setEditing(null)
  }, [])

  // Selection belongs to a day. Leaving it open across a date change, or
  // across switching to the week strip (which has no entries to select at
  // all), would show a card describing a block that is no longer on screen.
  useEffect(() => closeAll(), [day?.dayKey, mode, rangeMode, closeAll])

  if (!day || !settings) return null

  const todayKey = dayKey(Date.now(), settings.dayStartHour)
  const isToday = day.dayKey === todayKey
  const dayStart = dayStartTs(day.dayKey, settings.dayStartHour)

  /** The longest session in an entry — the one a correction almost always means. */
  const primaryOf = (entry: DayEntry): Session | null =>
    [...entry.sessions].sort((a, b) => b.durationSeconds - a.durationSeconds)[0] ?? null

  const idleOf = (entry: DayEntry): IdleBlock | null =>
    entry.kind === 'away' ? day.idle.find((b) => b.startTime === entry.start) ?? null : null

  /** Open the correction drawer on one entry, replacing any merge selection. */
  const editEntry = (entry: DayEntry) => {
    const primary = primaryOf(entry)
    setOpen(null)
    setEditing({
      session: primary,
      idle: idleOf(entry),
      selection: primary ? [primary] : [],
      entryIds: [entry.id],
    })
  }

  /**
   * Ctrl-click: hold this entry alongside whatever is already held.
   *
   * Only real sessions can merge — an away block or a calendar event has no
   * session id to fold — so those fall back to opening on their own rather
   * than silently doing nothing.
   */
  const addToSelection = (entry: DayEntry) => {
    if (entry.kind !== 'session' || !entry.sessions.length) {
      editEntry(entry)
      return
    }
    setOpen(null)
    setEditing((current) => {
      const held = current?.selection ?? []
      const heldEntries = current?.entryIds ?? []
      // Clicking a held entry again takes it back out, so a mis-click is
      // undone the same way it was made.
      if (heldEntries.includes(entry.id)) {
        const ids = new Set(entry.sessions.map((s) => s.id))
        const selection = held.filter((s) => !ids.has(s.id))
        const entryIds = heldEntries.filter((id) => id !== entry.id)
        if (!selection.length) return null
        return { session: selection[selection.length - 1], idle: null, selection, entryIds }
      }
      const seen = new Set(held.map((s) => s.id))
      const selection = [...held, ...entry.sessions.filter((s) => !seen.has(s.id))]
      return {
        session: primaryOf(entry),
        idle: null,
        selection,
        entryIds: [...heldEntries, entry.id],
      }
    })
  }

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
          {rangeMode === 'day' ? (
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
          ) : (
            // The grouping tabs describe one day's grid — meaningless above a
            // week strip, so a hint takes their place rather than a row of
            // tabs that silently do nothing.
            <div className="grid-tabs-hint">Pick a day to open it here.</div>
          )}
          <RefreshButton onRefresh={() => void app.refresh()} />
        </div>

        <div className="grid-datebar">
          <h1 className="grid-date">
            {rangeMode === 'week' ? rangeLabel(rangeFor('week', day.dayKey)) : datedTitle(dayStart)}
          </h1>
          <div className="grid-datenav">
            <div className="seg range-seg">
              {RANGES.map((range) => {
                const staysHere = range.id === 'day' || range.id === 'week'
                return (
                  <button
                    key={range.id}
                    className={staysHere ? (rangeMode === range.id ? 'on' : '') : ''}
                    /* Month and Year leave the calendar entirely, so the
                       tooltip says so — "Week view" used to promise a week on
                       this grid and then move the whole view out from under
                       the click. Week no longer does; only the wider periods
                       still do, because they need layouts (a calendar grid, a
                       heat grid) this view has no room for. */
                    title={
                      staysHere
                        ? range.id === 'day'
                          ? 'The day on this grid'
                          : 'The trailing week on this grid'
                        : `Open the ${range.label.toLowerCase()} in Reports`
                    }
                    onClick={
                      staysHere
                        ? () => setRangeMode(range.id as 'day' | 'week')
                        : () => onOpenReports(range.id as RangeKind)
                    }
                  >
                    {range.label}
                  </button>
                )
              })}
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
              title={rangeMode === 'week' ? 'Previous week' : 'Previous day'}
              onClick={() => app.selectDay(shiftDayKey(day.dayKey, rangeMode === 'week' ? -7 : -1))}
            >
              <IconChevronLeft size={15} />
            </button>
            <button
              className="icon-btn"
              title={rangeMode === 'week' ? 'Next week' : 'Next day'}
              onClick={() => app.selectDay(shiftDayKey(day.dayKey, rangeMode === 'week' ? 7 : 1))}
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
          {rangeMode === 'week' ? (
            <WeekStrip
              days={weekSummaries}
              selectedKey={day.dayKey}
              todayKey={todayKey}
              onSelectDay={(key) => {
                app.selectDay(key)
                setRangeMode('day')
              }}
            />
          ) : (
            <DayGrid
              dayKey={day.dayKey}
              dayStartHour={settings.dayStartHour}
              sessions={day.sessions}
              idle={day.idle}
              events={day.events}
              projects={app.projects}
              mode={mode}
              selectedId={open?.entry.id ?? null}
              pickedIds={pickedIds}
              onSelect={(entry, anchor, additive) => {
                if (!entry || !anchor) {
                  closeAll()
                  return
                }
                if (additive) {
                  addToSelection(entry)
                  return
                }
                setEditing(null)
                setOpen({ entry, anchor })
              }}
            />
          )}
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
          onEdit={() => editEntry(open.entry)}
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
              selection={editing.selection}
              idle={editing.idle}
              dayKey={day.dayKey}
              dayStartHour={settings.dayStartHour}
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

/**
 * The trailing week, as seven pickable day cards in place of the hour grid.
 *
 * `days` is `app.week` already summarised — the same trailing-seven-days
 * payload the summary panel's baseline uses — so switching into week mode
 * costs nothing extra to fetch. Picking a card is the only action: it
 * selects that day and hands control straight back to Day mode, the same
 * drill-down a month or year grid uses elsewhere in the app.
 */
function WeekStrip({
  days,
  selectedKey,
  todayKey,
  onSelectDay,
}: {
  days: DaySummary[]
  selectedKey: string
  todayKey: string
  onSelectDay(key: string): void
}) {
  if (!days.length) return null

  return (
    <div className="week-strip">
      {days.map((summary) => {
        const date = parseYmdLocal(summary.dayKey)
        const spend: Array<{ key: string; seconds: number; color: string }> = [
          { key: 'focus', seconds: summary.productiveSeconds, color: 'var(--productive)' },
          { key: 'neutral', seconds: summary.neutralSeconds, color: 'var(--neutral)' },
          { key: 'distracting', seconds: summary.distractingSeconds, color: 'var(--distracting)' },
          { key: 'away', seconds: summary.idleSeconds, color: 'var(--surface-4)' },
        ]
        const total = spend.reduce((sum, s) => sum + s.seconds, 0)

        return (
          <button
            key={summary.dayKey}
            className={`week-day${summary.dayKey === selectedKey ? ' on' : ''}${
              summary.dayKey === todayKey ? ' today' : ''
            }`}
            onClick={() => onSelectDay(summary.dayKey)}
          >
            <div className="week-day-head">
              <span className="week-day-name">{weekdayShort(date.getTime())}</span>
              <span className="week-day-num">{date.getDate()}</span>
            </div>
            <div className="week-day-total">{summary.totalSeconds ? duration(summary.totalSeconds) : '—'}</div>
            <div className="week-day-bar" aria-hidden="true">
              {total
                ? spend.map((s) =>
                    s.seconds ? (
                      <i key={s.key} style={{ flexGrow: s.seconds, background: s.color }} />
                    ) : null
                  )
                : null}
            </div>
          </button>
        )
      })}
    </div>
  )
}
