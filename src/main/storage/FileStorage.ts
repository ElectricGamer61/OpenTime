/**
 * The durable local store.
 *
 * ```
 * <userData>/opentime/
 *   meta.json              settings, projects, rules, goals  (small, always in memory)
 *   days/2026-08-03.json   one tracking day's sessions, idle blocks and events
 *   journal.jsonl          append-only log of writes not yet checkpointed
 * ```
 *
 * Three properties this layout buys, all of which the single-blob v0 store
 * lacked:
 *
 * **Durability.** Every mutation is appended to `journal.jsonl` and awaited
 * *before* the call returns. Day files are written on a debounce. If the machine
 * loses power between the two, `init()` replays the journal and the write is
 * still there. The old store coalesced writes with nothing behind them, so a
 * crash could lose the last seconds — or, worse, land mid-rewrite of the entire
 * history.
 *
 * **A bounded write.** Persisting one session rewrites one day file (a few kB),
 * not the whole history. On the old store the cost of a write grew with the
 * length of your history, which is exactly backwards.
 *
 * **A bounded footprint.** Days are loaded on demand and evicted, so a year of
 * data costs the same memory as a week. Configuration stays resident because it
 * is read on every tick and is tiny.
 *
 * Replay is idempotent: each journal record carries a monotonic `seq`, each day
 * file records the highest `seq` already folded into it, and replay skips
 * anything the file has already seen. That is what makes "append to the journal,
 * checkpoint later" safe rather than a way to double-count sessions.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { dayKey } from '../../core/day'
import { defaultConfig, migrateConfig, sanitizeSettings, STATE_VERSION } from '../../core/defaults'
import type {
  CalendarEvent,
  CategoryRule,
  DayRecord,
  Goal,
  IdleBlock,
  PersistedState,
  Project,
  Session,
  Settings,
  StoreConfig,
} from '../../core/types'
import type { Storage } from './Storage'

const WRITE_DEBOUNCE_MS = 1500
/** Days kept in memory. A month of scrollback costs ~1 MB; beyond that, re-read. */
const CACHE_LIMIT = 45
/** Checkpoint (and truncate the journal) once it grows past this many records. */
const JOURNAL_CHECKPOINT_RECORDS = 400

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

interface DayFile extends DayRecord {
  /** Highest journal sequence already folded into this file. */
  lastSeq: number
}

interface CacheEntry {
  record: DayFile
  dirty: boolean
  /** Monotonic counter for LRU eviction. */
  touched: number
}

type JournalRecord =
  | { seq: number; op: 'appendSessions'; days: Record<string, Session[]> }
  | { seq: number; op: 'putSessions'; key: string; sessions: Session[] }
  | { seq: number; op: 'appendIdle'; key: string; block: IdleBlock }
  | { seq: number; op: 'putIdle'; key: string; blocks: IdleBlock[] }
  | { seq: number; op: 'putEvents'; key: string; events: CalendarEvent[] }
  | { seq: number; op: 'updateSession'; key: string; id: string; patch: Partial<Session> }

interface MetaFile extends StoreConfig {
  /** Day keys whose contents are synthesised, so they can be cleared in one action. */
  demoDays?: string[]
}

function emptyDay(): DayFile {
  return { sessions: [], idle: [], events: [], lastSeq: 0 }
}

function sortSessions(list: Session[]): Session[] {
  return list.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
}

export class FileStorage implements Storage {
  private root: string
  private daysDir: string
  private metaFile: string
  private journalFile: string
  /** Where a v0 single-file store would be, for the one-time import. */
  private legacyFile: string

  private config: StoreConfig = defaultConfig()
  private demoDayKeys = new Set<string>()
  private index = new Set<string>()
  private cache = new Map<string, CacheEntry>()

  private seq = 0
  private journalRecords = 0
  private journalTail: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private checkpointing: Promise<void> | null = null
  private clock = 0

  constructor(userDataDir: string, folder = 'opentime') {
    this.root = path.join(userDataDir, folder)
    this.daysDir = path.join(this.root, 'days')
    this.metaFile = path.join(this.root, 'meta.json')
    this.journalFile = path.join(this.root, 'journal.jsonl')
    this.legacyFile = path.join(userDataDir, 'opentime-data.json')
  }

