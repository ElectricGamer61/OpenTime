/**
 * OpenTime as an MCP server: your tracked time, answerable by an assistant.
 *
 *   node dist/mcp/server.js
 *
 * Speaks MCP over stdio, so any MCP client can use it: Rookbot, Claude
 * Desktop, Claude Code, Cursor. It is read-only by construction (see
 * `store.ts`) and never talks to the network; everything it knows comes from
 * the same files the app writes. The data folder is found the way the app
 * finds it, and `OPENTIME_DATA_DIR` points it somewhere else.
 *
 * Every tool takes a `range` in words ("today", "this week", "last 14 days",
 * "2026-09-01..2026-09-25"), because that is how the question arrives.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { listSessions, resolveRange, status, summarize, timeOn } from '../core/ask'
import { rangeKeys } from '../core/range'
import { defaultDataDirectory, ReadOnlyStore } from './store'

const RANGE = z
  .string()
  .default('today')
  .describe('Which days. One of: today, yesterday, this week, last week, last 14 days, this month, last month, this year, all; or a date 2026-09-25; or a span 2026-09-01..2026-09-25. "this week" means the last 7 days.')

const READ = { readOnlyHint: true, openWorldHint: false } as const

export function createServer(store: ReadOnlyStore, now: () => number = Date.now): McpServer {
  const server = new McpServer({ name: 'opentime', version: '0.3.1' })

  const input = async (spec: string) => {
    const range = resolveRange(spec, now(), await store.dayStartHour())
    return { range, days: await store.days(rangeKeys(range)), projects: await store.projects() }
  }
  const answer = (run: () => Promise<string>) => async () => {
    try {
      return { content: [{ type: 'text' as const, text: await run() }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
    }
  }

  server.registerTool(
    'time_summary',
    {
      title: 'Where the time went',
      description:
        'What the tracked time in a range was spent on: total, productive/neutral/distracting, top categories, apps and projects, meetings, time away, and for a single day the first and last activity and the longest focus stretch.',
      inputSchema: { range: RANGE },
      annotations: READ,
    },
    async ({ range }) => answer(async () => summarize(await input(range)))()
  )

  server.registerTool(
    'time_on',
    {
      title: 'Time spent on something',
      description:
        'How long was spent on one thing (a project, an app, a site, a document, a topic) in a range, per day, and on which windows. Matches app names, window titles, sites, categories and project names; every word must match, and "|" separates alternative names ("rookbot|c0-f0").',
      inputSchema: {
        query: z.string().min(1).describe('what to look for, e.g. "rookbot", "youtube", "calculus homework", "rookbot|c0-f0"'),
        range: RANGE,
      },
      annotations: READ,
    },
    async ({ query, range }) => answer(async () => timeOn(query, await input(range)))()
  )

  server.registerTool(
    'sessions',
    {
      title: 'Tracked sessions',
      description: 'The individual tracked sessions in a range, newest first: time, duration, app, window title, category, project. Optionally only those matching a query.',
      inputSchema: {
        range: RANGE,
        query: z.string().optional().describe('only sessions matching this (same matching as time_on)'),
        limit: z.number().int().min(1).max(200).default(40),
      },
      annotations: READ,
    },
    async ({ range, query, limit }) => answer(async () => listSessions(await input(range), { ...(query ? { query } : {}), limit }))()
  )

  server.registerTool(
    'tracking_status',
    {
      title: 'Is tracking current',
      description: 'Whether OpenTime has recorded anything recently, which days it has, and the projects it attributes time to (with their keywords).',
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      answer(async () =>
        status({ now: now(), dataDirectory: store.root, dayKeys: await store.dayKeys(), lastSession: await store.lastSession(), projects: await store.projects() })
      )()
  )

  return server
}

async function main(): Promise<void> {
  const server = createServer(new ReadOnlyStore(defaultDataDirectory()))
  await server.connect(new StdioServerTransport())
}

// Only when run as the entry point, so tests can import createServer.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    // stdout belongs to the protocol; anything human goes to stderr.
    console.error('[opentime-mcp]', err)
    process.exit(1)
  })
}
