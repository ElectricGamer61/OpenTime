/**
 * Updates, from GitHub Releases.
 *
 * Two rules shape this file:
 *
 * - **Nothing phones home unless the person said yes.** The automatic check
 *   runs only with `settings.checkForUpdates` on, which onboarding asks about
 *   and which defaults off for anyone who never answered. "Check now" is always
 *   available, because a click is consent.
 * - **Nothing downloads or restarts on its own.** A found update is announced;
 *   the download starts when "Update now" is clicked, and the restart follows
 *   only once the new installer is fully on disk. The installer replaces the
 *   program files and never touches the data folder, which lives separately in
 *   the user's app-data directory.
 *
 * Only an installed Windows build can update itself. Dev runs, the unpacked
 * zip and macOS (unsigned, so it cannot) report `unsupported` and point at the
 * releases page instead.
 */

import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateState } from '../shared/ipc'

/** Re-check this often while the app stays open. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
/** Let the app settle before the first automatic check. */
const FIRST_CHECK_DELAY_MS = 15_000

export interface UpdaterDeps {
  /** Push the state to the renderer. */
  publish(state: UpdateState): void
  /** Whether the person agreed to automatic checks. */
  autoCheckEnabled(): boolean
  /** Stop tracking and get every write onto disk before the installer runs. */
  prepareToQuit(): Promise<void>
}

/**
 * Whether this build can install an update over itself: an NSIS install on
 * Windows. `OPENTIME_UPDATE_FEED` exists so the whole flow can be exercised
 * locally against a generic feed without publishing a real release.
 */
function supported(): boolean {
  if (process.env.OPENTIME_UPDATE_FEED) return true
  return app.isPackaged && process.platform === 'win32'
}

export class Updater {
  private current: UpdateState
  private timer: NodeJS.Timeout | null = null
  private firstCheck: NodeJS.Timeout | null = null

  constructor(private deps: UpdaterDeps) {
    this.current = supported() ? { state: 'idle' } : { state: 'unsupported' }
    if (!supported()) return

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = null
    const feed = process.env.OPENTIME_UPDATE_FEED
    if (feed) {
      autoUpdater.forceDevUpdateConfig = true
      autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    }

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('download-progress', (p) =>
      this.set({ state: 'downloading', version: this.current.version, percent: Math.round(p.percent) })
    )
    autoUpdater.on('error', (err) =>
      this.set({ state: 'error', version: this.current.version, message: friendly(err) })
    )
  }

  get state(): UpdateState {
    return this.current
  }

  /** Start or stop automatic checks to match the setting. */
  sync(): void {
    if (this.current.state === 'unsupported') return
    const on = this.deps.autoCheckEnabled()
    if (on && !this.timer) {
      this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
      this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
    } else if (!on) {
      if (this.firstCheck) clearTimeout(this.firstCheck)
      if (this.timer) clearInterval(this.timer)
      this.firstCheck = null
      this.timer = null
    }
  }

  async check(): Promise<UpdateState> {
    if (this.current.state === 'unsupported') return this.current
    // Never interrupt a download or an install with a fresh check.
    if (this.current.state === 'downloading' || this.current.state === 'installing') return this.current
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', message: friendly(err) })
    }
    return this.current
  }

  /** Download the announced update, then restart into it. */
  async install(): Promise<UpdateState> {
    if (this.current.state !== 'available' && this.current.state !== 'error') return this.current
    const version = this.current.version
    try {
      this.set({ state: 'downloading', version, percent: 0 })
      await autoUpdater.downloadUpdate()
      this.set({ state: 'installing', version })
      await this.deps.prepareToQuit()
      // Silent install, then relaunch: the person already said "update now".
      autoUpdater.quitAndInstall(true, true)
      // Tracking is already stopped. If the installer never took over, do not
      // leave a running app that silently records nothing: restart as-is.
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 20_000).unref()
    } catch (err) {
      this.set({ state: 'error', version, message: friendly(err) })
    }
    return this.current
  }

  private set(next: UpdateState): void {
    this.current = next
    this.deps.publish(next)
  }

  dispose(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck)
    if (this.timer) clearInterval(this.timer)
  }
}

/** Updater errors are HTTP dumps; people need one sentence. */
function friendly(err: unknown): string {
  const text = String((err as Error)?.message || err || '')
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::/i.test(text)) {
    return 'Could not reach GitHub. Check your internet connection and try again.'
  }
  if (/404|Unable to find latest version|No published versions/i.test(text)) {
    return 'No published release was found on GitHub yet.'
  }
  if (/sha512 checksum mismatch/i.test(text)) {
    return 'The download was damaged, so it was not installed. Try again.'
  }
  return 'The update check failed. You can always download the latest version from GitHub.'
}
