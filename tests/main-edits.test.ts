/**
 * Correction and export paths, end to end against the real store.
 *
 * These exercise the code the IPC handlers call, with a real `FileStorage`
 * behind them, so a correction is proven to survive a reopen — not merely to
 * mutate an array in memory.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dayKey } from '../src/core/day'
import { parseBackup } from '../src/core/export'
import type { Session } from '../src/core/types'
import { applyEdit } from '../src/main/edits/applyEdit'
import { buildExportPayload, resolveRange } from '../src/main/export/buildExport'
import { FileStorage } from '../src/main/storage/FileStorage'

let dir: string
let storage: FileStorage

const KEY = '2026-03-14'
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
    source: 'capture',
    ...patch,
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentime-main-'))
  storage = new FileStorage(dir)
  await storage.init()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('applyEdit', () => {
  it('splits a stored session into two, preserving total tracked time', async () => {
    await storage.appendSessions([session('a', at(9), at(11))])

    const result = await applyEdit(storage, { kind: 'split', dayKey: KEY, sessionId: 'a', at: at(10) })
    expect(result.ok).toBe(true)

    const sessions = await storage.getSessions(KEY)
    expect(sessions).toHaveLength(2)
    expect(sessions.reduce((s, x) => s + x.durationSeconds, 0)).toBe(2 * 3600)
    expect(sessions.every((s) => s.edited)).toBe(true)
  })

  it('merges two stored sessions into one', async () => {
    await storage.appendSessions([session('a', at(9), at(10)), session('b', at(10), at(11))])

    const result = await applyEdit(storage, {
      kind: 'merge',
      dayKey: KEY,
      sessionIds: ['a', 'b'],
    })
    expect(result.ok).toBe(true)

    const sessions = await storage.getSessions(KEY)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].durationSeconds).toBe(2 * 3600)
  })

  it('deletes a session and survives a reopen', async () => {
    await storage.appendSessions([session('a', at(9), at(10)), session('b', at(11), at(12))])
    await applyEdit(storage, { kind: 'delete', dayKey: KEY, sessionId: 'a' })
    await storage.flush()

    const reopened = new FileStorage(dir)
    await reopened.init()
    expect((await reopened.getSessions(KEY)).map((s) => s.id)).toEqual(['b'])
  })

  it('claims an away block as work and removes the block', async () => {
    await storage.appendSessions([session('a', at(9), at(10))])
    await storage.appendIdle(KEY, { startTime: at(11), endTime: at(12), durationSeconds: 3600 })

    const result = await applyEdit(storage, {
      kind: 'claim-idle',
      dayKey: KEY,
      idleStart: at(11),
      category: 'Meetings',
    })
    expect(result.ok).toBe(true)
    expect(await storage.getIdle(KEY)).toEqual([])

    const sessions = await storage.getSessions(KEY)
    expect(sessions).toHaveLength(2)
    // Exactly the claimed hour, counted once.
    expect(sessions.reduce((s, x) => s + x.durationSeconds, 0)).toBe(2 * 3600)
    expect(sessions[1].category).toBe('Meetings')
    expect(sessions[1].source).toBe('manual')
  })

  it('refuses to claim an away block that is already gone', async () => {
    const result = await applyEdit(storage, {
      kind: 'claim-idle',
      dayKey: KEY,
      idleStart: at(11),
      category: 'Meetings',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no longer there/)
  })

  it('adds a manual entry in a gap', async () => {
    await storage.appendSessions([session('a', at(9), at(10))])
    const result = await applyEdit(storage, {
      kind: 'manual',
      dayKey: KEY,
      startTime: at(13),
      endTime: at(15),
      category: 'Workshop',
    })
    expect(result.ok).toBe(true)
    expect(await storage.getSessions(KEY)).toHaveLength(2)
  })

  it('refuses a manual entry that would double-count tracked time', async () => {
    await storage.appendSessions([session('a', at(9), at(12))])
    const result = await applyEdit(storage, {
      kind: 'manual',
      dayKey: KEY,
      startTime: at(11),
      endTime: at(13),
      category: 'Workshop',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/overlaps/)
    // And nothing was written.
    expect(await storage.getSessions(KEY)).toHaveLength(1)
  })

  it('turns a validation failure into a message rather than a crash', async () => {
    await storage.appendSessions([session('a', at(9), at(11))])
    const result = await applyEdit(storage, {
      kind: 'split',
      dayKey: KEY,
      sessionId: 'a',
      at: at(9),
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/too close/)
    expect(await storage.getSessions(KEY)).toHaveLength(1)
  })

  it('reports a session that has already been removed', async () => {
    const result = await applyEdit(storage, { kind: 'delete', dayKey: KEY, sessionId: 'ghost' })
    expect(result.ok).toBe(false)
  })

  it('retimes a session and keeps the day sorted', async () => {
    await storage.appendSessions([session('a', at(9), at(10)), session('b', at(11), at(12))])
    await applyEdit(storage, {
      kind: 'retime',
      dayKey: KEY,
      sessionId: 'b',
      startTime: at(7),
      endTime: at(8),
    })
    const sessions = await storage.getSessions(KEY)
    expect(sessions[0].startTime).toBe(at(7))
    expect(sessions[1].startTime).toBe(at(9))
  })
})

describe('a correction cannot be filed under the wrong tracking day', () => {
  // The store trusts its caller for *which* day, so this is the guard that keeps
  // a day file's rows agreeing with `dayKey()`. A row whose timestamp maps to
  // another day makes that day's totals wrong and contradicts any re-aggregation
  // from timestamps — the local-vs-boundary bug `core/day.ts` exists to prevent.
  const beforeRollover = new Date(2026, 2, 14, 2, 0, 0, 0).getTime() // 2am on the 14th

  it('refuses a manual entry timed before the day it is being added to begins', async () => {
    // The tracking day 2026-03-14 runs 04:00 on the 14th to 04:00 on the 15th,
    // so 02:00 on the 14th belongs to 2026-03-13.
    expect(dayKey(beforeRollover, 4)).toBe('2026-03-13')

    const result = await applyEdit(storage, {
      kind: 'manual',
      dayKey: KEY,
      startTime: beforeRollover,
      endTime: beforeRollover + 3600_000,
      category: 'Workshop',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/outside the tracking day/i)
    expect(await storage.getSessions(KEY)).toHaveLength(0)
  })

  it('accepts an after-midnight entry, which is still the same tracking day', async () => {
    const oneAmNextMorning = new Date(2026, 2, 15, 1, 0, 0, 0).getTime()
    expect(dayKey(oneAmNextMorning, 4)).toBe(KEY)

    const result = await applyEdit(storage, {
      kind: 'manual',
      dayKey: KEY,
      startTime: oneAmNextMorning,
      endTime: oneAmNextMorning + 1800_000,
      category: 'Late fix',
    })

    expect(result.ok).toBe(true)
    const stored = await storage.getSessions(KEY)
    expect(stored).toHaveLength(1)
    expect(dayKey(stored[0].startTime, 4)).toBe(KEY)
  })

  it('refuses a retime that would push a session out of its day', async () => {
    await storage.appendSessions([session('a', at(9), at(11))])

    const result = await applyEdit(storage, {
      kind: 'retime',
      dayKey: KEY,
      sessionId: 'a',
      startTime: beforeRollover,
      endTime: beforeRollover + 3600_000,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/outside the tracking day/i)
    const stored = await storage.getSessions(KEY)
    expect(stored[0].startTime).toBe(at(9))
  })

  it('every stored session agrees with dayKey after a run of accepted edits', async () => {
    await storage.appendSessions([session('a', at(9), at(11)), session('b', at(13), at(15))])
    await applyEdit(storage, { kind: 'split', dayKey: KEY, sessionId: 'a', at: at(10) })
    await applyEdit(storage, {
      kind: 'manual', dayKey: KEY, startTime: at(20), endTime: at(21), category: 'Evening',
    })
    await applyEdit(storage, {
      kind: 'retime', dayKey: KEY, sessionId: 'b', startTime: at(13), endTime: at(14),
    })

    for (const s of await storage.getSessions(KEY)) {
      expect(dayKey(s.startTime, 4)).toBe(KEY)
    }
  })
})

describe('exports', () => {
  beforeEach(async () => {
    await storage.appendSessions([
      session('a', at(9), at(10)),
      session('b', at(11), at(12), { category: 'Breaks', productivity: 'distracting' }),
    ])
    await storage.appendIdle(KEY, { startTime: at(10), endTime: at(11), durationSeconds: 3600 })
  })

  it('resolves the whole history by default', () => {
    expect(resolveRange(storage, { format: 'sessions-csv' })).toEqual([KEY])
  })

  it('clips a requested range to the days that exist', () => {
    expect(resolveRange(storage, { format: 'sessions-csv', fromKey: '2026-03-01', toKey: '2026-03-10' })).toEqual([])
    expect(resolveRange(storage, { format: 'sessions-csv', fromKey: '2026-03-10', toKey: '2026-03-20' })).toEqual([KEY])
  })

  it('writes one CSV row per session', async () => {
    const payload = await buildExportPayload(storage, { format: 'sessions-csv' }, {
      exportedAt: 0,
      appVersion: '0.2.0',
    })
    expect(payload.count).toBe(2)
    expect(payload.unit).toBe('sessions')
    expect(payload.contents.trim().split('\n')).toHaveLength(3)
  })

  it('writes one CSV row per day with the away time included', async () => {
    const payload = await buildExportPayload(storage, { format: 'daily-csv' }, {
      exportedAt: 0,
      appVersion: '0.2.0',
    })
    expect(payload.count).toBe(1)
    expect(payload.contents).toContain('3600')
  })

  it('produces a backup that parses back into the same days', async () => {
    const payload = await buildExportPayload(storage, { format: 'backup-json' }, {
      exportedAt: 1234,
      appVersion: '0.2.0',
    })
    const parsed = parseBackup(payload.contents)
    expect(Object.keys(parsed.days)).toEqual([KEY])
    expect(parsed.days[KEY].sessions).toHaveLength(2)
    expect(parsed.days[KEY].idle).toHaveLength(1)
    expect(parsed.config.projects.length).toBeGreaterThan(0)
  })

  it('round-trips a backup through restore', async () => {
    const payload = await buildExportPayload(storage, { format: 'backup-json' }, {
      exportedAt: 1234,
      appVersion: '0.2.0',
    })
    const backup = parseBackup(payload.contents)

    // Wipe, then restore.
    await storage.putSessions(KEY, [])
    await storage.replaceAll(backup.config, backup.days)

    expect(await storage.getSessions(KEY)).toHaveLength(2)
    expect(await storage.getIdle(KEY)).toHaveLength(1)
  })

  it('seals a focus session into the day and survives a reopen', async () => {
    const outcome = await applyEdit(storage, {
      kind: 'seal-focus',
      dayKey: KEY,
      focus: {
        id: 'f1',
        label: 'Ship the billing fix',
        startTime: at(9, 30),
        plannedSeconds: 45 * 60,
        category: 'Deep Work',
        sound: 'silence',
      },
      endTime: at(10, 15),
    })
    expect(outcome.ok).toBe(true)

    // Re-open the store from disk: a seal that only mutated an in-memory array
    // would pass every other assertion here.
    const reopened = new FileStorage(dir)
    await reopened.init()
    const sessions = await reopened.getSessions(KEY)
    const marked = sessions.filter((s) => s.focus?.id === 'f1')
    expect(marked.length).toBeGreaterThan(0)
    expect(marked.every((s) => s.focus?.label === 'Ship the billing fix')).toBe(true)
    // 09:30–10:15 is 45 minutes, all of it accounted for one way or another.
    expect(marked.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(45 * 60)
  })

  it('reports an empty store rather than writing a headers-only file', () => {
    const empty = new FileStorage(path.join(dir, 'empty'))
    expect(resolveRange(empty, { format: 'sessions-csv' })).toEqual([])
  })
})
