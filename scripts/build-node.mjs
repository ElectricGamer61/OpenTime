/**
 * Bundle the main and preload processes with esbuild.
 *
 * esbuild rather than a second Vite instance: these are two small CJS bundles
 * for Node, they build in tens of milliseconds, and keeping them out of the
 * renderer toolchain means a renderer change never rebuilds the main process.
 */

import { copyFile, mkdir } from 'node:fs/promises'

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
