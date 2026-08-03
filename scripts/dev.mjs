/**
 * Dev runner: Vite dev server for the renderer, esbuild watch for main/preload,
 * then Electron pointed at the dev server.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

import electron from 'electron'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5273, strictPort: true } })
await server.listen()
const url = `http://localhost:${server.config.server.port}`
server.printUrls()

const esbuildWatch = spawn(process.execPath, ['scripts/build-node.mjs', '--watch'], {
  stdio: 'inherit',
})

// One initial synchronous build so main.js exists before Electron launches.
await new Promise((resolve) => setTimeout(resolve, 1200))

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, OPENTIME_DEV_SERVER_URL: url },
})

const shutdown = async (code = 0) => {
  esbuildWatch.kill()
  await server.close()
  process.exit(code)
}

child.on('close', (code) => void shutdown(code ?? 0))
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
