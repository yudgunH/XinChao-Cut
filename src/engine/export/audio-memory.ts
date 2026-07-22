/**
 * S3A — Browser full-timeline audio memory estimate + route decision.
 *
 * Finding F02: `renderAudioMix` builds one OfflineAudioContext for the *entire*
 * timeline duration, then `audioMixToPcm` slices full-channel copies. Peak RAM
 * therefore scales with duration × sample-rate × channels × live copies, not
 * with viewport size. This module estimates that peak *before* any
 * OfflineAudioContext construction so long form can fail-fast or route to the
 * server exporter when parity allows.
 *
 * Allocation map verified against `exporter.ts` (2026-07-10):
 *
 *   1. OfflineAudioContext(channels, frames, sampleRate)
 *      → destination / rendered AudioBuffer is planar float32
 *        bytes ≈ frames × channels × 4
 *   2. During `startRendering()`, engines keep an internal render buffer of
 *      the same order of magnitude (conservative +1 mix-sized slab).
 *   3. `audioMixToPcm`: `getChannelData(ch).slice()` → **second** full planar
 *      float32 copy (frames × channels × 4).
 *   4. Source `AudioBuffer`s already decoded for each unique audible asset
 *      (planar float32 at the buffer's own sample rate / channel count).
 *   5. Optional full-file encode after mix (audio-only export):
 *        WAV  → int16 interleaved file buffer ≈ frames × channels × 2 + 44
 *        MP3  → int16 L/R intermediate ≈ frames × channels × 2
 *      Video AAC path encodes in small frames; peak remains mix+pcm.
 *
 * Live mix-sized copies counted in the peak: (2) + (1 result) + (3) = 3.
 */

import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

// ── Constants matching exporter.ts offline mix ──────────────────────────────

/** Must match `exporter.ts` SAMPLE_RATE used by OfflineAudioContext. */
export const EXPORT_AUDIO_SAMPLE_RATE = 48_000
/** Must match `exporter.ts` AUDIO_CHANNELS. */
export const EXPORT_AUDIO_CHANNELS = 2
export const F32_BYTES = 4
export const I16_BYTES = 2

/**
 * Concurrent full-timeline float32 mix slabs at peak:
 * internal render buffer + result AudioBuffer + audioMixToPcm slice copies.
 */
export const MIX_LIVE_COPIES = 3

/**
 * Default browser peak budget: 512 MiB.
 *
 * Rationale (not a magic duration): a Chromium tab sharing an 8–16 GB machine
 * with GPU/decode already holds video frames and decoded sources. 512 MiB of
 * *additional* full-timeline audio peak leaves headroom before the multi-GB
 * OOM that a 1–2 h OfflineAudioContext (≈1.3 GB *per* f32 stereo buffer)
 * would cause. Equivalent pure-mix duration at 3 live copies with zero sources:
 *   512 MiB / (48000 × 2 × 4 × 3) ≈ 466 s ≈ 7.8 min.
 * Real projects with source buffers hit the budget earlier — by design.
 */
export const DEFAULT_BROWSER_AUDIO_PEAK_BUDGET_BYTES = 512 * 1024 * 1024

let budgetOverride: number | null = null

/** Test / advanced override. Pass null to restore the default. */
export function setBrowserAudioPeakBudgetBytes(bytes: number | null): void {
  if (bytes != null && !(bytes > 0)) {
    throw new RangeError('browser audio peak budget must be a positive number of bytes')
  }
  budgetOverride = bytes
}

export function getBrowserAudioPeakBudgetBytes(): number {
  return budgetOverride ?? DEFAULT_BROWSER_AUDIO_PEAK_BUDGET_BYTES
}

// ── Pure size helpers ───────────────────────────────────────────────────────

export function mixFrameCount(
  durationSec: number,
  sampleRate: number = EXPORT_AUDIO_SAMPLE_RATE,
): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0
  return Math.ceil(durationSec * sampleRate)
}

/** Bytes for one planar f32 mix buffer (OfflineAudioContext result size). */
export function mixBufferBytes(
  durationSec: number,
  sampleRate: number = EXPORT_AUDIO_SAMPLE_RATE,
  channels: number = EXPORT_AUDIO_CHANNELS,
): number {
  const ch = Math.max(1, Math.floor(channels) || 1)
  return mixFrameCount(durationSec, sampleRate) * ch * F32_BYTES
}

export type AudioEncodeKind = 'none' | 'wav' | 'mp3'

