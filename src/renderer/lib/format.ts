/** Presentation helpers. Pure and cheap — safe to call inside render. */

const HOUR_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})
/** The calendar header carries the year, because it can be scrolled into last year. */
const DATED_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

/** "3h 12m", "48m", "—" — the everyday duration format. */
export function duration(seconds: number): string {
  if (!seconds || seconds < 1) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  if (m) return `${m}m`
  return `${Math.round(seconds)}s`
}

/** "1:04:22" — for the live counter, where seconds matter. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export function timeOfDay(ts: number): string {
  return HOUR_FMT.format(ts)
}

export function weekdayShort(ts: number): string {
  return DAY_FMT.format(ts)
}

export function longDate(ts: number): string {
  return FULL_FMT.format(ts)
}

export function datedTitle(ts: number): string {
  return DATED_FMT.format(ts)
}

export function percent(share: number): string {
  if (!share) return '0%'
  return `${Math.round(share * 100)}%`
}

const PRODUCTIVITY_COLORS: Record<string, string> = {
  productive: 'var(--productive)',
  neutral: 'var(--neutral)',
  distracting: 'var(--distracting)',
  idle: 'var(--idle)',
}

export function productivityColor(kind: string): string {
  return PRODUCTIVITY_COLORS[kind] || 'var(--neutral)'
}

/**
 * Translucent fill derived from a project colour, so the timeline is scannable
 * by project at a glance while the left border still carries productivity.
 * Accepts `#rgb` and `#rrggbb`; anything else falls back to a neutral wash.
 */
export function blockFill(color: string, alpha = 0.16): string {
  const hex = color?.trim().replace('#', '')
  const full =
    hex?.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  if (!full || full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) {
    return `rgba(148, 163, 184, ${alpha})`
  }
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
