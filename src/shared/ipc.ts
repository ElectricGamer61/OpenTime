/**
 * The IPC contract between main and renderer.
 *
 * One place, shared by `preload.ts` and the renderer's typed client, so a
 * channel can never drift between the two sides.
 */

import type {
  ActiveFocus,
  CalendarEvent,
  CategoryRule,
  Goal,
  IdleBlock,
  Productivity,
  Project,
  Session,
  Settings,
  TrackerStatus,
} from '../core/types'
import type { FocusOutcome, FocusStartInput } from '../core/focus'

export const CHANNELS = {
  getBootstrap: 'opentime:getBootstrap',
  getDay: 'opentime:getDay',
  getRange: 'opentime:getRange',
  getStatus: 'opentime:getStatus',
  setTracking: 'opentime:setTracking',
  saveSettings: 'opentime:saveSettings',
  saveProjects: 'opentime:saveProjects',
  saveRules: 'opentime:saveRules',
  saveGoals: 'opentime:saveGoals',
  recategorize: 'opentime:recategorize',
  editSession: 'opentime:editSession',
  addManualEvent: 'opentime:addManualEvent',
  connectCalendar: 'opentime:connectCalendar',
  disconnectCalendar: 'opentime:disconnectCalendar',
  syncCalendar: 'opentime:syncCalendar',
  exportData: 'opentime:exportData',
  importBackup: 'opentime:importBackup',
  revealDataFolder: 'opentime:revealDataFolder',
  clearDemoData: 'opentime:clearDemoData',
  reloadCapture: 'opentime:reloadCapture',
  completeOnboarding: 'opentime:completeOnboarding',
  startFocus: 'opentime:startFocus',
  endFocus: 'opentime:endFocus',
  extendFocus: 'opentime:extendFocus',
  statusEvent: 'opentime:status',
  dataEvent: 'opentime:data-changed',
} as const

export interface DayPayload {
  dayKey: string
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
}

/** Everything the user needs to know about whether tracking is really working. */
export interface CaptureHealth {
  /** Adapter in use, e.g. "x-win (native)". */
  adapter: string
  /** True when the numbers are synthesised rather than observed. */
  demo: boolean
  /** Plain-language explanation of a fallback or a degraded permission. */
  notice?: string
  /** What the user could do about it, when there is something. */
  remedy?: 'macos-accessibility' | 'unsupported-session' | 'module-missing'
  /** Whether macOS has granted Accessibility (undefined off macOS). */
  accessibilityTrusted?: boolean
}

export interface Bootstrap {
  settings: Settings
  projects: Project[]
  rules: CategoryRule[]
  goals: Goal[]
  status: TrackerStatus
  today: DayPayload
  /** Day keys of the trailing week, oldest first. */
  weekKeys: string[]
  /** Every day key with recorded history, ascending — the reporting range. */
  historyKeys: string[]
  appVersion: string
  platform: string
  /** Where the store lives on disk, shown in Settings. */
  dataDirectory: string
  capture: CaptureHealth
  /** Populated when capture fell back to the demo adapter. */
  captureNotice?: string
  /** True until the first-run checklist has been completed. */
  firstRun: boolean
  /** Day keys holding seeded demo history, so the UI can offer to clear them. */
  demoDays: string[]
}

export interface RecategorizeRequest {
  dayKey: string
  sessionId: string
  category: string
  /** Also persist a rule so future activity matches automatically. */
  rememberAs?: 'app' | 'keyword'
  productivity?: Productivity
  note?: string
}

/**
 * Every structural correction, in one channel.
 *
 * A discriminated union rather than six near-identical channels: they all take
 * a day key, all mutate one day's sessions, and all return the updated day, so
 * splitting them apart would only duplicate the plumbing.
 */
