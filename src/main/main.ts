/**
 * OpenTime main process.
 *
 * Responsibilities, and nothing else: own the window and tray, own the capture
 * engine, own storage, answer IPC. Everything heavy lives outside this file, and
 * nothing that isn't time tracking lives in this process at all.
 */

import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  shell,
  systemPreferences,
  Tray,
} from 'electron'

import { dayKey, lastNDayKeys, parseYmdLocal, formatYmdLocal } from '../core/day'
import { generateDemoDay, shouldSeedDemo } from '../core/demo'
import { exportFilename, parseBackup } from '../core/export'
import { sanitizeGoal } from '../core/goals'
import { focusOutcome, sealFocus, startFocus, type FocusStartInput } from '../core/focus'
import type {
  ActiveFocus,
  CalendarEvent,
  CategoryRule,
  Goal,
  Project,
  Session,
  Settings,
  TrackerStatus,
} from '../core/types'
import { CHANNELS } from '../shared/ipc'
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
} from '../shared/ipc'
import { feedbackUrl, RELEASES_URL } from '../shared/project'
import { Blocker } from './blocker'
import { createCapture, type Capture } from './capture'
import { trayIcon, windowIconPath } from './icon'
import { applyEdit } from './edits/applyEdit'
import { buildExportPayload, FORMAT_SPEC, resolveRange } from './export/buildExport'
import {
  bucketEvents,
  buildAuthUrl,
  exchangeCode,
  fetchEvents,
  needsRefresh,
  OAUTH_USER_AGENT,
  refreshTokens,
  REDIRECT_URI,
  type TokenSet,
} from './calendar/google'
import { FileStorage } from './storage/FileStorage'
import { Tracker } from './tracker'
import { Updater } from './updater'

const DEV_SERVER_URL = process.env.OPENTIME_DEV_SERVER_URL
/** Passed by the login item: start tracking in the tray without a window. */
const HIDDEN_FLAG = '--hidden'
let windowOpenedBefore = false

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let storage: FileStorage
let tracker: Tracker
let capture: Capture
let captureHealth: CaptureHealth
let tokens: TokenSet | null = null
let blocker: Blocker | null = null
let updater: Updater | null = null
/**
 * The focus session running right now.
 *
 * Deliberately memory-only. A focus session is a label over minutes the tracker
 * is recording anyway, so losing it to a crash loses the label and none of the
 * time — whereas persisting it would mean deciding, at the next boot, how long
 * a session nobody ended is supposed to have run.
 */
let activeFocus: ActiveFocus | null = null

const tokenFile = () => path.join(app.getPath('userData'), 'opentime-google-tokens.json')

// ── Window ───────────────────────────────────────────────────────────────────

/**
 * Windows paints its inset minimize/maximize/close controls itself, as a
 * native overlay on top of the page — `titleBarOverlay` below only sets its
 * *initial* colours. It has to be kept in sync with `--bg`/`--text-dim` in
 * styles.css by hand, in both directions, or the overlay strip stays
 * whichever theme the window happened to be created in: a dark box parked
 * over a light custom title bar (or vice-versa), reading as a broken frame
 * rather than as chrome that matches the app.
 */
const TITLE_BAR_OVERLAY = {
  light: { color: '#eef0f5', symbolColor: '#5b6070', height: 44 },
  dark: { color: '#0d0d0f', symbolColor: '#8a8a92', height: 44 },
}

