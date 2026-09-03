/**
 * The ambient music player.
 *
 * Not a timer, not a second competing "start something" button next to
 * Focus — a small, always-available background player: pick a track, play or
 * pause it, set a volume. `useMusicPlayer` owns the one shared engine and
 * state; this is purely the trigger-and-popover UI, and it is mounted twice
 * on purpose — once as the rail's small unobtrusive control, once inside the
 * Focus setup sheet and dock — both reading and driving the same instance, so
 * starting a track from inside Focus and later adjusting it from the rail is
 * the same player, not two.
 *
 * Portalled to `document.body` for the same reason every rail-anchored
 * overlay is: the rail is `overflow: hidden` for its collapse animation, so
 * anything wider than the rail rendered in place would be sliced off at its
 * edge. See the note in `App.tsx`'s `Workspace`.
 */

import type { ComponentType } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { MUSIC_TRACKS, type MusicTrackId } from '../../core/music'
import type { MusicPlayerState } from '../lib/useMusicPlayer'
import {
  IconMusic,
  IconPause,
  IconPiano,
  IconPlay,
  IconPulse,
  IconSound,
  IconWave,
} from './Icons'

const TRACK_ICONS: Record<MusicTrackId, ComponentType<{ size?: number }>> = {
  lofi: IconMusic,
  whale: IconWave,
  alpha: IconPulse,
  classical: IconPiano,
}

const MENU_WIDTH = 300
const MENU_MARGIN = 8

export function MusicPlayerControl({
  player,
  label,
  compact,
}: {
  player: MusicPlayerState
  /** "Music" on the rail, "Play music" inside Focus — same popover either way. */
  label: string
  /** Rail-collapsed: icon only, no label, no trailing playing dot text. */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const button = wrap.current?.getBoundingClientRect()
      if (!button) return
      const width = menu.current?.offsetWidth ?? MENU_WIDTH
      const height = menu.current?.offsetHeight ?? 220
      const edge = MENU_MARGIN
      setPos({
        top: Math.max(edge, Math.min(button.top, window.innerHeight - height - edge)),
        left: Math.max(edge, Math.min(button.right + 8, window.innerWidth - width - edge)),
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const ActiveIcon = TRACK_ICONS[player.track]

  return (
    <div className="music-player-wrap" ref={wrap}>
      <button
        className={`music-player-trigger${player.playing ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Music"
      >
        <IconMusic size={16} />
        {compact ? null : <span className="nav-label">{label}</span>}
        {player.playing ? <i className="music-player-dot" aria-hidden="true" /> : null}
      </button>

      {open
        ? createPortal(
            <div
              className="music-player-menu"
              ref={menu}
              role="dialog"
              aria-label="Music player"
              style={{ width: MENU_WIDTH, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            >
              <div className="music-player-tracks">
                {MUSIC_TRACKS.map((t) => {
                  const Icon = TRACK_ICONS[t.id]
                  return (
                    <button
                      key={t.id}
                      className={`music-player-track${player.track === t.id ? ' on' : ''}`}
                      onClick={() => player.setTrack(t.id)}
                      title={t.detail}
                    >
                      <Icon size={18} />
                      <span>{t.label}</span>
                    </button>
                  )
                })}
              </div>

              <div className="music-player-controls">
                <button
                  className={`icon-btn${player.playing ? ' on' : ''}`}
                  onClick={player.toggle}
                  title={player.playing ? 'Pause' : 'Play'}
                >
                  {player.playing ? <IconPause size={17} /> : <IconPlay size={17} />}
                </button>
                <span className="music-player-now" title={MUSIC_TRACKS.find((t) => t.id === player.track)?.label}>
                  <ActiveIcon size={14} />
                  {MUSIC_TRACKS.find((t) => t.id === player.track)?.label}
                </span>
              </div>

              <label className="music-player-volume">
                <IconSound size={15} />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={player.volume}
                  onChange={(e) => player.setVolume(Number(e.target.value))}
                  aria-label="Volume"
                />
              </label>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
