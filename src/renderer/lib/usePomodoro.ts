/**
 * Pomodoro scheduling, wired to the running app.
 *
 * `src/core/pomodoro.ts` is the pure phase arithmetic; this is the state
 * machine that actually calls `app.startFocus`/`app.endFocus` at the right
 * moments. The design constraint is the one stated there: a work phase *is*
 * a focus session, a break phase never is, and pausing seals rather than
 * inventing a pause `ActiveFocus` cannot represent. See `core/pomodoro.ts`'s
 * top-of-file note before changing any of the transitions below — every one
 * of them exists to keep exactly one sealed session covering exactly the
 * minutes that were really worked, never more.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { PomodoroPhase } from '../../core/pomodoro'
import { otherPhase, pomodoroCountdown } from '../../core/pomodoro'
import { useNow } from '../state/useOpenTime'
import type { OpenTimeState } from '../state/useOpenTime'

export interface PomodoroInput {
  label: string
  projectId?: string
  workMinutes: number
  breakMinutes: number
}

interface PomodoroRun {
  label: string
  projectId?: string
  workMinutes: number
  breakMinutes: number
  phase: PomodoroPhase
  cyclesCompleted: number
  paused: boolean
  /** Epoch ms the current phase ends at. Null while paused. */
  endsAt: number | null
  /** Seconds frozen at the moment of pausing. Null while running. */
  pausedRemaining: number | null
}

function phaseSeconds(run: PomodoroRun, phase: PomodoroPhase): number {
  return (phase === 'work' ? run.workMinutes : run.breakMinutes) * 60
}

