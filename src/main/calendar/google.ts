/**
 * Google Calendar integration — OAuth wiring shape and REST client.
 *
 * Design notes (carried forward from the older Norte/Command implementation,
 * which had already solved these two problems):
 *
 *  1. **User-owned credentials.** OpenTime ships no client id or secret. The
 *     user creates a free OAuth client in their own Google Cloud project and
 *     pastes it into Settings; it is stored only in the local app-data file,
 *     never in the installer. That keeps the app free, open, and unattached to
 *     any hosted service of ours.
 *
 *  2. **Electron's user agent.** Google refuses OAuth in a window advertising
 *     Electron's default UA. The auth flow therefore runs in a dedicated
 *     `BrowserWindow` that presents an ordinary Chrome UA string while sharing
 *     the default session so an existing Google login carries over.
 *
 * No secret is required for anything below to compile or for the rest of the app
 * to run: when the user has not connected an account, `fetchEvents` simply
 * returns nothing and the UI shows the disconnected state.
 */

import { dayKey } from '../../core/day'
import type { CalendarEvent, CalendarSettings } from '../../core/types'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const EVENTS_ENDPOINT =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

/** Loopback redirect — the installed-app flow, no hosted callback needed. */
export const REDIRECT_URI = 'http://127.0.0.1:47813/oauth/callback'

/** Chrome UA presented by the auth window so Google accepts the flow. */
export const OAUTH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** Epoch ms. */
  expiresAt: number
}

export function buildAuthUrl(settings: CalendarSettings, state: string): string {
  const params = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: `https://www.googleapis.com/auth/${settings.scope}`,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

export async function exchangeCode(
  settings: CalendarSettings,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  })
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`)
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || '',
    expiresAt: Date.now() + json.expires_in * 1000,
  }
}

/** Refresh five minutes before expiry, so no request ever races the boundary. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

export function needsRefresh(tokens: TokenSet, now = Date.now()): boolean {
  return !tokens.accessToken || tokens.expiresAt - now <= REFRESH_MARGIN_MS
}

export async function refreshTokens(
  settings: CalendarSettings,
  tokens: TokenSet,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    // `invalid_grant` means the user revoked access — the caller flips the
    // account back to disconnected rather than retrying forever.
    throw new Error(`token refresh failed (${res.status})`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  return {
    accessToken: json.access_token,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  }
}

/** Raw Google event shape, trimmed to the fields we keep. */
interface GoogleEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

export function mapGoogleEvent(raw: GoogleEvent): CalendarEvent | null {
  const startIso = raw.start?.dateTime || raw.start?.date
  const endIso = raw.end?.dateTime || raw.end?.date
  if (!startIso || !endIso) return null
  return {
    id: raw.id,
    title: raw.summary || '(no title)',
    start: new Date(startIso).getTime(),
    end: new Date(endIso).getTime(),
    allDay: !raw.start?.dateTime,
    source: 'google',
  }
}

export async function fetchEvents(
  accessToken: string,
  timeMin: number,
  timeMax: number,
  fetchImpl: typeof fetch = fetch
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  })
  // Plain fetch, no `googleapis` SDK — one HTTP call does not justify a
  // several-megabyte dependency in a process we want to stay small.
  const res = await fetchImpl(`${EVENTS_ENDPOINT}?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`calendar fetch failed (${res.status})`)
  const json = (await res.json()) as { items?: GoogleEvent[] }
  return (json.items || []).map(mapGoogleEvent).filter((e): e is CalendarEvent => e !== null)
}

/** Bucket fetched events into tracking-day keys for storage. */
export function bucketEvents(
  events: CalendarEvent[],
  dayStartHour: number
): Record<string, CalendarEvent[]> {
  const out: Record<string, CalendarEvent[]> = {}
  for (const e of events) {
    ;(out[dayKey(e.start, dayStartHour)] ||= []).push(e)
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => a.start - b.start)
  return out
}
