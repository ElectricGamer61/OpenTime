/**
 * Bundle the main and preload processes with esbuild.
 *
 * esbuild rather than a second Vite instance: these are two small CJS bundles
 * for Node, they build in tens of milliseconds, and keeping them out of the
 * renderer toolchain means a renderer change never rebuilds the main process.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  // Electron and the native capture module are resolved at runtime, never
  // bundled — x-win ships a platform-specific .node binary.
  external: ['electron', '@miniben90/x-win'],
}

const targets = [
  { entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' },
  { entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' },
  { entryPoints: ['src/preload/shield.ts'], outfile: 'dist/preload/shield.js' },
  // The MCP server: a plain Node program (no Electron) that answers questions
  // about tracked time over stdio. See src/mcp/server.ts.
  { entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp/server.js' },
  // The focus shield is its own tiny page (see src/main/blocker.ts): a browser
  // bundle, not a Node one, and small enough to need no framework.
  {
    entryPoints: ['src/shield/shield.ts'],
    outfile: 'dist/shield/shield.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome128',
  },
]

// The Windows address-bar reader (src/native/address-helper.cs), compiled
// with the C# compiler every Windows install already has, so building it
// needs nothing extra. Elsewhere there is nothing to build: x-win reports the
// URL itself on macOS, and Linux has no address bar to read.
if (process.platform === 'win32') {
  const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const csc = path.join(framework, 'csc.exe')
  if (!existsSync(csc)) throw new Error(`C# compiler not found at ${csc}`)
  await mkdir('dist/native', { recursive: true })
  const wpf = (dll) => `-r:${path.join(framework, 'WPF', dll)}`
  execFileSync(csc, [
    '-nologo', '-optimize+', '-target:winexe',
    // Backslash paths: csc reads a leading '/' as one of its own options.
    `-out:${path.join('dist', 'native', 'address-helper.exe')}`,
    wpf('UIAutomationClient.dll'), wpf('UIAutomationTypes.dll'), wpf('WindowsBase.dll'),
    path.join('src', 'native', 'address-helper.cs'),
  ], { stdio: 'inherit' })
}

// The shield's static files ride along with its script.
await mkdir('dist/shield', { recursive: true })
await copyFile('src/shield/shield.html', 'dist/shield/shield.html')
await copyFile('src/shield/shield.css', 'dist/shield/shield.css')

if (watch) {
  for (const t of targets) {
    const ctx = await context({ ...common, ...t })
    await ctx.watch()
  }
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })))
}
