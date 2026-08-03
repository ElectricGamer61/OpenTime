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
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  shell,
  Tray,
  nativeImage,
} from 'electron'

import { dayKey, lastNDayKeys } from '../core/day'
import { generateDemoDay } from '../core/demo'
import type {
  CalendarEvent,
  CategoryRule,
  Project,
  Session,
  Settings,
  TrackerStatus,
} from '../core/types'
import { CHANNELS } from '../shared/ipc'
import type { Bootstrap, CalendarResult, DayPayload, RecategorizeRequest } from '../shared/ipc'
import { createCapture } from './capture'
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
import { JsonStorage } from './storage/JsonStorage'
import { Tracker } from './tracker'

const DEV_SERVER_URL = process.env.OPENTIME_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let storage: JsonStorage
let tracker: Tracker
let captureNotice: string | undefined
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

function buildTrayMenu(): void {
  if (!tray) return
  const status = tracker.status
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open OpenTime', click: showWindow },
      { type: 'separator' },
      {
        label: status.paused ? 'Resume tracking' : 'Pause tracking',
        click: () => {
          if (status.paused) tracker.resume()
          else tracker.pause()
        },
      },
      { label: `Capture: ${status.captureAdapter}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  )
  tray.setToolTip(status.paused ? 'OpenTime — paused' : 'OpenTime — tracking')
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function dayPayload(key: string): DayPayload {
  return {
    dayKey: key,
    sessions: storage.getSessions(key),
    idle: storage.getIdle(key),
    events: storage.getEvents(key),
  }
}

function todayKey(): string {
  return dayKey(Date.now(), storage.getSettings().dayStartHour)
}

function broadcast(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

/**
 * First-run seeding. When there is no history at all, backfill a fortnight of
 * realistic demo days so the dashboard is immediately meaningful — and so the
 * app is reviewable on a machine where OS capture cannot run. Real capture,
 * once it works, simply appends to the same store.
 */
async function seedDemoHistoryIfEmpty(): Promise<void> {
  if (!storage.isEmpty()) return
  const settings = storage.getSettings()
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
  await storage.flush()
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
    for (const key of keys) await storage.putEvents(key, buckets[key] || [])
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

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle(CHANNELS.getBootstrap, (): Bootstrap => {
    const key = todayKey()
    return {
      settings: storage.getSettings(),
      projects: storage.getProjects(),
      rules: storage.getRules(),
      status: tracker.status,
      today: dayPayload(key),
      weekKeys: lastNDayKeys(7, key),
      appVersion: app.getVersion(),
      platform: process.platform,
      captureNotice,
    }
  })

  ipcMain.handle(CHANNELS.getDay, (_e, key: string): DayPayload => dayPayload(key))

  ipcMain.handle(CHANNELS.getRange, (_e, keys: string[]): DayPayload[] =>
    keys.map((k) => dayPayload(k))
  )

  ipcMain.handle(CHANNELS.getStatus, (): TrackerStatus => tracker.status)

  ipcMain.handle(CHANNELS.setTracking, (_e, action: string): TrackerStatus => {
    if (action === 'start') tracker.start()
    else if (action === 'pause') tracker.pause()
    else if (action === 'resume') tracker.resume()
    else if (action === 'stop') tracker.stop()
    buildTrayMenu()
    return tracker.status
  })

  ipcMain.handle(CHANNELS.saveSettings, async (_e, settings: Settings): Promise<Settings> => {
    await storage.saveSettings(settings)
    tracker.reconfigure(settings, storage.getProjects(), storage.getRules())
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    return storage.getSettings()
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

  ipcMain.handle(
    CHANNELS.recategorize,
    async (_e, req: RecategorizeRequest): Promise<DayPayload> => {
      const patch: Partial<Session> = { category: req.category }
      if (req.productivity) patch.productivity = req.productivity
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

  ipcMain.handle(
    CHANNELS.addManualEvent,
    async (_e, input: Omit<CalendarEvent, 'id' | 'source'>): Promise<DayPayload> => {
      const key = dayKey(input.start, storage.getSettings().dayStartHour)
      const event: CalendarEvent = {
        ...input,
        id: `manual_${Date.now().toString(36)}`,
        source: 'manual',
      }
      const next = [...storage.getEvents(key), event].sort((a, b) => a.start - b.start)
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
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  void app.whenReady().then(async () => {
    storage = new JsonStorage(app.getPath('userData'))
    await storage.init()
    await loadTokens()
    await seedDemoHistoryIfEmpty()

    const settings = storage.getSettings()
    const probe = createCapture(settings.captureMode, process.execPath)
    captureNotice = probe.reason

    tracker = new Tracker(
      {
        capture: probe.capture,
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

  app.on('before-quit', async (event) => {
    if (!storage) return
    event.preventDefault()
    tracker?.stop()
    await storage.flush()
    app.exit(0)
  })
}
