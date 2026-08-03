/**
 * Bundle the main and preload processes with esbuild.
 *
 * esbuild rather than a second Vite instance: these are two small CJS bundles
 * for Node, they build in tens of milliseconds, and keeping them out of the
 * renderer toolchain means a renderer change never rebuilds the main process.
 */

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
]

if (watch) {
  for (const t of targets) {
    const ctx = await context({ ...common, ...t })
    await ctx.watch()
  }
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })))
}
