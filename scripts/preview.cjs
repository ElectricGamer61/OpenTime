/**
 * Drive the built renderer and capture a named state.
 *
 * `screenshot.cjs` captures the seven tabs at rest. This one exists for the
 * states you can only reach by *doing* something — opening the focus sheet,
 * switching Reports to a month, ending a session — which are exactly the states
 * a visual review of a new feature needs and which no static capture reaches.
 *
 *   npx electron scripts/preview.cjs <outDir> [shot...]
 *
 * Run with no shot names to capture all of them.
 *
 * Loaded without the preload bridge on purpose, like `screenshot.cjs`: the
 * renderer falls back to its self-contained demo client, so the whole UI is
 * reachable with no tracking engine behind it.
 */

const path = require('node:path')
const { promises: fs } = require('node:fs')

const { app, BrowserWindow } = require('electron')

const outDir = process.argv[2] || 'screenshots'
const wanted = process.argv.slice(3)
const root = path.dirname(__dirname)

const click = (selector, text) => `
  (() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const hit = ${text === undefined ? 'nodes[0]' : `nodes.find((n) => n.textContent.trim().includes(${JSON.stringify(text)}))`}
    if (!hit) return false
    hit.click()
    return true
  })()
`

/** Each shot is a list of steps run from a freshly reloaded renderer. */
const SHOTS = [
  { name: 'focus-setup', steps: [click('.focus-start')] },
  {
    name: 'focus-running',
    steps: [click('.focus-start'), `document.querySelector('#focus-goal').value`, click('.focus-sheet-foot .btn.primary')],
  },
  {
    name: 'focus-sound',
    steps: [
      click('.focus-start'),
      click('.focus-sheet-foot .btn.primary'),
      click('.focus-sound-wrap .icon-btn'),
    ],
  },
  {
    name: 'reports-month',
    steps: [click('.nav-item', 'Reports'), click('.range-bar .seg button', 'Month')],
  },
  {
    name: 'reports-year',
    steps: [click('.nav-item', 'Reports'), click('.range-bar .seg button', 'Year')],
  },
  {
    name: 'reports-custom',
    steps: [click('.nav-item', 'Reports'), click('.range-bar .seg button', 'Custom')],
  },
  {
    name: 'focus-complete',
    steps: [
      click('.focus-start'),
      `(() => {
        const el = document.querySelector('#focus-goal')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(el, 'Ship the billing fix')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`,
      click('.seg.focus-durations button', '15m'),
      click('.focus-sheet-foot .btn.primary'),
      6000,
      click('.focus-dock-actions .btn.danger'),
      2500,
    ],
  },
  {
    name: 'focus-timeline',
    steps: [
      click('.focus-start'),
      `(() => {
        const el = document.querySelector('#focus-goal')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(el, 'Ship the billing fix')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`,
      click('.focus-sheet-foot .btn.primary'),
      6000,
      click('.focus-dock-actions .btn.danger'),
      2500,
      click('.focus-sheet-foot .btn.ghost'),
    ],
  },
  {
    // The one README needs: a session running over the calendar it will land in.
    name: 'focus',
    steps: [
      click('.focus-start'),
      `(() => {
        const el = document.querySelector('#focus-goal')
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(el, 'Ship the billing fix')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`,
      click('.focus-beds button', 'Rain'),
    ],
  },
  { name: 'dashboard-focus', steps: [click('.nav-item', 'Dashboard')] },
  { name: 'settings-privacy', steps: [click('.nav-item', 'Settings'), click('.settings-nav button', 'Privacy')] },
  { name: 'goals', steps: [click('.nav-item', 'Goals')] },
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  const file = path.join(root, 'dist/renderer/index.html')
  await win.loadFile(file)

  for (const shot of SHOTS) {
    if (wanted.length && !wanted.includes(shot.name)) continue
    await win.loadFile(file)
    await new Promise((r) => setTimeout(r, 2200))

    for (const step of shot.steps) {
      // A number is a pause: a focus session has to actually run for a few
      // seconds before ending it produces anything to look at.
      if (typeof step === 'number') {
        await new Promise((r) => setTimeout(r, step))
        continue
      }
      await win.webContents.executeJavaScript(step)
      await new Promise((r) => setTimeout(r, 700))
    }

    await win.webContents.executeJavaScript(`
      Promise.all(
        document.getAnimations()
          .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {}))
      ).then(() => {})
    `)
    await new Promise((r) => setTimeout(r, 500))

    // `invalidate()` repaints, but a *newly added* layer — an opened sheet, the
    // dock — never lands in the capture without a real resize. See CLAUDE.md.
    const [w, h] = win.getSize()
    win.setSize(w, h - 1)
    await new Promise((r) => setTimeout(r, 200))
    win.setSize(w, h)
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 400))

    const image = await win.webContents.capturePage()
    const out = path.join(outDir, `${shot.name}.png`)
    await fs.writeFile(out, image.toPNG())
    console.log('wrote', out)
  }

  app.quit()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
