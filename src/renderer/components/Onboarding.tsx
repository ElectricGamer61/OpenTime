import { useState } from 'react'

import type { OpenTimeState } from '../state/useOpenTime'

/**
 * First run.
 *
 * Three things a new user must know before they trust an automatic tracker, and
 * nothing else: what it records, whether recording actually works on this
 * machine, and where the data lives. Deliberately not a tour — there is nothing
 * to tour, which is the point of the product.
 */
export function Onboarding({ app }: { app: OpenTimeState }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const capture = app.capture

  const retry = async () => {
    setBusy(true)
    setMessage('')
    const health = await app.reloadCapture()
    setBusy(false)
    setMessage(
      health.demo
        ? 'Still no OS capture on this machine — OpenTime will show generated activity instead.'
        : `Capture is live: ${health.adapter}.`
    )
  }

  const captureState = !capture
    ? 'unknown'
    : capture.demo
      ? 'blocked'
      : capture.notice
        ? 'degraded'
        : 'ok'

  return (
    <div className="onboard-backdrop" role="dialog" aria-modal="true" aria-label="Welcome to OpenTime">
      <div className="onboard">
        <h1 className="onboard-title">OpenTime tracks your time on its own</h1>
        <p className="onboard-sub">
          There is nothing to start or stop. Three things worth knowing before it does.
        </p>

        <ol className="onboard-steps">
          <li>
            <div className="onboard-step-title">It records what, never who or where</div>
            <div className="onboard-step-body">
              The focused application, its window title, and the <em>host</em> of a web address —
              never the full URL, never a screenshot, never a keystroke. Anything on your private
              list is not recorded at all.
            </div>
          </li>

          <li>
            <div className="onboard-step-title">
              Capture on this machine{' '}
              <span className={`pill ${captureState === 'ok' ? 'info' : 'warn'}`}>
                {captureState === 'ok'
                  ? 'Working'
                  : captureState === 'degraded'
                    ? 'Limited'
                    : 'Unavailable'}
              </span>
            </div>
            <div className="onboard-step-body">
              {capture?.notice ||
                `Reading the focused window through ${capture?.adapter || 'the system'}. Nothing else to do.`}
              {capture?.remedy === 'macos-accessibility' ? (
                <>
                  {' '}
                  Grant access in System Settings, then press <b>Check again</b> — no restart needed.
                </>
              ) : null}
            </div>
            {captureState !== 'ok' ? (
              <button className="btn" disabled={busy} onClick={() => void retry()}>
                {busy ? 'Checking…' : 'Check again'}
              </button>
            ) : null}
            {message ? <div className="onboard-step-body">{message}</div> : null}
          </li>

          <li>
            <div className="onboard-step-title">Your data stays on this machine</div>
            <div className="onboard-step-body">
              Everything lives in <code className="mono">{app.dataDirectory}</code>. No account, no
              server, no telemetry. Settings has one-click export to CSV or a full backup, and you
              can delete the folder at any time.
            </div>
            <button className="btn ghost" onClick={() => void app.revealDataFolder()}>
              Open the data folder
            </button>
          </li>
        </ol>

        {app.demoDays.length ? (
          <div className="notice">
            <span>ⓘ</span>
            <div>
              Because capture is unavailable here, {app.demoDays.length} days of{' '}
              <strong>generated example history</strong> were added so the dashboard is not blank.
              It is tagged as demo data everywhere it appears, and Settings can remove it in one
              click.
            </div>
          </div>
        ) : null}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={() => void app.completeOnboarding()}>
            Start tracking
          </button>
        </div>
      </div>
    </div>
  )
}
