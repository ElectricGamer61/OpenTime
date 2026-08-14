/**
 * Block colour.
 *
 * The timeline paints saturated fills on a near-black surface, so every block
 * needs a colour even when the category is not one of the user's projects.
 * Projects carry their own colour; everything else is assigned deterministically
 * from its name so a category keeps the same hue between renders, between days
 * and between launches — a legend that shuffles is not a legend.
 *
 * Pure and dependency-free; `tests/palette.test.ts` pins the behaviour.
 */

/**
 * Assigned to categories with no project of their own.
 *
 * Saturated rather than pastel: these are painted as solid block fills on a
 * near-black grid, where a pastel reads as a smudge and a neon reads as an
 * error. Each one is bright enough to hold a white label at 12px.
 */
export const CATEGORY_PALETTE = [
  '#7c5cff', // violet — the brand hue
  '#3ecf6e', // green
  '#4a9eff', // blue
  '#f2545b', // coral
  '#e0a83e', // amber
  '#12b5b0', // teal
  '#c86bf0', // orchid
  '#e2725f', // ember
] as const

/** Reserved hues, so these never collide with an assigned category colour. */
export const RESERVED_COLORS = {
  away: '#6b6b70',
  meeting: '#8b7bd8',
  uncategorized: '#5a5a62',
} as const

/**
 * FNV-1a. Chosen over `split('').reduce()` arithmetic because it spreads short,
 * similar strings ("Email" / "Emails") into different buckets, which is exactly
 * the case that matters here.
 */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Build a name → colour lookup.
 *
 * Projects win outright. Remaining names take a palette slot from their hash,
 * and collisions walk forward to the next free slot so two categories on the
 * same screen do not land on the same hue while a slot is still spare.
 */
export function categoryColors(
  projects: Array<{ name: string; color: string }>,
  names: string[]
): Map<string, string> {
  const out = new Map<string, string>()
  for (const project of projects) out.set(project.name, project.color)

  const taken = new Set(out.values())
  for (const name of names) {
    if (out.has(name)) continue
    if (!name || name.toLowerCase() === 'uncategorized') {
      out.set(name, RESERVED_COLORS.uncategorized)
      continue
    }
    const start = hash(name) % CATEGORY_PALETTE.length
    let color = CATEGORY_PALETTE[start]
    for (let step = 0; step < CATEGORY_PALETTE.length; step += 1) {
      const candidate = CATEGORY_PALETTE[(start + step) % CATEGORY_PALETTE.length]
      if (!taken.has(candidate)) {
        color = candidate
        break
      }
    }
    taken.add(color)
    out.set(name, color)
  }
  return out
}

/** `#rgb` / `#rrggbb` → `[r, g, b]`; anything else falls back to slate. */
export function toRgb(color: string): [number, number, number] {
  const hex = color?.trim().replace('#', '') ?? ''
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  if (full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) return [107, 107, 118]
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

export function rgba(color: string, alpha: number): string {
  const [r, g, b] = toRgb(color)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Relative luminance, used to decide whether a block's own label should be
 * white or near-black. A fixed white label disappears on the amber and green
 * categories, which is the whole reason this exists.
 */
export function luminance(color: string): number {
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = toRgb(color)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Label colour with enough contrast to sit on `color`. */
export function inkOn(color: string): string {
  return luminance(color) > 0.42 ? 'rgba(9, 9, 12, 0.92)' : '#ffffff'
}

/** Same, one step quieter — for the secondary line inside a block. */
export function subInkOn(color: string): string {
  return luminance(color) > 0.42 ? 'rgba(9, 9, 12, 0.66)' : 'rgba(255, 255, 255, 0.72)'
}

/**
 * The brighter edge of a fill, for the accent bar every timeline block carries
 * on its left side.
 *
 * Mixing toward white keeps the bar the same hue as the block — a bar in a
 * different colour reads as a second piece of information, and it is not one.
 * Light fills darken instead, because a bar brighter than an amber block simply
 * disappears against it.
 *
 * Returns hex, like everything else here — the module's own helpers only read
 * hex, and a function whose output its neighbours cannot parse is a trap.
 */
export function edgeOn(color: string): string {
  const [r, g, b] = toRgb(color)
  const light = luminance(color) > 0.42
  const toward = light ? 0 : 255
  const amount = light ? 0.28 : 0.34
  const mix = (channel: number) =>
    Math.round(channel + (toward - channel) * amount)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(r)}${mix(g)}${mix(b)}`
}
