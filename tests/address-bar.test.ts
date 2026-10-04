import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WindowsAddressReader } from '../src/main/capture/addressBar'
import { NativeCapture } from '../src/main/capture'

/**
 * A stand-in for the PowerShell helper: it records each request and answers
 * with whatever the test says the foreground window is.
 */
function fakeHelper() {
  const spawned: Array<{ requests: number; answer(title: string, value: string): void; exit(): void }> = []
  const spawn = () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() })
    const handle = {
      requests: 0,
      answer: (title: string, value: string) => stdout.write(`${title}\t${value}\r\n`),
      exit: () => child.emit('exit', 1),
    }
    stdin.on('data', (chunk: Buffer) => {
      handle.requests += chunk.toString().split('\n').length - 1
    })
    spawned.push(handle)
    return child
  }
  return { spawn, spawned }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('WindowsAddressReader', () => {
  it('answers pending first, then the page from the cache', async () => {
    const helper = fakeHelper()
    const reader = new WindowsAddressReader(helper.spawn)
    expect(reader.read('OpenTime - Google Chrome')).toBe('pending')
    await flush()
    expect(helper.spawned[0].requests).toBe(1)

    helper.spawned[0].answer('OpenTime - Google Chrome', 'github.com/ElectricGamer61/OpenTime?tab=readme')
    await flush()
    expect(reader.read('OpenTime - Google Chrome')).toEqual({
      host: 'github.com',
      address: 'github.com/electricgamer61/opentime',
    })
    reader.dispose()
  })

  it('asks once at a time, and starts only one helper', async () => {
    const helper = fakeHelper()
    const reader = new WindowsAddressReader(helper.spawn)
    reader.read('A')
    reader.read('A')
    reader.read('B')
    await flush()
    expect(helper.spawned).toHaveLength(1)
    expect(helper.spawned[0].requests).toBe(1)
    reader.dispose()
  })

  it('files the answer under the window the helper actually saw', async () => {
    const helper = fakeHelper()
    const reader = new WindowsAddressReader(helper.spawn)
    reader.read('Page one')
    await flush()
    // The user switched tabs while it was reading.
    helper.spawned[0].answer('Page two', 'youtube.com/watch')
    await flush()
    expect(reader.read('Page two')).toEqual({ host: 'youtube.com', address: 'youtube.com/watch' })
    expect(reader.read('Page one')).toBe('pending')
    reader.dispose()
  })

  it('treats a search being typed as no address', async () => {
    const helper = fakeHelper()
    const reader = new WindowsAddressReader(helper.spawn)
    reader.read('New Tab')
    await flush()
    helper.spawned[0].answer('New Tab', 'how to color grade')
    await flush()
    expect(reader.read('New Tab')).toBeNull()
    reader.dispose()
  })

  it('gives up on a helper that never answers, and on one that keeps dying', async () => {
    vi.useFakeTimers()
    const helper = fakeHelper()
    const reader = new WindowsAddressReader(helper.spawn)
    reader.read('Stuck')
    vi.advanceTimersByTime(21_000)
    // The stuck window is remembered as having no address, so the loop moves on.
    expect(reader.read('Stuck')).toBeNull()

    for (let i = 0; i < 4; i += 1) {
      reader.read(`Window ${i}`)
      helper.spawned[helper.spawned.length - 1].exit()
    }
    expect(reader.read('Anything else')).toBeNull()
    reader.dispose()
  })

  it('never starts a helper once disposed', () => {
    const helper = fakeHelper()
    const reader = new WindowsAddressReader(helper.spawn)
    reader.dispose()
    expect(reader.read('A')).toBeNull()
    expect(helper.spawned).toHaveLength(0)
  })
})

describe('NativeCapture addresses', () => {
  const window = (name: string, title: string, url = '') => ({
    activeWindow: () => ({ title, url, info: { name, path: `C:\\${name}.exe` } }),
  })

  it('reads the address bar for a browser when x-win has no URL', () => {
    const reader = { read: vi.fn(() => ({ host: 'github.com', address: 'github.com/acme/repo' })), dispose: vi.fn() }
    const capture = new NativeCapture(window('Google Chrome', 'repo - Google Chrome'), 'C:\\OpenTime.exe', reader)
    expect(capture.sample()).toMatchObject({ url: 'github.com', address: 'github.com/acme/repo' })
    expect(reader.read).toHaveBeenCalledWith('repo - Google Chrome')
  })

  it('marks a browser page pending while its address is read', () => {
    const reader = { read: vi.fn(() => 'pending' as const), dispose: vi.fn() }
    const capture = new NativeCapture(window('Microsoft Edge', 'Inbox'), 'C:\\OpenTime.exe', reader)
    expect(capture.sample()).toMatchObject({ url: '', urlPending: true })
  })

  it('prefers the URL x-win reports, and never reads anything for other apps', () => {
    const reader = { read: vi.fn(() => null), dispose: vi.fn() }
    const safari = new NativeCapture(
      window('Safari', 'Docs', 'https://developer.mozilla.org/en-US/docs?x=1'),
      '/OpenTime',
      reader
    )
    expect(safari.sample()).toMatchObject({ url: 'developer.mozilla.org', address: 'developer.mozilla.org/en-us/docs' })

    const code = new NativeCapture(window('Code', 'a.ts'), 'C:\\OpenTime.exe', reader)
    expect(code.sample()).toMatchObject({ url: '' })
    expect(reader.read).not.toHaveBeenCalled()
  })
})
