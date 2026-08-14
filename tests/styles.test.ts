import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The stylesheet is the whole design system, and its worst failure modes are
 * silent: an invalid declaration is dropped by the parser with no error
 * anywhere, and a token that is never defined resolves to nothing rather than
 * to something wrong. Both read as "the colour is a bit off" right up until you
 * find the surface that has no colour at all.
 *
 * These are the two that have actually shipped, so these are the two pinned.
 */
const RAW = readFileSync(
  fileURLToPath(new URL('../src/renderer/styles.css', import.meta.url)),
  'utf8'
)

/** Comments explain the traps; they must not be mistaken for falling into one. */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))

/**
 * Tokens the stylesheet reads but does not declare, because a component sets
 * them inline per element: the calendar block palette (`DayGrid.tsx`) and the
 * report heat cells (`ReportsView.tsx`).
 */
const SET_BY_COMPONENTS = ['--edge', '--fill', '--glow', '--heat', '--ink', '--sub-ink']

/** Every `--name: value` declaration in the sheet, in source order. */
function declarations(): Array<{ name: string; value: string; line: number }> {
  const out: Array<{ name: string; value: string; line: number }> = []
  CSS.split('\n').forEach((text, index) => {
    const match = text.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.*?);?\s*$/i)
    if (match) out.push({ name: match[1], value: match[2], line: index + 1 })
  })
  return out
}

describe('design tokens', () => {
  /**
   * A custom property that references itself is a *cycle*, and a cycle makes
   * the property invalid at computed-value time — in both branches of a
   * `light-dark()`, not only the one that named itself. Converting the sheet to
   * `light-dark()` left three tokens as `light-dark(<light>, var(--self))`,
   * which took the warning chip's fill and text colour away entirely and left
   * the first-run modal with no scrim behind it at all.
   */
  it('has no self-referencing custom property', () => {
    const cycles = declarations()
      .filter((d) => d.value.includes(`var(${d.name})`))
      .map((d) => `${d.name} (line ${d.line})`)
    expect(cycles).toEqual([])
  })

  /** A `var()` with no definition and no fallback resolves to nothing. */
  it('defines every token it reads', () => {
    const defined = new Set([...declarations().map((d) => d.name), ...SET_BY_COMPONENTS])
    const missing = new Set<string>()
    for (const [, name, rest] of CSS.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([^)]*)\)/gi)) {
      // A fallback (`var(--x, blue)`) is a deliberate default, not a hole.
      if (!defined.has(name) && !rest.trim().startsWith(',')) missing.add(name)
    }
    expect([...missing].sort()).toEqual([])
  })

  /**
   * `repeat(auto-fit, minmax(0, 1fr))` is invalid — an auto-repeat track needs
   * a fixed size — and an invalid `grid-template-columns` is dropped silently,
   * taking the layout with it.
   */
  it('never auto-repeats a fully flexible track', () => {
    expect(CSS).not.toMatch(/repeat\(\s*auto-(fit|fill)\s*,\s*minmax\(\s*0/i)
  })

  /**
   * A grid that declares only rows gets an implicit column that refuses to
   * shrink below its widest child, so in a narrow window the pane grows past
   * its track and slides under its neighbour. Every single-column grid carries
   * the clamp; this pins the ones that have already been caught doing it.
   */
  it('clamps the single-column grids that have overflowed before', () => {
    for (const selector of ['.calendar-main', '.summary', '.donut-legend', '.legend']) {
      const block = CSS.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))
      expect(block?.[0], `${selector} rule`).toBeTruthy()
      expect(block?.[0], `${selector} needs a minmax(0, …) column`).toMatch(
        /grid-template-columns:\s*minmax\(\s*0/
      )
    }
  })
})
