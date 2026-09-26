/** Factory defaults for a fresh OpenTime install, and settings validation. */

import { DEFAULT_BLOCK_TARGETS, normalizeBlockTargets } from './blocking'
import { DEFAULT_DAY_START_HOUR } from './day'
import type {
  BlockingSettings,
  CalendarSettings,
  CategoryRule,
  Goal,
  PersistedState,
  Project,
  Settings,
  StoreConfig,
} from './types'

/**
 * Bumped to 2 when goals, retention and the honest-demo settings landed and the
 * store moved from one JSON blob to per-day shards. `migrateConfig` fills in
 * every field a v1 file is missing, so an upgrade never loses data.
 */
export const STATE_VERSION = 2

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSeconds: 5,
  idleThresholdSeconds: 120,
  sessionGapSeconds: 60,
  dayStartHour: DEFAULT_DAY_START_HOUR,
  focusBlockMinutes: 75,
  ignoredApps: [],
  ignoredTitleKeywords: [],
  retentionDays: 0,
  captureMode: 'auto',
  seedDemoWhenUnavailable: false,
  launchAtLogin: false,
  notificationsEnabled: true,
  theme: 'system',
  checkForUpdates: false,
  blocking: {
    enabled: false,
    targets: DEFAULT_BLOCK_TARGETS,
  },
  calendar: {
    connected: false,
    clientId: '',
    clientSecret: '',
    scope: 'calendar.readonly',
  },
}

/**
 * Colours are taken from `CATEGORY_PALETTE` in the renderer's palette module so
 * a starter project and an unrecognised category are drawn from one set. They
 * are saturated on purpose: the calendar paints them as solid block fills.
 */
export const DEFAULT_PROJECTS: Project[] = [
  { id: 'p_deep_work', name: 'Deep Work', color: '#7c5cff', keywords: ['code', 'vscode', 'terminal', 'github'] },
  { id: 'p_design', name: 'Design', color: '#12b5b0', keywords: ['figma', 'sketch', 'photoshop', 'illustrator'] },
  { id: 'p_writing', name: 'Writing', color: '#4a9eff', keywords: ['docs.google', 'notion', 'obsidian', 'word'] },
  { id: 'p_communication', name: 'Communication', color: '#e0a83e', keywords: ['slack', 'mail', 'gmail', 'outlook', 'teams'] },
  { id: 'p_meetings', name: 'Meetings', color: '#c86bf0', keywords: ['zoom', 'meet.google', 'teams meeting', 'webex'] },
  { id: 'p_research', name: 'Research', color: '#3ecf6e', keywords: ['wikipedia', 'arxiv', 'stackoverflow', 'developer.mozilla'] },
  { id: 'p_breaks', name: 'Breaks', color: '#f2545b', keywords: ['youtube', 'netflix', 'reddit', 'twitch'] },
]

/**
 * Seed rules.
 *
 * Rules outrank projects, which is what makes these necessary: "Breaks" is a
 * legitimate category the user wants to see on the timeline, but naming a
 * category must not by itself make the time count as productive. Without these,
 * every hour of the day would score as focus.
 */
export const DEFAULT_RULES: CategoryRule[] = [
  { id: 'r_youtube', kind: 'keyword', match: 'youtube', category: 'Breaks', productivity: 'distracting' },
  { id: 'r_netflix', kind: 'keyword', match: 'netflix', category: 'Breaks', productivity: 'distracting' },
  { id: 'r_reddit', kind: 'keyword', match: 'reddit', category: 'Breaks', productivity: 'distracting' },
  { id: 'r_twitch', kind: 'keyword', match: 'twitch', category: 'Breaks', productivity: 'distracting' },
  { id: 'r_slack', kind: 'keyword', match: 'slack', category: 'Communication', productivity: 'neutral' },
]

/**
 * Two starter goals, both off by default.
 *
 * Goals that arrive switched on are goals someone else set for you, and the
 * first thing a user does with those is stop believing the number. They exist as
 * templates: switch one on and it is already sensible.
 */
export const DEFAULT_GOALS: Goal[] = [
  {
    id: 'g_focus_daily',
    name: 'Daily focus time',
    kind: 'productivity',
    target: 'productive',
    direction: 'at-least',
    seconds: 4 * 3600,
    cadence: 'daily',
    enabled: false,
  },
  {
    id: 'g_distraction_daily',
    name: 'Daily distraction ceiling',
    kind: 'productivity',
    target: 'distracting',
    direction: 'at-most',
    seconds: 45 * 60,
    cadence: 'daily',
    enabled: false,
  },
]

export function defaultConfig(): StoreConfig {
  return {
    version: STATE_VERSION,
    settings: DEFAULT_SETTINGS,
    projects: DEFAULT_PROJECTS,
    rules: DEFAULT_RULES,
    goals: DEFAULT_GOALS,
  }
}

export function defaultState(): PersistedState {
  return {
    ...defaultConfig(),
    sessionsByDay: {},
    idleByDay: {},
    eventsByDay: {},
  }
}

