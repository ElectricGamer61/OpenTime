/**
 * Reading the browser's address bar on Windows.
 *
 * `x-win` is meant to report a browser's URL, but on current Chrome and Edge
 * on Windows it comes back empty, so OpenTime never knew which site anyone
 * was on. This reads it the way screen readers (and Rize) do: through UI
 * Automation, asking the focused browser window for its address box.
 *
 * UI Automation is a .NET API, so the reading happens in a tiny helper
 * program (src/native/address-helper.cs, about 20 MB while running) rather
 * than in Electron: started on the first browser window, it answers one line
 * per request and costs no CPU while idle. The capture loop never waits on
 * it. A title it has not read yet comes back as 'pending', the session
 * builder holds that page's label until the next poll, and by then the answer
 * is in the cache.
 *
 * What leaves this module is `readAddress`'s host and path, never the query or
 * fragment, and only the host is ever stored (see `WindowSample.address`).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

import { readAddress } from '../../core/categorize'

export type AddressRead = { host: string; address: string } | null | 'pending'

export interface AddressReader {
  /** The address of the focused browser window with this title. */
  read(title: string): AddressRead
  dispose(): void
}

/** How long a read address is trusted before the same title is read again. */
const FOUND_TTL_MS = 60_000
/** A window with no readable address (the bar was being typed in) is retried sooner. */
const MISSING_TTL_MS = 10_000
/** An answer slower than this means the helper is stuck. */
const TIMEOUT_MS = 4_000
/** The first answer also waits for the helper to start and load UI Automation. */
const STARTUP_TIMEOUT_MS = 15_000
const MAX_CACHE = 64
/** Restarts allowed before giving up for the session: a machine that cannot run it never will. */
const MAX_RESTARTS = 3

export type SpawnHelper = () => ChildProcessWithoutNullStreams

/**
 * The built helper, next to the main bundle (dist/native). In the installed
 * app it is unpacked beside the asar archive, because Windows cannot run a
 * program from inside one.
 */
export function helperPath(): string {
  return path.join(__dirname, '..', 'native', 'address-helper.exe').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export function spawnHelperProgram(): ChildProcessWithoutNullStreams {
  return spawn(helperPath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
}

export class WindowsAddressReader implements AddressReader {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private cache = new Map<string, { value: { host: string; address: string } | null; at: number }>()
  private inflight: { title: string; timer: ReturnType<typeof setTimeout> } | null = null
  private restarts = 0
  private disabled = false
  /** Whether the running helper has answered once, so it is past its startup. */
  private warm = false

  constructor(
    private readonly spawnHelper: SpawnHelper = spawnHelperProgram,
    private readonly now: () => number = Date.now
  ) {}

  read(title: string): AddressRead {
    if (this.disabled) return null
    const hit = this.cache.get(title)
    if (hit) {
      const ttl = hit.value ? FOUND_TTL_MS : MISSING_TTL_MS
      if (this.now() - hit.at < ttl) return hit.value
      // Stale: refresh in the background but keep answering with what we had.
      this.request(title)
      return hit.value
    }
    this.request(title)
    return this.disabled ? null : 'pending'
  }

  dispose(): void {
    this.disabled = true
    this.clearInflight()
    this.stop()
  }

  private request(title: string): void {
    if (this.inflight || this.disabled) return
    const child = this.ensureChild()
    if (!child) return
    const timer = setTimeout(() => {
      // Stuck: remember that this window had nothing, so the loop moves on,
      // and start a fresh helper next time.
      this.remember(title, null)
      this.inflight = null
      this.stop()
      this.restarts += 1
      if (this.restarts > MAX_RESTARTS) this.disabled = true
    }, this.warm ? TIMEOUT_MS : STARTUP_TIMEOUT_MS)
    timer.unref?.()
    this.inflight = { title, timer }
    try {
      child.stdin.write('\n')
    } catch {
      this.clearInflight()
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnHelper()
    } catch (err) {
      console.error('[capture] address reader unavailable:', err)
      this.disabled = true
      return null
    }
    this.child = child
    this.buffer = ''
    this.warm = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    child.on('error', (err) => {
      console.error('[capture] address reader failed:', err)
      if (this.child === child) this.child = null
      this.disabled = true
      this.clearInflight()
    })
    child.on('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.clearInflight()
      this.restarts += 1
      if (this.restarts > MAX_RESTARTS) this.disabled = true
    })
    return child
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    this.warm = true
    const tab = line.indexOf('\t')
    const title = tab >= 0 ? line.slice(0, tab) : line
    const value = tab >= 0 ? line.slice(tab + 1) : ''
    this.clearInflight()
    // Filed under the title the helper actually saw: if the user switched
    // windows while it was reading, the answer belongs to the new window, and
    // the one asked about is simply read again on the next poll.
    this.remember(title, readAddress(value))
  }

  private remember(title: string, value: { host: string; address: string } | null): void {
    this.cache.delete(title)
    this.cache.set(title, { value, at: this.now() })
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private clearInflight(): void {
    if (this.inflight) clearTimeout(this.inflight.timer)
    this.inflight = null
  }

  private stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.end()
      child.kill()
    } catch {
      // Already gone.
    }
  }
}
