import { useId } from 'react'

/**
 * OpenTime's mark, the same drawing as the app icon (build/icon.svg) without
 * its tile: an open ring - a clock face deliberately left unclosed - swept in
 * the brand gradient, ending in a dot that marks "now". Inline SVG, so there
 * is no binary asset.
 */
export function BrandMark({ size = 22, tile = false }: { size?: number; tile?: boolean }) {
  // Several marks can be on screen at once; each needs its own gradient id.
  const id = useId().replace(/:/g, '')
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-ring`} x1="0.15" y1="0.9" x2="0.85" y2="0.1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.5" stopColor="#7c5cff" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#211a3a" />
          <stop offset="1" stopColor="#0b0a12" />
        </linearGradient>
      </defs>
      {tile ? <rect x="0" y="0" width="32" height="32" rx="7.5" fill={`url(#${id}-tile)`} /> : null}
      <path
        d={tile ? 'M16 6.6a9.4 9.4 0 1 0 8.14 4.7' : 'M16 3.6a12.4 12.4 0 1 0 10.74 6.2'}
        stroke={`url(#${id}-ring)`}
        strokeWidth={tile ? 3.3 : 4}
        strokeLinecap="round"
      />
      <circle
        cx={tile ? 24.14 : 26.74}
        cy={tile ? 11.3 : 9.8}
        r={tile ? 1.7 : 2.3}
        fill="#fff"
        stroke={tile ? 'none' : '#7c5cff'}
        strokeWidth="0.9"
      />
    </svg>
  )
}
