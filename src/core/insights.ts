/**
 * Insights: the few observations worth making out loud.
 *
 * The bar for adding one is that it must be *actionable or surprising*. A card
 * saying "you worked 6h 12m today" is neither — the number is already on screen.
 * "Your focus collapses after 3pm" and "meetings ate 40% of your day" change
 * what someone does tomorrow.
 *
 * Every insight is derived from summaries the dashboard already computed, so
 * this adds a pass over ~30 numbers, not over raw sessions.
 */

import type { DaySummary } from './aggregate'
import { dayStartTs } from './day'
import type { Session } from './types'

export type InsightTone = 'good' | 'warn' | 'neutral'

export interface Insight {
  id: string
  tone: InsightTone
  title: string
  detail: string
  /** Sort weight — higher surfaces first. */
  weight: number
}

/** Productive seconds per hour-of-day bucket, 0–23. */
export function hourlyFocus(sessions: Session[]): number[] {
  const hours = new Array(24).fill(0)
  for (const s of sessions) {
    if (s.productivity !== 'productive') continue
    // Spread the session across every hour it touches rather than crediting it
    // all to its start hour — a two-hour block would otherwise invent a spike.
    let cursor = s.startTime
    while (cursor < s.endTime) {
      const d = new Date(cursor)
      const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()
      const slice = Math.min(hourEnd, s.endTime) - cursor
      hours[d.getHours()] += slice / 1000
      cursor += slice
    }
  }
  return hours.map((v) => Math.round(v))
}

/** The contiguous run of hours holding the most productive time. */
export function peakFocusWindow(
  sessions: Session[],
  width = 3
): { startHour: number; seconds: number } | null {
  const hours = hourlyFocus(sessions)
  const total = hours.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  let bestStart = 0
  let best = -1
  for (let h = 0; h <= 24 - width; h++) {
    let sum = 0
    for (let i = 0; i < width; i++) sum += hours[h + i]
    if (sum > best) {
      best = sum
      bestStart = h
    }
  }
  return { startHour: bestStart, seconds: best }
}

function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  if (h === 0) return '12am'
  if (h === 12) return '12pm'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}

