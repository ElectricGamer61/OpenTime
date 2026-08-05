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

/**
 * Where a session came from.
 *
 * This matters for honesty: `demo` rows are synthesised, and the user must be
 * able to see that and delete them in one action rather than discovering months
 * later that their history is partly fictional.
 */
export type SessionSource = 'capture' | 'manual' | 'demo'

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
  /** Defaults to 'capture' when absent (every v1 row predates this field). */
  source?: SessionSource
  /** Free text the user attached in the review panel. */
  note?: string
  /** True once a human corrected or created this row by hand. */
  edited?: boolean
  /** Set when this stretch fell inside a focus session the user ran. */
  focus?: FocusMark
}

/**
 * The stamp a finished focus session leaves on the time it covered.
 *
 * A focus session is not a second kind of record: it is a claim over minutes
 * the tracker already observed. Sealing one marks those rows, so the timeline
 * can draw the session as one block without any of the time being counted
 * twice or any of the underlying apps being thrown away.
 */
export interface FocusMark {
  /** Id of the focus session, shared by every row it covered. */
  id: string
  /** What the user said they were going to do. */
  label: string
  /** Seconds the session was planned to run, for planned-vs-actual. */
  plannedSeconds: number
}

/** Ambient sound played during a focus session. Ids are synthesised, not files. */
export type AmbientBedId = 'silence' | 'rain' | 'ocean' | 'cafe' | 'deep'

/** A focus session that is running right now. Held in memory, never on disk. */
export interface ActiveFocus {
  id: string
  /** The goal the user typed, or a default. Never empty. */
  label: string
  /** Epoch ms. */
  startTime: number
  /** Planned length in seconds. The session is not stopped when it elapses. */
  plannedSeconds: number
  /** Category the filled-in gaps are recorded under. */
  category: string
  projectId?: string
  sound: AmbientBedId
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

/** A time target the user is holding themselves to. */
export interface Goal {
  id: string
  name: string
  /**
   * 'productivity' targets one of the three productivity levels;
   * 'category' targets a single category / project name.
   */
  kind: 'productivity' | 'category'
  /** A `Productivity` value, or a category name, depending on `kind`. */
  target: string
  /** Whether the target is a floor to reach or a ceiling to stay under. */
  direction: 'at-least' | 'at-most'
  /** The target itself, in seconds. */
  seconds: number
  cadence: 'daily' | 'weekly'
  enabled: boolean
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
  /** Window titles containing any of these are never recorded (lower-cased). */
  ignoredTitleKeywords: string[]
  /** Days of history to keep. 0 keeps everything forever. */
  retentionDays: number
  /** Capture adapter preference; 'auto' probes the native one and falls back. */
  captureMode: 'auto' | 'native' | 'demo'
  /**
   * Whether a fortnight of synthetic history may be seeded when real capture is
   * unavailable. Off means an honest empty dashboard instead of fiction.
   */
  seedDemoWhenUnavailable: boolean
  launchAtLogin: boolean
  notificationsEnabled: boolean
  /** Epoch ms the first-run checklist was completed; undefined until then. */
  onboardedAt?: number
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

/**
 * Everything persisted by the storage layer.
 *
 * This remains the shape of a *backup*, and of the small configuration file the
 * live store keeps in memory. It is no longer the shape of the on-disk store:
 * `FileStorage` shards the per-day maps into one file per day so the store scales
 * past what fits in memory. See `src/main/storage/FileStorage.ts`.
 */
export interface PersistedState {
  version: number
  settings: Settings
  projects: Project[]
  rules: CategoryRule[]
  goals: Goal[]
  /** Day key (YYYY-MM-DD, tracking-day bucketed) → sessions, ascending by start. */
  sessionsByDay: Record<string, Session[]>
  /** Day key → idle blocks. */
  idleByDay: Record<string, IdleBlock[]>
  /** Day key → calendar events. */
  eventsByDay: Record<string, CalendarEvent[]>
}

/** The configuration half of `PersistedState` — small, always held in memory. */
export interface StoreConfig {
  version: number
  settings: Settings
  projects: Project[]
  rules: CategoryRule[]
  goals: Goal[]
}

/** One tracking day's records. The unit the sharded store reads and writes. */
export interface DayRecord {
  sessions: Session[]
  idle: IdleBlock[]
  events: CalendarEvent[]
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
  /** Epoch ms a timed pause expires at, when one is running. */
  pausedUntil?: number | null
  /** The focus session running now, when there is one. */
  focus?: ActiveFocus | null
}
