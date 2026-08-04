import { describe, expect, it } from 'vitest'

import {
  CATEGORY_PALETTE,
  categoryColors,
  edgeOn,
  inkOn,
  luminance,
  RESERVED_COLORS,
  rgba,
  subInkOn,
  toRgb,
} from '../src/renderer/lib/palette'

const PROJECTS = [
  { name: 'Deep Work', color: '#6c5ce0' },
  { name: 'Design', color: '#00b8c4' },
]

describe('categoryColors', () => {
  it('gives a project its own colour', () => {
    const map = categoryColors(PROJECTS, ['Deep Work', 'Design'])
    expect(map.get('Deep Work')).toBe('#6c5ce0')
    expect(map.get('Design')).toBe('#00b8c4')
  })

  it('is stable for the same name across calls', () => {
    const a = categoryColors([], ['Invoicing', 'Support', 'Admin'])
    const b = categoryColors([], ['Invoicing', 'Support', 'Admin'])
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  // A colour that depends on the order the day happened to be aggregated in
  // would change every time a session was added.
  it('does not depend on the order the names arrive in', () => {
    const forward = categoryColors([], ['Invoicing', 'Support', 'Admin'])
    const reverse = categoryColors([], ['Admin', 'Support', 'Invoicing'])
    for (const name of ['Invoicing', 'Support', 'Admin']) {
      expect(reverse.get(name)).toBe(forward.get(name))
    }
  })

  it('assigns every name a palette colour', () => {
    const map = categoryColors([], ['Invoicing', 'Support', 'Admin'])
    for (const color of map.values()) {
      expect(CATEGORY_PALETTE as readonly string[]).toContain(color)
    }
  })

  it('does not hand two categories the same hue while a slot is spare', () => {
    const names = Array.from({ length: CATEGORY_PALETTE.length }, (_, i) => `Category ${i}`)
    const colors = [...categoryColors([], names).values()]
    expect(new Set(colors).size).toBe(names.length)
  })

  it('never reassigns a colour a project already holds', () => {
    const names = Array.from({ length: 6 }, (_, i) => `Other ${i}`)
    const map = categoryColors(PROJECTS, names)
    for (const name of names) {
      expect(map.get(name)).not.toBe('#6c5ce0')
      expect(map.get(name)).not.toBe('#00b8c4')
    }
  })

  it('gives Uncategorized the reserved neutral rather than a category hue', () => {
    const map = categoryColors([], ['Uncategorized'])
    expect(map.get('Uncategorized')).toBe(RESERVED_COLORS.uncategorized)
  })

  it('runs out of slots gracefully rather than throwing', () => {
    const names = Array.from({ length: CATEGORY_PALETTE.length * 3 }, (_, i) => `C${i}`)
    const map = categoryColors([], names)
    expect(map.size).toBe(names.length)
  })
})

describe('toRgb', () => {
  it('reads six-digit hex', () => {
    expect(toRgb('#3fb950')).toEqual([0x3f, 0xb9, 0x50])
  })

  it('expands three-digit hex', () => {
    expect(toRgb('#f0a')).toEqual([0xff, 0x00, 0xaa])
  })

  it('falls back on anything it cannot read', () => {
    // Project colours reach here straight out of a user-editable JSON file.
    expect(toRgb('not a colour')).toEqual([107, 107, 118])
    expect(toRgb('')).toEqual([107, 107, 118])
  })
})

describe('rgba', () => {
  it('renders a css colour', () => {
    expect(rgba('#3fb950', 0.5)).toBe('rgba(63, 185, 80, 0.5)')
  })
})

describe('label contrast', () => {
  it('puts white on dark fills and near-black on light ones', () => {
    expect(inkOn('#4a3b93')).toBe('#ffffff')
    expect(inkOn('#efb3ff')).toBe('rgba(9, 9, 12, 0.92)')
  })

  it('keeps the secondary line on the same side as the primary', () => {
    for (const color of CATEGORY_PALETTE) {
      const dark = inkOn(color) === '#ffffff'
      expect(subInkOn(color).startsWith('rgba(255')).toBe(dark)
    }
  })

  it('orders luminance the way the eye does', () => {
    expect(luminance('#ffffff')).toBeGreaterThan(luminance('#797979'))
    expect(luminance('#797979')).toBeGreaterThan(luminance('#0d0d0d'))
  })
})

describe('edgeOn', () => {
  // The bar exists to be seen against its own block, so on every palette hue it
  // has to land on the opposite side of the fill's luminance — not merely near
  // it. A bar the same brightness as the block is a bar nobody notices.
  it('separates from its fill on every palette colour', () => {
    for (const color of CATEGORY_PALETTE) {
      const fill = luminance(color)
      const edge = luminance(edgeOn(color))
      expect(Math.abs(edge - fill)).toBeGreaterThan(0.04)
      expect(edge > fill).toBe(fill <= 0.42)
    }
  })

  // Everything else in this module reads hex, so the bar colour has to be
  // something they can read back.
  it('returns hex the rest of the module can parse', () => {
    expect(edgeOn('#7c5cff')).toMatch(/^#[0-9a-f]{6}$/)
    expect(edgeOn('not a colour')).toMatch(/^#[0-9a-f]{6}$/)
  })
})
