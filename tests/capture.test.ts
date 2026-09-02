/**
 * Native capture probe classification.
 *
 * `probeNativeOutOfProcess` spawns a real child process, so it is not worth
 * exercising here; `classifyProbeFailure` is the pure decision it feeds
 * through — the part that turns a raw exit status into the honest message and
 * remedy Settings shows. A packaged Windows install that is missing the
 * Visual C++ Redistributable dlopen-fails with a distinct stderr shape from
 * "module not installed", and the two must not collapse into the same
 * (wrong) advice.
 */

import { describe, expect, it } from 'vitest'

import { classifyProbeFailure } from '../src/main/capture'

describe('classifyProbeFailure', () => {
  it('is ok on a clean exit', () => {
    expect(classifyProbeFailure({ status: 0, signal: null, stderr: '' })).toEqual({ ok: true })
  })

  it('reports a genuinely missing module as reinstallable', () => {
    const result = classifyProbeFailure({
      status: 1,
      signal: null,
      stderr: "Error: Cannot find module '@miniben90/x-win'",
    })
    expect(result).toMatchObject({ ok: false, remedy: 'module-missing' })
    expect(result.error).toMatch(/not installed/)
  })

  it('distinguishes a failed native load from a missing module', () => {
    const result = classifyProbeFailure({
      status: 1,
      signal: null,
      stderr: '\\\\?\\C:\\...\\x-win.win32-x64-msvc.node\nThe specified module could not be found.',
    })
    expect(result).toMatchObject({ ok: false, remedy: 'module-missing' })
    expect(result.error).toMatch(/Visual C\+\+ Redistributable/)
  })

  it('recognises the Win32-application variant of a failed native load', () => {
    const result = classifyProbeFailure({
      status: 1,
      signal: null,
      stderr: '%1 is not a valid Win32 application.',
    })
    expect(result.error).toMatch(/Visual C\+\+ Redistributable/)
  })

  it('reports an unsupported desktop session distinctly from a load failure', () => {
    const result = classifyProbeFailure({
      status: 1,
      signal: null,
      stderr: "thread panicked at 'Wayland is not supported'",
    })
    expect(result).toMatchObject({ ok: false, remedy: 'unsupported-session' })
    expect(result.error).toMatch(/Wayland/)
  })

  it('reports a probe crash by signal as an unsupported session', () => {
    const result = classifyProbeFailure({ status: null, signal: 'SIGABRT', stderr: '' })
    expect(result).toMatchObject({ ok: false, remedy: 'unsupported-session' })
    expect(result.error).toContain('SIGABRT')
  })

  it('falls back to the first stderr line for anything unrecognised', () => {
    const result = classifyProbeFailure({
      status: 1,
      signal: null,
      stderr: 'some unexpected failure\nwith extra detail',
    })
    expect(result).toMatchObject({ ok: false, remedy: 'unsupported-session' })
    expect(result.error).toBe('some unexpected failure')
  })
})
