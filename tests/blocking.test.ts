import { describe, expect, it } from 'vitest'

import {
  blockedBy,
  blockLabel,
  DEFAULT_BLOCK_TARGETS,
  nextShield,
  normalizeBlockTarget,
  normalizeBlockTargets,
  SHIELD_IDLE,
  SNOOZE_MINUTES,
  snoozeShield,
} from '../src/core/blocking'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/defaults'
import type { WindowSample } from '../src/core/types'

const chrome = (url: string, title = 'Some page - Google Chrome'): WindowSample => ({
  app: 'chrome',
  title,
  url,
})
const app = (name: string, title = name): WindowSample => ({ app: name, title })

describe('normalizeBlockTarget', () => {
  it('reduces a pasted URL to its host', () => {
    expect(normalizeBlockTarget('https://www.YouTube.com/watch?v=abc#t=1')).toBe('youtube.com')
    expect(normalizeBlockTarget('reddit.com/r/all')).toBe('reddit.com')
    expect(normalizeBlockTarget('localhost:3000')).toBe('localhost')
  })

  it('reduces an executable to its app name', () => {
    expect(normalizeBlockTarget('  Steam.exe ')).toBe('steam')
  })

  it('rejects input that names nothing', () => {
    expect(normalizeBlockTarget('   ')).toBe('')
    expect(normalizeBlockTargets(['', ' ', 'YouTube.com', 'youtube.com'])).toEqual(['youtube.com'])
    expect(normalizeBlockTargets('nope')).toEqual([])
  })
})

describe('blockedBy', () => {
  const targets = ['youtube.com', 'x.com', 'steam', 'discord']

  it('matches a site and its subdomains', () => {
    expect(blockedBy(chrome('youtube.com'), targets)).toBe('youtube.com')
    expect(blockedBy(chrome('m.youtube.com'), targets)).toBe('youtube.com')
    expect(blockedBy(chrome('x.com'), targets)).toBe('x.com')
  })

  it('never matches a different domain that merely ends the same way', () => {
    expect(blockedBy(chrome('dropbox.com'), targets)).toBeNull()
    expect(blockedBy(chrome('notyoutube.com'), targets)).toBeNull()
  })

  it('trusts the host over the title when the browser exposes one', () => {
    // A GitHub page titled after a YouTube issue is not YouTube.
    expect(blockedBy(chrome('github.com', 'Embed youtube player · Issue #4'), targets)).toBeNull()
  })

  it('falls back to the site name in the title when the browser hides the URL', () => {
    expect(blockedBy(chrome('', 'lofi beats - YouTube - Google Chrome'), targets)).toBe('youtube.com')
    // "x" is far too short to find safely in a title.
    expect(blockedBy(chrome('', 'Inbox (3) - Gmail - Google Chrome'), targets)).toBeNull()
  })

  it('does not apply the title fallback to apps that are not browsers', () => {
    expect(blockedBy(app('Code', 'youtube-embed.ts - VS Code'), targets)).toBeNull()
  })

  it('matches apps by name, tolerating suffixes and .exe', () => {
    expect(blockedBy(app('steam'), targets)).toBe('steam')
    expect(blockedBy(app('Steam.exe'), targets)).toBe('steam')
    expect(blockedBy(app('Discord PTB'), targets)).toBe('discord')
    expect(blockedBy(app('Code', 'notes.md'), targets)).toBeNull()
  })

  it('requires an exact name for very short app targets', () => {
    expect(blockedBy(app('Excel'), ['x'])).toBeNull()
    expect(blockedBy(app('x'), ['x'])).toBe('x')
  })

  it('matches app/word targets as whole words in the title only', () => {
    expect(blockedBy(app('Code', 'steam-api.ts'), ['steam'])).toBe('steam')
    expect(blockedBy(app('Code', 'steamroller.ts'), ['steam'])).toBeNull()
  })

  it('blocks nothing with no targets or no window', () => {
    expect(blockedBy(chrome('youtube.com'), [])).toBeNull()
    expect(blockedBy(null, targets)).toBeNull()
  })
})

