/**
 * S3B — Bounded-block browser audio mix (streaming).
 *
 * Design (session report):
 *
 * | Concern        | Choice |
 * |----------------|--------|
 * | Block size     | {@link STREAM_BLOCK_SEC} = 1.0 s; denoise uses {@link STREAM_DENOISE_BLOCK_SEC} |
 * | Denoise bounds | Each OfflineAudioContext reloads the worklet and resets STFT state. Larger blocks + equal-power crossfade hide clicks and cut worklet churn. |
 * | Scheduling     | Sequential block OfflineAudioContext; clip overlap resolved by Graph scheduling (same as full offline) |
 * | Backpressure   | Producer is pull-based async generator; consumer (encoder) awaits each block; max in-flight = 1 mix + 1 encode |
 * | Resampling     | OfflineAudioContext resamples source AudioBuffers to {@link EXPORT_AUDIO_SAMPLE_RATE} (browser native) |
 * | Encoder        | AudioEncoder AAC in {@link encodeAudioStream}; optional full-buffer parity path for tests |
 * | Cancellation   | AbortSignal checked between blocks; OfflineAudioContext abandoned (GC); no partial MP4 publish (caller) |
 * | Memory budget  | Peak ≈ active source AudioBuffers + 1–2 block mixes + encoder queue — O(block + sources), not O(duration) |
 * | Fallback       | If OfflineAudioContext / AudioEncoder missing → {@link isStreamingAudioAvailable} false; S3A gate remains |
 *
 * Does NOT allocate OfflineAudioContext(frames = duration×sr) for the full timeline.
 */

import type { Clip, Track } from '@engine/timeline'
import { createDenoiseNode, loadDenoiseModule } from '@engine/audio/denoise'

import {
  EXPORT_AUDIO_CHANNELS,
  EXPORT_AUDIO_SAMPLE_RATE,
  isExportAudibleClip,
} from './audio-memory'
import type { PcmAudio } from './exporter'

/** Timeline seconds per OfflineAudioContext block (no denoise). */
export const STREAM_BLOCK_SEC = 1.0

/**
 * Larger blocks when any audible clip uses denoise — fewer OfflineAudioContext
 * create/worklet-load cycles and fewer STFT state resets on a long export.
 */
export const STREAM_DENOISE_BLOCK_SEC = 4.0

/**
 * Equal-power crossfade: blend the first fadeFrames of `next` with the last
 * fadeFrames of `prev` (in place on `next`). Pure — used at denoise block seams.
 */
export const STREAM_DENOISE_CROSSFADE_SEC = 0.04

/** Max blocks held if a consumer buffers (pull model uses 1; tests may raise). */
export const STREAM_QUEUE_MAX_BLOCKS = 2

export interface StreamMixBlock {
  /** Absolute timeline start of this block (seconds). */
  startSec: number
  /** Number of frames at export sample rate. */
  frames: number
  sampleRate: number
  numberOfChannels: number
  /** Planar f32 channels — owned by the consumer after yield (producer does not reuse). */
  channels: Float32Array[]
}

export interface StreamMixOptions {
  durationSec: number
  clips: Clip[]
  tracks: Track[]
  audioBuffers: Map<string, AudioBuffer>
  blockSec?: number
  /** Override denoise boundary crossfade (default STREAM_DENOISE_CROSSFADE_SEC). 0 disables. */
  denoiseCrossfadeSec?: number
  sampleRate?: number
  channels?: number
  signal?: AbortSignal
  /** Test hook: called when a block offline context is created (peak tracking). */
  onBlockAllocated?: (bytes: number) => void
}

/** True when any audible clip requests denoise (drives block size + crossfade). */
export function streamMixNeedsDenoise(clips: Clip[], tracks: Track[]): boolean {
  return clips.some((c) => !!c.denoise && isExportAudibleClip(c, tracks))
}

/** Default block length for a mix run. */
export function streamMixBlockSec(
  clips: Clip[],
  tracks: Track[],
  override?: number,
): number {
  if (override != null && override > 0) return override
  return streamMixNeedsDenoise(clips, tracks) ? STREAM_DENOISE_BLOCK_SEC : STREAM_BLOCK_SEC
}

/**
 * Equal-power weights for COLA seam (same timeline region from two renders).
 * Pure helper — unit-tested independently of WebAudio.
 */
export function equalPowerWeights(i: number, fadeFrames: number): { a: number; b: number } {
  const t = fadeFrames <= 0 ? 1 : (i + 0.5) / fadeFrames
  return {
    a: Math.cos(t * 0.5 * Math.PI), // fade out previous extension
    b: Math.sin(t * 0.5 * Math.PI), // fade in current head
  }
}

