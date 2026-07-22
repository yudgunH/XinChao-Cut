/**
 * Pre-decode memory gate for main-thread `decodeAudioData` paths.
 *
 * Every caller of `decodeAudioData` first does `blob.arrayBuffer()`, which
 * materialises the ENTIRE encoded container in the renderer, and then holds the
 * fully decoded PCM (at the source's native rate/channels) alongside it. A
 * multi-GB video therefore OOMs the renderer *before* any downstream
 * duration/length check can fire — those checks run after the damage is done.
 *
 * This gate refuses the work up front, based on the one number we always have
 * without touching the file: `blob.size`. It is intentionally a hard, cheap
 * bound rather than an exact estimate — the exact fix is chunked demux + decode,
 * which these callers do not do yet.
 */

/**
 * Largest encoded container we will read into RAM for a main-thread decode.
 * `blob.arrayBuffer()` allocates exactly this many bytes, and `decodeAudioData`
 * then holds the decoded PCM on top of it. 1.25 GiB leaves room for both plus
 * the resampled output on a renderer that also holds video frames / GPU buffers.
 */
export const MAX_DECODE_INPUT_BYTES = 1.25 * 1024 * 1024 * 1024

/**
 * Largest decoded-PCM footprint we allow `decodeAudioData` to produce. A small
 * file can still decode huge: a 60-min 128 kbps MP3 is ~55 MB on disk but
 * decodes to 3600 s x 48 kHz x 2 ch x 4 B ≈ 1.38 GB of Float32 PCM. The size
 * gate above cannot see that, so we also gate on probed duration.
 */
export const MAX_DECODED_PCM_BYTES = 1.25 * 1024 * 1024 * 1024

export interface DecodeLimits {
  maxInputBytes?: number
  maxPcmBytes?: number
}

export interface DecodeEstimate {
  inputBytes: number
  /** null when browser metadata probing cannot determine the duration. */
  pcmBytes: number | null
}

/** Worst-case native decode rate assumed when probing (48 kHz stereo f32). */
const ASSUMED_DECODE_BYTES_PER_SEC = 48_000 * 2 * 4

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/**
 * Duration in seconds from container metadata only — the browser reads headers,
 * never the whole file. Returns null when it can't be determined (no DOM, bad
 * container, unsupported codec); callers then fall back to the size gate alone.
 */
export async function probeDurationSec(blob: Blob): Promise<number | null> {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null
  }
  const url = URL.createObjectURL(blob)
  const el = document.createElement('video')
  try {
    el.preload = 'metadata'
    el.muted = true
    const duration = await new Promise<number | null>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (v: number | null) => {
        if (settled) return
        settled = true
        if (timer != null) clearTimeout(timer)
        timer = null
        el.onloadedmetadata = null
        el.onerror = null
        resolve(v)
      }
      el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null)
      el.onerror = () => done(null)
      // Never hang the caller on a container the browser silently won't parse.
      timer = setTimeout(() => done(null), 5000)
      el.src = url
    })
    return duration
  } catch {
    return null
  } finally {
    el.removeAttribute('src')
    el.load()
    URL.revokeObjectURL(url)
  }
}

export class AudioDecodeTooLargeError extends Error {
  readonly sizeBytes: number
  readonly limitBytes: number

  constructor(sizeBytes: number, limitBytes: number, what: string) {
    super(
      `${what} is too large to decode in the browser (${formatGB(sizeBytes)}, ` +
        `limit ${formatGB(limitBytes)}). Start the XinChao-Cut backend so FFmpeg can ` +
        `handle it, or trim/split the source first.`,
    )
    this.name = 'AudioDecodeTooLargeError'
    this.sizeBytes = sizeBytes
    this.limitBytes = limitBytes
  }
}

/**
 * Throw before `blob.arrayBuffer()` when the container alone would blow the
 * renderer's memory budget. Call this at the top of every main-thread decode.
 */
export function assertDecodableSize(
  blob: Blob,
  what = 'This audio source',
  limitBytes: number = MAX_DECODE_INPUT_BYTES,
): void {
  if (blob.size > limitBytes) {
    throw new AudioDecodeTooLargeError(blob.size, limitBytes, what)
  }
}

/**
 * Full pre-decode gate: the container size AND the decoded-PCM footprint implied
 * by the probed duration. Await this before `blob.arrayBuffer()`.
 *
 * The duration probe reads container metadata only. If it can't be determined we
 * fall through on the size gate alone rather than blocking a legitimate decode.
 */
export async function assertDecodable(
  blob: Blob,
  what = 'This audio source',
  limits: DecodeLimits = {},
): Promise<DecodeEstimate> {
  const maxInputBytes = limits.maxInputBytes ?? MAX_DECODE_INPUT_BYTES
  const maxPcmBytes = limits.maxPcmBytes ?? MAX_DECODED_PCM_BYTES
  assertDecodableSize(blob, what, maxInputBytes)
  const durationSec = await probeDurationSec(blob)
  if (durationSec == null || !(durationSec > 0)) {
    return { inputBytes: blob.size, pcmBytes: null }
  }
  const pcmBytes = durationSec * ASSUMED_DECODE_BYTES_PER_SEC
  if (pcmBytes > maxPcmBytes) {
    throw new AudioDecodeTooLargeError(pcmBytes, maxPcmBytes, `${what} (decoded)`)
  }
  return { inputBytes: blob.size, pcmBytes }
}
