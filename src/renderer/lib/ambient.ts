/**
 * Ambient sound for focus sessions.
 *
 * Every bed here is **synthesised** from filtered noise at runtime. There are
 * no audio files in the bundle and none are fetched: the renderer's CSP allows
 * no external sources, an offline-first desktop app should not need the network
 * to make a sound, and shipping somebody else's recordings is a licensing
 * problem rather than a feature. Filtered noise is also the honest version of
 * what these beds are for — something with no detail to follow, so attention
 * has nothing to land on.
 *
 * The whole engine is lazy: no `AudioContext` is constructed until a session
 * actually asks for sound, because creating one on load is what makes browsers
 * mark a page as playing audio forever.
 */

import type { AmbientBedId } from '../../core/types'
import { noiseSource } from './noise'

/** Fades, in seconds. Anything shorter than this clicks. */
const FADE = 0.6

export interface AmbientEngine {
  /** Switch to a bed, or to `'silence'` to stop. Safe to call repeatedly. */
  play(bed: AmbientBedId): void
  /** 0–1. Applied immediately and remembered for the next bed. */
  setVolume(volume: number): void
  stop(): void
  dispose(): void
}

/**
 * A no-op engine, returned when the browser has no Web Audio at all.
 *
 * Silently doing nothing is right here: a focus session whose sound fails is
 * still a focus session, and an error dialog about an ambient bed would be a
 * worse interruption than the missing sound.
 */
const SILENT_ENGINE: AmbientEngine = {
  play() {},
  setVolume() {},
  stop() {},
  dispose() {},
}

export function createAmbientEngine(): AmbientEngine {
  const Ctor: typeof AudioContext | undefined =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return SILENT_ENGINE

  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let voice: { stop(): void } | null = null
  let current: AmbientBedId = 'silence'
  let volume = 0.4

  const ensure = (): { ctx: AudioContext; master: GainNode } => {
    if (!ctx || !master) {
      ctx = new Ctor()
      master = ctx.createGain()
      master.gain.value = volume
      master.connect(ctx.destination)
    }
    // Autoplay policy suspends a context created before a gesture; every call
    // into here is behind a click, so this is the moment it can be resumed.
    if (ctx.state === 'suspended') void ctx.resume()
    return { ctx, master }
  }

  /** Build one bed and return a handle that fades it out and tears it down. */
  const build = (bed: AmbientBedId): { stop(): void } | null => {
    const { ctx: audio, master: out } = ensure()
    const gain = audio.createGain()
    gain.gain.setValueAtTime(0.0001, audio.currentTime)
    gain.connect(out)

    const nodes: AudioScheduledSourceNode[] = []
    let peak = 1

    if (bed === 'rain') {
      const source = noiseSource(audio, 'white')
      const high = audio.createBiquadFilter()
      high.type = 'highpass'
      high.frequency.value = 900
      const low = audio.createBiquadFilter()
      low.type = 'lowpass'
      low.frequency.value = 7200
      source.connect(high).connect(low).connect(gain)
      source.start()
      nodes.push(source)
      peak = 0.55
    } else if (bed === 'ocean') {
      const source = noiseSource(audio, 'brown')
      const low = audio.createBiquadFilter()
      low.type = 'lowpass'
      low.frequency.value = 700
      const swell = audio.createGain()
      swell.gain.value = 0.55
      // A ~11-second swell: slow enough that it is never a rhythm to follow.
      const lfo = audio.createOscillator()
      lfo.frequency.value = 1 / 11
      const lfoDepth = audio.createGain()
      lfoDepth.gain.value = 0.4
      lfo.connect(lfoDepth).connect(swell.gain)
      lfo.start()
      source.connect(low).connect(swell).connect(gain)
      source.start()
      nodes.push(source, lfo)
      peak = 1
    } else if (bed === 'cafe') {
      const source = noiseSource(audio, 'brown')
      const low = audio.createBiquadFilter()
      low.type = 'lowpass'
      low.frequency.value = 520
      const body = audio.createBiquadFilter()
      body.type = 'peaking'
      body.frequency.value = 260
      body.gain.value = 5
      body.Q.value = 0.7
      source.connect(low).connect(body).connect(gain)
      source.start()
      nodes.push(source)
      peak = 0.9
    } else if (bed === 'deep') {
      const source = noiseSource(audio, 'brown')
      const low = audio.createBiquadFilter()
      low.type = 'lowpass'
      low.frequency.value = 170
      source.connect(low).connect(gain)
      source.start()
      const drone = audio.createOscillator()
      drone.type = 'sine'
      drone.frequency.value = 55
      const droneGain = audio.createGain()
      droneGain.gain.value = 0.05
      drone.connect(droneGain).connect(gain)
      drone.start()
      nodes.push(source, drone)
      peak = 1
    } else {
      gain.disconnect()
      return null
    }

    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), audio.currentTime + FADE)

    return {
      stop() {
        const now = audio.currentTime
        gain.gain.cancelScheduledValues(now)
        gain.gain.setValueAtTime(Math.max(0.0002, gain.gain.value), now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + FADE)
        for (const node of nodes) {
          try {
            node.stop(now + FADE + 0.05)
          } catch {
            // Already stopped — nothing to unwind.
          }
        }
        setTimeout(() => gain.disconnect(), (FADE + 0.2) * 1000)
      },
    }
  }

  return {
    play(bed) {
      if (bed === current && voice) return
      voice?.stop()
      voice = null
      current = bed
      if (bed === 'silence') return
      voice = build(bed)
    },
    setVolume(next) {
      volume = Math.min(1, Math.max(0, next))
      if (master && ctx) {
        master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05)
      }
    },
    stop() {
      voice?.stop()
      voice = null
      current = 'silence'
    },
    dispose() {
      voice?.stop()
      voice = null
      current = 'silence'
      const closing = ctx
      ctx = null
      master = null
      // Give the fade time to finish before the context goes away, or the last
      // thing the user hears is a click.
      setTimeout(() => void closing?.close().catch(() => {}), (FADE + 0.3) * 1000)
    },
  }
}