/**
 * Overlap-add two planar buffers that cover the **same** timeline region
 * (previous block's extension into the next hop, and the next block's head).
 * Writes the OLA result into `head` in place.
 */
export function overlapAddPlanar(
  pending: Float32Array[],
  head: Float32Array[],
  fadeFrames: number,
): void {
  if (fadeFrames <= 0) return
  const nch = Math.min(pending.length, head.length)
  for (let c = 0; c < nch; c++) {
    const p = pending[c]
    const h = head[c]
    if (!p || !h) continue
    const frames = Math.min(fadeFrames, p.length, h.length)
    for (let i = 0; i < frames; i++) {
      const { a, b } = equalPowerWeights(i, frames)
      h[i] = (p[i] ?? 0) * a + (h[i] ?? 0) * b
    }
  }
}

/**
 * @deprecated Name kept for tests; prefers {@link overlapAddPlanar} semantics when
 * `pending` is a dedicated extension buffer. The old tail(prev)×head(next) smear
 * of *adjacent* samples is no longer used on the streaming path (#9b).
 */
export function crossfadePlanarBoundary(
  prev: Float32Array[],
  next: Float32Array[],
  fadeFrames: number,
): void {
  // Legacy unit-test helper: treat prev's tail as "pending" for next's head.
  if (fadeFrames <= 0) return
  const nch = Math.min(prev.length, next.length)
  const pending: Float32Array[] = []
  for (let c = 0; c < nch; c++) {
    const p = prev[c]
    if (!p) continue
    const frames = Math.min(fadeFrames, p.length)
    pending.push(p.subarray(p.length - frames))
  }
  overlapAddPlanar(pending, next, fadeFrames)
}

/**
 * True when streaming **mix** can run (CPU planar and/or OfflineAudioContext).
 * Intentionally true in jsdom/Node so mix unit tests exercise the CPU fallback.
 * Do **not** use this alone to pick the browser streaming *export* path — use
 * {@link isStreamingAudioEncodeSupported} for encode capability.
 */
export function isStreamingAudioAvailable(): boolean {
  return typeof OfflineAudioContext !== 'undefined' || typeof Float32Array !== 'undefined'
}

/** AAC config matching {@link encodeAudioStream} in exporter.ts. */
export const STREAM_EXPORT_AAC_BITRATE = 192_000

/**
 * Async gate for the main-thread streaming video export path: OfflineAudioContext
 * (block mix) + AudioEncoder + `isConfigSupported` for the real AAC config used
 * at encode time. Falls back to false when any piece is missing (→ server/block
 * or full offline mix + worker).
 */
export async function isStreamingAudioEncodeSupported(
  bitrate: number = STREAM_EXPORT_AAC_BITRATE,
): Promise<boolean> {
  if (typeof OfflineAudioContext === 'undefined') return false
  if (typeof AudioEncoder === 'undefined') return false
  if (typeof AudioData === 'undefined') return false
  try {
    // Mirror exporter.encodeAudioStream configure()
    const cfg: AudioEncoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
      numberOfChannels: EXPORT_AUDIO_CHANNELS,
      bitrate,
    }
    if (typeof AudioEncoder.isConfigSupported !== 'function') {
      // Older engines: constructor exists but no probe — try a no-op configure.
      return true
    }
    const support = await AudioEncoder.isConfigSupported(cfg)
    return !!support?.supported
  } catch {
    return false
  }
}

/**
 * Pure scheduling: map a clip onto a block window [blockStart, blockEnd).
 * Returns null when the clip does not contribute samples in this block.
 *
 * Mirrors OfflineAudioContext semantics used by full-timeline `renderAudioMix`:
 *   src.start(when, offset, duration) with when = clip.startSec (absolute).
 */
export function scheduleClipInBlock(
  clip: {
    startSec: number
    inPointSec: number
    outPointSec: number
    speed: number
  },
  blockStart: number,
  blockEnd: number,
  bufferDurationSec: number,
): { when: number; offset: number; duration: number } | null {
  const speed = Math.max(clip.speed, 0.01)
  const srcDur = Math.min(
    clip.outPointSec - clip.inPointSec,
    Math.max(0, bufferDurationSec - clip.inPointSec),
  )
  if (srcDur <= 0) return null
  const clipEnd = clip.startSec + srcDur / speed
  // No overlap with [blockStart, blockEnd)
  if (clipEnd <= blockStart || clip.startSec >= blockEnd) return null

  // Absolute play start within the block, relative to blockStart.
  let when = clip.startSec - blockStart
  let offset = clip.inPointSec
  let playDur = srcDur

  if (when < 0) {
    // Clip started before this block — advance into the source.
    const skipSec = -when * speed
    offset += skipSec
    playDur -= skipSec
    when = 0
  }
  // Don't play past the block end.
  const maxPlay = (blockEnd - blockStart - when) * speed
  if (playDur > maxPlay) playDur = maxPlay
  if (playDur <= 1e-9) return null
  if (offset >= bufferDurationSec) return null
  playDur = Math.min(playDur, bufferDurationSec - offset)
  if (playDur <= 1e-9) return null
  return { when, offset, duration: playDur }
}

