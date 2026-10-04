/**
 * Check two things in an installed (or unpacked) OpenTime that only exist once
 * it is packaged:
 *
 *  - the browser address reader, a separate program that has to sit outside
 *    the asar archive to be runnable, starts and exits cleanly (it is never
 *    asked to read anything, so this reads no window);
 *  - the assistant connector, started exactly the way Settings → Assistant
 *    tells an MCP client to, answers a question.
 *
 *   node scripts/verify-install.mjs <path to OpenTime.exe> [data dir]
 *
 * Run by .github/workflows/windows-package.yml against the installed app.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exe = process.argv[2]
if (!exe || !existsSync(exe)) {
  console.error(`usage: node scripts/verify-install.mjs <OpenTime.exe>  (not found: ${exe})`)
  process.exit(2)
}
const resources = path.join(path.dirname(exe), 'resources')
const dataDir = process.argv[3] || path.join(os.tmpdir(), 'opentime-verify-install')
mkdirSync(dataDir, { recursive: true })

let failed = false
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) failed = true
}

// 1. The address reader is unpacked and runs.
const helper = path.join(resources, 'app.asar.unpacked', 'dist', 'native', 'address-helper.exe')
if (!existsSync(helper)) {
  check(false, 'address reader is installed', `missing ${helper}`)
} else {
  const code = await new Promise((resolve) => {
    const child = spawn(helper, [], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, 10_000)
    child.on('error', () => resolve('error'))
    child.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
    // No request: closing stdin straight away must end it.
    child.stdin.end()
  })
  check(code === 0, 'address reader starts and exits cleanly', `exit ${code}`)
}

// 2. The assistant connector, as Settings → Assistant configures it.
const client = new Client({ name: 'verify-install', version: '0' })
try {
  await client.connect(
    new StdioClientTransport({
      command: exe,
      args: [path.join(resources, 'app.asar', 'dist', 'mcp', 'server.js')],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENTIME_DATA_DIR: dataDir },
    })
  )
  const tools = (await client.listTools()).tools.map((t) => t.name)
  const answer = await client.callTool({ name: 'tracking_status', arguments: {} })
  const text = answer.content?.[0]?.text || ''
  check(
    tools.includes('time_summary') && !answer.isError && text.length > 0,
    'assistant connector answers',
    `${tools.join(', ')}; "${text.split('\n')[0].slice(0, 80)}"`
  )
} catch (err) {
  check(false, 'assistant connector answers', String(err?.message || err))
} finally {
  await client.close().catch(() => {})
}

process.exit(failed ? 1 : 0)
