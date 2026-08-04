/**
 * Capture screenshots of the running app from the real Electron shell.
 *
 * Run with `npx electron scripts/screenshot.cjs <outDir>` after `npm run build`.
 * Used to eyeball the UI on a machine with no interactive display; it boots the
 * actual main process, so what it captures is what ships.
 */

const path = require('node:path')
const { promises: fs } = require('node:fs')

const { app, BrowserWindow } = require('electron')

const outDir = process.argv[2] || 'screenshots'
const root = path.dirname(__dirname)

/** Tab label to click, and the filename README already links to. */
const TABS = [
  { tab: 'Calendar', file: 'calendar.png' },
  { tab: 'Dashboard', file: 'dashboard.png' },
  { tab: 'Activity', file: 'activity.png' },
  { tab: 'Reports', file: 'reports.png' },
  { tab: 'Projects', file: 'projects.png' },
  { tab: 'Goals', file: 'goals.png' },
  { tab: 'Settings', file: 'settings.png' },
]

app.disableHardwareAcceleration()

async function main() {
await app.whenReady()
await fs.mkdir(outDir, { recursive: true })

const win = new BrowserWindow({
  width: 1440,
  height: 950,
  show: false,
  backgroundColor: '#0d0d0f',
  // No preload on purpose: without the IPC bridge the renderer falls back to
  // its self-contained demo client, so this captures the full UI without
  // needing the tracking engine running behind it.
  webPreferences: { contextIsolation: true, nodeIntegration: false },
})

await win.loadFile(path.join(root, 'dist/renderer/index.html'))
await new Promise((r) => setTimeout(r, 2500))

for (const { tab, file: name } of TABS) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.nav-item')].find(
        (b) => b.textContent.trim() === ${JSON.stringify(tab)}
      )
      if (btn) btn.click()
      return !!btn
    })()
  `)
  // Without this, a renamed tab or a nav that stops responding silently
  // produces four screenshots of whatever was already on screen.
  if (!clicked) throw new Error(`no nav item labelled "${tab}"`)

  // Views animate in, and `capturePage()` on a hidden window reads whatever
  // the offscreen compositor last produced — a fixed sleep captured the
  // *previous* tab mid-transition. Wait for every running animation that has
  // a finite end to settle, then give the compositor a frame or two.
  await win.webContents.executeJavaScript(`
    Promise.all(
      document.getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    ).then(() => {})
  `)
  await new Promise((r) => setTimeout(r, 700))

  // Offscreen rendering only rasters what it thinks changed, and the rail is
  // outside the region the tab switch touched — without this the sidebar in
  // the PNG still shows the previously selected tab.
  win.webContents.invalidate()
  await new Promise((r) => setTimeout(r, 300))

  const active = await win.webContents.executeJavaScript(
    `document.querySelector('.nav-item.active')?.textContent.trim() ?? null`
  )
  if (active !== tab) throw new Error(`clicked "${tab}" but "${active}" is active`)
  const image = await win.webContents.capturePage()
  const file = path.join(outDir, name)
  await fs.writeFile(file, image.toPNG())
  console.log('wrote', file)
}

app.exit(0)
}

main().catch((err) => {
  console.error('screenshot failed:', err)
  app.exit(1)
})
