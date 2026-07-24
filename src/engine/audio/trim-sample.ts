/**
 * Decode and trim helpers for the voice-clone sample workflow.
 *
 * The user picks an audio sample, listens, and drags a selection (≤10s — the
 * backend's clone-prompt VRAM cap) before saving. We decode once in the browser
 * so the waveform, the in-browser preview, and the final cut all share the same
 * AudioBuffer — no re-upload of the whole file just to trim it.
 */
import { assertDecodable } from '@engine/audio/decode-guard'
import { encodeWav } from '@engine/export/audio-file'

/** Target number of waveform buckets across the whole sample. */
const PEAK_BUCKETS = 600

let _ac: AudioContext | null = null
function audioContext(): AudioContext {
  if (!_ac) _ac = new AudioContext()
  return _ac
}

export interface DecodedSample {
  buffer: AudioBuffer
  /** Normalised 0..1 peak per bucket (channel 0), length ~PEAK_BUCKETS. */
  peaks: number[]
  durationSec: number
}

/** Decode an uploaded audio file into an AudioBuffer + downsampled peaks. */
export async function decodeForTrim(file: Blob): Promise<DecodedSample> {
  // The user only needs to cut ≤10s, but this decodes the WHOLE picked file.
  // A multi-hour source would OOM the renderer before the trim UI even shows,
  // so refuse oversized/over-long files up front (size + probed duration).
  await assertDecodable(file, 'This audio sample', {
    maxInputBytes: 128 * 1024 * 1024,
    maxPcmBytes: 128 * 1024 * 1024,
  })
  const arrayBuffer = await file.arrayBuffer()
  // decodeAudioData detaches the buffer; it's fine, we don't reuse it.
  const buffer = await audioContext().decodeAudioData(arrayBuffer)
  const channel = buffer.getChannelData(0)
  const buckets = Math.min(PEAK_BUCKETS, channel.length)
  const blockSize = Math.max(1, Math.floor(channel.length / buckets))
  const peaks: number[] = new Array(buckets)

  let globalMax = 0
  for (let i = 0; i < buckets; i++) {
    let max = 0
    const start = i * blockSize
    const end = Math.min(start + blockSize, channel.length)
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channel[j] ?? 0)
      if (abs > max) max = abs
    }
    peaks[i] = max
    if (max > globalMax) globalMax = max
  }
  // Normalise so quiet samples still draw a readable waveform.
  if (globalMax > 0) {
    for (let i = 0; i < peaks.length; i++) peaks[i] = peaks[i]! / globalMax
  }
  return { buffer, peaks, durationSec: buffer.duration }
}

/**
 * Pick a sensible default selection: the `windowSec`-long window (capped to the
 * clip) with the most energy — i.e. the loudest stretch of speech. Returns
 * `[startSec, endSec]`.
 */
export function suggestSelection(peaks: number[], durationSec: number, windowSec: number): [number, number] {
  const win = Math.min(windowSec, durationSec)
  if (peaks.length === 0 || win >= durationSec) return [0, durationSec]
  const secPerBucket = durationSec / peaks.length
  const winBuckets = Math.max(1, Math.round(win / secPerBucket))
  // Sliding-window sum of energy (peak²) to find the loudest stretch.
  let bestStart = 0
  let bestSum = -1
  let sum = 0
  for (let i = 0; i < peaks.length; i++) {
    const e = peaks[i]! * peaks[i]!
    sum += e
    if (i >= winBuckets) sum -= peaks[i - winBuckets]! * peaks[i - winBuckets]!
    if (i >= winBuckets - 1 && sum > bestSum) {
      bestSum = sum
      bestStart = i - winBuckets + 1
    }
  }
  const startSec = bestStart * secPerBucket
  return [startSec, Math.min(durationSec, startSec + win)]
}

/**
 * Cut [startSec, endSec) out of `buffer` into a new mono/stereo AudioBuffer and
 * encode it as a 16-bit PCM WAV via the shared {@link encodeWav}. Used to upload
 * exactly the segment the user chose instead of the whole file.
 */
export function sliceToWav(buffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const sr = buffer.sampleRate
  const start = Math.max(0, Math.floor(startSec * sr))
  const end = Math.min(buffer.length, Math.ceil(endSec * sr))
  const len = Math.max(1, end - start)
  const numCh = buffer.numberOfChannels
  const out = audioContext().createBuffer(numCh, len, sr)
  for (let c = 0; c < numCh; c++) {
    out.getChannelData(c).set(buffer.getChannelData(c).subarray(start, end))
  }
  return encodeWav(out)
}

/** Format seconds as m:ss for axis/labels. */
export function fmtTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${r.toString().padStart(2, '0')}`
}
