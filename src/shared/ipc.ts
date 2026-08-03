/**
 * The IPC contract between main and renderer.
 *
 * One place, shared by `preload.ts` and the renderer's typed client, so a
 * channel can never drift between the two sides.
 */

import type {
  CalendarEvent,
  CategoryRule,
  IdleBlock,
  Project,
  Session,
  Settings,
  TrackerStatus,
} from '../core/types'

export const CHANNELS = {
  getBootstrap: 'opentime:getBootstrap',
  getDay: 'opentime:getDay',
  getRange: 'opentime:getRange',
  getStatus: 'opentime:getStatus',
  setTracking: 'opentime:setTracking',
  saveSettings: 'opentime:saveSettings',
  saveProjects: 'opentime:saveProjects',
  saveRules: 'opentime:saveRules',
  recategorize: 'opentime:recategorize',
  addManualEvent: 'opentime:addManualEvent',
  connectCalendar: 'opentime:connectCalendar',
  disconnectCalendar: 'opentime:disconnectCalendar',
  syncCalendar: 'opentime:syncCalendar',
  statusEvent: 'opentime:status',
  dataEvent: 'opentime:data-changed',
} as const

export interface DayPayload {
  dayKey: string
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
}

export interface Bootstrap {
  settings: Settings
  projects: Project[]
  rules: CategoryRule[]
  status: TrackerStatus
  today: DayPayload
  /** Day keys of the trailing week, oldest first. */
  weekKeys: string[]
  appVersion: string
  platform: string
  /** Populated when capture fell back to the demo adapter. */
  captureNotice?: string
}

export interface RecategorizeRequest {
  dayKey: string
  sessionId: string
  category: string
  /** Also persist a rule so future activity matches automatically. */
  rememberAs?: 'app' | 'keyword'
  productivity?: Session['productivity']
}

export interface CalendarResult {
  ok: boolean
  message: string
}

/** The surface exposed on `window.opentime`. */
export interface OpenTimeApi {
  getBootstrap(): Promise<Bootstrap>
  getDay(dayKey: string): Promise<DayPayload>
  getRange(dayKeys: string[]): Promise<DayPayload[]>
  getStatus(): Promise<TrackerStatus>
  setTracking(action: 'start' | 'pause' | 'resume' | 'stop'): Promise<TrackerStatus>
  saveSettings(settings: Settings): Promise<Settings>
  saveProjects(projects: Project[]): Promise<Project[]>
  saveRules(rules: CategoryRule[]): Promise<CategoryRule[]>
  recategorize(request: RecategorizeRequest): Promise<DayPayload>
  addManualEvent(event: Omit<CalendarEvent, 'id' | 'source'>): Promise<DayPayload>
  connectCalendar(): Promise<CalendarResult>
  disconnectCalendar(): Promise<CalendarResult>
  syncCalendar(): Promise<CalendarResult>
  onStatus(handler: (status: TrackerStatus) => void): () => void
  onDataChanged(handler: () => void): () => void
}

declare global {
  interface Window {
    opentime: OpenTimeApi
  }
}
