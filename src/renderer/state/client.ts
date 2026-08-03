/**
 * Renderer-side data client.
 *
 * In the desktop app this is just `window.opentime`, the preload bridge. When
 * the renderer is opened in a plain browser (`npm run build:renderer` + any
 * static server, or the Vite dev server on its own) there is no main process, so
 * a self-contained in-memory implementation backed by the same demo generator
 * takes over. That keeps the UI reviewable without launching Electron and means
 * every code path the components use is exercised in both environments.
 *
 * The fallback implements the *whole* API, including the destructive actions —
 * as no-ops that return the same result shape. A preview that throws on
 * "Export" would be worse than one that explains it cannot.
 */

import { dayKey, lastNDayKeys } from '../../core/day'
import { generateDemoDay, DemoSampleStream } from '../../core/demo'
import { defaultState } from '../../core/defaults'
import { resolveCategory, classifyProductivity } from '../../core/categorize'
import {
  applySessionEdit,
  claimIdleBlock,
  EditError,
  makeManualSession,
  mergeSessions,
  removeIdleBlock,
  retimeSession,
  splitSession,
} from '../../core/edits'
import { sanitizeGoal } from '../../core/goals'
import type {
  CalendarEvent,
  CategoryRule,
  Goal,
  PersistedState,
  Project,
  Session,
  Settings,
  TrackerStatus,
} from '../../core/types'
import type {
  Bootstrap,
  CalendarResult,
  CaptureHealth,
  DayPayload,
  EditResult,
  ExportResult,
  OpenTimeApi,
  RecategorizeRequest,
  SessionEdit,
} from '../../shared/ipc'

const PREVIEW_CAPTURE: CaptureHealth = {
  adapter: 'demo (browser preview)',
  demo: true,
  notice: 'Browser preview — no OS capture available, showing generated demo activity.',
  remedy: 'unsupported-session',
}

function createBrowserFallback(): OpenTimeApi {
  const state: PersistedState = defaultState()
  const stream = new DemoSampleStream()
  const listeners = new Set<() => void>()
  const statusListeners = new Set<(s: TrackerStatus) => void>()
  const started = Date.now()
  let paused = false

  const key = () => dayKey(Date.now(), state.settings.dayStartHour)
  const demoKeys = lastNDayKeys(14, key())

  for (const k of demoKeys) {
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
      captureAdapter: PREVIEW_CAPTURE.adapter,
      demo: true,
      stretchStart: paused ? null : started,
      pausedUntil: null,
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
            source: 'demo',
            open: true,
          },
    }
  }

  const notify = () => listeners.forEach((fn) => fn())

  const applyEdit = (edit: SessionEdit): EditResult => {
    const k = edit.dayKey
    const sessions = state.sessionsByDay[k] || []
    const find = (id: string) => sessions.find((s) => s.id === id)
    try {
      switch (edit.kind) {
        case 'split': {
          const target = find(edit.sessionId)
          if (!target) return { ok: false, message: 'That session is no longer there.' }
          const [a, b] = splitSession(target, edit.at)
          state.sessionsByDay[k] = applySessionEdit(sessions, { remove: [target.id], add: [a, b] })
          break
        }
        case 'merge': {
          const targets = edit.sessionIds.map(find).filter((s): s is Session => !!s)
          if (targets.length < 2) return { ok: false, message: 'Select at least two sessions to merge.' }
          state.sessionsByDay[k] = applySessionEdit(sessions, {
            remove: targets.map((s) => s.id),
            add: [mergeSessions(targets)],
          })
          break
        }
        case 'delete':
          state.sessionsByDay[k] = applySessionEdit(sessions, { remove: [edit.sessionId] })
          break
        case 'retime': {
          const target = find(edit.sessionId)
          if (!target) return { ok: false, message: 'That session is no longer there.' }
          state.sessionsByDay[k] = applySessionEdit(sessions, {
            remove: [target.id],
            add: [retimeSession(target, edit.startTime, edit.endTime)],
          })
          break
        }
        case 'manual':
          state.sessionsByDay[k] = applySessionEdit(sessions, { add: [makeManualSession(edit)] })
          break
        case 'claim-idle': {
          const idle = state.idleByDay[k] || []
          const block = idle.find((b) => b.startTime === edit.idleStart)
          if (!block) return { ok: false, message: 'That away block is no longer there.' }
          state.sessionsByDay[k] = applySessionEdit(sessions, { add: [claimIdleBlock(block, edit)] })
          state.idleByDay[k] = removeIdleBlock(idle, edit.idleStart)
          break
        }
      }
    } catch (err) {
      if (err instanceof EditError) return { ok: false, message: err.message }
      throw err
    }
    notify()
    return { ok: true, day: payload(k) }
  }

  const desktopOnly = (what: string): ExportResult => ({
    ok: false,
    message: `${what} is only available in the OpenTime desktop app.`,
  })

  return {
    async getBootstrap(): Promise<Bootstrap> {
      const k = key()
      return {
        settings: state.settings,
        projects: state.projects,
        rules: state.rules,
        goals: state.goals,
        status: status(),
        today: payload(k),
        weekKeys: lastNDayKeys(7, k),
        historyKeys: Object.keys(state.sessionsByDay).sort(),
        appVersion: '0.2.0',
        platform: 'browser',
        dataDirectory: '(in-memory preview)',
        capture: PREVIEW_CAPTURE,
        captureNotice: PREVIEW_CAPTURE.notice,
        firstRun: false,
        demoDays: demoKeys,
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
    async saveGoals(goals: Goal[]) {
      state.goals = (goals || []).map((g, i) => sanitizeGoal(g, `g_${i}`))
      notify()
      return state.goals
    },
    async recategorize(req: RecategorizeRequest) {
      const list = state.sessionsByDay[req.dayKey] || []
      const index = list.findIndex((s) => s.id === req.sessionId)
      if (index >= 0) {
        list[index] = {
          ...list[index],
          category: req.category,
          productivity: req.productivity || list[index].productivity,
          note: req.note || list[index].note,
          edited: true,
        }
      }
      notify()
      return payload(req.dayKey)
    },
    async editSession(edit) {
      return applyEdit(edit)
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
    async exportData() {
      return desktopOnly('Exporting')
    },
    async importBackup() {
      return desktopOnly('Restoring a backup')
    },
    async revealDataFolder() {
      /* nothing to reveal in a browser preview */
    },
    async clearDemoData() {
      return desktopOnly('Clearing demo data')
    },
    async reloadCapture() {
      return PREVIEW_CAPTURE
    },
    async completeOnboarding() {
      return state.settings
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