export interface SourceBufferEstimate {
  assetId?: string
  /** Source media duration (seconds). Used when knownBytes is absent. */
  durationSec: number
  sampleRate: number
  channels: number
  /** Exact decoded size when an AudioBuffer is already in hand. */
  knownBytes?: number
  /**
   * Encoded container size (bytes) that `ensureDecoded` transiently allocates:
   * `blob.arrayBuffer()` reads the WHOLE file into RAM before `decodeAudioData`.
   * For a multi-GB video with a short/light audio track the decoded PCM is tiny
   * yet this allocation alone can OOM the renderer (P0). Sources are decoded one
   * at a time, so only the largest container is live at the decode-phase peak.
   */
  encodedBytes?: number
}

/** Sum of unique source AudioBuffer footprints (planar f32). */
export function estimateSourceBytes(sources: SourceBufferEstimate[]): number {
  let total = 0
  for (const s of sources) {
    if (s.knownBytes != null && s.knownBytes >= 0) {
      total += s.knownBytes
      continue
    }
    const sr = s.sampleRate > 0 ? s.sampleRate : EXPORT_AUDIO_SAMPLE_RATE
    const ch = s.channels > 0 ? s.channels : EXPORT_AUDIO_CHANNELS
    total += mixFrameCount(s.durationSec, sr) * ch * F32_BYTES
  }
  return total
}

/**
 * Largest encoded container held at once during the sequential decode phase
 * (`blob.arrayBuffer()` of one source before `decodeAudioData`). Sources already
 * in hand (knownBytes) are not re-read, so they contribute nothing.
 */
export function estimateDecodeTransientBytes(sources: SourceBufferEstimate[]): number {
  let max = 0
  for (const s of sources) {
    if (s.knownBytes != null) continue
    if (s.encodedBytes != null && s.encodedBytes > max) max = s.encodedBytes
  }
  return max
}

/**
 * Extra peak from full-buffer encode of the mixed result.
 * WAV builds one int16 interleaved ArrayBuffer; MP3 materialises int16 L/R.
 */
export function estimateEncodeBytes(
  durationSec: number,
  kind: AudioEncodeKind,
  sampleRate: number = EXPORT_AUDIO_SAMPLE_RATE,
  channels: number = EXPORT_AUDIO_CHANNELS,
): number {
  const frames = mixFrameCount(durationSec, sampleRate)
  const ch = Math.max(1, Math.floor(channels) || 1)
  if (kind === 'wav') return 44 + frames * ch * I16_BYTES
  if (kind === 'mp3') return frames * ch * I16_BYTES
  return 0
}

export interface BrowserAudioPeakEstimate {
  durationSec: number
  sampleRate: number
  channels: number
  frames: number
  /** One full-timeline planar f32 mix. */
  mixBufferBytes: number
  /** mixBufferBytes × MIX_LIVE_COPIES. */
  mixLiveBytes: number
  sourceBytes: number
  encodeBytes: number
  /** Largest encoded container transiently read during decode (blob.arrayBuffer). */
  decodeTransientBytes: number
  /**
   * Peak = sources + max(decode-phase container transient, mix-phase slabs+encode).
   * The two phases don't overlap, so the peak is the larger, not their sum.
   */
  peakBytes: number
  budgetBytes: number
  overBudget: boolean
  /** Human-readable formula used (for tests / diagnostics). */
  formula: string
}

export interface EstimateBrowserAudioPeakInput {
  durationSec: number
  sources?: SourceBufferEstimate[]
  encode?: AudioEncodeKind
  sampleRate?: number
  channels?: number
  budgetBytes?: number
}

/**
 * peakBytes = sourceBytes
 *           + mixBufferBytes × MIX_LIVE_COPIES
 *           + encodeBytes
 */