export function usePomodoro(app: OpenTimeState) {
  const [run, setRun] = useState<PomodoroRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow(1000)
  const runRef = useRef(run)
  runRef.current = run
  /**
   * Bumped by every action that can open a work session (the tick, skip,
   * resume). `advanceTo` snapshots it before awaiting `openWork` and checks
   * it after: if something newer has started in the meantime — most
   * concretely, `stop()` landing while the tick's own transition is still
   * waiting on `app.startFocus` — the session `openWork` just opened has no
   * `run` left to represent it, so it is sealed immediately instead of
   * being left running with no Pomodoro framing over it.
   */
  const epoch = useRef(0)

  const remainingNow = (r: PomodoroRun): number =>
    r.paused ? (r.pausedRemaining ?? 0) : Math.max(0, Math.round(((r.endsAt ?? now) - now) / 1000))

  /** Seal the current work phase's session, if any is actually open. Swallowed on purpose — see the module note. */
  const sealWork = useCallback(async () => {
    if (!app.status?.focus) return
    await app.endFocus()
  }, [app])

  const openWork = useCallback(
    async (r: Pick<PomodoroRun, 'label' | 'projectId'>, minutes: number): Promise<boolean> => {
      const result = await app.startFocus({
        label: r.label,
        minutes: Math.max(1, minutes),
        projectId: r.projectId,
      })
      if (!result.ok) {
        setError(result.message || 'That work block could not be started.')
        return false
      }
      return true
    },
    [app]
  )

  const start = useCallback(
    async (input: PomodoroInput) => {
      setError(null)
      setBusy(true)
      const ok = await openWork(input, input.workMinutes)
      setBusy(false)
      if (!ok) return
      setRun({
        label: input.label,
        projectId: input.projectId,
        workMinutes: input.workMinutes,
        breakMinutes: input.breakMinutes,
        phase: 'work',
        cyclesCompleted: 0,
        paused: false,
        endsAt: Date.now() + input.workMinutes * 60_000,
        pausedRemaining: null,
      })
    },
    [openWork]
  )

  /**
   * Move on to `next`, at its full planned length — used by a natural phase
   * completion and by "Skip". `myEpoch` is this call's stamp: if `stop()` (or
   * another transition) has bumped `epoch` past it by the time `openWork`
   * resolves, this call has been superseded — the session it just opened is
   * sealed immediately rather than left running with no `run` above it.
   */
  const advanceTo = useCallback(
    async (next: PomodoroPhase, from: PomodoroRun, myEpoch: number) => {
      if (next === 'work') {
        const ok = await openWork(from, from.workMinutes)
        if (epoch.current !== myEpoch) {
          if (ok) await app.endFocus()
          return
        }
        if (!ok) {
          setRun(null)
          return
        }
      }
      setRun((prev) =>
        prev
          ? {
              ...prev,
              phase: next,
              cyclesCompleted: next === 'break' ? prev.cyclesCompleted + 1 : prev.cyclesCompleted,
              paused: false,
              endsAt: Date.now() + phaseSeconds(prev, next) * 1000,
              pausedRemaining: null,
            }
          : prev
      )
    },
    [openWork, app]
  )

  // The tick that actually drives phase transitions. Runs off the same `now`
  // the countdown is drawn from, so "the ring hit zero" and "advance the
  // phase" can never disagree.
  useEffect(() => {
    const r = runRef.current
    if (!r || r.paused || r.endsAt === null || busy) return
    if (now < r.endsAt) return
    const myEpoch = ++epoch.current
    setBusy(true)
    void (async () => {
      if (r.phase === 'work') await sealWork()
      await advanceTo(otherPhase(r.phase), r, myEpoch)
      setBusy(false)
    })()
  }, [now, busy, sealWork, advanceTo])

  const pause = useCallback(async () => {
    const r = runRef.current
    if (!r || r.paused || busy) return
    const remaining = remainingNow(r)
    setBusy(true)
    if (r.phase === 'work') await sealWork()
    setRun((prev) => (prev ? { ...prev, paused: true, endsAt: null, pausedRemaining: remaining } : prev))
    setBusy(false)
  }, [busy, sealWork])

  const resume = useCallback(async () => {
    const r = runRef.current
    if (!r || !r.paused || busy) return
    const remaining = r.pausedRemaining ?? 0
    setBusy(true)
    // Under a minute left is not worth reopening a session for — hand off to
    // the next phase instead of asking `startFocus` to run a session shorter
    // than the store will even keep.
    if (r.phase === 'work' && remaining < 60) {
      await advanceTo('break', r, ++epoch.current)
      setBusy(false)
      return
    }
    if (r.phase === 'work') {
      const ok = await openWork(r, Math.max(1, Math.round(remaining / 60)))
      setBusy(false)
      if (!ok) return
    } else {
      setBusy(false)
    }
    setRun((prev) => (prev ? { ...prev, paused: false, endsAt: Date.now() + remaining * 1000, pausedRemaining: null } : prev))
  }, [busy, openWork, advanceTo])

  const skip = useCallback(async () => {
    const r = runRef.current
    if (!r || busy) return
    setBusy(true)
    if (r.phase === 'work' && !r.paused) await sealWork()
    await advanceTo(otherPhase(r.phase), r, ++epoch.current)
    setBusy(false)
  }, [busy, sealWork, advanceTo])

  const stop = useCallback(async () => {
    const r = runRef.current
    if (!r) return
    // Stop always wins, even mid-transition: bumping the epoch here makes any
    // `advanceTo` currently awaiting `openWork` recognise it has been
    // superseded and seal the session it opens instead of resurrecting `run`.
    ++epoch.current
    if (r.phase === 'work' && !r.paused) await sealWork()
    setRun(null)
    setError(null)
    setBusy(false)
  }, [sealWork])

  const progress = run ? pomodoroCountdown(remainingNow(run), phaseSeconds(run, run.phase)) : null

  return {
    run: run
      ? {
          label: run.label,
          phase: run.phase,
          cyclesCompleted: run.cyclesCompleted,
          paused: run.paused,
          workMinutes: run.workMinutes,
          breakMinutes: run.breakMinutes,
        }
      : null,
    progress,
    error,
    /** True while a phase transition is in flight — disable Pause/Resume/Skip in the UI rather than let a double-click race it. */
    busy,
    start,
    pause,
    resume,
    skip,
    stop,
  }
}
