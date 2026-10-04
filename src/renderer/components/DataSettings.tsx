import { useMemo, useState } from 'react'

import { dayKey, lastNDayKeys } from '../../core/day'
import type { Settings } from '../../core/types'
import type { ExportFormat } from '../../shared/ipc'
import { IconInfo } from './Icons'
import type { OpenTimeState } from '../state/useOpenTime'

const RETENTION_CHOICES = [
  { value: 0, label: 'Keep everything' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
]

/**
 * Export ranges.
 *
 * Storage and the export builder have always taken a `fromKey`/`toKey`; until
 * now the UI passed neither, so every export was the whole history whatever the
 * user wanted. `days: 0` keeps meaning "everything".
 */
const RANGE_CHOICES = [
  { value: 0, label: 'All time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
]

/**
 * Your data: get it out, put it back, see where it is, throw it away.
 *
 * This card exists because "local-first" is a claim, and a claim you cannot act
 * on is marketing. Every control here is one the user can verify with their own
 * file manager immediately afterwards.
 */
export function DataSettings({
  app,
  draft,
  patch,
}: {
  app: OpenTimeState
  draft: Settings
  patch(p: Partial<Settings>): void
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [rangeDays, setRangeDays] = useState(0)

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true)
    setMessage('')
    const result = await fn()
    setBusy(false)
    setMessage(result.message)
  }

  const days = app.historyKeys.length

  // The bounds are day keys, and the count is how many stored days actually
  // fall inside them — "Last 30 days" over a fortnight of history is 14 days,
  // and saying 30 would be a promise the file does not keep.
  const range = useMemo(() => {
    if (!rangeDays) return { count: days }
    const latest = app.historyKeys[app.historyKeys.length - 1]
    if (!latest) return { count: 0 }
    const keys = lastNDayKeys(rangeDays, latest)
    const fromKey = keys[0]
    const toKey = keys[keys.length - 1]
    return {
      fromKey,
      toKey,
      count: app.historyKeys.filter((k) => k >= fromKey && k <= toKey).length,
    }
  }, [rangeDays, app.historyKeys, days])

  const exportAs = (format: ExportFormat) =>
    run(() => app.exportData({ format, fromKey: range.fromKey, toKey: range.toKey }))

  return (
    <div className="card">
      <h2 className="card-title">Your data</h2>
      <p className="card-note">
        {days
          ? `${days} tracked day${days === 1 ? '' : 's'} stored in `
          : 'Nothing recorded yet. Your history will be stored in '}
        <code className="mono">{app.dataDirectory}</code>. One file per day, in plain JSON you can
        read without OpenTime, and yours to copy, sync or delete.
      </p>

      <div className="setting-row">
        <div>
          <div className="setting-name">Export range</div>
          <div className="setting-desc">
            Which days the next export covers. A full backup always restores whatever it contains,
            so a narrowed backup restores only those days.
          </div>
        </div>
        <select
          aria-label="Export range"
          value={rangeDays}
          onChange={(e) => setRangeDays(Number(e.target.value))}
        >
          {RANGE_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row wide">
        <div>
          <div className="setting-name">Export</div>
          <div className="setting-desc">
            Sessions as CSV for a spreadsheet or an invoice, a day-by-day summary for a chart, or a
            full backup that restores everything including settings and rules.{' '}
            {range.count
              ? `${range.count} stored day${range.count === 1 ? '' : 's'} in range.`
              : 'No stored days in that range.'}
          </div>
        </div>
        <div className="row wrap">
          <button
            className="btn"
            disabled={busy || !range.count}
            onClick={() => void exportAs('sessions-csv')}
          >
            Sessions CSV
          </button>
          <button
            className="btn"
            disabled={busy || !range.count}
            onClick={() => void exportAs('daily-csv')}
          >
            Daily CSV
          </button>
          <button
            className="btn"
            disabled={busy || !range.count}
            onClick={() => void exportAs('backup-json')}
          >
            Full backup
          </button>
        </div>
      </div>

      <div className="setting-row wide">
        <div>
          <div className="setting-name">Restore a backup</div>
          <div className="setting-desc">
            Replaces everything currently stored. OpenTime asks for confirmation and tells you how
            much history the file holds first.
          </div>
        </div>
        <div className="row">
          <button className="btn ghost" disabled={busy} onClick={() => void run(app.importBackup)}>
            Choose a file…
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-name">Keep history for</div>
          <div className="setting-desc">
            Older days are deleted from disk, not hidden. Off by default: OpenTime never throws
            away your history unless you ask it to.
          </div>
        </div>
        <select
          aria-label="Keep history for"
          value={draft.retentionDays}
          onChange={(e) => {
            // Settings save the moment they change, so this is the last
            // chance to say what a shorter history actually deletes.
            const days = Number(e.target.value)
            if (days > 0) {
              const oldestKept = lastNDayKeys(days, dayKey(Date.now(), draft.dayStartHour))[0]
              const lost = app.historyKeys.filter((k) => k < oldestKept).length
              if (
                lost > 0 &&
                !window.confirm(
                  `This deletes ${lost} older day${lost === 1 ? '' : 's'} of history from this computer, and they cannot be brought back. Continue?`
                )
              ) {
                return
              }
            }
            patch({ retentionDays: days })
          }}
        >
          {RETENTION_CHOICES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <div>
          <div className="setting-name">Data folder</div>
          <div className="setting-desc">
            Open it in your file manager. Copying the folder is a complete backup.
          </div>
        </div>
        <button className="btn ghost" onClick={() => void app.revealDataFolder()}>
          Open folder
        </button>
      </div>

      {app.demoDays.length ? (
        <div className="setting-row wide">
          <div>
            <div className="setting-name">Demo history</div>
            <div className="setting-desc">
              {app.demoDays.length} generated day{app.demoDays.length === 1 ? '' : 's'} were seeded
              because OS capture is unavailable here. Removing them deletes exactly those days and
              nothing you actually recorded.
            </div>
          </div>
          <button className="btn ghost danger" disabled={busy} onClick={() => void run(app.clearDemoData)}>
            Remove demo data
          </button>
        </div>
      ) : null}

      <div className="setting-row">
        <div>
          <div className="setting-name">Seed example history</div>
          <div className="setting-desc">
            When capture cannot run, show generated activity so the dashboard is not blank. Turn it
            off to see an honest empty state instead.
          </div>
        </div>
        <button
          className={`switch${draft.seedDemoWhenUnavailable ? ' on' : ''}`}
          role="switch"
          aria-checked={draft.seedDemoWhenUnavailable}
          aria-label="Seed example history"
          onClick={() => patch({ seedDemoWhenUnavailable: !draft.seedDemoWhenUnavailable })}
        >
          <i />
        </button>
      </div>

      {message ? (
        <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
          <IconInfo />
          <div>{message}</div>
        </div>
      ) : null}
    </div>
  )
}
