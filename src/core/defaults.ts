/** Factory defaults for a fresh OpenTime install. */

import { DEFAULT_DAY_START_HOUR } from './day'
import type { CategoryRule, PersistedState, Project, Settings } from './types'

export const STATE_VERSION = 1

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSeconds: 5,
  idleThresholdSeconds: 120,
  sessionGapSeconds: 60,
  dayStartHour: DEFAULT_DAY_START_HOUR,
  focusBlockMinutes: 75,
  ignoredApps: [],
  captureMode: 'auto',
  launchAtLogin: false,
  notificationsEnabled: true,
  calendar: {
    connected: false,
    clientId: '',
    clientSecret: '',
    scope: 'calendar.readonly',
  },
}

export const DEFAULT_PROJECTS: Project[] = [
  { id: 'p_deep_work', name: 'Deep Work', color: '#5b8cff', keywords: ['code', 'vscode', 'terminal', 'github'] },
  { id: 'p_design', name: 'Design', color: '#38bdf8', keywords: ['figma', 'sketch', 'photoshop', 'illustrator'] },
  { id: 'p_writing', name: 'Writing', color: '#22d3ee', keywords: ['docs.google', 'notion', 'obsidian', 'word'] },
  { id: 'p_communication', name: 'Communication', color: '#f6b26b', keywords: ['slack', 'mail', 'gmail', 'outlook', 'teams'] },
  { id: 'p_meetings', name: 'Meetings', color: '#c084fc', keywords: ['zoom', 'meet.google', 'teams meeting', 'webex'] },
  { id: 'p_research', name: 'Research', color: '#34d399', keywords: ['wikipedia', 'arxiv', 'stackoverflow', 'developer.mozilla'] },
  { id: 'p_breaks', name: 'Breaks', color: '#94a3b8', keywords: ['youtube', 'netflix', 'reddit', 'twitch'] },
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

export function defaultState(): PersistedState {
  return {
    version: STATE_VERSION,
    settings: DEFAULT_SETTINGS,
    projects: DEFAULT_PROJECTS,
    rules: DEFAULT_RULES,
    sessionsByDay: {},
    idleByDay: {},
    eventsByDay: {},
  }
}

/** Colour lookup for a category name, falling back to a neutral slate. */
export function projectColor(projects: Project[], category: string): string {
  return projects.find((p) => p.name === category)?.color || '#64748b'
}
