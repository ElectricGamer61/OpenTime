/**
 * Export and backup tests.
 *
 * Two things are load-bearing here: a CSV that a spreadsheet cannot be tricked
 * into executing, and a restore path that refuses anything it does not
 * understand — because restore replaces the user's entire history.
 */

import { describe, expect, it } from 'vitest'

import { summarizeDay } from '../src/core/aggregate'
import { defaultConfig, DEFAULT_SETTINGS, STATE_VERSION } from '../src/core/defaults'
import {
  BackupError,
  buildBackup,
  csvField,
  dailyToCsv,
  exportFilename,
  parseBackup,
  sessionsToCsv,
} from '../src/core/export'
import type { Session } from '../src/core/types'

const at = (h: number, m = 0) => new Date(2026, 2, 14, h, m, 0, 0).getTime()

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    category: 'Deep Work',
    app: 'Code',
    title: 'tracker.ts',
    url: 'github.com',
    productivity: 'productive',
    startTime: at(9),
    endTime: at(10),
    durationSeconds: 3600,
    ...patch,
  }
}

describe('csvField', () => {
  it('quotes fields containing commas, quotes or newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
  })

  it('leaves ordinary text alone', () => {
    expect(csvField('Deep Work')).toBe('Deep Work')
  })

  it('defuses spreadsheet formula injection', () => {
    // Window titles are attacker-influenced: any web page can choose its own.
    // Excel and Sheets execute a leading =, +, - or @ on open.
    // The apostrophe goes inside the quoting, which is what a spreadsheet reads.
    expect(csvField('=HYPERLINK("http://evil","click")')).toMatch(/^"'=/)
    expect(csvField('+1-555-0100')).toMatch(/^'\+/)
    expect(csvField('@SUM(A1:A9)')).toMatch(/^'@/)
  })

  it('renders null and undefined as empty rather than the word', () => {
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })
})

describe('sessionsToCsv', () => {
  it('writes a header and one row per session, oldest first', () => {
    const csv = sessionsToCsv(
      [session('b', { startTime: at(14), endTime: at(15) }), session('a')],
      4
    )
    const lines = csv.trim().split('\n')
    expect(lines[0]).toContain('duration_seconds')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('09:00:00')
    expect(lines[2]).toContain('14:00:00')
  })

  it('buckets each row into its tracking day, not its calendar day', () => {
    const lateNight = session('n', {
      startTime: new Date(2026, 2, 15, 1, 0, 0, 0).getTime(),
      endTime: new Date(2026, 2, 15, 2, 0, 0, 0).getTime(),
    })
    expect(sessionsToCsv([lateNight], 4)).toContain('2026-03-14')
  })

  it('carries the correction and source columns', () => {
    const csv = sessionsToCsv([session('m', { source: 'manual', edited: true, note: 'workshop' })], 4)
    expect(csv).toContain('manual')
    expect(csv).toContain('yes')
    expect(csv).toContain('workshop')
  })

  it('produces just a header for an empty range', () => {
    expect(sessionsToCsv([], 4).trim().split('\n')).toHaveLength(1)
  })
})

describe('dailyToCsv', () => {
  it('writes one row per day straight from a summary', () => {
    const summary = summarizeDay('2026-03-14', [session('a')], [], [])
    const csv = dailyToCsv([summary])
    const [header, row] = csv.trim().split('\n')
    expect(header.split(',')).toHaveLength(10)
    expect(row).toContain('2026-03-14')
    expect(row).toContain('3600')
  })
})

describe('backups', () => {
  const config = defaultConfig()
  const days = {
    '2026-03-14': { sessions: [session('a')], idle: [], events: [] },
  }

  it('round-trips through build and parse', () => {
    const backup = buildBackup(config, days, { exportedAt: 1234, appVersion: '0.2.0' })
    const parsed = parseBackup(JSON.stringify(backup))
    expect(parsed.format).toBe('opentime-backup')
    expect(parsed.days['2026-03-14'].sessions).toHaveLength(1)
    expect(parsed.config.settings.idleThresholdSeconds).toBe(DEFAULT_SETTINGS.idleThresholdSeconds)
    expect(parsed.version).toBe(STATE_VERSION)
  })

  it('rejects a file that is not JSON', () => {
    expect(() => parseBackup('nope')).toThrow(BackupError)
  })

  it('rejects JSON that is not an OpenTime backup', () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(BackupError)
    expect(() => parseBackup('[1,2,3]')).toThrow(BackupError)
  })

  it('accepts a v1 export that had no envelope', () => {
    // A backup taken before the sharded store was the whole PersistedState.
    const v1 = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, pollIntervalSeconds: 30 },
      projects: [{ id: 'x', name: 'Only', color: '#fff', keywords: [] }],
      rules: [],
      sessionsByDay: { '2026-03-14': [session('a')] },
      idleByDay: {},
      eventsByDay: {},
    }
    const parsed = parseBackup(JSON.stringify(v1))
    expect(parsed.config.settings.pollIntervalSeconds).toBe(30)
    expect(parsed.days['2026-03-14'].sessions).toHaveLength(1)
    expect(parsed.days['2026-03-14'].idle).toEqual([])
  })

  it('drops day keys that are not day keys', () => {
    const hostile = {
      format: 'opentime-backup',
      config,
      days: {
        '../../etc/passwd': { sessions: [], idle: [], events: [] },
        '2026-03-14': { sessions: [session('a')], idle: [], events: [] },
      },
    }
    const parsed = parseBackup(JSON.stringify(hostile))
    expect(Object.keys(parsed.days)).toEqual(['2026-03-14'])
  })

  it('sanitises settings coming out of a backup', () => {
    const hostile = {
      format: 'opentime-backup',
      config: { ...config, settings: { ...DEFAULT_SETTINGS, pollIntervalSeconds: 0 } },
      days: {},
    }
    // A zero-second poll interval would spin the event loop forever.
    expect(parseBackup(JSON.stringify(hostile)).config.settings.pollIntervalSeconds).toBe(1)
  })

  it('tolerates day records with missing sections', () => {
    const sparse = {
      format: 'opentime-backup',
      config,
      days: { '2026-03-14': {} },
    }
    const parsed = parseBackup(JSON.stringify(sparse))
    expect(parsed.days['2026-03-14']).toEqual({ sessions: [], idle: [], events: [] })
  })
})

describe('exportFilename', () => {
  it('sorts chronologically and carries the extension', () => {
    const name = exportFilename('opentime-sessions', 'csv', new Date(2026, 7, 3, 9, 5).getTime())
    expect(name).toBe('opentime-sessions-20260803-0905.csv')
  })
})
