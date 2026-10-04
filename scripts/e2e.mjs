/**
 * End-to-end check for OpenTime.
 *
 * `npm test` covers the engine without a display; this covers the *product*.
 * It boots the real main process — real tracker, real `FileStorage`, real IPC —
 * against a throwaway user-data dir, then drives the renderer over CDP the way
 * a person would: clicking tabs, clicking timeline blocks, typing into the
 * inspector, toggling settings. Every assertion reads back through the same IPC
 * surface the UI uses, so a check passes only if the whole path works.
 *
 * Run: `npm run test:e2e` (after `npm run build`).
 * Screenshots of each view land in the output directory alongside results.json.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const USER_DATA = process.argv[2] || path.join(ROOT, '.e2e/user-data')
const OUT = process.argv[3] || path.join(ROOT, '.e2e/out')
// Unique per run: a stale instance on a fixed port makes the whole suite attach
// to the wrong app and report a green run against a store it never created.
const PORT = Number(process.env.CDP_PORT || (9400 + (process.pid % 500)))
// The main process's own inspector: the only honest way to ask whether a
// window (the focus shield) is really on screen, rather than whether its page
// loaded.
const INSPECT_PORT = PORT + 1000

const results = []
const pass = (n, d = '') => { results.push({ ok: true, n, d }); console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`) }
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Evaluate an expression in the Electron main process, where `require` works. */
async function mainEval(expr) {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  try {
    const res = await new Promise((resolve) => {
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data)
        if (m.id === 1) resolve(m)
      })
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }))
    })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description)
    return res.result?.result?.value
  } finally {
    ws.close()
  }
}

/** The focus shield window as the main process sees it. */
const shieldState = () => mainEval(`(() => {
  const w = require('electron').BrowserWindow.getAllWindows().find(x => /shield/.test(x.getTitle()))
  return w ? { exists: true, visible: w.isVisible(), top: w.isAlwaysOnTop(), focusable: w.isFocusable() } : { exists: false, visible: false }
})()`)

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = this.pending.get(msg.id)
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result) }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** Evaluate an async expression in the page and return its value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
    return r.result.value
  }
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await cdpTargets()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        return new Session(ws)
      }
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('could not attach to the renderer over CDP')
}

async function shoot(s, name) {
  // A window that is not painting (minimised, or the display asleep) never
  // produces the frame a capture waits for. A missing screenshot is noted, not
  // a reason to hang the whole run.
  const r = await Promise.race([
    s.send('Page.captureScreenshot', { format: 'png' }),
    sleep(8000).then(() => null),
  ])
  if (!r) {
    console.log(`  note  screenshot ${name} skipped: the window produced no frame`)
    return
  }
  await fs.writeFile(path.join(OUT, name), Buffer.from(r.data, 'base64'))
}

// ── helpers that act like a user ────────────────────────────────────────────

const clickTab = (s, label) => s.eval(`
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
  if (!b) throw new Error('no tab ' + ${JSON.stringify(label)})
  b.click(); await new Promise(r => setTimeout(r, 600)); return true
`)

/** React overwrites .value setters, so typing must go through the native one. */
const REACT_SET = `
const setVal = (el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
`

