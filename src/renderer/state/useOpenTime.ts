/**
 * The renderer's single data hook.
 *
 * Deliberately one hook, one fetch path: the app holds the current day, the
 * trailing week, and the tracker status, and nothing else. Every number on
 * screen is derived from those three by memoised selectors, so a status tick
 * never re-fetches and a re-render never re-aggregates unless the underlying
 * arrays actually changed identity.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { dayKey, lastNDayKeys } from '../../core/day'
import type {
  CalendarEvent,
  CategoryRule,
  Goal,
  Project,
  Settings,
  TrackerStatus,
} from '../../core/types'
import type { FocusStartInput } from '../../core/focus'
import type {
  Bootstrap,
  CalendarResult,
  CaptureHealth,
  DayPayload,
  EditResult,
  ExportRequest,
  ExportResult,
  FeedbackKind,
  FocusEndResult,
  FocusStartResult,
  RecategorizeRequest,
  SessionEdit,
  UpdateState,
} from '../../shared/ipc'
import { client } from './client'

export interface OpenTimeState {
  ready: boolean
  settings: Settings | null
  projects: Project[]
  rules: CategoryRule[]
  goals: Goal[]
  status: TrackerStatus | null
  selectedDay: string
  day: DayPayload | null
  week: DayPayload[]
  weekKeys: string[]
  historyKeys: string[]
  appVersion: string
  platform: string
  dataDirectory: string
  capture: CaptureHealth | null
  captureNotice?: string
  firstRun: boolean
  demoDays: string[]
  update: UpdateState
  selectDay(key: string): void
  /** Read arbitrary day keys, for the reporting ranges the hook does not hold. */
  loadRange(keys: string[]): Promise<DayPayload[]>
  refresh(): Promise<void>
  reload(): Promise<void>
  setTracking(action: 'start' | 'pause' | 'resume' | 'stop', minutes?: number): Promise<void>
  saveSettings(settings: Settings): Promise<void>
  saveProjects(projects: Project[]): Promise<void>
  saveRules(rules: CategoryRule[]): Promise<void>
  saveGoals(goals: Goal[]): Promise<void>
  recategorize(request: RecategorizeRequest): Promise<void>
  editSession(edit: SessionEdit): Promise<EditResult>
  addManualEvent(event: Omit<CalendarEvent, 'id' | 'source'>): Promise<void>
  connectCalendar(): Promise<CalendarResult>
  disconnectCalendar(): Promise<CalendarResult>
  syncCalendar(): Promise<CalendarResult>
  exportData(request: ExportRequest): Promise<ExportResult>
  importBackup(): Promise<ExportResult>
  revealDataFolder(): Promise<void>
  clearDemoData(): Promise<ExportResult>
  reloadCapture(): Promise<CaptureHealth>
  completeOnboarding(settings: Settings): Promise<void>
  checkForUpdates(): Promise<UpdateState>
  installUpdate(): Promise<UpdateState>
  openFeedback(kind: FeedbackKind): Promise<void>
  startFocus(input: FocusStartInput): Promise<FocusStartResult>
  endFocus(): Promise<FocusEndResult>
  extendFocus(minutes: number): Promise<FocusStartResult>
}

