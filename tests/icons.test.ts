import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import png2icons from 'png2icons'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

/**
 * build/icon.ico, icon.icns, icon.png, and tray/*.png are generated from
 * build/icon.svg by scripts/make-icons.mjs and committed rather than built on
 * every install (see electron-builder.config.cjs and src/main/icon.ts).
 * That only stays true if a hand-edit of the SVG is never shipped without
 * also running `npm run icons` — this regenerates every raster in-memory and
 * byte-compares it against what's committed, so a forgotten regeneration
 * fails here instead of shipping a stale icon.
 */

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const buildDir = path.join(root, 'build')

const TRAY_SIZES = [16, 20, 24, 32, 40, 48]

async function render(svg: Buffer, size: number): Promise<Buffer> {
  return sharp(svg).resize(size, size).png().toBuffer()
}

describe('app icon rasters', () => {
  it('are freshly regenerated from build/icon.svg (run `npm run icons` after editing it)', async () => {
    const svg = await readFile(path.join(buildDir, 'icon.svg'))
    const master = await render(svg, 1024)

    const expectedIco = png2icons.createICO(master, png2icons.BICUBIC2, 0, false, true)
    const expectedIcns = png2icons.createICNS(master, png2icons.BICUBIC2, 0)
    const expectedPng = await render(svg, 512)
    expect(expectedIco).not.toBeNull()
    expect(expectedIcns).not.toBeNull()

    const [actualIco, actualIcns, actualPng] = await Promise.all([
      readFile(path.join(buildDir, 'icon.ico')),
      readFile(path.join(buildDir, 'icon.icns')),
      readFile(path.join(buildDir, 'icon.png')),
    ])

    expect(actualIco.equals(Buffer.from(expectedIco as Buffer))).toBe(true)
    expect(actualIcns.equals(Buffer.from(expectedIcns as Buffer))).toBe(true)
    expect(actualPng.equals(expectedPng)).toBe(true)

    for (const size of TRAY_SIZES) {
      const expected = await render(svg, size)
      const actual = await readFile(path.join(buildDir, 'tray', `${size}.png`))
      expect(actual.equals(expected), `tray/${size}.png is stale`).toBe(true)
    }
  })

  it('icon.ico is a valid multi-size Windows icon', async () => {
    const buf = await readFile(path.join(buildDir, 'icon.ico'))
    // ICONDIR header: reserved=0, type=1 (icon), count>0.
    expect(buf.readUInt16LE(0)).toBe(0)
    expect(buf.readUInt16LE(2)).toBe(1)
    const count = buf.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(6)
    // Every ICONDIRENTRY must claim a size in the Windows-recommended set.
    const allowed = new Set([16, 24, 32, 48, 64, 72, 96, 128, 256, 0])
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16
      expect(allowed.has(buf.readUInt8(entry))).toBe(true)
      expect(allowed.has(buf.readUInt8(entry + 1))).toBe(true)
    }
  })

  it('icon.icns starts with the ICNS magic', async () => {
    const buf = await readFile(path.join(buildDir, 'icon.icns'))
    expect(buf.subarray(0, 4).toString('ascii')).toBe('icns')
  })

  it('every tray representation is square, opaque-capable RGBA, and the declared size', async () => {
    for (const size of TRAY_SIZES) {
      const meta = await sharp(path.join(buildDir, 'tray', `${size}.png`)).metadata()
      expect(meta.width).toBe(size)
      expect(meta.height).toBe(size)
      expect(meta.hasAlpha).toBe(true)
    }
  })

  it('icon.png (the runtime window icon) is square RGBA', async () => {
    const meta = await sharp(path.join(buildDir, 'icon.png')).metadata()
    expect(meta.width).toBe(meta.height)
    expect(meta.hasAlpha).toBe(true)
  })
})
