/**
 * Resolves the app icon rasters generated from build/icon.svg (see
 * scripts/make-icons.mjs) at runtime, in both dev and packaged builds.
 *
 * electron-builder's `files` list only ships `dist/**` and `package.json`
 * into the asar; build/ reaches the packaged app only via the `extraResources`
 * copy in electron-builder.config.cjs, which lands unpacked at
 * `process.resourcesPath`. In dev, dist/main sits at <repo>/dist/main, so
 * build/ is two levels up from __dirname.
 */

import path from 'node:path'
import { app, nativeImage } from 'electron'

function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../build')
}

/** The window/taskbar icon: a single mid-size PNG is enough for BrowserWindow. */
export function windowIconPath(): string {
  return path.join(resourceRoot(), 'icon.png')
}

// Electron does not resize a Tray image itself — it shows exactly the pixels
// it's given per display scale factor. Handing it one upscaled bitmap reads
// visibly soft next to native tray icons at 200% scaling, so every size is
// rendered ahead of time (see scripts/make-icons.mjs) and registered as its
// own representation.
const TRAY_REPRESENTATIONS: Array<{ file: string; scaleFactor: number }> = [
  { file: '16.png', scaleFactor: 1 },
  { file: '20.png', scaleFactor: 1.25 },
  { file: '24.png', scaleFactor: 1.5 },
  { file: '32.png', scaleFactor: 2 },
  { file: '40.png', scaleFactor: 2.5 },
  { file: '48.png', scaleFactor: 3 },
]

export function trayIcon(): Electron.NativeImage {
  const trayDir = path.join(resourceRoot(), 'tray')
  const image = nativeImage.createEmpty()
  for (const { file, scaleFactor } of TRAY_REPRESENTATIONS) {
    image.addRepresentation({ scaleFactor, buffer: nativeImage.createFromPath(path.join(trayDir, file)).toPNG() })
  }
  return image
}
