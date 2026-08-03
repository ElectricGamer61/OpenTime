/**
 * Shared domain types for OpenTime.
 *
 * These types are the contract between the capture engine (main process), the
 * storage layer, and the renderer. Keep them plain and serialisable — every one
 * of them crosses the IPC boundary via structured clone.
 */

/** How an activity contributes to the day. */
export type Productivity = 'productive' | 'neutral' | 'distracting'

/** One raw sample of the OS focused window. */
export interface WindowSample {
  /** Executable / application display name, e.g. "Code", "chrome". */
  app: string
  /** Focused window title. */
  title: string
  /**
   * Host only (never a full URL) for browser windows, e.g. "github.com".
   * Paths and query strings are deliberately discarded so no tokens or message
   * contents are ever persisted. Empty for non-browser apps.
   */
  url?: string
  /** Absolute path of the focused executable, when the platform exposes it. */
  execPath?: string
}

/** A contiguous stretch of time spent on one category of work. */
export interface Session {
  id: string
  /** Category name resolved by the rules engine at flush time. */
  category: string
  app: string
  title: string
  url: string
  productivity: Productivity
  /** Epoch ms. */
  startTime: number
  /** Epoch ms. */
  endTime: number
  durationSeconds: number
  /** Project id this session was attributed to, if any. */
  projectId?: string
}

/** A stretch the user was away from the machine (OS-reported idle). */
export interface IdleBlock {
  startTime: number
  endTime: number
  durationSeconds: number
}

/** "Remember this app as X" and learned keyword rules. */
export interface CategoryRule {
  id: string
  /** 'app' matches the executable name exactly; 'keyword' is a substring of "app title url". */
  kind: 'app' | 'keyword'
  /** Lower-cased match value. */
  match: string
  category: string
  /** Optional productivity override applied alongside the category. */
  productivity?: Productivity
}

/** A user-defined body of work; keywords auto-attribute sessions to it. */
export interface Project {
  id: string
  name: string
  color: string
  /** Lower-cased substrings matched against "app title url". */
  keywords: string[]
  archived?: boolean
}

/** Calendar event overlaid on the timeline. */
export interface CalendarEvent {
  id: string
  title: string
  /** Epoch ms. */
  start: number
  /** Epoch ms. */
  end: number
  allDay?: boolean
  /** Where the event came from — used for badge + refresh semantics. */
  source: 'google' | 'manual' | 'demo'
  calendarName?: string
}

export interface Settings {
  /** Active-mode sampling interval in seconds. */
  pollIntervalSeconds: number
  /** OS idle seconds before the open session is closed. */
  idleThresholdSeconds: number
  /** A gap larger than this starts a new session even within one category. */
  sessionGapSeconds: number
  /** Hour (local, 0–23) at which the tracking day rolls over. */
  dayStartHour: number
  /** Minutes of unbroken active time before the break nudge fires. */
  focusBlockMinutes: number
  /** Apps we never record (lower-cased names). */
  ignoredApps: string[]
  /** Capture adapter preference; 'auto' probes the native one and falls back. */
  captureMode: 'auto' | 'native' | 'demo'
  launchAtLogin: boolean
  notificationsEnabled: boolean
  calendar: CalendarSettings
}

export interface CalendarSettings {
  connected: boolean
  /** User-owned Google Cloud OAuth client id. Never shipped in the installer. */
  clientId: string
  /** User-owned client secret; stored only in the local app-data settings file. */
  clientSecret: string
  /** Read-only is the lighter Google verification path — see README. */
  scope: 'calendar.readonly' | 'calendar'
  accountEmail?: string
  lastSyncedAt?: number
}

/** Everything persisted by the storage layer, one shape for JSON or SQLite. */
export interface PersistedState {
  version: number
  settings: Settings
  projects: Project[]
  rules: CategoryRule[]
  /** Day key (YYYY-MM-DD, tracking-day bucketed) → sessions, ascending by start. */
  sessionsByDay: Record<string, Session[]>
  /** Day key → idle blocks. */
  idleByDay: Record<string, IdleBlock[]>
  /** Day key → calendar events. */
  eventsByDay: Record<string, CalendarEvent[]>
}

/** Live tracker status pushed to the renderer. */
export interface TrackerStatus {
  running: boolean
  paused: boolean
  mode: 'active' | 'idle'
  captureAdapter: string
  /** Whether the running adapter is real OS capture or generated demo data. */
  demo: boolean
  /** The session currently open, extended to now. Null when idle/paused. */
  current: (Session & { open: true }) | null
  /** Epoch ms the current unbroken active stretch began; null when idle. */
  stretchStart: number | null
}
