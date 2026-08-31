/**
 * Shared filtered-noise generation for the ambient and music engines.
 *
 * Split out of `ambient.ts` once `music.ts` needed the same textures (the
 * lo-fi bed's tape hiss, the alpha bed's soft floor) — kept in one place so
 * the two engines cannot drift on what "brown noise" means.
 */

/** Seconds of noise generated once and looped. Long enough to hide the seam. */
const BUFFER_SECONDS = 5

function fillWhite(data: Float32Array): void {
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
}

/**
 * Brown noise — a running sum of white, which rolls off at 6dB/octave.
 *
 * Kept rather than plain white for the low beds because white noise at low
 * volume still reads as hiss, and hiss is the thing people reach to turn off.
 */
function fillBrown(data: Float32Array): void {
  let last = 0
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    data[i] = last * 3.5
  }
}

/**
 * A looping buffer source filled with synthesised noise. Not yet started or
 * connected. Takes `BaseAudioContext` rather than `AudioContext` because the
 * music engine's pre-rendered beds build this against an `OfflineAudioContext`.
 */
export function noiseSource(audio: BaseAudioContext, kind: 'white' | 'brown'): AudioBufferSourceNode {
  const buffer = audio.createBuffer(1, audio.sampleRate * BUFFER_SECONDS, audio.sampleRate)
  const data = buffer.getChannelData(0)
  if (kind === 'white') fillWhite(data)
  else fillBrown(data)
  const source = audio.createBufferSource()
  source.buffer = buffer
  source.loop = true
  return source
}

/**
 * Sparse random impulses — the pop/crackle texture of old vinyl, not a
 * texture "noise" already covers. Amplitude decays per-click so it reads as
 * dust rather than static.
 */
export function crackleSource(audio: BaseAudioContext, seconds = 8): AudioBufferSourceNode {
  const buffer = audio.createBuffer(1, audio.sampleRate * seconds, audio.sampleRate)
  const data = buffer.getChannelData(0)
  const clicksPerSecond = 6
  const total = Math.floor(seconds * clicksPerSecond)
  for (let i = 0; i < total; i += 1) {
    const at = Math.floor(Math.random() * data.length)
    const amp = 0.15 + Math.random() * 0.5
    const len = 8 + Math.floor(Math.random() * 24)
    for (let j = 0; j < len && at + j < data.length; j += 1) {
      data[at + j] += (Math.random() * 2 - 1) * amp * (1 - j / len)
    }
  }
  const source = audio.createBufferSource()
  source.buffer = buffer
  source.loop = true
  return source
}