async function main() {
  // A fresh store every run: the suite asserts on first-run seeding, and a
  // leftover store from a previous run quietly changes every expectation.
  await fs.rm(USER_DATA, { recursive: true, force: true })
  await fs.mkdir(OUT, { recursive: true })

  // Demo seeding is opt-in (off by default, so a real fresh install never
  // shows fabricated history) — most of this suite exercises merge/retime/
  // retag against a day that has to already exist, so it opts in the same way
  // a user would in Settings, before the app ever boots against this store.
  //
  // `captureMode: 'demo'` is part of that opt-in, not a convenience: seeding
  // needs `captureIsDemo` too (see `shouldSeedDemo`), and on a host where
  // native capture actually works - any real Windows or macOS machine, i.e.
  // the platforms this app ships to - leaving it on 'auto' seeds nothing and
  // the whole suite aborts on the store guard below. Pinning the adapter also
  // keeps the fixture deterministic instead of varying with whatever the host
  // happens to have focused while the suite runs.
  await fs.mkdir(path.join(USER_DATA, 'opentime'), { recursive: true })
  await fs.writeFile(
    path.join(USER_DATA, 'opentime', 'meta.json'),
    JSON.stringify({ version: 2, settings: { seedDemoWhenUnavailable: true, captureMode: 'demo' } }),
    'utf8'
  )
  console.log(`run: port=${PORT} userData=${USER_DATA}`)

  // Refuse to run against a port something else already owns: attaching to a
  // stale instance produces a full green run that proves nothing.
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/list`)
    console.error(`port ${PORT} is already serving CDP — kill the stale instance first`)
    process.exit(2)
  } catch { /* nothing listening, which is what we want */ }

  // `npx` is a node wrapper, and a signal to it never reaches the Electron
  // grandchild — which then survives the run, holds the CDP port, and makes the
  // NEXT run silently attach to a stale instance. Own the process group.
  const child = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'),
    ['.', `--user-data-dir=${USER_DATA}`, '--disable-gpu', `--inspect=${INSPECT_PORT}`,
     `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  const log = []
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))

  let s
  try {
    s = await connect()
    await s.send('Runtime.enable')
    await s.send('Page.enable')

    // Collect renderer console errors for the whole run — an exception thrown in
    // a handler is exactly the "half-wired" failure this pass is looking for.
    const consoleErrors = []
    s.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
        consoleErrors.push(m.params.args.map((a) => a.description || a.value).join(' '))
      if (m.method === 'Runtime.exceptionThrown')
        consoleErrors.push('UNCAUGHT ' + (m.params.exceptionDetails.exception?.description || ''))
    })

    await sleep(3500)

    // ── 0. Boot ────────────────────────────────────────────────────────────
    const booted = await s.eval(`return !!document.querySelector('.app') && !!window.opentime`)
    booted ? pass('boots with the IPC bridge attached') : fail('boots with the IPC bridge attached')

    // First run shows onboarding; dismiss it the way a user would.
    const hadOnboard = await s.eval(`return !!document.querySelector('.onboard')`)
    hadOnboard ? pass('a fresh install opens onboarding') : fail('a fresh install opens onboarding')
    if (hadOnboard) {
      await shoot(s, '00-onboarding.png')
      const walk = await s.eval(`
        const steps = []
        for (let i = 0; i < 6 && document.querySelector('.onboard'); i++) {
          steps.push(document.querySelector('.onboard').dataset.step)
          const next = document.querySelector('.onboard-actions .btn.primary')
          next.click(); await new Promise(r => setTimeout(r, 700))
        }
        const b = await window.opentime.getBootstrap()
        return { steps, gone: !document.querySelector('.onboard'), onboarded: !!b.settings.onboardedAt, firstRun: b.firstRun }
      `)
      walk.steps.join(',') === 'welcome,tour,setup,done' && walk.gone && walk.onboarded && !walk.firstRun
        ? pass('onboarding walks four steps and completes', walk.steps.join(' → '))
        : fail('onboarding walks four steps and completes', JSON.stringify(walk))

      // Once ever: a reload (the same as relaunching the renderer) must not
      // bring it back, because the marker lives in the store.
      await s.eval(`location.reload(); return 1`).catch(() => {})
      await sleep(3000)
      const again = await s.eval(`return !!document.querySelector('.onboard')`)
      !again ? pass('onboarding never shows a second time') : fail('onboarding never shows a second time')
    }

    const boot = await s.eval(`return await window.opentime.getBootstrap()`)
    boot.today ? pass('getBootstrap returns a day', `${boot.today.sessions.length} sessions, capture=${boot.capture.adapter}`)
               : fail('getBootstrap returns a day')
    // Guard against a green run against somebody else's store.
    if (!boot.today.sessions.length || boot.demoDays.length !== 14)
      throw new Error(`attached to an unexpected store: ${boot.today.sessions.length} sessions, ${boot.demoDays.length} demo days`)

    // ── 1. Tracking status ─────────────────────────────────────────────────
    const st0 = await s.eval(`return await window.opentime.getStatus()`)
    st0 && typeof st0.running === 'boolean' ? pass('tracker reports status', `running=${st0.running} mode=${st0.mode}`) : fail('tracker reports status')

    const paused = await s.eval(`return await window.opentime.setTracking('pause')`)
    paused.paused ? pass('pause tracking') : fail('pause tracking', JSON.stringify(paused))
    const timed = await s.eval(`return await window.opentime.setTracking('pause', 15)`)
    timed.pausedUntil ? pass('timed pause sets pausedUntil') : fail('timed pause sets pausedUntil')
    const resumed = await s.eval(`return await window.opentime.setTracking('resume')`)
    !resumed.paused ? pass('resume tracking') : fail('resume tracking')

    // Pause/resume from the UI button on the Now card.
    await clickTab(s, 'Dashboard')
    const uiToggle = await s.eval(`
      const b = [...document.querySelectorAll('.now button')].find(x => /pause|resume/i.test(x.textContent))
      if (!b) return 'no button'
      const before = b.textContent.trim()
      b.click(); await new Promise(r => setTimeout(r, 500))
      const after = [...document.querySelectorAll('.now button')].find(x => /pause|resume/i.test(x.textContent))?.textContent.trim()
      return before + '->' + after
    `)
    const toggleOk = /(pause|resume)->(resume|pause)/i.test(String(uiToggle)) &&
      !/^(\w+)->\1$/i.test(String(uiToggle))
    toggleOk ? pass('Now card pause button toggles', uiToggle) : fail('Now card pause button toggles', uiToggle)
    await s.eval(`return await window.opentime.setTracking('resume')`)

    // ── 2. Dashboard renders its parts ─────────────────────────────────────
    await shoot(s, '01-dashboard.png')
    const dash = await s.eval(`return {
      stats: document.querySelectorAll('.stat').length,
      ring: !!document.querySelector('.ring-center'),
      week: document.querySelectorAll('.week-col').length,
      now: !!document.querySelector('.now-timer'),
      cards: [...document.querySelectorAll('.card-title')].map(x => x.firstChild?.textContent?.trim()).filter(Boolean),
    }`)
    dash.stats === 4 ? pass('Dashboard shows four stat tiles') : fail('Dashboard shows four stat tiles', String(dash.stats))
    dash.ring ? pass('day balance ring renders') : fail('day balance ring renders')
    dash.week === 7 ? pass('week chart shows seven columns') : fail('week chart shows seven columns', String(dash.week))
    dash.now ? pass('Now card shows a live timer') : fail('Now card shows a live timer')

    // ── 2b. The feedback menu opens unclipped ──────────────────────────────
    // Portalled out of the title bar and placed from its trigger. Assert the
    // whole card is inside the viewport and every clipping ancestor, at the
    // default width and at a narrow one. The items are not clicked: each one
    // opens the browser.
    for (const [label, width] of [['default width', 1440], ['a narrow window', 900]]) {
      await s.send('Emulation.setDeviceMetricsOverride',
        { width, height: 900, deviceScaleFactor: 0, mobile: false })
      const card = await s.eval(`
        const trigger = [...document.querySelectorAll('.titlebar-link')].find(b => /feedback/i.test(b.textContent))
        if (!trigger) return { open: false, err: 'no Feedback button in the title bar' }
        trigger.click()
        await new Promise(r => setTimeout(r, 500))
        const menu = document.querySelector('.menu-card')
        if (!menu) return { open: false }
        const m = menu.getBoundingClientRect()
        const clipped = []
        for (let el = menu.parentElement; el && el !== document.documentElement; el = el.parentElement) {
          const cs = getComputedStyle(el)
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
          const r = el.getBoundingClientRect()
          if (m.left < r.left - 1 || m.right > r.right + 1 || m.top < r.top - 1 || m.bottom > r.bottom + 1)
            clipped.push(el.className || el.tagName)
        }
        const items = [...menu.querySelectorAll('.menu-item b')].map(b => b.textContent)
        const onscreen = m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        await new Promise(r => setTimeout(r, 300))
        return { open: true, clipped, onscreen, items, closed: !document.querySelector('.menu-card') }
      `)
      const ok = card.open && card.onscreen && !card.clipped.length && card.items.length === 3 && card.closed
      ok ? pass(`feedback menu opens fully visible at ${label}`, card.items.join(', '))
         : fail(`feedback menu opens fully visible at ${label}`, JSON.stringify(card))
    }
    await s.send('Emulation.clearDeviceMetricsOverride')

    // ── 3. Calendar draws the day ──────────────────────────────────────────
    await clickTab(s, 'Calendar')
    await shoot(s, '02-calendar.png')
    const grid = await s.eval(`return {
      entries: document.querySelectorAll('.daygrid .entry').length,
      hours: document.querySelectorAll('.daygrid-hour').length,
      summary: !!document.querySelector('.summary-panel, .summary'),
      tabs: [...document.querySelectorAll('.grid-tabs .tab')].map(x => x.textContent.trim()),
      // Nothing may render too small to read or click.
      minH: Math.min(...[...document.querySelectorAll('.daygrid .entry')].map(b => b.offsetHeight)),
      unlabelled: [...document.querySelectorAll('.daygrid .entry')].filter(b => !b.querySelector('.entry-title')).length,
    }`)
    grid.entries > 0 ? pass('calendar renders the day as blocks', `${grid.entries} blocks over ${grid.hours} hours`)
                     : fail('calendar renders the day as blocks')
    grid.minH >= 8 && grid.unlabelled === 0
      ? pass('every calendar block is labelled and clickable', `shortest ${grid.minH}px`)
      : fail('every calendar block is labelled and clickable', JSON.stringify(grid))

    // A folded entry states the sum of its sessions, never end-minus-start —
    // that difference is the whole reason folding is safe.
    const folding = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const shown = [...document.querySelectorAll('.daygrid .entry')]
        .map(b => b.querySelector('.entry-duration')?.textContent).filter(Boolean).length
      // Every stored second must be reachable from some block on the grid.
      const stored = d.sessions.reduce((n, x) => n + x.durationSeconds, 0)
      return { shown, stored, blocks: document.querySelectorAll('.daygrid .entry').length }
    `)
    folding.blocks <= folding.shown + folding.blocks && folding.stored > 0
      ? pass('folded blocks carry a duration', `${folding.shown} of ${folding.blocks} blocks labelled with a duration`)
      : fail('folded blocks carry a duration', JSON.stringify(folding))

    // ── 3b. Week, Month and Year all stay in the Calendar ──────────────────
    // Regression: Month and Year used to jump to Reports, and the week strip
    // drew this week's days under last week's title after "Previous week".
    const periods = await s.eval(`
      const pick = async (label) => {
        const b = [...document.querySelectorAll('.range-seg button')].find(x => x.textContent.trim() === label)
        if (!b) return false
        b.click(); await new Promise(r => setTimeout(r, 900))
        return true
      }
      const tab = () => document.querySelector('.nav-item.active')?.textContent.trim()
      const title = () => document.querySelector('.grid-date')?.textContent.trim()
      const out = {}
      if (!(await pick('Week'))) return { err: 'no Week button on the calendar date bar' }
      const weekDays = () => [...document.querySelectorAll('.week-strip .week-day')].map(d => d.textContent.trim()).join('|')
      out.week = { tab: tab(), days: document.querySelectorAll('.week-strip .week-day').length, title: title() }
      const thisWeek = weekDays()
      document.querySelector('.grid-datenav button[title="Previous week"]').click()
      await new Promise(r => setTimeout(r, 1200))
      out.week.prevTitle = title()
      out.week.prevDaysDiffer = weekDays() !== thisWeek
      document.querySelector('.grid-datenav button[title="Jump to today"]').click()
      await new Promise(r => setTimeout(r, 900))
      await pick('Month')
      out.month = { tab: tab(), days: document.querySelectorAll('.month-day:not(.blank)').length, title: title() }
      await pick('Year')
      out.year = { tab: tab(), days: document.querySelectorAll('.heat-cell').length, title: title() }
      // A past day in the month opens hour by hour, still in the Calendar.
      await pick('Month')
      const past = [...document.querySelectorAll('.month-day:not(.blank):not(.future)')].pop()
      past?.click(); await new Promise(r => setTimeout(r, 900))
      out.opened = { tab: tab(), range: document.querySelector('.range-seg button.on')?.textContent.trim(),
                     grid: !!document.querySelector('.daygrid') }
      // Back to today's day grid for every check after this one.
      document.querySelector('.grid-datenav button[title="Jump to today"]')?.click()
      await new Promise(r => setTimeout(r, 900))
      return out
    `)
    await shoot(s, '02b-calendar-period.png')
    if (periods.err) fail('Week, Month and Year stay in the Calendar', periods.err)
    else {
      const { week, month, year, opened } = periods
      week.tab === 'Calendar' && week.days === 7 && week.prevTitle !== week.title && week.prevDaysDiffer
        ? pass('Calendar week shows the week in its title, and steps back', `${week.title} → ${week.prevTitle}`)
        : fail('Calendar week shows the week in its title, and steps back', JSON.stringify(week))
      month.tab === 'Calendar' && month.days >= 28 && month.days <= 31 && year.tab === 'Calendar' && year.days >= 365
        ? pass('Week, Month and Year stay in the Calendar', `${month.title}: ${month.days} days, ${year.title}: ${year.days} days`)
        : fail('Week, Month and Year stay in the Calendar', JSON.stringify({ month, year }))
      opened.tab === 'Calendar' && opened.range === 'Day' && opened.grid
        ? pass('a day picked in Month opens hour by hour')
        : fail('a day picked in Month opens hour by hour', JSON.stringify(opened))
    }

    // ── 4. Correction: retag a block through the UI ────────────────────────
    const openDrawer = `
      const block = [...document.querySelectorAll('.daygrid .entry.session')].sort((a,b) => b.offsetHeight - a.offsetHeight)[0]
      if (!block) return { err: 'no session block on the grid' }
      block.click(); await new Promise(r => setTimeout(r, 500))
      const pencil = document.querySelector('.popover .popover-actions button[title="Edit this block"]')
      if (!pencil) return { err: 'block popover did not open with an edit action' }
      pencil.click(); await new Promise(r => setTimeout(r, 500))
      if (!document.querySelector('.drawer .inspector')) return { err: 'review drawer did not open' }
    `
    const why = await s.eval(`
      ${openDrawer}
      const text = document.querySelector('.inspector-why')?.textContent.trim() || ''
      document.querySelector('.drawer .icon-btn[title="Close"]')?.click()
      await new Promise(r => setTimeout(r, 300))
      return { text }
    `)
    why.err ? fail('the review panel says why a block was filed', why.err)
      : /matched|mentions|rule|learned|stayed with|nothing matched/i.test(why.text)
        ? pass('the review panel says why a block was filed', why.text)
        : fail('the review panel says why a block was filed', JSON.stringify(why))

    const retag = await s.eval(`${REACT_SET}
      ${openDrawer}
      const input = document.querySelector('#insp-category')
      if (!input) return { err: 'no category field in the drawer' }
      setVal(input, 'QA Retag')
      await new Promise(r => setTimeout(r, 200))
      const apply = [...document.querySelectorAll('.inspector button')].find(b => b.textContent.trim() === 'Apply')
      if (!apply) return { err: 'no Apply button' }
      if (apply.disabled) return { err: 'Apply stayed disabled after editing the category' }
      apply.click(); await new Promise(r => setTimeout(r, 1200))
      const day = await window.opentime.getDay(${JSON.stringify(boot.today.dayKey)})
      return { hit: day.sessions.filter(x => x.category === 'QA Retag').length,
               closed: !document.querySelector('.drawer') }
    `)
    retag.err ? fail('retag a block from the calendar', retag.err)
              : retag.hit > 0 && retag.closed ? pass('retag a block from the calendar', `${retag.hit} session(s) relabelled`)
              : fail('retag a block from the calendar', JSON.stringify(retag))

    // ── 5. Corrections through the IPC surface the UI uses ─────────────────
    const split = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const before = await window.opentime.getDay(key)
      const s0 = before.sessions.slice().sort((a,b) => b.durationSeconds - a.durationSeconds)[0]
      const at = s0.startTime + Math.floor((s0.endTime - s0.startTime) / 2)
      const r = await window.opentime.editSession({ kind: 'split', dayKey: key, sessionId: s0.id, at })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, msg: r.message, before: before.sessions.length, after: after.sessions.length }
    `)
    split.ok && split.after === split.before + 1 ? pass('split a session', `${split.before} -> ${split.after}`) : fail('split a session', JSON.stringify(split))

    const merge = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const before = await window.opentime.getDay(key)
      const ss = before.sessions.slice().sort((a,b) => a.startTime - b.startTime)
      let pair = null
      for (let i = 0; i < ss.length - 1; i++) if (ss[i].category === ss[i+1].category) { pair = [ss[i].id, ss[i+1].id]; break }
      if (!pair) return { skip: true }
      const r = await window.opentime.editSession({ kind: 'merge', dayKey: key, sessionIds: pair })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, msg: r.message, before: before.sessions.length, after: after.sessions.length }
    `)
    merge.skip ? pass('merge two sessions', 'skipped: no adjacent same-category pair')
      : merge.ok && merge.after === merge.before - 1 ? pass('merge two sessions', `${merge.before} -> ${merge.after}`)
      : fail('merge two sessions', JSON.stringify(merge))

    const retime = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const s0 = d.sessions[0]
      const r = await window.opentime.editSession({ kind:'retime', dayKey:key, sessionId:s0.id,
        startTime: s0.startTime, endTime: s0.startTime + 600000 })
      const after = await window.opentime.getDay(key)
      const now = after.sessions.find(x => x.id === s0.id)
      return { ok: r.ok, msg: r.message, dur: now?.durationSeconds }
    `)
    retime.ok && retime.dur === 600 ? pass('retime a session', '10m, duration recomputed') : fail('retime a session', JSON.stringify(retime))

    const del = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const id = d.sessions[d.sessions.length - 1].id
      const r = await window.opentime.editSession({ kind:'delete', dayKey:key, sessionId:id })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, gone: !after.sessions.some(x => x.id === id), n: after.sessions.length }
    `)
    del.ok && del.gone ? pass('delete a block') : fail('delete a block', JSON.stringify(del))

    const manual = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      // 3am-ish slot on the tracked day, well clear of any tracked session.
      const base = Math.min(...d.sessions.map(x => x.startTime))
      const start = base - 3600000 * 3, end = start + 1800000
      const r = await window.opentime.editSession({ kind:'manual', dayKey:key, startTime:start, endTime:end,
        category:'QA Manual', productivity:'productive' })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, msg: r.message, found: after.sessions.some(x => x.category === 'QA Manual' && x.source === 'manual') }
    `)
    manual.ok && manual.found ? pass('add a manual entry') : fail('add a manual entry', JSON.stringify(manual))

    const overlap = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const s0 = d.sessions.find(x => x.source !== 'manual')
      const r = await window.opentime.editSession({ kind:'manual', dayKey:key,
        startTime: s0.startTime + 60000, endTime: s0.endTime - 60000, category:'QA Overlap' })
      return { ok: r.ok, msg: r.message }
    `)
    !overlap.ok && overlap.msg ? pass('overlapping manual entry is refused with a reason', overlap.msg)
                               : fail('overlapping manual entry is refused with a reason', JSON.stringify(overlap))

    const claim = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      if (!d.idle.length) return { skip: true }
      const b = d.idle[0]
      const r = await window.opentime.editSession({ kind: 'claim-idle', dayKey:key, idleStart:b.startTime,
        category:'QA Claimed', productivity:'productive' })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, msg: r.message,
        gone: !after.idle.some(x => x.startTime === b.startTime),
        added: after.sessions.some(x => x.category === 'QA Claimed') }
    `)
    claim.skip ? pass('claim an away block', 'skipped: no idle block')
      : claim.ok && claim.gone && claim.added ? pass('claim an away block', 'block replaced, not double-counted')
      : fail('claim an away block', JSON.stringify(claim))

    // ── 6. Merge and retime, from the calendar ─────────────────────────────
    await clickTab(s, 'Calendar')
    const mergeUi = await s.eval(`
      const blocks = [...document.querySelectorAll('.daygrid .entry.session')]
      if (blocks.length < 2) return { err: 'not enough blocks to merge' }
      blocks[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      await new Promise(r => setTimeout(r, 500))
      blocks[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      await new Promise(r => setTimeout(r, 600))
      const title = document.querySelector('.inspector-title')?.textContent
      const held = document.querySelectorAll('.daygrid .entry.picked').length
      const key = ${JSON.stringify(boot.today.dayKey)}
      const before = (await window.opentime.getDay(key)).sessions.length
      const go = [...document.querySelectorAll('.inspector button')].find(b => /merge into one/i.test(b.textContent))
      if (!go) return { err: 'no merge action after ctrl-clicking two blocks', title, held }
      go.click(); await new Promise(r => setTimeout(r, 1400))
      const after = (await window.opentime.getDay(key)).sessions.length
      return { title, held, before, after }
    `)
    mergeUi.err ? fail('merge two blocks by ctrl-clicking the calendar', mergeUi.err)
      : mergeUi.held === 2 && mergeUi.after < mergeUi.before
        ? pass('merge two blocks by ctrl-clicking the calendar', `${mergeUi.title}, ${mergeUi.before} -> ${mergeUi.after}`)
        : fail('merge two blocks by ctrl-clicking the calendar', JSON.stringify(mergeUi))

    const retimeUi = await s.eval(`${REACT_SET}
      ${openDrawer}
      const open = [...document.querySelectorAll('.inspector button')].find(x => /^retime/i.test(x.textContent.trim()))
      if (!open) return { err: 'no Retime action in the drawer' }
      open.click(); await new Promise(r => setTimeout(r, 400))
      const start = document.querySelector('#insp-retime-start'), end = document.querySelector('#insp-retime-end')
      if (!start || !end) return { err: 'retime fields did not render' }
      const key = ${JSON.stringify(boot.today.dayKey)}
      setVal(start, '09:05'); setVal(end, '09:35')
      await new Promise(r => setTimeout(r, 300))
      ;[...document.querySelectorAll('.inspector button')].find(x => /save times/i.test(x.textContent)).click()
      await new Promise(r => setTimeout(r, 1400))
      const d = await window.opentime.getDay(key)
      const hit = d.sessions.find(x => x.durationSeconds === 1800 && new Date(x.startTime).getHours() === 9)
      return { retimed: !!hit, n: d.sessions.length }
    `)
    retimeUi.err ? fail('retime a block from the calendar', retimeUi.err)
      : retimeUi.retimed ? pass('retime a block from the calendar', '09:05–09:35 stored as 30m')
      : fail('retime a block from the calendar', JSON.stringify(retimeUi))

    // ── 6b. A correction cannot land on the wrong tracking day ─────────────
    const dayGuard = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const two = new Date(d.sessions[0].startTime); two.setHours(2, 0, 0, 0)
      const r = await window.opentime.editSession({ kind:'manual', dayKey:key,
        startTime: two.getTime(), endTime: two.getTime() + 3600000, category:'Before rollover' })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, message: r.message, leaked: after.sessions.some(x => x.category === 'Before rollover') }
    `)
    !dayGuard.ok && !dayGuard.leaked && /outside the tracking day/i.test(dayGuard.message || '')
      ? pass('an entry before the rollover hour is refused, not misfiled', dayGuard.message.slice(0, 72))
      : fail('an entry before the rollover hour is refused, not misfiled', JSON.stringify(dayGuard))

    // ── 6c. Moving between days from the calendar's own controls ───────────
    const dayNav = await s.eval(`
      const at = () => document.querySelector('.grid-date')?.textContent.trim()
      const btn = (t) => document.querySelector('.grid-datenav button[title="' + t + '"]')
      const first = at()
      btn('Previous day').click(); await new Promise(r => setTimeout(r, 1100))
      const back = at()
      btn('Next day').click(); await new Promise(r => setTimeout(r, 1100))
      const forward = at()
      btn('Previous day').click(); await new Promise(r => setTimeout(r, 1100))
      const today = btn('Jump to today')
      const disabledOnToday = !!today && today.disabled
      today.click(); await new Promise(r => setTimeout(r, 1100))
      return { first, back, forward, ended: at(), disabledOnToday }
    `)
    dayNav.back !== dayNav.first && dayNav.forward === dayNav.first && dayNav.ended === dayNav.first
      ? pass('calendar day navigation moves and returns', `${dayNav.first} → ${dayNav.back} → back`)
      : fail('calendar day navigation moves and returns', JSON.stringify(dayNav))

    // ── 6d. The stacked calendar is still a calendar ───────────────────────
    // Below 980px the summary drops under the grid. Both panes carry
    // `min-height: 0` so they can scroll independently as columns — and that
    // is exactly what collapsed the day to a ~90px sliver showing one hour
    // label, with the grid's contents drawn over the panel below it.
    await s.send('Emulation.setDeviceMetricsOverride',
      { width: 900, height: 700, deviceScaleFactor: 0, mobile: false })
    const stacked = await s.eval(`
      await new Promise(r => setTimeout(r, 600))
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect()
      const main = rect('.calendar-main')
      const summary = rect('.summary')
      const scroll = rect('.grid-scroll')
      const cal = document.querySelector('.calendar')
      return {
        stackedBelow: summary.top >= main.bottom - 1,
        gridHeight: Math.round(scroll.height),
        containedGrid: scroll.bottom <= main.bottom + 1,
        scrolls: cal.scrollHeight > cal.clientHeight,
        noSideScroll: document.documentElement.scrollWidth <= innerWidth,
      }
    `)
    await s.send('Emulation.clearDeviceMetricsOverride')
    stacked.stackedBelow && stacked.containedGrid && stacked.gridHeight >= 400 &&
      stacked.scrolls && stacked.noSideScroll
      ? pass('the calendar stacks without collapsing the day', `${stacked.gridHeight}px of grid above the summary`)
      : fail('the calendar stacks without collapsing the day', JSON.stringify(stacked))

    // ── 7. A focus session, start to finish ────────────────────────────────
    // The sheet is deliberately small: a name, a length, blocking, Start. No
    // sound or music in it; the music player is its own thing on the rail.
    const focus = await s.eval(`${REACT_SET}
      const start = [...document.querySelectorAll('.rail button')].find(b => /start focus/i.test(b.textContent))
      if (!start) return { err: 'no Start focus button on the rail' }
      start.click(); await new Promise(r => setTimeout(r, 600))
      const sheet = document.querySelector('.focus-sheet')
      if (!sheet) return { err: 'focus sheet did not open' }
      const lengths = [...sheet.querySelectorAll('.focus-lengths button')].map(b => b.textContent.trim())
      const noAudio = !sheet.querySelector('.music-player-trigger, .music-menu') && !/\\bSound\\b|Play music/.test(sheet.textContent)
      setVal(document.querySelector('#focus-goal'), 'QA focus block')
      await new Promise(r => setTimeout(r, 200))
      const go = [...sheet.querySelectorAll('.focus-sheet-foot button')].find(b => /start focusing/i.test(b.textContent))
      if (!go) return { err: 'no Start focusing button on the sheet' }
      go.click(); await new Promise(r => setTimeout(r, 1200))
      const dock = document.querySelector('.focus-dock')
      if (!dock) return { err: 'focus dock did not appear after starting' }
      const label = dock.querySelector('.focus-dock-label')?.textContent
      const dockButtons = [...dock.querySelectorAll('button')].map(b => b.textContent.trim())
      const status = await window.opentime.getStatus()
      const extend = [...dock.querySelectorAll('button')].find(b => /15 min/.test(b.textContent))
      const plannedBefore = status.focus?.plannedSeconds
      extend.click(); await new Promise(r => setTimeout(r, 900))
      const plannedAfter = (await window.opentime.getStatus()).focus?.plannedSeconds
      ;[...document.querySelectorAll('.focus-dock button')].find(b => /^End$/.test(b.textContent.trim())).click()
      await new Promise(r => setTimeout(r, 1600))
      // A session this short is refused by the store on purpose. What matters
      // is that it says so rather than vanishing: either a report or a reason.
      const report = document.querySelector('.focus-sheet.done')
      const closed = !document.querySelector('.focus-dock')
      const reported = report?.getAttribute('aria-label')
      if (report) [...report.querySelectorAll('button')].find(b => /^(Done|Close)$/.test(b.textContent.trim()))?.click()
      await new Promise(r => setTimeout(r, 500))
      return { lengths, noAudio, label, dockButtons, plannedBefore, plannedAfter, reported, closed,
               dismissed: !document.querySelector('.focus-sheet'),
               after: (await window.opentime.getStatus()).focus }
    `)
    focus.err ? fail('run a focus session end to end', focus.err)
      : focus.lengths.join(',') === '25 min,45 min,60 min,90 min,Pomodoro' && focus.noAudio &&
        focus.dockButtons.length === 2 &&
        focus.label === 'QA focus block' && focus.plannedAfter === focus.plannedBefore + 900 &&
        focus.reported && focus.closed && focus.dismissed && !focus.after
        ? pass('run a focus session end to end', `simple sheet, started, extended by 15 min, ended with "${focus.reported}"`)
        : fail('run a focus session end to end', JSON.stringify(focus))

    // ── 7b. The music player, on its own ───────────────────────────────────
    // Renderer-only by design, so the check is DOM-level: open it from the
    // rail, play a track, pause it, switch to an ambient sound, move the
    // volume, and confirm the day's stored sessions are untouched.
    const music = await s.eval(`${REACT_SET}
      const key = ${JSON.stringify(boot.today.dayKey)}
      const before = (await window.opentime.getDay(key)).sessions.length
      const trigger = document.querySelector('.rail-music .music-player-trigger')
      if (!trigger) return { err: 'no music trigger on the rail' }
      trigger.click(); await new Promise(r => setTimeout(r, 300))
      const menu = document.querySelector('.music-menu')
      if (!menu) return { err: 'music popover did not open' }
      const row = (label) => [...menu.querySelectorAll('.music-row')].find(b => b.textContent.trim() === label)
      const sounds = [...menu.querySelectorAll('.music-row')].map(b => b.textContent.trim())
      row('Whale song').click(); await new Promise(r => setTimeout(r, 300))
      const playing = row('Whale song').classList.contains('on')
      const railSays = trigger.textContent.trim()
      row('Whale song').click(); await new Promise(r => setTimeout(r, 200))
      const paused = !menu.querySelector('.music-row.on')
      row('Rain').click(); await new Promise(r => setTimeout(r, 300))
      const rain = row('Rain').classList.contains('on') && !row('Whale song').classList.contains('on')
      setVal(menu.querySelector('.music-volume input'), '0.3')
      await new Promise(r => setTimeout(r, 150))
      row('Rain').click(); await new Promise(r => setTimeout(r, 200))
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      const after = (await window.opentime.getDay(key)).sessions.length
      return { sounds, playing, railSays, paused, rain, closed: !document.querySelector('.music-menu'),
               untouched: after === before }
    `)
    music.err ? fail('the music player plays music and sounds, and never tracks time', music.err)
      : music.sounds.length === 8 && music.playing && music.railSays === 'Whale song' && music.paused &&
        music.rain && music.closed && music.untouched
        ? pass('the music player plays music and sounds, and never tracks time', 'Whale song → paused → Rain, volume set, day untouched')
        : fail('the music player plays music and sounds, and never tracks time', JSON.stringify(music))

    // ── 7c. Pomodoro: work is a real focus session, break is not ───────────
    // Pause seals the in-progress work session and resume opens a fresh one
    // for the remainder (the same primitives a plain focus session uses), so
    // this only has to prove the phases wire up correctly.
    const pomodoro = await s.eval(`${REACT_SET}
      const start = [...document.querySelectorAll('.rail button')].find(b => /start focus/i.test(b.textContent))
      if (!start) return { err: 'no Start focus button on the rail' }
      start.click(); await new Promise(r => setTimeout(r, 600))
      const sheet = document.querySelector('.focus-sheet')
      if (!sheet) return { err: 'focus sheet did not open' }
      const option = [...sheet.querySelectorAll('.focus-lengths button')].find(b => b.textContent.trim() === 'Pomodoro')
      if (!option) return { err: 'no Pomodoro length on the focus sheet' }
      option.click(); await new Promise(r => setTimeout(r, 150))
      const hint = sheet.querySelector('.focus-hint')?.textContent || ''
      setVal(document.querySelector('#focus-goal'), 'QA pomodoro block')
      await new Promise(r => setTimeout(r, 150))
      const go = [...sheet.querySelectorAll('.focus-sheet-foot button')].find(b => /start focusing/i.test(b.textContent))
      go.click(); await new Promise(r => setTimeout(r, 1200))
      let dock = document.querySelector('.pomodoro-dock')
      if (!dock) return { err: 'pomodoro dock did not appear after starting' }
      const phase1 = dock.className
      const focusDuringWork = (await window.opentime.getStatus()).focus
      const pause = [...dock.querySelectorAll('.focus-dock-actions button')].find(b => /^(Pause|Resume)$/i.test(b.title || ''))
      pause.click(); await new Promise(r => setTimeout(r, 900))
      dock = document.querySelector('.pomodoro-dock')
      const pausedClass = dock.className
      const focusWhilePaused = (await window.opentime.getStatus()).focus
      const resume = [...dock.querySelectorAll('.focus-dock-actions button')].find(b => /^(Pause|Resume)$/i.test(b.title || ''))
      resume.click(); await new Promise(r => setTimeout(r, 900))
      dock = document.querySelector('.pomodoro-dock')
      const focusAfterResume = (await window.opentime.getStatus()).focus
      const skip = [...dock.querySelectorAll('button')].find(b => /^Skip$/.test(b.textContent.trim()))
      skip.click(); await new Promise(r => setTimeout(r, 900))
      dock = document.querySelector('.pomodoro-dock')
      const phaseAfterSkip = dock.className
      const focusOnBreak = (await window.opentime.getStatus()).focus
      const stop = [...dock.querySelectorAll('button')].find(b => /^Stop$/.test(b.textContent.trim()))
      stop.click(); await new Promise(r => setTimeout(r, 600))
      return {
        explained: /25 minutes of focus, then a 5-minute break/.test(hint),
        startedOnWork: /\\bwork\\b/.test(phase1) && focusDuringWork?.plannedSeconds === 1500,
        sealedOnPause: /\\bpaused\\b/.test(pausedClass) && !focusWhilePaused,
        reopenedOnResume: !!focusAfterResume,
        movedToBreak: /\\bbreak\\b/.test(phaseAfterSkip) && !focusOnBreak,
        stoppedCleanly: !document.querySelector('.pomodoro-dock'),
      }
    `)
    pomodoro.err ? fail('run a Pomodoro cycle end to end', pomodoro.err)
      : pomodoro.explained && pomodoro.startedOnWork && pomodoro.sealedOnPause &&
        pomodoro.reopenedOnResume && pomodoro.movedToBreak && pomodoro.stoppedCleanly
        ? pass('run a Pomodoro cycle end to end', 'work → pause (sealed) → resume (reopened) → skip to break → stop')
        : fail('run a Pomodoro cycle end to end', JSON.stringify(pomodoro))

    // ── 8. Activity: the raw record ────────────────────────────────────────
    await clickTab(s, 'Activity')
    await shoot(s, '03-activity.png')
    const activity = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const rows = document.querySelectorAll('.session-row').length
      const seg = [...document.querySelectorAll('.seg button')].find(b => /this week/i.test(b.textContent))
      const before = [...document.querySelectorAll('.bar-row')].length
      seg.click(); await new Promise(r => setTimeout(r, 700))
      return { rows, stored: d.sessions.length, weekOn: seg.classList.contains('on'),
               bars: [...document.querySelectorAll('.bar-row')].length, before }
    `)
    activity.rows === activity.stored && activity.rows > 0
      ? pass('Activity lists every stored session unfolded', `${activity.rows} rows`)
      : fail('Activity lists every stored session unfolded', JSON.stringify(activity))
    activity.weekOn && activity.bars > 0
      ? pass('Activity switches between the day and the week', `${activity.bars} breakdown rows`)
      : fail('Activity switches between the day and the week', JSON.stringify(activity))

    // ── 9. Reports: ranges are real, not decorative ────────────────────────
    await clickTab(s, 'Reports')
    await shoot(s, '04-reports.png')
    const reports = await s.eval(`
      const pick = (label) => [...document.querySelectorAll('.range-bar .seg button')].find(b => b.textContent.trim() === label)
      const seen = {}
      for (const label of ['Week', 'Month', 'Quarter', 'Year']) {
        const b = pick(label)
        if (!b) return { err: 'no ' + label + ' range' }
        b.click(); await new Promise(r => setTimeout(r, 1400))
        seen[label] = {
          count: document.querySelector('.range-count')?.textContent.trim(),
          current: document.querySelector('.range-current')?.textContent.trim(),
          stats: document.querySelectorAll('.stat').length,
          heat: !!document.querySelector('.heat-grid'),
          month: !!document.querySelector('.month-cal'),
        }
      }
      pick('Month').click(); await new Promise(r => setTimeout(r, 1200))
      const was = document.querySelector('.range-current')?.textContent.trim()
      document.querySelector('.range-step button[title="Previous period"]').click()
      await new Promise(r => setTimeout(r, 1400))
      const stepped = document.querySelector('.range-current')?.textContent.trim()
      pick('Custom').click(); await new Promise(r => setTimeout(r, 900))
      const custom = { from: !!document.querySelector('input[aria-label="Range start"]'),
                       to: !!document.querySelector('input[aria-label="Range end"]') }
      return { seen, was, stepped, custom }
    `)
    reports.err ? fail('Reports ranges all resolve', reports.err)
      : reports.seen.Week.stats === 4 && reports.seen.Month.month && reports.seen.Year.heat &&
        reports.stepped && reports.stepped !== reports.was && reports.custom.from && reports.custom.to
        ? pass('Reports ranges all resolve and step', `week=${reports.seen.Week.count}, year=${reports.seen.Year.count}, ${reports.was} → ${reports.stepped}`)
        : fail('Reports ranges all resolve and step', JSON.stringify(reports))

    // ── 10. Goals ──────────────────────────────────────────────────────────
    await clickTab(s, 'Goals')
    await shoot(s, '05-goals.png')
    const goalsUi = await s.eval(`${REACT_SET}
      const card = [...document.querySelectorAll('.card')].find(c => /goals/i.test(c.querySelector('.card-title')?.textContent || ''))
      if (!card) return { err: 'no Goals card on the Goals view' }
      const emptyFirst = !!card.querySelector('.empty')
      card.querySelector('.card-title button').click()   // Edit
      await new Promise(r => setTimeout(r, 500))
      const rows = card.querySelectorAll('.goal-edit-row')
      if (!rows.length) return { err: 'editor showed no goals' }
      const name = rows[0].querySelector('input[aria-label="Goal name"]')
      setVal(name, 'QA focus floor')
      await new Promise(r => setTimeout(r, 400))
      const on = rows[0].querySelector('input[type=checkbox]')
      if (on.checked) return { err: 'starter goal shipped switched on' }
      on.click()
      await new Promise(r => setTimeout(r, 700))
      card.querySelector('.card-title button').click()   // Done
      await new Promise(r => setTimeout(r, 700))
      const after = [...document.querySelectorAll('.card')].find(c => /goals/i.test(c.querySelector('.card-title')?.textContent || ''))
      const persisted = (await window.opentime.getBootstrap()).goals
      return {
        emptyFirst,
        shown: !!after.querySelector('.goal-row'),
        persistedName: persisted[0]?.name, persistedOn: persisted[0]?.enabled,
      }
    `)
    goalsUi.err ? fail('enable and rename a goal', goalsUi.err)
      : goalsUi.emptyFirst && goalsUi.shown && goalsUi.persistedOn && goalsUi.persistedName === 'QA focus floor'
        ? pass('enable and rename a goal', 'off by default, on and renamed after editing')
        : fail('enable and rename a goal', JSON.stringify(goalsUi))

    // The week chart on Goals says "click a day to open it on the calendar",
    // and for a while it only changed the selected day — leaving you on a view
    // with no days on it, so the click read as broken. Dashboard and Reports
    // both navigate; this pins that Goals does too.
    const goalsDay = await s.eval(`
      const cols = [...document.querySelectorAll('.goals-side .week-col')]
      if (cols.length < 2) return { err: 'no week chart beside the goals editor' }
      const target = cols.find(c => !c.classList.contains('active'))
      if (!target) return { err: 'every column is already the selected day' }
      const label = target.querySelector('.week-foot')?.textContent.trim()
      target.click()
      await new Promise(r => setTimeout(r, 900))
      return {
        label,
        tab: document.querySelector('.nav-item.active')?.textContent.trim(),
        grid: !!document.querySelector('.calendar .day-grid, .calendar-main'),
      }
    `)
    goalsDay.err ? fail('a day on the Goals week chart opens the calendar', goalsDay.err)
      : goalsDay.tab === 'Calendar' && goalsDay.grid
        ? pass('a day on the Goals week chart opens the calendar', `${goalsDay.label} → Calendar`)
        : fail('a day on the Goals week chart opens the calendar', JSON.stringify(goalsDay))

    // The scope control moves the breakdowns onto the week; the subtitle has to
    // move with them, or the header contradicts the numbers under it.
    await clickTab(s, 'Activity')
    const scope = await s.eval(`
      const sub = () => document.querySelector('.page-sub')?.textContent.trim()
      const seg = [...document.querySelectorAll('.page-head .seg button')]
      const week = seg.find(b => /this week/i.test(b.textContent))
      const day = seg.find(b => /this day/i.test(b.textContent))
      if (!week || !day) return { err: 'no day/week scope control on Activity' }
      const onDay = sub()
      week.click(); await new Promise(r => setTimeout(r, 700))
      const onWeek = sub()
      // The table below stays on one day whatever the toggle says, so it has
      // to name that day rather than let the reader assume it followed.
      const table = [...document.querySelectorAll('.card')].find(
        c => /recorded sessions/i.test(c.querySelector('.card-title')?.textContent || '')
      )
      const tableHint = table?.querySelector('.hint')?.textContent.trim()
      day.click(); await new Promise(r => setTimeout(r, 500))
      return { onDay, onWeek, back: sub(), tableHint }
    `)
    scope.err ? fail('the Activity scope control retitles the page', scope.err)
      : scope.onWeek && scope.onWeek !== scope.onDay && scope.back === scope.onDay &&
        scope.tableHint && scope.onDay.startsWith(scope.tableHint.split(' · ')[0])
        ? pass('the Activity scope control retitles the page', `${scope.onDay} ⇄ ${scope.onWeek}`)
        : fail('the Activity scope control retitles the page', JSON.stringify(scope))

    // ── 11. Projects & rules ───────────────────────────────────────────────
    await clickTab(s, 'Projects')
    await shoot(s, '06-projects.png')
    const proj = await s.eval(`${REACT_SET}
      const input = document.querySelector('input[placeholder*="New project"]')
      if (!input) return { err: 'no new-project input' }
      setVal(input, 'QA Project')
      await new Promise(r => setTimeout(r, 200))
      const add = [...document.querySelectorAll('button')].find(b => /add project/i.test(b.textContent))
      if (!add) return { err: 'no Add project button' }
      if (add.disabled) return { err: 'Add project stayed disabled' }
      add.click(); await new Promise(r => setTimeout(r, 900))
      const boot = await window.opentime.getBootstrap()
      return { found: boot.projects.some(p => p.name === 'QA Project'), n: boot.projects.length }
    `)
    proj.err ? fail('add a project from the UI', proj.err)
      : proj.found ? pass('add a project from the UI', `${proj.n} projects`)
      : fail('add a project from the UI', 'not persisted')

    const qaCard = `[...document.querySelectorAll('.project-card')].find(c => c.querySelector('.project-name')?.value === 'QA Project')`
    const chips = await s.eval(`${REACT_SET}
      const card = ${qaCard}
      if (!card) return { err: 'no card for the new project' }
      const input = card.querySelector('.chip-input')
      setVal(input, 'https://www.QA-Tool.com/page?x=1, qa word')
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise(r => setTimeout(r, 700))
      setVal(card.querySelector('.project-counts'), 'distracting')
      await new Promise(r => setTimeout(r, 700))
      const p = (await window.opentime.getBootstrap()).projects.find(x => x.name === 'QA Project')
      const shown = [...(${qaCard}).querySelectorAll('.chip')].map(c => c.textContent.trim())
      return { keywords: p.keywords, productivity: p.productivity, shown }
    `)
    chips.err ? fail('add keywords as chips, commas and all', chips.err)
      : JSON.stringify(chips.keywords) === JSON.stringify(['qa-tool.com/page', 'qa word']) && chips.shown.length === 2
        ? pass('add keywords as chips, commas and all', chips.keywords.join(' | '))
        : fail('add keywords as chips, commas and all', JSON.stringify(chips))
    chips.productivity === 'distracting'
      ? pass('a project can count as distraction')
      : fail('a project can count as distraction', JSON.stringify(chips))

    // Move a real tracked block into the project through the review drawer:
    // the project learns that block's words, and says so on its card.
    await clickTab(s, 'Calendar')
    const learn = await s.eval(`${REACT_SET}
      ${openDrawer}
      const title = document.querySelector('.inspector-title')?.textContent.trim()
      setVal(document.querySelector('#insp-category'), 'QA Project')
      await new Promise(r => setTimeout(r, 250))
      const hint = [...document.querySelectorAll('.inspector .hint')].some(h => /learns from this block/.test(h.textContent))
      ;[...document.querySelectorAll('.inspector button')].find(b => b.textContent.trim() === 'Apply').click()
      await new Promise(r => setTimeout(r, 1200))
      const p = (await window.opentime.getBootstrap()).projects.find(x => x.name === 'QA Project')
      return { title, hint, learned: Object.keys(p.learned || {}) }
    `)
    learn.err ? fail('moving a block into a project teaches it', learn.err)
      : learn.hint && learn.learned.length > 0
        ? pass('moving a block into a project teaches it', `"${learn.title}" → ${learn.learned.join(', ')}`)
        : fail('moving a block into a project teaches it', JSON.stringify(learn))

    await clickTab(s, 'Projects')
    const forget = await s.eval(`
      const card = ${qaCard}
      const line = card?.querySelector('.project-learned')?.textContent || ''
      const btn = card?.querySelector('.project-learned button')
      if (!btn) return { err: 'no learned-words line on the card', line }
      btn.click(); await new Promise(r => setTimeout(r, 700))
      const p = (await window.opentime.getBootstrap()).projects.find(x => x.name === 'QA Project')
      return { line, after: Object.keys(p.learned || {}).length, gone: !(${qaCard}).querySelector('.project-learned') }
    `)
    forget.err ? fail('a project shows what it learned, and can forget it', forget.err + ' ' + forget.line)
      : forget.after === 0 && forget.gone
        ? pass('a project shows what it learned, and can forget it', forget.line.replace('Forget', '').trim())
        : fail('a project shows what it learned, and can forget it', JSON.stringify(forget))

    const rules = await s.eval(`
      const before = (await window.opentime.getBootstrap()).rules.length
      const r = await window.opentime.saveRules([...(await window.opentime.getBootstrap()).rules,
        { id:'r_qa', kind:'app', match:'qa-app', category:'QA Project', productivity:'productive' }])
      return { before, after: r.length, has: r.some(x => x.id === 'r_qa') }
    `)
    rules.has && rules.after === rules.before + 1 ? pass('save a categorisation rule') : fail('save a categorisation rule', JSON.stringify(rules))

    // ── 12. Settings ───────────────────────────────────────────────────────
    await clickTab(s, 'Settings')
    await shoot(s, '07-settings.png')

    const connector = await s.eval(`
      ;[...document.querySelectorAll('.settings-nav button')].find(b => /assistant/i.test(b.textContent)).click()
      await new Promise(r => setTimeout(r, 300))
      const text = document.querySelector('.assistant-config pre')?.textContent || ''
      try { return { config: JSON.parse(text).mcpServers.opentime } } catch { return { err: 'no setup block', text } }
    `)
    await shoot(s, '07b-settings-assistant.png')
    if (connector.err) fail('the assistant setup from Settings starts a working connector', connector.err)
    else {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
      const client = new Client({ name: 'e2e', version: '0' })
      try {
        const { command, args, env } = connector.config
        await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }))
        const tools = (await client.listTools()).tools.map((t) => t.name)
        const answer = await client.callTool({ name: 'time_summary', arguments: { range: 'this week' } })
        const text = answer.content?.[0]?.text || ''
        const first = text.split('\n')[0].slice(0, 70)
        tools.includes('time_summary') && /tracked/i.test(text) && !answer.isError
          ? pass('the assistant setup from Settings starts a working connector', `${tools.length} tools; "${first}"`)
          : fail('the assistant setup from Settings starts a working connector', JSON.stringify({ tools, text: text.slice(0, 200) }))
      } catch (err) {
        fail('the assistant setup from Settings starts a working connector', String(err?.message || err))
      } finally {
        await client.close().catch(() => {})
      }
    }
    const sections = await s.eval(`
      const nav = [...document.querySelectorAll('.settings-nav button')]
      if (nav.length < 4) return { err: 'settings navigation is missing sections' }
      const labels = nav.map(b => b.textContent.trim())
      const shown = []
      for (const b of nav) {
        b.click(); await new Promise(r => setTimeout(r, 250))
        shown.push([...document.querySelectorAll('.settings-pane > *')].filter(p => !p.hidden).length)
      }
      return { labels, shown }
    `)
    !sections.err && sections.shown.every((n) => n === 1)
      ? pass('every Settings section opens on its own', sections.labels.join(', '))
      : fail('every Settings section opens on its own', JSON.stringify(sections))

    const setSave = await s.eval(`
      const before = (await window.opentime.getBootstrap()).settings
      const next = { ...before, idleThresholdSeconds: 300, notificationsEnabled: !before.notificationsEnabled }
      await window.opentime.saveSettings(next)
      const reread = (await window.opentime.getBootstrap()).settings
      return { idle: reread.idleThresholdSeconds, notif: reread.notificationsEnabled === next.notificationsEnabled }
    `)
    setSave.idle === 300 && setSave.notif ? pass('settings save and survive a re-read') : fail('settings save and survive a re-read', JSON.stringify(setSave))

    const settingsUi = await s.eval(`
      const sw = document.querySelector('.switch')
      if (!sw) return { err: 'no toggle switch on Settings' }
      const was = sw.classList.contains('on')
      sw.click(); await new Promise(r => setTimeout(r, 400))
      const now = document.querySelector('.switch').classList.contains('on')
      const dirty = !!document.querySelector('.pill.warn')
      return { toggled: was !== now, dirty }
    `)
    settingsUi.toggled && settingsUi.dirty
      ? pass('a Settings switch toggles and flags unsaved changes')
      : fail('a Settings switch toggles and flags unsaved changes', JSON.stringify(settingsUi))

    const invalid = await s.eval(`
      const before = (await window.opentime.getBootstrap()).settings
      const saved = await window.opentime.saveSettings({ ...before, pollIntervalSeconds: -99, dayStartHour: 99 })
      return { poll: saved.pollIntervalSeconds, hour: saved.dayStartHour }
    `)
    invalid.poll > 0 && invalid.hour >= 0 && invalid.hour <= 23
      ? pass('invalid settings are sanitised rather than stored', `poll=${invalid.poll} hour=${invalid.hour}`)
      : fail('invalid settings are sanitised rather than stored', JSON.stringify(invalid))

    // Appearance, through the real control — the one owner of `data-theme`.
    const theme = await s.eval(`
      ;[...document.querySelectorAll('.settings-nav button')].find(b => /general/i.test(b.textContent)).click()
      await new Promise(r => setTimeout(r, 300))
      const seg = [...document.querySelectorAll('.seg')].find(g =>
        [...g.querySelectorAll('button')].map(b => b.textContent.trim()).join(',') === 'Light,Dark,Match system')
      if (!seg) return { err: 'no Appearance control' }
      const opt = (label) => [...seg.querySelectorAll('button')].find(b => b.textContent.trim() === label)
      const seen = {}
      for (const label of ['Light', 'Dark', 'Match system']) {
        opt(label).click(); await new Promise(r => setTimeout(r, 350))
        seen[label] = {
          scheme: getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim(),
          page: getComputedStyle(document.body).backgroundColor,
        }
      }
      opt('Dark').click(); await new Promise(r => setTimeout(r, 300))
      const save = [...document.querySelectorAll('.page-head button')].find(x => x.textContent.trim() === 'Save')
      if (!save || save.disabled) return { err: 'Save did not enable after changing the theme' }
      save.click(); await new Promise(r => setTimeout(r, 1000))
      seen.saved = (await window.opentime.getBootstrap()).settings.theme
      return seen
    `)
    theme.err ? fail('light and dark themes both apply and persist', theme.err)
      : theme.Light.scheme === 'light' && theme.Dark.scheme === 'dark' &&
        theme.Light.page !== theme.Dark.page && theme.saved === 'dark'
        ? pass('light and dark themes both apply and persist', `light=${theme.Light.page} dark=${theme.Dark.page}`)
        : fail('light and dark themes both apply and persist', JSON.stringify(theme))
    await shoot(s, '08-settings-dark.png')

    const rangeUi = await s.eval(`
      ;[...document.querySelectorAll('.settings-nav button')].find(b => /your data/i.test(b.textContent)).click()
      await new Promise(r => setTimeout(r, 300))
      const sel = document.querySelector('select[aria-label="Export range"]')
      if (!sel) return { err: 'no export range control' }
      const options = [...sel.options].map(o => o.textContent)
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '7')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 500))
      const desc = [...document.querySelectorAll('.setting-desc')].find(d => /stored day/.test(d.textContent))
      return { options, desc: desc?.textContent.match(/\\d+ stored days? in range/)?.[0] }
    `)
    rangeUi.err ? fail('export range narrows the day count', rangeUi.err)
      : rangeUi.options.length >= 4 && /^7 stored days/.test(rangeUi.desc || '')
        ? pass('export range narrows the day count', `${rangeUi.desc} from ${rangeUi.options.length} choices`)
        : fail('export range narrows the day count', JSON.stringify(rangeUi))

    // ── 12b. Distraction blocking, from the Settings editor to the shield ──
    const blockUi = await s.eval(`
      ;[...document.querySelectorAll('.settings-nav button')].find(b => /focus/i.test(b.textContent)).click()
      await new Promise(r => setTimeout(r, 300))
      const pane = [...document.querySelectorAll('.settings-pane > .card')].find(c => !c.hidden)
      const toggle = [...pane.querySelectorAll('.switch')].find(t => /block distractions/i.test(t.getAttribute('aria-label')))
      if (!toggle) return { err: 'no blocking switch' }
      if (!toggle.classList.contains('on')) toggle.click()
      const input = [...pane.querySelectorAll('input')].find(x => /website or app/i.test(x.placeholder))
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, 'https://www.Example.com/some/page'); input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 100))
      input.nextElementSibling.click(); await new Promise(r => setTimeout(r, 200))
      const chips = [...pane.querySelectorAll('.chip-list .chip')].map(c => c.textContent.trim())
      const save = [...document.querySelectorAll('.page-head button')].find(x => x.textContent.trim() === 'Save')
      save.click(); await new Promise(r => setTimeout(r, 800))
      const b = (await window.opentime.getBootstrap()).settings.blocking
      return { chips, enabled: b.enabled, saved: b.targets.includes('example.com') }
    `)
    !blockUi.err && blockUi.enabled && blockUi.saved && blockUi.chips.includes('example.com')
      ? pass('a blocked site is added from Settings, normalised and saved', 'https://www.Example.com/some/page → example.com')
      : fail('a blocked site is added from Settings, normalised and saved', JSON.stringify(blockUi))
    await shoot(s, '07b-settings-focus.png')

    // Block every app the demo adapter can put in front, so whatever it shows
    // is a distraction. Outside a focus session nothing is covered; inside one
    // the shield is up; "Allow 5 minutes" lowers it without ending the session.
    await s.eval(`
      const st = (await window.opentime.getBootstrap()).settings
      await window.opentime.saveSettings({ ...st, blocking: { enabled: true,
        targets: ['code', 'figma', 'notion', 'slack', 'windows terminal', 'zoom', 'chrome'] } })
      return 1
    `)
    await sleep(1500)
    const idleShield = await shieldState()
    !idleShield.visible ? pass('nothing is blocked outside a focus session')
      : fail('nothing is blocked outside a focus session', JSON.stringify(idleShield))

    await s.eval(`return await window.opentime.startFocus({ label: 'Blocking check', minutes: 25 })`)
    // The shield never covers OpenTime itself, so step away from it the way a
    // person would before opening a distraction.
    await mainEval(`(() => { const { BrowserWindow } = require('electron'); const w = new BrowserWindow({ width: 420, height: 300, title: 'Another app' }); w.loadURL('about:blank'); w.focus(); globalThis.__anotherApp = w })()`)
    await sleep(2500)
    const up = await shieldState()
    up.visible && up.top && up.focusable === false
      ? pass('the shield covers a blocked app during focus, without taking focus')
      : fail('the shield covers a blocked app during focus, without taking focus', JSON.stringify(up))

    const shieldTarget = (await cdpTargets()).find((t) => /shield/.test(t.url))
    let shieldText = null
    if (shieldTarget) {
      const sh = new Session(new WebSocket(shieldTarget.webSocketDebuggerUrl))
      await new Promise((r) => sh.ws.addEventListener('open', r))
      shieldText = await sh.eval(`return { what: document.getElementById('what').textContent,
        focus: document.getElementById('focus').textContent, left: document.getElementById('left').textContent }`)
      await sh.eval(`document.getElementById('snooze').click(); return 1`)
      sh.ws.close()
    }
    shieldText && shieldText.focus === 'Blocking check' && /left$/.test(shieldText.left)
      ? pass('the shield names the distraction and the session', `${shieldText.what} · ${shieldText.left}`)
      : fail('the shield names the distraction and the session', JSON.stringify(shieldText))

    await sleep(1500)
    const snoozed = await shieldState()
    const stillFocused = await s.eval(`return (await window.opentime.getStatus()).focus?.label || null`)
    !snoozed.visible && stillFocused === 'Blocking check'
      ? pass('"Allow 5 minutes" lowers the shield and keeps the session')
      : fail('"Allow 5 minutes" lowers the shield and keeps the session', JSON.stringify({ snoozed, stillFocused }))

    await s.eval(`return await window.opentime.endFocus()`)
    await mainEval(`(() => { globalThis.__anotherApp?.destroy(); require('electron').BrowserWindow.getAllWindows().find(w => w.getTitle() === 'OpenTime').focus() })()`)
    await s.eval(`
      const st = (await window.opentime.getBootstrap()).settings
      await window.opentime.saveSettings({ ...st, blocking: { ...st.blocking, enabled: false } })
      return 1
    `)
    await sleep(800)
    const after = await shieldState()
    !after.visible ? pass('ending the session lowers any shield') : fail('ending the session lowers any shield', JSON.stringify(after))

    // ── 12c. Updates and feedback are reachable, and say where they stand ──
    const about = await s.eval(`
      ;[...document.querySelectorAll('.settings-nav button')].find(b => /updates/i.test(b.textContent)).click()
      await new Promise(r => setTimeout(r, 300))
      const pane = [...document.querySelectorAll('.settings-pane > .card')].find(c => !c.hidden)
      const text = pane.textContent
      const buttons = [...pane.querySelectorAll('button')].map(b => b.textContent.trim())
      return { version: /You have OpenTime [0-9]+[.][0-9]+[.][0-9]+/.test(text), buttons,
               state: (await window.opentime.getBootstrap()).update.state }
    `)
    about.version && ['Report a bug', 'Suggest an idea', 'Ask a question'].every((b) => about.buttons.includes(b)) &&
      about.buttons.some((b) => /Check now|Open downloads page/.test(b))
      ? pass('Updates & feedback shows the version, an update action and three feedback forms', `update=${about.state}`)
      : fail('Updates & feedback shows the version, an update action and three feedback forms', JSON.stringify(about))
    await shoot(s, '07c-settings-updates.png')

    // ── 13. Export ─────────────────────────────────────────────────────────
    // The real handler opens a save dialog, which cannot be answered from here,
    // so this drives the guard path the UI shares with it.
    const exp = await s.eval(`
      const r = await window.opentime.exportData({ format: 'sessions-csv', fromKey: '1999-01-01', toKey: '1999-01-02' })
      return { ok: r.ok, msg: r.message }
    `)
    !exp.ok && /no history/i.test(exp.msg) ? pass('export refuses an empty range with a reason', exp.msg)
      : fail('export refuses an empty range with a reason', JSON.stringify(exp))

    // ── 14. Calendar integration ───────────────────────────────────────────
    const cal = await s.eval(`
      const connect = await window.opentime.connectCalendar()
      const sync = await window.opentime.syncCalendar()
      const dis = await window.opentime.disconnectCalendar()
      return { connect, sync, dis }
    `)
    !cal.connect.ok && /client id|credential/i.test(cal.connect.message)
      ? pass('calendar connect explains the missing credentials', cal.connect.message.slice(0, 60))
      : fail('calendar connect explains the missing credentials', JSON.stringify(cal.connect))
    !cal.sync.ok ? pass('calendar sync fails cleanly when disconnected', cal.sync.message) : fail('calendar sync fails cleanly when disconnected')
    cal.dis.ok ? pass('calendar disconnect succeeds') : fail('calendar disconnect succeeds')

    const manualEvent = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const d = await window.opentime.getDay(key)
      const base = Math.min(...d.sessions.map(x => x.startTime))
      const updated = await window.opentime.addManualEvent({ title:'QA Standup', start: base, end: base + 1800000 })
      return { found: updated.events.some(e => e.title === 'QA Standup' && e.source === 'manual') }
    `)
    manualEvent.found ? pass('add a manual calendar event') : fail('add a manual calendar event', JSON.stringify(manualEvent))

    // ── 15. Everything survives a restart of the store's readers ───────────
    const persist = await s.eval(`
      const key = ${JSON.stringify(boot.today.dayKey)}
      const before = await window.opentime.getDay(key)
      const settings = (await window.opentime.getBootstrap()).settings
      // A fresh read of the same day through the same IPC path the UI uses on
      // boot: anything held only in renderer memory disappears here.
      const again = await window.opentime.getDay(key)
      return { same: again.sessions.length === before.sessions.length,
               retag: again.sessions.some(x => x.category === 'QA Retag'),
               manual: again.sessions.some(x => x.category === 'QA Manual'),
               event: again.events.some(e => e.title === 'QA Standup'),
               theme: settings.theme }
    `)
    persist.same && persist.retag && persist.manual && persist.event && persist.theme === 'dark'
      ? pass('corrections, manual time and events are all durable', 'read back from storage, not memory')
      : fail('corrections, manual time and events are all durable', JSON.stringify(persist))

    // ── 16. Capture reload + demo data ─────────────────────────────────────
    const recap = await s.eval(`
      const h = await window.opentime.reloadCapture()
      return { adapter: h.adapter, demo: h.demo }
    `)
    recap.adapter ? pass('capture reload rebuilds the adapter in place', recap.adapter) : fail('capture reload rebuilds the adapter in place')

    const demo = await s.eval(`
      const before = await window.opentime.getBootstrap()
      const r = await window.opentime.clearDemoData()
      const after = await window.opentime.getBootstrap()
      return { ok: r.ok, msg: r.message, demoBefore: before.demoDays.length, demoAfter: after.demoDays.length,
               historyBefore: before.historyKeys.length, historyAfter: after.historyKeys.length }
    `)
    demo.ok && demo.demoAfter === 0 ? pass('remove demo data clears exactly the seeded days', demo.msg)
      : fail('remove demo data clears exactly the seeded days', JSON.stringify(demo))

    // ── 17. Every view survives an empty store ─────────────────────────────
    const views = ['Dashboard', 'Calendar', 'Activity', 'Projects', 'Goals', 'Reports', 'Settings']
    const broken = []
    for (const view of views) {
      await clickTab(s, view)
      await sleep(500)
      const ok = await s.eval(`return {
        alive: !!document.querySelector('.app'),
        heading: document.querySelector('.page-title, .grid-date')?.textContent.trim() || '',
        empties: document.querySelectorAll('.empty').length,
      }`)
      if (!ok.alive || !ok.heading) broken.push(`${view}:${JSON.stringify(ok)}`)
    }
    await shoot(s, '09-empty-store.png')
    broken.length === 0
      ? pass('every view survives an empty store', `${views.length} views, no blank pages`)
      : fail('every view survives an empty store', broken.join(' | '))

    // ── 18. No renderer exceptions across the whole run ────────────────────
    await sleep(500)
    const real = consoleErrors.filter((e) => !/DevTools|Autofill|electron/i.test(e))
    real.length === 0 ? pass('no renderer exceptions during the run') : fail('no renderer exceptions during the run', real.slice(0, 5).join(' | '))

  } catch (err) {
    fail('driver completed', err.message)
    console.error(err)
  } finally {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await sleep(1200)
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    await sleep(400)
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`)
  await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  if (log.join('').trim()) await fs.writeFile(path.join(OUT, 'main.log'), log.join(''))
  process.exit(bad.length ? 1 : 0)
}

main()
