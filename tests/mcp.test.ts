import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatAgo, formatDuration, resolveRange, sessionMatches } from '../src/core/ask'
import type { Project, Session } from '../src/core/types'
import { createServer } from '../src/mcp/server'
import { defaultDataDirectory, ReadOnlyStore } from '../src/mcp/store'

/** Local noon on 2026-09-25: comfortably inside the tracking day of that key. */
const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime()
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m, 0).getTime()

function session(id: string, day: number, h: number, minutes: number, extra: Partial<Session> = {}): Session {
  const startTime = at(day, h)
  return {
    id,
    category: 'Deep Work',
    app: 'Code',
    title: 'store.ts - C0-F0',
    url: '',
    productivity: 'productive',
    startTime,
    endTime: startTime + minutes * 60_000,
    durationSeconds: minutes * 60,
    source: 'capture',
    ...extra,
  }
}

const PROJECTS: Project[] = [{ id: 'p_rook', name: 'Rookbot', color: '#f80', keywords: ['c0-f0', 'rookbot'] }]

describe('resolveRange', () => {
  it('reads the phrases people use, in tracking days', () => {
    expect(resolveRange('today', NOW, 4)).toMatchObject({ fromKey: '2026-09-25', toKey: '2026-09-25' })
    expect(resolveRange('yesterday', NOW, 4)).toMatchObject({ fromKey: '2026-09-24', toKey: '2026-09-24' })
    expect(resolveRange('this week', NOW, 4)).toMatchObject({ fromKey: '2026-09-19', toKey: '2026-09-25' })
    expect(resolveRange('last week', NOW, 4)).toMatchObject({ fromKey: '2026-09-12', toKey: '2026-09-18' })
    expect(resolveRange('last 3 days', NOW, 4)).toMatchObject({ fromKey: '2026-09-23', toKey: '2026-09-25' })
    expect(resolveRange('this month', NOW, 4)).toMatchObject({ fromKey: '2026-09-01', toKey: '2026-09-30' })
    expect(resolveRange('last month', NOW, 4)).toMatchObject({ fromKey: '2026-08-01', toKey: '2026-08-31' })
    expect(resolveRange('2026-09-20..2026-09-22', NOW, 4)).toMatchObject({ fromKey: '2026-09-20', toKey: '2026-09-22' })
    expect(resolveRange(undefined, NOW, 4)).toMatchObject({ fromKey: '2026-09-25' })
    expect(resolveRange('This week (trailing 7 days)', NOW, 4)).toMatchObject({ fromKey: '2026-09-19', toKey: '2026-09-25' })
    expect(resolveRange('the last 3 days', NOW, 4)).toMatchObject({ fromKey: '2026-09-23' })
  })

  it('counts 2am as the day before, like the rest of the app', () => {
    expect(resolveRange('today', at(26, 2), 4)).toMatchObject({ fromKey: '2026-09-25' })
  })

  it('refuses a range it does not understand rather than guessing one', () => {
    expect(() => resolveRange('the other day', NOW, 4)).toThrow(/do not understand/)
  })
})

describe('sessionMatches', () => {
  const s = session('a', 25, 9, 30, { projectId: 'p_rook' })
  it('needs every word, anywhere the session describes itself', () => {
    expect(sessionMatches(s, 'code c0-f0', PROJECTS)).toBe(true)
    expect(sessionMatches(s, 'rookbot', PROJECTS)).toBe(true)
    expect(sessionMatches(s, 'code youtube', PROJECTS)).toBe(false)
  })
  it('treats | as another name for the same thing', () => {
    expect(sessionMatches(s, 'youtube|store.ts', PROJECTS)).toBe(true)
  })
  it('counts a project by its keywords even where the session was never attributed', () => {
    const loose = session('b', 25, 9, 30, { title: 'ws.ts - C0-F0' })
    expect(sessionMatches(loose, 'rookbot', PROJECTS)).toBe(true)
    expect(sessionMatches(loose, 'roblox', PROJECTS)).toBe(false)
  })
})

