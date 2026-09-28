/**
 * Answers to the questions another program asks about your time.
 *
 * This is what OpenTime's MCP server (`src/mcp/server.ts`) says when an
 * assistant asks "how long did I work on Rookbot this week?". It is pure: it
 * takes sessions already read from the store and returns plain text, so every
 * number here can be pinned by a test and agrees with the dashboard, which is
 * built from the same `summarizeDay`.
 *
 * The output is written for a language model to read and repeat to a person:
 * short labelled lines, durations the way people say them, no JSON. A model
 * handed raw seconds does arithmetic, and gets it wrong.
 */

import { summarizeDay } from './aggregate'
import { dayKey, formatYmdLocal, parseYmdLocal } from './day'
import { normalizeCustom, rangeFor, type DayRange } from './range'
import type { DayRecord, Project, Session } from './types'

const YMD = /^\d{4}-\d{2}-\d{2}$/

/**
 * Turn what someone typed into a range of tracking days.
 *
 * Accepts the phrases people use ("today", "yesterday", "this week",
 * "last week", "last 14 days", "this month", "last month", "this year"), one
 * day (`2026-09-25`), or a span (`2026-09-01..2026-09-25`, also with "to").
 * "This week" is the trailing seven days, which is what the dashboard means by
 * it (see `rangeFor`). Anything unrecognised is an error rather than a guess,
 * because a wrong range answers a different question with confidence.
 */
export function resolveRange(spec: string | undefined, now: number, dayStartHour: number): DayRange {
  const today = dayKey(now, dayStartHour)
  // A model copies phrasing from the tool description, asides and all
  // ("this week (the last 7 days)"), so parentheticals and a leading "the"
  // are noise rather than part of the question.
  const s = (spec ?? 'today')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const shift = (key: string, days: number) => {
    const d = parseYmdLocal(key)
    d.setDate(d.getDate() + days)
    return formatYmdLocal(d)
  }
  if (s === '' || s === 'today') return rangeFor('day', today)
  if (s === 'yesterday') return rangeFor('day', shift(today, -1))
  if (s === 'this week' || s === 'week') return rangeFor('week', today)
  if (s === 'last week') return rangeFor('week', shift(today, -7))
  if (s === 'this month' || s === 'month') return rangeFor('month', today)
  if (s === 'last month') {
    const d = parseYmdLocal(today)
    return rangeFor('month', formatYmdLocal(new Date(d.getFullYear(), d.getMonth() - 1, 1)))
  }
  if (s === 'this year' || s === 'year') return rangeFor('year', today)
  if (s === 'all' || s === 'all time' || s === 'ever') return normalizeCustom('2000-01-01', today)
  const lastN = s.match(/^(?:last|past) (\d{1,3}) days?$/)
  if (lastN) {
    const n = Math.max(1, Number(lastN[1]))
    return normalizeCustom(shift(today, -(n - 1)), today)
  }
  if (YMD.test(s)) return rangeFor('day', s)
  const span = s.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|-|–)\s*(\d{4}-\d{2}-\d{2})$/)
  if (span) return normalizeCustom(span[1], span[2])
  throw new Error(
    `I do not understand the range "${spec}". Use today, yesterday, this week, last week, last N days, this month, last month, this year, a date like 2026-09-25, or 2026-09-01..2026-09-25.`
  )
}

/** "3h 12m", "45m", "under a minute". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? 'under a minute' : '0m'
  const m = Math.round(seconds / 60)
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (!h) return `${m}m`
  return rest ? `${h}h ${rest}m` : `${h}h`
}

/** How long ago, coarsened past a day: nobody says "37h 20m ago". */
export function formatAgo(seconds: number): string {
  if (seconds < 90) return 'just now'
  if (seconds < 86_400) return `${formatDuration(seconds)} ago`
  const days = Math.round(seconds / 86_400)
  return days === 1 ? 'a day ago' : `${days} days ago`
}

function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function describeRange(range: DayRange): string {
  return range.fromKey === range.toKey ? range.fromKey : `${range.fromKey} to ${range.toKey}`
}

function top<T>(entries: Iterable<[T, number]>, n: number): Array<[T, number]> {
  return [...entries].sort((a, b) => b[1] - a[1]).slice(0, n)
}

/**
 * Whether a session is about `query`. Every word has to appear somewhere in
 * what the session knows about itself (app, window title, site, category, and
 * the project it was attributed to), so "rookbot brain" does not match every
 * window that merely says "brain". Case-insensitive; `|` separates
 * alternatives, so "rookbot|c0-f0" matches either name of the same thing.
 *
 * Naming a project also means its keywords. The user already told OpenTime
 * that "c0-f0" is Rookbot, so "how long on Rookbot" has to count a window
 * titled "C0-F0" even when that session was never attributed (it predates the
 * project, or was edited by hand).
 */
