/**
 * Calendar entries.
 *
 * The engine records a session every time the focused window changes, so a
 * morning of real work is fifty rows long. A calendar grid drawn from those
 * rows is confetti: unreadable, and unclickable at the sizes most of them get.
 *
 * This module is the one place that turns raw sessions into the things the day
 * grid actually draws — contiguous *entries* — and decides which column each one
 * belongs in. It is pure and takes no React: `tests/entries.test.ts` pins it.
 *
 * Two rules keep entries honest:
 *  - only **adjacent** sessions merge. If a different category sat between two
 *    stretches of the same one, they stay two entries, because merging them
 *    would silently claim the minutes in between.
 *  - every derived number is recomputed from the sessions folded in, never
 *    carried over from one of them.
 */

import type { CalendarEvent, IdleBlock, Productivity, Session } from '../../core/types'

/** How the grid is grouped — the filter tabs above the day view. */
export type GroupMode = 'category' | 'project' | 'app'

export type EntryKind = 'session' | 'away' | 'event'

/** One app or site inside an entry, for the popover's breakdown list. */
export interface EntryApp {
  name: string
  seconds: number
  /** Share of the entry, 0–1. */
  share: number
}

export interface DayEntry {
  id: string
  kind: EntryKind
  /** What the entry is called on the grid — the group key it was built from. */
  label: string
  /** Sessions folded in, ascending by start. Empty for away and calendar rows. */
  sessions: Session[]
  start: number
  end: number
  seconds: number
  /** Dominant productivity across the folded sessions. */
  productivity: Productivity | 'idle' | 'event'
  /** Which column of the grid this sits in. */
  lane: number
  apps: EntryApp[]
  /** Distinct window titles, longest-running first. */
  titles: string[]
  /** The most recent note any folded session carries. */
  note?: string
  /** True when a human corrected any of the folded sessions. */
  edited: boolean
  /** True when every folded session is synthetic. */
  demo: boolean
  /** Set when the entry is a focus session the user ran deliberately. */
  focus?: { id: string; label: string; plannedSeconds: number }
}

/**
 * Sessions further apart than this never fold together, even in one category.
 *
 * Ten minutes: long enough that switching to the terminal and back reads as one
 * stretch of work, short enough that a coffee break still splits the entry.
 * Only the *span* crosses the gap — the entry's duration is still the sum of
 * the sessions in it, so the unobserved minutes are never credited.
 */
export const DEFAULT_MERGE_GAP_SECONDS = 600

const NO_PROJECT = 'No project'

/**
 * The group key a session belongs to.
 *
 * Projects resolve through the caller's id→name map rather than the session's
 * category, because a session can be attributed to a project while carrying a
 * rule-assigned category — the two are separate channels by design.
 */
export function groupKeyFor(
  session: Session,
  mode: GroupMode,
  projectNames: Map<string, string>
): string {
  // A focus session outranks every grouping except "by app": the user declared
  // that stretch to be one thing, and splitting their 45 minutes back into
  // three category blocks throws that declaration away. Apps are exempt because
  // "which app did the focus session go in" is exactly what that tab is for.
  if (mode !== 'app' && session.focus) return session.focus.label
  if (mode === 'app') return session.app || 'Unknown app'
  if (mode === 'project') {
    const name = session.projectId ? projectNames.get(session.projectId) : undefined
    return name || NO_PROJECT
  }
  return session.category || 'Uncategorized'
}

function dominantProductivity(sessions: Session[]): Productivity {
  const totals = new Map<Productivity, number>()
  for (const s of sessions) {
    totals.set(s.productivity, (totals.get(s.productivity) || 0) + s.durationSeconds)
  }
  let best: Productivity = 'neutral'
  let bestSeconds = -1
  for (const [level, seconds] of totals) {
    if (seconds > bestSeconds) {
      best = level
      bestSeconds = seconds
    }
  }
  return best
}

/** App/host totals inside one entry, largest first. */
function appsOf(sessions: Session[]): EntryApp[] {
  const totals = new Map<string, number>()
  let total = 0
  for (const s of sessions) {
    // The host is the more useful name when there is one: "github.com" says
    // more than a fourth row reading "chrome".
    const name = s.url || s.app || 'Unknown'
    totals.set(name, (totals.get(name) || 0) + s.durationSeconds)
    total += s.durationSeconds
  }
  return [...totals.entries()]
    .map(([name, seconds]) => ({ name, seconds, share: total > 0 ? seconds / total : 0 }))
    .sort((a, b) => b.seconds - a.seconds)
}

function titlesOf(sessions: Session[]): string[] {
  const totals = new Map<string, number>()
  for (const s of sessions) {
    const title = s.title?.trim()
    if (!title) continue
    totals.set(title, (totals.get(title) || 0) + s.durationSeconds)
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([title]) => title)
}

function finish(label: string, sessions: Session[]): DayEntry {
  const start = sessions[0].startTime
  const end = sessions[sessions.length - 1].endTime
  return {
    id: `entry_${sessions[0].id}`,
    kind: 'session',
    label,
    sessions,
    start,
    end,
    // Summed rather than measured end-to-start: the sub-gaps between folded
    // sessions are real seconds nobody was observed working.
    seconds: sessions.reduce((sum, s) => sum + s.durationSeconds, 0),
    productivity: dominantProductivity(sessions),
    lane: 0,
    apps: appsOf(sessions),
    titles: titlesOf(sessions),
    note: [...sessions].reverse().find((s) => s.note?.trim())?.note,
    edited: sessions.some((s) => s.edited),
    demo: sessions.every((s) => s.source === 'demo'),
    // Only when the whole run is one session — a fold that mixes focused and
    // unfocused time is not a focus session and must not be badged as one.
    focus:
      sessions[0].focus && sessions.every((s) => s.focus?.id === sessions[0].focus?.id)
        ? sessions[0].focus
        : undefined,
  }
}

