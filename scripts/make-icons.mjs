/**
 * Regenerate every packaged app-icon raster from build/icon.svg (the app
 * icon) and build/tray.svg (the tile-less tray variant).
 *
 * Run with `npm run icons` after editing the master SVG. Nothing here is
 * loaded at app runtime except the plain PNGs under build/ (the main process
 * reads those directly, see src/main/icon.ts); build/icon.ico and
 * build/icon.icns exist only for electron-builder and are never imported by
 * app code.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
import png2icons from 'png2icons'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const svgPath = path.join(root, 'build', 'icon.svg')
const traySvgPath = path.join(root, 'build', 'tray.svg')
const buildDir = path.join(root, 'build')

// Electron's Tray expects an exact-pixel image per scale factor rather than
// one bitmap it resizes itself — handing it a single upscaled PNG produces a
// visibly soft tray glyph on HiDPI. Render every representation straight
// from the vector source instead.
const TRAY_SIZES = [16, 20, 24, 32, 40, 48]
const APP_PNG_SIZE = 512

// The SVG's own viewBox is already 1024×1024px, so rsvg's default density
// rasterizes it 1:1; resize handles every smaller target from that.
async function render(svg, size) {
  return sharp(svg).resize(size, size).png().toBuffer()
}

async function main() {
  await mkdir(buildDir, { recursive: true })
  const svg = await readFile(svgPath)
  const traySvg = await readFile(traySvgPath)

  const master = await render(svg, 1024)

  const ico = png2icons.createICO(master, png2icons.BICUBIC2, 0, false, true)
  if (!ico) throw new Error('png2icons failed to build icon.ico')
  await writeFile(path.join(buildDir, 'icon.ico'), ico)

  const icns = png2icons.createICNS(master, png2icons.BICUBIC2, 0)
  if (!icns) throw new Error('png2icons failed to build icon.icns')
  await writeFile(path.join(buildDir, 'icon.icns'), icns)

  const appPng = await render(svg, APP_PNG_SIZE)
  await writeFile(path.join(buildDir, 'icon.png'), appPng)

  const trayDir = path.join(buildDir, 'tray')
  await mkdir(trayDir, { recursive: true })
  for (const size of TRAY_SIZES) {
    const png = await render(traySvg, size)
    await writeFile(path.join(trayDir, `${size}.png`), png)
  }

  console.log(`Wrote icon.ico, icon.icns, icon.png, and tray/{${TRAY_SIZES.join(',')}}.png to ${buildDir}`)
}

await main()
