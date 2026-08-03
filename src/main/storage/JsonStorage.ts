/**
 * JSON-file implementation of `Storage`.
 *
 * Writes are coalesced: mutations update an in-memory snapshot and schedule a
 * single debounced atomic write (tmp file + rename) instead of touching disk per
 * change. Combined with the session batching in `SessionBuilder`, a normal
 * working hour costs a handful of small writes.
 *
 * This is the v0 backend. `Storage` is intentionally shaped so a SQLite backend
 * can replace it without touching the engine — see the README.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { dayKey } from '../../core/day'
import { defaultState, DEFAULT_SETTINGS, STATE_VERSION } from '../../core/defaults'
import type {
  CalendarEvent,
  CategoryRule,
  IdleBlock,
  PersistedState,
  Project,
  Session,
  Settings,
} from '../../core/types'
import type { Storage } from './Storage'

const WRITE_DEBOUNCE_MS = 1500

export class JsonStorage implements Storage {
  private file: string
  private state: PersistedState = defaultState()
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> | null = null
  private dirty = false

  constructor(dir: string, filename = 'opentime-data.json') {
    this.file = path.join(dir, filename)
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as PersistedState
      this.state = migrate(parsed)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // A corrupt file must not brick the app: keep the bad copy for
        // forensics and start clean rather than crash-looping at boot.
        console.error('[storage] unreadable data file, starting fresh:', err)
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      }
      this.state = defaultState()
      this.markDirty()
    }
  }

  getSettings(): Settings {
    return this.state.settings
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.state.settings = { ...settings, calendar: { ...settings.calendar } }
    this.markDirty()
  }

  getProjects(): Project[] {
    return this.state.projects
  }

  async saveProjects(projects: Project[]): Promise<void> {
    this.state.projects = projects
    this.markDirty()
  }

  getRules(): CategoryRule[] {
    return this.state.rules
  }

  async saveRules(rules: CategoryRule[]): Promise<void> {
    this.state.rules = rules
    this.markDirty()
  }

  async appendSessions(sessions: Session[]): Promise<void> {
    if (!sessions.length) return
    const hour = this.state.settings.dayStartHour
    for (const s of sessions) {
      const key = dayKey(s.startTime, hour)
      const list = (this.state.sessionsByDay[key] ||= [])
      // Sessions arrive in chronological order in the common case, so an
      // append + tail-check beats re-sorting the day on every flush.
      if (list.length && list[list.length - 1].startTime > s.startTime) {
        list.push(s)
        list.sort((a, b) => a.startTime - b.startTime)
      } else {
        list.push(s)
      }
    }
    this.markDirty()
  }

  getSessions(key: string): Session[] {
    return this.state.sessionsByDay[key] || []
  }

  async appendIdle(key: string, block: IdleBlock): Promise<void> {
    ;(this.state.idleByDay[key] ||= []).push(block)
    this.markDirty()
  }

  getIdle(key: string): IdleBlock[] {
    return this.state.idleByDay[key] || []
  }

  async putEvents(key: string, events: CalendarEvent[]): Promise<void> {
    this.state.eventsByDay[key] = events
    this.markDirty()
  }

  getEvents(key: string): CalendarEvent[] {
    return this.state.eventsByDay[key] || []
  }

  async updateSession(key: string, id: string, patch: Partial<Session>): Promise<Session | null> {
    const list = this.state.sessionsByDay[key]
    if (!list) return null
    const index = list.findIndex((s) => s.id === id)
    if (index < 0) return null
    const next = { ...list[index], ...patch, id: list[index].id }
    list[index] = next
    this.markDirty()
    return next
  }

  isEmpty(): boolean {
    for (const key of Object.keys(this.state.sessionsByDay)) {
      if (this.state.sessionsByDay[key].length) return false
    }
    return true
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.writing) await this.writing
    if (!this.dirty) return
    await this.write()
  }

  private markDirty(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, WRITE_DEBOUNCE_MS)
    // Never hold the process open just to flush a cache.
    this.timer.unref?.()
  }

  private async write(): Promise<void> {
    if (this.writing) return this.writing
    this.dirty = false
    const payload = JSON.stringify(this.state)
    const tmp = `${this.file}.tmp`
    this.writing = (async () => {
      try {
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, this.file)
      } catch (err) {
        console.error('[storage] write failed:', err)
        this.dirty = true
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }
}

/** Fill in anything a state file written by an older version is missing. */
export function migrate(input: Partial<PersistedState> | null): PersistedState {
  const base = defaultState()
  if (!input || typeof input !== 'object') return base
  return {
    version: STATE_VERSION,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(input.settings || {}),
      calendar: { ...DEFAULT_SETTINGS.calendar, ...(input.settings?.calendar || {}) },
    },
    projects: input.projects?.length ? input.projects : base.projects,
    rules: input.rules || base.rules,
    sessionsByDay: input.sessionsByDay || {},
    idleByDay: input.idleByDay || {},
    eventsByDay: input.eventsByDay || {},
  }
}
