/**
 * Audio engine for the Music timer.
 *
 * Three of the four tracks are **synthesised**, exactly like the Focus
 * ambient beds in `ambient.ts` and for the same reasons: no file to fetch, no
 * license to track, nothing that grows the installer. `lofi` and `classical`
 * are original short loops rendered once through an `OfflineAudioContext` —
 * that renders faster than real time and gives back a plain `AudioBuffer`
 * that loops exactly like the noise beds, rather than requiring a live
 * scheduler to keep re-triggering notes (which would have to survive the
 * window being backgrounded). `alpha` is two detuned oscillators, built live
 * like the ambient beds, because a beat frequency has to be live oscillators
 * by construction.
 *
 * `whale` is the one real recording OpenTime ships: a public-domain NOAA
 * humpback whale field recording, bundled as a local asset and decoded once.
 * See `docs/audio-licenses.md` for the source, license basis, and exactly
 * what was changed from the original file. It is loaded with `fetch()`
 * against the app's own bundled asset — same-origin, nothing external, the
 * CSP is unchanged.
 *
 * Like `ambient.ts`, the whole engine is lazy: nothing is built, fetched or
 * rendered until a track is actually requested.
 */

import type { MusicTrackId } from '../../core/music'
import whaleUrl from '../assets/audio/whale.wav'
import { crackleSource, noiseSource } from './noise'

/** Fades, in seconds. Anything shorter than this clicks. */
const FADE = 0.6

export interface MusicEngine {
  /** Switch to a track, or to `null` to stop. Safe to call repeatedly. */
  play(track: MusicTrackId | null): void
  /** 0–1. Applied immediately and remembered for the next track. */
  setVolume(volume: number): void
  stop(): void
  dispose(): void
}

/** Returned when the browser has no Web Audio at all — see `ambient.ts`'s `SILENT_ENGINE` for why silence is right here. */
const SILENT_ENGINE: MusicEngine = {
  play() {},
  setVolume() {},
  stop() {},
  dispose() {},
}

type BufferTrack = 'lofi' | 'whale' | 'classical'

/** A short original chord loop — not a transcription of anything, just four soft triads. */
async function renderLofiLoop(sampleRate: number): Promise<AudioBuffer> {
  const seconds = 8
  const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate)
  const master = offline.createGain()
  master.gain.value = 1
  master.connect(offline.destination)

  const chords: number[][] = [
    [220.0, 261.63, 329.63], // Am
    [174.61, 220.0, 261.63], // F
    [130.81, 164.81, 196.0], // C
    [196.0, 246.94, 293.66], // G
  ]
  const chordSeconds = seconds / chords.length
  for (const [i, freqs] of chords.entries()) {
    const start = i * chordSeconds
    for (const freq of freqs) {
      const osc = offline.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = freq
      const env = offline.createGain()
      env.gain.setValueAtTime(0, start)
      env.gain.linearRampToValueAtTime(0.08, start + 0.6)
      env.gain.linearRampToValueAtTime(0.05, start + chordSeconds - 0.4)
      env.gain.linearRampToValueAtTime(0, start + chordSeconds)
      osc.connect(env).connect(master)
      osc.start(start)
      osc.stop(start + chordSeconds)
    }
  }

  // Tape hiss under the chords, quiet enough to read as texture, not noise.
  const crackle = crackleSource(offline, seconds)
  const crackleGain = offline.createGain()
  crackleGain.gain.value = 0.12
  crackle.connect(crackleGain).connect(master)
  crackle.start()

  const hiss = noiseSource(offline, 'white')
  const hissLow = offline.createBiquadFilter()
  hissLow.type = 'lowpass'
  hissLow.frequency.value = 4000
  const hissGain = offline.createGain()
  hissGain.gain.value = 0.02
  hiss.connect(hissLow).connect(hissGain).connect(master)
  hiss.start()

  return offline.startRendering()
}

/**
 * A calm original arpeggio — the "clearly licensed equivalent" to a Mozart
 * bed: original notes, not a rendition of any existing composition, so there
 * is nothing to license and nothing to misrepresent as a real recording.
 */
async function renderClassicalLoop(sampleRate: number): Promise<AudioBuffer> {
  const seconds = 6.4
  const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate)
  const master = offline.createGain()
  master.connect(offline.destination)

  const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63, 293.66, 261.63] // C E G C' G E D C
  const noteSeconds = seconds / notes.length
  for (const [i, freq] of notes.entries()) {
    const start = i * noteSeconds
    const osc = offline.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const env = offline.createGain()
    env.gain.setValueAtTime(0, start)
    env.gain.linearRampToValueAtTime(0.16, start + 0.02)
    env.gain.exponentialRampToValueAtTime(0.0006, start + noteSeconds * 1.3)
    osc.connect(env).connect(master)
    osc.start(start)
    osc.stop(start + noteSeconds * 1.4)

    // A soft octave-up partial, so a single sine reads closer to a struck
    // string than to a test tone.
    const partial = offline.createOscillator()
    partial.type = 'sine'
    partial.frequency.value = freq * 2
    const partialEnv = offline.createGain()
    partialEnv.gain.setValueAtTime(0, start)
    partialEnv.gain.linearRampToValueAtTime(0.035, start + 0.02)
    partialEnv.gain.exponentialRampToValueAtTime(0.0003, start + noteSeconds)
    partial.connect(partialEnv).connect(master)
    partial.start(start)
    partial.stop(start + noteSeconds)
  }

  return offline.startRendering()
}

