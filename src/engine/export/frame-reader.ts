import { createFile, DataStream, Endianness, type ISOFile, type Sample } from 'mp4box'
import { yieldToMacrotask } from '@engine/core/schedule'

/**
 * Decodes video frames sequentially with WebCodecs VideoDecoder instead of
 * seeking an <video> element (which is ~100ms/seek → minutes for a full clip).
 *
 * Optimised for forward playback (export iterates time ascending): it streams
 * encoded chunks into the decoder in decode order and hands back the frame
 * visible at a given source time. A backward jump reconfigures the decoder and
 * restarts from the nearest prior keyframe (not from sample 0), so reverse
 * clip order / scrubbing does not re-decode the entire file. A FORWARD jump
 * whose covering keyframe lies beyond every sample fetched so far restarts
 * there too (see shouldRestartForward) — a later clip that skips minutes of
 * source no longer decodes the whole gap.
 *
 * Memory is bounded: only the moov box is parsed up front (mp4box's
 * appendBuffer returns the next position it needs, skipping over mdat), and
 * sample data is read from the source Blob on demand in fixed-size windows —
 * the file is never fully materialised in RAM, so multi-GB sources are fine.
 */
export interface VideoFrameReader {
  /** Frame visible at `sourceSec` (caller must NOT close it — the reader owns it). */
  getFrameAt(sourceSec: number): Promise<VideoFrame | null>
  close(): void
}

/**
 * Diagnostic decode counters, cumulative across every reader on this thread.
 * The exporter logs per-window deltas so a slow export can be attributed to
 * seek churn (a timeline with many reordered cuts re-decodes from a
 * keyframe on each backward/forward jump) vs. steady sequential decode.
 * `configures` counts every decoder (re)init (first open + each reset);
 * `resets` counts only seek-driven re-inits. Read/chunk/output counters expose
 * whether a slow source is I/O-bound or simply decodes more input frames per
 * rendered output frame (for example, 60 fps source into a 30 fps export).
 */
export const frameReaderStats = {
  configures: 0,
  resets: 0,
  backwardResets: 0,
  forwardResets: 0,
  sourceReadCalls: 0,
  sourceReadBytes: 0,
  sourceReadMs: 0,
  sourceCacheHits: 0,
  sourceCacheMisses: 0,
  sourceCacheBytesServed: 0,
  chunksSubmitted: 0,
  framesOutput: 0,
  sourceRateObservations: 0,
  sourceRateTotal: 0,
  hardwareConfigures: 0,
  softwareConfigures: 0,
  hardwareFallbacks: 0,
  coldDecodeCalls: 0,
  coldDecodeMs: 0,
  resetDecodeCalls: 0,
  resetDecodeMs: 0,
  steadyDecodeCalls: 0,
  steadyDecodeMs: 0,
}

/**
 * Random-access encoded media input. Browser imports use Blob slices; desktop
 * path-backed media uses bounded native range reads through the export worker.
 */
export interface VideoByteSource {
  size: number
  read(start: number, end: number): Promise<ArrayBuffer>
}

export type VideoReaderSource = Blob | VideoByteSource

export interface SharedVideoByteRangeCache {
  wrap(sourceId: string, source: VideoByteSource): VideoByteSource
}

export function asVideoByteSource(source: VideoReaderSource): VideoByteSource {
  if (source instanceof Blob) {
    return {
      size: source.size,
      read: (start, end) => source.slice(start, end).arrayBuffer(),
    }
  }
  return source
}

/**
 * Add a bounded, shared exact/covering-range cache to a random-access source.
 *
 * Dense timelines frequently revisit the same keyframe ranges after a cut.
 * Without this layer every decoder reset sends another 16 MiB desktop IPC
 * read even though the bytes are immutable and were read seconds earlier.
 * Entries are LRU-evicted and the cache never exceeds `maxBytes`.
 */
