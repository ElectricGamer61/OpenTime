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
import type { CalendarEvent, CategoryRule, Project, Settings, TrackerStatus } from '../../core/types'
import type { Bootstrap, CalendarResult, DayPayload, RecategorizeRequest } from '../../shared/ipc'
import { client } from './client'

export interface OpenTimeState {
  ready: boolean
  settings: Settings | null
  projects: Project[]
  rules: CategoryRule[]
  status: TrackerStatus | null
  selectedDay: string
  day: DayPayload | null
  week: DayPayload[]
  weekKeys: string[]
  appVersion: string
  platform: string
  captureNotice?: string
  selectDay(key: string): void
  refresh(): Promise<void>
  setTracking(action: 'start' | 'pause' | 'resume' | 'stop'): Promise<void>
  saveSettings(settings: Settings): Promise<void>
  saveProjects(projects: Project[]): Promise<void>
  saveRules(rules: CategoryRule[]): Promise<void>
  recategorize(request: RecategorizeRequest): Promise<void>
  addManualEvent(event: Omit<CalendarEvent, 'id' | 'source'>): Promise<void>
  connectCalendar(): Promise<CalendarResult>
  disconnectCalendar(): Promise<CalendarResult>
  syncCalendar(): Promise<CalendarResult>
}

export function useOpenTime(): OpenTimeState {
  const api = client()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [status, setStatus] = useState<TrackerStatus | null>(null)
  const [selectedDay, setSelectedDay] = useState<string>(() => dayKey())
  const [day, setDay] = useState<DayPayload | null>(null)
  const [week, setWeek] = useState<DayPayload[]>([])
  const [weekKeys, setWeekKeys] = useState<string[]>([])
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

  const refresh = useCallback(async () => {
    if (!weekKeys.length) return
    await loadDays(selectedRef.current, weekKeys)
  }, [loadDays, weekKeys])

  const setTracking = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'stop') => {
      setStatus(await api.setTracking(action))
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

  const recategorize = useCallback(
    async (request: RecategorizeRequest) => {
      setDay(await api.recategorize(request))
      if (weekKeys.length) setWeek(await api.getRange(weekKeys))
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

  return useMemo(
    () => ({
      ready: !!boot && !!day,
      settings: boot?.settings ?? null,
      projects: boot?.projects ?? [],
      rules: boot?.rules ?? [],
      status,
      selectedDay,
      day,
      week,
      weekKeys,
      appVersion: boot?.appVersion ?? '',
      platform: boot?.platform ?? '',
      captureNotice: boot?.captureNotice,
      selectDay,
      refresh,
      setTracking,
      saveSettings,
      saveProjects,
      saveRules,
      recategorize,
      addManualEvent,
      connectCalendar,
      disconnectCalendar,
      syncCalendar,
    }),
    [
      boot,
      day,
      week,
      weekKeys,
      status,
      selectedDay,
      selectDay,
      refresh,
      setTracking,
      saveSettings,
      saveProjects,
      saveRules,
      recategorize,
      addManualEvent,
      connectCalendar,
      disconnectCalendar,
      syncCalendar,
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
