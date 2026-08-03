/**
 * OpenTime's mark: an open ring — a clock face deliberately left unclosed —
 * with a single hand. Drawn inline as SVG so there is no binary asset and it
 * inherits the accent token.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M16 3.5a12.5 12.5 0 1 1-8.84 21.34"
        stroke="var(--accent)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M16 9v7.4l5 3"
        stroke="var(--text)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Wordmark() {
  return (
    <div className="brand">
      <BrandMark />
      <div className="brand-name">
        Open<span>Time</span>
      </div>
    </div>
  )
}