export function createSharedVideoByteRangeCache(
  maxBytes = 64 * 1024 * 1024,
): SharedVideoByteRangeCache {
  interface CacheEntry {
    sourceId: string
    start: number
    end: number
    buffer: ArrayBuffer
  }

  const budget = Math.max(0, Math.floor(maxBytes))
  const entries = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<ArrayBuffer>>()
  let cachedBytes = 0
  const keyOf = (sourceId: string, start: number, end: number) =>
    `${sourceId}:${start}:${end}`
  const touch = (key: string, entry: CacheEntry) => {
    entries.delete(key)
    entries.set(key, entry)
  }

  return {
    wrap(sourceId: string, source: VideoByteSource): VideoByteSource {
      return {
        size: source.size,
        async read(start: number, end: number): Promise<ArrayBuffer> {
          const key = keyOf(sourceId, start, end)
          const exact = entries.get(key)
          if (exact) {
            touch(key, exact)
            frameReaderStats.sourceCacheHits++
            frameReaderStats.sourceCacheBytesServed += Math.max(0, end - start)
            return exact.buffer
          }

          // A keyframe-aligned restart can request a smaller tail of a
          // previously cached window from the same immutable source.
          for (const [coveringKey, entry] of entries) {
            if (
              entry.sourceId !== sourceId || entry.start > start || entry.end < end
            ) continue
            touch(coveringKey, entry)
            frameReaderStats.sourceCacheHits++
            frameReaderStats.sourceCacheBytesServed += Math.max(0, end - start)
            return entry.buffer.slice(start - entry.start, end - entry.start)
          }

          const pending = inflight.get(key)
          if (pending) {
            frameReaderStats.sourceCacheHits++
            frameReaderStats.sourceCacheBytesServed += Math.max(0, end - start)
            return pending
          }

          frameReaderStats.sourceCacheMisses++
          const load = source.read(start, end).then((buffer) => {
            if (budget === 0 || buffer.byteLength === 0 || buffer.byteLength > budget) {
              return buffer
            }
            while (entries.size > 0 && cachedBytes + buffer.byteLength > budget) {
              const oldestKey = entries.keys().next().value as string | undefined
              if (!oldestKey) break
              const oldest = entries.get(oldestKey)
              entries.delete(oldestKey)
              if (oldest) cachedBytes -= oldest.buffer.byteLength
            }
            const entry: CacheEntry = {
              sourceId,
              start,
              end: start + buffer.byteLength,
              buffer,
            }
            entries.set(key, entry)
            cachedBytes += buffer.byteLength
            return buffer
          }).finally(() => inflight.delete(key))
          inflight.set(key, load)
          return load
        },
      }
    },
  }
}

/** Add a private bounded cache to one random-access source. */
export function createCachedVideoByteSource(
  source: VideoByteSource,
  maxBytes = 64 * 1024 * 1024,
): VideoByteSource {
  return createSharedVideoByteRangeCache(maxBytes).wrap('source', source)
}

/** Lightweight per-sample index entry (no data — read from the blob on demand). */
export interface SampleRef {
  offset: number
  size: number
  type: 'key' | 'delta'
  /** Composition timestamp in microseconds (CTS), not DTS. */
  tsUs: number
  durUs: number
}

/** Immutable demux metadata shared by all decoder mappings of one asset. */
export interface VideoSampleIndex {
  codec: string
  codedWidth: number
  codedHeight: number
  description?: Uint8Array
  offsets: Float64Array
  sizes: Uint32Array
  keyFlags: Uint8Array
  tsUs: Float64Array
  durUs: Float64Array
  keyIndices: Uint32Array
}

const EPS = 1e-3

// Parse slice for the moov scan; window size for batched sample reads. Real
// export measurements showed that 32 MiB desktop ranges halved the call count
// but increased over-read and latency enough to regress long exports, so keep
// the bounded 16 MiB window for both source adapters.
const PARSE_SLICE = 4 * 1024 * 1024
const BLOB_READ_WINDOW = 16 * 1024 * 1024
const BYTE_SOURCE_READ_WINDOW = 16 * 1024 * 1024

/** Estimate encoded video samples/second without sorting a potentially huge track. */
export function estimateVideoSampleRate(durationsUs: Float64Array): number {
  if (durationsUs.length === 0) return 0
  const sampleLimit = 512
  const stride = Math.max(1, Math.floor(durationsUs.length / sampleLimit))
  let totalUs = 0
  let samples = 0
  for (let index = 0; index < durationsUs.length; index += stride) {
    const durationUs = durationsUs[index]!
    if (!Number.isFinite(durationUs) || durationUs <= 0) continue
    totalUs += durationUs
    samples++
  }
  if (samples === 0 || totalUs <= 0) return 0
  return 1_000_000 / (totalUs / samples)
}

/**
 * Build the list of sample indices that are sync/key frames.
 * Exported for unit tests.
 */
export function buildKeyIndices(refs: readonly Pick<SampleRef, 'type'>[]): number[] {
  const keys: number[] = []
  for (let i = 0; i < refs.length; i++) {
    if (refs[i]!.type === 'key') keys.push(i)
  }
  // Degenerate stream with no marked sync samples — still need a start point.
  if (keys.length === 0 && refs.length > 0) keys.push(0)
  return keys
}