export type SessionEdit =
  | { kind: 'split'; dayKey: string; sessionId: string; at: number }
  | { kind: 'merge'; dayKey: string; sessionIds: string[] }
  | { kind: 'delete'; dayKey: string; sessionId: string }
  | { kind: 'retime'; dayKey: string; sessionId: string; startTime: number; endTime: number }
  | {
      kind: 'manual'
      dayKey: string
      startTime: number
      endTime: number
      category: string
      productivity?: Productivity
      note?: string
    }
  /**
   * Close a focus session over the day it ran in. Not offered in the review
   * panel — it is what `endFocus` writes with — but it belongs here because it
   * is a correction like any other and shares the same one-write guarantee.
   */
  | { kind: 'seal-focus'; dayKey: string; focus: ActiveFocus; endTime: number }
  | {
      kind: 'claim-idle'
      dayKey: string
      /** Start time of the away block being claimed — idle blocks carry no id. */
      idleStart: number
      category: string
      productivity?: Productivity
      note?: string
    }

export interface EditResult {
  ok: boolean
  message?: string
  day?: DayPayload
}

export interface CalendarResult {
  ok: boolean
  message: string
}

/**
 * The result of ending a focus session.
 *
 * Carries the status back with it so the renderer never has to guess whether
 * the session really closed, and the outcome so the "how did that go" card can
 * be drawn from what actually landed on disk rather than from what the
 * renderer's own timer thought.
 */
export interface FocusEndResult {
  ok: boolean
  message?: string
  status: TrackerStatus
  dayKey?: string
  outcome?: FocusOutcome
}

export interface FocusStartResult {
  ok: boolean
  message?: string
  status: TrackerStatus
  focus?: ActiveFocus
}

export type ExportFormat = 'sessions-csv' | 'daily-csv' | 'backup-json'

export interface ExportRequest {
  format: ExportFormat
  /** Inclusive day-key range. Defaults to the whole history. */
  fromKey?: string
  toKey?: string
}

export interface ExportResult {
  ok: boolean
  message: string
  /** Where the file landed, when it did. */
  path?: string
  /** Rows or days written — the number worth confirming back to the user. */
  count?: number
}

/** The surface exposed on `window.opentime`. */
export interface OpenTimeApi {
  getBootstrap(): Promise<Bootstrap>
  getDay(dayKey: string): Promise<DayPayload>
  getRange(dayKeys: string[]): Promise<DayPayload[]>
  getStatus(): Promise<TrackerStatus>
  setTracking(
    action: 'start' | 'pause' | 'resume' | 'stop',
    minutes?: number
  ): Promise<TrackerStatus>
  saveSettings(settings: Settings): Promise<Settings>
  saveProjects(projects: Project[]): Promise<Project[]>
  saveRules(rules: CategoryRule[]): Promise<CategoryRule[]>
  saveGoals(goals: Goal[]): Promise<Goal[]>
  recategorize(request: RecategorizeRequest): Promise<DayPayload>
  editSession(edit: SessionEdit): Promise<EditResult>
  addManualEvent(event: Omit<CalendarEvent, 'id' | 'source'>): Promise<DayPayload>
  connectCalendar(): Promise<CalendarResult>
  disconnectCalendar(): Promise<CalendarResult>
  syncCalendar(): Promise<CalendarResult>
  exportData(request: ExportRequest): Promise<ExportResult>
  importBackup(): Promise<ExportResult>
  revealDataFolder(): Promise<void>
  clearDemoData(): Promise<ExportResult>
  reloadCapture(): Promise<CaptureHealth>
  completeOnboarding(): Promise<Settings>
  startFocus(input: FocusStartInput): Promise<FocusStartResult>
  endFocus(): Promise<FocusEndResult>
  /** Push the planned end out by `minutes`. Never shortens a session. */
  extendFocus(minutes: number): Promise<FocusStartResult>
  onStatus(handler: (status: TrackerStatus) => void): () => void
  onDataChanged(handler: () => void): () => void
}

declare global {
  interface Window {
    opentime: OpenTimeApi
  }
}
