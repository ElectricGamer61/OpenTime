import { describe, expect, it } from 'vitest'

import { summarizeDay } from '../src/core/aggregate'
import {
  dayElapsedShare,
  evaluateGoal,
  evaluateGoals,
  sanitizeGoal,
  secondsForGoal,
} from '../src/core/goals'
import type { Goal, Session } from '../src/core/types'

const at = (h: number, m = 0) => new Date(2026, 2, 14, h, m, 0, 0).getTime()

function session(id: string, from: number, to: number, patch: Partial<Session> = {}): Session {
  return {
    id,
    category: 'Deep Work',
    app: 'Code',
    title: '',
    url: '',
    productivity: 'productive',
    startTime: from,
    endTime: to,
    durationSeconds: Math.round((to - from) / 1000),
    ...patch,
  }
}

const day = (sessions: Session[]) => summarizeDay('2026-03-14', sessions)

const focusGoal: Goal = {
  id: 'g1',
  name: 'Daily focus',
  kind: 'productivity',
  target: 'productive',
  direction: 'at-least',
  seconds: 4 * 3600,
  cadence: 'daily',
  enabled: true,
}

const distractionCeiling: Goal = {
  ...focusGoal,
  id: 'g2',
  name: 'Distraction ceiling',
  target: 'distracting',
  direction: 'at-most',
  seconds: 30 * 60,
}

describe('secondsForGoal', () => {
  it('reads the matching productivity total', () => {
    const summary = day([
      session('a', at(9), at(11)),
      session('b', at(11), at(12), { productivity: 'distracting', category: 'Breaks' }),
    ])
    expect(secondsForGoal(focusGoal, summary)).toBe(2 * 3600)
    expect(secondsForGoal(distractionCeiling, summary)).toBe(3600)
  })

  it('sums a category regardless of case', () => {
    const summary = day([session('a', at(9), at(11))])
    const goal: Goal = { ...focusGoal, kind: 'category', target: 'deep work' }
    expect(secondsForGoal(goal, summary)).toBe(2 * 3600)
  })

  it('returns zero for a category nothing landed in', () => {
    const summary = day([session('a', at(9), at(11))])
    expect(secondsForGoal({ ...focusGoal, kind: 'category', target: 'Design' }, summary)).toBe(0)
  })
})

describe('evaluateGoal', () => {
  it('reports a floor as met once the target is reached', () => {
    const result = evaluateGoal(focusGoal, [day([session('a', at(9), at(13, 30))])])
    expect(result.state).toBe('met')
    expect(result.progress).toBe(1)
    expect(result.remainingSeconds).toBe(0)
  })

  it('clamps progress but keeps the true ratio', () => {
    const result = evaluateGoal(focusGoal, [day([session('a', at(9), at(17))])])
    expect(result.progress).toBe(1)
    expect(result.ratio).toBeCloseTo(2, 1)
  })

  it('is on track rather than behind when the window has barely started', () => {
    const summary = day([session('a', at(9), at(9, 30))])
    expect(evaluateGoal(focusGoal, [summary], { elapsedShare: 0.1 }).state).toBe('on-track')
    expect(evaluateGoal(focusGoal, [summary], { elapsedShare: 1 }).state).toBe('behind')
  })

  it('reports a ceiling as exceeded only when it is actually breached', () => {
    const under = day([
      session('a', at(9), at(9, 20), { productivity: 'distracting', category: 'Breaks' }),
    ])
    const over = day([
      session('a', at(9), at(10), { productivity: 'distracting', category: 'Breaks' }),
    ])
    expect(evaluateGoal(distractionCeiling, [under]).state).toBe('met')
    expect(evaluateGoal(distractionCeiling, [over]).state).toBe('exceeded')
  })

  it('warns that a ceiling is being spent too fast', () => {
    const summary = day([
      session('a', at(9), at(9, 25), { productivity: 'distracting', category: 'Breaks' }),
    ])
    // 25 of 30 allowed minutes gone with only a fifth of the day elapsed.
    expect(evaluateGoal(distractionCeiling, [summary], { elapsedShare: 0.2 }).state).toBe('at-risk')
  })

  it('sums a weekly goal across every day in the window', () => {
    const days = [
      day([session('a', at(9), at(12))]),
      day([session('b', at(9), at(12))]),
      day([session('c', at(9), at(12))]),
    ]
    const weekly: Goal = { ...focusGoal, cadence: 'weekly', seconds: 20 * 3600 }
    const result = evaluateGoal(weekly, days)
    expect(result.seconds).toBe(9 * 3600)
    expect(result.days).toBe(3)
    expect(result.remainingSeconds).toBe(11 * 3600)
  })

  it('reports an empty window as zero rather than dividing by nothing', () => {
    const result = evaluateGoal(focusGoal, [])
    expect(result.seconds).toBe(0)
    expect(result.progress).toBe(0)
    expect(Number.isFinite(result.ratio)).toBe(true)
  })
})

describe('evaluateGoals', () => {
  it('skips disabled goals entirely', () => {
    const summary = day([session('a', at(9), at(11))])
    const results = evaluateGoals(
      [focusGoal, { ...distractionCeiling, enabled: false }],
      summary,
      [summary]
    )
    expect(results).toHaveLength(1)
    expect(results[0].goal.id).toBe('g1')
  })

  it('routes daily and weekly goals to the right window', () => {
    const today = day([session('a', at(9), at(11))])
    const week = [today, day([session('b', at(9), at(11))])]
    const results = evaluateGoals([focusGoal, { ...focusGoal, id: 'w', cadence: 'weekly' }], today, week)
    expect(results[0].seconds).toBe(2 * 3600)
    expect(results[1].seconds).toBe(4 * 3600)
  })
})

describe('dayElapsedShare', () => {
  const dayStart = at(4)

  it('is zero before the working window opens', () => {
    expect(dayElapsedShare(at(5), dayStart)).toBe(0)
  })

  it('grows through the day and saturates at one', () => {
    const morning = dayElapsedShare(at(11), dayStart)
    const afternoon = dayElapsedShare(at(16), dayStart)
    expect(morning).toBeGreaterThan(0)
    expect(afternoon).toBeGreaterThan(morning)
    expect(dayElapsedShare(at(23), dayStart)).toBe(1)
  })
})

describe('sanitizeGoal', () => {
  it('repairs a goal arriving with nonsense fields', () => {
    const goal = sanitizeGoal(
      { name: '   ', kind: 'productivity', target: 'banana', seconds: -5, cadence: 'hourly' } as never,
      'fallback'
    )
    expect(goal.id).toBe('fallback')
    expect(goal.name).toBe('Goal')
    expect(goal.target).toBe('productive')
    expect(goal.seconds).toBeGreaterThanOrEqual(60)
    expect(goal.cadence).toBe('daily')
  })

  it('keeps a well-formed goal intact', () => {
    expect(sanitizeGoal(distractionCeiling, 'x')).toEqual(distractionCeiling)
  })

  it('keeps a category target as written', () => {
    const goal = sanitizeGoal({ kind: 'category', target: 'Client: Acme' }, 'x')
    expect(goal.target).toBe('Client: Acme')
  })
})
