/** An on/off switch. The one used everywhere a setting is a yes or a no. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange(v: boolean): void
  label: string
}) {
  return (
    <button
      className={`switch${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  )
}
