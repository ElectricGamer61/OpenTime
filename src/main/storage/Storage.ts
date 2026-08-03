/**
 * Storage abstraction.
 *
 * Deliberately narrow: the engine only ever appends sessions/idle blocks and
 * reads whole days. That is the entire query surface, which is what makes the
 * JSON implementation viable now and the SQLite implementation a drop-in later
 * (see "SQLite migration path" in the README) — the interface never exposes an
 * in-memory `Record<string, Session[]>` to callers, so a backend is free to keep
 * data on disk and answer per-day queries with an indexed range scan.
 */

import type {
  CalendarEvent,
  CategoryRule,
  IdleBlock,
  Project,
  Session,
  Settings,
} from '../../core/types'

export interface Storage {
  /** Load everything the engine needs at boot. */
  init(): Promise<void>

  getSettings(): Settings
  saveSettings(settings: Settings): Promise<void>

  getProjects(): Project[]
  saveProjects(projects: Project[]): Promise<void>

  getRules(): CategoryRule[]
  saveRules(rules: CategoryRule[]): Promise<void>

  /** Append flushed sessions, bucketed into their tracking days. */
  appendSessions(sessions: Session[]): Promise<void>
  getSessions(dayKey: string): Session[]

  appendIdle(dayKey: string, block: IdleBlock): Promise<void>
  getIdle(dayKey: string): IdleBlock[]

  /** Replace a day's events (calendar sync is idempotent per day). */
  putEvents(dayKey: string, events: CalendarEvent[]): Promise<void>
  getEvents(dayKey: string): CalendarEvent[]

  /** Recategorise a single stored session (used by the review panel). */
  updateSession(dayKey: string, id: string, patch: Partial<Session>): Promise<Session | null>

  /** Whether any session has ever been recorded — drives first-run seeding. */
  isEmpty(): boolean

  /** Force any pending write to disk (called on quit). */
  flush(): Promise<void>
}
