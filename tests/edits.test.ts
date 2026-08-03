/**
 * Manual-correction tests.
 *
 * These are the operations that write over automatically captured history, so
 * the bar is that a correction can never leave the day in a state the
 * aggregation layer would silently mis-total: no zero-length rows, no duration
 * that disagrees with its timestamps, no double-counted minutes.
 */

import { describe, expect, it } from 'vitest'

import {
  applySessionEdit,
  claimIdleBlock,
  EditError,
  findOverlaps,
  makeManualSession,
  mergeSessions,
  removeIdleBlock,
  retimeSession,
  splitSession,
} from '../src/core/edits'
import { summarizeDay } from '../src/core/aggregate'
import type { Session } from '../src/core/types'

const at = (h: number, m = 0) => new Date(2026, 2, 14, h, m, 0, 0).getTime()

function session(id: string, from: number, to: number, patch: Partial<Session> = {}): Session {
  return {
    id,
    category: 'Deep Work',
    app: 'Code',
    title: 'tracker.ts',
    url: '',
    productivity: 'productive',
    startTime: from,
    endTime: to,
    durationSeconds: Math.round((to - from) / 1000),
    ...patch,
  }
}

describe('splitSession', () => {
  it('produces two halves whose durations add up to the original', () => {
    const original = session('a', at(9), at(11))
    const [left, right] = splitSession(original, at(10))
    expect(left.durationSeconds + right.durationSeconds).toBe(original.durationSeconds)
    expect(left.endTime).toBe(at(10))
    expect(right.startTime).toBe(at(10))
  })

  it('marks both halves as edited and gives them fresh ids', () => {
    const [left, right] = splitSession(session('a', at(9), at(11)), at(10))
    expect(left.edited).toBe(true)
    expect(right.edited).toBe(true)
    expect(new Set([left.id, right.id, 'a']).size).toBe(3)
  })

  it('refuses a split that would create a zero-length session', () => {
    const original = session('a', at(9), at(11))
    expect(() => splitSession(original, at(9))).toThrow(EditError)
    expect(() => splitSession(original, at(11))).toThrow(EditError)
    expect(() => splitSession(original, at(9) + 1000)).toThrow(EditError)
  })

  it('refuses a nonsense split point', () => {
    expect(() => splitSession(session('a', at(9), at(11)), Number.NaN)).toThrow(EditError)
  })
})

describe('mergeSessions', () => {
  it('spans from the earliest start to the latest end', () => {
    const merged = mergeSessions([
      session('b', at(10), at(11)),
      session('a', at(9), at(9, 30)),
    ])
    expect(merged.startTime).toBe(at(9))
    expect(merged.endTime).toBe(at(11))
    expect(merged.durationSeconds).toBe(2 * 3600)
  })

  it('takes its identity from the longest piece, not the first', () => {
    const merged = mergeSessions([
      session('blip', at(9), at(9, 1), { app: 'Terminal', category: 'Shell' }),
      session('real', at(9, 1), at(10), { app: 'Code', category: 'Deep Work' }),
    ])
    expect(merged.category).toBe('Deep Work')
    expect(merged.app).toBe('Code')
  })

  it('needs at least two sessions', () => {
    expect(() => mergeSessions([session('a', at(9), at(10))])).toThrow(EditError)
  })
})

describe('makeManualSession', () => {
  it('records off-machine work with a computed duration', () => {
    const created = makeManualSession({
      startTime: at(13),
      endTime: at(15),
      category: 'Workshop',
      note: 'Off-site, no laptop',
    })
    expect(created.durationSeconds).toBe(2 * 3600)
    expect(created.source).toBe('manual')
    expect(created.edited).toBe(true)
    expect(created.note).toBe('Off-site, no laptop')
  })

  it('defaults to productive but honours an explicit level', () => {
    expect(makeManualSession({ startTime: at(9), endTime: at(10), category: 'X' }).productivity).toBe(
      'productive'
    )
    expect(
      makeManualSession({
        startTime: at(9),
        endTime: at(10),
        category: 'X',
        productivity: 'neutral',
      }).productivity
    ).toBe('neutral')
  })

  it('rejects entries with no category, no length, or backwards times', () => {
    expect(() => makeManualSession({ startTime: at(9), endTime: at(10), category: '  ' })).toThrow(
      EditError
    )
    expect(() => makeManualSession({ startTime: at(9), endTime: at(9), category: 'X' })).toThrow(
      EditError
    )
    expect(() => makeManualSession({ startTime: at(11), endTime: at(9), category: 'X' })).toThrow(
      EditError
    )
  })
})

describe('claimIdleBlock', () => {
  it('turns an away block into tracked time covering exactly that span', () => {
    const block = { startTime: at(11), endTime: at(12), durationSeconds: 3600 }
    const claimed = claimIdleBlock(block, { category: 'Meetings' })
    expect(claimed.startTime).toBe(block.startTime)
    expect(claimed.endTime).toBe(block.endTime)
    expect(claimed.durationSeconds).toBe(3600)
    expect(claimed.source).toBe('manual')
  })

  it('leaves no double-counted minutes once the block is removed', () => {
    const block = { startTime: at(11), endTime: at(12), durationSeconds: 3600 }
    const idle = [block]
    const claimed = claimIdleBlock(block, { category: 'Meetings' })
    const summary = summarizeDay(
      '2026-03-14',
      [session('a', at(9), at(10)), claimed],
      removeIdleBlock(idle, block.startTime)
    )
    expect(summary.totalSeconds).toBe(2 * 3600)
    expect(summary.idleSeconds).toBe(0)
  })
})

describe('retimeSession', () => {
  it('moves a session and recomputes its duration', () => {
    const moved = retimeSession(session('a', at(9), at(10)), at(9, 30), at(11))
    expect(moved.durationSeconds).toBe(90 * 60)
    expect(moved.edited).toBe(true)
  })

  it('refuses to collapse a session to nothing', () => {
    expect(() => retimeSession(session('a', at(9), at(10)), at(9), at(9))).toThrow(EditError)
  })
})

describe('applySessionEdit', () => {
  it('removes and inserts in one pass, keeping the day sorted', () => {
    const day = [session('a', at(9), at(10)), session('c', at(14), at(15))]
    const next = applySessionEdit(day, {
      remove: ['a'],
      add: [session('b', at(11), at(12)), session('a2', at(8), at(8, 30))],
    })
    expect(next.map((s) => s.id)).toEqual(['a2', 'b', 'c'])
  })

  it('is a no-op when nothing is added or removed', () => {
    const day = [session('a', at(9), at(10))]
    expect(applySessionEdit(day, {}).map((s) => s.id)).toEqual(['a'])
  })
})

describe('findOverlaps', () => {
  const day = [session('a', at(9), at(10)), session('b', at(14), at(15))]

  it('finds the sessions a proposed span would double-count', () => {
    expect(findOverlaps({ startTime: at(9, 30), endTime: at(11) }, day).map((s) => s.id)).toEqual(['a'])
  })

  it('treats touching edges as not overlapping', () => {
    expect(findOverlaps({ startTime: at(10), endTime: at(11) }, day)).toEqual([])
  })

  it('returns nothing for a clear gap', () => {
    expect(findOverlaps({ startTime: at(11), endTime: at(12) }, day)).toEqual([])
  })
})
