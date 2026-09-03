import { describe, expect, it } from 'vitest'

import { EditError } from '../src/core/edits'
import {
  MAX_POMODORO_BREAK_MINUTES,
  MAX_POMODORO_WORK_MINUTES,
  MIN_POMODORO_BREAK_MINUTES,
  MIN_POMODORO_WORK_MINUTES,
  POMODORO_PRESETS,
  otherPhase,
  pomodoroCountdown,
  validatePomodoroPlan,
} from '../src/core/pomodoro'

describe('POMODORO_PRESETS', () => {
  it('offers the classic 25/5 and long 50/10 presets', () => {
    expect(POMODORO_PRESETS.find((p) => p.workMinutes === 25 && p.breakMinutes === 5)).toBeTruthy()
    expect(POMODORO_PRESETS.find((p) => p.workMinutes === 50 && p.breakMinutes === 10)).toBeTruthy()
  })
})

describe('validatePomodoroPlan', () => {
  it('accepts a plan inside bounds, rounding fractional minutes', () => {
    expect(validatePomodoroPlan({ workMinutes: 20.4, breakMinutes: 4.6 })).toEqual({
      workMinutes: 20,
      breakMinutes: 5,
    })
  })

  it('rejects work below the minimum', () => {
    expect(() => validatePomodoroPlan({ workMinutes: MIN_POMODORO_WORK_MINUTES - 1, breakMinutes: 5 })).toThrow(
      EditError
    )
  })

  it('rejects work above the maximum', () => {
    expect(() => validatePomodoroPlan({ workMinutes: MAX_POMODORO_WORK_MINUTES + 1, breakMinutes: 5 })).toThrow(
      EditError
    )
  })

  it('rejects break below the minimum', () => {
    expect(() => validatePomodoroPlan({ workMinutes: 25, breakMinutes: MIN_POMODORO_BREAK_MINUTES - 1 })).toThrow(
      EditError
    )
  })

  it('rejects break above the maximum', () => {
    expect(() => validatePomodoroPlan({ workMinutes: 25, breakMinutes: MAX_POMODORO_BREAK_MINUTES + 1 })).toThrow(
      EditError
    )
  })

  it('rejects non-finite input', () => {
    expect(() => validatePomodoroPlan({ workMinutes: NaN, breakMinutes: 5 })).toThrow(EditError)
    expect(() => validatePomodoroPlan({ workMinutes: 25, breakMinutes: Infinity })).toThrow(EditError)
  })
})

describe('pomodoroCountdown', () => {
  it('reports zero elapsed at the very start of a phase', () => {
    const c = pomodoroCountdown(25 * 60, 25 * 60)
    expect(c.elapsedSeconds).toBe(0)
    expect(c.fraction).toBe(0)
    expect(c.done).toBe(false)
  })

  it('tracks elapsed and fraction partway through', () => {
    const c = pomodoroCountdown(15 * 60, 25 * 60)
    expect(c.elapsedSeconds).toBe(10 * 60)
    expect(c.fraction).toBeCloseTo(10 / 25, 5)
    expect(c.done).toBe(false)
  })

  it('is done exactly when remaining hits zero, never negative', () => {
    const c = pomodoroCountdown(0, 25 * 60)
    expect(c.remainingSeconds).toBe(0)
    expect(c.fraction).toBe(1)
    expect(c.done).toBe(true)
  })

  it('clamps a remaining figure that overshot past zero', () => {
    const c = pomodoroCountdown(-30, 25 * 60)
    expect(c.remainingSeconds).toBe(0)
    expect(c.done).toBe(true)
  })
})

describe('otherPhase', () => {
  it('flips work and break', () => {
    expect(otherPhase('work')).toBe('break')
    expect(otherPhase('break')).toBe('work')
  })
})