describe('blockLabel', () => {
  it('names sites by their brand and apps by their app name', () => {
    expect(blockLabel('youtube.com', chrome('youtube.com'))).toBe('Youtube')
    expect(blockLabel('steam', app('Steam'))).toBe('Steam')
  })
})

describe('nextShield', () => {
  const targets = ['youtube.com']
  const now = 1_000_000

  it('raises the shield on a blocked window during a focus session', () => {
    const s = nextShield(SHIELD_IDLE, { active: true, sample: chrome('youtube.com'), targets, now })
    expect(s.target).toBe('youtube.com')
  })

  it('never raises it outside a focus session', () => {
    const s = nextShield(SHIELD_IDLE, { active: false, sample: chrome('youtube.com'), targets, now })
    expect(s.target).toBeNull()
  })

  it('keeps the shield up while OpenTime itself (the shield) is in front', () => {
    const up = { target: 'youtube.com', snoozed: {} }
    expect(nextShield(up, { active: true, sample: null, targets, now }).target).toBe('youtube.com')
  })

  it('lowers it as soon as something unblocked is in front', () => {
    const up = { target: 'youtube.com', snoozed: {} }
    expect(nextShield(up, { active: true, sample: app('Code'), targets, now }).target).toBeNull()
  })

  it('drops everything, snoozes included, when the session ends', () => {
    const up = { target: 'youtube.com', snoozed: { 'youtube.com': now + 60_000 } }
    expect(nextShield(up, { active: false, sample: null, targets, now })).toEqual(SHIELD_IDLE)
  })

  it('lets a snoozed target through until the snooze runs out', () => {
    const up = { target: 'youtube.com', snoozed: {} }
    const snoozed = snoozeShield(up, now)
    expect(snoozed.target).toBeNull()

    const during = nextShield(snoozed, { active: true, sample: chrome('youtube.com'), targets, now: now + 1000 })
    expect(during.target).toBeNull()

    const after = nextShield(during, {
      active: true,
      sample: chrome('youtube.com'),
      targets,
      now: now + SNOOZE_MINUTES * 60_000 + 1,
    })
    expect(after.target).toBe('youtube.com')
    expect(after.snoozed).toEqual({})
  })

  it('snoozing with no shield up changes nothing', () => {
    expect(snoozeShield(SHIELD_IDLE, now)).toBe(SHIELD_IDLE)
  })
})

describe('blocking settings', () => {
  it('ships switched off, with a starter list', () => {
    expect(DEFAULT_SETTINGS.blocking.enabled).toBe(false)
    expect(DEFAULT_SETTINGS.blocking.targets).toEqual(DEFAULT_BLOCK_TARGETS)
  })

  it('gives a config from before blocking existed the starter list, off', () => {
    const s = sanitizeSettings({ pollIntervalSeconds: 5 })
    expect(s.blocking).toEqual({ enabled: false, targets: DEFAULT_BLOCK_TARGETS })
  })

  it('keeps an emptied list empty rather than refilling it', () => {
    expect(sanitizeSettings({ blocking: { enabled: true, targets: [] } }).blocking).toEqual({
      enabled: true,
      targets: [],
    })
  })

  it('normalises what the user typed', () => {
    const s = sanitizeSettings({
      blocking: { enabled: true, targets: ['https://www.Reddit.com/r/x', 'reddit.com', 'Steam.exe'] },
    })
    expect(s.blocking.targets).toEqual(['reddit.com', 'steam'])
  })

  it('never checks for updates unless someone said yes', () => {
    expect(sanitizeSettings({}).checkForUpdates).toBe(false)
    expect(sanitizeSettings({ checkForUpdates: true }).checkForUpdates).toBe(true)
  })
})
