import { useState } from 'react'

import type { Settings } from '../../core/types'
import type { ExportFormat } from '../../shared/ipc'
import type { OpenTimeState } from '../state/useOpenTime'

const RETENTION_CHOICES = [
  { value: 0, label: 'Keep everything' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
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

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true)
    setMessage('')
    const result = await fn()
    setBusy(false)
    setMessage(result.message)
  }

  const exportAs = (format: ExportFormat) => run(() => app.exportData({ format }))
  const days = app.historyKeys.length

  return (
    <div className="card">
      <h2 className="card-title">Your data</h2>
      <p className="card-note">
        {days
          ? `${days} tracked day${days === 1 ? '' : 's'} stored in `
          : 'Nothing recorded yet. Your history will be stored in '}
        <code className="mono">{app.dataDirectory}</code>. One file per day, plain JSON — readable
        without OpenTime, and yours to copy, sync or delete.
      </p>

      <div className="setting-row wide">
        <div>
          <div className="setting-name">Export</div>
          <div className="setting-desc">
            Sessions as CSV for a spreadsheet or an invoice, a day-by-day summary for a chart, or a
            full backup that restores everything including settings and rules.
          </div>
        </div>
        <div className="row wrap">
          <button className="btn" disabled={busy || !days} onClick={() => void exportAs('sessions-csv')}>
            Sessions CSV
          </button>
          <button className="btn" disabled={busy || !days} onClick={() => void exportAs('daily-csv')}>
            Daily CSV
          </button>
          <button className="btn" disabled={busy || !days} onClick={() => void exportAs('backup-json')}>
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
            Older days are deleted from disk, not hidden. Off by default — OpenTime does not throw
            away your history unless you ask it to.
          </div>
        </div>
        <select
          aria-label="Keep history for"
          value={draft.retentionDays}
          onChange={(e) => patch({ retentionDays: Number(e.target.value) })}
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
          <span>ⓘ</span>
          <div>{message}</div>
        </div>
      ) : null}
    </div>
  )
}
