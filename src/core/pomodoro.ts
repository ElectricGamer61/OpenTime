/**
 * Pomodoro scheduling.
 *
 * A Pomodoro run is not a second kind of tracked record — it is Focus,
 * scheduled. Every work phase is an ordinary focus session (`src/core/
 * focus.ts`): started when the phase begins, sealed when it ends, exactly
 * like a session someone started by hand. Break phases have no session at
 * all, so they are never claimed as focus time and can never double-count.
 * Pausing mid-work seals whatever really happened up to that instant, and
 * resuming opens a fresh session for what is left of the phase — two honest,
 * separately-sealed sessions with a real gap between them, rather than a
 * pause concept `ActiveFocus` was never built to have, which would otherwise
 * leave an unobserved stretch inside one session's window for `sealFocus` to
 * quietly fill in as work.
 *
 * This module is the pure phase arithmetic only — preset and custom minutes,
 * and countdown math from a remaining-seconds figure. The scheduling itself
 * (calling `startFocus`/`endFocus` at the right moments) is the renderer's
 * `usePomodoro`, because it has to talk to the running app.
 * `tests/pomodoro.test.ts` pins this module.
 */

import { EditError } from './edits'

export type PomodoroPhase = 'work' | 'break'

export interface PomodoroPreset {
  id: string
  label: string
  workMinutes: number
  breakMinutes: number
}

/** The two presets the setup panel offers before "Custom". */
export const POMODORO_PRESETS: PomodoroPreset[] = [
  { id: 'classic', label: '25 / 5', workMinutes: 25, breakMinutes: 5 },
  { id: 'long', label: '50 / 10', workMinutes: 50, breakMinutes: 10 },
]

export const DEFAULT_POMODORO_WORK_MINUTES = POMODORO_PRESETS[0].workMinutes
export const DEFAULT_POMODORO_BREAK_MINUTES = POMODORO_PRESETS[0].breakMinutes

/** Custom timing stays simple: whole minutes, inside a sane working day. */
export const MIN_POMODORO_WORK_MINUTES = 5
export const MAX_POMODORO_WORK_MINUTES = 180
export const MIN_POMODORO_BREAK_MINUTES = 1
export const MAX_POMODORO_BREAK_MINUTES = 60

export interface PomodoroPlan {
  workMinutes: number
  breakMinutes: number
}

/**
 * Validate custom work/break minutes. Presets never pass through this — they
 * are valid by construction — this is only for the "Custom" fields.
 */
export function validatePomodoroPlan(input: { workMinutes: number; breakMinutes: number }): PomodoroPlan {
  const workMinutes = Math.round(input.workMinutes)
  const breakMinutes = Math.round(input.breakMinutes)
  if (
    !Number.isFinite(workMinutes) ||
    workMinutes < MIN_POMODORO_WORK_MINUTES ||
    workMinutes > MAX_POMODORO_WORK_MINUTES
  ) {
    throw new EditError(`Work runs between ${MIN_POMODORO_WORK_MINUTES} and ${MAX_POMODORO_WORK_MINUTES} minutes.`)
  }
  if (
    !Number.isFinite(breakMinutes) ||
    breakMinutes < MIN_POMODORO_BREAK_MINUTES ||
    breakMinutes > MAX_POMODORO_BREAK_MINUTES
  ) {
    throw new EditError(`Break runs between ${MIN_POMODORO_BREAK_MINUTES} and ${MAX_POMODORO_BREAK_MINUTES} minutes.`)
  }
  return { workMinutes, breakMinutes }
}

export interface PomodoroCountdown {
  elapsedSeconds: number
  remainingSeconds: number
  /** 0–1, clamped. */
  fraction: number
  /** The phase's planned length has fully elapsed and should hand off to the next one. */
  done: boolean
}

/**
 * Progress through a single phase, from how many seconds it has left right
 * now — not a start time. A paused phase's remaining time is frozen rather
 * than still counting down from when the phase began, so the caller always
 * passes the current remaining seconds (ticking it down between renders is
 * `usePomodoro`'s job, the same way `focusProgress` is handed a `now`).
 */
export function pomodoroCountdown(remainingSeconds: number, totalSeconds: number): PomodoroCountdown {
  const total = Math.max(1, Math.round(totalSeconds))
  const remaining = Math.max(0, Math.round(remainingSeconds))
  const elapsed = Math.max(0, total - remaining)
  return {
    elapsedSeconds: elapsed,
    remainingSeconds: remaining,
    fraction: Math.min(1, elapsed / total),
    done: remaining <= 0,
  }
}

export function otherPhase(phase: PomodoroPhase): PomodoroPhase {
  return phase === 'work' ? 'break' : 'work'
}
