import { createFile, DataStream, Endianness, type ISOFile, type Sample } from 'mp4box'

/**
 * Decodes video frames sequentially with WebCodecs VideoDecoder instead of
 * seeking an <video> element (which is ~100ms/seek → minutes for a full clip).
 *
 * Optimised for forward playback (export iterates time ascending): it streams
 * encoded chunks into the decoder in decode order and hands back the frame
 * visible at a given source time. A backward jump re-decodes from the start,
 * which keeps it correct regardless of B-frames / keyframe layout.
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

/** Lightweight per-sample index entry (no data — read from the blob on demand). */
interface SampleRef {
  offset: number
  size: number
  type: 'key' | 'delta'
  tsUs: number
  durUs: number
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const EPS = 1e-3

// Parse slice for the moov scan; window size for batched sample reads.
const PARSE_SLICE = 4 * 1024 * 1024
const READ_WINDOW = 16 * 1024 * 1024

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

export async function createVideoFrameReader(blob: Blob): Promise<VideoFrameReader> {
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
  while (!parseReady && !parseError && pos < blob.size) {
    const end = Math.min(pos + PARSE_SLICE, blob.size)
    const buf = (await blob.slice(pos, end).arrayBuffer()) as ArrayBuffer & { fileStart: number }
    buf.fileStart = pos
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = file.appendBuffer(buf as any, end >= blob.size) as number | undefined
    // Follow the parser's jump when it advances; otherwise read linearly.
    pos = typeof next === 'number' && next > pos ? next : end
  }
  if (parseError) throw parseError
  if (!parseReady) throw new Error('Could not parse MP4 metadata')

  // Sample index from the moov's stbl — metadata only, no media data.
  const samples: Sample[] = file.getTrackSamplesInfo(trackId) ?? []
  const refs: SampleRef[] = samples
    .filter((s) => s.size > 0)
    .map((s) => ({
      offset: s.offset,
      size: s.size,
      type: s.is_sync ? 'key' : 'delta',
      tsUs: (s.cts / s.timescale) * 1e6,
      durUs: (s.duration / s.timescale) * 1e6,
    }))
  if (refs.length === 0) throw new Error('No video samples')

  // ── decoder state ─────────────────────────────────────────
  let decoder: VideoDecoder | null = null
  let ready: VideoFrame[] = []
  let current: VideoFrame | null = null
  let flushed = false
  let lastSec = -Infinity
  let closed = false
  let errored = false

  // On-demand fetch state: `pending` holds chunks read but not yet fed; the
  // cursor walks `refs` in decode order. Memory is bounded by one read window
  // plus the decoder's own queue.
  let pending: EncodedVideoChunk[] = []
  let nextSample = 0

  async function fetchBatch(): Promise<void> {
    if (nextSample >= refs.length) return
    const start = nextSample
    let end = start
    let lo = refs[start]!.offset
    let hi = lo + refs[start]!.size
    // Grow the window over subsequent samples (usually contiguous in mdat)
    // until it would exceed READ_WINDOW. Always take at least one sample.
    while (end < refs.length) {
      const s = refs[end]!
      const nlo = Math.min(lo, s.offset)
      const nhi = Math.max(hi, s.offset + s.size)
      if (nhi - nlo > READ_WINDOW && end > start) break
      lo = nlo
      hi = nhi
      end++
    }
    const buf = new Uint8Array(await blob.slice(lo, hi).arrayBuffer())
    for (let i = start; i < end; i++) {
      const s = refs[i]!
      pending.push(
        new EncodedVideoChunk({
          type: s.type,
          timestamp: s.tsUs,
          duration: s.durUs,
          data: buf.subarray(s.offset - lo, s.offset - lo + s.size),
        }),
      )
    }
    nextSample = end
  }

  function disposeFrames() {
    if (current) current.close()
    current = null
    for (const f of ready) f.close()
    ready = []
  }

  function configure() {
    errored = false
    decoder = new VideoDecoder({
      output: (f) => ready.push(f),
      error: () => {
        errored = true
      },
    })
    const cfg: VideoDecoderConfig = { codec, codedWidth, codedHeight }
    if (description) cfg.description = description
    decoder.configure(cfg)
    pending = []
    nextSample = 0
    flushed = false
  }

  function reset() {
    disposeFrames()
    try {
      decoder?.close()
    } catch {
      /* already closed */
    }
    configure()
  }

  const frameSec = (f: VideoFrame) => (f.timestamp ?? 0) / 1e6

  // Bound how far the decoder runs ahead so 1080p frames don't pile up in RAM.
  const MAX_DECODE_QUEUE = 8

  async function getFrameAt(targetSec: number): Promise<VideoFrame | null> {
    if (closed) return null
    if (!decoder) configure()
    if (targetSec < lastSec - EPS) reset() // backward jump → re-decode from start
    lastSec = targetSec

    for (let guard = 0; guard < 5_000_000; guard++) {
      if (errored) return current // decode failed → keep last good frame, don't hang
      // Advance `current` over every ready frame up to the target time.
      while (ready.length > 0 && frameSec(ready[0]!) <= targetSec + EPS) {
        if (current) current.close()
        current = ready.shift()!
      }
      // A frame strictly after target means `current` is the right one.
      if (ready.length > 0 && frameSec(ready[0]!) > targetSec + EPS) return current

      if (pending.length > 0 || nextSample < refs.length) {
        // Feed only while the decoder has room — this is the backpressure that
        // keeps memory bounded. If it's full, just wait for outputs.
        while (pending.length > 0 && decoder!.decodeQueueSize < MAX_DECODE_QUEUE) {
          decoder!.decode(pending.shift()!)
        }
        if (pending.length === 0 && nextSample < refs.length &&
            decoder!.decodeQueueSize < MAX_DECODE_QUEUE) {
          await fetchBatch()
        } else {
          await tick()
        }
      } else if (!flushed) {
        flushed = true
        try {
          await decoder!.flush()
        } catch {
          /* ignore */
        }
        await tick()
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
