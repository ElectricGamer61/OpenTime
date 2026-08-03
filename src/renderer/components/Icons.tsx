/**
 * OpenTime's icon set — original, drawn inline as SVG so there is no binary
 * asset, no icon-font dependency, and every glyph inherits `currentColor` and
 * the surrounding font size.
 *
 * House style: 24×24 box, 1.7px round-capped strokes, no fills. Keeping every
 * glyph on the same grid and weight is what makes the navigation read as one
 * set rather than a pile of clip art.
 */

type IconProps = { size?: number; className?: string }

function Svg({ size = 17, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Today — a day column with the current moment marked. */
export function IconToday(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4.5" width="16" height="15" rx="3" />
      <path d="M8 2.75v3.5M16 2.75v3.5M4 9.5h16" />
      <path d="M8.5 13.5h7" />
    </Svg>
  )
}

/** Week — a small bar series. */
export function IconWeek(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 16.5v-4M12 16.5v-8M16.5 16.5v-6" />
    </Svg>
  )
}

/** Projects & rules — stacked layers. */
export function IconProjects(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 20 8l-8 4.5L4 8l8-4.5Z" />
      <path d="m4 12.5 8 4.5 8-4.5" />
      <path d="m4 16.75 8 4.5 8-4.5" />
    </Svg>
  )
}

/** Settings — sliders rather than a gear, to stay off the well-worn path. */
export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 7.5h14M5 16.5h14" />
      <circle cx="9.5" cy="7.5" r="2.25" />
      <circle cx="15" cy="16.5" r="2.25" />
    </Svg>
  )
}

/** Refresh. */
export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5" />
      <path d="M19.75 4.5v4.25H15.5" />
    </Svg>
  )
}

/** Info — used by the demo notice. */
export function IconInfo({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11v5.25M12 7.9v.1" />
    </Svg>
  )
}

/** Play / pause glyph for the live card. */
export function IconClock({ size = 22, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.25V12l3 1.75" />
    </Svg>
  )
}

export function IconPause({ size = 22, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M9.5 6.5v11M14.5 6.5v11" strokeWidth="2" />
    </Svg>
  )
}

/** Empty-state glyphs. */
export function IconEmptyTimeline({ size = 30, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M8 8.5h8M8 12.5h5" />
    </Svg>
  )
}

export function IconEmptyPointer({ size = 30, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M6 4.5 18.5 11 13 12.75 10.75 18 6 4.5Z" />
    </Svg>
  )
}

export function IconEmptyRule({ size = 30, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M4.5 6.5h15M4.5 12h9M4.5 17.5h12" />
      <circle cx="17.5" cy="12" r="2" />
    </Svg>
  )
}
