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

const TABS = ['Today', 'This week', 'Projects & rules', 'Settings']

app.disableHardwareAcceleration()

async function main() {
await app.whenReady()
await fs.mkdir(outDir, { recursive: true })

const win = new BrowserWindow({
  width: 1440,
  height: 950,
  show: false,
  backgroundColor: '#0b0e14',
  // No preload on purpose: without the IPC bridge the renderer falls back to
  // its self-contained demo client, so this captures the full UI without
  // needing the tracking engine running behind it.
  webPreferences: { contextIsolation: true, nodeIntegration: false },
})

await win.loadFile(path.join(root, 'dist/renderer/index.html'))
await new Promise((r) => setTimeout(r, 2500))

for (const [index, tab] of TABS.entries()) {
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('.nav-item')].find(
        (b) => b.textContent.trim() === ${JSON.stringify(tab)}
      )
      if (btn) btn.click()
      return !!btn
    })()
  `)
  await new Promise((r) => setTimeout(r, 900))
  const image = await win.webContents.capturePage()
  const file = path.join(outDir, `${index + 1}-${tab.toLowerCase().replace(/[^a-z]+/g, '-')}.png`)
  await fs.writeFile(file, image.toPNG())
  console.log('wrote', file)
}

app.exit(0)
}

main().catch((err) => {
  console.error('screenshot failed:', err)
  app.exit(1)
})
