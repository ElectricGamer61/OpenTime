/**
 * The focus shield page. Vanilla DOM on purpose: it has to appear the instant
 * a blocked window comes to the front, so it carries no framework to boot.
 */

import type { ShieldAction, ShieldView } from '../shared/ipc'

declare global {
  interface Window {
    shield: {
      getView(): Promise<ShieldView | null>
      onView(handler: (view: ShieldView) => void): void
      act(action: ShieldAction): void
    }
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement

let endsAt: number | null = null

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function tick(): void {
  const left = $('left')
  if (!endsAt) {
    left.textContent = ''
    return
  }
  const seconds = Math.max(0, Math.round((endsAt - Date.now()) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  left.textContent = `${h ? `${h}:${pad(m)}` : m}:${pad(s)} left`
}

function render(view: ShieldView | null): void {
  if (!view) return
  $('what').textContent = view.label
  $('focus').textContent = view.focusLabel || 'your focus session'
  endsAt = view.endsAt
  tick()
}

$('snooze').addEventListener('click', () => window.shield.act('snooze'))
$('end').addEventListener('click', () => window.shield.act('end'))

window.shield.onView(render)
void window.shield.getView().then(render)
setInterval(tick, 1000)
