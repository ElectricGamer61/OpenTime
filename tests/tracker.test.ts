/**
 * Engine tests.
 *
 * The Tracker takes its capture source, idle signal and clock as dependencies,
 * so the whole idle/active state machine is exercised here with no Electron and
 * no real timers.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PROJECTS, DEFAULT_SETTINGS } from '../src/core/defaults'
import type { Settings, WindowSample } from '../src/core/types'
import type { Capture } from '../src/main/capture'
import { JsonStorage } from '../src/main/storage/JsonStorage'
import { Tracker } from '../src/main/tracker'

class ScriptedCapture implements Capture {
  readonly name = 'scripted'
  readonly demo = true
  current: WindowSample | null = { app: 'Code', title: 'a.ts' }
  sample(): WindowSample | null {
    return this.current
  }
  dispose(): void {}
}

let dir: string
let storage: JsonStorage
let capture: ScriptedCapture
let clock: number
let idleSeconds: number

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...patch,
})

async function makeTracker(patch: Partial<Settings> = {}) {
  const config = settings(patch)
  const tracker = new Tracker(
    {
      capture,
      storage,
      getIdleSeconds: () => idleSeconds,
      now: () => clock,
    },
    config,
    DEFAULT_PROJECTS,
    []
  )
  return { tracker, config }
}

beforeEach(async () => {
  vi.useFakeTimers()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentime-tracker-'))
  storage = new JsonStorage(dir)
  await storage.init()
  capture = new ScriptedCapture()
  clock = new Date(2026, 2, 14, 9, 0, 0, 0).getTime()
  idleSeconds = 0
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Drive the engine for `seconds` of wall time at its real polling cadence.
 * Ticking in one big jump would look like a sampling gap and split the session,
 * which is correct behaviour but not what these tests are exercising.
 */
function run(tracker: Tracker, seconds: number, step = DEFAULT_SETTINGS.pollIntervalSeconds) {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    clock += Math.min(step, seconds - elapsed) * 1000
    tracker.tick()
  }
}

describe('Tracker', () => {
  it('opens a session on the first tick and reports it as current', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    tracker.tick()
    expect(tracker.status.current?.category).toBe('Deep Work')
    expect(tracker.status.mode).toBe('active')
    tracker.stop()
  })

  it('does not write to storage while a session stays open', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    run(tracker, 60)
    // A full minute of polling, still nothing persisted — this is the batching
    // that keeps the engine cheap.
    expect(storage.getSessions('2026-03-14')).toEqual([])
    tracker.stop()
    expect(storage.getSessions('2026-03-14')).toHaveLength(1)
  })

  it('closes the session and records an idle block when the OS reports idle', async () => {
    const { tracker } = await makeTracker({ idleThresholdSeconds: 120 })
    tracker.start()
    tracker.tick()
    run(tracker, 600)

    idleSeconds = 120
    run(tracker, 5)

    expect(tracker.status.mode).toBe('idle')
    expect(tracker.status.current).toBeNull()
    const sessions = storage.getSessions('2026-03-14')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].durationSeconds).toBe(600)

    // Coming back closes the idle block, dated from when input actually stopped.
    idleSeconds = 0
    clock += 30 * 60 * 1000
    vi.advanceTimersByTime(30_000)

    const idle = storage.getIdle('2026-03-14')
    expect(idle).toHaveLength(1)
    expect(idle[0].durationSeconds).toBeGreaterThan(30 * 60)
    expect(tracker.status.mode).toBe('active')
    tracker.stop()
  })

  it('opens a new session immediately on return rather than waiting a full interval', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    tracker.tick()
    idleSeconds = 300
    run(tracker, 10)
    expect(tracker.status.mode).toBe('idle')

    idleSeconds = 0
    clock += 60_000
    vi.advanceTimersByTime(30_000)
    expect(tracker.status.current).not.toBeNull()
    tracker.stop()
  })

  it('flushes the open session when paused and stops sampling', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    tracker.tick()
    run(tracker, 300)
    tracker.pause()

    expect(storage.getSessions('2026-03-14')).toHaveLength(1)
    expect(tracker.status.paused).toBe(true)
    expect(tracker.status.current).toBeNull()

    // Timers must not produce more data while paused.
    vi.advanceTimersByTime(60_000)
    expect(storage.getSessions('2026-03-14')).toHaveLength(1)

    tracker.resume()
    expect(tracker.status.paused).toBe(false)
    tracker.stop()
  })

  it('splits sessions when the focused activity changes category', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    tracker.tick()
    run(tracker, 300)
    capture.current = { app: 'Slack', title: '#general' }
    run(tracker, 5)

    const sessions = storage.getSessions('2026-03-14')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].category).toBe('Deep Work')
    expect(tracker.status.current?.category).toBe('Communication')
    tracker.stop()
  })

  it('records nothing while there is no focused window', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    capture.current = null
    run(tracker, 10)
    expect(tracker.status.current).toBeNull()
    expect(storage.getSessions('2026-03-14')).toEqual([])
    tracker.stop()
  })

  it('fires the focus checkpoint once per unbroken stretch', async () => {
    const onBreakSuggestion = vi.fn()
    const tracker = new Tracker(
      {
        capture,
        storage,
        getIdleSeconds: () => idleSeconds,
        now: () => clock,
        onBreakSuggestion,
      },
      settings({ focusBlockMinutes: 10 }),
      DEFAULT_PROJECTS,
      []
    )
    tracker.start()
    tracker.tick()
    run(tracker, 11 * 60)
    run(tracker, 60)
    expect(onBreakSuggestion).toHaveBeenCalledTimes(1)
    expect(onBreakSuggestion.mock.calls[0][0]).toBeGreaterThanOrEqual(10)
    tracker.stop()
  })

  it('survives a capture adapter that throws', async () => {
    const throwing: Capture = {
      name: 'broken',
      demo: true,
      sample() {
        throw new Error('UIA refused')
      },
      dispose() {},
    }
    const tracker = new Tracker(
      { capture: throwing, storage, getIdleSeconds: () => idleSeconds, now: () => clock },
      settings(),
      DEFAULT_PROJECTS,
      []
    )
    tracker.start()
    expect(() => tracker.tick()).not.toThrow()
    expect(tracker.status.running).toBe(true)
    tracker.stop()
  })

  it('applies changed settings without losing the open session', async () => {
    const { tracker } = await makeTracker()
    tracker.start()
    tracker.tick()
    run(tracker, 120)
    const before = tracker.status.current?.startTime
    tracker.reconfigure(settings({ pollIntervalSeconds: 30 }), DEFAULT_PROJECTS, [])
    expect(tracker.status.current?.startTime).toBe(before)
    tracker.stop()
  })

  it('respects the private-app list end to end', async () => {
    const { tracker } = await makeTracker({ ignoredApps: ['1password'] })
    tracker.start()
    capture.current = { app: '1Password', title: 'Personal vault' }
    run(tracker, 300)
    expect(storage.getSessions('2026-03-14')).toEqual([])
    tracker.stop()
    expect(storage.getSessions('2026-03-14')).toEqual([])
  })
})