export function audioBufferToStreamBlock(
  buf: AudioBuffer,
  startSec: number,
): StreamMixBlock {
  const ch = buf.numberOfChannels
  const channels: Float32Array[] = []
  for (let c = 0; c < ch; c++) {
    // Copy so OfflineAudioContext can GC the AudioBuffer independently.
    channels.push(buf.getChannelData(c).slice())
  }
  return {
    startSec,
    frames: buf.length,
    sampleRate: buf.sampleRate,
    numberOfChannels: ch,
    channels,
  }
}

/**
 * CPU planar mixer for one block (no OfflineAudioContext). Used when WebAudio
 * is unavailable (Node tests) and as a reference for constant-rate sources.
 * Resamples by nearest-neighbor when source rate ≠ target (good enough for tests).
 */
export function mixAudioBlockCpu(
  blockStart: number,
  blockEnd: number,
  clips: Clip[],
  tracks: Track[],
  audioBuffers: Map<string, AudioBuffer>,
  opts?: { sampleRate?: number; channels?: number; onBlockAllocated?: (bytes: number) => void },
): { channels: Float32Array[]; frames: number; sampleRate: number; numberOfChannels: number } {
  const sr = opts?.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE
  const nch = opts?.channels ?? EXPORT_AUDIO_CHANNELS
  const blockDur = Math.max(0, blockEnd - blockStart)
  const frames = Math.max(1, Math.ceil(blockDur * sr))
  opts?.onBlockAllocated?.(frames * nch * 4)
  const channels: Float32Array[] = Array.from({ length: nch }, () => new Float32Array(frames))

  for (const clip of clips) {
    if (!isExportAudibleClip(clip, tracks)) continue
    const buffer = clip.assetId ? audioBuffers.get(clip.assetId) : undefined
    if (!buffer) continue
    const sch = scheduleClipInBlock(clip, blockStart, blockEnd, buffer.duration)
    if (!sch) continue
    const speed = Math.max(clip.speed, 0.01)
    const vol = clip.volume
    const srcSr = buffer.sampleRate
    for (let i = 0; i < frames; i++) {
      const tRel = i / sr
      if (tRel < sch.when) continue
      if (tRel >= sch.when + sch.duration / speed) continue
      const srcSec = sch.offset + (tRel - sch.when) * speed
      const srcIdx = srcSec * srcSr
      const i0 = Math.floor(srcIdx)
      const frac = srcIdx - i0
      for (let c = 0; c < nch; c++) {
        const srcCh = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
        const s0 = srcCh[Math.min(i0, srcCh.length - 1)] ?? 0
        const s1 = srcCh[Math.min(i0 + 1, srcCh.length - 1)] ?? s0
        channels[c]![i]! += (s0 + (s1 - s0) * frac) * vol
      }
    }
  }
  return { channels, frames, sampleRate: sr, numberOfChannels: nch }
}

