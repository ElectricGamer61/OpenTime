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

/**
 * Which themes to capture. Both are shipped, so both have to be looked at —
 * a light theme nobody has rendered is a light theme that is broken.
 * `--theme=light|dark|both`; the default keeps the README filenames untouched.
 */
const themeArg = (process.argv.find((a) => a.startsWith('--theme=')) || '').split('=')[1]
const THEMES = themeArg === 'both' ? ['light', 'dark'] : [themeArg || 'dark']

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

for (const theme of THEMES) {
  // Drive the real Appearance control. This script loads the renderer without
  // the preload bridge (see below), so there is no `window.opentime` to call —
  // and stamping `data-theme` directly is undone the moment a view mounts,
  // because the app owns that attribute and re-applies it from settings.
  await win.webContents.executeJavaScript(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const nav = (label) =>
        [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === label)
      nav('Settings').click()
      await wait(600)
      const button = [...document.querySelectorAll('.seg button')].find(
        (b) => b.textContent.trim().toLowerCase() === ${JSON.stringify(theme)}
      )
      if (!button) throw new Error('no Appearance option for ${theme}')
      button.click()
      await wait(300)
      const save = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save')
      if (save && !save.disabled) save.click()
      await wait(600)
    })()
  `)
  const applied = await win.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim()`
  )
  // Without this a "dark" capture that silently rendered light looks like a
  // theme that works, which is the one thing these screenshots must not do.
  if (applied !== theme) throw new Error(`asked for ${theme} but color-scheme is "${applied}"`)

  const suffix = THEMES.length > 1 ? `-${theme}` : ''

for (const { tab, file: rawName } of TABS) {
  const name = rawName.replace(/\.png$/, `${suffix}.png`)
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

  // `invalidate()` alone still left the *previous* tab's active pill in the
  // raster — the rail is outside the region the switch dirtied, and repainting
  // is not the same as re-rastering. A one-pixel resize and back forces a full
  // raster and is the only thing that reliably fixed it.
  const [w, h] = win.getSize()
  win.setSize(w, h - 1)
  await new Promise((r) => setTimeout(r, 150))
  win.setSize(w, h)
  await new Promise((r) => setTimeout(r, 350))

  const image = await win.webContents.capturePage()
  const file = path.join(outDir, name)
  await fs.writeFile(file, image.toPNG())
  console.log('wrote', file)
}
}

app.exit(0)
}

main().catch((err) => {
  console.error('screenshot failed:', err)
  app.exit(1)
})