/** Colour lookup for a category name, falling back to a neutral slate. */
export function projectColor(projects: Project[], category: string): string {
  return projects.find((p) => p.name === category)?.color || '#64748b'
}

// ── Validation ───────────────────────────────────────────────────────────────

const POLL_RANGE: [number, number] = [1, 300]
const IDLE_RANGE: [number, number] = [30, 3600]
const GAP_RANGE: [number, number] = [10, 3600]
const FOCUS_RANGE: [number, number] = [15, 480]
const RETENTION_RANGE: [number, number] = [0, 3650]

function clampInt(value: unknown, [lo, hi]: [number, number], fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const raw of value) {
    const v = String(raw ?? '').trim().toLowerCase()
    if (v) seen.add(v)
  }
  return [...seen]
}

/**
 * Coerce anything claiming to be `Settings` into settings the engine can run on.
 *
 * Settings cross IPC from a renderer and come back out of a user-editable JSON
 * file and out of restored backups. A `pollIntervalSeconds` of 0 would spin the
 * event loop; a negative idle threshold would close every session instantly.
 * Every path that writes settings goes through here.
 */
export function sanitizeSettings(input: Partial<Settings> | null | undefined): Settings {
  const raw = (input || {}) as Partial<Settings>
  const calendarRaw = (raw.calendar || {}) as Partial<CalendarSettings>
  const calendar: CalendarSettings = {
    connected: !!calendarRaw.connected,
    clientId: String(calendarRaw.clientId ?? '').trim(),
    clientSecret: String(calendarRaw.clientSecret ?? '').trim(),
    scope: calendarRaw.scope === 'calendar' ? 'calendar' : 'calendar.readonly',
    accountEmail: calendarRaw.accountEmail ? String(calendarRaw.accountEmail) : undefined,
    lastSyncedAt: Number.isFinite(Number(calendarRaw.lastSyncedAt))
      ? Number(calendarRaw.lastSyncedAt)
      : undefined,
  }

  const captureMode =
    raw.captureMode === 'native' || raw.captureMode === 'demo' ? raw.captureMode : 'auto'

  // A config written before blocking existed gets the starter list, switched
  // off; one that exists keeps exactly what the user left in it, even empty.
  const blockingRaw = raw.blocking as Partial<BlockingSettings> | undefined
  const blocking: BlockingSettings = {
    enabled: !!blockingRaw?.enabled,
    targets: Array.isArray(blockingRaw?.targets)
      ? normalizeBlockTargets(blockingRaw.targets)
      : [...DEFAULT_BLOCK_TARGETS],
  }

  return {
    pollIntervalSeconds: clampInt(
      raw.pollIntervalSeconds,
      POLL_RANGE,
      DEFAULT_SETTINGS.pollIntervalSeconds
    ),
    idleThresholdSeconds: clampInt(
      raw.idleThresholdSeconds,
      IDLE_RANGE,
      DEFAULT_SETTINGS.idleThresholdSeconds
    ),
    sessionGapSeconds: clampInt(raw.sessionGapSeconds, GAP_RANGE, DEFAULT_SETTINGS.sessionGapSeconds),
    dayStartHour: clampInt(raw.dayStartHour, [0, 23], DEFAULT_SETTINGS.dayStartHour),
    focusBlockMinutes: clampInt(raw.focusBlockMinutes, FOCUS_RANGE, DEFAULT_SETTINGS.focusBlockMinutes),
    ignoredApps: stringList(raw.ignoredApps),
    ignoredTitleKeywords: stringList(raw.ignoredTitleKeywords),
    retentionDays: clampInt(raw.retentionDays, RETENTION_RANGE, DEFAULT_SETTINGS.retentionDays),
    captureMode,
    seedDemoWhenUnavailable:
      raw.seedDemoWhenUnavailable === undefined ? false : !!raw.seedDemoWhenUnavailable,
    launchAtLogin: !!raw.launchAtLogin,
    notificationsEnabled: raw.notificationsEnabled === undefined ? true : !!raw.notificationsEnabled,
    theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
    onboardedAt: Number.isFinite(Number(raw.onboardedAt)) && Number(raw.onboardedAt) > 0
      ? Number(raw.onboardedAt)
      : undefined,
    checkForUpdates: !!raw.checkForUpdates,
    blocking,
    calendar,
  }
}

/** Fill in anything a config file written by an older version is missing. */
export function migrateConfig(input: Partial<StoreConfig> | null | undefined): StoreConfig {
  const base = defaultConfig()
  if (!input || typeof input !== 'object') return base
  return {
    version: STATE_VERSION,
    settings: sanitizeSettings(input.settings),
    projects: input.projects?.length ? input.projects : base.projects,
    rules: Array.isArray(input.rules) ? input.rules : base.rules,
    goals: Array.isArray(input.goals) ? input.goals : base.goals,
  }
}
