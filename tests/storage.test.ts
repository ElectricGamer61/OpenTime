import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { JsonStorage, migrate } from '../src/main/storage/JsonStorage'
import { DEFAULT_SETTINGS } from '../src/core/defaults'
import type { Session } from '../src/core/types'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentime-test-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const at = (h: number) => new Date(2026, 2, 14, h, 0, 0, 0).getTime()

function session(id: string, startHour: number, minutes: number): Session {
  return {
    id,
    category: 'Engineering',
    app: 'Code',
    title: '',
    url: '',
    productivity: 'productive',
    startTime: at(startHour),
    endTime: at(startHour) + minutes * 60_000,
    durationSeconds: minutes * 60,
  }
}

describe('JsonStorage', () => {
  it('starts from defaults when no file exists', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    expect(storage.getSettings().idleThresholdSeconds).toBe(DEFAULT_SETTINGS.idleThresholdSeconds)
    expect(storage.getProjects().length).toBeGreaterThan(0)
    expect(storage.isEmpty()).toBe(true)
  })

  it('buckets appended sessions into their tracking day', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    await storage.appendSessions([session('a', 9, 30), session('b', 14, 60)])
    expect(storage.getSessions('2026-03-14')).toHaveLength(2)
    expect(storage.isEmpty()).toBe(false)
  })

  it('keeps each day sorted even when sessions arrive out of order', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    await storage.appendSessions([session('late', 16, 10)])
    await storage.appendSessions([session('early', 9, 10)])
    expect(storage.getSessions('2026-03-14').map((s) => s.id)).toEqual(['early', 'late'])
  })

  it('persists and reloads across instances', async () => {
    const first = new JsonStorage(dir)
    await first.init()
    await first.appendSessions([session('a', 9, 30)])
    await first.saveSettings({ ...first.getSettings(), idleThresholdSeconds: 300 })
    await first.flush()

    const second = new JsonStorage(dir)
    await second.init()
    expect(second.getSessions('2026-03-14')).toHaveLength(1)
    expect(second.getSettings().idleThresholdSeconds).toBe(300)
  })

  it('replaces a day’s events rather than appending duplicates', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    await storage.putEvents('2026-03-14', [
      { id: 'e1', title: 'Standup', start: at(9), end: at(10), source: 'google' },
    ])
    await storage.putEvents('2026-03-14', [
      { id: 'e1', title: 'Standup (moved)', start: at(11), end: at(12), source: 'google' },
    ])
    expect(storage.getEvents('2026-03-14')).toHaveLength(1)
    expect(storage.getEvents('2026-03-14')[0].title).toBe('Standup (moved)')
  })

  it('updates a stored session in place and keeps its id', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    await storage.appendSessions([session('a', 9, 30)])
    const updated = await storage.updateSession('2026-03-14', 'a', {
      category: 'Design',
      productivity: 'neutral',
    })
    expect(updated).toMatchObject({ id: 'a', category: 'Design', productivity: 'neutral' })
    expect(storage.getSessions('2026-03-14')[0].category).toBe('Design')
  })

  it('returns null when updating a session that is not there', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    expect(await storage.updateSession('2026-03-14', 'nope', { category: 'X' })).toBeNull()
  })

  it('recovers from a corrupt data file instead of crashing', async () => {
    const file = path.join(dir, 'opentime-data.json')
    await fs.writeFile(file, '{ this is not json', 'utf8')
    const storage = new JsonStorage(dir)
    await storage.init()
    expect(storage.isEmpty()).toBe(true)
    // The unreadable original is kept for forensics rather than silently lost.
    const entries = await fs.readdir(dir)
    expect(entries.some((e) => e.includes('.corrupt-'))).toBe(true)
  })

  it('returns empty lists for days that have no data', async () => {
    const storage = new JsonStorage(dir)
    await storage.init()
    expect(storage.getSessions('1999-01-01')).toEqual([])
    expect(storage.getIdle('1999-01-01')).toEqual([])
    expect(storage.getEvents('1999-01-01')).toEqual([])
  })
})

describe('migrate', () => {
  it('fills in missing sections of an older state file', () => {
    const state = migrate({ version: 0, sessionsByDay: { '2026-03-14': [] } })
    expect(state.settings).toMatchObject({ idleThresholdSeconds: 120 })
    expect(state.settings.calendar.scope).toBe('calendar.readonly')
    expect(state.projects.length).toBeGreaterThan(0)
    expect(state.idleByDay).toEqual({})
  })

  it('preserves values the file already had', () => {
    const state = migrate({
      version: 1,
      settings: { ...DEFAULT_SETTINGS, pollIntervalSeconds: 30 },
      projects: [{ id: 'x', name: 'Only', color: '#fff', keywords: [] }],
    })
    expect(state.settings.pollIntervalSeconds).toBe(30)
    expect(state.projects).toHaveLength(1)
  })

  it('tolerates null', () => {
    expect(migrate(null).version).toBe(1)
  })
})
