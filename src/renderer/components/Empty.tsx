import type { ReactNode } from 'react'

/**
 * The one empty state in the app.
 *
 * Every "there is nothing here" surface goes through this so they all say the
 * same thing the same way: a muted glyph, a short statement of fact, and a
 * hint that tells the reader what would put something here. Bare sentences
 * floating in a card read as a bug; this reads as a state.
 */
export function Empty({
  glyph,
  title,
  hint,
}: {
  glyph?: ReactNode
  title: string
  hint?: ReactNode
}) {
  return (
    <div className="empty">
      {glyph ? <span className="empty-glyph">{glyph}</span> : null}
      <span className="empty-title">{title}</span>
      {hint ? <span className="empty-hint">{hint}</span> : null}
    </div>
  )
}
