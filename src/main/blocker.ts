/**
 * Distraction blocking: the part that touches windows.
 *
 * The decisions live in `src/core/blocking.ts`; this owns the timer and the
 * shield window. It only runs while a focus session is live and blocking is
 * switched on - outside that there is no timer at all, so the feature costs
 * nothing for anyone who does not use it.
 *
 * The shield is a frameless, always-on-top window over the work area of the
 * display the pointer is on. It is deliberately *not focusable*: the blocked
 * window stays in front underneath it, so Ctrl+W or Alt+Tab still work, and
 * the next tick sees something unblocked in front and lowers the shield. The
 * taskbar stays uncovered for the same reason - there is always a way out.
 */

import path from 'node:path'

import { BrowserWindow, ipcMain, screen } from 'electron'

import {
  blockLabel,
  nextShield,
  SHIELD_IDLE,
  snoozeShield,
  type ShieldState,
} from '../core/blocking'
import type { ActiveFocus, Settings, WindowSample } from '../core/types'
import { SHIELD_CHANNELS, type ShieldAction, type ShieldView } from '../shared/ipc'
import type { Capture } from './capture'

/** Fast enough that a blocked tab is covered almost at once; one cheap OS call. */
const TICK_MS = 1000

export interface BlockerDeps {
  capture(): Capture
  settings(): Settings
  focus(): ActiveFocus | null
  /** True when OpenTime's own main window is the one in front. */
  mainWindowFocused(): boolean
  /** Ends the running focus session, exactly as the app's own button does. */
  endFocus(): Promise<unknown>
}

export class Blocker {
  private state: ShieldState = SHIELD_IDLE
  private timer: NodeJS.Timeout | null = null
  private shield: BrowserWindow | null = null
  private lastSample: WindowSample | null = null
  private view: ShieldView | null = null

  constructor(private deps: BlockerDeps) {
    ipcMain.on(SHIELD_CHANNELS.action, (_e, action: ShieldAction) => void this.act(action))
    ipcMain.handle(SHIELD_CHANNELS.getView, () => this.view)
  }

  private get active(): boolean {
    const { blocking } = this.deps.settings()
    return !!this.deps.focus() && blocking.enabled && blocking.targets.length > 0
  }

  /**
   * Start or stop the loop to match reality. Call after a focus session starts
   * or ends and after settings are saved; everything else is the tick's job.
   */
  sync(): void {
    if (this.active && !this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS)
      this.tick()
    } else if (!this.active) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.apply(SHIELD_IDLE)
    }
  }

  /** One decision. Exposed so the e2e suite can drive it without waiting. */
  tick(): void {
    const now = Date.now()
    let sample: WindowSample | null
    try {
      // OpenTime's own window counts as "unblocked": opening the app to end
      // the session must never leave the shield parked over it.
      sample = this.deps.mainWindowFocused()
        ? { app: 'OpenTime', title: 'OpenTime' }
        : this.deps.capture().sample(now)
    } catch {
      sample = null
    }
    if (sample) this.lastSample = sample
    this.apply(
      nextShield(this.state, {
        active: this.active,
        sample,
        targets: this.deps.settings().blocking.targets,
        now,
      })
    )
  }

  /** What the shield is showing, for tests and diagnostics. */
  get shielded(): string | null {
    return this.state.target
  }

  private async act(action: ShieldAction): Promise<void> {
    if (action === 'snooze') {
      this.apply(snoozeShield(this.state, Date.now()))
    } else if (action === 'end') {
      this.apply({ ...this.state, target: null })
      await this.deps.endFocus()
      this.sync()
    }
  }

  private apply(next: ShieldState): void {
    const changed = next.target !== this.state.target
    this.state = next
    if (!changed) {
      // Same distraction, possibly dragged to another monitor: follow it.
      if (next.target && this.shield && !this.shield.isDestroyed() && this.shield.isVisible()) {
        const area = this.displayFor(this.lastSample).workArea
        const at = this.shield.getBounds()
        if (at.x !== area.x || at.y !== area.y || at.width !== area.width || at.height !== area.height) {
          this.shield.setBounds(area)
        }
      }
      return
    }
    if (next.target) this.raise(next.target)
    else this.lower()
  }

  private raise(target: string): void {
    const focus = this.deps.focus()
    this.view = {
      label: blockLabel(target, this.lastSample),
      target,
      focusLabel: focus?.label ?? '',
      endsAt: focus ? focus.startTime + focus.plannedSeconds * 1000 : null,
    }

    if (!this.shield || this.shield.isDestroyed()) this.shield = this.createShield()
    this.shield.setBounds(this.displayFor(this.lastSample).workArea)
    this.shield.webContents.send(SHIELD_CHANNELS.view, this.view)
    this.shield.showInactive()
    this.shield.setAlwaysOnTop(true, 'screen-saver')
  }

  /**
   * The display the blocked window is on, so a second monitor with real work
   * on it is never the one covered. Falls back to the pointer's display when
   * the platform does not say where the window is.
   */
  private displayFor(sample: WindowSample | null): Electron.Display {
    const b = sample?.bounds
    if (!b) return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const centre = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    // x-win reports physical pixels; Electron's displays are in DIPs, and on
    // Windows with mixed scaling the two differ per monitor.
    const point = process.platform === 'win32' ? screen.screenToDipPoint(centre) : centre
    return screen.getDisplayNearestPoint(point)
  }

  private lower(): void {
    this.view = null
    if (this.shield && !this.shield.isDestroyed()) this.shield.hide()
  }

  private createShield(): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // The whole point: never steal focus from the window underneath.
      focusable: false,
      hasShadow: false,
      title: 'OpenTime focus shield',
      webPreferences: {
        preload: path.join(__dirname, '../preload/shield.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.setVisibleOnAllWorkspaces(true)
    void win.loadFile(path.join(__dirname, '../shield/shield.html'))
    win.on('closed', () => {
      if (this.shield === win) this.shield = null
    })
    return win
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.shield && !this.shield.isDestroyed()) this.shield.destroy()
    this.shield = null
  }
}