export interface BuildOptions {
  mode: GroupMode
  /** Project id → display name. */
  projectNames: Map<string, string>
  mergeGapSeconds?: number
  idle?: IdleBlock[]
  events?: CalendarEvent[]
}

/**
 * Fold a day's sessions into entries, and turn away blocks and calendar events
 * into entries of their own so the grid has one kind of thing to draw.
 */
export function buildEntries(sessions: Session[], opts: BuildOptions): DayEntry[] {
  const gapMs = (opts.mergeGapSeconds ?? DEFAULT_MERGE_GAP_SECONDS) * 1000
  const ordered = [...sessions].sort((a, b) => a.startTime - b.startTime)
  const out: DayEntry[] = []

  let runLabel = ''
  let run: Session[] = []
  const flush = () => {
    if (run.length) out.push(finish(runLabel, run))
    run = []
  }

  for (const session of ordered) {
    const label = groupKeyFor(session, opts.mode, opts.projectNames)
    const previous = run[run.length - 1]
    if (previous && label === runLabel && session.startTime - previous.endTime <= gapMs) {
      run.push(session)
      continue
    }
    flush()
    runLabel = label
    run = [session]
  }
  flush()

  for (const block of opts.idle ?? []) {
    out.push({
      id: `away_${block.startTime}`,
      kind: 'away',
      label: 'Away',
      sessions: [],
      start: block.startTime,
      end: block.endTime,
      seconds: block.durationSeconds,
      productivity: 'idle',
      lane: 0,
      apps: [],
      titles: [],
      edited: false,
      demo: false,
    })
  }

  for (const event of opts.events ?? []) {
    if (event.allDay) continue
    out.push({
      id: `event_${event.id}`,
      kind: 'event',
      label: event.title || 'Untitled event',
      sessions: [],
      start: event.start,
      end: event.end,
      seconds: Math.max(0, Math.round((event.end - event.start) / 1000)),
      productivity: 'event',
      lane: 0,
      apps: [],
      titles: [],
      edited: false,
      demo: event.source === 'demo',
    })
  }

  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

export interface LaneLayout {
  entries: DayEntry[]
  /** Column count the grid should draw, always at least 1. */
  laneCount: number
  /** Lane index → the labels sharing it, in the order they were assigned. */
  laneLabels: string[][]
}

/**
 * Put every entry in a column.
 *
 * Sessions never overlap in time, so packing by collision would produce a single
 * column and lose the thing a calendar grid is for — seeing at a glance that the
 * morning was one kind of work and the afternoon another. Columns are therefore
 * *labels*, ordered by how much of the day each one took. Labels past the cap
 * share the final column, which is safe precisely because they cannot overlap.
 *
 * Calendar events always take the last column: they are what was scheduled, not
 * what happened, and interleaving the two invites reading one as the other.
 */
export function assignLanes(entries: DayEntry[], maxLanes = 5): LaneLayout {
  const cap = Math.max(1, maxLanes)
  const totals = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind === 'event') continue
    totals.set(entry.label, (totals.get(entry.label) || 0) + entry.seconds)
  }

  const hasEvents = entries.some((e) => e.kind === 'event')
  // Events take one column out of the budget rather than adding a sixth. A quiet
  // day narrows the grid rather than drawing empty columns beside its one entry.
  const trackLanes = Math.max(1, Math.min(hasEvents ? cap - 1 : cap, totals.size))
  const ranked = [...totals.entries()]
    // Ties break on the name so a day with two equal categories lays out the
    // same way on every render.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label]) => label)

  const laneOf = new Map<string, number>()
  const laneLabels: string[][] = Array.from({ length: trackLanes }, () => [])
  ranked.forEach((label, index) => {
    const lane = index < trackLanes ? index : trackLanes - 1
    laneOf.set(label, lane)
    laneLabels[lane].push(label)
  })

  const eventLane = hasEvents ? trackLanes : -1
  if (hasEvents) laneLabels.push(['Calendar'])

  return {
    entries: entries.map((entry) => ({
      ...entry,
      lane: entry.kind === 'event' ? eventLane : (laneOf.get(entry.label) ?? 0),
    })),
    laneCount: hasEvents ? trackLanes + 1 : trackLanes,
    laneLabels,
  }
}

/**
 * A factual sentence about how an entry was spent.
 *
 * Deliberately assembled from counts the store already holds rather than
 * written by a model: OpenTime never sends activity anywhere, so the only
 * summary it can honestly show is one it can derive.
 */
export function describeEntry(entry: DayEntry): string {
  if (entry.kind === 'away') return 'No input was detected for this stretch.'
  if (entry.kind === 'event') return 'From your calendar. Nothing was tracked against it here.'
  if (!entry.sessions.length) return ''

  const stretches = entry.sessions.length
  const apps = entry.apps.length
  const longest = Math.max(...entry.sessions.map((s) => s.durationSeconds))
  const parts: string[] = []
  parts.push(
    stretches === 1
      ? 'One unbroken stretch'
      : `${stretches} stretches, longest ${Math.round(longest / 60)}m`
  )
  parts.push(apps === 1 ? `in ${entry.apps[0].name}` : `across ${apps} apps and sites`)
  if (entry.titles.length) parts.push(`starting with “${entry.titles[0]}”`)
  return `${parts.join(', ')}.`
}
