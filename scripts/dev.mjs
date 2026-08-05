/**
 * Dev runner: Vite dev server for the renderer, esbuild watch for main/preload,
 * then Electron pointed at the dev server.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

import electron from 'electron'
import { createServer } from 'vite'

// Fixed by default so the URL is predictable, overridable so two checkouts of
// this repo can run `npm run dev` at the same time.
const port = Number(process.env.OPENTIME_DEV_PORT) || 5273
const server = await createServer({ server: { port, strictPort: true } })
await server.listen()
const url = `http://localhost:${server.config.server.port}`
server.printUrls()

const esbuildWatch = spawn(process.execPath, ['scripts/build-node.mjs', '--watch'], {
  stdio: 'inherit',
})

// One initial synchronous build so main.js exists before Electron launches.
await new Promise((resolve) => setTimeout(resolve, 1200))

// Anything after `npm run dev --` is handed straight to Electron. Needed more
// often than it looks: a WSL or headless session cannot start the GPU process
// and aborts at boot without `--disable-gpu --no-sandbox`.
const child = spawn(electron, ['.', ...process.argv.slice(2)], {
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