/** Mix one timeline block into an OfflineAudioContext of finite length. */
export async function mixAudioBlock(
  blockStart: number,
  blockEnd: number,
  clips: Clip[],
  tracks: Track[],
  audioBuffers: Map<string, AudioBuffer>,
  opts?: {
    sampleRate?: number
    channels?: number
    onBlockAllocated?: (bytes: number) => void
    /** Force CPU mixer (tests / no OfflineAudioContext). */
    forceCpu?: boolean
    signal?: AbortSignal
  },
): Promise<AudioBuffer | null> {
  const sr = opts?.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE
  const nch = opts?.channels ?? EXPORT_AUDIO_CHANNELS
  const blockDur = Math.max(0, blockEnd - blockStart)
  if (blockDur <= 0) return null
  const frames = Math.max(1, Math.ceil(blockDur * sr))
  opts?.onBlockAllocated?.(frames * nch * 4)

  if (opts?.forceCpu || typeof OfflineAudioContext === 'undefined') {
    const mixed = mixAudioBlockCpu(blockStart, blockEnd, clips, tracks, audioBuffers, opts)
    // Synthesize a minimal AudioBuffer-like object via Offline when possible;
    // otherwise return null and let stream path use CPU blocks directly.
    if (typeof OfflineAudioContext === 'undefined') {
      return {
        length: mixed.frames,
        sampleRate: mixed.sampleRate,
        numberOfChannels: mixed.numberOfChannels,
        duration: mixed.frames / mixed.sampleRate,
        getChannelData: (c: number) => mixed.channels[c]!,
        copyFromChannel: () => {},
        copyToChannel: () => {},
      } as AudioBuffer
    }
  }

  const octx = new OfflineAudioContext(nch, frames, sr)
  const denoiseReady = clips.some((c) => c.denoise && isExportAudibleClip(c, tracks))
    ? await raceAudioStage(loadDenoiseModule(octx), opts?.signal, 30_000, 'denoise setup')
    : false

  let scheduled = 0
  for (const clip of clips) {
    if (!isExportAudibleClip(clip, tracks)) continue
    const buffer = clip.assetId ? audioBuffers.get(clip.assetId) : undefined
    if (!buffer) continue
    const sch = scheduleClipInBlock(clip, blockStart, blockEnd, buffer.duration)
    if (!sch) continue

    const src = octx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = Math.max(clip.speed, 0.01)
    const gain = octx.createGain()
    gain.gain.value = clip.volume

    if (clip.denoise && denoiseReady) {
      try {
        const dn = createDenoiseNode(octx, clip.denoise)
        src.connect(gain).connect(dn).connect(octx.destination)
      } catch {
        src.connect(gain).connect(octx.destination)
      }
    } else {
      src.connect(gain).connect(octx.destination)
    }
    src.start(sch.when, sch.offset, sch.duration)
    scheduled++
  }

  // Silence-only blocks still render to keep encoder timeline aligned.
  void scheduled
  return raceAudioStage(octx.startRendering(), opts?.signal, 120_000, 'audio block render')
}

