/**
 * Preload bridge.
 *
 * Context isolation stays on and the renderer gets exactly the methods in
 * `OpenTimeApi` — no `ipcRenderer`, no `require`, no node globals.
 */

import { contextBridge, ipcRenderer } from 'electron'

import { CHANNELS } from '../shared/ipc'
import type { OpenTimeApi } from '../shared/ipc'

const api: OpenTimeApi = {
  getBootstrap: () => ipcRenderer.invoke(CHANNELS.getBootstrap),
  getDay: (dayKey) => ipcRenderer.invoke(CHANNELS.getDay, dayKey),
  getRange: (dayKeys) => ipcRenderer.invoke(CHANNELS.getRange, dayKeys),
  getStatus: () => ipcRenderer.invoke(CHANNELS.getStatus),
  setTracking: (action) => ipcRenderer.invoke(CHANNELS.setTracking, action),
  saveSettings: (settings) => ipcRenderer.invoke(CHANNELS.saveSettings, settings),
  saveProjects: (projects) => ipcRenderer.invoke(CHANNELS.saveProjects, projects),
  saveRules: (rules) => ipcRenderer.invoke(CHANNELS.saveRules, rules),
  recategorize: (request) => ipcRenderer.invoke(CHANNELS.recategorize, request),
  addManualEvent: (event) => ipcRenderer.invoke(CHANNELS.addManualEvent, event),
  connectCalendar: () => ipcRenderer.invoke(CHANNELS.connectCalendar),
  disconnectCalendar: () => ipcRenderer.invoke(CHANNELS.disconnectCalendar),
  syncCalendar: () => ipcRenderer.invoke(CHANNELS.syncCalendar),
  onStatus: (handler) => {
    const listener = (_e: unknown, status: Parameters<typeof handler>[0]) => handler(status)
    ipcRenderer.on(CHANNELS.statusEvent, listener)
    return () => ipcRenderer.removeListener(CHANNELS.statusEvent, listener)
  },
  onDataChanged: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(CHANNELS.dataEvent, listener)
    return () => ipcRenderer.removeListener(CHANNELS.dataEvent, listener)
  },
}

contextBridge.exposeInMainWorld('opentime', api)