export function estimateBrowserAudioPeakBytes(
  input: EstimateBrowserAudioPeakInput,
): BrowserAudioPeakEstimate {
  const sampleRate = input.sampleRate ?? EXPORT_AUDIO_SAMPLE_RATE
  const channels = input.channels ?? EXPORT_AUDIO_CHANNELS
  const encode = input.encode ?? 'none'
  const budgetBytes = input.budgetBytes ?? getBrowserAudioPeakBudgetBytes()
  const durationSec = Number.isFinite(input.durationSec) ? Math.max(0, input.durationSec) : 0

  const frames = mixFrameCount(durationSec, sampleRate)
  const oneMix = mixBufferBytes(durationSec, sampleRate, channels)
  const mixLiveBytes = oneMix * MIX_LIVE_COPIES
  const sourceBytes = estimateSourceBytes(input.sources ?? [])
  const encodeBytes = estimateEncodeBytes(durationSec, encode, sampleRate, channels)
  const decodeTransientBytes = estimateDecodeTransientBytes(input.sources ?? [])
  // Decode phase (sources + one big container transient) and mix phase (sources +
  // live mix slabs + encode) do NOT overlap — take the larger, not the sum.
  const decodePhasePeak = sourceBytes + decodeTransientBytes
  const mixPhasePeak = sourceBytes + mixLiveBytes + encodeBytes
  const peakBytes = Math.max(decodePhasePeak, mixPhasePeak)

  const formula =
    `peak = sources(${sourceBytes}) + max(decodeContainer(${decodeTransientBytes}), ` +
    `mix(${oneMix})×${MIX_LIVE_COPIES}+encode(${encodeBytes})) = ${peakBytes}; budget=${budgetBytes}`

  return {
    durationSec,
    sampleRate,
    channels,
    frames,
    mixBufferBytes: oneMix,
    mixLiveBytes,
    sourceBytes,
    encodeBytes,
    decodeTransientBytes,
    peakBytes,
    budgetBytes,
    overBudget: peakBytes > budgetBytes,
    formula,
  }
}

// ── Route decision ──────────────────────────────────────────────────────────