export function useOpenTime(): OpenTimeState {
  const api = client()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [status, setStatus] = useState<TrackerStatus | null>(null)
  const [selectedDay, setSelectedDay] = useState<string>(() => dayKey())
  const [day, setDay] = useState<DayPayload | null>(null)
  const [week, setWeek] = useState<DayPayload[]>([])
  const [weekKeys, setWeekKeys] = useState<string[]>([])
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' })
  const selectedRef = useRef(selectedDay)
  selectedRef.current = selectedDay

  const loadDays = useCallback(
    async (key: string, keys: string[]) => {
      const [dayPayload, weekPayloads] = await Promise.all([api.getDay(key), api.getRange(keys)])
      setDay(dayPayload)
      setWeek(weekPayloads)
    },
    [api]
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bootstrap = await api.getBootstrap()
      if (cancelled) return
      const key = dayKey(Date.now(), bootstrap.settings.dayStartHour)
      setBoot(bootstrap)
      setStatus(bootstrap.status)
      setUpdate(bootstrap.update)
      setSelectedDay(key)
      setWeekKeys(bootstrap.weekKeys)
      setDay(bootstrap.today)
      setWeek(await api.getRange(bootstrap.weekKeys))
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  // Status arrives as a push from the main process; it carries no session data,
  // so it never invalidates the aggregates.
  useEffect(() => api.onStatus(setStatus), [api])
  useEffect(() => api.onUpdate(setUpdate), [api])

  // Data changes are a signal, not a payload — refetch the two things on screen.
  useEffect(
    () =>
      api.onDataChanged(() => {
        if (weekKeys.length) void loadDays(selectedRef.current, weekKeys)
      }),
    [api, loadDays, weekKeys]
  )

  const selectDay = useCallback(
    (key: string) => {
      setSelectedDay(key)
      void api.getDay(key).then(setDay)
    },
    [api]
  )

  const loadRange = useCallback((keys: string[]) => api.getRange(keys), [api])

  const refresh = useCallback(async () => {
    if (!weekKeys.length) return
    await loadDays(selectedRef.current, weekKeys)
  }, [loadDays, weekKeys])

  /** Re-read everything, for actions that can change the whole store. */
  const reload = useCallback(async () => {
    const bootstrap = await api.getBootstrap()
    setBoot(bootstrap)
    setStatus(bootstrap.status)
    const key = dayKey(Date.now(), bootstrap.settings.dayStartHour)
    setSelectedDay(key)
    setWeekKeys(bootstrap.weekKeys)
    setDay(bootstrap.today)
    setWeek(await api.getRange(bootstrap.weekKeys))
  }, [api])

  const setTracking = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'stop', minutes?: number) => {
      setStatus(await api.setTracking(action, minutes))
    },
    [api]
  )

  const saveSettings = useCallback(
    async (next: Settings) => {
      const saved = await api.saveSettings(next)
      setBoot((prev) => (prev ? { ...prev, settings: saved } : prev))
      const key = dayKey(Date.now(), saved.dayStartHour)
      const keys = lastNDayKeys(7, key)
      setWeekKeys(keys)
      setSelectedDay(key)
      await loadDays(key, keys)
    },
    [api, loadDays]
  )

  const saveProjects = useCallback(
    async (next: Project[]) => {
      const saved = await api.saveProjects(next)
      setBoot((prev) => (prev ? { ...prev, projects: saved } : prev))
    },
    [api]
  )

  const saveRules = useCallback(
    async (next: CategoryRule[]) => {
      const saved = await api.saveRules(next)
      setBoot((prev) => (prev ? { ...prev, rules: saved } : prev))
    },
    [api]
  )

  const saveGoals = useCallback(
    async (next: Goal[]) => {
      const saved = await api.saveGoals(next)
      setBoot((prev) => (prev ? { ...prev, goals: saved } : prev))
    },
    [api]
  )

  const recategorize = useCallback(
    async (request: RecategorizeRequest) => {
      setDay(await api.recategorize(request))
      if (weekKeys.length) setWeek(await api.getRange(weekKeys))
    },
    [api, weekKeys]
  )

  const editSession = useCallback(
    async (edit: SessionEdit) => {
      const result = await api.editSession(edit)
      if (result.ok && result.day) {
        setDay(result.day)
        if (weekKeys.length) setWeek(await api.getRange(weekKeys))
      }
      return result
    },
    [api, weekKeys]
  )

  const addManualEvent = useCallback(
    async (event: Omit<CalendarEvent, 'id' | 'source'>) => {
      const updated = await api.addManualEvent(event)
      if (updated.dayKey === selectedRef.current) setDay(updated)
    },
    [api]
  )

  const connectCalendar = useCallback(async () => {
    const result = await api.connectCalendar()
    if (result.ok) await refresh()
    return result
  }, [api, refresh])

  const disconnectCalendar = useCallback(async () => {
    const result = await api.disconnectCalendar()
    setBoot(await api.getBootstrap())
    return result
  }, [api])

  const syncCalendar = useCallback(async () => {
    const result = await api.syncCalendar()
    if (result.ok) await refresh()
    return result
  }, [api, refresh])

  const exportData = useCallback((request: ExportRequest) => api.exportData(request), [api])

  const importBackup = useCallback(async () => {
    const result = await api.importBackup()
    if (result.ok) await reload()
    return result
  }, [api, reload])

  const revealDataFolder = useCallback(() => api.revealDataFolder(), [api])

  const clearDemoData = useCallback(async () => {
    const result = await api.clearDemoData()
    if (result.ok) await reload()
    return result
  }, [api, reload])

  const reloadCapture = useCallback(async () => {
    const health = await api.reloadCapture()
    await reload()
    return health
  }, [api, reload])

  const startFocus = useCallback(
    async (input: FocusStartInput) => {
      const result = await api.startFocus(input)
      setStatus(result.status)
      return result
    },
    [api]
  )

  /**
   * Ending a session writes to the day it ran in, which is not necessarily the
   * day on screen — refresh rather than trusting the result's payload.
   */
  const endFocus = useCallback(async () => {
    const result = await api.endFocus()
    setStatus(result.status)
    if (result.ok) await refresh()
    return result
  }, [api, refresh])

  const extendFocus = useCallback(
    async (minutes: number) => {
      const result = await api.extendFocus(minutes)
      setStatus(result.status)
      return result
    },
    [api]
  )

  const completeOnboarding = useCallback(
    async (settings: Settings) => {
      const saved = await api.completeOnboarding(settings)
      setBoot((prev) => (prev ? { ...prev, settings: saved, firstRun: false } : prev))
    },
    [api]
  )

  const checkForUpdates = useCallback(async () => {
    const next = await api.checkForUpdates()
    setUpdate(next)
    return next
  }, [api])

  const installUpdate = useCallback(async () => {
    const next = await api.installUpdate()
    setUpdate(next)
    return next
  }, [api])

  const openFeedback = useCallback((kind: FeedbackKind) => api.openFeedback(kind), [api])

  return useMemo(
    () => ({
      ready: !!boot && !!day,
      settings: boot?.settings ?? null,
      projects: boot?.projects ?? [],
      rules: boot?.rules ?? [],
      goals: boot?.goals ?? [],
      status,
      selectedDay,
      day,
      week,
      weekKeys,
      historyKeys: boot?.historyKeys ?? [],
      appVersion: boot?.appVersion ?? '',
      platform: boot?.platform ?? '',
      dataDirectory: boot?.dataDirectory ?? '',
      capture: boot?.capture ?? null,
      captureNotice: boot?.captureNotice,
      firstRun: boot?.firstRun ?? false,
      demoDays: boot?.demoDays ?? [],
      update,
      selectDay,
      loadRange,
      refresh,
      reload,
      setTracking,
      saveSettings,
      saveProjects,
      saveRules,
      saveGoals,
      recategorize,
      editSession,
      addManualEvent,
      connectCalendar,
      disconnectCalendar,
      syncCalendar,
      exportData,
      importBackup,
      revealDataFolder,
      clearDemoData,
      reloadCapture,
      completeOnboarding,
      checkForUpdates,
      installUpdate,
      openFeedback,
      startFocus,
      endFocus,
      extendFocus,
    }),
    [
      boot,
      day,
      week,
      weekKeys,
      status,
      selectedDay,
      selectDay,
      loadRange,
      refresh,
      reload,
      setTracking,
      saveSettings,
      saveProjects,
      saveRules,
      saveGoals,
      recategorize,
      editSession,
      addManualEvent,
      connectCalendar,
      disconnectCalendar,
      syncCalendar,
      exportData,
      importBackup,
      revealDataFolder,
      clearDemoData,
      reloadCapture,
      completeOnboarding,
      checkForUpdates,
      installUpdate,
      openFeedback,
      update,
      startFocus,
      endFocus,
      extendFocus,
    ]
  )
}

/**
 * A ticking clock, isolated so only the components that display live seconds
 * re-render each second — the dashboard aggregates never do.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