it('says durations the way people do', () => {
  expect(formatDuration(0)).toBe('0m')
  expect(formatDuration(30)).toBe('under a minute')
  expect(formatDuration(45 * 60)).toBe('45m')
  expect(formatDuration(3 * 3600)).toBe('3h')
  expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h 12m')
  expect(formatAgo(40)).toBe('just now')
  expect(formatAgo(2 * 3600)).toBe('2h ago')
  expect(formatAgo(37 * 3600)).toBe('2 days ago')
})

describe('defaultDataDirectory', () => {
  it('is where the app keeps it, unless told otherwise', () => {
    expect(defaultDataDirectory({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')).toBe(
      path.join('C:\\Users\\x\\AppData\\Roaming', 'OpenTime', 'opentime')
    )
    expect(defaultDataDirectory({ OPENTIME_DATA_DIR: '/tmp/ot' }, 'linux')).toBe('/tmp/ot')
  })
})

describe('the MCP server', () => {
  let dir: string
  let client: Client

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'opentime-mcp-'))
    mkdirSync(path.join(dir, 'days'))
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 2, settings: { dayStartHour: 4 }, projects: PROJECTS, rules: [], goals: [] }))
    // Two days on disk, already checkpointed.
    writeFileSync(
      path.join(dir, 'days', '2026-09-24.json'),
      JSON.stringify({ sessions: [session('y1', 24, 10, 90, { projectId: 'p_rook' })], idle: [], events: [], lastSeq: 3 })
    )
    writeFileSync(
      path.join(dir, 'days', '2026-09-25.json'),
      JSON.stringify({
        sessions: [
          session('t1', 25, 9, 60, { projectId: 'p_rook' }),
          session('t2', 25, 10, 20, { app: 'chrome', title: 'YouTube', url: 'youtube.com', category: 'Video', productivity: 'distracting' }),
        ],
        idle: [],
        events: [],
        lastSeq: 5,
      })
    )
    // The app is running: one write is journalled but not yet folded into the
    // day file, and one old record the file already has must not count twice.
    writeFileSync(
      path.join(dir, 'journal.jsonl'),
      [
        JSON.stringify({ seq: 5, op: 'appendSessions', days: { '2026-09-25': [session('t1', 25, 9, 60)] } }),
        JSON.stringify({ seq: 6, op: 'appendSessions', days: { '2026-09-25': [session('t3', 25, 11, 30, { title: 'ws.ts - C0-F0' })] } }),
        '{"seq": 7, "op": "appendSess', // torn by a crash mid-append
      ].join('\n')
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createServer(new ReadOnlyStore(dir), () => NOW).connect(a)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
  })

  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content as Array<{ text: string }>)[0].text, isError: !!r.isError }
  }

  it('offers four read-only tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['sessions', 'time_on', 'time_summary', 'tracking_status'])
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
  })

  it('answers "how long on X", including what is only in the journal, once', async () => {
    const today = await call('time_on', { query: 'c0-f0', range: 'today' })
    // 60m from the day file plus 30m journalled; the seq-5 duplicate is skipped.
    expect(today.text).toContain('"c0-f0" Fri 2026-09-25: 1h 30m across 2 sessions')
    const week = await call('time_on', { query: 'rookbot', range: 'this week' })
    expect(week.text).toContain('3h across 3 sessions')
    expect(week.text).toContain('Thu 2026-09-24 1h 30m')
  })

  it('summarises a day the way the dashboard does', async () => {
    const { text } = await call('time_summary', { range: 'today' })
    expect(text).toContain('Tracked Fri 2026-09-25: 1h 50m.')
    expect(text).toContain('distracting 20m')
    expect(text).toContain('By project: Rookbot 1h')
  })

  it('lists sessions newest first', async () => {
    const { text } = await call('sessions', { range: 'today' })
    expect(text.split('\n')[0]).toContain('ws.ts - C0-F0')
  })

  it('says what it has and how fresh it is', async () => {
    const { text } = await call('tracking_status')
    expect(text).toContain('2 tracked days, from 2026-09-24 to 2026-09-25')
    expect(text).toContain('Rookbot (keywords: c0-f0, rookbot)')
  })

  it('turns a bad range into an answer the model can act on, not a crash', async () => {
    const r = await call('time_summary', { range: 'the other day' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Use today, yesterday')
  })
})
