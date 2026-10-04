import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { DaySummary } from '../../core/aggregate'
import { summarizeDay } from '../../core/aggregate'
import { dayKey, dayStartTs, parseYmdLocal, formatYmdLocal } from '../../core/day'
import { rangeContains, rangeFor, rangeKeys, rangeLabel, shiftRange, type DayRange } from '../../core/range'
import type { IdleBlock, Session } from '../../core/types'
import type { Slice } from '../components/Charts'
import { DayGrid } from '../components/DayGrid'
import { Empty } from '../components/Empty'
import { HeatGrid, MonthCalendar } from '../components/RangeGrids'
import { EntryPopover } from '../components/EntryPopover'
import {
  IconApps,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconFolder,
  IconInfo,
} from '../components/Icons'
import { Inspector } from '../components/Inspector'
import { SummaryPanel } from '../components/SummaryPanel'
import type { DayEntry, GroupMode } from '../lib/entries'
import { datedTitle, duration, weekdayShort } from '../lib/format'
import { categoryColors, RESERVED_COLORS } from '../lib/palette'
import type { OpenTimeState } from '../state/useOpenTime'

/**
 * The grid's grouping tabs: by project or by app. There used to be a third,
 * "Time entries", which grouped by the same label as "Projects" in all but
 * name, so people had to guess the difference.
 */
const TABS: Array<{ id: GroupMode; label: string; Icon: typeof IconFolder }> = [
  { id: 'category', label: 'By project', Icon: IconFolder },
  { id: 'app', label: 'By app', Icon: IconApps },
]

type CalendarRange = 'day' | 'week' | 'month' | 'year'

/**
 * Ranges this bar can switch to. Every one stays on this view: Day is the hour
 * grid, Week a strip of seven days, Month a calendar, Year a cell per day, and
 * clicking any day in the wider ones opens it hour by hour. Month and Year
 * used to jump to Reports, which read as the button being broken.
 */
const RANGES: Array<{ id: CalendarRange; label: string }> = [
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
}: {
  app: OpenTimeState
  onCustomize(): void
}) {
  const [mode, setMode] = useState<GroupMode>('category')
  const [rangeMode, setRangeMode] = useState<CalendarRange>('day')
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

  // The period on screen for Week, Month and Year, always the one containing
  // the selected day: the title and the days drawn under it come from the same
  // range, so they cannot disagree (the week strip once showed this week's
  // days under last week's title).
  const range = useMemo<DayRange | null>(
    () => (day && rangeMode !== 'day' ? rangeFor(rangeMode, day.dayKey) : null),
    [rangeMode, day?.dayKey]
  )
  const [rangeDays, setRangeDays] = useState<DaySummary[] | null>(null)
  const loadRange = app.loadRange
  useEffect(() => {
    if (!range) {
      setRangeDays(null)
      return
    }
    let cancelled = false
    void loadRange(rangeKeys(range)).then((payloads) => {
      if (cancelled) return
      setRangeDays(payloads.map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events)))
    })
    return () => {
      cancelled = true
    }
    // `app.week` changes whenever tracked data does, so the period stays live.
  }, [range, loadRange, app.week])

  const previous = useMemo(() => {
    if (!day) return null
    const key = shiftDayKey(day.dayKey, -1)
    const found = app.week.find((d) => d.dayKey === key)
    return found ? summarizeDay(found.dayKey, found.sessions, found.idle, found.events) : null
  }, [app.week, day])

  /** Donut slices for whichever grouping the tabs are on. */
  const slices = useMemo<Slice[]>(() => {
    if (!day) return []
    const totals = new Map<string, number>()
    for (const b of mode === 'app' ? summary.byApp : summary.byCategory) totals.set(b.key, b.seconds)
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

  /** Arrows step one day, or one whole week, month or year, and never past today. */
  const step = (direction: -1 | 1) => {
    if (!range) {
      app.selectDay(shiftDayKey(day.dayKey, direction))
      return
    }
    const next = shiftRange(range, direction)
    app.selectDay(next.toKey > todayKey ? todayKey : next.toKey)
  }
  const atPresent = range ? rangeContains(range, todayKey) || range.toKey > todayKey : isToday
  const unit = rangeMode === 'day' ? 'day' : rangeMode
  const rangeTracked = rangeDays?.reduce((sum, d) => sum + d.totalSeconds, 0) ?? 0
  const rangeActive = rangeDays?.filter((d) => d.totalSeconds > 0).length ?? 0

  /** A day picked in Week, Month or Year opens hour by hour. Days to come have nothing to open. */
  const openDay = (key: string) => {
    if (key > todayKey) return
    app.selectDay(key)
    setRangeMode('day')
  }
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
    <div className={`calendar${range ? ' wide' : ''}`}>
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
            // The grouping tabs describe one day's grid, meaningless above a
            // whole period, so a hint takes their place rather than a row of
            // tabs that silently do nothing.
            <div className="grid-tabs-hint">Click any day to see it hour by hour.</div>
          )}
        </div>

        <div className="grid-datebar">
          <div className="grid-date-block">
            <h1 className="grid-date">{range ? rangeLabel(range) : datedTitle(dayStart)}</h1>
            {range ? (
              <p className="grid-date-sub">
                {rangeDays
                  ? rangeTracked
                    ? `${duration(rangeTracked)} tracked on ${rangeActive} ${rangeActive === 1 ? 'day' : 'days'}`
                    : 'Nothing tracked in this period'
                  : 'Loading…'}
              </p>
            ) : null}
          </div>
          <div className="grid-datenav">
            <div className="seg range-seg">
              {RANGES.map((option) => (
                <button
                  key={option.id}
                  className={rangeMode === option.id ? 'on' : ''}
                  aria-pressed={rangeMode === option.id}
                  onClick={() => setRangeMode(option.id)}
                >
                  {option.label}
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
            <button className="icon-btn" title={`Previous ${unit}`} onClick={() => step(-1)}>
              <IconChevronLeft size={15} />
            </button>
            <button
              className="icon-btn"
              title={`Next ${unit}`}
              onClick={() => step(1)}
              disabled={atPresent}
            >
              <IconChevronRight size={15} />
            </button>
          </div>
        </div>

        {app.captureNotice ? (
          <div className="notice">
            <IconInfo />
            <div>
              <strong>Showing example activity.</strong> {app.captureNotice} You can clear it in
              Settings under Your data.
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
          {range ? (
            !rangeDays ? (
              <Empty title="Loading…" hint="Reading this period from local storage." />
            ) : rangeMode === 'week' ? (
              <WeekStrip
                days={rangeDays}
                selectedKey={day.dayKey}
                todayKey={todayKey}
                onSelectDay={openDay}
              />
            ) : rangeMode === 'month' ? (
              <div className="calendar-period">
                <MonthCalendar
                  range={range}
                  days={rangeDays}
                  selected={day.dayKey}
                  todayKey={todayKey}
                  onSelect={openDay}
                />
              </div>
            ) : (
              <div className="calendar-period">
                <HeatGrid days={rangeDays} selected={day.dayKey} todayKey={todayKey} onSelect={openDay} />
                <p className="calendar-period-hint">Darker days had more tracked time.</p>
              </div>
            )
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

      {/* The summary describes one day, so it sits beside the day grid only;
          a week, month or year gets the full width instead. */}
      {range ? null : (
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
      )}

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
              rules={app.rules}
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
 * A week as seven pickable day cards in place of the hour grid. Picking one
 * opens that day hour by hour.
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
            <div className="week-day-total">{summary.totalSeconds ? duration(summary.totalSeconds) : '-'}</div>
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
