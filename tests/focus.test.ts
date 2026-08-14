import { describe, expect, it } from 'vitest'

import {
  focusOutcome,
  focusProgress,
  sealFocus,
  startFocus,
  AMBIENT_BEDS,
  DEFAULT_FOCUS_CATEGORY,
} from '../src/core/focus'
import { EditError } from '../src/core/edits'
import type { ActiveFocus, Session } from '../src/core/types'

const T0 = new Date('2026-03-09T09:00:00').getTime()
const min = (n: number) => n * 60_000

let counter = 0
function session(offsetMinutes: number, minutes: number, patch: Partial<Session> = {}): Session {
  const startTime = T0 + min(offsetMinutes)
  const endTime = startTime + min(minutes)
  counter += 1
  return {
    id: `s${counter}`,
    category: 'Deep Work',
    app: 'Code',
    title: 'opentime — App.tsx',
    url: '',
    productivity: 'productive',
    startTime,
    endTime,
    durationSeconds: Math.round((endTime - startTime) / 1000),
    ...patch,
  }
}

function focus(patch: Partial<ActiveFocus> = {}): ActiveFocus {
  return {
    id: 'f1',
    label: 'Ship the billing fix',
    startTime: T0 + min(10),
    plannedSeconds: 45 * 60,
    category: DEFAULT_FOCUS_CATEGORY,
    sound: 'silence',
    ...patch,
  }
}

/** Deterministic ids, so a snapshot of the sealed day is stable. */
let idCounter = 0
const makeId = (prefix = 'x') => `${prefix}_${(idCounter += 1)}`

describe('startFocus', () => {
  it('fills in every field a half-filled session would leave undefined', () => {
    const f = startFocus({}, T0)
    expect(f.label).toBe('Focus session')
    expect(f.plannedSeconds).toBe(45 * 60)
    expect(f.category).toBe(DEFAULT_FOCUS_CATEGORY)
    expect(f.sound).toBe('silence')
    expect(f.startTime).toBe(T0)
  })

  it('trims the goal and keeps the chosen bed', () => {
    const f = startFocus({ label: '  Write the RFC  ', minutes: 25, sound: 'rain' }, T0)
    expect(f.label).toBe('Write the RFC')
    expect(f.plannedSeconds).toBe(25 * 60)
    expect(f.sound).toBe('rain')
  })

  it('rejects a bed it does not have rather than playing nothing silently', () => {
    const f = startFocus({ sound: 'lofi-beats' as never }, T0)
    expect(AMBIENT_BEDS.some((b) => b.id === f.sound)).toBe(true)
    expect(f.sound).toBe('silence')
  })

  it('refuses absurd durations', () => {
    expect(() => startFocus({ minutes: 0 }, T0)).toThrow(EditError)
    expect(() => startFocus({ minutes: 9 * 60 }, T0)).toThrow(EditError)
  })
})

describe('focusProgress', () => {
  it('counts down, then reports the overrun rather than a negative', () => {
    const f = focus({ startTime: T0, plannedSeconds: 600 })
    expect(focusProgress(f, T0 + min(5)).remainingSeconds).toBe(300)
    expect(focusProgress(f, T0 + min(5)).fraction).toBeCloseTo(0.5)

    const over = focusProgress(f, T0 + min(12))
    expect(over.remainingSeconds).toBe(0)
    expect(over.overrun).toBe(true)
    expect(over.overrunSeconds).toBe(120)
    expect(over.fraction).toBe(1)
  })
})