/** Keep the native Windows title-bar overlay's colours matched to the theme. */
function syncTitleBarOverlay(): void {
  if (process.platform !== 'win32' || !mainWindow) return
  mainWindow.setTitleBarOverlay(
    nativeTheme.shouldUseDarkColors ? TITLE_BAR_OVERLAY.dark : TITLE_BAR_OVERLAY.light
  )
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // Must match `--bg` in the renderer, or the window paints a different dark
    // for the frame or two before the first render lands.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d0f' : '#eef0f5',
    title: 'OpenTime',
    // macOS ignores this in favour of the app bundle's .icns; Windows and
    // Linux use it for the taskbar/Alt-Tab icon.
    icon: windowIconPath(),
    // The renderer draws its own title bar, so the native one is hidden and the
    // platform's window controls are inset into it. Linux is the exception:
    // hiding the frame there removes the controls outright rather than
    // relocating them, and a window you cannot close is not a trade worth
    // making for a strip of chrome.
    titleBarStyle:
      process.platform === 'darwin'
        ? 'hiddenInset'
        : process.platform === 'win32'
          ? 'hidden'
          : 'default',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: nativeTheme.shouldUseDarkColors
            ? TITLE_BAR_OVERLAY.dark
            : TITLE_BAR_OVERLAY.light,
        }
      : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The renderer never needs a background throttle exemption; letting
      // Chromium throttle the hidden window is exactly what we want.
      backgroundThrottling: true,
    },
  })

  // Paint only when there is something to show — no white flash on launch.
  // At sign-in the window stays hidden: tracking runs from the tray, and the
  // tray icon or Ctrl+Alt+O brings the window up.
  // Only the very first window: one reopened later from the tray must show.
  const startHidden = !windowOpenedBefore && process.argv.includes(HIDDEN_FLAG) && !!tray
  windowOpenedBefore = true
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (DEV_SERVER_URL) void mainWindow.loadURL(DEV_SERVER_URL)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function showWindow(): void {
  if (!mainWindow) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

/**
 * The tray menu is the app's real front door — most days it is the only part
 * anyone touches. Timed pauses live here rather than only in the window,
 * because "stop tracking for an hour" is a decision made while doing something
 * else entirely.
 */
function buildTrayMenu(): void {
  if (!tray) return
  const status = tracker.status
  const pauseFor = (minutes: number) => ({
    label: `${minutes} minutes`,
    click: () => {
      tracker.pause(minutes)
      buildTrayMenu()
    },
  })

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OpenTime', click: showWindow },
      { type: 'separator' },
      // Only present while one is running: a permanently-disabled "End focus
      // session" row would be a menu that mostly says no.
      ...(activeFocus
        ? [
            { label: `Focus: ${activeFocus.label}`, enabled: false },
            { label: 'End focus session', click: () => void endFocusSession() },
            { type: 'separator' as const },
          ]
        : []),
      status.paused
        ? { label: 'Resume tracking', click: () => { tracker.resume(); buildTrayMenu() } }
        : {
            label: 'Pause tracking',
            submenu: [
              ...[15, 30, 60].map(pauseFor),
              { type: 'separator' as const },
              {
                label: 'Until I resume',
                click: () => {
                  tracker.pause()
                  buildTrayMenu()
                },
              },
            ],
          },
      { label: `Capture: ${status.captureAdapter}`, enabled: false },
      { type: 'separator' },
      { label: 'Send feedback…', click: () => void openFeedback('question') },
      { label: 'Quit', click: () => app.quit() },
    ])
  )

  const until = status.pausedUntil
    ? ` until ${new Date(status.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ''
  tray.setToolTip(status.paused ? `OpenTime — paused${until}` : 'OpenTime — tracking')
}

function toggleWindow(): void {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
  } else {
    showWindow()
  }
}

function togglePause(): void {
  if (!tracker) return
  if (tracker.status.paused) tracker.resume()
  else tracker.pause()
  buildTrayMenu()
}

/**
 * A solo-user app is more often driven from the keyboard than the tray. These
 * two cover the only actions worth doing without first bringing the window
 * forward: show/hide it, and pause tracking for something private without
 * hunting for the tray icon. Registration can fail (another app already holds
 * the combination, or the desktop session does not support global hotkeys at
 * all) — same "degrade, do not crash" treatment as the tray itself.
 */
function registerGlobalShortcuts(): void {
  try {
    globalShortcut.register('CommandOrControl+Alt+O', toggleWindow)
    globalShortcut.register('CommandOrControl+Alt+P', togglePause)
  } catch (err) {
    console.error('[main] global shortcuts unavailable:', err)
  }
}

// ── Data helpers ─────────────────────────────────────────────────────────────

async function dayPayload(key: string): Promise<DayPayload> {
  const record = await storage.getDay(key)
  return { dayKey: key, ...record }
}

function todayKey(): string {
  return dayKey(Date.now(), storage.getSettings().dayStartHour)
}

/**
 * The tracker's status plus whatever the focus controller is doing.
 *
 * Focus is not the tracker's business — the engine samples identically whether
 * or not a session is running — but the renderer wants both on one push, so it
 * is stitched on here rather than threaded through `Tracker`.
 */
function statusNow(): TrackerStatus {
  return { ...tracker.status, focus: activeFocus }
}

/**
 * Push to the renderer, if there is still a renderer.
 *
 * Three guards, all earned during shutdown: the window can be gone, its
 * `webContents` can be destroyed while the window object is not, and the render
 * *frame* can be disposed a moment before either — which makes `send` throw. The
 * final flush on quit runs through here, and a failed notification must never be
 * the reason a session does not reach disk.
 */
function broadcast(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isDestroyed()) return
  try {
    mainWindow.webContents.send(channel, payload)
  } catch {
    // The renderer went away between the check and the send. Nothing to do.
  }
}

/**
 * First-run seeding, and the one place this app is allowed to invent data.
 *
 * Off by default — see `shouldSeedDemo` — so a fresh install with no capture
 * starts on an honest empty dashboard rather than fabricated history. A user
 * who opts in via `seedDemoWhenUnavailable` gets a backfill instead of a blank
 * slate, and every seeded day is recorded in the store so "Clear demo data"
 * can remove exactly those days and nothing else.
 */
async function seedDemoHistoryIfNeeded(): Promise<void> {
  const settings = storage.getSettings()
  if (
    !shouldSeedDemo({
      captureIsDemo: captureHealth.demo,
      seedDemoWhenUnavailable: settings.seedDemoWhenUnavailable,
      storeIsEmpty: storage.isEmpty(),
    })
  ) {
    return
  }

  const projects = storage.getProjects()
  const rules = storage.getRules()
  const keys = lastNDayKeys(14, todayKey())
  for (const key of keys) {
    const day = generateDemoDay(key, {
      dayStartHour: settings.dayStartHour,
      sessionGapSeconds: settings.sessionGapSeconds,
      projects,
      rules,
    })
    await storage.appendSessions(day.sessions)
    for (const block of day.idle) await storage.appendIdle(key, block)
    if (day.events.length) await storage.putEvents(key, day.events)
  }
  await storage.markDemoDays(keys)
  await storage.flush()
}

/**
 * Apply the retention policy.
 *
 * Off by default. When on, days older than the window are deleted outright —
 * a retention setting that only hides data is a lie about what is on disk.
 */
async function applyRetention(): Promise<number> {
  const days = storage.getSettings().retentionDays
  if (!days) return 0
  const cutoff = parseYmdLocal(todayKey())
  cutoff.setDate(cutoff.getDate() - days)
  const removed = await storage.prune(formatYmdLocal(cutoff))
  if (removed.length) console.log(`[storage] retention removed ${removed.length} day(s)`)
  return removed.length
}

function macAccessibilityTrusted(): boolean | undefined {
  if (process.platform !== 'darwin') return undefined
  try {
    // `false` means "check, don't prompt" — the prompt belongs to onboarding,
    // not to every boot.
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return undefined
  }
}

/**
 * (Re)build the capture adapter and publish its health.
 *
 * Exposed as an action because the two things that fix a fallback — granting
 * macOS Accessibility, installing the native module — happen while the app is
 * already running, and making someone restart to pick that up is a bad first
 * five minutes.
 */
function initCapture(): CaptureHealth {
  const settings = storage.getSettings()
  const trusted = macAccessibilityTrusted()
  const probe = createCapture(settings.captureMode, process.execPath, {
    macAccessibilityTrusted: trusted,
  })
  capture?.dispose?.()
  capture = probe.capture
  captureHealth = {
    adapter: probe.capture.name,
    demo: probe.capture.demo,
    notice: probe.reason,
    remedy: probe.remedy,
    accessibilityTrusted: trusted,
  }
  return captureHealth
}

// ── Calendar ─────────────────────────────────────────────────────────────────

async function loadTokens(): Promise<void> {
  try {
    tokens = JSON.parse(await fs.readFile(tokenFile(), 'utf8')) as TokenSet
  } catch {
    tokens = null
  }
}

async function saveTokens(next: TokenSet | null): Promise<void> {
  tokens = next
  if (!next) {
    await fs.rm(tokenFile(), { force: true }).catch(() => {})
    return
  }
  await fs.writeFile(tokenFile(), JSON.stringify(next), 'utf8')
}

/**
 * Run the installed-app OAuth flow.
 *
 * Two details that are easy to get wrong and were already solved once in the
 * predecessor app: the auth page must be loaded in a window presenting a normal
 * Chrome user agent (Google rejects Electron's default UA), and the redirect is
 * a loopback listener rather than a hosted callback, so no server is involved.
 */
async function connectCalendar(): Promise<CalendarResult> {
  const settings = storage.getSettings()
  const { clientId, clientSecret } = settings.calendar
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      message:
        'Add your own Google OAuth client ID and secret in Settings first. OpenTime ships no credentials — see the README for the two-minute setup.',
    }
  }

  const state = Math.random().toString(36).slice(2)
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', REDIRECT_URI)
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<h2>OpenTime is connected.</h2><p>You can close this window.</p>')
      server.close()
      const returned = url.searchParams.get('state')
      const got = url.searchParams.get('code')
      if (returned !== state) reject(new Error('OAuth state mismatch'))
      else if (!got) reject(new Error(url.searchParams.get('error') || 'no authorization code'))
      else resolve(got)
    })
    server.listen(47813, '127.0.0.1', () => {
      const authWindow = new BrowserWindow({
        width: 520,
        height: 700,
        title: 'Connect Google Calendar',
        autoHideMenuBar: true,
        icon: windowIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      })
      authWindow.webContents.setUserAgent(OAUTH_USER_AGENT)
      void authWindow.loadURL(buildAuthUrl(settings.calendar, state))
      authWindow.on('closed', () => {
        server.close()
        reject(new Error('authorization window closed'))
      })
    })
    server.on('error', reject)
  }).catch((err: Error) => {
    throw err
  })

  const next = await exchangeCode(settings.calendar, code)
  await saveTokens(next)
  await storage.saveSettings({
    ...settings,
    calendar: { ...settings.calendar, connected: true, lastSyncedAt: Date.now() },
  })
  return syncCalendar()
}

async function ensureAccessToken(): Promise<string | null> {
  if (!tokens) return null
  if (!needsRefresh(tokens)) return tokens.accessToken
  const settings = storage.getSettings()
  try {
    const next = await refreshTokens(settings.calendar, tokens)
    await saveTokens(next)
    return next.accessToken
  } catch (err) {
    // Revoked access: drop the tokens and show the disconnected state rather
    // than retrying a grant that will never succeed again.
    await saveTokens(null)
    await storage.saveSettings({
      ...settings,
      calendar: { ...settings.calendar, connected: false },
    })
    console.error('[calendar] refresh failed:', err)
    return null
  }
}

async function syncCalendar(): Promise<CalendarResult> {
  const settings = storage.getSettings()
  const token = await ensureAccessToken()
  if (!token) return { ok: false, message: 'Google Calendar is not connected.' }
  try {
    const keys = lastNDayKeys(7, todayKey())
    const start = new Date()
    start.setDate(start.getDate() - 7)
    const end = new Date()
    end.setDate(end.getDate() + 2)
    const events = await fetchEvents(token, start.getTime(), end.getTime())
    const buckets = bucketEvents(events, settings.dayStartHour)
    for (const key of keys) {
      // Manual entries are the user's own record and must survive a sync that
      // replaces everything Google knows about the day.
      const manual = (await storage.getEvents(key)).filter((e) => e.source === 'manual')
      await storage.putEvents(key, [...manual, ...(buckets[key] || [])].sort((a, b) => a.start - b.start))
    }
    await storage.saveSettings({
      ...settings,
      calendar: { ...settings.calendar, connected: true, lastSyncedAt: Date.now() },
    })
    broadcast(CHANNELS.dataEvent)
    return { ok: true, message: `Synced ${events.length} events.` }
  } catch (err) {
    return { ok: false, message: `Sync failed: ${(err as Error).message}` }
  }
}

// ── Export ───────────────────────────────────────────────────────────────────

async function exportData(request: ExportRequest): Promise<ExportResult> {
  if (!resolveRange(storage, request).length) {
    return { ok: false, message: 'There is no history to export yet.' }
  }

  const now = Date.now()
  const spec = FORMAT_SPEC[request.format]
  const chosen = await dialog.showSaveDialog({
    title: 'Export OpenTime data',
    defaultPath: exportFilename(spec.prefix, spec.ext, now),
    filters: [{ name: spec.filterName, extensions: [spec.ext] }],
  })
  if (chosen.canceled || !chosen.filePath) return { ok: false, message: 'Export cancelled.' }

  const payload = await buildExportPayload(storage, request, {
    exportedAt: now,
    appVersion: app.getVersion(),
  })

  try {
    await fs.writeFile(chosen.filePath, payload.contents, 'utf8')
  } catch (err) {
    return { ok: false, message: `Could not write the file: ${(err as Error).message}` }
  }

  return {
    ok: true,
    message: `Exported ${payload.count} ${payload.unit} to ${path.basename(chosen.filePath)}.`,
    path: chosen.filePath,
    count: payload.count,
  }
}

/**
 * Restore from a backup.
 *
 * Destructive, so it asks first, in a dialog that states plainly what is about
 * to be replaced. Tracking stops for the duration: writing new sessions into a
 * store that is being swapped underneath would be a race with someone's history
 * as the stake.
 */
async function importBackup(): Promise<ExportResult> {
  const chosen = await dialog.showOpenDialog({
    title: 'Restore an OpenTime backup',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (chosen.canceled || !chosen.filePaths.length) return { ok: false, message: 'Restore cancelled.' }

  let backup
  try {
    backup = parseBackup(await fs.readFile(chosen.filePaths[0], 'utf8'))
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }

  const dayCount = Object.keys(backup.days).length
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Replace my data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Restore backup',
    message: `Replace everything with this backup?`,
    detail:
      `The backup holds ${dayCount} day(s) of history, plus its own settings, projects and rules.\n\n` +
      'Your current history will be deleted. Export it first if you want to keep it.',
  })
  if (confirm.response !== 0) return { ok: false, message: 'Restore cancelled.' }

  const wasRunning = tracker.status.running
  tracker.stop()
  // `stop()` starts the final write; draining it before the swap is what stops
  // a session landing in the store a moment after the restore cleared it.
  await tracker.drain()
  await storage.replaceAll(backup.config, backup.days)
  tracker.reconfigure(storage.getSettings(), storage.getProjects(), storage.getRules())
  if (wasRunning) tracker.start()
  broadcast(CHANNELS.dataEvent)
  return { ok: true, message: `Restored ${dayCount} day(s) from the backup.`, count: dayCount }
}

/**
 * End the running focus session and write it into the day it ran in.
 *
 * A plain function rather than only an IPC handler because the tray ends
 * sessions too, and a tray item that reached in through `ipcMain` would be a
 * second, untested path over the same history.
 */
async function endFocusSession(): Promise<FocusEndResult> {
  const focus = activeFocus
  if (!focus) return { ok: false, message: 'No focus session is running.', status: statusNow() }

  // Flush first: the minutes just worked are still inside the tracker's open
  // session, and sealing before they reach the store would claim nothing.
  await tracker.flushOpenSession()

  const key = dayKey(focus.startTime, storage.getSettings().dayStartHour)
  const endTime = Date.now()
  activeFocus = null
  buildTrayMenu()
  blocker?.sync()

  try {
    const sealed = sealFocus(await storage.getSessions(key), focus, endTime)
    await storage.putSessions(key, sealed.sessions)
    const status = statusNow()
    broadcast(CHANNELS.statusEvent, status)
    broadcast(CHANNELS.dataEvent)
    return {
      ok: true,
      status,
      dayKey: key,
      outcome: focusOutcome(sealed.sessions, focus.id) ?? {
        label: focus.label,
        plannedSeconds: focus.plannedSeconds,
        actualSeconds: 0,
        apps: [],
      },
    }
  } catch (err) {
    console.error('[main] sealing the focus session failed:', err)
    const status = statusNow()
    broadcast(CHANNELS.statusEvent, status)
    return {
      ok: false,
      message: (err as Error).message || 'That focus session could not be recorded.',
      status,
    }
  }
}

/**
 * Start at sign-in - for an installed build only. From a dev checkout or the
 * e2e suite, `process.execPath` is the bare Electron binary, and registering
 * that would launch an empty Electron window at every login.
 */
function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) return
  // Started at sign-in, OpenTime goes straight to the tray; see createWindow.
  app.setLoginItemSettings({ openAtLogin, args: [HIDDEN_FLAG] })
}

/** Open the GitHub feedback form for one kind of feedback in the browser. */
async function openFeedback(kind: FeedbackKind): Promise<void> {
  await shell.openExternal(
    feedbackUrl(kind, { version: app.getVersion(), platform: `${process.platform} ${process.arch}` })
  )
}

let quitPrepared = false

/**
 * Stop everything that writes and get it onto disk. Shared by an ordinary quit
 * and by the updater, which must not start replacing the program files while
 * the last minutes of tracking are still in memory.
 */
async function prepareToQuit(): Promise<void> {
  if (quitPrepared) return
  quitPrepared = true
  globalShortcut.unregisterAll()
  blocker?.dispose()
  updater?.dispose()
  tracker?.stop()
  // Drain before flushing: `stop()` starts the final write, and flushing a
  // store the last session has not reached yet would lose it.
  await Promise.resolve(tracker?.drain())
  await storage.flush()
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getBootstrap, async (): Promise<Bootstrap> => {
    const key = todayKey()
    const settings = storage.getSettings()
    return {
      settings,
      projects: storage.getProjects(),
      rules: storage.getRules(),
      goals: storage.getGoals(),
      status: statusNow(),
      today: await dayPayload(key),
      weekKeys: lastNDayKeys(7, key),
      historyKeys: storage.listDayKeys(),
      appVersion: app.getVersion(),
      platform: process.platform,
      dataDirectory: storage.dataDirectory,
      capture: captureHealth,
      captureNotice: captureHealth.demo ? captureHealth.notice : undefined,
      firstRun: !settings.onboardedAt,
      demoDays: storage.demoDays(),
      update: updater?.state ?? { state: 'unsupported' },
    }
  })

  ipcMain.handle(CHANNELS.getDay, (_e, key: string): Promise<DayPayload> => dayPayload(key))

  ipcMain.handle(CHANNELS.getRange, async (_e, keys: string[]): Promise<DayPayload[]> => {
    const out: DayPayload[] = []
    for (const key of keys) out.push(await dayPayload(key))
    return out
  })

  ipcMain.handle(CHANNELS.getStatus, (): TrackerStatus => statusNow())

  ipcMain.handle(
    CHANNELS.setTracking,
    (_e, action: string, minutes?: number): TrackerStatus => {
      if (action === 'start') tracker.start()
      else if (action === 'pause') tracker.pause(minutes)
      else if (action === 'resume') tracker.resume()
      else if (action === 'stop') tracker.stop()
      buildTrayMenu()
      return statusNow()
    }
  )

  ipcMain.handle(CHANNELS.saveSettings, async (_e, settings: Settings): Promise<Settings> => {
    const before = storage.getSettings()
    await storage.saveSettings(settings)
    const saved = storage.getSettings()
    tracker.reconfigure(saved, storage.getProjects(), storage.getRules())
    applyLoginItem(saved.launchAtLogin)
    // A changed capture mode should take effect now, not at the next launch.
    if (saved.captureMode !== before.captureMode) {
      initCapture()
      tracker.setCapture(capture)
    }
    // Triggers `nativeTheme`'s 'updated' event, which resyncs the Windows
    // title-bar overlay colours to match.
    if (saved.theme !== before.theme) nativeTheme.themeSource = saved.theme
    if (saved.retentionDays !== before.retentionDays) await applyRetention()
    blocker?.sync()
    updater?.sync()
    broadcast(CHANNELS.dataEvent)
    return saved
  })

  ipcMain.handle(CHANNELS.saveProjects, async (_e, projects: Project[]): Promise<Project[]> => {
    await storage.saveProjects(projects)
    tracker.reconfigure(storage.getSettings(), projects, storage.getRules())
    return storage.getProjects()
  })

  ipcMain.handle(CHANNELS.saveRules, async (_e, rules: CategoryRule[]): Promise<CategoryRule[]> => {
    await storage.saveRules(rules)
    tracker.reconfigure(storage.getSettings(), storage.getProjects(), rules)
    return storage.getRules()
  })

  ipcMain.handle(CHANNELS.saveGoals, async (_e, goals: Goal[]): Promise<Goal[]> => {
    await storage.saveGoals((goals || []).map((g, i) => sanitizeGoal(g, `g_${i}`)))
    return storage.getGoals()
  })

  ipcMain.handle(
    CHANNELS.recategorize,
    async (_e, req: RecategorizeRequest): Promise<DayPayload> => {
      const patch: Partial<Session> = { category: req.category, edited: true }
      if (req.productivity) patch.productivity = req.productivity
      if (req.note !== undefined) patch.note = req.note || undefined
      const project = storage.getProjects().find((p) => p.name === req.category)
      if (project) patch.projectId = project.id
      const updated = await storage.updateSession(req.dayKey, req.sessionId, patch)

      if (updated && req.rememberAs) {
        const match =
          req.rememberAs === 'app'
            ? updated.app.toLowerCase()
            : (updated.url || updated.app).toLowerCase()
        const rules = storage.getRules()
        const existing = rules.findIndex((r) => r.kind === req.rememberAs && r.match === match)
        const rule: CategoryRule = {
          id: existing >= 0 ? rules[existing].id : `r_${Date.now().toString(36)}`,
          kind: req.rememberAs,
          match,
          category: req.category,
          productivity: req.productivity,
        }
        const next = existing >= 0 ? rules.map((r, i) => (i === existing ? rule : r)) : [...rules, rule]
        await storage.saveRules(next)
        tracker.reconfigure(storage.getSettings(), storage.getProjects(), next)
      }
      broadcast(CHANNELS.dataEvent)
      return dayPayload(req.dayKey)
    }
  )

  ipcMain.handle(CHANNELS.editSession, async (_e, edit: SessionEdit): Promise<EditResult> => {
    try {
      const outcome = await applyEdit(storage, edit)
      if (outcome.ok) broadcast(CHANNELS.dataEvent)
      return outcome
    } catch (err) {
      console.error('[main] session edit failed:', err)
      return { ok: false, message: 'That edit could not be applied.' }
    }
  })

  ipcMain.handle(
    CHANNELS.addManualEvent,
    async (_e, input: Omit<CalendarEvent, 'id' | 'source'>): Promise<DayPayload> => {
      const key = dayKey(input.start, storage.getSettings().dayStartHour)
      const event: CalendarEvent = {
        ...input,
        id: `manual_${Date.now().toString(36)}`,
        source: 'manual',
      }
      const next = [...(await storage.getEvents(key)), event].sort((a, b) => a.start - b.start)
      await storage.putEvents(key, next)
      broadcast(CHANNELS.dataEvent)
      return dayPayload(key)
    }
  )

  ipcMain.handle(CHANNELS.connectCalendar, async (): Promise<CalendarResult> => {
    try {
      return await connectCalendar()
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle(CHANNELS.disconnectCalendar, async (): Promise<CalendarResult> => {
    await saveTokens(null)
    const settings = storage.getSettings()
    await storage.saveSettings({
      ...settings,
      calendar: { ...settings.calendar, connected: false, accountEmail: undefined },
    })
    broadcast(CHANNELS.dataEvent)
    return { ok: true, message: 'Disconnected.' }
  })

  ipcMain.handle(CHANNELS.syncCalendar, (): Promise<CalendarResult> => syncCalendar())

  ipcMain.handle(CHANNELS.exportData, async (_e, request: ExportRequest): Promise<ExportResult> => {
    try {
      await storage.flush()
      return await exportData(request)
    } catch (err) {
      return { ok: false, message: `Export failed: ${(err as Error).message}` }
    }
  })

  ipcMain.handle(CHANNELS.importBackup, async (): Promise<ExportResult> => {
    try {
      return await importBackup()
    } catch (err) {
      return { ok: false, message: `Restore failed: ${(err as Error).message}` }
    }
  })

  ipcMain.handle(CHANNELS.revealDataFolder, async (): Promise<void> => {
    await storage.flush()
    await shell.openPath(storage.dataDirectory)
  })

  ipcMain.handle(CHANNELS.clearDemoData, async (): Promise<ExportResult> => {
    const removed = await storage.clearDemoDays()
    broadcast(CHANNELS.dataEvent)
    return removed
      ? { ok: true, message: `Removed ${removed} day(s) of demo history.`, count: removed }
      : { ok: false, message: 'There is no demo history to remove.' }
  })

  ipcMain.handle(CHANNELS.reloadCapture, (): CaptureHealth => {
    const health = initCapture()
    tracker.setCapture(capture)
    buildTrayMenu()
    broadcast(CHANNELS.statusEvent, statusNow())
    return health
  })

  // First run saves the person's choices and the "done" marker in one write,
  // so onboarding can never half-finish and come back.
  ipcMain.handle(CHANNELS.completeOnboarding, async (_e, chosen?: Settings): Promise<Settings> => {
    const before = storage.getSettings()
    await storage.saveSettings({ ...before, ...(chosen || {}), onboardedAt: Date.now() })
    const saved = storage.getSettings()
    tracker.reconfigure(saved, storage.getProjects(), storage.getRules())
    applyLoginItem(saved.launchAtLogin)
    if (saved.theme !== before.theme) nativeTheme.themeSource = saved.theme
    blocker?.sync()
    updater?.sync()
    broadcast(CHANNELS.dataEvent)
    return saved
  })

  ipcMain.handle(
    CHANNELS.startFocus,
    (_e, input: FocusStartInput): FocusStartResult => {
      if (activeFocus) {
        return { ok: false, message: 'A focus session is already running.', status: statusNow() }
      }
      try {
        activeFocus = startFocus(input)
      } catch (err) {
        return { ok: false, message: (err as Error).message, status: statusNow() }
      }
      // A focus session against a paused tracker would record nothing, so
      // starting one resumes tracking rather than quietly producing an empty
      // block 45 minutes later.
      if (tracker.status.paused) tracker.resume()
      buildTrayMenu()
      blocker?.sync()
      const status = statusNow()
      broadcast(CHANNELS.statusEvent, status)
      return { ok: true, status, focus: activeFocus }
    }
  )

  ipcMain.handle(CHANNELS.endFocus, (): Promise<FocusEndResult> => endFocusSession())

  ipcMain.handle(CHANNELS.checkForUpdates, async (): Promise<UpdateState> => {
    if (!updater || updater.state.state === 'unsupported') {
      await shell.openExternal(RELEASES_URL)
      return updater?.state ?? { state: 'unsupported' }
    }
    return updater.check()
  })

  ipcMain.handle(
    CHANNELS.installUpdate,
    async (): Promise<UpdateState> => updater?.install() ?? { state: 'unsupported' }
  )

  ipcMain.handle(CHANNELS.openFeedback, (_e, kind: FeedbackKind) =>
    openFeedback(kind === 'bug' || kind === 'idea' ? kind : 'question')
  )

  ipcMain.handle(CHANNELS.extendFocus, (_e, minutes: number): FocusStartResult => {
    if (!activeFocus) {
      return { ok: false, message: 'No focus session is running.', status: statusNow() }
    }
    const add = Math.round(minutes)
    if (!Number.isFinite(add) || add <= 0) {
      return { ok: false, message: 'Extending needs a positive number of minutes.', status: statusNow() }
    }
    // Extending only ever moves the planned end later. A session already past
    // its plan extends from *now*, not from a marker in the past, so one click
    // reliably buys the minutes it says it does.
    const elapsed = Math.max(0, Math.round((Date.now() - activeFocus.startTime) / 1000))
    activeFocus = {
      ...activeFocus,
      plannedSeconds: Math.max(activeFocus.plannedSeconds, elapsed) + add * 60,
    }
    const status = statusNow()
    broadcast(CHANNELS.statusEvent, status)
    return { ok: true, status, focus: activeFocus }
  })
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  // Distinguish this from the `--print-capture-health` diagnostic finding
  // capture genuinely unavailable: both otherwise look like "silent exit,
  // no output," which is exactly the ambiguity that cost time chasing the
  // wrong cause when a prior process's lock hadn't yet been released.
  if (process.argv.includes('--print-capture-health')) {
    console.error('another OpenTime instance already holds the single-instance lock')
  }
  app.quit()
} else {
  app.on('second-instance', showWindow)

  void app.whenReady().then(async () => {
    // Notifications on Windows attribute to an AppUserModelID; without one they
    // arrive from "electron.app.OpenTime" and cannot be configured by the user.
    if (process.platform === 'win32') app.setAppUserModelId('app.opentime.desktop')

    storage = new FileStorage(app.getPath('userData'))
    await storage.init()

    // A headless diagnostic for the packaged-build smoke check: print exactly
    // what a user would see in Settings for capture health, then exit, rather
    // than opening a window. Exercises the real `createCapture` probe against
    // whatever actually shipped in this build — the one thing dev mode and an
    // unpacked build cannot prove either way.
    if (process.argv.includes('--print-capture-health')) {
      const health = initCapture()
      // OpenTime.exe is a GUI-subsystem (not console-subsystem) binary. Even
      // with output redirected by the launching shell, a write-then-`app.exit()`
      // race (or the binary simply having no attached stdio) can lose the
      // whole line on Windows — confirmed by two CI runs where this printed
      // nothing at all despite completing in well under a second, unrelated
      // to `app.exit()`'s own immediate-termination behavior. A file next to
      // the rest of this run's data is unambiguous regardless of stdio.
      const healthPath = path.join(app.getPath('userData'), 'capture-health.json')
      await fs.writeFile(healthPath, JSON.stringify(health))
      console.log(JSON.stringify(health))
      app.exit(health.demo ? 1 : 0)
      return
    }

    await loadTokens()
    initCapture()
    await seedDemoHistoryIfNeeded()
    await applyRetention()

    const settings = storage.getSettings()
    // Drives `nativeTheme.shouldUseDarkColors`, which `createWindow` and
    // `syncTitleBarOverlay` read — this is what makes "system" resolve to the
    // real OS theme instead of always reading as light.
    nativeTheme.themeSource = settings.theme
    nativeTheme.on('updated', syncTitleBarOverlay)
    // Re-register every launch, so a login item written by an older version
    // (no --hidden, or an old install path) matches this build.
    applyLoginItem(settings.launchAtLogin)

    tracker = new Tracker(
      {
        capture,
        storage,
        getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
        onChange: () => {
          broadcast(CHANNELS.statusEvent, statusNow())
          broadcast(CHANNELS.dataEvent)
        },
        onBreakSuggestion: (minutes) => {
          if (!storage.getSettings().notificationsEnabled) return
          if (!Notification.isSupported()) return
          new Notification({
            title: 'OpenTime — focus checkpoint',
            body: `${minutes} minutes of unbroken focus. A short break here protects the next block.`,
            silent: true,
          }).show()
        },
      },
      settings,
      storage.getProjects(),
      storage.getRules()
    )

    blocker = new Blocker({
      capture: () => capture,
      settings: () => storage.getSettings(),
      focus: () => activeFocus,
      // Windows can report a minimised window as still focused when nothing
      // else took the foreground; only a window actually on screen counts.
      mainWindowFocused: () =>
        !!mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized() &&
        mainWindow.isFocused(),
      endFocus: () => endFocusSession(),
    })
    updater = new Updater({
      publish: (state) => broadcast(CHANNELS.updateEvent, state),
      autoCheckEnabled: () => storage.getSettings().checkForUpdates,
      prepareToQuit,
    })
    updater.sync()

    registerIpc()

    // The tray comes first: a window started hidden at sign-in needs it to
    // exist, or there would be no way back to the app.
    try {
      tray = new Tray(trayIcon())
      buildTrayMenu()
      tray.on('click', showWindow)
    } catch (err) {
      // No system tray (some Linux sessions) — the app is still fully usable.
      console.error('[main] tray unavailable:', err)
    }

    createWindow()

    tracker.start()
    registerGlobalShortcuts()

    // Come back promptly on wake/unlock instead of waiting out the heartbeat.
    powerMonitor.on('resume', () => tracker.wake())
    powerMonitor.on('unlock-screen', () => tracker.wake())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Keep tracking in the tray on Windows/Linux; macOS keeps the app alive
    // by convention anyway.
    if (!tray && process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    // Already flushed - by an earlier pass through here, or by the updater
    // before it launched the installer. Let the quit proceed.
    if (!storage || quitPrepared) return
    event.preventDefault()
    void prepareToQuit()
      .catch((err) => console.error('[main] final flush failed:', err))
      .finally(() => app.exit(0))
  })
}