function hours(seconds: number): string {
  // Round to whole minutes first so 7h 59m 40s reads "8h", never "7h 60m".
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

export interface InsightInput {
  today: DaySummary
  sessions: Session[]
  /** The trailing week including today, oldest first. */
  week: DaySummary[]
  dayStartHour: number
}

/**
 * Build the day's insights, most important first.
 *
 * Returns an empty list rather than filler when there is nothing to say — an
 * insights panel that always has five cards teaches people to ignore it.
 */
export function buildInsights(input: InsightInput): Insight[] {
  const { today, sessions, week } = input
  const out: Insight[] = []
  if (today.totalSeconds < 15 * 60) return out

  // Peak focus window — where the good hours actually are.
  const peak = peakFocusWindow(sessions)
  if (peak && peak.seconds > 20 * 60) {
    out.push({
      id: 'peak-window',
      tone: 'good',
      title: `Sharpest between ${hourLabel(peak.startHour)} and ${hourLabel(peak.startHour + 3)}`,
      detail: `${hours(peak.seconds)} of focused work landed in that window — the strongest three hours of your day. Worth defending from meetings.`,
      weight: 60,
    })
  }

  // Fragmentation — the thing the focus score is quietly punishing.
  const switchesPerHour = today.totalSeconds
    ? today.switches / Math.max(today.totalSeconds / 3600, 0.25)
    : 0
  if (switchesPerHour >= 12) {
    out.push({
      id: 'fragmentation',
      tone: 'warn',
      title: `${Math.round(switchesPerHour)} context switches an hour`,
      detail: `Your longest unbroken block was ${hours(today.longestFocusSeconds)}. Switching this often is most of the gap between hours worked and work done.`,
      weight: 85,
    })
  } else if (today.longestFocusSeconds >= 60 * 60) {
    out.push({
      id: 'deep-block',
      tone: 'good',
      title: `${hours(today.longestFocusSeconds)} of unbroken focus`,
      detail: 'A block that long is rare enough to be worth repeating deliberately rather than by luck.',
      weight: 55,
    })
  }

  // Meeting load — only when it is genuinely eating the day.
  if (today.meetingSeconds > 0 && today.totalSeconds > 0) {
    const share = today.meetingSeconds / today.totalSeconds
    if (share >= 0.35) {
      out.push({
        id: 'meeting-load',
        tone: 'warn',
        title: `Meetings covered ${percent(share)} of your tracked day`,
        detail: `${hours(today.meetingSeconds)} scheduled against ${hours(today.totalSeconds)} tracked. Days this booked rarely leave room for a deep block.`,
        weight: 80,
      })
    }
  }

  // Top distraction — named, because "distraction: 1h 20m" is not actionable.
  const distractors = today.byCategory
    .filter((b) => b.productivity === 'distracting')
    .sort((a, b) => b.seconds - a.seconds)
  if (distractors.length && distractors[0].seconds >= 20 * 60) {
    const top = distractors[0]
    out.push({
      id: 'top-distraction',
      tone: 'warn',
      title: `${hours(top.seconds)} in ${top.label}`,
      detail: `That is ${percent(top.share)} of everything tracked today. If it is genuinely a break, retag it as one — the score should reflect what you meant.`,
      weight: 70,
    })
  }

  // Day against its own recent baseline. Comparing to a fixed ideal would be
  // someone else's standard; comparing to your own last week is yours.
  const priors = week.filter((d) => d.dayKey !== today.dayKey && d.totalSeconds > 15 * 60)
  if (priors.length >= 3) {
    const avg = priors.reduce((s, d) => s + d.productiveSeconds, 0) / priors.length
    const delta = today.productiveSeconds - avg
    if (Math.abs(delta) >= 45 * 60) {
      out.push({
        id: 'baseline',
        tone: delta > 0 ? 'good' : 'neutral',
        title:
          delta > 0
            ? `${hours(delta)} more focus than your recent average`
            : `${hours(-delta)} less focus than your recent average`,
        detail: `Your last ${priors.length} tracked days averaged ${hours(Math.round(avg))} of focused work.`,
        weight: 50,
      })
    }
  }

  // A late finish is worth naming once, not nagging about.
  if (today.lastActivityAt !== null) {
    const end = new Date(today.lastActivityAt)
    const endHour = end.getHours() + end.getMinutes() / 60
    if (endHour >= 21 || endHour < 4) {
      out.push({
        id: 'late-finish',
        tone: 'neutral',
        title: `Still working at ${hourLabel(end.getHours())}`,
        detail: 'Late blocks are counted against the tracking day they started in, so tomorrow’s totals stay clean.',
        weight: 30,
      })
    }
  }

  return out.sort((a, b) => b.weight - a.weight)
}

/**
 * Insights over a whole range — the reporting view's counterpart. Kept separate
 * because a week's story is about consistency, and a day's is about shape.
 */
export function buildRangeInsights(days: DaySummary[], dayStartHour: number): Insight[] {
  const tracked = days.filter((d) => d.totalSeconds > 15 * 60)
  if (tracked.length < 2) return []
  const out: Insight[] = []

  const best = tracked.reduce((a, b) => (b.focusScore > a.focusScore ? b : a))
  const worst = tracked.reduce((a, b) => (b.focusScore < a.focusScore ? b : a))
  if (best.focusScore - worst.focusScore >= 20) {
    const weekday = (key: string) =>
      new Date(dayStartTs(key, dayStartHour)).toLocaleDateString(undefined, { weekday: 'long' })
    out.push({
      id: 'range-spread',
      tone: 'neutral',
      title: `${weekday(best.dayKey)} beat ${weekday(worst.dayKey)} by ${best.focusScore - worst.focusScore} points`,
      detail: `Focus scores ranged from ${worst.focusScore} to ${best.focusScore}. Consistency usually moves the weekly total more than any single great day.`,
      weight: 60,
    })
  }

  const totalTracked = tracked.reduce((s, d) => s + d.totalSeconds, 0)
  const totalMeetings = tracked.reduce((s, d) => s + d.meetingSeconds, 0)
  if (totalTracked > 0 && totalMeetings / totalTracked >= 0.3) {
    out.push({
      id: 'range-meetings',
      tone: 'warn',
      title: `${percent(totalMeetings / totalTracked)} of the period was scheduled`,
      detail: `${hours(totalMeetings)} in meetings across ${tracked.length} tracked days.`,
      weight: 70,
    })
  }

  const noDeepBlock = tracked.filter((d) => d.longestFocusSeconds < 45 * 60).length
  if (noDeepBlock >= Math.ceil(tracked.length / 2)) {
    out.push({
      id: 'range-no-deep',
      tone: 'warn',
      title: `${noDeepBlock} of ${tracked.length} days had no 45-minute block`,
      detail: 'Deep work is the thing most easily lost without anyone noticing, because the hours still add up.',
      weight: 75,
    })
  }

  return out.sort((a, b) => b.weight - a.weight)
}
