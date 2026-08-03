/**
 * Active-window capture.
 *
 * One narrow interface with two implementations:
 *  - `NativeCapture` reads the OS focused window through `@miniben90/x-win`
 *    (native napi module; Windows and macOS are the priority targets, X11 works,
 *    Wayland does not expose the focused window at all);
 *  - `DemoCapture` synthesises a plausible activity stream so the app is fully
 *    usable — and screenshottable — anywhere the native path can't run.
 *
 * `createCapture` probes the native module once at boot and falls back rather
 * than failing to start. The probe is lazy and wrapped, so a native ABI mismatch
 * degrades the app instead of crashing it (a lesson carried over from the older
 * Norte tracker, which lazy-loaded x-win for exactly this reason).
 */

import { spawnSync } from 'node:child_process'

import { BROWSER_RE, urlHost } from '../../core/categorize'
import { DemoSampleStream } from '../../core/demo'
import type { WindowSample } from '../../core/types'

export interface Capture {
  /** Stable identifier shown in Settings, e.g. "x-win (native)". */
  readonly name: string
  /** True when the samples are synthesised rather than read from the OS. */
  readonly demo: boolean
  /** The focused window right now, or null when there isn't one. */
  sample(now: number): WindowSample | null
  dispose(): void
}

export class NativeCapture implements Capture {
  readonly name = 'x-win (native)'
  readonly demo = false
  private xwin: XWinModule
  private selfExecPath: string

  constructor(xwin: XWinModule, selfExecPath: string) {
    this.xwin = xwin
    this.selfExecPath = selfExecPath.toLowerCase()
  }

  sample(): WindowSample | null {
    const win = this.xwin.activeWindow()
    // An empty object means no focused window — locked screen, or no GUI
    // context. Treat it as "nothing to record", not as an error.
    if (!win || !win.title) return null

    const app = win.info?.name || ''
    const execPath = win.info?.path || ''

    // Never track OpenTime itself; the app doing the tracking is not work.
    if (execPath && execPath.toLowerCase() === this.selfExecPath) return null

    let url = ''
    if (BROWSER_RE.test(app)) {
      // Reading a URL forces the browser accessibility tree on, so it is
      // browsers only — and some windows still refuse UIA.
      try {
        url = urlHost(win.url)
      } catch {
        url = ''
      }
    }
    return { app, title: win.title || '', url, execPath }
  }

  dispose(): void {}
}

export class DemoCapture implements Capture {
  readonly name = 'demo (synthesised)'
  readonly demo = true
  private stream = new DemoSampleStream()

  sample(now: number): WindowSample | null {
    return this.stream.next(now)
  }

  dispose(): void {}
}

interface XWinModule {
  activeWindow(): {
    title?: string
    url?: string
    info?: { name?: string; path?: string }
  } | null
}

/** Probe result, surfaced in Settings so the state is never a mystery. */
export interface CaptureProbe {
  capture: Capture
  /** Why the demo adapter was chosen, when it was. */
  reason?: string
  /**
   * Whether the fallback is something the user can fix (grant a permission,
   * switch desktop session) or simply what this machine is. Onboarding shows a
   * "Fix this" step for the first and an explanation for the second.
   */
  remedy?: CaptureRemedy
}

export type CaptureRemedy = 'macos-accessibility' | 'unsupported-session' | 'module-missing'

/**
 * Probe the native module in a throwaway child process.
 *
 * This is not paranoia. `x-win` is a Rust addon, and on a session it cannot
 * read (Wayland, a headless container, WSL without an X server) it does not
 * throw — it *panics*, which aborts the host process. A panic unwinding through
 * napi is not catchable by `try/catch`, so probing in-process would mean the
 * app dies at boot on those systems instead of falling back.
 *
 * One `spawnSync` at startup, and only when native capture is on the table.
 */
function probeNativeOutOfProcess(): { ok: boolean; error?: string; remedy?: CaptureRemedy } {
  const script = `
    try {
      const xwin = require(${JSON.stringify('@miniben90/x-win')})
      xwin.activeWindow()
      process.exit(0)
    } catch (err) {
      process.stderr.write(String(err && err.message ? err.message : err))
      process.exit(1)
    }
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    // Run Electron's binary as a plain node process for the probe.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: process.cwd(),
    timeout: 10_000,
    encoding: 'utf8',
  })

  if (result.status === 0) return { ok: true }
  if (result.signal) {
    return {
      ok: false,
      error: `native capture crashed the probe (${result.signal})`,
      remedy: 'unsupported-session',
    }
  }
  const stderr = (result.stderr || '').trim()
  if (/cannot find module|MODULE_NOT_FOUND/i.test(stderr)) {
    return {
      ok: false,
      error:
        'the native window-capture module is not installed for this platform — reinstall dependencies, or install the app package built for this OS',
      remedy: 'module-missing',
    }
  }
  if (/panicked|Wayland|org\.gnome\.Shell/i.test(stderr)) {
    return {
      ok: false,
      error:
        'this desktop session does not expose the focused window (Wayland and some remote/headless sessions do not)',
      remedy: 'unsupported-session',
    }
  }
  return {
    ok: false,
    error: stderr.split('\n')[0] || 'native capture is unavailable here',
    remedy: 'unsupported-session',
  }
}

/**
 * macOS gates window *titles* behind Accessibility. Without it, `x-win` still
 * loads and still returns an app name, so the probe passes while every title
 * comes back empty — the app looks like it is working and quietly records
 * nothing useful. Callers pass `isTrusted` from `systemPreferences`, which is
 * the only reliable way to tell the difference.
 */
export function macAccessibilityNotice(isTrusted: boolean): string | undefined {
  if (isTrusted) return undefined
  return (
    'macOS has not granted OpenTime Accessibility access, so window titles are hidden. ' +
    'Open System Settings → Privacy & Security → Accessibility and enable OpenTime, ' +
    'then reload capture.'
  )
}

export function createCapture(
  mode: 'auto' | 'native' | 'demo',
  selfExecPath: string,
  opts: { macAccessibilityTrusted?: boolean } = {}
): CaptureProbe {
  if (mode === 'demo') return { capture: new DemoCapture(), reason: 'demo mode selected in Settings' }

  const probe = probeNativeOutOfProcess()
  if (probe.ok) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@miniben90/x-win') as XWinModule
      const capture = new NativeCapture(mod, selfExecPath)
      // Native capture works, but on macOS it may be capturing app names only.
      // That is a degraded state worth naming rather than a fallback.
      if (process.platform === 'darwin' && opts.macAccessibilityTrusted === false) {
        return {
          capture,
          reason: macAccessibilityNotice(false),
          remedy: 'macos-accessibility',
        }
      }
      return { capture }
    } catch (err) {
      return {
        capture: new DemoCapture(),
        reason: `native capture unavailable: ${(err as Error).message}`,
        remedy: 'module-missing',
      }
    }
  }

  if (mode === 'native') {
    // The user asked for native explicitly; still don't crash, but be loud.
    console.error('[capture]', probe.error)
  }
  return { capture: new DemoCapture(), reason: probe.error, remedy: probe.remedy }
}
