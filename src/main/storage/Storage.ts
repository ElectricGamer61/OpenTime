/**
 * Storage abstraction.
 *
 * Deliberately narrow: the engine appends sessions and idle blocks, reads whole
 * days, and edits individual rows. That is the entire query surface, which is
 * what makes the sharded-file implementation viable now and a SQLite
 * implementation a drop-in later (see "Storage" in the README).
 *
 * Two shapes of access, on purpose:
 *  - **configuration** (settings, projects, rules, goals) is tiny, read on every
 *    tick, and stays in memory — so its getters are synchronous;
 *  - **day records** can span years and are read on demand — so their getters
 *    are asynchronous, and a backend is free to answer them from disk.
 *
 * That split is the whole reason the store scales past what fits in RAM.
 */

import type {
  CalendarEvent,
  CategoryRule,
  DayRecord,
  Goal,
  IdleBlock,
  Project,
  Session,
  Settings,
  StoreConfig,
} from '../../core/types'
import type { SessionPatch } from '../../core/journal'

export interface Storage {
  /** Load configuration and recover any un-checkpointed writes. */
  init(): Promise<void>

  getSettings(): Settings
  saveSettings(settings: Settings): Promise<void>

  getProjects(): Project[]
  saveProjects(projects: Project[]): Promise<void>

  getRules(): CategoryRule[]
  saveRules(rules: CategoryRule[]): Promise<void>

  getGoals(): Goal[]
  saveGoals(goals: Goal[]): Promise<void>

  /** The whole configuration half of the store, for backups. */
  getConfig(): StoreConfig

  /** Append flushed sessions, bucketed into their tracking days. */
  appendSessions(sessions: Session[]): Promise<void>
  getSessions(dayKey: string): Promise<Session[]>
  /** Replace a day's sessions wholesale — the manual-edit path. */
  putSessions(dayKey: string, sessions: Session[]): Promise<void>

  appendIdle(dayKey: string, block: IdleBlock): Promise<void>
  getIdle(dayKey: string): Promise<IdleBlock[]>
  putIdle(dayKey: string, blocks: IdleBlock[]): Promise<void>

  /** Replace a day's events (calendar sync is idempotent per day). */
  putEvents(dayKey: string, events: CalendarEvent[]): Promise<void>
  getEvents(dayKey: string): Promise<CalendarEvent[]>

  /** Everything for one day in one read. */
  getDay(dayKey: string): Promise<DayRecord>
  getDays(dayKeys: string[]): Promise<DayRecord[]>

  /** Recategorise a single stored session (used by the review panel). */
  /** Apply a patch; a `null` field is removed. */
  updateSession(dayKey: string, id: string, patch: SessionPatch): Promise<Session | null>

  /** Every day key that has records, ascending. */
  listDayKeys(): string[]

  /** Whether any day has ever been recorded — drives first-run behaviour. */
  isEmpty(): boolean

  /** Delete every day strictly before `cutoffKey`. Returns the keys removed. */
  prune(cutoffKey: string): Promise<string[]>

  /** Day keys holding seeded demo history, if any. */
  demoDays(): string[]
  /** Record that these day keys were seeded with synthetic history. */
  markDemoDays(keys: string[]): Promise<void>
  /** Delete every seeded day. Returns the number of days removed. */
  clearDemoDays(): Promise<number>

  /** Replace the entire store — the restore-from-backup path. */
  replaceAll(config: StoreConfig, days: Record<string, DayRecord>): Promise<void>

  /** Read days back out for a backup, one at a time rather than all at once. */
  exportDays(dayKeys?: string[]): Promise<Record<string, DayRecord>>

  /** Force any pending write to disk (called on quit). */
  flush(): Promise<void>
}
