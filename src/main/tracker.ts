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
  private pausedUntil: number | null = null
  private resumeTimer: NodeJS.Timeout | null = null
  /** Serialised queue of in-flight storage writes; see `drain()`. */
  private pending: Promise<void> = Promise.resolve()

  constructor(deps: TrackerDeps, settings: Settings, projects: Project[], rules: CategoryRule[]) {
    this.deps = deps
    this.settings = settings
    this.builder = new SessionBuilder({
      sessionGapSeconds: settings.sessionGapSeconds,
      dayStartHour: settings.dayStartHour,
      ignoredApps: settings.ignoredApps,
      ignoredTitleKeywords: settings.ignoredTitleKeywords,
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
      ignoredTitleKeywords: settings.ignoredTitleKeywords,
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
    this.clearResumeTimer()
    this.pausedUntil = null
    this.track(this.commit(this.builder.flush()))
    this.running = false
    this.mode = 'idle'
    this.stretchStart = null
    this.emit()
  }

  /**
   * Pause tracking, optionally for a fixed number of minutes.
   *
   * A timed pause is the honest version of "don't track this": the alternative
   * people actually reach for is quitting the app, and then they forget to start
   * it again and lose the afternoon. Resuming is scheduled rather than
   * remembered.
   */
  pause(minutes?: number): void {
    if (!this.running) return
    this.clearResumeTimer()
    if (minutes && minutes > 0) {
      this.pausedUntil = this.now() + minutes * 60_000
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null
        this.pausedUntil = null
        this.resume()
      }, minutes * 60_000)
      this.resumeTimer.unref?.()
    } else {
      this.pausedUntil = null
    }
    if (this.paused) {
      this.emit()
      return
    }
    this.paused = true
    this.clearTimer()
    this.track(this.commit(this.builder.flush()))
    this.stretchStart = null
    this.emit()
  }

  resume(): void {
    this.clearResumeTimer()
    this.pausedUntil = null
    if (!this.running || !this.paused) return
    this.paused = false
    this.enterActive()
  }

  /**
   * Swap the capture adapter in place.
   *
   * Used when a user grants macOS Accessibility or switches capture mode: the
   * open session is closed first, because samples from a different adapter are
   * not a continuation of the stretch the old one was building.
   */
  setCapture(capture: Capture): void {
    if (capture === this.deps.capture) return
    this.track(this.commit(this.builder.flush()))
    this.deps.capture = capture
    this.emit()
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
      pausedUntil: this.pausedUntil,
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
        this.track(this.commit(this.builder.flush()))
        this.enterIdle(now)
        return
      }
      const sample = this.deps.capture.sample(now)
      if (sample) this.track(this.commit(this.builder.sample(sample, now)))
      else this.track(this.commit(this.builder.flush()))
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
    if (block) this.track(this.storeIdle(block))
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

  /**
   * Wait for every write this tracker has started.
   *
   * Storage writes are durable but asynchronous, and the engine deliberately
   * does not block a poll tick on the disk. That leaves one moment where the
   * difference matters: quitting. `stop()` followed by `drain()` is the only
   * ordering that guarantees the last session reached the journal before the
   * process exits. Tests use it for the same reason.
   */
  async drain(): Promise<void> {
    await this.pending
  }

  /**
   * Close the open session now and wait for it to reach the store.
   *
   * Ending a focus session has to seal minutes that are still sitting in the
   * builder; sealing against a day file that stops at the last flush would
   * claim an empty window. Closes at the last observed sample like every other
   * flush, so the unobserved tail is still not credited.
   */
  async flushOpenSession(): Promise<void> {
    this.track(this.commit(this.builder.flush()))
    await this.drain()
  }

  /** Chain a write onto the pending queue so `drain()` can await all of them. */
  private track(work: Promise<void>): void {
    this.pending = this.pending.then(() => work).catch((err) => {
      console.error('[tracker] write failed:', err)
    })
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

  private clearResumeTimer(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
  }

  private emit(): void {
    this.deps.onChange?.(this.status)
  }
}