async function raceAudioStage<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
      ...(signal ? [new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('Export cancelled', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      })] : []),
    ])
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Pull-based async generator of mixed PCM blocks covering [0, durationSec).
 * Peak memory is independent of duration (one block at a time + source buffers).
 *
 * When denoise is active: larger default blocks (fewer worklet loads) and
 * **true overlap-add** at seams (#9b): each block (except the last) is rendered
 * past the hop into the next region; that extension is held and COLA'd with the
 * next block's head **before** the next hop is yielded — never smear already-
 * encoded tail samples of the previous hop.
 */
export async function* streamMixAudioBlocks(
  opts: StreamMixOptions,
): AsyncGenerator<StreamMixBlock, void, unknown> {
  if (!isStreamingAudioAvailable()) {
    throw new Error('Streaming audio mix unavailable on this runtime')
  }
  const {
    durationSec,
    clips,
    tracks,
    audioBuffers,
    signal,
    onBlockAllocated,
  } = opts
  const needsDenoise = streamMixNeedsDenoise(clips, tracks)
  const blockSec = streamMixBlockSec(clips, tracks, opts.blockSec)
  const sampleRate = opts.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE
  const channels = opts.channels ?? EXPORT_AUDIO_CHANNELS
  const forceCpu = typeof OfflineAudioContext === 'undefined'
  const olapSec = needsDenoise
    ? Math.max(0, opts.denoiseCrossfadeSec ?? STREAM_DENOISE_CROSSFADE_SEC)
    : 0
  const fadeFrames = olapSec > 0 ? Math.max(1, Math.round(olapSec * sampleRate)) : 0

  if (!(durationSec > 0)) return

  // Sweep only clips intersecting the current block. The old implementation
  // rescanned every timeline clip for every 1s block (O(blocks × clips)), which
  // is catastrophic for multi-hour/caption-heavy projects.
  const candidates = clips
    .filter((clip) => (
      isExportAudibleClip(clip, tracks) && !!clip.assetId && audioBuffers.has(clip.assetId)
    ))
    .sort((left, right) => left.startSec - right.startSec)
  const active = new Map<string, Clip>()
  let candidateCursor = 0

  /** Previous hop's extension into this hop (same timeline region as next head). */
  let pendingOla: Float32Array[] | null = null

  for (let start = 0; start < durationSec; start += blockSec) {
    if (signal?.aborted) {
      throw new DOMException('Audio mix cancelled', 'AbortError')
    }
    const end = Math.min(durationSec, start + blockSec)
    const hasMore = end < durationSec - 1e-12
    // Render into the next hop when we need an OLA extension for denoise seams.
    const renderEnd =
      hasMore && fadeFrames > 0
        ? Math.min(durationSec, end + olapSec)
        : end
    const coreFrames = Math.max(1, Math.round((end - start) * sampleRate))
    while (
      candidateCursor < candidates.length
      && candidates[candidateCursor]!.startSec < renderEnd
    ) {
      const clip = candidates[candidateCursor++]!
      active.set(clip.id, clip)
    }
    for (const [id, clip] of active) {
      const sourceDuration = Math.max(0, clip.outPointSec - clip.inPointSec)
      const clipEnd = clip.startSec + sourceDuration / Math.max(clip.speed, 0.01)
      if (clipEnd <= start) active.delete(id)
    }
    const blockClips = [...active.values()]

    let planar: Float32Array[]
    let totalFrames: number

    if (forceCpu) {
      const mixed = mixAudioBlockCpu(start, renderEnd, blockClips, tracks, audioBuffers, {
        sampleRate,
        channels,
        onBlockAllocated,
      })
      totalFrames = mixed.frames
      planar = mixed.channels.map((ch) => {
        const copy = new Float32Array(ch.length)
        copy.set(ch)
        return copy
      })
    } else {
      const buf = await mixAudioBlock(start, renderEnd, blockClips, tracks, audioBuffers, {
        sampleRate,
        channels,
        onBlockAllocated,
        signal,
      })
      if (!buf) continue
      const block = audioBufferToStreamBlock(buf, start)
      totalFrames = block.frames
      planar = block.channels
    }

    // COLA: pending extension from previous render covers [start, start+olap).
    if (pendingOla && fadeFrames > 0) {
      const n = Math.min(fadeFrames, planar[0]?.length ?? 0, pendingOla[0]?.length ?? 0)
      if (n > 0) overlapAddPlanar(pendingOla, planar, n)
    }

    // Stash extension [end, renderEnd) for the next hop's head OLA.
    if (hasMore && fadeFrames > 0 && totalFrames > coreFrames) {
      const ext = Math.min(fadeFrames, totalFrames - coreFrames)
      pendingOla = planar.map((ch) => {
        const slice = new Float32Array(ext)
        slice.set(ch.subarray(coreFrames, coreFrames + ext))
        return slice
      })
    } else {
      pendingOla = null
    }

    // Yield only this hop's core — never the extension (that is OLA material).
    const outFrames = Math.min(coreFrames, totalFrames)
    const outCh = planar.map((ch) => {
      const copy = new Float32Array(outFrames)
      copy.set(ch.subarray(0, outFrames))
      return copy
    })
    yield {
      startSec: start,
      frames: outFrames,
      sampleRate,
      numberOfChannels: channels,
      channels: outCh,
    }
  }
}

/** Concatenate stream blocks into PcmAudio (tests / short fixtures only). */
export async function streamMixToPcm(opts: StreamMixOptions): Promise<PcmAudio | null> {
  const hasAudible = opts.clips.some(
    (c) => isExportAudibleClip(c, opts.tracks) && !!c.assetId && opts.audioBuffers.has(c.assetId),
  )
  if (!hasAudible) return null

  const sampleRate = opts.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE
  const numberOfChannels = opts.channels ?? EXPORT_AUDIO_CHANNELS
  const totalFrames = Math.ceil(Math.max(0, opts.durationSec) * sampleRate)
  if (totalFrames <= 0) return null

  const channels: Float32Array[] = Array.from(
    { length: numberOfChannels },
    () => new Float32Array(totalFrames),
  )
  for await (const block of streamMixAudioBlocks(opts)) {
    const destOffset = Math.round(block.startSec * sampleRate)
    for (let c = 0; c < numberOfChannels; c++) {
      const src = block.channels[c] ?? block.channels[0]
      if (!src) continue
      const dest = channels[c]!
      const n = Math.min(src.length, dest.length - destOffset)
      if (n > 0) dest.set(src.subarray(0, n), destOffset)
    }
  }
  return { sampleRate, length: totalFrames, numberOfChannels, channels }
}

/**
 * Max theoretical peak for streaming path (sources + live block slabs).
 * Used by 12h synthetic tests — must not grow with duration.
 */
export function estimateStreamingPeakBytes(
  sourceBytes: number,
  blockSec: number = STREAM_BLOCK_SEC,
  sampleRate: number = EXPORT_AUDIO_SAMPLE_RATE,
  channels: number = EXPORT_AUDIO_CHANNELS,
  liveBlockCopies: number = 2,
): number {
  const blockFrames = Math.ceil(blockSec * sampleRate)
  const blockBytes = blockFrames * channels * 4 * liveBlockCopies
  return sourceBytes + blockBytes
}
