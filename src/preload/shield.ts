/**
 * The focus shield's preload. Exposes exactly two things: the current view,
 * and the two buttons. Nothing else from the app crosses into this window.
 */

import { contextBridge, ipcRenderer } from 'electron'

import { SHIELD_CHANNELS, type ShieldAction, type ShieldView } from '../shared/ipc'

contextBridge.exposeInMainWorld('shield', {
  getView: (): Promise<ShieldView | null> => ipcRenderer.invoke(SHIELD_CHANNELS.getView),
  onView: (handler: (view: ShieldView) => void) => {
    ipcRenderer.on(SHIELD_CHANNELS.view, (_e, view: ShieldView) => handler(view))
  },
  act: (action: ShieldAction) => ipcRenderer.send(SHIELD_CHANNELS.action, action),
})
