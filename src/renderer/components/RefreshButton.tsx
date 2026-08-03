import { useState } from 'react'

import { IconRefresh } from './Icons'

/**
 * Refresh with a spin.
 *
 * A local refetch usually resolves faster than a person can perceive, so a
 * plain button gives no evidence it did anything. Rather than fake a spinner
 * for a fixed delay, this spins the icon exactly once on click: honest about
 * being a gesture acknowledgement rather than a progress indicator.
 */
export function RefreshButton({ onRefresh }: { onRefresh(): void }) {
  const [spinKey, setSpinKey] = useState(0)

  return (
    // `spin` is withheld until the first click so the icon does not spin
    // unprompted when the view mounts.
    <button
      className={`btn ghost${spinKey ? ' spin' : ''}`}
      onClick={() => {
        setSpinKey((n) => n + 1)
        onRefresh()
      }}
    >
      {/* Remounting restarts the CSS animation; without the key a second
          click within the animation window would do nothing visible. */}
      <IconRefresh key={spinKey} className="btn-icon" />
      Refresh
    </button>
  )
}