describe('sealFocus', () => {
  it('stamps the sessions inside the window and leaves the rest alone', () => {
    const before = session(0, 5)
    const inside = session(10, 20)
    const after = session(60, 10)
    const sealed = sealFocus([before, inside, after], focus(), T0 + min(40), makeId)

    // Two marked rows: the observed one, plus the fill for 09:30–09:40 that
    // nothing was recorded against.
    const marked = sealed.sessions.filter((s) => s.focus?.id === 'f1')
    expect(marked).toHaveLength(2)
    expect(marked[0].id).toBe(inside.id)
    expect(marked[0].focus?.label).toBe('Ship the billing fix')
    expect(sealed.sessions.find((s) => s.id === before.id)?.focus).toBeUndefined()
    expect(sealed.sessions.find((s) => s.id === after.id)?.focus).toBeUndefined()
  })

  it('splits a session straddling the start so earlier minutes are not claimed', () => {
    // 09:00–09:30, focus runs 09:10–09:40.
    const straddling = session(0, 30)
    const sealed = sealFocus([straddling], focus(), T0 + min(40), makeId)

    const marked = sealed.sessions.filter((s) => s.focus?.id === 'f1')
    const unmarked = sealed.sessions.filter((s) => !s.focus)
    expect(unmarked).toHaveLength(1)
    expect(unmarked[0].startTime).toBe(T0)
    expect(unmarked[0].endTime).toBe(T0 + min(10))
    expect(unmarked[0].durationSeconds).toBe(600)
    expect(marked[0].startTime).toBe(T0 + min(10))
    expect(marked[0].endTime).toBe(T0 + min(30))
  })

  it('never loses or duplicates time when it splits', () => {
    const day = [session(0, 30), session(35, 20), session(60, 15)]
    const total = day.reduce((sum, s) => sum + s.durationSeconds, 0)
    const sealed = sealFocus(day, focus(), T0 + min(40), makeId)
    // Filled rows add time that was never observed, so compare only the rows
    // that came from the originals.
    const kept = sealed.sessions.filter((s) => s.app !== 'Focus session')
    expect(kept.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(total)
  })

  it('sends a row whole to the majority side rather than making a two-second orphan', () => {
    // Starts one second before the window: splitting would leave a 1s piece.
    const nearlyInside = session(0, 20, {
      startTime: T0 + min(10) - 1000,
      endTime: T0 + min(30),
      durationSeconds: 1201,
    })
    const sealed = sealFocus([nearlyInside], focus(), T0 + min(40), makeId)
    expect(sealed.sessions).toHaveLength(2) // the row plus one filled gap
    expect(sealed.sessions.find((s) => s.id === nearlyInside.id)?.focus?.id).toBe('f1')
  })

  it('fills the minutes nothing was observed for, so a dark window still records', () => {
    const sealed = sealFocus([], focus(), T0 + min(40), makeId)
    expect(sealed.filled).toBe(1)
    expect(sealed.sessions).toHaveLength(1)
    expect(sealed.sessions[0].source).toBe('manual')
    expect(sealed.sessions[0].category).toBe(DEFAULT_FOCUS_CATEGORY)
    expect(sealed.sessions[0].title).toBe('Ship the billing fix')
    expect(sealed.seconds).toBe(30 * 60)
  })

  it('fills only the gaps, not the whole window', () => {
    const sealed = sealFocus([session(10, 10), session(25, 5)], focus(), T0 + min(40), makeId)
    const filled = sealed.sessions.filter((s) => s.app === 'Focus session')
    // 09:20–09:25 and 09:30–09:40.
    expect(filled.map((s) => s.durationSeconds).sort((a, b) => a - b)).toEqual([300, 600])
    expect(sealed.seconds).toBe(30 * 60)
  })

  it('attributes the whole session to the project the user picked', () => {
    const sealed = sealFocus([session(10, 20)], focus({ projectId: 'p9' }), T0 + min(40), makeId)
    expect(sealed.sessions.every((s) => s.projectId === 'p9')).toBe(true)
  })

  it('refuses a window too short to be a session', () => {
    expect(() => sealFocus([], focus(), focus().startTime + 500, makeId)).toThrow(EditError)
  })

  it('is idempotent for the same id, so a retry cannot double-mark a day', () => {
    const once = sealFocus([session(10, 20)], focus(), T0 + min(40), makeId)
    const twice = sealFocus(once.sessions, focus(), T0 + min(40), makeId)
    expect(twice.seconds).toBe(once.seconds)
    expect(twice.sessions.filter((s) => s.focus?.id === 'f1')).toHaveLength(
      once.sessions.filter((s) => s.focus?.id === 'f1').length
    )
  })
})

describe('focusOutcome', () => {
  it('reads a sealed session back as planned-vs-actual with its apps', () => {
    const sealed = sealFocus(
      [session(10, 20, { app: 'Code' }), session(30, 5, { app: 'chrome', url: 'github.com' })],
      focus(),
      T0 + min(40),
      makeId
    )
    const outcome = focusOutcome(sealed.sessions, 'f1')
    expect(outcome?.label).toBe('Ship the billing fix')
    expect(outcome?.plannedSeconds).toBe(45 * 60)
    expect(outcome?.actualSeconds).toBe(30 * 60)
    expect(outcome?.apps[0].name).toBe('Code')
  })

  it('returns null when nothing carries that id', () => {
    expect(focusOutcome([session(0, 10)], 'nope')).toBeNull()
  })
})
