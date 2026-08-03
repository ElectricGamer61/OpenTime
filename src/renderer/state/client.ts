/**
 * Renderer-side data client.
 *
 * In the desktop app this is just `window.opentime`, the preload bridge. When
 * the renderer is opened in a plain browser (`npm run build:renderer` + any
 * static server, or the Vite dev server on its own) there is no main process, so
 * a self-contained in-memory implementation backed by the same demo generator
 * takes over. That keeps the UI reviewable without launching Electron and means
 * every code path the components use is exercised in both environments.
 */

import { dayKey, lastNDayKeys } from '../../core/day'
import { generateDemoDay, DemoSampleStream } from '../../core/demo'
import { defaultState } from '../../core/defaults'
import { resolveCategory, classifyProductivity } from '../../core/categorize'
import type {
  CalendarEvent,
  CategoryRule,
  PersistedState,
  Project,
  Settings,
  TrackerStatus,
} from '../../core/types'
import type { Bootstrap, CalendarResult, DayPayload, OpenTimeApi, RecategorizeRequest } from '../../shared/ipc'

function createBrowserFallback(): OpenTimeApi {
  const state: PersistedState = defaultState()
  const stream = new DemoSampleStream()
  const listeners = new Set<() => void>()
  const statusListeners = new Set<(s: TrackerStatus) => void>()
  const started = Date.now()
  let paused = false

  const key = () => dayKey(Date.now(), state.settings.dayStartHour)

  for (const k of lastNDayKeys(14, key())) {
    const day = generateDemoDay(k, {
      dayStartHour: state.settings.dayStartHour,
      sessionGapSeconds: state.settings.sessionGapSeconds,
      projects: state.projects,
      rules: state.rules,
    })
    state.sessionsByDay[k] = day.sessions
    state.idleByDay[k] = day.idle
    state.eventsByDay[k] = day.events
  }

  const payload = (k: string): DayPayload => ({
    dayKey: k,
    sessions: state.sessionsByDay[k] || [],
    idle: state.idleByDay[k] || [],
    events: state.eventsByDay[k] || [],
  })

  const status = (): TrackerStatus => {
    const sample = stream.next(Date.now())
    const resolution = resolveCategory(sample, state.rules, state.projects)
    const now = Date.now()
    return {
      running: true,
      paused,
      mode: paused ? 'idle' : 'active',
      captureAdapter: 'demo (browser preview)',
      demo: true,
      stretchStart: paused ? null : started,
      current: paused
        ? null
        : {
            id: 'current',
            category: resolution.category,
            projectId: resolution.projectId,
            app: sample.app,
            title: sample.title,
            url: sample.url || '',
            productivity: classifyProductivity(sample, resolution),
            startTime: started,
            endTime: now,
            durationSeconds: Math.round((now - started) / 1000),
            open: true,
          },
    }
  }

  const notify = () => listeners.forEach((fn) => fn())

  return {
    async getBootstrap(): Promise<Bootstrap> {
      const k = key()
      return {
        settings: state.settings,
        projects: state.projects,
        rules: state.rules,
        status: status(),
        today: payload(k),
        weekKeys: lastNDayKeys(7, k),
        appVersion: '0.1.0',
        platform: 'browser',
        captureNotice:
          'Browser preview — no OS capture available, showing generated demo activity.',
      }
    },
    async getDay(k) {
      return payload(k)
    },
    async getRange(keys) {
      return keys.map(payload)
    },
    async getStatus() {
      return status()
    },
    async setTracking(action) {
      paused = action === 'pause' || action === 'stop'
      const s = status()
      statusListeners.forEach((fn) => fn(s))
      return s
    },
    async saveSettings(settings: Settings) {
      state.settings = settings
      notify()
      return settings
    },
    async saveProjects(projects: Project[]) {
      state.projects = projects
      notify()
      return projects
    },
    async saveRules(rules: CategoryRule[]) {
      state.rules = rules
      notify()
      return rules
    },
    async recategorize(req: RecategorizeRequest) {
      const list = state.sessionsByDay[req.dayKey] || []
      const index = list.findIndex((s) => s.id === req.sessionId)
      if (index >= 0) {
        list[index] = {
          ...list[index],
          category: req.category,
          productivity: req.productivity || list[index].productivity,
        }
      }
      notify()
      return payload(req.dayKey)
    },
    async addManualEvent(input: Omit<CalendarEvent, 'id' | 'source'>) {
      const k = dayKey(input.start, state.settings.dayStartHour)
      state.eventsByDay[k] = [
        ...(state.eventsByDay[k] || []),
        { ...input, id: `manual_${Date.now()}`, source: 'manual' as const },
      ].sort((a, b) => a.start - b.start)
      notify()
      return payload(k)
    },
    async connectCalendar(): Promise<CalendarResult> {
      return {
        ok: false,
        message: 'Google Calendar can only be connected from the desktop app.',
      }
    },
    async disconnectCalendar(): Promise<CalendarResult> {
      return { ok: true, message: 'Disconnected.' }
    },
    async syncCalendar(): Promise<CalendarResult> {
      return { ok: false, message: 'Not connected.' }
    },
    onStatus(handler) {
      statusListeners.add(handler)
      const timer = setInterval(() => handler(status()), 5000)
      return () => {
        statusListeners.delete(handler)
        clearInterval(timer)
      }
    },
    onDataChanged(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
}

let cached: OpenTimeApi | null = null

export function client(): OpenTimeApi {
  if (cached) return cached
  cached = typeof window !== 'undefined' && window.opentime ? window.opentime : createBrowserFallback()
  return cached
}
