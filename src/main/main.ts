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
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  shell,
  systemPreferences,
  Tray,
  nativeImage,
} from 'electron'

import { dayKey, lastNDayKeys, parseYmdLocal, formatYmdLocal } from '../core/day'
import { generateDemoDay } from '../core/demo'
import { exportFilename, parseBackup } from '../core/export'
import { sanitizeGoal } from '../core/goals'
import type {
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
  RecategorizeRequest,
  SessionEdit,
} from '../shared/ipc'
import { createCapture, type Capture } from './capture'
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

const DEV_SERVER_URL = process.env.OPENTIME_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let storage: FileStorage
let tracker: Tracker
let capture: Capture
let captureHealth: CaptureHealth
let tokens: TokenSet | null = null

const tokenFile = () => path.join(app.getPath('userData'), 'opentime-google-tokens.json')

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'OpenTime',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
  mainWindow.once('ready-to-show', () => mainWindow?.show())

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

// A 16px monochrome dot, drawn inline — no binary asset to keep in sync.
function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="#7aa2ff" stroke-width="2"/><path d="M8 4.5V8l2.5 1.5" stroke="#7aa2ff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
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
      { label: 'Quit', click: () => app.quit() },
    ])
  )

  const until = status.pausedUntil
    ? ` until ${new Date(status.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ''
  tray.setToolTip(status.paused ? `OpenTime — paused${until}` : 'OpenTime — tracking')
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
 * Two rules make it honest. It only runs when real capture is *unavailable*, so
 * a working install never mixes fiction into a real history; and every seeded
 * day is recorded in the store so "Clear demo data" can remove exactly those
 * days and nothing else. A user who would rather see an empty dashboard turns
 * `seedDemoWhenUnavailable` off and gets one.
 */
async function seedDemoHistoryIfNeeded(): Promise<void> {
  const settings = storage.getSettings()
  if (!captureHealth.demo || !settings.seedDemoWhenUnavailable) return
  if (!storage.isEmpty()) return

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
      status: tracker.status,
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
    }
  })

  ipcMain.handle(CHANNELS.getDay, (_e, key: string): Promise<DayPayload> => dayPayload(key))

  ipcMain.handle(CHANNELS.getRange, async (_e, keys: string[]): Promise<DayPayload[]> => {
    const out: DayPayload[] = []
    for (const key of keys) out.push(await dayPayload(key))
    return out
  })

  ipcMain.handle(CHANNELS.getStatus, (): TrackerStatus => tracker.status)

  ipcMain.handle(
    CHANNELS.setTracking,
    (_e, action: string, minutes?: number): TrackerStatus => {
      if (action === 'start') tracker.start()
      else if (action === 'pause') tracker.pause(minutes)
      else if (action === 'resume') tracker.resume()
      else if (action === 'stop') tracker.stop()
      buildTrayMenu()
      return tracker.status
    }
  )

  ipcMain.handle(CHANNELS.saveSettings, async (_e, settings: Settings): Promise<Settings> => {
    const before = storage.getSettings()
    await storage.saveSettings(settings)
    const saved = storage.getSettings()
    tracker.reconfigure(saved, storage.getProjects(), storage.getRules())
    app.setLoginItemSettings({ openAtLogin: saved.launchAtLogin })
    // A changed capture mode should take effect now, not at the next launch.
    if (saved.captureMode !== before.captureMode) {
      initCapture()
      tracker.setCapture(capture)
    }
    if (saved.retentionDays !== before.retentionDays) await applyRetention()
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
    broadcast(CHANNELS.statusEvent, tracker.status)
    return health
  })

  ipcMain.handle(CHANNELS.completeOnboarding, async (): Promise<Settings> => {
    await storage.saveSettings({ ...storage.getSettings(), onboardedAt: Date.now() })
    return storage.getSettings()
  })
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  void app.whenReady().then(async () => {
    // Notifications on Windows attribute to an AppUserModelID; without one they
    // arrive from "electron.app.OpenTime" and cannot be configured by the user.
    if (process.platform === 'win32') app.setAppUserModelId('app.opentime.desktop')

    storage = new FileStorage(app.getPath('userData'))
    await storage.init()
    await loadTokens()
    initCapture()
    await seedDemoHistoryIfNeeded()
    await applyRetention()

    const settings = storage.getSettings()

    tracker = new Tracker(
      {
        capture,
        storage,
        getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
        onChange: (status) => {
          broadcast(CHANNELS.statusEvent, status)
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

    registerIpc()
    createWindow()

    try {
      tray = new Tray(trayIcon())
      buildTrayMenu()
      tray.on('click', showWindow)
    } catch (err) {
      // No system tray (some Linux sessions) — the app is still fully usable.
      console.error('[main] tray unavailable:', err)
    }

    tracker.start()

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

  let quitting = false
  app.on('before-quit', (event) => {
    if (!storage || quitting) return
    quitting = true
    event.preventDefault()
    tracker?.stop()
    // Drain before flushing: `stop()` starts the final write, and flushing a
    // store the last session has not reached yet would lose it.
    void Promise.resolve(tracker?.drain())
      .then(() => storage.flush())
      .catch((err) => console.error('[main] final flush failed:', err))
      .finally(() => app.exit(0))
  })
}
