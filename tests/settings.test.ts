/**
 * Settings validation.
 *
 * Settings arrive from three untrusted places — a renderer over IPC, a
 * hand-editable JSON file, and a restored backup — and several of them can wedge
 * the engine if believed. Every write path funnels through `sanitizeSettings`,
 * so this is where that contract is pinned.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/core/defaults'

describe('sanitizeSettings', () => {
  it('returns the defaults for nothing at all', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('refuses a poll interval that would spin the event loop', () => {
    expect(sanitizeSettings({ pollIntervalSeconds: 0 }).pollIntervalSeconds).toBe(1)
    expect(sanitizeSettings({ pollIntervalSeconds: -5 }).pollIntervalSeconds).toBe(1)
    expect(sanitizeSettings({ pollIntervalSeconds: 99999 }).pollIntervalSeconds).toBe(300)
  })

  it('keeps the idle threshold inside a range that can actually detect idleness', () => {
    expect(sanitizeSettings({ idleThresholdSeconds: 1 }).idleThresholdSeconds).toBe(30)
    expect(sanitizeSettings({ idleThresholdSeconds: 10 ** 9 }).idleThresholdSeconds).toBe(3600)
  })

  it('keeps the day-start hour on the clock', () => {
    expect(sanitizeSettings({ dayStartHour: 26 }).dayStartHour).toBe(23)
    expect(sanitizeSettings({ dayStartHour: -3 }).dayStartHour).toBe(0)
  })

  it('coerces non-numeric input to the default rather than NaN', () => {
    const settings = sanitizeSettings({ pollIntervalSeconds: 'soon' as never })
    expect(settings.pollIntervalSeconds).toBe(DEFAULT_SETTINGS.pollIntervalSeconds)
    expect(Number.isNaN(settings.pollIntervalSeconds)).toBe(false)
  })

  it('lower-cases and de-duplicates the privacy lists', () => {
    const settings = sanitizeSettings({
      ignoredApps: ['1Password', '1password', '  Bitwarden  ', ''],
      ignoredTitleKeywords: ['ACME Merger', 'acme merger'],
    })
    expect(settings.ignoredApps).toEqual(['1password', 'bitwarden'])
    expect(settings.ignoredTitleKeywords).toEqual(['acme merger'])
  })

  it('drops a privacy list that is not a list', () => {
    expect(sanitizeSettings({ ignoredApps: 'everything' as never }).ignoredApps).toEqual([])
  })

  it('accepts only known capture modes', () => {
    expect(sanitizeSettings({ captureMode: 'native' }).captureMode).toBe('native')
    expect(sanitizeSettings({ captureMode: 'screenshots' as never }).captureMode).toBe('auto')
  })

  it('defaults retention to keeping everything', () => {
    expect(sanitizeSettings({}).retentionDays).toBe(0)
    expect(sanitizeSettings({ retentionDays: -1 }).retentionDays).toBe(0)
    expect(sanitizeSettings({ retentionDays: 90 }).retentionDays).toBe(90)
  })

  it('trims OAuth credentials and never invents a scope', () => {
    const settings = sanitizeSettings({
      calendar: {
        connected: true,
        clientId: '  abc.apps.googleusercontent.com  ',
        clientSecret: ' shh ',
        scope: 'drive' as never,
      },
    })
    expect(settings.calendar.clientId).toBe('abc.apps.googleusercontent.com')
    expect(settings.calendar.clientSecret).toBe('shh')
    expect(settings.calendar.scope).toBe('calendar.readonly')
  })

  it('treats a missing onboarding stamp as not yet onboarded', () => {
    expect(sanitizeSettings({}).onboardedAt).toBeUndefined()
    expect(sanitizeSettings({ onboardedAt: 0 }).onboardedAt).toBeUndefined()
    expect(sanitizeSettings({ onboardedAt: 1700000000000 }).onboardedAt).toBe(1700000000000)
  })

  it('defaults demo seeding off, but honours an explicit opt-in', () => {
    expect(sanitizeSettings({}).seedDemoWhenUnavailable).toBe(false)
    expect(sanitizeSettings({ seedDemoWhenUnavailable: true }).seedDemoWhenUnavailable).toBe(true)
  })

  it('is idempotent', () => {
    const once = sanitizeSettings({ pollIntervalSeconds: 0, ignoredApps: ['A', 'a'] })
    expect(sanitizeSettings(once)).toEqual(once)
  })
})
