/**
 * Distraction blocking, as pure decisions.
 *
 * OpenTime cannot close or minimise another application's window, and would not
 * want to: that is a much larger promise about what it may do to someone's
 * machine than "it reads which window has focus". What it does instead is put
 * a shield over the screen while a blocked app or site is in front during a
 * focus session. The shield never takes keyboard focus, so Ctrl+W or switching
 * apps still works, and the moment something else is in front it goes away.
 *
 * Everything here is pure so the matching rules and the show/hide state machine
 * are testable without Electron. `src/main/blocker.ts` drives it.
 */

import { BROWSER_RE } from './categorize'
import type { WindowSample } from './types'

/** Offered, pre-filled, when someone switches blocking on. Editable. */
export const DEFAULT_BLOCK_TARGETS = [
  'youtube.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'netflix.com',
  'twitch.tv',
]

/** How long "Allow 5 minutes" lets one target through. */
export const SNOOZE_MINUTES = 5

/**
 * Reduce whatever someone typed to the form matching works on.
 *
 * "https://www.YouTube.com/watch?v=x" and "youtube.com" have to mean the same
 * thing, and "Steam.exe" has to match the app called "steam". Returns '' for
 * input that names nothing.
 */
export function normalizeBlockTarget(raw: string): string {
  let t = String(raw ?? '').trim().toLowerCase()
  if (!t) return ''
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
  t = t.replace(/[/?#].*$/, '') // path, query, fragment
  t = t.replace(/^www\./, '')
  t = t.replace(/:\d+$/, '') // port
  t = t.replace(/\.exe$/, '')
  return t.trim()
}

/** Normalise and de-duplicate a list of targets, dropping empties. */
export function normalizeBlockTargets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const item of raw) {
    const t = normalizeBlockTarget(String(item ?? ''))
    if (t) seen.add(t)
  }
  return [...seen]
}

const isHost = (target: string) => target.includes('.')

/** Whole-word, case-insensitive containment. */
function hasWord(haystack: string, word: string): boolean {
  if (!word) return false
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(haystack)
}

/**
 * The target a window is blocked by, or null.
 *
 * A site target matches the browser's host exactly or as a parent domain
 * ("youtube.com" covers "m.youtube.com" but "x.com" does not cover
 * "dropbox.com"). Browsers do not always expose the URL, so a browser window
 * with no host falls back to the site's name appearing as a word in the title
 * - "youtube" in "Lo-fi beats - YouTube" - but only for names long enough not
 * to collide with ordinary words ("x" alone never matches).
 *
 * An app/word target matches the app's name, or a whole word in the title.
 */
export function blockedBy(sample: WindowSample | null, targets: string[]): string | null {
  if (!sample || !targets.length) return null
  const app = sample.app.toLowerCase().replace(/\.exe$/, '')
  const title = sample.title || ''
  const host = normalizeBlockTarget(sample.url || '')
  const browser = BROWSER_RE.test(app)

  for (const target of targets) {
    if (isHost(target)) {
      if (host) {
        if (host === target || host.endsWith(`.${target}`)) return target
        continue
      }
      if (!browser) continue
      const name = target.split('.')[0]
      if (name.length >= 4 && hasWord(title, name)) return target
    } else {
      // Containment catches "discord" in "Discord PTB"; below three letters it
      // would catch nearly everything, so short targets must match exactly.
      if (app === target || (target.length >= 3 && app.includes(target))) return target
      if (hasWord(title, target)) return target
    }
  }
  return null
}

/** The pretty name shown on the shield: "YouTube", not "youtube.com". */
export function blockLabel(target: string, sample: WindowSample | null): string {
  if (!isHost(target) && sample?.app) return sample.app
  if (BRAND_NAMES[target]) return BRAND_NAMES[target]
  const name = target.split('.')[0]
  return name ? name[0].toUpperCase() + name.slice(1) : target
}

/** How the usual suspects spell themselves, so the shield never says "Youtube". */
const BRAND_NAMES: Record<string, string> = {
  'youtube.com': 'YouTube',
  'x.com': 'X',
  'tiktok.com': 'TikTok',
  'twitch.tv': 'Twitch',
  'linkedin.com': 'LinkedIn',
}

/** "YouTube, Reddit and 7 more": a whole block list in one short line. */
export function describeBlockList(targets: string[]): string {
  if (!targets.length) return ''
  const names = targets.slice(0, 2).map((t) => blockLabel(t, null))
  const rest = targets.length - names.length
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(' and ')
}

export interface ShieldState {
  /** The target currently shielded, or null when the shield is down. */
  target: string | null
  /** Epoch ms each snoozed target is allowed until. */
  snoozed: Record<string, number>
}

export const SHIELD_IDLE: ShieldState = { target: null, snoozed: {} }

/**
 * One step of the shield's state machine.
 *
 * `sample` is what is in front right now, where null means "nothing OpenTime
 * would record" - which includes OpenTime itself, and so the shield. That is
 * why null keeps the current state instead of lowering it: clicking the shield
 * must not be the thing that dismisses it.
 */
export function nextShield(
  state: ShieldState,
  input: { active: boolean; sample: WindowSample | null; targets: string[]; now: number }
): ShieldState {
  if (!input.active) return SHIELD_IDLE
  const snoozed = Object.fromEntries(
    Object.entries(state.snoozed).filter(([, until]) => until > input.now)
  )
  if (input.sample === null) return { target: state.target, snoozed }
  const hit = blockedBy(input.sample, input.targets)
  if (hit && !(snoozed[hit] > input.now)) return { target: hit, snoozed }
  return { target: null, snoozed }
}

/** Let one target through for `SNOOZE_MINUTES`, and lower the shield. */
export function snoozeShield(state: ShieldState, now: number): ShieldState {
  if (!state.target) return state
  return {
    target: null,
    snoozed: { ...state.snoozed, [state.target]: now + SNOOZE_MINUTES * 60_000 },
  }
}