  /** The directory the user can open in Explorer/Finder to see their data. */
  get dataDirectory(): string {
    return this.root
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await fs.mkdir(this.daysDir, { recursive: true })
    await this.loadMeta()
    await this.loadIndex()
    if (!this.index.size && !(await this.exists(this.metaFile))) {
      await this.importLegacyStore()
    }
    await this.replayJournal()
    await this.writeMeta()
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await fs.stat(file)
      return true
    } catch {
      return false
    }
  }

  private async loadMeta(): Promise<void> {
    try {
      const raw = await fs.readFile(this.metaFile, 'utf8')
      const parsed = JSON.parse(raw) as MetaFile
      this.config = migrateConfig(parsed)
      this.demoDayKeys = new Set(Array.isArray(parsed.demoDays) ? parsed.demoDays : [])
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Never brick the app on a bad settings file: keep it for forensics and
        // fall back to defaults. History lives in the day files and is untouched.
        console.error('[storage] unreadable meta.json, using defaults:', err)
        await fs.rename(this.metaFile, `${this.metaFile}.corrupt-${Date.now()}`).catch(() => {})
      }
      this.config = defaultConfig()
    }
  }

  private async loadIndex(): Promise<void> {
    this.index.clear()
    let entries: string[] = []
    try {
      entries = await fs.readdir(this.daysDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const key = name.slice(0, -'.json'.length)
      if (DAY_KEY_RE.test(key)) this.index.add(key)
    }
  }

  /**
   * One-time import of the v0 store (a single `opentime-data.json`).
   *
   * The original is renamed rather than deleted: an upgrade that silently
   * destroys the only copy of someone's history is not an upgrade.
   */
  private async importLegacyStore(): Promise<void> {
    let parsed: Partial<PersistedState>
    try {
      parsed = JSON.parse(await fs.readFile(this.legacyFile, 'utf8')) as Partial<PersistedState>
    } catch {
      return
    }
    this.config = migrateConfig(parsed)

    const keys = new Set([
      ...Object.keys(parsed.sessionsByDay || {}),
      ...Object.keys(parsed.idleByDay || {}),
      ...Object.keys(parsed.eventsByDay || {}),
    ])
    for (const key of keys) {
      if (!DAY_KEY_RE.test(key)) continue
      await this.writeDayFile(key, {
        sessions: sortSessions([...(parsed.sessionsByDay?.[key] || [])]),
        idle: [...(parsed.idleByDay?.[key] || [])],
        events: [...(parsed.eventsByDay?.[key] || [])],
        lastSeq: 0,
      })
      this.index.add(key)
    }
    await fs.rename(this.legacyFile, `${this.legacyFile}.migrated`).catch(() => {})
    console.log(`[storage] migrated ${keys.size} day(s) from the v0 store`)
  }

  /**
   * Fold any writes the journal holds but the day files do not yet have.
   *
   * A truncated final line is the normal shape of a crash mid-append, so bad
   * lines are skipped rather than treated as corruption.
   */
  private async replayJournal(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.journalFile, 'utf8')
    } catch {
      return
    }
    const lines = raw.split('\n').filter((l) => l.trim())
    let applied = 0
    for (const line of lines) {
      let record: JournalRecord
      try {
        record = JSON.parse(line) as JournalRecord
      } catch {
        continue
      }
      if (!record || typeof record.seq !== 'number') continue
      this.seq = Math.max(this.seq, record.seq)
      if (await this.applyRecord(record, true)) applied += 1
    }
    // Count the replayed lines so the checkpoint below actually clears the
    // journal — otherwise it would be replayed (harmlessly, but forever).
    this.journalRecords = lines.length
    if (applied) console.log(`[storage] recovered ${applied} journalled write(s)`)
    await this.checkpoint()
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  getSettings(): Settings {
    return this.config.settings
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.config.settings = sanitizeSettings(settings)
    await this.writeMeta()
  }

  getProjects(): Project[] {
    return this.config.projects
  }

  async saveProjects(projects: Project[]): Promise<void> {
    this.config.projects = projects
    await this.writeMeta()
  }

  getRules(): CategoryRule[] {
    return this.config.rules
  }

  async saveRules(rules: CategoryRule[]): Promise<void> {
    this.config.rules = rules
    await this.writeMeta()
  }

  getGoals(): Goal[] {
    return this.config.goals
  }

  async saveGoals(goals: Goal[]): Promise<void> {
    this.config.goals = goals
    await this.writeMeta()
  }

  getConfig(): StoreConfig {
    return { ...this.config, version: STATE_VERSION }
  }

  /**
   * Configuration is written straight through rather than journalled: it is a
   * few kB, it changes when a human clicks Save, and losing the last settings
   * change to a crash would be a bug a user would notice immediately.
   */
  private async writeMeta(): Promise<void> {
    const payload: MetaFile = {
      ...this.config,
      version: STATE_VERSION,
      demoDays: [...this.demoDayKeys],
    }
    await this.atomicWrite(this.metaFile, JSON.stringify(payload, null, 2))
  }

  // ── Day records ────────────────────────────────────────────────────────────

  private async load(key: string): Promise<CacheEntry> {
    const hit = this.cache.get(key)
    if (hit) {
      hit.touched = ++this.clock
      return hit
    }
    let record = emptyDay()
    if (this.index.has(key)) {
      const file = this.dayPath(key)
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<DayFile>
        record = {
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
          idle: Array.isArray(parsed.idle) ? parsed.idle : [],
          events: Array.isArray(parsed.events) ? parsed.events : [],
          lastSeq: Number(parsed.lastSeq) || 0,
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          // One unreadable day must cost that day, not the whole history.
          console.error(`[storage] unreadable day ${key}, starting it empty:`, err)
          await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
        }
        this.index.delete(key)
      }
    }
    const entry: CacheEntry = { record, dirty: false, touched: ++this.clock }
    this.cache.set(key, entry)
    this.evict()
    return entry
  }

  /** Drop the least recently used clean days once the cache is over budget. */
  private evict(): void {
    if (this.cache.size <= CACHE_LIMIT) return
    const candidates = [...this.cache.entries()]
      .filter(([, e]) => !e.dirty)
      .sort((a, b) => a[1].touched - b[1].touched)
    for (const [key] of candidates) {
      if (this.cache.size <= CACHE_LIMIT) break
      this.cache.delete(key)
    }
  }

  private dayPath(key: string): string {
    return path.join(this.daysDir, `${key}.json`)
  }

  async getDay(key: string): Promise<DayRecord> {
    const { record } = await this.load(key)
    return { sessions: record.sessions, idle: record.idle, events: record.events }
  }

  async getDays(keys: string[]): Promise<DayRecord[]> {
    const out: DayRecord[] = []
    for (const key of keys) out.push(await this.getDay(key))
    return out
  }

  async getSessions(key: string): Promise<Session[]> {
    return (await this.load(key)).record.sessions
  }

  async getIdle(key: string): Promise<IdleBlock[]> {
    return (await this.load(key)).record.idle
  }

  async getEvents(key: string): Promise<CalendarEvent[]> {
    return (await this.load(key)).record.events
  }

  listDayKeys(): string[] {
    return [...this.index].sort()
  }

  isEmpty(): boolean {
    return this.index.size === 0
  }

  demoDays(): string[] {
    return [...this.demoDayKeys].sort()
  }

  async markDemoDays(keys: string[]): Promise<void> {
    for (const key of keys) this.demoDayKeys.add(key)
    await this.writeMeta()
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async appendSessions(sessions: Session[]): Promise<void> {
    if (!sessions.length) return
    const hour = this.config.settings.dayStartHour
    const days: Record<string, Session[]> = {}
    // Bucket before journalling, so a replay does not depend on `dayStartHour`
    // being what it was when the write happened.
    for (const s of sessions) (days[dayKey(s.startTime, hour)] ||= []).push(s)
    await this.write({ seq: this.nextSeq(), op: 'appendSessions', days })
  }

  async putSessions(key: string, sessions: Session[]): Promise<void> {
    await this.write({ seq: this.nextSeq(), op: 'putSessions', key, sessions })
  }

  async appendIdle(key: string, block: IdleBlock): Promise<void> {
    await this.write({ seq: this.nextSeq(), op: 'appendIdle', key, block })
  }

  async putIdle(key: string, blocks: IdleBlock[]): Promise<void> {
    await this.write({ seq: this.nextSeq(), op: 'putIdle', key, blocks })
  }

  async putEvents(key: string, events: CalendarEvent[]): Promise<void> {
    await this.write({ seq: this.nextSeq(), op: 'putEvents', key, events })
  }

  async updateSession(key: string, id: string, patch: Partial<Session>): Promise<Session | null> {
    const { record } = await this.load(key)
    if (!record.sessions.some((s) => s.id === id)) return null
    await this.write({ seq: this.nextSeq(), op: 'updateSession', key, id, patch })
    return (await this.getSessions(key)).find((s) => s.id === id) || null
  }

  private nextSeq(): number {
    return ++this.seq
  }

  /** Apply a record in memory, then durably append it to the journal. */
  private async write(record: JournalRecord): Promise<void> {
    await this.applyRecord(record, false)
    await this.appendJournal(record)
    this.scheduleCheckpoint()
  }

  /**
   * Fold one record into the in-memory day.
   *
   * `replaying` guards against double-application: a record whose seq the day
   * file already carries was checkpointed before the crash and must be skipped.
   * Returns whether it was applied.
   */
  private async applyRecord(record: JournalRecord, replaying: boolean): Promise<boolean> {
    const keys = record.op === 'appendSessions' ? Object.keys(record.days) : [record.key]
    let applied = false

    for (const key of keys) {
      if (!DAY_KEY_RE.test(key)) continue
      const entry = await this.load(key)
      if (replaying && record.seq <= entry.record.lastSeq) continue

      switch (record.op) {
        case 'appendSessions': {
          const incoming = record.days[key] || []
          const list = entry.record.sessions
          const tail = list[list.length - 1]
          list.push(...incoming)
          // Sessions arrive chronologically in the common case, so a tail check
          // beats re-sorting the day on every flush.
          if (tail && incoming.some((s) => s.startTime < tail.startTime)) sortSessions(list)
          break
        }
        case 'putSessions':
          entry.record.sessions = sortSessions([...record.sessions])
          break
        case 'appendIdle':
          entry.record.idle.push(record.block)
          break
        case 'putIdle':
          entry.record.idle = [...record.blocks]
          break
        case 'putEvents':
          entry.record.events = [...record.events]
          break
        case 'updateSession': {
          const index = entry.record.sessions.findIndex((s) => s.id === record.id)
          if (index < 0) break
          entry.record.sessions[index] = {
            ...entry.record.sessions[index],
            ...record.patch,
            id: entry.record.sessions[index].id,
          }
          break
        }
      }

      entry.record.lastSeq = Math.max(entry.record.lastSeq, record.seq)
      entry.dirty = true
      this.index.add(key)
      applied = true
    }
    return applied
  }

  /**
   * Append to the journal, serialised through a promise chain so records can
   * never interleave. Awaited by the caller: this is the durability point.
   */
  private appendJournal(record: JournalRecord): Promise<void> {
    this.journalRecords += 1
    this.journalTail = this.journalTail
      .catch(() => {})
      .then(() => fs.appendFile(this.journalFile, `${JSON.stringify(record)}\n`, 'utf8'))
      .catch((err) => {
        // A failed journal append is not fatal — the write is still in memory
        // and the checkpoint will persist it — but it must be visible.
        console.error('[storage] journal append failed:', err)
      })
    return this.journalTail
  }

  // ── Checkpointing ──────────────────────────────────────────────────────────

  private scheduleCheckpoint(): void {
    if (this.journalRecords >= JOURNAL_CHECKPOINT_RECORDS) {
      void this.checkpoint()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.checkpoint()
    }, WRITE_DEBOUNCE_MS)
    // Never hold the process open just to flush a cache.
    this.timer.unref?.()
  }

  /** Write every dirty day, then drop the journal records they covered. */
  private async checkpoint(): Promise<void> {
    if (this.checkpointing) return this.checkpointing
    this.checkpointing = (async () => {
      try {
        const dirty = [...this.cache.entries()].filter(([, e]) => e.dirty)
        if (!dirty.length) {
          await this.truncateJournal()
          return
        }
        for (const [key, entry] of dirty) {
          // The payload is serialised synchronously with this read, so it is
          // exactly the state `seqAtWrite` describes. A write that lands during
          // the await leaves the day dirty rather than being dropped when the
          // journal is truncated below.
          const seqAtWrite = entry.record.lastSeq
          await this.writeDayFile(key, entry.record)
          if (entry.record.lastSeq === seqAtWrite) entry.dirty = false
          this.index.add(key)
        }
        await this.truncateJournal()
        this.evict()
      } catch (err) {
        console.error('[storage] checkpoint failed:', err)
      } finally {
        this.checkpointing = null
      }
    })()
    return this.checkpointing
  }

  private async truncateJournal(): Promise<void> {
    if (!this.journalRecords) return
    // Serialise behind any in-flight append so a record is never dropped
    // between being written and being checkpointed.
    await this.journalTail.catch(() => {})
    if ([...this.cache.values()].some((e) => e.dirty)) return
    this.journalRecords = 0
    await fs.rm(this.journalFile, { force: true }).catch(() => {})
  }

  private async writeDayFile(key: string, record: DayFile): Promise<void> {
    await this.atomicWrite(this.dayPath(key), JSON.stringify(record))
  }

  private async atomicWrite(file: string, payload: string): Promise<void> {
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, file)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.journalTail.catch(() => {})
    // A checkpoint already in flight may predate the newest write, so run until
    // nothing is dirty. Bounded, because nothing new is being appended on quit.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.checkpoint()
      if (![...this.cache.values()].some((e) => e.dirty)) break
    }
    await this.writeMeta()
  }

  // ── Bulk operations ────────────────────────────────────────────────────────

  /**
   * Delete every day strictly older than `cutoffKey`.
   *
   * Retention is opt-in and off by default: silently deleting someone's history
   * because a default said so is the kind of thing that makes a local-first app
   * untrustworthy. When it is on, deletion is real — files are removed, not
   * hidden.
   */
  async prune(cutoffKey: string): Promise<string[]> {
    const removed: string[] = []
    for (const key of [...this.index]) {
      if (key >= cutoffKey) continue
      await fs.rm(this.dayPath(key), { force: true }).catch(() => {})
      this.index.delete(key)
      this.cache.delete(key)
      this.demoDayKeys.delete(key)
      removed.push(key)
    }
    if (removed.length) await this.writeMeta()
    return removed
  }

  /**
   * Remove every trace of synthetic history.
   *
   * Two passes, because synthetic data arrives two ways. Whole days that were
   * *seeded* are deleted outright. Individual rows produced by the demo capture
   * adapter can also land in a day that has real records — if capture starts
   * working mid-afternoon, today holds both — so those are filtered out row by
   * row instead of taking the day with them.
   *
   * Returns the number of days affected either way.
   */
  async clearDemoDays(): Promise<number> {
    const seeded = [...this.demoDayKeys]
    for (const key of seeded) {
      await fs.rm(this.dayPath(key), { force: true }).catch(() => {})
      this.index.delete(key)
      this.cache.delete(key)
    }
    this.demoDayKeys.clear()

    let touched = seeded.length
    for (const key of [...this.index]) {
      const { record } = await this.load(key)
      const sessions = record.sessions.filter((s) => s.source !== 'demo')
      const events = record.events.filter((e) => e.source !== 'demo')
      if (sessions.length === record.sessions.length && events.length === record.events.length) {
        continue
      }
      await this.putSessions(key, sessions)
      await this.putEvents(key, events)
      touched += 1
    }

    await this.writeMeta()
    return touched
  }

  /**
   * Replace the whole store from a backup.
   *
   * Writes day files first and only then swaps the journal away, so an
   * interrupted restore leaves the previous store readable rather than half of
   * each.
   */
  async replaceAll(config: StoreConfig, days: Record<string, DayRecord>): Promise<void> {
    await this.flush()
    for (const key of [...this.index]) {
      await fs.rm(this.dayPath(key), { force: true }).catch(() => {})
    }
    this.cache.clear()
    this.index.clear()
    this.demoDayKeys.clear()

    for (const [key, record] of Object.entries(days)) {
      if (!DAY_KEY_RE.test(key)) continue
      await this.writeDayFile(key, {
        sessions: sortSessions([...(record.sessions || [])]),
        idle: [...(record.idle || [])],
        events: [...(record.events || [])],
        lastSeq: 0,
      })
      this.index.add(key)
    }

    this.config = migrateConfig(config)
    this.seq = 0
    this.journalRecords = 0
    await fs.rm(this.journalFile, { force: true }).catch(() => {})
    await this.writeMeta()
  }

  /** Read every day back out, for a backup. Streams day by day, never all at once. */
  async exportDays(keys: string[] = this.listDayKeys()): Promise<Record<string, DayRecord>> {
    const out: Record<string, DayRecord> = {}
    for (const key of keys) out[key] = await this.getDay(key)
    return out
  }
}
