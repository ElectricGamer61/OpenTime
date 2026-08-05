import { describe, expect, it } from 'vitest'

import { blockFill, clock, duration, percent } from '../src/renderer/lib/format'

describe('duration', () => {
  it('renders hours and minutes', () => {
    expect(duration(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(duration(48 * 60)).toBe('48m')
    expect(duration(2 * 3600)).toBe('2h')
  })

  it('renders sub-minute values as seconds and nothing as a dash', () => {
    expect(duration(20)).toBe('20s')
    expect(duration(0)).toBe('—')
    expect(duration(0.4)).toBe('—')
  })

  it('carries a rounded-up 60th minute into the hour, never "Nh 60m"', () => {
    // 19h 59m 40s rounds to 20h — the shipped bug rendered "19h 60m".
    expect(duration(19 * 3600 + 59 * 60 + 40)).toBe('20h')
    // 59m 50s rounds to 1h — not "60m".
    expect(duration(59 * 60 + 50)).toBe('1h')
    expect(duration(3599)).toBe('1h')
  })

  it('still rounds ordinary values to the nearest minute', () => {
    expect(duration(89)).toBe('1m')
    expect(duration(150)).toBe('3m')
    expect(duration(3600 + 29)).toBe('1h')
    expect(duration(3600 + 31)).toBe('1h 1m')
  })
})

describe('clock', () => {
  it('formats live counters with and without hours', () => {
    expect(clock(3862)).toBe('1:04:22')
    expect(clock(75)).toBe('1:15')
    expect(clock(-5)).toBe('0:00')
  })
})

describe('percent', () => {
  it('rounds shares to whole percentages', () => {
    expect(percent(0)).toBe('0%')
    expect(percent(0.154)).toBe('15%')
    expect(percent(1)).toBe('100%')
  })
})

describe('blockFill', () => {
  it('expands 3- and 6-digit hex to a translucent rgba', () => {
    expect(blockFill('#5b8cff')).toBe('rgba(91, 140, 255, 0.16)')
    expect(blockFill('#48f', 0.2)).toBe('rgba(68, 136, 255, 0.2)')
  })

  it('falls back to a neutral wash on anything that is not a hex colour', () => {
    expect(blockFill('tomato')).toBe('rgba(148, 163, 184, 0.16)')
    expect(blockFill('')).toBe('rgba(148, 163, 184, 0.16)')
  })
})