export function sessionMatches(session: Session, query: string, projects: Project[]): boolean {
  const project = session.projectId ? projects.find((p) => p.id === session.projectId)?.name ?? '' : ''
  const hay = `${session.app} ${session.title} ${session.url} ${session.category} ${project}`.toLowerCase()
  return alternatives(query, projects).some((words) => words.every((w) => hay.includes(w)))
}

function alternatives(query: string, projects: Project[]): string[][] {
  const alts = query
    .toLowerCase()
    .split('|')
    .map((alt) => alt.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length)
  const extra: string[][] = []
  for (const p of projects) {
    const name = p.name.toLowerCase()
    if (!alts.some((words) => words.every((w) => name.includes(w)))) continue
    for (const k of p.keywords) if (k.trim()) extra.push(k.toLowerCase().trim().split(/\s+/))
  }
  return [...alts, ...extra]
}

export interface AskInput {
  range: DayRange
  days: Array<{ key: string; record: DayRecord }>
  projects: Project[]
}

/** What the tracked time in a range was spent on. */
export function summarize({ range, days, projects }: AskInput): string {
  const summaries = days.map((d) => summarizeDay(d.key, d.record.sessions, d.record.idle, d.record.events))
  const total = summaries.reduce((a, s) => a + s.totalSeconds, 0)
  if (!total) return `Nothing tracked ${describeRange(range)}.`

  const sum = (k: 'productiveSeconds' | 'neutralSeconds' | 'distractingSeconds' | 'idleSeconds' | 'meetingSeconds') =>
    summaries.reduce((a, s) => a + s[k], 0)
  const byCategory = new Map<string, number>()
  const byApp = new Map<string, number>()
  const byProject = new Map<string, number>()
  for (const s of summaries) {
    for (const b of s.byCategory) byCategory.set(b.key, (byCategory.get(b.key) ?? 0) + b.seconds)
    for (const b of s.byApp) byApp.set(b.key, (byApp.get(b.key) ?? 0) + b.seconds)
  }
  for (const d of days) {
    for (const session of d.record.sessions) {
      if (!session.projectId) continue
      const name = projects.find((p) => p.id === session.projectId)?.name ?? session.projectId
      byProject.set(name, (byProject.get(name) ?? 0) + session.durationSeconds)
    }
  }
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`
  const list = (m: Map<string, number>, n: number) =>
    top(m, n)
      .map(([k, v]) => `${k} ${formatDuration(v)}`)
      .join(', ')
  const active = summaries.filter((s) => s.totalSeconds > 0)
  const lines = [
    `Tracked ${describeRange(range)}: ${formatDuration(total)}${active.length > 1 ? ` over ${active.length} days` : ''}.`,
    `Productive ${formatDuration(sum('productiveSeconds'))} (${pct(sum('productiveSeconds'))}), neutral ${formatDuration(sum('neutralSeconds'))}, distracting ${formatDuration(sum('distractingSeconds'))}.`,
    `By category: ${list(byCategory, 6)}.`,
    `By app: ${list(byApp, 6)}.`,
  ]
  if (byProject.size) lines.push(`By project: ${list(byProject, 6)}.`)
  if (sum('meetingSeconds')) lines.push(`Meetings: ${formatDuration(sum('meetingSeconds'))}.`)
  if (sum('idleSeconds')) lines.push(`Away: ${formatDuration(sum('idleSeconds'))}.`)
  if (active.length === 1) {
    const s = active[0]
    lines.push(
      `First activity ${clock(s.firstActivityAt!)}, last ${clock(s.lastActivityAt!)}. Longest focus stretch ${formatDuration(s.longestFocusSeconds)}; focus score ${s.focusScore}/100.`
    )
  } else if (active.length > 1) {
    lines.push(`Per day: ${active.map((s) => `${s.dayKey} ${formatDuration(s.totalSeconds)}`).join(', ')}.`)
  }
  return lines.join('\n')
}

/** How long was spent on one thing, and when. */
export function timeOn(query: string, input: AskInput): string {
  const { range, days, projects } = input
  const hits = days.flatMap((d) => d.record.sessions.filter((s) => sessionMatches(s, query, projects)).map((s) => ({ key: d.key, s })))
  if (!hits.length) {
    return `No tracked time matches "${query}" ${describeRange(range)}. Matching looks at app names, window titles, sites, categories and project names; try a shorter word or another name for it.`
  }
  const total = hits.reduce((a, h) => a + h.s.durationSeconds, 0)
  const perDay = new Map<string, number>()
  const byTitle = new Map<string, number>()
  const byApp = new Map<string, number>()
  for (const { key, s } of hits) {
    perDay.set(key, (perDay.get(key) ?? 0) + s.durationSeconds)
    const label = `${s.app}: ${s.title || s.url || '(no title)'}`
    byTitle.set(label, (byTitle.get(label) ?? 0) + s.durationSeconds)
    byApp.set(s.app, (byApp.get(s.app) ?? 0) + s.durationSeconds)
  }
  const first = Math.min(...hits.map((h) => h.s.startTime))
  const last = Math.max(...hits.map((h) => h.s.endTime))
  const lines = [
    `"${query}" ${describeRange(range)}: ${formatDuration(total)} across ${hits.length} session${hits.length === 1 ? '' : 's'}.`,
    `In: ${top(byApp, 5)
      .map(([k, v]) => `${k} ${formatDuration(v)}`)
      .join(', ')}.`,
  ]
  if (perDay.size > 1) {
    lines.push(`Per day: ${[...perDay].map(([k, v]) => `${k} ${formatDuration(v)}`).join(', ')}.`)
  }
  lines.push(
    perDay.size === 1
      ? `On ${[...perDay.keys()][0]}, between ${clock(first)} and ${clock(last)}.`
      : `First ${formatYmdLocal(new Date(first))} ${clock(first)}, last ${formatYmdLocal(new Date(last))} ${clock(last)}.`
  )
  lines.push(
    `Mostly: ${top(byTitle, 5)
      .map(([k, v]) => `${k} (${formatDuration(v)})`)
      .join('; ')}.`
  )
  return lines.join('\n')
}

/** The sessions themselves, newest first, one line each. */
export function listSessions(input: AskInput, opts: { query?: string; limit: number }): string {
  const { range, days, projects } = input
  const all = days
    .flatMap((d) => d.record.sessions)
    .filter((s) => !opts.query || sessionMatches(s, opts.query, projects))
    .sort((a, b) => b.startTime - a.startTime)
  if (!all.length) return `No sessions ${opts.query ? `matching "${opts.query}" ` : ''}${describeRange(range)}.`
  const shown = all.slice(0, opts.limit)
  const multiDay = range.fromKey !== range.toKey
  const lines = shown.map((s) => {
    const project = s.projectId ? projects.find((p) => p.id === s.projectId)?.name : undefined
    const when = `${multiDay ? `${formatYmdLocal(new Date(s.startTime))} ` : ''}${clock(s.startTime)}-${clock(s.endTime)}`
    return `${when} ${formatDuration(s.durationSeconds)} | ${s.app}: ${s.title || s.url || '(no title)'} | ${s.category}${project ? ` | ${project}` : ''}${s.productivity === 'distracting' ? ' | distracting' : ''}`
  })
  if (all.length > shown.length) lines.push(`...and ${all.length - shown.length} earlier.`)
  return lines.join('\n')
}

export interface StatusInput {
  now: number
  dataDirectory: string
  dayKeys: string[]
  lastSession: Session | null
  projects: Project[]
}

/**
 * Whether the record is current. The server cannot ask the running app, so it
 * says what the files say: when the last session ended. The session in
 * progress lives in the tracker's memory until it closes, so "the last few
 * minutes are not in the files yet" is normal, not a fault.
 */
export function status({ now, dataDirectory, dayKeys, lastSession, projects }: StatusInput): string {
  const lines = [`OpenTime data: ${dataDirectory}`]
  if (!dayKeys.length || !lastSession) {
    lines.push('Nothing has been tracked yet.')
  } else {
    const ago = Math.max(0, Math.round((now - lastSession.endTime) / 1000))
    lines.push(
      `${dayKeys.length} tracked day${dayKeys.length === 1 ? '' : 's'}, from ${dayKeys[0]} to ${dayKeys[dayKeys.length - 1]}.`,
      `Last recorded activity ended ${formatAgo(ago)} (${lastSession.app}: ${lastSession.title || lastSession.url || '(no title)'}).`
    )
    if (ago > 20 * 60) {
      lines.push('Nothing newer is on disk, so OpenTime is probably not running or is paused. The current session is only written when it ends.')
    }
  }
  const live = projects.filter((p) => !p.archived)
  if (live.length) lines.push(`Projects: ${live.map((p) => `${p.name} (keywords: ${p.keywords.join(', ') || 'none'})`).join('; ')}.`)
  return lines.join('\n')
}

