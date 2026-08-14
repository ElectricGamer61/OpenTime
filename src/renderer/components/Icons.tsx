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

// ── Navigation ───────────────────────────────────────────────────────────────

/** Dashboard — four panes. */
export function IconDashboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.75" y="3.75" width="7" height="7" rx="2" />
      <rect x="13.25" y="3.75" width="7" height="7" rx="2" />
      <rect x="3.75" y="13.25" width="7" height="7" rx="2" />
      <rect x="13.25" y="13.25" width="7" height="7" rx="2" />
    </Svg>
  )
}

/** Calendar — a day grid with the header rail. */
export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.75" y="5" width="16.5" height="15.25" rx="3" />
      <path d="M8 3v3.5M16 3v3.5M3.75 9.75h16.5" />
    </Svg>
  )
}

/** Today — kept for the week view's "jump to day" affordance. */
export function IconToday(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4.5" width="16" height="15" rx="3" />
      <path d="M8 2.75v3.5M16 2.75v3.5M4 9.5h16" />
      <path d="M8.5 13.5h7" />
    </Svg>
  )
}

/** Activity — the trace of a day's switching. */
export function IconActivity(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12.5h3.5L9 6.5l3.5 11 2.5-5h6" />
    </Svg>
  )
}

/** Projects — a folder. */
export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.75 6.75A2 2 0 0 1 5.75 4.75h3l2 2.5h6.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z" />
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

/** Goals — a floor to reach, drawn as a target. */
export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </Svg>
  )
}

/** Reports — a bar series. */
export function IconWeek(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 16.5v-4M12 16.5v-8M16.5 16.5v-6" />
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

// ── Chrome ───────────────────────────────────────────────────────────────────

/** Collapse the sidebar — a double chevron. */
export function IconCollapse(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m11 7-5 5 5 5M18 7l-5 5 5 5" />
    </Svg>
  )
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m14.5 6-6 6 6 6" />
    </Svg>
  )
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 6 6-6" />
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

export function IconPlay({ size = 22, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M8.5 6.2 18 12l-9.5 5.8Z" />
    </Svg>
  )
}

// ── Grid header and entry actions ────────────────────────────────────────────

/** Entries — a list. */
export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15M4.5 12h15M4.5 17h9" />
    </Svg>
  )
}

/** Apps — a small grid, for the popover's breakdown heading. */
export function IconApps(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="2.1" />
      <circle cx="17" cy="7" r="2.1" />
      <circle cx="7" cy="17" r="2.1" />
      <circle cx="17" cy="17" r="2.1" />
    </Svg>
  )
}

export function IconPencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.6 4.9a2 2 0 0 1 2.83 2.83L8.9 17.25l-3.65.9.9-3.65Z" />
    </Svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.75 7h14.5M9.5 7V5.25a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.75 7.5 7.6 19a1.5 1.5 0 0 0 1.5 1.4h5.8a1.5 1.5 0 0 0 1.5-1.4L17.25 7.5" />
    </Svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Svg>
  )
}

/** Split — where one block was really two. */
export function IconSplit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v17" strokeDasharray="2.4 2.6" />
      <path d="M4.5 8.5h4M15.5 15.5h4" />
    </Svg>
  )
}

/** Data folder. */
export function IconFolderOpen(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.75 18.5V6.75a2 2 0 0 1 2-2h3l2 2.5h5.5a2 2 0 0 1 2 2v1.5" />
      <path d="M3.75 18.5 6.4 11.6a1.5 1.5 0 0 1 1.4-.95h12.1a1 1 0 0 1 .94 1.35l-2.24 5.85a2 2 0 0 1-1.87 1.29H5.75a2 2 0 0 1-2-2Z" />
    </Svg>
  )
}

// ── Empty-state glyphs ───────────────────────────────────────────────────────

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

// ── Focus sessions ───────────────────────────────────────────────────────────

/** Focus — a target ring drawn open, so it reads as attention rather than aim. */
export function IconFocus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.25a8.75 8.75 0 1 1-8.6 10.4" />
      <circle cx="12" cy="12" r="4.25" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Sound on — a speaker with two arcs. */
export function IconSound(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 9.25h3l4-3.25v12l-4-3.25h-3z" />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.6 7a7 7 0 0 1 0 10" />
    </Svg>
  )
}

/** Sound off — the same speaker, struck through. */
export function IconSoundOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 9.25h3l4-3.25v12l-4-3.25h-3z" />
      <path d="M15.5 10l4 4M19.5 10l-4 4" />
    </Svg>
  )
}

/** Stop — a filled square, for ending a running session. */
export function IconStop(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Plus — extending a session, adding a row. */
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Svg>
  )
}

/**
 * Range — a measured span between two end caps, for the month and custom
 * report ranges.
 *
 * The caps have to stay short against a long bar. Drawn full height with a
 * shorter bar between them, this is the letter H, and beside two date inputs
 * that is exactly how it read.
 */
export function IconRange(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 8.5v7M19.5 8.5v7M4.5 12h15" />
    </Svg>
  )
}

/** Check — confirmation in the focus completion card. */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  )
}
