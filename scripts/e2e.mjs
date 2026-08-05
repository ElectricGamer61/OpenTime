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

const results = []
const pass = (n, d = '') => { results.push({ ok: true, n, d }); console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`) }
const fail = (n, d = '') => { results.push({ ok: false, n, d }); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const r = await s.send('Page.captureScreenshot', { format: 'png' })
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
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
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
    ['.', `--user-data-dir=${USER_DATA}`, '--disable-gpu',
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
    if (hadOnboard) {
      await shoot(s, '00-onboarding.png')
      const done = await s.eval(`
        const b = [...document.querySelectorAll('.onboard button')].pop()
        if (!b) return false
        b.click(); await new Promise(r => setTimeout(r, 800)); return !document.querySelector('.onboard')
      `)
      done ? pass('onboarding completes and dismisses') : fail('onboarding completes and dismisses')
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
    await clickTab(s, 'Today')
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

    // ── 2. Today view renders its parts ────────────────────────────────────
    await clickTab(s, 'Today')
    await shoot(s, '01-today.png')
    const today = await s.eval(`return {
      stats: document.querySelectorAll('.stat').length,
      blocks: document.querySelectorAll('.timeline .block').length,
      cards: [...document.querySelectorAll('.card-title')].map(x => x.textContent.replace(/Click.*/, '').trim()),
      ring: !!document.querySelector('.ring-center'),
    }`)
    today.stats === 4 ? pass('Today shows four stat tiles') : fail('Today shows four stat tiles', String(today.stats))
    today.blocks > 0 ? pass('timeline renders blocks', `${today.blocks} blocks`) : fail('timeline renders blocks')
    today.ring ? pass('focus ring renders') : fail('focus ring renders')

    // ── 3. Correction: retag a block through the UI ────────────────────────
    const retag = await s.eval(`${REACT_SET}
      const block = [...document.querySelectorAll('.timeline .block:not(.idle)')].find(b => b.offsetHeight > 30)
      if (!block) return { err: 'no session block tall enough to click' }
      block.click(); await new Promise(r => setTimeout(r, 600))
      const input = document.querySelector('#insp-category')
      if (!input) return { err: 'inspector did not open' }
      setVal(input, 'QA Retag')
      await new Promise(r => setTimeout(r, 200))
      const apply = [...document.querySelectorAll('.inspector button')].find(b => b.textContent.trim() === 'Apply')
      if (!apply) return { err: 'no Apply button' }
      if (apply.disabled) return { err: 'Apply stayed disabled after editing the category' }
      apply.click(); await new Promise(r => setTimeout(r, 1200))
      const day = await window.opentime.getDay(${JSON.stringify(boot.today.dayKey)})
      return { hit: day.sessions.filter(x => x.category === 'QA Retag').length }
    `)
    retag.err ? fail('retag a block from the timeline', retag.err)
              : retag.hit > 0 ? pass('retag a block from the timeline', `${retag.hit} session(s) relabelled`)
              : fail('retag a block from the timeline', 'category did not persist')

    // ── 4. Correction: split ───────────────────────────────────────────────
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

    // ── 5. Correction: merge ───────────────────────────────────────────────
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

    // ── 6. Correction: retime, delete, manual, claim-idle ──────────────────
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
      const r = await window.opentime.editSession({ kind:'claim-idle', dayKey:key, idleStart:b.startTime,
        category:'QA Claimed', productivity:'productive' })
      const after = await window.opentime.getDay(key)
      return { ok: r.ok, msg: r.message,
        gone: !after.idle.some(x => x.startTime === b.startTime),
        added: after.sessions.some(x => x.category === 'QA Claimed') }
    `)
    claim.skip ? pass('claim an away block', 'skipped: no idle block')
      : claim.ok && claim.gone && claim.added ? pass('claim an away block', 'block replaced, not double-counted')
      : fail('claim an away block', JSON.stringify(claim))

    // ── 6b. Merge and retime, from the UI ──────────────────────────────────
    await clickTab(s, 'Today')
    const mergeUi = await s.eval(`
      const tall = () => [...document.querySelectorAll('.timeline .block:not(.idle):not(.cluster)')].filter(b => b.offsetHeight > 25)
      const bs = tall()
      if (bs.length < 2) return { err: 'not enough blocks to merge' }
      bs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 500))
      bs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      await new Promise(r => setTimeout(r, 600))
      const title = document.querySelector('.inspector-title')?.textContent
      const marked = document.querySelectorAll('.timeline .block.selected').length
      const key = ${JSON.stringify(boot.today.dayKey)}
      const before = (await window.opentime.getDay(key)).sessions.length
      const go = [...document.querySelectorAll('.inspector button')].find(b => /merge into one/i.test(b.textContent))
      if (!go) return { err: 'no merge button after ctrl-click' }
      go.click(); await new Promise(r => setTimeout(r, 1200))
      const after = (await window.opentime.getDay(key)).sessions.length
      return { title, marked, before, after }
    `)
    mergeUi.err ? fail('merge two blocks by ctrl-clicking the timeline', mergeUi.err)
      : mergeUi.marked === 2 && mergeUi.after === mergeUi.before - 1
        ? pass('merge two blocks by ctrl-clicking the timeline', `${mergeUi.title}, ${mergeUi.before} -> ${mergeUi.after}`)
        : fail('merge two blocks by ctrl-clicking the timeline', JSON.stringify(mergeUi))

    const retimeUi = await s.eval(`${REACT_SET}
      const b = [...document.querySelectorAll('.timeline .block:not(.idle):not(.cluster)')].find(x => x.offsetHeight > 30)
      b.click(); await new Promise(r => setTimeout(r, 600))
      const open = [...document.querySelectorAll('.inspector button')].find(x => /retime/i.test(x.textContent))
      if (!open) return { err: 'no Retime action' }
      open.click(); await new Promise(r => setTimeout(r, 400))
      const start = document.querySelector('#insp-retime-start'), end = document.querySelector('#insp-retime-end')
      if (!start || !end) return { err: 'retime fields did not render' }
      const key = ${JSON.stringify(boot.today.dayKey)}
      const was = (await window.opentime.getDay(key)).sessions.length
      setVal(start, '09:05'); setVal(end, '09:35')
      await new Promise(r => setTimeout(r, 300))
      ;[...document.querySelectorAll('.inspector button')].find(x => /save times/i.test(x.textContent)).click()
      await new Promise(r => setTimeout(r, 1200))
      const d = await window.opentime.getDay(key)
      const hit = d.sessions.find(x => x.durationSeconds === 1800 && new Date(x.startTime).getHours() === 9)
      return { was, now: d.sessions.length, retimed: !!hit }
    `)
    retimeUi.err ? fail('retime a block from the UI', retimeUi.err)
      : retimeUi.retimed ? pass('retime a block from the UI', '09:05–09:35 stored as 30m')
      : fail('retime a block from the UI', JSON.stringify(retimeUi))

    // ── 6c. A correction cannot land on the wrong tracking day ─────────────
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

    // ── 6d. Short blocks are clustered rather than drawn as a barcode ──────
    const cluster = await s.eval(`
      const clusters = [...document.querySelectorAll('.timeline .block.cluster')]
      const before = document.querySelectorAll('.timeline .block').length
      if (!clusters.length) return { clusters: 0 }
      const text = clusters[0].textContent.trim()
      clusters[0].click(); await new Promise(r => setTimeout(r, 500))
      const after = document.querySelectorAll('.timeline .block').length
      // Nothing may be shorter than a clickable minimum, cluster or not.
      const min = Math.min(...[...document.querySelectorAll('.timeline .block')].map(b => b.offsetHeight))
      return { clusters: clusters.length, text, before, after, min }
    `)
    cluster.clusters === 0
      ? pass('short-block clustering', 'no cluster needed for this day')
      : cluster.after > cluster.before && cluster.min >= 4
        ? pass('short blocks cluster and expand on click', `${cluster.clusters} clusters, "${cluster.text}", ${cluster.before} -> ${cluster.after}`)
        : fail('short blocks cluster and expand on click', JSON.stringify(cluster))

    // ── 6e. Theme ──────────────────────────────────────────────────────────
    await clickTab(s, 'Settings')
    const theme = await s.eval(`
      const seen = {}
      for (const want of ['light', 'dark', 'system']) {
        const b = [...document.querySelectorAll('.seg button')].find(x => x.textContent.trim().toLowerCase() === want)
        if (!b) return { err: 'no Appearance option for ' + want }
        b.click(); await new Promise(r => setTimeout(r, 350))
        seen[want] = {
          scheme: getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim(),
          page: getComputedStyle(document.body).backgroundColor,
        }
      }
      // Persist one, so the choice is proven to survive the round trip.
      ;[...document.querySelectorAll('.seg button')].find(x => x.textContent.trim() === 'Dark').click()
      await new Promise(r => setTimeout(r, 300))
      const save = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save')
      if (save && !save.disabled) save.click()
      await new Promise(r => setTimeout(r, 900))
      seen.saved = (await window.opentime.getBootstrap()).settings.theme
      return seen
    `)
    theme.err ? fail('light and dark themes both apply', theme.err)
      : theme.light.scheme === 'light' && theme.dark.scheme === 'dark' &&
        theme.light.page !== theme.dark.page && theme.saved === 'dark'
        ? pass('light and dark themes both apply and persist', `light=${theme.light.page} dark=${theme.dark.page}`)
        : fail('light and dark themes both apply', JSON.stringify(theme))

    // ── 6f. Export honours the chosen range ────────────────────────────────
    const rangeUi = await s.eval(`
      const sel = document.querySelector('select[aria-label="Export range"]')
      if (!sel) return { err: 'no export range control' }
      const options = [...sel.options].map(o => o.textContent)
      const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      proto.call(sel, '7')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 500))
      const desc = [...document.querySelectorAll('.setting-desc')].find(d => /stored day/.test(d.textContent))
      return { options, desc: desc?.textContent.match(/\\d+ stored days? in range/)?.[0] }
    `)
    rangeUi.err ? fail('export range is selectable', rangeUi.err)
      : rangeUi.options.length >= 4 && /^7 stored days/.test(rangeUi.desc || '')
        ? pass('export range narrows the day count', `${rangeUi.desc} from ${rangeUi.options.length} choices`)
        : fail('export range narrows the day count', JSON.stringify(rangeUi))

    // ── 7. Goals ───────────────────────────────────────────────────────────
    await clickTab(s, 'Today')
    // Drive the real editor: both starter goals ship switched off, so this is
    // the flow a user actually takes to get a goal onto the dashboard.
    const goalsUi = await s.eval(`${REACT_SET}
      const card = [...document.querySelectorAll('.card')].find(c => /goals/i.test(c.querySelector('.card-title')?.textContent || ''))
      if (!card) return { err: 'no Goals card on Today' }
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
      on.click()                                          // enable it
      await new Promise(r => setTimeout(r, 700))
      card.querySelector('.card-title button').click()    // Done
      await new Promise(r => setTimeout(r, 700))
      const after = [...document.querySelectorAll('.card')].find(c => /goals/i.test(c.querySelector('.card-title')?.textContent || ''))
      const persisted = (await window.opentime.getBootstrap()).goals
      return {
        emptyFirst,
        shown: !!after.querySelector('.goal-row'),
        text: after.textContent.replace(/\\s+/g, ' ').slice(0, 120),
        persistedName: persisted[0]?.name, persistedOn: persisted[0]?.enabled,
      }
    `)
    goalsUi.err ? fail('enable and rename a goal from the Today view', goalsUi.err)
      : goalsUi.emptyFirst && goalsUi.shown && goalsUi.persistedOn && goalsUi.persistedName === 'QA focus floor'
        ? pass('enable and rename a goal from the Today view', goalsUi.text)
        : fail('enable and rename a goal from the Today view', JSON.stringify(goalsUi))

    // ── 8. Projects & rules ────────────────────────────────────────────────
    await clickTab(s, 'Projects & rules')
    await shoot(s, '02-projects.png')
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

    const rules = await s.eval(`
      const before = (await window.opentime.getBootstrap()).rules.length
      const r = await window.opentime.saveRules([...(await window.opentime.getBootstrap()).rules,
        { id:'r_qa', kind:'app', match:'qa-app', category:'QA Project', productivity:'productive' }])
      return { before, after: r.length, has: r.some(x => x.id === 'r_qa') }
    `)
    rules.has && rules.after === rules.before + 1 ? pass('save a categorisation rule') : fail('save a categorisation rule', JSON.stringify(rules))

    // ── 9. Week view + day navigation ──────────────────────────────────────
    await clickTab(s, 'This week')
    await shoot(s, '03-week.png')
    const week = await s.eval(`return {
      cols: document.querySelectorAll('.week-col').length,
      stats: document.querySelectorAll('.stat').length,
      text: document.querySelector('.page-sub')?.textContent,
    }`)
    week.cols === 7 ? pass('week chart shows seven columns') : fail('week chart shows seven columns', String(week.cols))
    week.stats === 4 ? pass('week shows four stat tiles') : fail('week shows four stat tiles', String(week.stats))

    const nav = await s.eval(`
      const cols = [...document.querySelectorAll('.week-col')]
      cols[1].click(); await new Promise(r => setTimeout(r, 900))
      return { tab: document.querySelector('.nav-item.active')?.textContent.trim(),
               title: document.querySelector('.page-title')?.textContent.trim() }
    `)
    nav.tab === 'Today' ? pass('clicking a week column opens that day on Today', nav.title) : fail('clicking a week column opens that day on Today', JSON.stringify(nav))

    const back = await s.eval(`
      const b = [...document.querySelectorAll('button')].find(x => /back to today/i.test(x.textContent))
      if (!b) return { err: 'no Back to today button on a past day' }
      b.click(); await new Promise(r => setTimeout(r, 900))
      return { title: document.querySelector('.page-title')?.textContent.trim() }
    `)
    back.title === 'Today' ? pass('"Back to today" returns to the current day') : fail('"Back to today" returns to the current day', JSON.stringify(back))

    // ── 10. Settings ───────────────────────────────────────────────────────
    await clickTab(s, 'Settings')
    await shoot(s, '04-settings.png')
    const setSave = await s.eval(`
      const before = (await window.opentime.getBootstrap()).settings
      const next = { ...before, idleThresholdSeconds: 300, notificationsEnabled: !before.notificationsEnabled }
      const saved = await window.opentime.saveSettings(next)
      const reread = (await window.opentime.getBootstrap()).settings
      return { idle: reread.idleThresholdSeconds, notif: reread.notificationsEnabled === next.notificationsEnabled }
    `)
    setSave.idle === 300 && setSave.notif ? pass('settings save and survive a re-read') : fail('settings save and survive a re-read', JSON.stringify(setSave))

    const settingsUi = await s.eval(`${REACT_SET}
      const sw = document.querySelector('.switch')
      if (!sw) return { err: 'no toggle switch on Settings' }
      const was = sw.classList.contains('on')
      sw.click(); await new Promise(r => setTimeout(r, 400))
      const now = document.querySelector('.switch').classList.contains('on')
      return { toggled: was !== now }
    `)
    settingsUi.toggled ? pass('a Settings switch toggles') : fail('a Settings switch toggles', JSON.stringify(settingsUi))

    const invalid = await s.eval(`
      const before = (await window.opentime.getBootstrap()).settings
      const saved = await window.opentime.saveSettings({ ...before, pollIntervalSeconds: -99, dayStartHour: 99 })
      return { poll: saved.pollIntervalSeconds, hour: saved.dayStartHour }
    `)
    invalid.poll > 0 && invalid.hour >= 0 && invalid.hour <= 23
      ? pass('invalid settings are sanitised rather than stored', `poll=${invalid.poll} hour=${invalid.hour}`)
      : fail('invalid settings are sanitised rather than stored', JSON.stringify(invalid))

    // ── 11. Export ─────────────────────────────────────────────────────────
    // The real handler opens a save dialog, so drive the payload builder through
    // it with the dialog auto-answered from the main process side is not possible
    // here; instead assert the guard path and the range resolution the UI uses.
    const exp = await s.eval(`
      const r = await window.opentime.exportData({ format: 'sessions-csv', fromKey: '1999-01-01', toKey: '1999-01-02' })
      return { ok: r.ok, msg: r.message }
    `)
    !exp.ok && /no history/i.test(exp.msg) ? pass('export refuses an empty range with a reason', exp.msg)
      : fail('export refuses an empty range with a reason', JSON.stringify(exp))

    // ── 12. Calendar ───────────────────────────────────────────────────────
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

    // ── 13. Capture reload + demo data ─────────────────────────────────────
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

    // ── 14. Empty state after the history is gone ──────────────────────────
    await clickTab(s, 'Today')
    await shoot(s, '05-today-empty.png')
    const empty = await s.eval(`return {
      empties: document.querySelectorAll('.empty').length,
      crashed: !document.querySelector('.app'),
      title: document.querySelector('.page-title')?.textContent.trim(),
    }`)
    !empty.crashed && empty.title ? pass('Today survives an empty store', `${empty.empties} empty states`) : fail('Today survives an empty store', JSON.stringify(empty))

    await clickTab(s, 'This week')
    const emptyWeek = await s.eval(`return { crashed: !document.querySelector('.app'), title: document.querySelector('.page-title')?.textContent.trim() }`)
    !emptyWeek.crashed ? pass('This week survives an empty store') : fail('This week survives an empty store')

    // ── 15. No renderer exceptions across the whole run ────────────────────
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