/**
 * Pick the sample index to resume decoding from for a backward jump (or initial
 * seek) to `targetSec`.
 *
 * Sample table is in decode order; `tsUs` is CTS. With B-frame reorder, a frame
 * after the last keyframe with CTS ≤ target may still depend on the *previous*
 * GOP's keyframe. We therefore take the last key with CTS ≤ target, then retreat
 * one keyframe when one exists — correct for B-frame GOPs at the cost of at most
 * one extra GOP of decode (never "from the start of a 1h file").
 *
 * Exported for unit tests (mock sample metadata, no WebCodecs).
 */
export function findSeekSampleIndex(
  refs: readonly Pick<SampleRef, 'type' | 'tsUs'>[],
  keyIndices: readonly number[],
  targetSec: number,
): number {
  if (refs.length === 0) return 0
  if (keyIndices.length === 0) return 0

  const targetUs = targetSec * 1e6

  // Binary search: last keyframe whose CTS ≤ targetUs.
  let lo = 0
  let hi = keyIndices.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const sampleIdx = keyIndices[mid]!
    if (refs[sampleIdx]!.tsUs <= targetUs) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  if (best < 0) {
    // Target is before every keyframe's CTS — start at the first key (usually 0).
    return keyIndices[0]!
  }

  // B-frame reorder safety: start one keyframe earlier when available.
  const safe = best > 0 ? best - 1 : best
  return keyIndices[safe]!
}

/**
 * True when a FORWARD jump to `targetSec` should restart the decoder at the
 * covering keyframe instead of decoding sequentially through the gap.
 *
 * Both paths must decode up to the sample containing the target; the sequential
 * path starts at the fetch cursor (`nextSample`), the restart path at
 * `findSeekSampleIndex(target)`. Restarting therefore wins exactly when the
 * restart point lies beyond the cursor — strictly fewer samples decoded AND no
 * re-read of blob ranges already fetched. Steady forward playback never
 * triggers this: the B-frame retreat keeps the restart point at least one GOP
 * behind a cursor that prefetch holds ahead of the last target.
 *
 * Exported for unit tests (same expression getFrameAt uses).
 */
export function shouldRestartForward(
  refs: readonly Pick<SampleRef, 'type' | 'tsUs'>[],
  keyIndices: readonly number[],
  targetSec: number,
  nextSample: number,
): boolean {
  return findSeekSampleIndex(refs, keyIndices, targetSec) > nextSample
}

/**
 * Chromium can emit every delayed frame and drain decodeQueueSize to zero while
 * leaving VideoDecoder.flush() pending forever. Once new flush output has been
 * quiet for a short interval with an empty queue, treating it as EOS is safer
 * than failing an otherwise complete export after the five-second timeout.
 */
export function canRecoverCompletedDecoderFlush(
  outputVersionAtStart: number,
  outputVersionNow: number,
  decodeQueueSize: number,
  quietMs: number,
): boolean {
  return (
    outputVersionNow > outputVersionAtStart &&
    decodeQueueSize === 0 &&
    quietMs >= 50
  )
}

function findPackedSeekSampleIndex(index: VideoSampleIndex, targetSec: number): number {
  if (index.tsUs.length === 0 || index.keyIndices.length === 0) return 0
  const targetUs = targetSec * 1e6
  let lo = 0
  let hi = index.keyIndices.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const sampleIdx = index.keyIndices[mid]!
    if (index.tsUs[sampleIdx]! <= targetUs) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best < 0) return index.keyIndices[0]!
  return index.keyIndices[best > 0 ? best - 1 : best]!
}

function buildDescription(file: ISOFile, trackId: number): Uint8Array | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trak: any = (file as any).getTrackById(trackId)
  const entries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? []
  for (const entry of entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (!box) continue
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
    box.write(stream)
    return new Uint8Array(stream.buffer, 8) // strip the 8-byte box header
  }
  return undefined
}