export type BrowserAudioRoute =
  | { action: 'browser'; estimate: BrowserAudioPeakEstimate }
  | { action: 'server'; estimate: BrowserAudioPeakEstimate; reason: string }
  | { action: 'block'; estimate: BrowserAudioPeakEstimate; message: string }

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function formatDurationSec(sec: number): string {
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} h`
  if (sec >= 60) return `${(sec / 60).toFixed(1)} min`
  return `${sec.toFixed(1)} s`
}

export interface DecideBrowserAudioRouteInput {
  estimate: BrowserAudioPeakEstimate
  /** Backend /health reports export capability. */
  serverAvailable: boolean
  /**
   * True when server export is allowed for this timeline (no strict parity
   * gaps, or user opted into approximate server). Audio-file export cannot
   * use the server path (server produces MP4 video, not standalone mp3/wav).
   */
  serverParityOk: boolean
  /** video = full editor export; audio-file = mix → mp3/wav download. */
  purpose: 'video' | 'audio-file'
  /**
   * S3B: when true, browser can mix/encode in bounded blocks and may accept
   * over-budget full-timeline offline peaks (streaming avoids that allocation).
   */
  streamingAvailable?: boolean
}

export function decideBrowserAudioRoute(
  input: DecideBrowserAudioRouteInput,
): BrowserAudioRoute {
  const {
    estimate,
    serverAvailable,
    serverParityOk,
    purpose,
    streamingAvailable = false,
  } = input
  if (!estimate.overBudget) {
    return { action: 'browser', estimate }
  }

  const peak = formatBytes(estimate.peakBytes)
  const budget = formatBytes(estimate.budgetBytes)
  const dur = formatDurationSec(estimate.durationSec)

  // S3B: streaming video export mixes in bounded blocks, so the multi-slab
  // `mixLiveBytes` term is never held at once. BUT every audible source is still
  // fully decoded up front (ensureDecoded → decodeAudioData of the whole file),
  // so `sourceBytes` remains a live allocation. Only take the browser path when
  // that residual fits the budget — otherwise source decode alone would OOM the
  // renderer (P0 #2). The real fix (chunked AudioDecoder / demux ring buffer)
  // removes this term; until then we guard on it instead of ignoring the budget.
  if (streamingAvailable && purpose === 'video') {
    // Streaming bounds the mix slabs, but every source is still fully decoded up
    // front — both the decoded PCM (sourceBytes) AND the transient container read
    // (blob.arrayBuffer of the largest source) are live. Only take the browser
    // path when that residual fits; a multi-GB video container alone can OOM.
    const streamingPeak =
      estimate.sourceBytes + Math.max(estimate.decodeTransientBytes, estimate.encodeBytes)
    if (streamingPeak <= estimate.budgetBytes) {
      return { action: 'browser', estimate }
    }
    // else: fall through to server / block — sources / container don't fit.
  }

  if (purpose === 'audio-file') {
    // Server exporter only produces video (MP4). No silent quality drop / sample-rate change.
    return {
      action: 'block',
      estimate,
      message:
        `Browser audio export needs ~${peak} peak RAM for a ${dur} timeline ` +
        `(budget ${budget}). Standalone MP3/WAV cannot fall back to the server exporter. ` +
        `Shorten the timeline, export a shorter range, or use a runtime with OfflineAudioContext ` +
        `streaming mix (S3B).`,
    }
  }

  // Video path without streaming: prefer server when capability + parity both hold.
  if (serverAvailable && serverParityOk) {
    return {
      action: 'server',
      estimate,
      reason:
        `Browser audio mix would peak ~${peak} (budget ${budget}) for ${dur}; ` +
        `routing to server FFmpeg export (no full-timeline OfflineAudioContext).`,
    }
  }

  if (serverAvailable && !serverParityOk) {
    return {
      action: 'block',
      estimate,
      message:
        `Browser audio mix would peak ~${peak} (budget ${budget}) for ${dur}, ` +
        `but this timeline uses features the server exporter cannot match pixel-exactly. ` +
        `Options: enable “approximate server export”, remove unsupported effects/captions, ` +
        `or shorten the timeline. Refusing to start a multi-GB OfflineAudioContext.`,
    }
  }

  return {
    action: 'block',
    estimate,
    message:
      `Browser audio mix would peak ~${peak} (budget ${budget}) for ${dur}, ` +
      `and the backend export service is offline. Start the XinChao-Cut backend to use ` +
      `server export, or shorten the timeline. Refusing to allocate OfflineAudioContext.`,
  }
}

// ── Timeline helpers ────────────────────────────────────────────────────────

/** Match ExportDialog / renderAudioMix audible filter. */
export function isExportAudibleClip(clip: Clip, tracks: Track[]): boolean {
  if (!clip.assetId || clip.muted || (clip.volume ?? 1) <= 0) return false
  const track = tracks.find((t) => t.id === clip.trackId)
  if (!track || track.muted || track.hidden) return false
  return track.kind === 'audio' || track.kind === 'video'
}

export function collectAudibleSourceEstimates(
  clips: Clip[],
  tracks: Track[],
  assets: MediaAsset[],
  decoded?: Map<string, { length: number; numberOfChannels: number; sampleRate: number }>,
): SourceBufferEstimate[] {
  const need = new Set<string>()
  for (const c of clips) {
    if (c.assetId && isExportAudibleClip(c, tracks)) need.add(c.assetId)
  }
  const out: SourceBufferEstimate[] = []
  for (const asset of assets) {
    if (!need.has(asset.id)) continue
    if (asset.kind !== 'audio' && asset.kind !== 'video') continue
    const buf = decoded?.get(asset.id)
    if (buf) {
      out.push({
        assetId: asset.id,
        durationSec: buf.length / buf.sampleRate,
        sampleRate: buf.sampleRate,
        channels: buf.numberOfChannels,
        knownBytes: buf.length * buf.numberOfChannels * F32_BYTES,
      })
    } else {
      out.push({
        assetId: asset.id,
        durationSec: asset.durationSec || 0,
        sampleRate: asset.sampleRate || EXPORT_AUDIO_SAMPLE_RATE,
        channels: asset.channels || (asset.kind === 'audio' ? 2 : 2),
        // The whole container is read into RAM by ensureDecoded before decode —
        // gate on it so a huge video with light audio can't slip past (P0).
        encodedBytes: asset.sizeBytes || undefined,
      })
    }
  }
  return out
}

export class BrowserAudioMemoryError extends Error {
  readonly estimate: BrowserAudioPeakEstimate
  readonly code = 'BROWSER_AUDIO_MEMORY' as const

  constructor(message: string, estimate: BrowserAudioPeakEstimate) {
    super(message)
    this.name = 'BrowserAudioMemoryError'
    this.estimate = estimate
  }
}

/**
 * Throw before OfflineAudioContext when the peak would exceed the budget.
 * Used as a hard safety net inside `renderAudioMix` / `exportVideo`.
 */
export function assertBrowserAudioWithinBudget(
  durationSec: number,
  sources: SourceBufferEstimate[],
  encode: AudioEncodeKind = 'none',
): BrowserAudioPeakEstimate {
  const estimate = estimateBrowserAudioPeakBytes({ durationSec, sources, encode })
  if (estimate.overBudget) {
    throw new BrowserAudioMemoryError(
      `Browser full-timeline audio mix would peak ~${formatBytes(estimate.peakBytes)} ` +
        `(budget ${formatBytes(estimate.budgetBytes)}) for ${formatDurationSec(durationSec)}. ` +
        `Refusing OfflineAudioContext allocation.`,
      estimate,
    )
  }
  return estimate
}
