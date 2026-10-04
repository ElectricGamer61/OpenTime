/**
 * Storage tests.
 *
 * The interesting cases are the ones a single-JSON-blob store could not even
 * express: crash recovery from the journal, per-day sharding, migration from the
 * v0 file, retention, and restore.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '../src/main/storage/FileStorage'
import { DEFAULT_SETTINGS, defaultConfig, migrateConfig } from '../src/core/defaults'
import type { Session } from '../src/core/types'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentime-test-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const at = (h: number, m = 0) => new Date(2026, 2, 14, h, m, 0, 0).getTime()

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

async function open(): Promise<FileStorage> {
  const storage = new FileStorage(dir)
  await storage.init()
  return storage
}

const storeDir = () => path.join(dir, 'opentime')
const journal = () => path.join(storeDir(), 'journal.jsonl')

describe('FileStorage', () => {
  it('starts from defaults when nothing exists', async () => {
    const storage = await open()
    expect(storage.getSettings().idleThresholdSeconds).toBe(DEFAULT_SETTINGS.idleThresholdSeconds)
    expect(storage.getProjects().length).toBeGreaterThan(0)
    expect(storage.getGoals().length).toBeGreaterThan(0)
    expect(storage.isEmpty()).toBe(true)
  })

  it('buckets appended sessions into their tracking day', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30), session('b', 14, 60)])
    expect(await storage.getSessions('2026-03-14')).toHaveLength(2)
    expect(storage.isEmpty()).toBe(false)
    expect(storage.listDayKeys()).toEqual(['2026-03-14'])
  })

  it('keeps each day sorted even when sessions arrive out of order', async () => {
    const storage = await open()
    await storage.appendSessions([session('late', 16, 10)])
    await storage.appendSessions([session('early', 9, 10)])
    expect((await storage.getSessions('2026-03-14')).map((s) => s.id)).toEqual(['early', 'late'])
  })

  it('persists and reloads across instances', async () => {
    const first = await open()
    await first.appendSessions([session('a', 9, 30)])
    await first.saveSettings({ ...first.getSettings(), idleThresholdSeconds: 300 })
    await first.flush()

    const second = await open()
    expect(await second.getSessions('2026-03-14')).toHaveLength(1)
    expect(second.getSettings().idleThresholdSeconds).toBe(300)
  })

  it('writes one file per tracking day rather than one file for everything', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30)])
    await storage.appendSessions([
      { ...session('b', 9, 30), startTime: at(9) + 86_400_000, endTime: at(10) + 86_400_000 },
    ])
    await storage.flush()
    const files = (await fs.readdir(path.join(storeDir(), 'days'))).sort()
    expect(files).toEqual(['2026-03-14.json', '2026-03-15.json'])
  })

  it('replaces a day’s events rather than appending duplicates', async () => {
    const storage = await open()
    await storage.putEvents('2026-03-14', [
      { id: 'e1', title: 'Standup', start: at(9), end: at(10), source: 'google' },
    ])
    await storage.putEvents('2026-03-14', [
      { id: 'e1', title: 'Standup (moved)', start: at(11), end: at(12), source: 'google' },
    ])
    const events = await storage.getEvents('2026-03-14')
    expect(events).toHaveLength(1)
    expect(events[0].title).toBe('Standup (moved)')
  })

  it('updates a stored session in place and keeps its id', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30)])
    const updated = await storage.updateSession('2026-03-14', 'a', {
      category: 'Design',
      productivity: 'neutral',
    })
    expect(updated).toMatchObject({ id: 'a', category: 'Design', productivity: 'neutral' })
    expect((await storage.getSessions('2026-03-14'))[0].category).toBe('Design')
  })

  it('clears a field patched to null, and it stays cleared after a restart', async () => {
    const storage = await open()
    await storage.appendSessions([{ ...session('a', 9, 30), projectId: 'p1', note: 'x' }])
    const updated = await storage.updateSession('2026-03-14', 'a', { category: 'Admin', projectId: null, note: null })
    expect(updated).not.toHaveProperty('projectId')
    expect(updated).not.toHaveProperty('note')
    // Replayed from the journal on the next start, not just held in memory.
    const reopened = await open()
    const [row] = await reopened.getSessions('2026-03-14')
    expect(row).toMatchObject({ category: 'Admin' })
    expect(row).not.toHaveProperty('projectId')
  })

  it('returns null when updating a session that is not there', async () => {
    const storage = await open()
    expect(await storage.updateSession('2026-03-14', 'nope', { category: 'X' })).toBeNull()
  })

  it('returns empty lists for days that have no data', async () => {
    const storage = await open()
    expect(await storage.getSessions('1999-01-01')).toEqual([])
    expect(await storage.getIdle('1999-01-01')).toEqual([])
    expect(await storage.getEvents('1999-01-01')).toEqual([])
  })
})

describe('FileStorage durability', () => {
  it('recovers writes from the journal when the process dies before a checkpoint', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30)])
    await storage.appendIdle('2026-03-14', {
      startTime: at(12),
      endTime: at(13),
      durationSeconds: 3600,
    })
    // No flush: this is exactly the "power cut two seconds later" case. The day
    // file has not been written, but the journal has.
    expect(await fs.readFile(journal(), 'utf8')).toContain('appendSessions')

    const reopened = await open()
    expect(await reopened.getSessions('2026-03-14')).toHaveLength(1)
    expect(await reopened.getIdle('2026-03-14')).toHaveLength(1)
  })

  it('does not double-apply journalled writes across repeated recoveries', async () => {
    const first = await open()
    await first.appendSessions([session('a', 9, 30)])

    // Recover once — this checkpoints and clears the journal.
    const second = await open()
    expect(await second.getSessions('2026-03-14')).toHaveLength(1)

    // Recover again from the same directory: still exactly one session.
    const third = await open()
    expect(await third.getSessions('2026-03-14')).toHaveLength(1)
  })

  it('ignores a torn final journal line instead of refusing to boot', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30)])
    await fs.appendFile(journal(), '{"seq":99,"op":"appendSess', 'utf8')

    const reopened = await open()
    expect(await reopened.getSessions('2026-03-14')).toHaveLength(1)
  })

  it('clears the journal once everything is checkpointed', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30)])
    await storage.flush()
    await expect(fs.stat(journal())).rejects.toThrow()
  })

  it('recovers from an unreadable meta file without losing history', async () => {
    const first = await open()
    await first.appendSessions([session('a', 9, 30)])
    await first.flush()
    await fs.writeFile(path.join(storeDir(), 'meta.json'), '{ this is not json', 'utf8')

    const second = await open()
    expect(second.getSettings().idleThresholdSeconds).toBe(DEFAULT_SETTINGS.idleThresholdSeconds)
    // History lives in the day files and must be untouched by a bad meta file.
    expect(await second.getSessions('2026-03-14')).toHaveLength(1)
    const entries = await fs.readdir(storeDir())
    expect(entries.some((e) => e.includes('.corrupt-'))).toBe(true)
  })

  it('quarantines one unreadable day rather than failing the whole store', async () => {
    const first = await open()
    await first.appendSessions([session('a', 9, 30)])
    await first.flush()
    await fs.writeFile(path.join(storeDir(), 'days', '2026-03-14.json'), 'not json', 'utf8')

    const second = await open()
    expect(await second.getSessions('2026-03-14')).toEqual([])
    const entries = await fs.readdir(path.join(storeDir(), 'days'))
    expect(entries.some((e) => e.includes('.corrupt-'))).toBe(true)
  })

  it('keeps memory bounded by evicting old days from the cache', async () => {
    const storage = await open()
    for (let day = 1; day <= 60; day++) {
      const start = new Date(2026, 0, day, 9, 0, 0, 0).getTime()
      await storage.appendSessions([
        { ...session(`s${day}`, 9, 30), startTime: start, endTime: start + 1_800_000 },
      ])
      await storage.flush()
    }
    // Everything is still readable, but not everything is still resident.
    expect(storage.listDayKeys()).toHaveLength(60)
    expect(await storage.getSessions('2026-01-01')).toHaveLength(1)
    expect(await storage.getSessions('2026-02-28')).toHaveLength(1)
  })
})

describe('FileStorage migration from the v0 store', () => {
  it('imports a single-file store and keeps the original', async () => {
    const legacy = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, pollIntervalSeconds: 30 },
      projects: [{ id: 'x', name: 'Only', color: '#fff', keywords: [] }],
      rules: [],
      sessionsByDay: { '2026-03-14': [session('a', 9, 30)] },
      idleByDay: { '2026-03-14': [{ startTime: at(12), endTime: at(13), durationSeconds: 3600 }] },
      eventsByDay: {},
    }
    await fs.writeFile(path.join(dir, 'opentime-data.json'), JSON.stringify(legacy), 'utf8')

    const storage = await open()
    expect(storage.getSettings().pollIntervalSeconds).toBe(30)
    expect(storage.getProjects()).toHaveLength(1)
    expect(await storage.getSessions('2026-03-14')).toHaveLength(1)
    expect(await storage.getIdle('2026-03-14')).toHaveLength(1)
    // Goals did not exist in v1 and must be filled in from defaults.
    expect(storage.getGoals().length).toBeGreaterThan(0)
    // The original is renamed, never deleted.
    await expect(fs.stat(path.join(dir, 'opentime-data.json.migrated'))).resolves.toBeTruthy()
  })

  it('does not re-import once the new store exists', async () => {
    await fs.writeFile(
      path.join(dir, 'opentime-data.json'),
      JSON.stringify({ version: 1, sessionsByDay: { '2026-03-14': [session('a', 9, 30)] } }),
      'utf8'
    )
    const first = await open()
    await first.flush()
    const second = await open()
    expect(await second.getSessions('2026-03-14')).toHaveLength(1)
  })
})

describe('FileStorage bulk operations', () => {
  it('prunes days older than the retention cutoff and leaves the rest', async () => {
    const storage = await open()
    for (const day of [1, 10, 20]) {
      const start = new Date(2026, 0, day, 9, 0, 0, 0).getTime()
      await storage.appendSessions([
        { ...session(`s${day}`, 9, 30), startTime: start, endTime: start + 1_800_000 },
      ])
    }
    await storage.flush()

    const removed = await storage.prune('2026-01-10')
    expect(removed).toEqual(['2026-01-01'])
    expect(storage.listDayKeys()).toEqual(['2026-01-10', '2026-01-20'])
    await expect(fs.stat(path.join(storeDir(), 'days', '2026-01-01.json'))).rejects.toThrow()
  })

  it('clears exactly the days that were seeded with demo history', async () => {
    const storage = await open()
    await storage.appendSessions([session('demo', 9, 30)])
    await storage.appendSessions([
      { ...session('real', 9, 30), startTime: at(9) + 86_400_000, endTime: at(10) + 86_400_000 },
    ])
    await storage.markDemoDays(['2026-03-14'])
    await storage.flush()

    expect(await storage.clearDemoDays()).toBe(1)
    expect(storage.listDayKeys()).toEqual(['2026-03-15'])
    expect(storage.demoDays()).toEqual([])
  })

  it('also strips demo-adapter rows out of days that hold real records', async () => {
    const storage = await open()
    // The mid-afternoon case: capture starts working, so today ends up holding
    // both synthesised and observed rows.
    await storage.appendSessions([
      { ...session('synthetic', 9, 30), source: 'demo' },
      { ...session('observed', 14, 30), source: 'capture' },
    ])
    await storage.putEvents('2026-03-14', [
      { id: 'd1', title: 'Fake standup', start: at(9), end: at(10), source: 'demo' },
      { id: 'g1', title: 'Real standup', start: at(11), end: at(12), source: 'google' },
    ])

    expect(await storage.clearDemoDays()).toBe(1)
    expect((await storage.getSessions('2026-03-14')).map((s) => s.id)).toEqual(['observed'])
    expect((await storage.getEvents('2026-03-14')).map((e) => e.id)).toEqual(['g1'])
  })

  it('leaves a store with no demo data untouched', async () => {
    const storage = await open()
    await storage.appendSessions([session('real', 9, 30)])
    expect(await storage.clearDemoDays()).toBe(0)
    expect(await storage.getSessions('2026-03-14')).toHaveLength(1)
  })

  it('replaces the whole store on restore, dropping what was there before', async () => {
    const storage = await open()
    await storage.appendSessions([session('old', 9, 30)])
    await storage.flush()

    await storage.replaceAll(
      { ...defaultConfig(), settings: { ...DEFAULT_SETTINGS, focusBlockMinutes: 45 } },
      {
        '2025-12-25': {
          sessions: [{ ...session('restored', 9, 30), startTime: 1, endTime: 2, durationSeconds: 1 }],
          idle: [],
          events: [],
        },
      }
    )

    expect(storage.listDayKeys()).toEqual(['2025-12-25'])
    expect(await storage.getSessions('2026-03-14')).toEqual([])
    expect(storage.getSettings().focusBlockMinutes).toBe(45)

    // And it survives a reopen — restore writes through, not just in memory.
    const reopened = await open()
    expect(reopened.listDayKeys()).toEqual(['2025-12-25'])
  })

  it('exports every day back out for a backup', async () => {
    const storage = await open()
    await storage.appendSessions([session('a', 9, 30)])
    const days = await storage.exportDays()
    expect(Object.keys(days)).toEqual(['2026-03-14'])
    expect(days['2026-03-14'].sessions).toHaveLength(1)
  })
})

describe('FileStorage upgrade cleanup', () => {
  it('starts a brand new store with no demo history and seeding opted out', async () => {
    const storage = await open()
    expect(storage.isEmpty()).toBe(true)
    expect(storage.demoDays()).toEqual([])
    expect(storage.getSettings().seedDemoWhenUnavailable).toBe(false)
  })

  it('removes demo days left by an older version on upgrade, keeping real history', async () => {
    // Simulate a pre-upgrade store: demo history seeded by the old
    // seed-by-default behaviour, alongside a real tracked day.
    const seeded = await open()
    await seeded.appendSessions([session('demo', 9, 30)])
    await seeded.appendSessions([
      { ...session('real', 9, 30), startTime: at(9) + 86_400_000, endTime: at(10) + 86_400_000 },
    ])
    await seeded.markDemoDays(['2026-03-14'])
    await seeded.saveSettings({ ...seeded.getSettings(), seedDemoWhenUnavailable: true })
    await seeded.flush()

    const upgraded = await open()
    expect(upgraded.listDayKeys()).toEqual(['2026-03-15'])
    expect(await upgraded.getSessions('2026-03-15')).toHaveLength(1)
    expect(upgraded.demoDays()).toEqual([])
    // The migration also turns the honest default back on, or the very next
    // boot with capture still unavailable would immediately reseed what it
    // just removed.
    expect(upgraded.getSettings().seedDemoWhenUnavailable).toBe(false)

    // Idempotent: nothing left to remove on a third boot, and the real day
    // is still exactly what it was.
    const again = await open()
    expect(again.listDayKeys()).toEqual(['2026-03-15'])
    expect(again.demoDays()).toEqual([])
  })

  it('never removes real data when there is nothing marked as demo', async () => {
    const storage = await open()
    await storage.appendSessions([session('real', 9, 30)])
    await storage.flush()

    const reopened = await open()
    expect(await reopened.getSessions('2026-03-14')).toHaveLength(1)
  })
})

describe('migrateConfig', () => {
  it('fills in missing sections of an older config', () => {
    const config = migrateConfig({ version: 1 })
    expect(config.settings).toMatchObject({ idleThresholdSeconds: 120 })
    expect(config.settings.calendar.scope).toBe('calendar.readonly')
    expect(config.projects.length).toBeGreaterThan(0)
    expect(config.goals.length).toBeGreaterThan(0)
    expect(config.version).toBe(2)
  })

  it('preserves values the file already had', () => {
    const config = migrateConfig({
      version: 1,
      settings: { ...DEFAULT_SETTINGS, pollIntervalSeconds: 30 },
      projects: [{ id: 'x', name: 'Only', color: '#fff', keywords: [] }],
    })
    expect(config.settings.pollIntervalSeconds).toBe(30)
    expect(config.projects).toHaveLength(1)
  })

  it('tolerates null', () => {
    expect(migrateConfig(null).version).toBe(2)
  })

  it('moves an unedited pre-0.4 Breaks onto sites, counted as distraction', () => {
    const config = migrateConfig({
      version: 2,
      projects: [{ id: 'p_breaks', name: 'Breaks', color: '#f00', keywords: ['youtube', 'netflix', 'reddit', 'twitch'] }],
      rules: [
        { id: 'r_youtube', kind: 'keyword', match: 'youtube', category: 'Breaks', productivity: 'distracting' },
        { id: 'r_mine', kind: 'app', match: 'steam', category: 'Breaks' },
      ],
    })
    expect(config.projects[0]).toMatchObject({
      keywords: ['youtube.com', 'netflix.com', 'reddit.com', 'twitch.tv'],
      productivity: 'distracting',
    })
    // The starter word rule is retired; a rule the user made is kept.
    expect(config.rules.map((r) => r.id)).toEqual(['r_mine'])
  })

  it('leaves a Breaks someone edited alone, apart from how it counts', () => {
    const config = migrateConfig({
      version: 2,
      projects: [{ id: 'p_breaks', name: 'Breaks', color: '#f00', keywords: ['youtube', 'chess'] }],
    })
    expect(config.projects[0].keywords).toEqual(['youtube', 'chess'])
    expect(config.projects[0].productivity).toBe('distracting')

    const chosen = migrateConfig({
      version: 2,
      projects: [{ id: 'p_breaks', name: 'Breaks', color: '#f00', keywords: [], productivity: 'neutral' }],
    })
    expect(chosen.projects[0].productivity).toBe('neutral')
  })

  it('drops a malformed learned-word map instead of trusting it', () => {
    const config = migrateConfig({
      version: 2,
      projects: [
        {
          id: 'x',
          name: 'X',
          color: '#fff',
          keywords: [],
          learned: { good: 2, bad: -1, worse: 'three' as unknown as number },
          productivity: 'sometimes' as never,
        },
      ],
    })
    expect(config.projects[0].learned).toEqual({ good: 2 })
    expect(config.projects[0].productivity).toBeUndefined()
  })
})