export async function createVideoSampleIndex(sourceInput: VideoReaderSource): Promise<VideoSampleIndex> {
  const source = asVideoByteSource(sourceInput)
  const file = createFile()
  let codec = ''
  let codedWidth = 0
  let codedHeight = 0
  let description: Uint8Array | undefined
  let trackId = 0
  let parseReady = false
  let parseError: Error | null = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(file as any).onError = (e: string) => {
    parseError = new Error(`mp4box: ${e}`)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  file.onReady = (info: any) => {
    const vtrack = info.videoTracks?.[0] ?? info.tracks?.find((t: { video?: unknown }) => t.video)
    if (!vtrack) {
      parseError = new Error('No video track')
      return
    }
    trackId = vtrack.id
    codec = vtrack.codec
    codedWidth = vtrack.track_width || vtrack.video?.width || 0
    codedHeight = vtrack.track_height || vtrack.video?.height || 0
    description = buildDescription(file, trackId)
    parseReady = true
  }

  // ── Index phase: parse just the moov. appendBuffer returns the next file
  // position the parser wants, which lets it leap over the (huge) mdat box —
  // so only a few MB of metadata ever enter memory, wherever the moov lives.
  let pos = 0
  while (!parseReady && !parseError && pos < source.size) {
    const end = Math.min(pos + PARSE_SLICE, source.size)
    const buf = (await source.read(pos, end)) as ArrayBuffer & { fileStart: number }
    buf.fileStart = pos
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = file.appendBuffer(buf as any, end >= source.size) as number | undefined
    // Follow the parser's jump when it advances; otherwise read linearly.
    pos = typeof next === 'number' && next > pos ? next : end
  }
  if (parseError) throw parseError
  if (!parseReady) throw new Error('Could not parse MP4 metadata')

  // Sample index from the moov's stbl — metadata only, no media data.
  const samples: Sample[] = file.getTrackSamplesInfo(trackId) ?? []
  const count = samples.reduce((n, sample) => n + (sample.size > 0 ? 1 : 0), 0)
  if (count === 0) throw new Error('No video samples')
  const offsets = new Float64Array(count)
  const sizes = new Uint32Array(count)
  const keyFlags = new Uint8Array(count)
  const tsUs = new Float64Array(count)
  const durUs = new Float64Array(count)
  let cursor = 0
  let keyCount = 0
  for (const sample of samples) {
    if (sample.size <= 0) continue
    offsets[cursor] = sample.offset
    sizes[cursor] = sample.size
    keyFlags[cursor] = sample.is_sync ? 1 : 0
    if (sample.is_sync) keyCount++
    tsUs[cursor] = (sample.cts / sample.timescale) * 1e6
    durUs[cursor] = (sample.duration / sample.timescale) * 1e6
    cursor++
  }
  const keyIndices = new Uint32Array(keyCount || 1)
  if (keyCount === 0) {
    keyIndices[0] = 0
  } else {
    let keyCursor = 0
    for (let i = 0; i < count; i++) {
      if (keyFlags[i]) keyIndices[keyCursor++] = i
    }
  }

  return {
    codec, codedWidth, codedHeight, description,
    offsets, sizes, keyFlags, tsUs, durUs, keyIndices,
  }
}

export async function createVideoFrameReader(
  sourceInput: VideoReaderSource,
  sharedIndex?: VideoSampleIndex,
): Promise<VideoFrameReader> {
  const source = asVideoByteSource(sourceInput)
  const readWindow = sourceInput instanceof Blob
    ? BLOB_READ_WINDOW
    : BYTE_SOURCE_READ_WINDOW
  const index = sharedIndex ?? await createVideoSampleIndex(source)
  const {
    codec, codedWidth, codedHeight, description,
    offsets, sizes, keyFlags, tsUs, durUs,
  } = index
  const sampleCount = offsets.length
  const sourceSampleRate = estimateVideoSampleRate(durUs)
  frameReaderStats.sourceRateObservations++
  frameReaderStats.sourceRateTotal += sourceSampleRate

  // ── decoder state ─────────────────────────────────────────
  let decoder: VideoDecoder | null = null
  let ready: VideoFrame[] = []
  let current: VideoFrame | null = null
  let flushed = false
  let lastSec = -Infinity
  let closed = false
  let errored = false
  let outputVersion = 0
  // Browser export is explicitly GPU-first. Hardware VideoDecoder keeps YUV
  // surfaces on the GPU so WebGPU can consume them without a CPU decode/copy.
  // A driver/configure/stall failure flips this reader to software once and
  // restarts from the covering keyframe, preserving export reliability.
  let decoderAcceleration: NonNullable<VideoDecoderConfig['hardwareAcceleration']> =
    'prefer-hardware'

  // On-demand fetch state: `pending` holds chunks read but not yet fed; the
  // cursor walks `refs` in decode order. Memory is bounded by one read window
  // plus the decoder's own queue.
  let pending: EncodedVideoChunk[] = []
  let pendingHead = 0
  let nextSample = 0

  const pendingCount = () => pending.length - pendingHead

  function takePending(): EncodedVideoChunk {
    const chunk = pending[pendingHead++]!
    if (pendingHead === pending.length) {
      // Drop the drained backing array in O(1). Array.shift() moved hundreds of
      // chunk references per decoded frame for a 16 MiB read window.
      pending = []
      pendingHead = 0
    }
    return chunk
  }

  // Phase A decode-ahead: overlap the blob read of the NEXT batch with the
  // decode/composite of the current frame. `inflightFetch` enforces the
  // single-flight invariant (at most one fetchBatch in flight); `gen` is
  // bumped on reset()/configure() so a fetch launched under an old generation
  // discards its result instead of writing into the freshly-reset state.
  let inflightFetch: Promise<void> | null = null
  let prefetchError: unknown = null
  let gen = 0

  async function fetchBatch(): Promise<void> {
    if (nextSample >= sampleCount) return
    const myGen = gen
    const start = nextSample
    let end = start
    let lo = offsets[start]!
    let hi = lo + sizes[start]!
    // Grow the window over subsequent samples (usually contiguous in mdat)
    // until it would exceed the source-specific read window. Always take at
    // least one sample.
    while (end < sampleCount) {
      const offset = offsets[end]!
      const size = sizes[end]!
      const nlo = Math.min(lo, offset)
      const nhi = Math.max(hi, offset + size)
      if (nhi - nlo > readWindow && end > start) break
      lo = nlo
      hi = nhi
      end++
    }
    const readStartedAt = performance.now()
    const readBuffer = await source.read(lo, hi)
    frameReaderStats.sourceReadCalls++
    frameReaderStats.sourceReadBytes += hi - lo
    frameReaderStats.sourceReadMs += performance.now() - readStartedAt
    const buf = new Uint8Array(readBuffer)
    // A reset()/configure() during the await invalidates this read — the
    // pending queue and cursor were rebuilt for a new generation. Drop it.
    if (gen !== myGen) return
    if (pendingHead > 0) {
      // Prefetch resolves while a few old chunks may remain. Compact once per
      // read window instead of shifting the whole queue once per video frame.
      pending = pending.slice(pendingHead)
      pendingHead = 0
    }
    for (let i = start; i < end; i++) {
      const offset = offsets[i]!
      const size = sizes[i]!
      pending.push(
        new EncodedVideoChunk({
          type: keyFlags[i] ? 'key' : 'delta',
          timestamp: tsUs[i]!,
          duration: durUs[i]!,
          data: buf.subarray(offset - lo, offset - lo + size),
        }),
      )
    }
    nextSample = end
  }

  // Kick off (or return) the single in-flight batch read. Fire-and-forget safe:
  // a read rejection is captured here to avoid an unhandled fire-and-forget
  // promise, then rethrown by the foreground getFrameAt loop.
  function startPrefetch(): Promise<void> | null {
    if (inflightFetch || nextSample >= sampleCount) return inflightFetch
    const myGen = gen
    inflightFetch = fetchBatch()
      .catch((error) => {
        if (gen === myGen) prefetchError = error
      })
      .finally(() => {
        if (gen === myGen) inflightFetch = null
      })
    return inflightFetch
  }

  function disposeFrames() {
    if (current) current.close()
    current = null
    for (const f of ready) f.close()
    ready = []
  }

  /**
   * Configure a fresh VideoDecoder and set the sample cursor at `startSample`
   * (must be a keyframe index, or 0 as fallback).
   */
  function configure(startSample = 0) {
    frameReaderStats.configures++
    errored = false
    const createDecoder = () => new VideoDecoder({
      output: (f) => {
        ready.push(f)
        outputVersion++
        frameReaderStats.framesOutput++
      },
      error: () => {
        errored = true
      },
    })
    const decoderConfig = (
      hardwareAcceleration: NonNullable<VideoDecoderConfig['hardwareAcceleration']>,
    ): VideoDecoderConfig => {
      const cfg: VideoDecoderConfig = {
        codec,
        codedWidth,
        codedHeight,
        hardwareAcceleration,
        // Export is an offline throughput job: permit decoder buffering and
        // B-frame reordering instead of optimizing single-frame latency.
        optimizeForLatency: false,
      }
      if (description) cfg.description = description
      return cfg
    }
    decoder = createDecoder()
    try {
      decoder.configure(decoderConfig(decoderAcceleration))
    } catch (error) {
      if (decoderAcceleration !== 'prefer-hardware') throw error
      try { decoder.close() } catch { /* rejected configure */ }
      decoderAcceleration = 'prefer-software'
      frameReaderStats.hardwareFallbacks++
      decoder = createDecoder()
      decoder.configure(decoderConfig(decoderAcceleration))
    }
    if (decoderAcceleration === 'prefer-hardware') frameReaderStats.hardwareConfigures++
    else frameReaderStats.softwareConfigures++
    pending = []
    pendingHead = 0
    // Clamp so a bad index never walks past the end.
    nextSample = Math.max(0, Math.min(startSample, sampleCount))
    flushed = false
    // Invalidate any in-flight prefetch: its result belongs to the old state.
    gen++
    inflightFetch = null
    prefetchError = null
  }

  /**
   * Tear down decoder state and restart at the keyframe covering `targetSec`
   * (not sample 0 — that was the long-export O(n) trap on every backward jump).
   */
  function reset(targetSec: number) {
    frameReaderStats.resets++
    disposeFrames()
    try {
      decoder?.close()
    } catch {
      /* already closed */
    }
    const start = findPackedSeekSampleIndex(index, targetSec)
    configure(start)
  }

  function fallbackHardwareDecoder(targetSec: number): boolean {
    if (decoderAcceleration !== 'prefer-hardware') return false
    decoderAcceleration = 'prefer-software'
    frameReaderStats.hardwareFallbacks++
    reset(targetSec)
    return true
  }

  const frameSec = (f: VideoFrame) => (f.timestamp ?? 0) / 1e6

  // Keep NVDEC fed while WebGPU/VideoEncoder consume the previous frame. The
  // hardware path can hold a few more GPU surfaces; software stays conservative.
  const decodeQueueLimit = () => decoderAcceleration === 'prefer-hardware' ? 16 : 8

  // Phase A decode-ahead tuning / rollback switch. With DECODE_AHEAD off the
  // reader falls back to the old strictly-sequential fetch (await when empty).
  const DECODE_AHEAD = true
  const PREFETCH_LOW_WATER = 4

  async function getFrameAt(targetSec: number): Promise<VideoFrame | null> {
    if (closed) return null
    const callStartedAt = performance.now()
    let callKind: 'cold' | 'reset' | 'steady' = 'steady'
    try {
    if (!decoder) {
      callKind = 'cold'
      // First access may be mid-file (clip in-point far into a long source) —
      // start at the covering keyframe, not sample 0.
      configure(findPackedSeekSampleIndex(index, targetSec))
    } else if (targetSec < lastSec - EPS) {
      callKind = 'reset'
      frameReaderStats.backwardResets++
      // Backward jump → re-decode from the nearest prior keyframe (with B-frame
      // safety), not from the start of the file.
      reset(targetSec)
    } else if (findPackedSeekSampleIndex(index, targetSec) > nextSample) {
      callKind = 'reset'
      frameReaderStats.forwardResets++
      // Forward jump past everything fetched so far (a later clip skipping
      // minutes of source, or PiP alternating far-apart in-points): restart at
      // the covering keyframe instead of decoding the whole gap.
      reset(targetSec)
    }
    lastSec = targetSec

    // Wall-clock stall guard. The old 5-million-iteration counter allowed a
    // stalled hardware decoder (full queue, no outputs, no error callback) to
    // spin here for 15+ minutes — the export sat at "100%" looking hung. Fail
    // fast with a diagnosable message instead; the exporter surfaces it.
    let deadline = Date.now() + 20_000
    for (let guard = 0; guard < 5_000_000; guard++) {
      if (prefetchError) {
        const error = prefetchError
        prefetchError = null
        throw new Error(`Video source prefetch failed at ${targetSec.toFixed(3)}s`, {
          cause: error,
        })
      }
      if (errored && fallbackHardwareDecoder(targetSec)) {
        callKind = 'reset'
        deadline = Date.now() + 20_000
        continue
      }
      if (errored) return current // decode failed → keep last good frame, don't hang
      if (Date.now() > deadline) {
        if (fallbackHardwareDecoder(targetSec)) {
          callKind = 'reset'
          deadline = Date.now() + 20_000
          continue
        }
        throw new Error(
          `Video decode stalled at ${targetSec.toFixed(3)}s ` +
          `(decoderQueue=${decoder?.decodeQueueSize ?? -1}, ready=${ready.length}, ` +
          `sample=${nextSample}/${sampleCount}, flushed=${flushed})`,
        )
      }
      // Advance `current` over every ready frame up to the target time.
      while (ready.length > 0 && frameSec(ready[0]!) <= targetSec + EPS) {
        if (current) current.close()
        current = ready.shift()!
      }
      // A frame strictly after target means `current` is the right one.
      if (ready.length > 0 && frameSec(ready[0]!) > targetSec + EPS) return current

      if (pendingCount() > 0 || nextSample < sampleCount) {
        // Feed only while the decoder has room — this is the backpressure that
        // keeps memory bounded. If it's full, just wait for outputs.
        while (pendingCount() > 0 && decoder!.decodeQueueSize < decodeQueueLimit()) {
          frameReaderStats.chunksSubmitted++
          decoder!.decode(takePending())
        }
        // Early prefetch kick: while we still have chunks to feed but the
        // pending queue is running low, start reading the next batch so the
        // blob I/O overlaps this frame's decode/composite instead of stalling
        // the whole pipeline once pending hits zero.
        if (DECODE_AHEAD && pendingCount() < PREFETCH_LOW_WATER && nextSample < sampleCount) {
          startPrefetch()
        }
        if (pendingCount() === 0 && nextSample < sampleCount &&
            decoder!.decodeQueueSize < decodeQueueLimit()) {
          // Await the in-flight batch (started by the early kick) rather than
          // issuing a fresh blocking read; the getFrameAt deadline bounds it.
          await (DECODE_AHEAD ? (startPrefetch() ?? Promise.resolve()) : fetchBatch())
        } else {
          await yieldToMacrotask()
        }
      } else if (!flushed) {
        // Some WebView2/driver combinations emit every delayed frame but never
        // resolve flush(). Observe actual output and queue state so a complete
        // stream does not pay the five-second timeout or fail at the final GOP.
        const outputVersionAtStart = outputVersion
        let lastOutputVersion = outputVersion
        let lastOutputAt = Date.now()
        let flushSettled = false
        let flushFailure: unknown = null
        let flushPromise: Promise<void>
        try {
          flushPromise = decoder!.flush()
        } catch (error) {
          throw new Error(
            `Video decoder flush failed at ${targetSec.toFixed(3)}s ` +
            `(decoderQueue=${decoder?.decodeQueueSize ?? -1}, ready=${ready.length})`,
            { cause: error },
          )
        }
        void flushPromise.then(
          () => { flushSettled = true },
          (error) => {
            flushFailure = error
            flushSettled = true
          },
        )

        const flushDeadline = Math.min(deadline, Date.now() + 5_000)
        while (!flushSettled && Date.now() <= flushDeadline) {
          await yieldToMacrotask()
          if (outputVersion !== lastOutputVersion) {
            lastOutputVersion = outputVersion
            lastOutputAt = Date.now()
          }
          // Consume every delayed output up to the requested source time.
          while (ready.length > 0 && frameSec(ready[0]!) <= targetSec + EPS) {
            if (current) current.close()
            current = ready.shift()!
          }
          if (ready.length > 0 && frameSec(ready[0]!) > targetSec + EPS) {
            return current
          }
          if (canRecoverCompletedDecoderFlush(
            outputVersionAtStart,
            outputVersion,
            decoder!.decodeQueueSize,
            Date.now() - lastOutputAt,
          )) {
            flushed = true
            return current
          }
        }
        if (flushSettled && !flushFailure) {
          flushed = true
          await yieldToMacrotask()
          continue
        }
        // A driver may reject flush after already delivering the delayed GOP.
        // Give those callbacks the same short quiet-period recovery rather than
        // turning a complete frame sequence into a false export failure.
        while (
          outputVersion > outputVersionAtStart &&
          decoder!.decodeQueueSize === 0 &&
          Date.now() - lastOutputAt < 50 &&
          Date.now() <= flushDeadline
        ) {
          await yieldToMacrotask()
          if (outputVersion !== lastOutputVersion) {
            lastOutputVersion = outputVersion
            lastOutputAt = Date.now()
          }
          while (ready.length > 0 && frameSec(ready[0]!) <= targetSec + EPS) {
            if (current) current.close()
            current = ready.shift()!
          }
          if (ready.length > 0 && frameSec(ready[0]!) > targetSec + EPS) {
            return current
          }
        }
        // One final recovery check covers output delivered in the same task as
        // the deadline. A genuine no-output stall still fails diagnostically.
        if (canRecoverCompletedDecoderFlush(
          outputVersionAtStart,
          outputVersion,
          decoder!.decodeQueueSize,
          Date.now() - lastOutputAt,
        )) {
          flushed = true
          return current
        }
        throw new Error(
          `Video decoder flush failed at ${targetSec.toFixed(3)}s ` +
          `(decoderQueue=${decoder?.decodeQueueSize ?? -1}, ready=${ready.length})`,
          { cause: flushFailure ?? new Error('decoder.flush timeout') },
        )
      } else {
        // End of stream — return the last decoded frame.
        while (ready.length > 0 && frameSec(ready[0]!) <= targetSec + EPS) {
          if (current) current.close()
          current = ready.shift()!
        }
        return current
      }
    }
    return current
    } finally {
      const elapsedMs = performance.now() - callStartedAt
      if (callKind === 'cold') {
        frameReaderStats.coldDecodeCalls++
        frameReaderStats.coldDecodeMs += elapsedMs
      } else if (callKind === 'reset') {
        frameReaderStats.resetDecodeCalls++
        frameReaderStats.resetDecodeMs += elapsedMs
      } else {
        frameReaderStats.steadyDecodeCalls++
        frameReaderStats.steadyDecodeMs += elapsedMs
      }
    }
  }

  return {
    getFrameAt,
    close() {
      closed = true
      disposeFrames()
      try {
        decoder?.close()
      } catch {
        /* ignore */
      }
      decoder = null
    },
  }
}

/**
 * HTMLVideoElement seek-based reader — used when the WebCodecs decoder pool is
 * saturated (many unique source mappings active at once) or when the container
 * is not WebCodecs-friendly. Same {@link VideoFrameReader} surface so export
 * can keep calling getFrameAt; slower than sequential decode (~seek latency).
 *
 * Unavailable in pure workers (no DOM `<video>`). Callers should fall back to
 * soft WebCodecs create or surface a clear error.
 */
export async function createHtmlVideoFrameReader(blob: Blob): Promise<VideoFrameReader> {
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') {
    throw new Error(
      'HTMLVideo seek reader unavailable in this environment (no DOM video element)',
    )
  }
  if (typeof VideoFrame === 'undefined') {
    throw new Error('VideoFrame constructor unavailable — cannot wrap <video> seek frames')
  }

  const url = URL.createObjectURL(blob)
  const el = document.createElement('video')
  el.crossOrigin = 'anonymous'
  el.src = url
  el.preload = 'auto'
  el.muted = true
  el.playsInline = true

  try {
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup()
        resolve()
      }
      const onErr = () => {
        cleanup()
        reject(new Error('HTMLVideo seek reader failed to load media'))
      }
      const cleanup = () => {
        el.removeEventListener('loadedmetadata', onMeta)
        el.removeEventListener('error', onErr)
      }
      if (el.readyState >= 1) {
        resolve()
        return
      }
      el.addEventListener('loadedmetadata', onMeta)
      el.addEventListener('error', onErr)
    })
  } catch (error) {
    // No reader object is returned on metadata failure, so its close() cannot
    // perform this cleanup for us. Release the multi-GB blob URL here.
    el.removeAttribute('src')
    el.load()
    URL.revokeObjectURL(url)
    throw error
  }

  let current: VideoFrame | null = null
  let closed = false
  let lastSec = -Infinity

  const seekTo = (sec: number, timeoutMs = 10_000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (Math.abs(el.currentTime - sec) < 0.001) {
        resolve()
        return
      }
      let settled = false
      const onSeeked = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        el.removeEventListener('seeked', onSeeked)
        resolve()
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        el.removeEventListener('seeked', onSeeked)
        reject(new Error(`HTMLVideo seek timed out at ${sec.toFixed(3)}s`))
      }, timeoutMs)
      el.addEventListener('seeked', onSeeked)
      try {
        el.currentTime = Math.max(0, sec)
      } catch (e) {
        settled = true
        clearTimeout(timer)
        el.removeEventListener('seeked', onSeeked)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })

  return {
    async getFrameAt(sourceSec: number): Promise<VideoFrame | null> {
      if (closed) return null
      const target = Math.max(0, sourceSec)
      // Small epsilon: avoid re-seek thrash on steady forward playback.
      if (Math.abs(target - lastSec) > 1e-3 || Math.abs(el.currentTime - target) > 1e-3) {
        await seekTo(target)
        lastSec = target
      }
      if (el.readyState < 2) return current
      if (current) {
        try {
          current.close()
        } catch {
          /* ignore */
        }
        current = null
      }
      current = new VideoFrame(el, {
        timestamp: Math.round(target * 1e6),
      })
      return current
    },
    close() {
      closed = true
      if (current) {
        try {
          current.close()
        } catch {
          /* ignore */
        }
        current = null
      }
      try {
        el.pause()
      } catch {
        /* ignore */
      }
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(url)
    },
  }
}
