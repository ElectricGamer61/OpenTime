/**
 * The music player on the rail.
 *
 * Its own thing, apart from Focus: one short list of music and ambient
 * sounds. Click one to play it, click it again to pause, and set the volume.
 * It never touches tracked time. `useMusicPlayer` owns the audio; this is
 * only the trigger and the popover.
 *
 * Portalled to `document.body` for the same reason every rail-anchored
 * overlay is: the rail is `overflow: hidden` for its collapse animation, so
 * anything wider than the rail rendered in place would be sliced off at its
 * edge.
 */

import type { ComponentType } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { AMBIENT_SOUNDS, MUSIC_TRACKS, soundLabel, type PlayerSound } from '../../core/music'
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

const ICONS: Record<PlayerSound, ComponentType<{ size?: number }>> = {
  lofi: IconMusic,
  whale: IconWave,
  alpha: IconPulse,
  classical: IconPiano,
  rain: IconSound,
  ocean: IconWave,
  cafe: IconSound,
  deep: IconSound,
}

const GROUPS: Array<{ title: string; items: Array<{ id: PlayerSound; label: string; detail: string }> }> = [
  { title: 'Music', items: MUSIC_TRACKS },
  { title: 'Sounds', items: AMBIENT_SOUNDS },
]

const MENU_WIDTH = 260
const MENU_MARGIN = 8

export function MusicPlayerControl({ player }: { player: MusicPlayerState }) {
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
      const height = menu.current?.offsetHeight ?? 360
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

  const choose = (id: PlayerSound) => {
    if (player.track === id) player.toggle()
    else player.setTrack(id)
  }

  return (
    <div className="music-player-wrap" ref={wrap}>
      <button
        className={`music-player-trigger${player.playing ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={player.playing ? `Playing ${soundLabel(player.track)}` : 'Music'}
      >
        <IconMusic size={16} />
        <span className="nav-label">{player.playing ? soundLabel(player.track) : 'Music'}</span>
        {player.playing ? <i className="music-player-dot" aria-hidden="true" /> : null}
      </button>

      {open
        ? createPortal(
            <div
              className="music-menu"
              ref={menu}
              role="dialog"
              aria-label="Music"
              style={{ width: MENU_WIDTH, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            >
              {GROUPS.map((group) => (
                <div className="music-group" key={group.title}>
                  <div className="music-group-title">{group.title}</div>
                  {group.items.map((item) => {
                    const Icon = ICONS[item.id]
                    const current = player.track === item.id
                    const live = current && player.playing
                    return (
                      <button
                        key={item.id}
                        className={`music-row${live ? ' on' : ''}`}
                        onClick={() => choose(item.id)}
                        title={item.detail}
                        aria-pressed={live}
                      >
                        <Icon size={16} />
                        <span>{item.label}</span>
                        <span className="music-row-action" aria-hidden="true">
                          {live ? <IconPause size={14} /> : <IconPlay size={14} />}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}

              <label className="music-volume">
                <IconSound size={15} />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={player.volume}
                  style={{ '--fill': `${Math.round(player.volume * 100)}%` } as React.CSSProperties}
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