async function loadWhale(audio: AudioContext): Promise<AudioBuffer> {
  const response = await fetch(whaleUrl)
  const bytes = await response.arrayBuffer()
  return audio.decodeAudioData(bytes)
}

export function createMusicEngine(): MusicEngine {
  const Ctor: typeof AudioContext | undefined =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return SILENT_ENGINE

  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let voice: { stop(): void } | null = null
  let current: MusicTrackId | null = null
  let volume = 0.4
  /** One request counter so a track switch mid-decode does not resurrect a stale buffer. */
  let requestId = 0
  const bufferCache = new Map<BufferTrack, Promise<AudioBuffer>>()

  const ensure = (): { ctx: AudioContext; master: GainNode } => {
    if (!ctx || !master) {
      ctx = new Ctor()
      master = ctx.createGain()
      master.gain.value = volume
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return { ctx, master }
  }

  const loadBuffer = (audio: AudioContext, track: BufferTrack): Promise<AudioBuffer> => {
    const cached = bufferCache.get(track)
    if (cached) return cached
    const promise =
      track === 'whale'
        ? loadWhale(audio)
        : track === 'lofi'
          ? renderLofiLoop(audio.sampleRate)
          : renderClassicalLoop(audio.sampleRate)
    bufferCache.set(track, promise)
    return promise
  }

  /** The alpha bed is live oscillators — a beat frequency cannot be pre-rendered into a short loop without an audible seam at the wrap. */
  const buildAlpha = (audio: AudioContext, gain: GainNode): AudioScheduledSourceNode[] => {
    const carrier = 210
    const beatHz = 10 // alpha band, roughly 8–12Hz
    const left = audio.createOscillator()
    left.type = 'sine'
    left.frequency.value = carrier
    const right = audio.createOscillator()
    right.type = 'sine'
    right.frequency.value = carrier + beatHz
    const panL = audio.createStereoPanner()
    panL.pan.value = -1
    const panR = audio.createStereoPanner()
    panR.pan.value = 1
    const toneGain = audio.createGain()
    toneGain.gain.value = 0.1
    left.connect(panL).connect(toneGain)
    right.connect(panR).connect(toneGain)

    // Two bare sine tones read as a hearing test; a soft floor underneath
    // gives the ear something else to rest on.
    const floor = noiseSource(audio, 'brown')
    const floorLow = audio.createBiquadFilter()
    floorLow.type = 'lowpass'
    floorLow.frequency.value = 260
    const floorGain = audio.createGain()
    floorGain.gain.value = 0.3
    floor.connect(floorLow).connect(floorGain)

    toneGain.connect(gain)
    floorGain.connect(gain)
    left.start()
    right.start()
    floor.start()
    return [left, right, floor]
  }

  const stopVoice = (audio: AudioContext, gain: GainNode, nodes: AudioScheduledSourceNode[]): void => {
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
  }

  const play = (track: MusicTrackId | null): void => {
    if (track === current && voice) return
    voice?.stop()
    voice = null
    current = track
    if (!track) return

    const myRequest = (requestId += 1)
    const { ctx: audio, master: out } = ensure()
    const gain = audio.createGain()
    gain.gain.setValueAtTime(0.0001, audio.currentTime)
    gain.connect(out)

    if (track === 'alpha') {
      const nodes = buildAlpha(audio, gain)
      gain.gain.exponentialRampToValueAtTime(1, audio.currentTime + FADE)
      voice = { stop: () => stopVoice(audio, gain, nodes) }
      return
    }

    // Everything else loads or renders asynchronously. `stop()` before it
    // resolves just disconnects the (still silent) gain node; the request
    // counter stops a superseded load from starting playback after the fact.
    voice = { stop: () => gain.disconnect() }
    loadBuffer(audio, track)
      .then((buffer) => {
        if (myRequest !== requestId) return
        const source = audio.createBufferSource()
        source.buffer = buffer
        source.loop = true
        source.connect(gain)
        source.start()
        gain.gain.exponentialRampToValueAtTime(1, audio.currentTime + FADE)
        voice = { stop: () => stopVoice(audio, gain, [source]) }
      })
      .catch(() => {
        // A bed that fails to load is a bed that stays silent, same as
        // `SILENT_ENGINE` — an error dialog over a missing background sound
        // would be a worse interruption than the missing sound.
        gain.disconnect()
      })
  }

  return {
    play,
    setVolume(next) {
      volume = Math.min(1, Math.max(0, next))
      if (master && ctx) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05)
    },
    stop() {
      play(null)
    },
    dispose() {
      voice?.stop()
      voice = null
      current = null
      const closing = ctx
      ctx = null
      master = null
      setTimeout(() => void closing?.close().catch(() => {}), (FADE + 0.3) * 1000)
    },
  }
}
