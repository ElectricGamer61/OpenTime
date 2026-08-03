/**
 * Goals.
 *
 * A goal is a floor or a ceiling on a slice of time, evaluated over a day or a
 * week. Two shapes cover what people actually set: "at least N hours of focus"
 * and "at most N minutes of distraction" (productivity goals), and "at least N
 * hours on Client X" (category goals).
 *
 * Deliberately not modelled: streaks, badges, and any notion of a goal you can
 * fail permanently. A tracker that scolds you gets muted, and a muted tracker
 * measures nothing. Progress is a number and a state; the interpretation stays
 * with the user.
 */

import type { DaySummary } from './aggregate'
import type { Goal, Productivity } from './types'

/**
 * Where a goal stands right now.
 *
 * Floors and ceilings need different words: a floor you are short of is
 * `behind`, whereas a ceiling you are burning through too fast is `at-risk`.
 * Collapsing both into one label reads as nonsense in half the cases.
 */
export type GoalState = 'met' | 'on-track' | 'behind' | 'at-risk' | 'exceeded'

export interface GoalProgress {
  goal: Goal
  /** Seconds accumulated in the goal's window so far. */
  seconds: number
  /** Progress against the target, 0–1 (clamped for display; see `ratio`). */
  progress: number
  /** Unclamped seconds/target, so "180% of your ceiling" stays expressible. */
  ratio: number
  state: GoalState
  /** Days contributing to this evaluation — 1 for daily, up to 7 for weekly. */
  days: number
  /** Seconds still needed (floors) or still available (ceilings). Never negative. */
  remainingSeconds: number
}

const PRODUCTIVITY_FIELD: Record<Productivity, keyof DaySummary> = {
  productive: 'productiveSeconds',
  neutral: 'neutralSeconds',
  distracting: 'distractingSeconds',
}

/** Seconds one summary contributes to one goal. */
export function secondsForGoal(goal: Goal, summary: DaySummary): number {
  if (goal.kind === 'productivity') {
    const field = PRODUCTIVITY_FIELD[goal.target as Productivity]
    return field ? (summary[field] as number) : 0
  }
  const target = goal.target.toLowerCase()
  let total = 0
  for (const bucket of summary.byCategory) {
    if (bucket.key.toLowerCase() === target) total += bucket.seconds
  }
  return total
}

function stateFor(goal: Goal, seconds: number, elapsedShare: number): GoalState {
  if (goal.direction === 'at-least') {
    if (seconds >= goal.seconds) return 'met'
    // Pro-rate against how much of the window has actually elapsed, so a
    // weekly goal is not "behind" every Monday morning by construction.
    return seconds >= goal.seconds * elapsedShare ? 'on-track' : 'behind'
  }
  if (seconds > goal.seconds) return 'exceeded'
  // Under the ceiling, but spending it faster than the window is passing.
  return seconds > goal.seconds * elapsedShare ? 'at-risk' : 'met'
}

export interface EvaluateOptions {
  /**
   * How much of the goal's window has passed, 0–1. Callers pass the real
   * fraction (hours into the day, days into the week) so pacing is honest;
   * defaults to a fully elapsed window, which is the right answer for history.
   */
  elapsedShare?: number
}

/**
 * Evaluate one goal over the summaries in its window.
 *
 * Callers pass the summaries that belong to the window — one day for a daily
 * goal, the week's days for a weekly one. Evaluation does no date maths of its
 * own, which keeps tracking-day rollover in exactly one place.
 */
export function evaluateGoal(
  goal: Goal,
  summaries: DaySummary[],
  opts: EvaluateOptions = {}
): GoalProgress {
  const elapsedShare = Math.min(1, Math.max(0, opts.elapsedShare ?? 1))
  const seconds = summaries.reduce((sum, s) => sum + secondsForGoal(goal, s), 0)
  const target = Math.max(1, goal.seconds)
  const ratio = seconds / target
  return {
    goal,
    seconds,
    ratio,
    progress: Math.min(1, ratio),
    state: stateFor(goal, seconds, elapsedShare),
    days: summaries.length,
    // Reads as "still to earn" for a floor and "still to spend" for a ceiling.
    remainingSeconds: Math.max(0, goal.seconds - seconds),
  }
}

/**
 * Evaluate every enabled goal.
 *
 * `today` is the summary for the selected day; `week` is the trailing week
 * (including today). Disabled goals are dropped rather than reported as zero —
 * a switched-off goal is not a failing goal.
 */
export function evaluateGoals(
  goals: Goal[],
  today: DaySummary,
  week: DaySummary[],
  opts: { dayElapsedShare?: number; weekElapsedShare?: number } = {}
): GoalProgress[] {
  return goals
    .filter((g) => g.enabled)
    .map((goal) =>
      goal.cadence === 'weekly'
        ? evaluateGoal(goal, week, { elapsedShare: opts.weekElapsedShare })
        : evaluateGoal(goal, [today], { elapsedShare: opts.dayElapsedShare })
    )
}

/**
 * How much of a tracking day has elapsed, 0–1.
 *
 * Used to pace daily goals. Clamped to the waking part of the day: at 4am the
 * answer is 0, not "you are 0% of the way through a goal you cannot have started
 * yet", and a goal is not judged against the hours you were asleep.
 */
export function dayElapsedShare(now: number, dayStart: number, activeHours = 12): number {
  const elapsedHours = (now - dayStart) / 3600_000
  // Work is assumed to start ~5 hours after the tracking day rolls over (9am on
  // the default 4am boundary) and to run for `activeHours`.
  const workStart = 5
  return Math.min(1, Math.max(0, (elapsedHours - workStart) / activeHours))
}

/** Sensible new goal, pre-filled for the "add goal" affordance. */
export function draftGoal(id: string): Goal {
  return {
    id,
    name: 'New goal',
    kind: 'productivity',
    target: 'productive',
    direction: 'at-least',
    seconds: 4 * 3600,
    cadence: 'daily',
    enabled: true,
  }
}

/** Coerce a goal arriving over IPC into something evaluable. */
export function sanitizeGoal(input: Partial<Goal>, fallbackId: string): Goal {
  const kind = input.kind === 'category' ? 'category' : 'productivity'
  const target =
    kind === 'productivity'
      ? input.target === 'distracting' || input.target === 'neutral'
        ? input.target
        : 'productive'
      : String(input.target ?? '').trim() || 'Uncategorized'
  const seconds = Math.round(Number(input.seconds))
  return {
    id: String(input.id || fallbackId),
    name: String(input.name ?? '').trim() || 'Goal',
    kind,
    target,
    direction: input.direction === 'at-most' ? 'at-most' : 'at-least',
    seconds: Number.isFinite(seconds) ? Math.min(24 * 3600 * 7, Math.max(60, seconds)) : 3600,
    cadence: input.cadence === 'weekly' ? 'weekly' : 'daily',
    enabled: input.enabled !== false,
  }
}
