import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '../src/core/defaults'
import {
  bucketEvents,
  buildAuthUrl,
  exchangeCode,
  fetchEvents,
  mapGoogleEvent,
  needsRefresh,
  REDIRECT_URI,
  refreshTokens,
} from '../src/main/calendar/google'

const calendar = { ...DEFAULT_SETTINGS.calendar, clientId: 'cid', clientSecret: 'secret' }

describe('buildAuthUrl', () => {
  it('requests offline access with the configured scope and a loopback redirect', () => {
    const url = new URL(buildAuthUrl(calendar, 'state123'))
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBe('state123')
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.readonly'
    )
    // The secret must never appear in a URL the browser will see.
    expect(url.search).not.toContain('secret')
  })
})

describe('needsRefresh', () => {
  const now = Date.now()

  it('is true when the token is missing', () => {
    expect(needsRefresh({ accessToken: '', refreshToken: 'r', expiresAt: now + 3600_000 }, now)).toBe(true)
  })

  it('is true inside the five-minute margin', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 60_000 }, now)).toBe(true)
  })

  it('is false for a comfortably fresh token', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 3600_000 }, now)).toBe(false)
  })
})

describe('refreshTokens', () => {
  it('keeps the refresh token and recomputes the expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    }) as unknown as typeof fetch

    const next = await refreshTokens(
      calendar,
      { accessToken: 'old', refreshToken: 'keep-me', expiresAt: 0 },
      fetchImpl
    )
    expect(next.accessToken).toBe('new-access')
    expect(next.refreshToken).toBe('keep-me')
    expect(next.expiresAt).toBeGreaterThan(Date.now())
  })

  it('throws on a revoked grant instead of retrying forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch
    await expect(
      refreshTokens(calendar, { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, fetchImpl)
    ).rejects.toThrow(/400/)
  })
})

describe('mapGoogleEvent', () => {
  it('maps a timed event', () => {
    const event = mapGoogleEvent({
      id: 'e1',
      summary: 'Design review',
      start: { dateTime: '2026-03-14T11:00:00Z' },
      end: { dateTime: '2026-03-14T12:00:00Z' },
    })
    expect(event).toMatchObject({ id: 'e1', title: 'Design review', allDay: false, source: 'google' })
    expect(event!.end - event!.start).toBe(3600_000)
  })

  it('flags an all-day event', () => {
    const event = mapGoogleEvent({
      id: 'e2',
      summary: 'Public holiday',
      start: { date: '2026-03-14' },
      end: { date: '2026-03-15' },
    })
    expect(event!.allDay).toBe(true)
  })

  it('names an untitled event rather than rendering a blank block', () => {
    const event = mapGoogleEvent({
      id: 'e3',
      start: { dateTime: '2026-03-14T11:00:00Z' },
      end: { dateTime: '2026-03-14T11:30:00Z' },
    })
    expect(event!.title).toBe('(no title)')
  })

  it('drops an event with no usable times', () => {
    expect(mapGoogleEvent({ id: 'e4', summary: 'Broken' })).toBeNull()
  })
})

describe('fetchEvents', () => {
  it('sends the bearer token and expands recurring events', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: 'e1',
            summary: 'Standup',
            start: { dateTime: '2026-03-14T09:30:00Z' },
            end: { dateTime: '2026-03-14T09:45:00Z' },
          },
          { id: 'bad', summary: 'No times' },
        ],
      }),
    }) as unknown as typeof fetch

    const events = await fetchEvents('token123', Date.parse('2026-03-14'), Date.parse('2026-03-15'), fetchImpl)
    expect(events).toHaveLength(1)

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).toContain('singleEvents=true')
    expect(init.headers.authorization).toBe('Bearer token123')
  })

  it('surfaces an API failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch
    await expect(fetchEvents('t', 0, 1, fetchImpl)).rejects.toThrow(/403/)
  })

  it('propagates a network failure rather than reporting an empty calendar', async () => {
    // An offline laptop must show "sync failed", not "you have no meetings" —
    // silently returning nothing would erase the overlay for the whole week.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')) as unknown as typeof fetch
    await expect(fetchEvents('t', 0, 1, fetchImpl)).rejects.toThrow(/ENOTFOUND/)
  })

  it('tolerates a response with no items at all', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch
    await expect(fetchEvents('t', 0, 1, fetchImpl)).resolves.toEqual([])
  })

  it('fails loudly on a body that is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    }) as unknown as typeof fetch
    await expect(fetchEvents('t', 0, 1, fetchImpl)).rejects.toThrow(SyntaxError)
  })
})

describe('exchangeCode', () => {
  it('returns a token set on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    }) as unknown as typeof fetch
    const tokens = await exchangeCode(calendar, 'code123', fetchImpl)
    expect(tokens).toMatchObject({ accessToken: 'a', refreshToken: 'r' })
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
  })

  it('reports a rejected authorization code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch
    await expect(exchangeCode(calendar, 'stale-code', fetchImpl)).rejects.toThrow(/400/)
  })

  it('survives a grant that comes back with no refresh token', async () => {
    // Google omits `refresh_token` when the user has already granted consent
    // and `prompt=consent` did not force a new one.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'a', expires_in: 3600 }),
    }) as unknown as typeof fetch
    await expect(exchangeCode(calendar, 'code', fetchImpl)).resolves.toMatchObject({
      refreshToken: '',
    })
  })
})

describe('bucketEvents', () => {
  it('groups events into tracking days and sorts each day', () => {
    const at = (h: number) => new Date(2026, 2, 14, h, 0, 0, 0).getTime()
    const buckets = bucketEvents(
      [
        { id: 'b', title: 'Later', start: at(15), end: at(16), source: 'google' },
        { id: 'a', title: 'Earlier', start: at(9), end: at(10), source: 'google' },
        { id: 'c', title: 'Late night', start: at(1), end: at(2), source: 'google' },
      ],
      4
    )
    expect(buckets['2026-03-14'].map((e) => e.id)).toEqual(['a', 'b'])
    // 1am belongs to the previous tracking day.
    expect(buckets['2026-03-13'].map((e) => e.id)).toEqual(['c'])
  })
})
