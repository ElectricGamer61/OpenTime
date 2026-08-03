/**
 * The capture engine.
 *
 * Two-mode polling loop, adapted from the older Norte tracker's state machine
 * because the shape is right: sample the focused window every few seconds while
 * the user is active, and the moment the OS reports idle, close the open session
 * and drop to a cheap heartbeat that does nothing but watch for their return.
 * While you're away the process touches neither the capture module nor the disk.
 *
 * Everything external is injected (`Capture`, idle seconds, storage, clock) so
 * the whole engine is testable without Electron.
 */

import { dayKey } from '../core/day'
import { makeIdleBlock, SessionBuilder } from '../core/sessions'
import type { CategoryRule, IdleBlock, Project, Session, Settings, TrackerStatus } from '../core/types'
import type { Capture } from './capture'
import type { Storage } from './storage/Storage'

export interface TrackerDeps {
  capture: Capture
  storage: Storage
  /** OS-reported seconds since the last user input. */
  getIdleSeconds: () => number
  /** Injected clock, for tests. */
  now?: () => number
  /** Fired after each state change so the renderer can be nudged. */
  onChange?: (status: TrackerStatus) => void
  /** Fired when the focus-block nudge is due. */
  onBreakSuggestion?: (minutes: number) => void
}

/** Cheap heartbeat interval while idle — the user isn't generating data. */
export const IDLE_POLL_MS = 30_000

export class Tracker {
  private deps: TrackerDeps
  private settings: Settings
  private builder: SessionBuilder
  private timer: NodeJS.Timeout | null = null
  private running = false
  private paused = false
  private mode: 'active' | 'idle' = 'idle'
  private stretchStart: number | null = null
  private breakSuggested = false
  private idleStart: number | null = null

  constructor(deps: TrackerDeps, settings: Settings, projects: Project[], rules: CategoryRule[]) {
    this.deps = deps
    this.settings = settings
    this.builder = new SessionBuilder({
      sessionGapSeconds: settings.sessionGapSeconds,
      dayStartHour: settings.dayStartHour,
      ignoredApps: settings.ignoredApps,
      rules,
      projects,
    })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** Apply changed settings/rules/projects without dropping the open session. */
  reconfigure(settings: Settings, projects: Project[], rules: CategoryRule[]): void {
    const intervalChanged = settings.pollIntervalSeconds !== this.settings.pollIntervalSeconds
    this.settings = settings
    this.builder.updateOptions({
      sessionGapSeconds: settings.sessionGapSeconds,
      dayStartHour: settings.dayStartHour,
      ignoredApps: settings.ignoredApps,
      rules,
      projects,
    })
    if (intervalChanged && this.running && !this.paused && this.mode === 'active') {
      this.enterActive()
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.paused = false
    this.enterActive()
  }

  stop(): void {
    this.clearTimer()
    void this.commit(this.builder.flush())
    this.running = false
    this.mode = 'idle'
    this.stretchStart = null
    this.emit()
  }

  pause(): void {
    if (!this.running || this.paused) return
    this.paused = true
    this.clearTimer()
    void this.commit(this.builder.flush())
    this.stretchStart = null
    this.emit()
  }

  resume(): void {
    if (!this.running || !this.paused) return
    this.paused = false
    this.enterActive()
  }

  /** Called on OS resume/unlock so we don't wait out the idle heartbeat. */
  wake(): void {
    if (this.running && !this.paused) this.enterActive()
  }

  get status(): TrackerStatus {
    const open = this.builder.current
    const now = this.now()
    return {
      running: this.running,
      paused: this.paused,
      mode: this.mode,
      captureAdapter: this.deps.capture.name,
      demo: this.deps.capture.demo,
      stretchStart: this.stretchStart,
      current:
        open && this.mode === 'active' && !this.paused
          ? {
              id: 'current',
              category: open.category,
              projectId: open.projectId,
              app: open.app,
              title: open.title,
              url: open.url,
              productivity: 'neutral',
              startTime: open.startTime,
              endTime: now,
              durationSeconds: Math.round((now - open.startTime) / 1000),
              open: true,
            }
          : null,
    }
  }

  /** One active-mode tick. Exposed for tests; normally driven by the timer. */
  tick(): void {
    const now = this.now()
    try {
      if (this.deps.getIdleSeconds() >= this.settings.idleThresholdSeconds) {
        // End the session at its last observed sample, not at `now`: the time
        // since then was the user walking away, and must not be counted.
        void this.commit(this.builder.flush())
        this.enterIdle(now)
        return
      }
      const sample = this.deps.capture.sample(now)
      if (sample) void this.commit(this.builder.sample(sample, now))
      else void this.commit(this.builder.flush())
      this.maybeSuggestBreak(now)
    } catch (err) {
      // A single bad poll must never take the loop down.
      console.error('[tracker] active poll error:', err)
    }
  }

  /** One idle-mode tick: the only question is whether the user came back. */
  private idleTick(): void {
    try {
      if (this.deps.getIdleSeconds() < this.settings.idleThresholdSeconds) {
        this.closeIdleBlock(this.now())
        this.enterActive()
        this.tick() // open the new session immediately, not one interval later
      }
    } catch (err) {
      console.error('[tracker] idle poll error:', err)
    }
  }

  private enterActive(): void {
    this.clearTimer()
    this.mode = 'active'
    if (!this.stretchStart) {
      this.stretchStart = this.now()
      this.breakSuggested = false
    }
    this.timer = setInterval(() => this.tick(), this.settings.pollIntervalSeconds * 1000)
    this.timer.unref?.()
    this.emit()
  }

  private enterIdle(now: number): void {
    this.clearTimer()
    this.mode = 'idle'
    this.stretchStart = null
    this.breakSuggested = false
    // The idle stretch began when input stopped, not when we noticed.
    this.idleStart = now - this.settings.idleThresholdSeconds * 1000
    this.timer = setInterval(() => this.idleTick(), IDLE_POLL_MS)
    this.timer.unref?.()
    this.emit()
  }

  private closeIdleBlock(now: number): void {
    if (this.idleStart === null) return
    const block = makeIdleBlock(this.idleStart, now)
    this.idleStart = null
    if (block) void this.storeIdle(block)
  }

  private async storeIdle(block: IdleBlock): Promise<void> {
    await this.deps.storage.appendIdle(dayKey(block.startTime, this.settings.dayStartHour), block)
  }

  private maybeSuggestBreak(now: number): void {
    if (this.breakSuggested || !this.stretchStart) return
    if (now - this.stretchStart < this.settings.focusBlockMinutes * 60_000) return
    this.breakSuggested = true
    this.deps.onBreakSuggestion?.(Math.round((now - this.stretchStart) / 60_000))
  }

  private async commit(sessions: Session[]): Promise<void> {
    if (!sessions.length) return
    await this.deps.storage.appendSessions(sessions)
    this.emit()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private emit(): void {
    this.deps.onChange?.(this.status)
  }
}
