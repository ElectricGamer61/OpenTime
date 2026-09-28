/**
 * A read-only view of OpenTime's store, for the MCP server.
 *
 * The server runs in its own process, usually while the app is running and
 * writing, so it must never write anything: no migrations, no checkpoints, no
 * renaming a file it cannot parse. It reads the day files and folds in any
 * journal records the app has written but not yet checkpointed, which is the
 * same thing `FileStorage.init()` does on boot, through the same `foldRecord`.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_DAY_START_HOUR } from '../core/day'
import { migrateConfig } from '../core/defaults'
import { DAY_KEY_RE, foldRecord, parseJournal, recordKeys } from '../core/journal'
import type { DayRecord, Project, Session, StoreConfig } from '../core/types'

/**
 * Where the app keeps its data: Electron's `userData` for a product named
 * OpenTime, plus the store's own folder. `OPENTIME_DATA_DIR` overrides it (a
 * test, a second profile, a copy on another disk).
 */
export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.OPENTIME_DATA_DIR) return env.OPENTIME_DATA_DIR
  const home = os.homedir()
  const userData =
    platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'OpenTime')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'OpenTime')
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'OpenTime')
  return path.join(userData, 'opentime')
}

interface DayFile extends DayRecord {
  lastSeq?: number
}

export class ReadOnlyStore {
  constructor(readonly root: string) {}

  private get daysDir(): string {
    return path.join(this.root, 'days')
  }

  async config(): Promise<StoreConfig> {
    try {
      return migrateConfig(JSON.parse(await fs.readFile(path.join(this.root, 'meta.json'), 'utf8')))
    } catch {
      return migrateConfig(null)
    }
  }

  async dayStartHour(): Promise<number> {
    return (await this.config()).settings.dayStartHour ?? DEFAULT_DAY_START_HOUR
  }

  async projects(): Promise<Project[]> {
    return (await this.config()).projects
  }

  /** Every day that has a file, or a journalled write waiting to become one, ascending. */
  async dayKeys(): Promise<string[]> {
    const keys = new Set<string>()
    try {
      for (const name of await fs.readdir(this.daysDir)) {
        const key = name.replace(/\.json$/, '')
        if (name.endsWith('.json') && DAY_KEY_RE.test(key)) keys.add(key)
      }
    } catch {
      // No days folder: nothing tracked yet.
    }
    for (const record of await this.journal()) for (const key of recordKeys(record)) keys.add(key)
    return [...keys].sort()
  }

  private async journal() {
    try {
      return parseJournal(await fs.readFile(path.join(this.root, 'journal.jsonl'), 'utf8'))
    } catch {
      return []
    }
  }

  private async readDayFile(key: string): Promise<DayFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.daysDir, `${key}.json`), 'utf8')) as Partial<DayFile>
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        idle: Array.isArray(parsed.idle) ? parsed.idle : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
        lastSeq: typeof parsed.lastSeq === 'number' ? parsed.lastSeq : 0,
      }
    } catch {
      // Missing, or caught mid-rename by the app's atomic write: an empty day
      // this instant is better than failing the whole question.
      return { sessions: [], idle: [], events: [], lastSeq: 0 }
    }
  }

  /** The days asked for, with the journal folded in. Days with nothing are left out. */
  async days(keys: string[]): Promise<Array<{ key: string; record: DayRecord }>> {
    const wanted = new Set(keys)
    const known = (await this.dayKeys()).filter((k) => wanted.has(k))
    const journal = await this.journal()
    const out: Array<{ key: string; record: DayRecord }> = []
    for (const key of known) {
      const day = await this.readDayFile(key)
      for (const record of journal) {
        if (record.seq <= (day.lastSeq ?? 0) || !recordKeys(record).includes(key)) continue
        foldRecord(day, key, record)
      }
      out.push({ key, record: { sessions: day.sessions, idle: day.idle, events: day.events } })
    }
    return out
  }

  /** The most recent session on disk, wherever it is. */
  async lastSession(): Promise<Session | null> {
    const keys = await this.dayKeys()
    for (let i = keys.length - 1; i >= 0; i--) {
      const [day] = await this.days([keys[i]])
      const last = day?.record.sessions.reduce<Session | null>((a, s) => (!a || s.endTime > a.endTime ? s : a), null)
      if (last) return last
    }
    return null
  }
}
