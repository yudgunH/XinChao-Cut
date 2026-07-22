import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer'

import {
  ActiveClipIndex,
  adjustToFilter,
  clipEffectiveDuration,
  clipSourceSec,
  isAdjustNeutral,
  makeDefaultTransform,
  resolveClipTransformAt,
  resolveClipOpacityAt,
  canvasFilterString,
} from '@engine/timeline'
import type { BlurStickerData, Clip, ClipCanvasFill, ClipTransform, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

import { captionVisualStateKey, drawTextClip } from '@engine/timeline/draw-caption'
import { BLUR_REF_HEIGHT } from '@engine/timeline/types'
import {
  fallbackCaptionFamiliesForText,
  registerCaptionFontFaces,
} from '@engine/text/font-catalog'
import { getFxBuffer, releaseFxBuffers } from '@engine/composition/fx-buffer'
import {
  buildRenderPlan,
  CAPTION_OVERLAY_CLIP_ID,
  resolveRenderPlanDraws,
  type RenderPlanDrawDescriptor,
  type RenderPlanSourceInfo,
} from '@engine/composition/render-plan'
import { yieldToMacrotask } from '@engine/core/schedule'

import { createDenoiseNode, loadDenoiseModule } from '@engine/audio/denoise'
import {
  cleanupStaleExportScratch,
  createWritable,
  readBlob,
  deleteBlob,
} from '@engine/persistence/opfs'

import { GpuCompositor } from '@engine/preview/gpu-compositor'
import {
  createHtmlVideoFrameReader,
  createSharedVideoByteRangeCache,
  createVideoSampleIndex,
  createVideoFrameReader,
  frameReaderStats,
  type VideoByteSource,
  type VideoFrameReader,
  type VideoReaderSource,
  type VideoSampleIndex,
} from './frame-reader'
import { ExportReaderPool, sourceMappingKey } from './reader-pool'
import {
  assertSafeInMemoryBrowserOutput,
  assertBrowserStorageHeadroom,
  BrowserStorageHeadroomError,
  estimateBrowserOutputBytes,
  getBrowserStorageSnapshot,
  type BrowserStorageSnapshot,
} from './browser-admission'
import {
  BackendMp4StreamSink,
  type BrowserDirectOutput,
} from './direct-output'
import {
  EXPORT_AUDIO_CHANNELS,
  EXPORT_AUDIO_SAMPLE_RATE,
  assertBrowserAudioWithinBudget,
  isExportAudibleClip,
  type SourceBufferEstimate,
} from './audio-memory'
import {
  isStreamingAudioEncodeSupported,
  streamMixAudioBlocks,
  type StreamMixBlock,
} from './audio-stream-mix'
import { exportQualityDefinition, type ExportQualityProfile } from './quality'
import {
  analyzeAudioBlocks,
  masterAudioBlocks,
  masterPcmAudioInPlace,
  type AudioMasteringPreset,
} from './audio-mastering'

/** Pre-mixed stereo PCM transferred from the main thread when running in a
 *  worker — OfflineAudioContext is main-thread-only, so audio is mixed there
 *  and the raw channel Float32Arrays (transferable) are sent to the worker. */
export interface PcmAudio {
  sampleRate: number
  length: number
  numberOfChannels: number
  channels: Float32Array[]
}

/** Extract an AudioBuffer's channel data into a transferable PcmAudio. */
export function audioMixToPcm(mix: AudioBuffer): PcmAudio {
  const channels: Float32Array[] = []
  for (let ch = 0; ch < mix.numberOfChannels; ch++) {
    channels.push(mix.getChannelData(ch).slice())
  }
  return { sampleRate: mix.sampleRate, length: mix.length, numberOfChannels: mix.numberOfChannels, channels }
}

/** Texture-cache key for one media draw. The first occurrence of an asset in a
 *  frame keeps the bare assetId (so the GPU compositor caches one texture per
 *  asset in the common case — bounded VRAM); the 2nd+ occurrence (same asset
 *  used by another clip in the SAME frame, e.g. PiP/duplicate at a different
 *  source time) gets a distinct suffixed key so the draws don't share a texture
 *  and overwrite each other. See GpuCompositor.ensureTexture. */
export { getExportMediaRect, mediaDrawCacheKey } from '@engine/composition/render-plan'

/** Force an IDR at visual edit boundaries while retaining a bounded GOP. */
export function buildSceneKeyframeFrames(
  clips: Clip[],
  tracks: Track[],
  fps: number,
  totalFrames: number,
): Set<number> {
  const visibleVideoTracks = new Set(
    tracks
      .filter((track) => track.kind === 'video' && !track.hidden)
      .map((track) => track.id),
  )
  const frames = new Set<number>([0])
  for (const clip of clips) {
    // `muted` controls only the clip's audio contribution. A muted video clip
    // is still visible and therefore still creates a visual edit boundary.
    if (!clip.assetId || !visibleVideoTracks.has(clip.trackId)) continue
    const start = Math.round(Math.max(0, clip.startSec) * fps)
    const end = Math.round(Math.max(0, clip.startSec + clipEffectiveDuration(clip)) * fps)
    if (start > 0 && start < totalFrames) frames.add(start)
    if (end > 0 && end < totalFrames) frames.add(end)
  }
  return frames
}

/**
 * True when two adjacent timeline clips cannot continue through the current
 * decoder cursor cheaply. Small same-asset forward gaps are normally already
 * covered by decode-ahead; backwards or large jumps require a keyframe seek and
 * are worth predecoding before the cut becomes active. Forward same-asset
 * jumps are admitted only when the pool already has an inactive warm reader;
 * they must never create another decoder just for lookahead.
 */
export function shouldPredecodeAdjacentCut(current: Clip, next: Clip): boolean {
  if (!current.assetId || !next.assetId) return false
  if (current.assetId !== next.assetId) return true
  const sourceGapSec = next.inPointSec - current.outPointSec
  // Decode-ahead absorbs small forward gaps. A larger forward jump may require
  // a keyframe seek, but the caller uses allowCreate:false for it so admission
  // is free when no inactive warm reader is available.
  return sourceGapSec < -1 / 60 || sourceGapSec > 2
}

/**
 * Resolve on the encoder's next `dequeue` event (encodeQueueSize decreased),
 * or after a short fallback tick for runtimes that don't fire it. Never
 * rejects — callers re-check queue size, abort, and stall state per iteration.
 */
function waitForEncoderDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      encoder.removeEventListener('dequeue', finish)
      resolve()
    }
    const timer = setTimeout(finish, 50)
    encoder.addEventListener('dequeue', finish)
  })
}

// Encoder backpressure hysteresis. Two failure modes bracket the sweet spot,
// both measured on a 608x1080 export:
//  - Hold the queue at a single mark (drain to ≤12 whenever it exceeds 12) and
//    the loop blocks for one `dequeue`-event round-trip (~2ms media-process
//    latency) on EVERY frame → capped at the event rate (~110fps, drain 2.2ms).
//  - Let it fill deep (HIGH=30) and the encoder keeps ~30 in-flight frames,
//    which contends with the video decoder for the GPU → decode balloons 6→10ms
//    and fps DROPS to ~85 even though the encoder now keeps up (drain 1.4ms).
// So keep the queue shallow (bounded near the old cap so decode stays fast) but
// use hysteresis so the per-frame event latency is amortized over ~(HIGH-LOW)
// streamed frames instead of paid every frame.
const ENCODER_QUEUE_HIGH = 12
const ENCODER_QUEUE_LOW = 6

/** OPFS scratch file the export muxer streams into (overwritten per export). */
const EXPORT_TMP_KEY = '__export-tmp.mp4'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
  qualityProfile?: ExportQualityProfile
  audioBitrateKbps?: number
  audioMastering?: AudioMasteringPreset
  /** Requested output codec. Unsupported browser/server encoders fall back to
   * H.264 and report the actual codec rather than failing a long render late. */
  videoCodec?: ExportVideoCodec
  /** HDR10 is server-only until the browser compositor is end-to-end 10-bit. */
  dynamicRange?: ExportDynamicRange
  /** R&D path: encode overlay-free WebGPU frames without the 2D canvas blit. */
  browserZeroCopy?: 'off' | 'auto'
}

export type ExportVideoCodec = 'h264' | 'hevc' | 'av1'
export type ExportDynamicRange = 'sdr' | 'hdr10'

export interface ResolutionTier {
  height: number
  fps: number
  videoBitrateKbps: number
}

/** Resolution tiers (height-based); width is derived from the project aspect ratio. */
export const EXPORT_TIERS: Record<string, ResolutionTier> = {
  '720p': { height: 720, fps: 30, videoBitrateKbps: 5000 },
  '1080p': { height: 1080, fps: 30, videoBitrateKbps: 8000 },
  '1080p60': { height: 1080, fps: 60, videoBitrateKbps: 12000 },
  '4K': { height: 2160, fps: 30, videoBitrateKbps: 35000 },
}

// Shared with audio-memory.ts so S3A estimates match the real OfflineAudioContext.
const SAMPLE_RATE = EXPORT_AUDIO_SAMPLE_RATE
const AUDIO_CHANNELS = EXPORT_AUDIO_CHANNELS
const MIN_AXIS_SCALE = 0.05

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ExportProgress {
  frame: number
  total: number
  phase: 'audio' | 'encoding' | 'muxing' | 'done'
  /** Actual rendered video frames, retained when Hybrid progress uses 0..100. */
  renderedFrame?: number
  renderedTotal?: number
  seekFallbackAsset?: string
  zeroCopy?: BrowserExportResult['zeroCopy']
  videoCodec?: ExportVideoCodec
}

export type OnProgress = (p: ExportProgress) => void

export interface DesktopVideoSourceReader {
  size(sourcePath: string): Promise<number>
  read(sourcePath: string, start: number, end: number): Promise<ArrayBuffer>
}

export class DesktopVideoSourceReadError extends Error {
  override name = 'DesktopVideoSourceReadError'
}

export class BrowserVideoUnsupportedError extends Error {
  override name = 'BrowserVideoUnsupportedError'
}

function errorChainSome(error: unknown, predicate: (value: unknown) => boolean): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (current != null && !seen.has(current)) {
    if (predicate(current)) return true
    seen.add(current)
    current = typeof current === 'object' && current && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return false
}

export function isBrowserVideoUnsupportedError(error: unknown): boolean {
  return errorChainSome(error, (value) =>
    value instanceof BrowserVideoUnsupportedError ||
    (typeof value === 'object' && value !== null &&
      'name' in value && value.name === 'NotSupportedError'),
  )
}

function isDesktopVideoSourceReadError(error: unknown): boolean {
  return errorChainSome(error, (value) => value instanceof DesktopVideoSourceReadError)
}

export interface BrowserExportResult {
  blob: Blob | null
  savedPath?: string
  /** Codec actually written. May be h264 when the requested codec was not
   * supported by the local WebCodecs implementation. */
  videoCodec: ExportVideoCodec
  zeroCopy: 'off' | 'active' | 'fallback' | 'ineligible'
}

// H.264 codec strings to try, best quality first (all level 5.2 = 0x34, which
// covers every export tier up to 4K). Baseline (last) maximises decoder
// compatibility but lacks CABAC/B-frames AND is unsupported for *encoding* by
// many GPUs — offering High/Main first is what actually unlocks hardware encode
// on those machines instead of silently falling back to software.
const AVC_CODECS = [
  'avc1.640034', // High profile
  'avc1.4d0034', // Main profile
  'avc1.420034', // Baseline profile (last-resort fallback)
] as const

/**
 * Pick a supported H.264 encoder config. Prefers hardware acceleration, and
 * within that the highest-quality profile the machine can encode. Tries every
 * profile under prefer-hardware before dropping to software, so a GPU that
 * can't encode Baseline still gets used via High/Main. Always falls back to a
 * Baseline config so export never fails outright.
 */
const WEB_CODECS: Record<ExportVideoCodec, readonly string[]> = {
  h264: AVC_CODECS,
  // Main profile, level 5.1. `hvc1` keeps parameter sets in the MP4 sample
  // description; `hev1` is retained for WebCodecs implementations that expose
  // only that sample-entry form.
  hevc: ['hvc1.1.6.L153.B0', 'hev1.1.6.L153.B0'],
  // Main profile, level 6.0/5.1, 8-bit. The higher level is required for 4K60;
  // lower-level fallback covers conservative drivers at <=4K30.
  av1: ['av01.0.16M.08', 'av01.0.13M.08'],
}

export interface PickedVideoConfig {
  config: VideoEncoderConfig
  codec: ExportVideoCodec
  fellBack: boolean
}

export function muxerCodec(codec: ExportVideoCodec): 'avc' | 'hevc' | 'av1' {
  return codec === 'h264' ? 'avc' : codec
}

/**
 * A new encoder session may only replace the current one before the muxer has
 * received its first sample.  Once any sample exists, a replacement session
 * may emit a different decoder configuration/SPS/PPS even when the requested
 * WebCodecs config is identical.
 */
export function canRestartVideoEncoder(encodedChunks: number): boolean {
  return encodedChunks === 0
}

/**
 * The experimental direct-GPU path must be verified on the first output frame.
 * Starting it later would require restarting an already-populated MP4 if the
 * real encoder rejects the GPU surface after the sacrificial probe.
 */
export function canStartZeroCopy(frameIndex: number, alreadyVerified: boolean): boolean {
  return alreadyVerified || frameIndex === 0
}

export async function probeBrowserVideoCodecs(
  base: Omit<VideoEncoderConfig, 'codec'>,
): Promise<Record<ExportVideoCodec, boolean>> {
  const result: Record<ExportVideoCodec, boolean> = { h264: false, hevc: false, av1: false }
  if (typeof VideoEncoder === 'undefined') return result
  for (const family of Object.keys(WEB_CODECS) as ExportVideoCodec[]) {
    for (const codec of WEB_CODECS[family]) {
      try {
        if ((await VideoEncoder.isConfigSupported({ ...base, codec })).supported) {
          result[family] = true
          break
        }
      } catch {
        // Try the next codec string; support varies by WebView2/driver.
      }
    }
  }
  return result
}

export async function pickVideoConfig(
  base: Omit<VideoEncoderConfig, 'codec'>,
  requested: ExportVideoCodec,
): Promise<PickedVideoConfig> {
  const variants: Array<Omit<VideoEncoderConfig, 'codec'>> = [base]
  if (base.bitrateMode) {
    const compatible = { ...base }
    delete compatible.bitrateMode
    variants.push(compatible)
  }
  const families: ExportVideoCodec[] = requested === 'h264'
    ? ['h264']
    : [requested, 'h264']
  for (const family of families) {
    for (const hw of ['prefer-hardware', 'no-preference'] as const) {
      for (const variant of variants) {
        for (const codec of WEB_CODECS[family]) {
          const cfg: VideoEncoderConfig = { ...variant, codec, hardwareAcceleration: hw }
          try {
            const support = await VideoEncoder.isConfigSupported(cfg)
            if (support.supported) {
              return { config: support.config ?? cfg, codec: family, fellBack: family !== requested }
            }
          } catch {
            /* try next */
          }
        }
      }
    }
  }
  // Nothing reported support — hand back a Baseline config and let configure()
  // surface a meaningful error if the machine truly can't encode H.264.
  return {
    config: { ...variants[variants.length - 1]!, codec: 'avc1.420034' },
    codec: 'h264',
    fellBack: requested !== 'h264',
  }
}

/** Sacrificial one-frame encode used by the R&D zero-copy path.  It exercises
 * the exact WebGPU canvas and encoder config before the real muxer receives a
 * byte. A timeout/driver error simply disables zero-copy for this export. */
export async function probeGpuZeroCopy(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  config: VideoEncoderConfig,
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return false
  let outputSeen = false
  let fatal: unknown = null
  let probe: VideoEncoder | null = null
  try {
    probe = new VideoEncoder({
      output: () => { outputSeen = true },
      error: (error) => { fatal = error },
    })
    probe.configure(config)
    const frame = new VideoFrame(canvas, { timestamp: 0, duration: 1_000_000 })
    try {
      probe.encode(frame, { keyFrame: true })
    } finally {
      frame.close()
    }
    await withDeadline(probe.flush(), 5_000, 'WebGPU zero-copy probe')
    return outputSeen && !fatal
  } catch {
    return false
  } finally {
    try { probe?.close() } catch { /* failed probe */ }
  }
}

/** Seek a <video> and wait for 'seeked'. Hard deadline so a broken file cannot
 *  hang the main-thread export fallback forever (same rule as withDeadline). */
function seekVideoToSec(
  el: HTMLVideoElement,
  sec: number,
  label = 'video seek',
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    el.addEventListener('seeked', onSeeked)
    try {
      el.currentTime = sec
    } catch (e) {
      settled = true
      clearTimeout(timer)
      el.removeEventListener('seeked', onSeeked)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Anything the 2D compositor can drawImage(). Includes a plain canvas because
 *  VideoFrames are rasterized to one before any ctx.filter is applied (Chromium
 *  renders a filtered VideoFrame draw as a green frame — see rasterizeForFilter). */
type DrawSource =
  | HTMLVideoElement | HTMLImageElement | VideoFrame | ImageBitmap
  | HTMLCanvasElement | OffscreenCanvas

function drawSrcW(src: DrawSource, fallback: number): number {
  if (src instanceof HTMLVideoElement) return src.videoWidth || fallback
  if (src instanceof HTMLImageElement) return src.naturalWidth || fallback
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return src.displayWidth || fallback
  // ImageBitmap and canvases both expose .width.
  return (src as ImageBitmap).width || fallback
}

function drawSrcH(src: DrawSource, fallback: number): number {
  if (src instanceof HTMLVideoElement) return src.videoHeight || fallback
  if (src instanceof HTMLImageElement) return src.naturalHeight || fallback
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return src.displayHeight || fallback
  return (src as ImageBitmap).height || fallback
}

function fitDrawCtx(
  ctx: CanvasRenderingContext2D,
  src: DrawSource,
  cw: number,
  ch: number,
  transform: ClipTransform,
) {
  // Mirrors PreviewCanvas.drawMedia exactly: crop shrinks the fitted source and
  // selects the source sub-rect; flip mirrors around the clip centre. This 2D
  // path runs whenever the GPU compositor is unavailable AND for every frame of
  // a project with a blur canvasFill — dropping crop/flip here silently
  // uncropped/unflipped those clips relative to the preview.
  const t = { ...makeDefaultTransform(), ...transform }
  const sw = drawSrcW(src, cw)
  const sh = drawSrcH(src, ch)
  const crop = t.crop
  const sx = crop ? sw * crop.l : 0
  const sy = crop ? sh * crop.t : 0
  const sWidth = crop ? sw * Math.max(0.02, 1 - crop.l - crop.r) : sw
  const sHeight = crop ? sh * Math.max(0.02, 1 - crop.t - crop.b) : sh
  const scale = Math.min(cw / sWidth, ch / sHeight) * Math.max(0.05, t.scale)
  const dw = sWidth * scale * Math.max(MIN_AXIS_SCALE, t.scaleX)
  const dh = sHeight * scale * Math.max(MIN_AXIS_SCALE, t.scaleY)
  ctx.save()
  ctx.translate(t.x * cw, t.y * ch)
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180)
  if (t.flipH || t.flipV) ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1)
  ctx.drawImage(src, sx, sy, sWidth, sHeight, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
}

function drawCanvasFillCtx(
  ctx: CanvasRenderingContext2D,
  src: DrawSource,
  cw: number,
  ch: number,
  transform: ClipTransform,
  canvasFill: ClipCanvasFill | undefined,
  adjustFilter: string,
): void {
  if (canvasFill?.mode !== 'blur') return
  const t = { ...makeDefaultTransform(), ...transform }
  const sw = drawSrcW(src, cw)
  const sh = drawSrcH(src, ch)
  const crop = t.crop
  const sx = crop ? sw * crop.l : 0
  const sy = crop ? sh * crop.t : 0
  const sWidth = crop ? sw * Math.max(0.02, 1 - crop.l - crop.r) : sw
  const sHeight = crop ? sh * Math.max(0.02, 1 - crop.t - crop.b) : sh
  const coverScale = Math.max(cw / sWidth, ch / sHeight) * Math.max(1, canvasFill.scale ?? 1.08)
  const dw = sWidth * coverScale
  const dh = sHeight * coverScale
  // blurPx is authored on the 720p preview — scale to this frame's resolution.
  const blur = Math.max(0, Math.min(80, canvasFill.blurPx ?? 34)) * (ch / BLUR_REF_HEIGHT)
  const opacity = Math.max(0, Math.min(1, canvasFill.opacity ?? 1))

  ctx.save()
  ctx.globalAlpha *= opacity
  ctx.filter = [adjustFilter === 'none' ? '' : adjustFilter, `blur(${blur}px)`, 'brightness(0.82)']
    .filter(Boolean)
    .join(' ')
  ctx.drawImage(src, sx, sy, sWidth, sHeight, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
  ctx.restore()
}

function getBlurStickerRect(fx: BlurStickerData, cw: number, ch: number): Rect {
  const w = Math.max(1, fx.w * cw)
  const h = Math.max(1, fx.h * ch)
  return { x: fx.x * cw - w / 2, y: fx.y * ch - h / 2, w, h }
}

function clampRect(rect: Rect, cw: number, ch: number): Rect {
  const x = Math.max(0, Math.min(cw, rect.x))
  const y = Math.max(0, Math.min(ch, rect.y))
  const right = Math.max(x, Math.min(cw, rect.x + rect.w))
  const bottom = Math.max(y, Math.min(ch, rect.y + rect.h))
  return { x, y, w: right - x, h: bottom - y }
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

/** Full-frame look filter (matches PreviewCanvas.drawFilterFx): snapshot then
 *  redraw through the CSS filter so preview and browser export grade the same. */
function drawFilterFx(ctx: CanvasRenderingContext2D, filterStr: string, cw: number, ch: number): void {
  if (!filterStr || cw < 1 || ch < 1) return
  const bctx = getFxBuffer('export-filter', cw, ch)
  if (!bctx) return
  bctx.clearRect(0, 0, cw, ch)
  bctx.drawImage(ctx.canvas, 0, 0, cw, ch, 0, 0, cw, ch)
  ctx.save()
  ctx.filter = filterStr
  ctx.drawImage(bctx.canvas, 0, 0, cw, ch)
  ctx.filter = 'none'
  ctx.restore()
}

function drawBlurSticker(
  ctx: CanvasRenderingContext2D,
  fx: BlurStickerData,
  cw: number,
  ch: number,
): void {
  const rect = clampRect(getBlurStickerRect(fx, cw, ch), cw, ch)
  if (rect.w < 1 || rect.h < 1) return
  // blurPx/radius are authored on the 720p preview — scale to this resolution.
  const blur = Math.max(0, Math.min(80, fx.blurPx)) * (ch / BLUR_REF_HEIGHT)
  const pad = Math.ceil(blur * 2)
  const sx = Math.max(0, Math.floor(rect.x - pad))
  const sy = Math.max(0, Math.floor(rect.y - pad))
  const sw = Math.min(cw - sx, Math.ceil(rect.w + pad * 2))
  const sh = Math.min(ch - sy, Math.ceil(rect.h + pad * 2))
  if (sw <= 0 || sh <= 0) return

  const bctx = getFxBuffer('export-blur', sw, sh)
  if (!bctx) return
  bctx.clearRect(0, 0, sw, sh)
  bctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh)

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, Math.max(0, fx.radius))
  ctx.clip()
  ctx.filter = `blur(${blur}px)`
  ctx.drawImage(bctx.canvas, sx, sy, sw, sh)
  ctx.filter = 'none'
  ctx.restore()
}

async function loadTextClipFonts(clips: Clip[]): Promise<void> {
  // Works on both main thread (document.fonts) and in workers (self.fonts).
  // Fonts pre-loaded on the main thread are cached by the browser and resolve
  // quickly when self.fonts.load() is called from within the worker.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fontSet: FontFaceSet | undefined = typeof document !== 'undefined' ? document.fonts : (self as any).fonts
  if (!fontSet) return
  const seen = new Set<string>()
  const requests: Promise<unknown>[] = []
  for (const clip of clips) {
    const td = clip.textData
    if (!td) continue
    const key = `${td.fontWeight}|${td.fontFamily}`
    if (seen.has(key)) continue
    seen.add(key)
    requests.push(fontSet.load(`${td.fontWeight} 64px ${td.fontFamily}`, td.content || 'Hg'))
  }
  await Promise.all(requests)
}

/** Build source estimates from already-decoded buffers (exact knownBytes). */
function sourceEstimatesFromBuffers(
  audioBuffers: Map<string, AudioBuffer>,
  assetIds: Iterable<string>,
): SourceBufferEstimate[] {
  const out: SourceBufferEstimate[] = []
  for (const id of assetIds) {
    const buf = audioBuffers.get(id)
    if (!buf) continue
    out.push({
      assetId: id,
      durationSec: buf.duration,
      sampleRate: buf.sampleRate,
      channels: buf.numberOfChannels,
      knownBytes: buf.length * buf.numberOfChannels * 4,
    })
  }
  return out
}

/** Mix all audible clips into a single stereo AudioBuffer via offline rendering.
 *
 *  S3A: refuses to construct OfflineAudioContext when the full-timeline peak
 *  would exceed the browser audio budget (see audio-memory.ts). Callers that
 *  can route to server export should decide *before* decoding sources. */
export async function renderAudioMix(
  durationSec: number,
  clips: Clip[],
  tracks: Track[],
  audioBuffers: Map<string, AudioBuffer>,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const audible = clips.filter((c) => {
    if (!c.assetId || c.muted || !audioBuffers.has(c.assetId)) return false
    const track = tracks.find((t) => t.id === c.trackId)
    return !!track && !track.muted && !track.hidden && (track.kind === 'audio' || track.kind === 'video')
  })
  if (audible.length === 0 || durationSec <= 0) return null

  // Hard gate before any full-timeline OfflineAudioContext allocation (F02 / S3A).
  const usedIds = new Set(audible.map((c) => c.assetId!).filter(Boolean))
  assertBrowserAudioWithinBudget(
    durationSec,
    sourceEstimatesFromBuffers(audioBuffers, usedIds),
    'none',
  )

  const length = Math.ceil(durationSec * SAMPLE_RATE)
  const octx = new OfflineAudioContext(AUDIO_CHANNELS, length, SAMPLE_RATE)

  // Load the denoise worklet up front if any clip needs it (offline contexts
  // require the module registered before rendering). Keeps mp3/wav export
  // consistent with live preview.
  const denoiseReady = audible.some((c) => c.denoise)
    ? await withAbortAndDeadline(loadDenoiseModule(octx), signal, 30_000, 'denoise setup')
    : false

  for (const clip of audible) {
    const buffer = audioBuffers.get(clip.assetId!)
    if (!buffer) continue
    const speed = Math.max(clip.speed, 0.01)

    const src = octx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = speed

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

    const offset = clip.inPointSec
    const dur = Math.min(clip.outPointSec - clip.inPointSec, Math.max(0, buffer.duration - offset))
    if (dur <= 0) continue
    src.start(clip.startSec, offset, dur)
  }

  const renderDeadlineMs = Math.max(
    120_000,
    Math.min(30 * 60_000, Math.ceil(durationSec * 2_000)),
  )
  return withAbortAndDeadline(
    octx.startRendering(),
    signal,
    renderDeadlineMs,
    'offline audio render',
  )
}

/** Encode pre-mixed PCM (PcmAudio) to AAC and feed chunks to the muxer.
 *  Works on both main thread and in Web Workers (AudioEncoder is available in both). */
/** Race a promise against a wall-clock deadline — every awaited stage of the
 *  export pipeline goes through this so NOTHING can hang the export silently
 *  at "100%"; a stuck stage fails with a message naming itself instead. */
async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return withAbortAndDeadline(p, undefined, ms, label)
}

/** Abort an incremental OPFS writer, then remove its visible target even when
 * abort rejects. Dependency injection keeps the cleanup contract unit-testable. */
export async function discardExportScratch(
  writable: Pick<FileSystemWritableFileStream, 'abort'>,
  scratchKey: string,
  remove: (key: string) => Promise<void> = deleteBlob,
): Promise<void> {
  await withDeadline(writable.abort(), 5_000, 'OPFS abort').catch(() => {})
  await withDeadline(remove(scratchKey), 5_000, 'OPFS scratch cleanup').catch(() => {})
}

async function withAbortAndDeadline<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
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

async function encodeAudio(
  audio: PcmAudio,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  muxer: any,
  bitrate: number,
  waitForOutput?: () => Promise<void>,
): Promise<void> {
  await encodeAudioStream(
    (async function* () {
      yield {
        startSec: 0,
        frames: audio.length,
        sampleRate: audio.sampleRate,
        numberOfChannels: audio.numberOfChannels,
        channels: audio.channels,
      }
    })(),
    muxer,
    () => false,
    bitrate,
    waitForOutput,
  )
}

/**
 * S3B: encode mixed PCM blocks as they arrive — no full-timeline planar buffer.
 * Backpressure: awaits encoder queue drain when backlog grows; abort stops loop.
 */
async function encodeAudioStream(
  blocks: AsyncIterable<{
    frames: number
    sampleRate: number
    numberOfChannels: number
    channels: Float32Array[]
  }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  muxer: any,
  isAborted: () => boolean,
  bitrate: number,
  waitForOutput?: () => Promise<void>,
): Promise<void> {
  let fatal: unknown = null
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      fatal = e
      console.error('AudioEncoder error:', e)
    },
  })

  let configured = false
  const CHUNK = 4096
  let timestampUs = 0

  try {
    for await (const block of blocks) {
      if (isAborted()) throw new DOMException('Export cancelled', 'AbortError')
      if (fatal) throw new Error(`AudioEncoder failed: ${String(fatal)}`)
      const numCh = Math.min(block.numberOfChannels, AUDIO_CHANNELS)
      if (!configured) {
        encoder.configure({
          codec: 'mp4a.40.2',
          sampleRate: block.sampleRate,
          numberOfChannels: numCh,
          bitrate,
        })
        configured = true
      }
      // Bounded encoder queue — wait before flooding (backpressure).
      while (encoder.encodeQueueSize > 8) {
        if (isAborted()) throw new DOMException('Export cancelled', 'AbortError')
        if (fatal) throw new Error(`AudioEncoder failed: ${String(fatal)}`)
        await yieldToMacrotask()
      }
      for (let offset = 0; offset < block.frames; offset += CHUNK) {
        const frames = Math.min(CHUNK, block.frames - offset)
        const planar = new Float32Array(frames * numCh)
        for (let ch = 0; ch < numCh; ch++) {
          planar.set(block.channels[ch]!.subarray(offset, offset + frames), ch * frames)
        }
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: block.sampleRate,
          numberOfFrames: frames,
          numberOfChannels: numCh,
          timestamp: timestampUs,
          data: planar,
        })
        encoder.encode(data)
        data.close()
        timestampUs += Math.round((frames / block.sampleRate) * 1_000_000)
        // A worker PCM fallback can provide the entire timeline as one block.
        // Enforce backpressure per chunk so AudioData copies cannot accumulate.
        while (encoder.encodeQueueSize > 8) {
          if (isAborted()) throw new DOMException('Export cancelled', 'AbortError')
          if (fatal) throw new Error(`AudioEncoder failed: ${String(fatal)}`)
          await yieldToMacrotask()
        }
      }
      if (waitForOutput) await waitForOutput()
    }
    if (!configured) return // no audio blocks
    if (fatal) throw new Error(`AudioEncoder failed: ${String(fatal)}`)
    await withDeadline(encoder.flush(), 30_000, 'AudioEncoder.flush')
    if (waitForOutput) await waitForOutput()
    if (fatal) throw new Error(`AudioEncoder failed: ${String(fatal)}`)
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* ignore */
    }
  }
}

/** Worker-compatible export core. Audio is pre-mixed on the main thread
 *  (OfflineAudioContext is main-thread-only) and passed in as raw PCM.
 *  Canvas + image loading are worker-aware (OffscreenCanvas / ImageBitmap). */
export async function exportVideoCore(
  settings: ExportSettings,
  durationSec: number,
  clips: Clip[],
  tracks: Track[],
  assets: MediaAsset[],
  urlCache: Map<string, string>,
  pcmAudio: PcmAudio | null,
  isAborted: () => boolean,
  onProgress: OnProgress,
  /** S3B: when set, audio is mixed+encoded as blocks (no full-timeline PCM). */
  audioStream?: AsyncIterable<StreamMixBlock> | null,
  /** Selected native folder: bypass OPFS and stream mux chunks to the backend. */
  directOutput?: BrowserDirectOutput,
  /** Per-window OPFS key; prevents two tabs from deleting each other's export. */
  scratchKey: string = EXPORT_TMP_KEY,
  /** Main-thread cancellation; worker callers use hard termination + isAborted. */
  abortSignal?: AbortSignal,
  /** Desktop path-backed source bridge used by the worker/main-thread fallback. */
  desktopVideoSource?: DesktopVideoSourceReader,
): Promise<BrowserExportResult> {
  const { width, height, fps, videoBitrateKbps } = settings
  const requestedVideoCodec = settings.videoCodec ?? 'h264'
  const quality = exportQualityDefinition(settings.qualityProfile)
  const audioBitrate = Math.max(
    64_000,
    Math.round((settings.audioBitrateKbps ?? quality.audioBitrateKbps) * 1_000),
  )
  if (pcmAudio && settings.audioMastering && settings.audioMastering !== 'off') {
    masterPcmAudioInPlace(pcmAudio, settings.audioMastering)
  }
  const totalFrames = Math.max(1, Math.ceil(durationSec * fps))
  const isWorker = typeof document === 'undefined'

  // OffscreenCanvas in worker (no DOM), HTMLCanvasElement on main thread.
  const canvas: HTMLCanvasElement | OffscreenCanvas = isWorker
    ? new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
    : Object.assign(document.createElement('canvas'), { width, height })
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

  // Caption zero-copy overlay: text is still rasterized by the exact shared 2D
  // renderer (preview parity), but only into a transparent overlay. WebGPU then
  // alpha-composites that texture over the media surface, avoiding the costly
  // full-frame GPU -> Canvas2D readback before VideoEncoder.
  let captionGpuCanvas: HTMLCanvasElement | OffscreenCanvas | null = null
  let captionGpuCtx: CanvasRenderingContext2D | null = null
  let captionOverlayStateKey: string | null = null
  let captionOverlayFrameVersion = 0
  const getCaptionGpuContext = (): CanvasRenderingContext2D | null => {
    if (!captionGpuCanvas) {
      captionGpuCanvas = isWorker
        ? new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
        : Object.assign(document.createElement('canvas'), { width, height })
      captionGpuCtx = captionGpuCanvas.getContext('2d', {
        alpha: true,
      }) as CanvasRenderingContext2D | null
    }
    return captionGpuCtx
  }

  // Scratch canvas used to rasterize a VideoFrame to RGBA before any ctx.filter
  // (blur canvasFill / adjust) is applied to it. Chromium renders a *filtered*
  // drawImage(VideoFrame) as a solid green frame (the planar YUV source can't go
  // through the filter path), so the blurred letterbox fill came out green while
  // the unfiltered fit-draw looked fine. Drawing the frame once unfiltered here
  // gives a plain RGBA canvas the filter path handles correctly. Reused + resized.
  let rasterCanvas: HTMLCanvasElement | OffscreenCanvas | null = null
  let rasterCtx: CanvasRenderingContext2D | null = null
  const rasterizeForFilter = (src: DrawSource): DrawSource => {
    if (typeof VideoFrame === 'undefined' || !(src instanceof VideoFrame)) return src
    const w = Math.max(1, src.displayWidth)
    const h = Math.max(1, src.displayHeight)
    if (!rasterCanvas) {
      rasterCanvas = isWorker
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h })
      rasterCtx = rasterCanvas.getContext('2d') as CanvasRenderingContext2D
    }
    if (rasterCanvas.width !== w) rasterCanvas.width = w
    if (rasterCanvas.height !== h) rasterCanvas.height = h
    rasterCtx!.clearRect(0, 0, w, h)
    rasterCtx!.drawImage(src, 0, 0, w, h)
    return rasterCanvas
  }

  // Video sources: prefer WebCodecs sequential decoders (fast, CapCut-like).
  // S7: pool is keyed by *source-time mapping*, not asset id — two clips of the
  // same asset with different in-points get independent decoders so they do not
  // thrash seek/reset every frame. Blobs are demux-probed once per asset; the
  // first mapping reuses that seed reader; extra mappings create additional
  // readers from the same blob. Never one new reader per output frame.
  const videoSources = new Map<string, VideoReaderSource>()
  const videoSourceLoads = new Map<string, Promise<VideoReaderSource>>()
  const videoIndexes = new Map<string, VideoSampleIndex>()
  const videoIndexLoads = new Map<string, Promise<VideoSampleIndex>>()
  // One export-wide budget. A per-asset 64 MiB cache could retain hundreds of
  // MiB when a project references several source videos/readers.
  const desktopVideoRangeCache = createSharedVideoByteRangeCache(64 * 1024 * 1024)
  const maxVideoBlobCacheEntries = 6
  const maxVideoIndexCacheBytes = 128 * 1024 * 1024
  let videoIndexCacheBytes = 0
  const indexBytes = (index: VideoSampleIndex) =>
    index.offsets.byteLength + index.sizes.byteLength + index.keyFlags.byteLength +
    index.tsUs.byteLength + index.durUs.byteLength + index.keyIndices.byteLength +
    (index.description?.byteLength ?? 0)
  let mediaReleased = false
  const createReaderBounded = async (
    factory: () => Promise<VideoFrameReader>,
    label: string,
  ): Promise<VideoFrameReader> => {
    const pending = factory()
    try {
      return await withAbortAndDeadline(pending, abortSignal, 30_000, label)
    } catch (e) {
      // A timed-out parser/decoder may still resolve later. The reader pool
      // never receives that late value, so close it here instead of leaking a
      // VideoDecoder/HTMLVideo resource after cancellation.
      void pending.then((reader) => {
        try { reader.close() } catch { /* already closed */ }
      }, () => {})
      throw e
    }
  }
  const getVideoSource = async (assetId: string): Promise<VideoReaderSource> => {
    const cached = videoSources.get(assetId)
    if (cached) {
      videoSources.delete(assetId)
      videoSources.set(assetId, cached)
      return cached
    }
    const inflight = videoSourceLoads.get(assetId)
    if (inflight) return inflight
    const asset = assets.find((candidate) => candidate.id === assetId)
    const load = (async (): Promise<VideoReaderSource> => {
      if (asset?.normalizedBlobKey) {
        const url = urlCache.get(assetId)
        if (url) {
          const response = await fetch(url, abortSignal ? { signal: abortSignal } : undefined)
          if (!response.ok) throw new Error(`Video fetch failed (${response.status})`)
          return response.blob()
        }
      }
      if (asset?.sourcePath && desktopVideoSource) {
        let size: number | null = null
        try {
          size = await withAbortAndDeadline(
            desktopVideoSource.size(asset.sourcePath),
            abortSignal,
            30_000,
            `desktop video size ${asset.name}`,
          )
        } catch (error) {
          // Scope/IPC failures (e.g. a drag-dropped path the Tauri asset scope
          // never granted) must NOT fail the export: the same file is already
          // playable via its media URL — fall through and fetch it as a Blob,
          // which keeps the fast WebCodecs path at the cost of RAM for this file.
          console.warn(
            `[export] desktop byte-range unavailable for "${asset.name}" ` +
              `(${String(error)}); falling back to URL fetch`,
          )
        }
        if (size !== null) {
          const byteSize = size
          const desktopSource: VideoByteSource = {
            size: byteSize,
            read: async (start, end) => {
              try {
                return await withAbortAndDeadline(
                  desktopVideoSource.read(asset.sourcePath!, start, end),
                  abortSignal,
                  30_000,
                  `desktop video read ${asset.name} ${start}-${end}`,
                )
              } catch (error) {
                throw new DesktopVideoSourceReadError(
                  `Cannot read desktop video "${asset.name}" bytes ${start}-${end}`,
                  { cause: error },
                )
              }
            },
          }
          // Decoder mappings and seek resets share immutable source bytes,
          // bounded by one cache budget across every asset in this export.
          return desktopVideoRangeCache.wrap(assetId, desktopSource)
        }
      }
      const url = urlCache.get(assetId)
      if (!url) throw new Error(`No video URL for asset ${assetId}`)
      const response = await fetch(url, abortSignal ? { signal: abortSignal } : undefined)
      if (!response.ok) throw new Error(`Video fetch failed (${response.status})`)
      return response.blob()
    })()
      .then((source) => {
        if (mediaReleased) return source
        videoSources.set(assetId, source)
        while (videoSources.size > maxVideoBlobCacheEntries) {
          const oldest = videoSources.keys().next().value as string | undefined
          if (!oldest) break
          videoSources.delete(oldest)
        }
        return source
      })
      .finally(() => videoSourceLoads.delete(assetId))
    videoSourceLoads.set(assetId, load)
    return withAbortAndDeadline(load, abortSignal, 120_000, `video fetch ${assetId}`)
  }
  const getVideoIndex = async (
    assetId: string,
    source: VideoReaderSource,
  ): Promise<VideoSampleIndex> => {
    const cached = videoIndexes.get(assetId)
    if (cached) {
      videoIndexes.delete(assetId)
      videoIndexes.set(assetId, cached)
      return cached
    }
    const inflight = videoIndexLoads.get(assetId)
    if (inflight) return inflight
    const parse = createVideoSampleIndex(source).catch((error) => {
      if (isDesktopVideoSourceReadError(error)) throw error
      throw new BrowserVideoUnsupportedError(
        `Browser demux does not support video asset ${assetId}`,
        { cause: error },
      )
    })
    const load = withAbortAndDeadline(
      parse,
      abortSignal,
      60_000,
      `video sample index ${assetId}`,
    ).then((index) => {
      if (!mediaReleased) {
        videoIndexes.set(assetId, index)
        videoIndexCacheBytes += indexBytes(index)
        while (
          videoIndexes.size > 1 &&
          (videoIndexes.size > maxVideoBlobCacheEntries ||
            videoIndexCacheBytes > maxVideoIndexCacheBytes)
        ) {
          const oldest = videoIndexes.keys().next().value as string | undefined
          if (!oldest) break
          const evicted = videoIndexes.get(oldest)
          videoIndexes.delete(oldest)
          if (evicted) videoIndexCacheBytes -= indexBytes(evicted)
        }
      }
      return index
    }).finally(() => videoIndexLoads.delete(assetId))
    videoIndexLoads.set(assetId, load)
    return load
  }
  const exportReaderPool = new ExportReaderPool({
    // Keep recently inactive source mappings warm across short edit cuts. A
    // dense timelines often switch clips every few frames; closing and
    // recreating a WebCodecs decoder at each boundary costs more than drawing
    // the frame. The pool still has the hard live-decoder cap and evicts a
    // warm slot before it aliases a different source-time mapping.
    warmRetentionTicks: Math.max(30, Math.min(120, Math.round(fps * 2))),
    createReader: async (assetId) => {
      const source = await getVideoSource(assetId)
      const index = await getVideoIndex(assetId, source)
      return createReaderBounded(
        () => createVideoFrameReader(source, index),
        `video index ${assetId}`,
      )
    },
    // Soft-expand when primary decoder budget is full and every slot is still
    // active (e.g. 7 distinct video assets overlapping). Prefer HTMLVideo seek
    // on main thread; in workers fall back to another WebCodecs reader.
    createDegradedReader: async (assetId) => {
      const source = await getVideoSource(assetId)
      if (!isWorker && source instanceof Blob) {
        try {
          return await createReaderBounded(
            () => createHtmlVideoFrameReader(source),
            `HTML video reader ${assetId}`,
          )
        } catch (e) {
          console.warn(
            `[export S7] HTMLVideo degraded reader failed for ${assetId}, soft WebCodecs:`,
            e,
          )
        }
      }
      const index = await getVideoIndex(assetId, source)
      return createReaderBounded(
        () => createVideoFrameReader(source, index),
        `degraded video index ${assetId}`,
      )
    },
    onDegraded: ({ assetId, key, reason }) => {
      console.warn(`[export S7] decoder pool degraded for asset ${assetId} (${key}): ${reason}`)
    },
  })
  const exportVideoPool = new Map<string, HTMLVideoElement>()
  // Images: HTMLImageElement on main thread, ImageBitmap in worker (no Image constructor).
  const exportImagePool = new Map<string, HTMLImageElement | ImageBitmap>()
  const webCodecsUnsupported = new Set<string>()
  const canUseWebCodecsSource = (asset: MediaAsset) =>
    !webCodecsUnsupported.has(asset.id) &&
    (!asset.sourcePath || !!desktopVideoSource || !!asset.normalizedBlobKey)
  const ensureHtmlVideo = async (asset: MediaAsset): Promise<HTMLVideoElement> => {
    const cached = exportVideoPool.get(asset.id)
    if (cached) return cached
    if (isWorker) throw new DOMException('Worker cannot decode a video asset', 'NotSupportedError')
    const url = urlCache.get(asset.id)
    if (!url) throw new Error(`No video URL for asset ${asset.id}`)
    const el = document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.src = url
    el.preload = 'metadata'
    el.muted = true
    el.playsInline = true
    exportVideoPool.set(asset.id, el)
    await withAbortAndDeadline(new Promise<void>((resolve, reject) => {
      if (el.readyState >= 1) { resolve(); return }
      el.onloadedmetadata = () => resolve()
      el.onerror = () => reject(new Error(`Failed to load video for export: ${asset.name}`))
      el.load()
    }), abortSignal, 15_000, `video metadata ${asset.name}`)
    return el
  }
  const ensureImage = async (asset: MediaAsset): Promise<HTMLImageElement | ImageBitmap> => {
    const cached = exportImagePool.get(asset.id)
    if (cached) return cached
    const url = urlCache.get(asset.id)
    if (!url) throw new Error(`No image URL for asset ${asset.id}`)
    let loaded: HTMLImageElement | ImageBitmap
    if (isWorker) {
      const response = await withAbortAndDeadline(
        fetch(url, abortSignal ? { signal: abortSignal } : undefined),
        abortSignal,
        30_000,
        `image fetch ${asset.name}`,
      )
      if (!response.ok) throw new Error(`Image fetch failed (${response.status})`)
      const bitmapPending = response.blob().then((blob) => createImageBitmap(blob))
      try {
        loaded = await withAbortAndDeadline(
          bitmapPending,
          abortSignal,
          30_000,
          `image decode ${asset.name}`,
        )
      } catch (e) {
        void bitmapPending.then((bitmap) => bitmap.close(), () => {})
        throw e
      }
    } else {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      await withAbortAndDeadline(new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error(`Failed to load image for export: ${asset.name}`))
        img.src = url
      }), abortSignal, 15_000, `image load ${asset.name}`)
      loaded = img
    }
    exportImagePool.set(asset.id, loaded)
    return loaded
  }
  const releaseLoadedMedia = (): void => {
    mediaReleased = true
    exportReaderPool.closeAll()
    if (!isWorker) {
      for (const el of exportVideoPool.values()) el.src = ''
      for (const img of exportImagePool.values()) {
        if (img instanceof HTMLImageElement) img.src = ''
      }
    } else {
      for (const bmp of exportImagePool.values()) {
        if (bmp instanceof ImageBitmap) {
          try { bmp.close() } catch { /* already closed */ }
        }
      }
    }
    exportVideoPool.clear()
    exportImagePool.clear()
    videoSources.clear()
    videoSourceLoads.clear()
    videoIndexes.clear()
    videoIndexCacheBytes = 0
    videoIndexLoads.clear()
  }
  let gpu: GpuCompositor | null = null
  try {
  // In a worker the FontFaceSet is empty (no @font-face from the document), so
  // custom-font captions would fall back to a default face. Register the bundled
  // fonts here first; loadTextClipFonts then fetches the ones actually used.
  if (isWorker) {
    const families = new Set<string>()
    for (const clip of clips) {
      if (clip.textData?.fontFamily) families.add(clip.textData.fontFamily)
      for (const fallback of fallbackCaptionFamiliesForText(clip.textData?.content ?? '')) {
        families.add(fallback)
      }
    }
    await registerCaptionFontFaces(families, (self as unknown as { fonts: FontFaceSet }).fonts)
  }
  await withAbortAndDeadline(loadTextClipFonts(clips), abortSignal, 60_000, 'caption font load')

  // Try to stand up a GPU compositor at export resolution. Returns null when
  // WebGPU is unavailable — the frame loop then uses the Canvas 2D path.
    const gpuPending = GpuCompositor.create(width, height)
    try {
      gpu = await withAbortAndDeadline(
        gpuPending,
        abortSignal,
        30_000,
        'GPU compositor setup',
      )
    } catch (e) {
      void gpuPending.then((lateGpu) => {
        try { lateGpu?.destroy() } catch { /* late initialization failed */ }
      }, () => {})
      throw e
    }
  } catch (e) {
    releaseLoadedMedia()
    throw e
  }
  let gpuLost = false

  // 1. Audio: pre-mixed PCM (legacy/worker) and/or S3B pull-stream of blocks.
  // pcmAudio is null when using streaming or when the timeline has no audio.
  const hasAudioTrack = !!pcmAudio || !!audioStream

  // 2. Muxer with video (+ audio if present). The MP4 streams into an OPFS
  // scratch file as it's muxed, so memory stays bounded no matter how long the
  // export is (the old ArrayBufferTarget held the whole file in RAM). The
  // tradeoff: fastStart false puts the moov atom at the end, fine for a
  // downloaded file. Falls back to the in-memory path if OPFS is unavailable
  // (or a leaked lock from a crashed export blocks the scratch file).
  let directSink: BackendMp4StreamSink | null = null
  let opfsWritable: FileSystemWritableFileStream | null = null
  if (directOutput) {
    try {
      directSink = await BackendMp4StreamSink.create(directOutput)
    } catch (e) {
      try { gpu?.destroy() } catch { /* device gone */ }
      releaseLoadedMedia()
      throw e
    }
  } else {
    try {
      try {
        await withAbortAndDeadline(
          cleanupStaleExportScratch(scratchKey),
          abortSignal,
          30_000,
          'OPFS stale cleanup',
        )
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e
        // Stale-file cleanup is best effort; the per-window delete below is authoritative.
      }
      await withAbortAndDeadline(
        deleteBlob(scratchKey),
        abortSignal,
        30_000,
        'OPFS scratch delete',
      ) // reclaim this window's previous export
      const estimatedOutput = estimateBrowserOutputBytes(
        durationSec,
        videoBitrateKbps,
        hasAudioTrack,
        audioBitrate / 1_000,
      )
      let storage: BrowserStorageSnapshot | null = null
      try {
        storage = await withAbortAndDeadline(
          getBrowserStorageSnapshot(),
          abortSignal,
          15_000,
          'browser storage estimate',
        )
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e
      }
      assertBrowserStorageHeadroom(storage, estimatedOutput)
      const writablePending = createWritable(scratchKey)
      try {
        opfsWritable = await withAbortAndDeadline(
          writablePending,
          abortSignal,
          30_000,
          'OPFS writer create',
        )
      } catch (e) {
        void writablePending.then(async (writable) => {
          await writable.abort().catch(() => {})
          await deleteBlob(scratchKey)
        }, () => {})
        throw e
      }
    } catch (e) {
      if (
        e instanceof BrowserStorageHeadroomError ||
        (e instanceof DOMException && e.name === 'AbortError')
      ) {
        try { gpu?.destroy() } catch { /* device gone */ }
        releaseLoadedMedia()
        throw e
      }
      opfsWritable = null
    }
  }
  if (!directSink && !opfsWritable) {
    try {
      assertSafeInMemoryBrowserOutput(
        estimateBrowserOutputBytes(
          durationSec,
          videoBitrateKbps,
          hasAudioTrack,
          audioBitrate / 1_000,
        ),
      )
    } catch (e) {
      try { gpu?.destroy() } catch { /* device gone */ }
      releaseLoadedMedia()
      throw e
    }
  }
  const discardScratch = async (): Promise<void> => {
    if (!opfsWritable) return
    await discardExportScratch(opfsWritable, scratchKey)
  }
  // Resolve the actual codec before the muxer is created: its MP4 sample entry
  // must match the chunks emitted by WebCodecs. Browser HDR is deliberately an
  // SDR fallback until the compositor is end-to-end 10-bit.
  let pickedVideo: PickedVideoConfig
  try {
    pickedVideo = await withAbortAndDeadline(pickVideoConfig({
      width,
      height,
      bitrate: videoBitrateKbps * 1000,
      framerate: fps,
      // 'realtime' rather than 'quality': on real footage the 'quality' preset's
      // lookahead + B-frames make the hardware encoder the export bottleneck
      // (telemetry showed the encode queue pinned at its cap with the producer
      // waiting on it every frame — ~115 fps on a 608x1080 stream whose encoder
      // ceiling probe read 215/266 fps on trivial black frames). At the bitrates
      // this exporter targets (VBR, ~8 Mbps for sub-1MP) the two presets are
      // visually indistinguishable, so we take the throughput. Latency is
      // irrelevant to a batch file export.
      latencyMode: 'realtime',
      // No explicit bitrateMode: 'variable' is already the WebCodecs default
      // (the config echo below logs it), so passing it only narrows
      // isConfigSupported matching on conservative runtimes.
    }, requestedVideoCodec), abortSignal, 30_000, 'VideoEncoder configuration')
  } catch (e) {
    try { gpu?.destroy() } catch { /* device gone */ }
    releaseLoadedMedia()
    await discardScratch()
    if (directSink) await directSink.abort()
    throw e
  }
  // Force the chosen latencyMode onto the applied config. isConfigSupported()
  // canonicalizes the config it echoes back and may drop latencyMode, which
  // would silently revert the encoder to the 'quality' default — so set it here
  // where configure() actually reads it, not just in the pickVideoConfig input.
  pickedVideo.config.latencyMode = 'realtime'
  // One-time config line so a slow export is attributable from the console:
  // wrong codec (hevc/av1 fell back?), unexpected resolution/bitrate, or a
  // software encoder are all visible here without guessing. `bp=` and `latency=`
  // double as a proof-of-life marker: if you don't see them, the (worker)
  // bundle serving this export is stale — hard-reload before trusting numbers.
  // eslint-disable-next-line no-console
  console.info(
    `[export] encoder: ${pickedVideo.codec} ${width}x${height}@${fps} ` +
      `${Math.round((videoBitrateKbps) / 1000)}Mbps ` +
      `hw=${String(pickedVideo.config.hardwareAcceleration ?? 'no-preference')} ` +
      `bitrateMode=${String(pickedVideo.config.bitrateMode ?? 'default')} ` +
      `latency=${String(pickedVideo.config.latencyMode ?? 'default')} ` +
      `bp=hyst${ENCODER_QUEUE_HIGH}/${ENCODER_QUEUE_LOW}` +
      (pickedVideo.fellBack ? ` (requested ${requestedVideoCodec}, fell back)` : ''),
  )
  // Ceiling probe: pure encoder service rate at this exact config, on a
  // throwaway session with textured frames; flat black frames make software
  // encoding look unrealistically fast. WebCodecs exposes no way to ASK whether
  // a config runs on hardware
  // ('require-hardware' doesn't exist), so we infer it: run the same probe with
  // hardwareAcceleration 'prefer-hardware' vs 'prefer-software'. If hardware is
  // real, prefer-hardware is much faster; if they're ~equal, the runtime is
  // software-encoding either way (the WebView2 "no hardware codec" case) — and
  // the only real speedup is Server (native ffmpeg NVENC/NVDEC). Costs <1s.
  // Probe canvases below are deliberately textured rather than flat black;
  // otherwise software inter-frame compression makes the comparison useless.
  try {
    const probeRate = async (
      hardwareAcceleration: NonNullable<VideoEncoderConfig['hardwareAcceleration']>,
    ): Promise<number> => {
      const probeCanvases = [0, 1].map((seed) => {
        const probeCanvas = new OffscreenCanvas(width, height)
        const probeCtx = probeCanvas.getContext('2d')
        if (!probeCtx) return null
        const gradient = probeCtx.createLinearGradient(0, 0, width, height)
        gradient.addColorStop(0, seed ? '#e91e63' : '#1565c0')
        gradient.addColorStop(0.5, seed ? '#ffb300' : '#00acc1')
        gradient.addColorStop(1, seed ? '#4a148c' : '#1b5e20')
        probeCtx.fillStyle = gradient
        probeCtx.fillRect(0, 0, width, height)
        probeCtx.fillStyle = seed ? 'rgba(255,255,255,0.68)' : 'rgba(0,0,0,0.62)'
        for (let i = 0; i < 48; i++) {
          const x = (i * 97 + seed * 211) % Math.max(1, width)
          const y = (i * 53 + seed * 149) % Math.max(1, height)
          probeCtx.fillRect(x, y, Math.max(8, width / 13), Math.max(8, height / 17))
        }
        return probeCanvas
      })
      if (probeCanvases.some((canvas) => !canvas)) return NaN
      let probeError: unknown = null
      const probe = new VideoEncoder({
        output: () => {},
        error: (e) => { probeError = e },
      })
      try {
        probe.configure({ ...pickedVideo.config, hardwareAcceleration })
        const frames = 60
        const t0 = performance.now()
        for (let i = 0; i < frames; i++) {
          const vf = new VideoFrame(probeCanvases[i % probeCanvases.length]!, {
            timestamp: Math.round((i / fps) * 1_000_000),
            duration: Math.round((1 / fps) * 1_000_000),
          })
          try {
            probe.encode(vf, { keyFrame: i === 0 })
          } finally {
            vf.close()
          }
        }
        await withDeadline(probe.flush(), 10_000, 'encoder rate probe flush')
        if (probeError) return NaN
        return (frames * 1000) / (performance.now() - t0)
      } finally {
        try { probe.close() } catch { /* already closed by error */ }
      }
    }
    const hwFps = await probeRate('prefer-hardware')
    const swFps = await probeRate('prefer-software')
    const verdict = !Number.isFinite(hwFps) || !Number.isFinite(swFps)
      ? 'inconclusive'
      : hwFps > swFps * 1.3 ? 'HARDWARE encoder active'
        : 'hardware path unverified (export remains configured prefer-hardware)'
    // eslint-disable-next-line no-console
    console.info(
      `[export] encoder hw-vs-sw probe (textured frames): ` +
        `preferHardware=${hwFps.toFixed(0)}fps preferSoftware=${swFps.toFixed(0)}fps → ${verdict}`,
    )
  } catch (probeFailure) {
    // Diagnostic only — never let the probe break a real export.
    console.warn('[export] encoder hw-vs-sw probe failed:', probeFailure)
  }
  const muxerCommon = {
    video: { codec: muxerCodec(pickedVideo.codec), width, height },
    ...(hasAudioTrack
      ? {
          audio: {
            codec: 'aac' as const,
            numberOfChannels: pcmAudio
              ? Math.min(pcmAudio.numberOfChannels, AUDIO_CHANNELS)
              : AUDIO_CHANNELS,
            sampleRate: pcmAudio?.sampleRate ?? SAMPLE_RATE,
          },
        }
      : {}),
    firstTimestampBehavior: 'offset' as const,
  }
  const createMuxer = () => directSink
    ? new Muxer({
        ...muxerCommon,
        target: directSink.target,
        fastStart: false as const,
      })
    : opfsWritable
      ? new Muxer({
        ...muxerCommon,
        target: new FileSystemWritableFileStreamTarget(opfsWritable),
        fastStart: false as const,
      })
      : new Muxer({ ...muxerCommon, target: new ArrayBufferTarget(), fastStart: 'in-memory' as const })
  let muxer: ReturnType<typeof createMuxer>
  try {
    muxer = createMuxer()
  } catch (e) {
    try { gpu?.destroy() } catch { /* device gone */ }
    releaseLoadedMedia()
    await discardScratch()
    if (directSink) await directSink.abort()
    throw e
  }

  // 3. Video encoder (prefer GPU hardware encoding for speed). Encoded chunks
  // go straight into the muxer — buffering them and adding after the loop kept
  // the entire encoded video in RAM for no benefit (audio is a separate track,
  // so track-local timestamp ordering is preserved either way).
  // A dead encoder must FAIL the export, not hang it: the error callback only
  // logged before, so a lost hardware session left the drain loop below spinning
  // at "100%" forever (worker alive, GPU memory pinned).
  let encoderFatal: unknown = null
  let encodedVideoChunks = 0
  let encoderGeneration = 0
  const createConfiguredVideoEncoder = (): VideoEncoder => {
    const generation = ++encoderGeneration
    const next = new VideoEncoder({
      output: (chunk, meta) => {
        // close() clears the encoder control queue, but an output callback that
        // was already posted can still race a first-frame fallback. Never let a
        // retired session append a duplicate timestamp/config to the new MP4.
        if (generation !== encoderGeneration) return
        encodedVideoChunks++
        muxer.addVideoChunk(chunk, meta)
      },
      error: (e) => {
        if (generation !== encoderGeneration) return
        encoderFatal = e
        console.error('VideoEncoder error:', e)
      },
    })
    next.configure(pickedVideo.config)
    return next
  }
  let encoder: VideoEncoder
  try {
    encoder = createConfiguredVideoEncoder()
  } catch (e) {
    try { encoder!.close() } catch { /* configure failed */ }
    try { gpu?.destroy() } catch { /* device gone */ }
    releaseLoadedMedia()
    await discardScratch()
    if (directSink) await directSink.abort()
    throw e
  }

  // Precompute lookups + S6 temporal index / sweep cursors (monotonic t).
  const assetById = new Map(assets.map((a) => [a.id, a]))
  const activeIndex = ActiveClipIndex.build(clips, tracks)
  const videoSweep = activeIndex.createSweep('video')
  const fxSweep = activeIndex.createSweep('fx')
  const textSweep = activeIndex.createSweep('text')
  // Adjacent cuts frequently use distinct source-time mappings of the
  // same asset. Keep a cheap index of the next video clip on each track so its
  // decoder can be opened while the current frame is being composited.
  const videoTrackIds = new Set(
    tracks.filter((track) => track.kind === 'video' && !track.hidden).map((track) => track.id),
  )
  const nextVideoClipById = new Map<string, Clip>()
  for (const trackId of videoTrackIds) {
    const ordered = clips
      .filter((clip) => clip.trackId === trackId && clip.assetId)
      .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
    for (let i = 0; i + 1 < ordered.length; i++) {
      nextVideoClipById.set(ordered[i]!.id, ordered[i + 1]!)
    }
  }
  // Give a discontinuous mapping enough lead time to decode from its preceding
  // keyframe. The pool admits only one actual frame-prewarm concurrently and
  // never evicts an active/warm reader to do it, keeping GPU pressure bounded.
  // Reset-prone cuts can take hundreds of milliseconds to decode from a
  // keyframe; one second gives the existing warm-reader path time to finish
  // without creating extra background decoder work on short exports.
  const prewarmWindowSec = 1
  const keyFrameFrames = buildSceneKeyframeFrames(clips, tracks, fps, totalFrames)
  const maxKeyframeFrames = Math.max(
    1,
    Math.round(fps * quality.maxKeyframeIntervalSec),
  )
  // Main-thread <video> seek path: key by mapping so two clips of the same
  // asset do not share one lastSeek cursor (still one element — degraded).
  const lastSeek = new Map<string, number>()

  const frameOwnedVideoFrames = new Set<VideoFrame>()
  let zeroCopyState: BrowserExportResult['zeroCopy'] =
    settings.browserZeroCopy === 'auto' ? 'ineligible' : 'off'
  let zeroCopyProbeComplete = false
  let zeroCopyRealPathVerified = false
  let zeroCopySurface: 'none' | 'image-bitmap' | 'canvas-fence' = 'none'

  // Cancel/failure MUST release everything — decoders, the WebGPU device, the
  // encoder, the OPFS scratch lock. A stuck or cancelled export used to keep
  // the worker alive holding gigabytes of GPU memory until the app was closed.
  const releaseAll = async (): Promise<void> => {
    encoderGeneration++ // ignore callbacks already queued by a failed session
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch { /* already closed */ }
    try {
      gpu?.destroy()
    } catch { /* device gone */ }
    for (const frame of frameOwnedVideoFrames) {
      try { frame.close() } catch { /* already closed */ }
    }
    frameOwnedVideoFrames.clear()
    releaseLoadedMedia()
    releaseFxBuffers('export-')
    // Discard the partial scratch file (also releases its OPFS lock). BOUND it:
    // when the hardware encoder/OPFS session is lost, abort() can stay pending
    // forever. Since fail() awaits releaseAll() before throwing, an un-deadlined
    // abort() here strands the whole export at "100%" — the stall guard fires but
  // its own teardown can never complete. Time-box it so fail() always proceeds.
    // abort() discards temporary data but can leave the target entry; a failure
    // after close can leave the committed multi-GB file. Always remove our key.
    await discardScratch()
    if (directSink) await directSink.abort()
  }
  let teardownStarted = false
  const fail = async (err: unknown): Promise<never> => {
    // The failure path must never hang: even with the abort deadline above, any
    // future await added to releaseAll() could re-introduce the 100% hang. Wrap
    // the entire teardown so fail() is guaranteed to throw (releasing VRAM as far
    // as it got) rather than leave the export pinned and unkillable.
    teardownStarted = true
    await withDeadline(releaseAll(), 10_000, 'releaseAll').catch(() => {})
    throw err
  }

  // 4. Frame loop
  let lastCooperativeYield = performance.now()
  // Per-phase throughput telemetry. A slow export MUST be attributable from
  // the console alone: which phase eats the time (source decode vs draw vs
  // encoder backpressure) and which path ran (gpu/2d, zero-copy, worker).
  // One summary line every ~5s; performance.now() bookkeeping is negligible.
  const perfWin = {
    frames: 0, gpuFrames: 0, decodeMs: 0, drawMs: 0, encodeMs: 0,
    // encode+bp breakdown: VideoFrame create + encode() submit / encoder queue
    // drain / backend sink capacity wait / cooperative yield. Their sum ≈
    // encodeMs; a gap means time went to the rare zero-copy verify flushes.
    encSubmitMs: 0, encDrainMs: 0, sinkWaitMs: 0, yieldMs: 0, maxQueue: 0,
    captionFrames: 0, captionRedraws: 0,
    // Decode-churn snapshot (cumulative counters at window start). A dense
    // timeline of many reordered cuts re-inits/seeks the decoder per cut; the
    // per-window deltas below tell "decode is slow because it keeps re-seeking"
    // apart from "decode is slow but sequential (GPU-bound)".
    poolCreates0: 0, poolTransient0: 0, poolReleases0: 0, poolHandoffs0: 0,
    poolFramePrewarms0: 0, poolDegraded0: 0,
    readerResets0: 0, readerBackwardResets0: 0, readerForwardResets0: 0,
    readerConfigures0: 0,
    readerSourceReadCalls0: 0, readerSourceReadBytes0: 0, readerSourceReadMs0: 0,
    readerChunksSubmitted0: 0, readerFramesOutput0: 0,
    readerHardware0: 0, readerSoftware0: 0, readerHardwareFallback0: 0,
    start: performance.now(),
  }
  const perfTotal = {
    frames: 0,
    gpuFrames: 0,
    decodeMs: 0,
    drawMs: 0,
    encodeMs: 0,
    captionFrames: 0,
    captionRedraws: 0,
    start: performance.now(),
  }
  // frameReaderStats is intentionally process-wide so the diagnostics can
  // aggregate decoder behaviour across workers. Snapshot it per export here;
  // otherwise the "total" line for the second export includes the first
  // export's decoder inits and makes a healthy job look more churn-heavy.
  const readerStatsStart = {
    configures: frameReaderStats.configures,
    resets: frameReaderStats.resets,
    backwardResets: frameReaderStats.backwardResets,
    forwardResets: frameReaderStats.forwardResets,
    sourceReadCalls: frameReaderStats.sourceReadCalls,
    sourceReadBytes: frameReaderStats.sourceReadBytes,
    sourceReadMs: frameReaderStats.sourceReadMs,
    sourceCacheHits: frameReaderStats.sourceCacheHits,
    sourceCacheMisses: frameReaderStats.sourceCacheMisses,
    sourceCacheBytesServed: frameReaderStats.sourceCacheBytesServed,
    chunksSubmitted: frameReaderStats.chunksSubmitted,
    framesOutput: frameReaderStats.framesOutput,
    sourceRateObservations: frameReaderStats.sourceRateObservations,
    sourceRateTotal: frameReaderStats.sourceRateTotal,
    hardwareConfigures: frameReaderStats.hardwareConfigures,
    softwareConfigures: frameReaderStats.softwareConfigures,
    hardwareFallbacks: frameReaderStats.hardwareFallbacks,
    coldDecodeCalls: frameReaderStats.coldDecodeCalls,
    coldDecodeMs: frameReaderStats.coldDecodeMs,
    resetDecodeCalls: frameReaderStats.resetDecodeCalls,
    resetDecodeMs: frameReaderStats.resetDecodeMs,
    steadyDecodeCalls: frameReaderStats.steadyDecodeCalls,
    steadyDecodeMs: frameReaderStats.steadyDecodeMs,
  }
  // Window zero must start at this export's snapshot, not process zero. Without
  // this the first perf line of a second export reports the previous job's
  // decoder churn even though the final total is correct.
  perfWin.readerResets0 = readerStatsStart.resets
  perfWin.readerBackwardResets0 = readerStatsStart.backwardResets
  perfWin.readerForwardResets0 = readerStatsStart.forwardResets
  perfWin.readerConfigures0 = readerStatsStart.configures
  perfWin.readerSourceReadCalls0 = readerStatsStart.sourceReadCalls
  perfWin.readerSourceReadBytes0 = readerStatsStart.sourceReadBytes
  perfWin.readerSourceReadMs0 = readerStatsStart.sourceReadMs
  perfWin.readerChunksSubmitted0 = readerStatsStart.chunksSubmitted
  perfWin.readerFramesOutput0 = readerStatsStart.framesOutput
  perfWin.readerHardware0 = readerStatsStart.hardwareConfigures
  perfWin.readerSoftware0 = readerStatsStart.softwareConfigures
  perfWin.readerHardwareFallback0 = readerStatsStart.hardwareFallbacks
  const logPerfWindow = (final = false) => {
    const elapsed = performance.now() - perfWin.start
    if (perfWin.frames === 0 || (!final && elapsed < 5_000)) return
    const per = (v: number) => (v / perfWin.frames).toFixed(1)
    // eslint-disable-next-line no-console
    console.info(
      `[export perf] ${final ? 'final ' : ''}fps=${((perfWin.frames * 1000) / elapsed).toFixed(1)} ` +
        `decode=${per(perfWin.decodeMs)}ms draw=${per(perfWin.drawMs)}ms encode+bp=${per(perfWin.encodeMs)}ms ` +
        `(submit=${per(perfWin.encSubmitMs)} drain=${per(perfWin.encDrainMs)} ` +
        `sink=${per(perfWin.sinkWaitMs)} yield=${per(perfWin.yieldMs)} maxQ=${perfWin.maxQueue}) ` +
        `path=${perfWin.gpuFrames === perfWin.frames ? 'gpu' : perfWin.gpuFrames === 0 ? '2d' : `mixed(${perfWin.gpuFrames}/${perfWin.frames}gpu)`} ` +
        `zeroCopy=${zeroCopyState} surface=${zeroCopySurface} worker=${isWorker} ` +
        `captions=${perfWin.captionRedraws}/${perfWin.captionFrames}` +
        // Decode-churn deltas for THIS window: reader creates/transient opens/
        // releases (mapping churn at cuts) + reader seek-resets + degraded
        // acquires (pool over cap). High relative to `frames` here = the dense
        // timeline is re-decoding from keyframes per cut, not decoding
        // sequentially — the actionable "many cuts" cost.
        ((): string => {
          const s = exportReaderPool.getStats()
          const dCreate = s.creates - perfWin.poolCreates0
          const dTransient = s.transientOpens - perfWin.poolTransient0
          const dRelease = s.releases - perfWin.poolReleases0
          const dHandoff = s.handoffs - perfWin.poolHandoffs0
          const dFramePrewarm = s.framePrewarms - perfWin.poolFramePrewarms0
          const dDegraded = s.degradedAcquires - perfWin.poolDegraded0
          const dResets = frameReaderStats.resets - perfWin.readerResets0
          const dBackwardResets =
            frameReaderStats.backwardResets - perfWin.readerBackwardResets0
          const dForwardResets = frameReaderStats.forwardResets - perfWin.readerForwardResets0
          const dConfigures = frameReaderStats.configures - perfWin.readerConfigures0
          const dReadCalls = frameReaderStats.sourceReadCalls - perfWin.readerSourceReadCalls0
          const dReadBytes = frameReaderStats.sourceReadBytes - perfWin.readerSourceReadBytes0
          const dReadMs = frameReaderStats.sourceReadMs - perfWin.readerSourceReadMs0
          const dChunks = frameReaderStats.chunksSubmitted - perfWin.readerChunksSubmitted0
          const dOutputs = frameReaderStats.framesOutput - perfWin.readerFramesOutput0
          const dHardware = frameReaderStats.hardwareConfigures - perfWin.readerHardware0
          const dSoftware = frameReaderStats.softwareConfigures - perfWin.readerSoftware0
          const dFallback = frameReaderStats.hardwareFallbacks - perfWin.readerHardwareFallback0
          return ` churn(creates=${dCreate} transient=${dTransient} release=${dRelease} ` +
            `handoffs=${dHandoff} predecoded=${dFramePrewarm} ` +
            `degraded=${dDegraded} seekResets=${dResets}` +
            `(back=${dBackwardResets} fwd=${dForwardResets}) decoderInits=${dConfigures} ` +
            `inputChunks=${dChunks} decodedFrames=${dOutputs} ` +
            `sourceRead=${dReadCalls}@${dReadMs.toFixed(1)}ms/${(dReadBytes / (1024 * 1024)).toFixed(1)}MB ` +
            `decoderHwReq=${dHardware} decoderSw=${dSoftware} hwFallback=${dFallback})`
        })() +
        // Assets decoding through the ~20fps <video>-seek fallback — the #1
        // cause of a "10x slower than it used to be" export.
        (exportVideoPool.size > 0 ? ` seekFallbackAssets=${exportVideoPool.size}` : ''),
    )
    perfWin.frames = perfWin.gpuFrames = perfWin.decodeMs = perfWin.drawMs = perfWin.encodeMs = 0
    perfWin.encSubmitMs = perfWin.encDrainMs = perfWin.sinkWaitMs = perfWin.yieldMs = perfWin.maxQueue = 0
    perfWin.captionFrames = perfWin.captionRedraws = 0
    const stats = exportReaderPool.getStats()
    perfWin.poolCreates0 = stats.creates
    perfWin.poolTransient0 = stats.transientOpens
    perfWin.poolReleases0 = stats.releases
    perfWin.poolHandoffs0 = stats.handoffs
    perfWin.poolFramePrewarms0 = stats.framePrewarms
    perfWin.poolDegraded0 = stats.degradedAcquires
    perfWin.readerResets0 = frameReaderStats.resets
    perfWin.readerBackwardResets0 = frameReaderStats.backwardResets
    perfWin.readerForwardResets0 = frameReaderStats.forwardResets
    perfWin.readerConfigures0 = frameReaderStats.configures
    perfWin.readerSourceReadCalls0 = frameReaderStats.sourceReadCalls
    perfWin.readerSourceReadBytes0 = frameReaderStats.sourceReadBytes
    perfWin.readerSourceReadMs0 = frameReaderStats.sourceReadMs
    perfWin.readerChunksSubmitted0 = frameReaderStats.chunksSubmitted
    perfWin.readerFramesOutput0 = frameReaderStats.framesOutput
    perfWin.readerHardware0 = frameReaderStats.hardwareConfigures
    perfWin.readerSoftware0 = frameReaderStats.softwareConfigures
    perfWin.readerHardwareFallback0 = frameReaderStats.hardwareFallbacks
    perfWin.start = performance.now()
  }
  const logPerfTotal = () => {
    if (perfTotal.frames === 0) return
    const elapsed = performance.now() - perfTotal.start
    const per = (value: number) => (value / perfTotal.frames).toFixed(1)
    const poolStats = exportReaderPool.getStats()
    const coldCalls = frameReaderStats.coldDecodeCalls - readerStatsStart.coldDecodeCalls
    const resetCalls = frameReaderStats.resetDecodeCalls - readerStatsStart.resetDecodeCalls
    const steadyCalls = frameReaderStats.steadyDecodeCalls - readerStatsStart.steadyDecodeCalls
    const callAverage = (ms: number, calls: number) => calls > 0 ? (ms / calls).toFixed(1) : '0.0'
    const coldAvg = callAverage(frameReaderStats.coldDecodeMs - readerStatsStart.coldDecodeMs, coldCalls)
    const resetAvg = callAverage(frameReaderStats.resetDecodeMs - readerStatsStart.resetDecodeMs, resetCalls)
    const steadyAvg = callAverage(frameReaderStats.steadyDecodeMs - readerStatsStart.steadyDecodeMs, steadyCalls)
    const inputChunks = frameReaderStats.chunksSubmitted - readerStatsStart.chunksSubmitted
    const decodedFrames = frameReaderStats.framesOutput - readerStatsStart.framesOutput
    const sourceReadCalls = frameReaderStats.sourceReadCalls - readerStatsStart.sourceReadCalls
    const sourceReadBytes = frameReaderStats.sourceReadBytes - readerStatsStart.sourceReadBytes
    const sourceReadMs = frameReaderStats.sourceReadMs - readerStatsStart.sourceReadMs
    const sourceCacheHits = frameReaderStats.sourceCacheHits - readerStatsStart.sourceCacheHits
    const sourceCacheMisses = frameReaderStats.sourceCacheMisses - readerStatsStart.sourceCacheMisses
    const sourceCacheBytesServed =
      frameReaderStats.sourceCacheBytesServed - readerStatsStart.sourceCacheBytesServed
    const sourceRateObservations =
      frameReaderStats.sourceRateObservations - readerStatsStart.sourceRateObservations
    const sourceRateTotal = frameReaderStats.sourceRateTotal - readerStatsStart.sourceRateTotal
    // eslint-disable-next-line no-console
    console.info(
      `[export perf total] fps=${((perfTotal.frames * 1000) / elapsed).toFixed(1)} ` +
        `frames=${perfTotal.frames} decode=${per(perfTotal.decodeMs)}ms ` +
        `draw=${per(perfTotal.drawMs)}ms encode+bp=${per(perfTotal.encodeMs)}ms ` +
        `path=${perfTotal.gpuFrames === perfTotal.frames
          ? 'gpu'
          : perfTotal.gpuFrames === 0
            ? '2d'
            : `mixed(${perfTotal.gpuFrames}/${perfTotal.frames}gpu)`} ` +
        `zeroCopy=${zeroCopyState} surface=${zeroCopySurface} worker=${isWorker} ` +
        `captions=${perfTotal.captionRedraws}/${perfTotal.captionFrames}` +
        ` churn(creates=${poolStats.creates} transient=${poolStats.transientOpens} ` +
        `release=${poolStats.releases} handoffs=${poolStats.handoffs} ` +
        `predecoded=${poolStats.framePrewarms} ` +
        `degraded=${poolStats.degradedAcquires} ` +
        `seekResets=${frameReaderStats.resets - readerStatsStart.resets}` +
        `(back=${frameReaderStats.backwardResets - readerStatsStart.backwardResets} ` +
        `fwd=${frameReaderStats.forwardResets - readerStatsStart.forwardResets}) ` +
        `decoderInits=${frameReaderStats.configures - readerStatsStart.configures} ` +
        `decoderHwReq=${frameReaderStats.hardwareConfigures - readerStatsStart.hardwareConfigures} ` +
        `decoderSw=${frameReaderStats.softwareConfigures - readerStatsStart.softwareConfigures} ` +
        `hwFallback=${frameReaderStats.hardwareFallbacks - readerStatsStart.hardwareFallbacks}) ` +
        `readerCost(cold=${coldCalls}@${coldAvg}ms reset=${resetCalls}@${resetAvg}ms ` +
        `steady=${steadyCalls}@${steadyAvg}ms) ` +
        `sourceRate=${(sourceRateTotal / Math.max(1, sourceRateObservations)).toFixed(1)}fps ` +
        `decodeWork(chunks=${inputChunks} output=${decodedFrames} ` +
        `chunksPerFrame=${(inputChunks / Math.max(1, perfTotal.frames)).toFixed(2)} ` +
        `sourceRead=${sourceReadCalls}@${(sourceReadMs / Math.max(1, sourceReadCalls)).toFixed(1)}ms ` +
        `${(sourceReadBytes / (1024 * 1024)).toFixed(1)}MB ` +
        `rangeCache=${sourceCacheHits}/${sourceCacheMisses} ` +
        `${(sourceCacheBytesServed / (1024 * 1024)).toFixed(1)}MB)` +
        (exportVideoPool.size > 0 ? ` seekFallbackAssets=${exportVideoPool.size}` : ''),
    )
  }
  for (let f = 0; f < totalFrames; f++) {
    try {
    if (isAborted()) await fail(new DOMException('Export cancelled', 'AbortError'))
    if (encoderFatal) await fail(new Error(`VideoEncoder failed: ${String(encoderFatal)}`))

    const t = f / fps
    const tPhase0 = performance.now()
    // Do not touch the full-resolution Canvas2D surface unless this frame
    // actually needs the safe path. A 4K zero-copy export used to clear ~33 MB
    // of CPU pixels every frame even though VideoEncoder consumed gpu.canvas.
    let canvasPrepared = false
    const prepareCanvasFrame = () => {
      if (canvasPrepared) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.filter = 'none'
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      canvasPrepared = true
    }

    // S6: sweep cursor — O(events advanced + active), not O(all clips) per frame.
    const activeVideo = videoSweep.advanceTo(t)

    // Pre-fetch all media sources for this frame once — both GPU and Canvas 2D
    // paths read from this map so seeks/decodes only happen once per frame.
    const clipSources = new Map<string, RenderPlanSourceInfo & {
      source: HTMLVideoElement | HTMLImageElement | VideoFrame | ImageBitmap
    }>()

    // S7: release readers whose mapping left the active set, then acquire by
    // sourceMappingKey so overlapping duplicates keep independent decoders.
    const activeMappingKeys = new Set<string>()
    const activeImageIds = new Set<string>()
    for (const clip of activeVideo) {
      if (!clip.assetId) continue
      const asset = assetById.get(clip.assetId)
      if (!asset) continue
      if (asset.kind === 'image') {
        activeImageIds.add(asset.id)
        continue
      }
      if (asset.kind !== 'video') continue
      if (!canUseWebCodecsSource(asset)) continue
      const key = sourceMappingKey(clip)
      if (key) activeMappingKeys.add(key)
    }
    exportReaderPool.releaseUnused(activeMappingKeys)
    // Image decode surfaces are proportional to source resolution. Retain only
    // images visible in this frame instead of every image ever seen on a long
    // timeline.
    for (const [assetId, image] of exportImagePool) {
      if (activeImageIds.has(assetId)) continue
      if (image instanceof ImageBitmap) image.close()
      else image.src = ''
      exportImagePool.delete(assetId)
    }

    for (const clip of activeVideo) {
      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
      if (!asset) continue
      if (asset.kind === 'video') {
        const srcSec = clipSourceSec(clip, t)
        const mapKey = sourceMappingKey(clip)
        if (mapKey && canUseWebCodecsSource(asset)) {
          let vf: VideoFrame | null = null
          try {
            const { reader } = await exportReaderPool.acquire(mapKey, asset.id)
            vf = await reader.getFrameAt(srcSec)
          } catch (e) {
            const unsupported = isBrowserVideoUnsupportedError(e)
            if (isWorker) {
              if (!unsupported) await fail(e)
              await fail(new DOMException(
                `Worker cannot decode video asset ${asset.name}: ${String(e)}`,
                'NotSupportedError',
              ))
            }
            if (!unsupported) await fail(e)
            // Falling to the <video>-seek path caps this export at roughly
            // 20 fps (measured: one seek ≈ 35-50 ms). That is the difference
            // between a 30-second export and a 10-minute one, so it must NEVER
            // happen silently.
            if (!webCodecsUnsupported.has(asset.id)) {
              console.warn(
                `[export] "${asset.name}" cannot use the fast WebCodecs decoder (${String(e)}). ` +
                  'Falling back to <video>-seek decoding (~20 fps). ' +
                  'Server (FFmpeg) export handles this file at full speed.',
              )
              onProgress(directOutput?.hybridSpec
                ? {
                    frame: (f / totalFrames) * 95,
                    total: 100,
                    phase: 'encoding',
                    renderedFrame: f,
                    renderedTotal: totalFrames,
                    seekFallbackAsset: asset.name,
                  }
                : {
                    frame: f,
                    total: totalFrames,
                    phase: 'encoding',
                    renderedFrame: f,
                    renderedTotal: totalFrames,
                    seekFallbackAsset: asset.name,
                  })
            }
            webCodecsUnsupported.add(asset.id)
          }
          // Clone so this clip keeps its own frame: the reader owns `vf` and
          // closes/invalidates it on the next getFrameAt. Even with separate
          // readers, clone keeps ownership clear (export closes clones at EOP).
          if (vf) {
            const clone = vf.clone()
            frameOwnedVideoFrames.add(clone)
            clipSources.set(clip.id, {
              source: clone,
              sourceW: vf.displayWidth || width,
              sourceH: vf.displayHeight || height,
              frameVersion: f,
            })
            continue
          }
        }
        if (!isWorker) {
          try {
            const el = await ensureHtmlVideo(asset)
            const frameEps = Math.max(clip.speed, 0.01) / (fps * 2)
            // Key lastSeek by mapping so two clips of one asset don't share cursor.
            const seekKey = mapKey || asset.id
            if (Math.abs((lastSeek.get(seekKey) ?? -1) - srcSec) > frameEps) {
              await seekVideoToSec(el, srcSec, `video seek ${asset.name}`)
              lastSeek.set(seekKey, srcSec)
            }
            if (el.readyState >= 2) {
              clipSources.set(clip.id, {
                source: el,
                sourceW: el.videoWidth || width,
                sourceH: el.videoHeight || height,
                frameVersion: el.currentTime,
              })
            }
          } catch (e) {
            await fail(e)
          }
        }
      } else if (asset.kind === 'image') {
        try {
          const img = await ensureImage(asset)
          const sw = img instanceof HTMLImageElement ? img.naturalWidth || width : img.width || width
          const sh = img instanceof HTMLImageElement ? img.naturalHeight || height : img.height || height
          clipSources.set(clip.id, {
            source: img,
            sourceW: sw,
            sourceH: sh,
            frameVersion: 0,
          })
        } catch (e) {
          await fail(e)
        }
      }
    }

    // Prime the first frame only for a predicted source discontinuity while the
    // current frame is being drawn/encoded. Sequential cuts remain on the warm
    // handoff path, so dense timelines do not allocate one decoder per clip.
    for (const clip of activeVideo) {
      const next = nextVideoClipById.get(clip.id)
      // Never prewarm a clip that is already active (overlapping layers can
      // make the adjacent clip visible before the current one ends).
      if (!next || next.startSec <= t || next.startSec - t > prewarmWindowSec) continue
      if (!shouldPredecodeAdjacentCut(clip, next)) continue
      const asset = next.assetId ? assetById.get(next.assetId) : undefined
      if (!asset || asset.kind !== 'video' || !canUseWebCodecsSource(asset)) continue
      const key = sourceMappingKey(next)
      if (!key) continue
      const sameAsset = next.assetId === clip.assetId
      const backwardJump = sameAsset && next.inPointSec < clip.outPointSec - 1 / 60
      void exportReaderPool.prewarmFrame(key, asset.id, next.inPointSec, {
        // A backward jump is expensive enough to justify opening a dedicated
        // reader. A forward jump must reuse an already-warm sibling or skip;
        // this avoids the create/release regression seen on short reviews.
        allowCreate: !sameAsset || backwardJump,
      })
      // At most one adjacent mapping is requested per frame; prewarmFrame also
      // deduplicates the cut and enforces one global in-flight decode.
      break
    }

    const tPhase1 = performance.now() // sources ready (reader decode / seeks done)

    // Overlay clip lists for this frame (fx + text, drawn after the media pass).
    const activeFx = fxSweep.advanceTo(t)
    const activeText = textSweep.advanceTo(t)
    const renderPlan = buildRenderPlan({
      mediaClips: activeVideo,
      captionClips: activeText,
      fxClips: activeFx,
      tracks,
      outputWidth: width,
      outputHeight: height,
      timelineSec: t,
      overlayFrameVersion: f,
      sources: clipSources,
    })
    // GPU path: composite all media clips through the WebGPU shader (handles
    // brightness/contrast/saturation, rotation, flip, crop, and the blurred
    // letterbox background natively). Falls back to Canvas 2D only when the GPU
    // is unavailable or the device was lost.
    let drewOnGpu = false
    let captionsRenderedOnGpu = false
    let encodeSource: HTMLCanvasElement | OffscreenCanvas | ImageBitmap = canvas
    let encodeBitmap: ImageBitmap | null = null

    if (gpu && !gpuLost) {
      let drawDescriptors: RenderPlanDrawDescriptor[] = renderPlan.mediaDraws
      // Effects still use Canvas2D and must remain below captions. When no effect
      // is active, upload one transparent full-frame caption layer after all
      // media draws. This keeps drawTextClip as the single parity renderer while
      // allowing the final WebGPU canvas to feed VideoEncoder directly.
      //
      // Only pay for this per-frame caption texture upload when zero-copy is
      // actually armed AND the frame is otherwise zero-copy-eligible (no fx).
      // When zero-copy is off (the default) or fx forces the 2D compositing
      // path, the caption canvas is drawn straight onto the encode surface in
      // Canvas 2D below — the same path preview uses — at no upload cost.
      // Uploading a full-resolution RGBA caption texture every frame regardless
      // (the previous behaviour) is what regressed sustained export throughput
      // from ~300 to ~120fps on caption-heavy timelines: the cache never hit
      // (frameVersion == frame index) so ~8 MB/frame at 1080p (~33 MB at 4K)
      // crossed the bus each frame for output that then just got blitted back
      // to the 2D canvas anyway.
      const zeroCopyArmed =
        settings.browserZeroCopy === 'auto' && renderPlan.fxClips.length === 0
      let frameCaptionOverlayAdded = false
      if (zeroCopyArmed && renderPlan.captionOverlayDraw) {
        const overlayCtx = getCaptionGpuContext()
        if (overlayCtx && captionGpuCanvas) {
          perfWin.captionFrames++
          perfTotal.captionFrames++
          const stateKey = JSON.stringify(
            renderPlan.captionClips.map((clip) =>
              captionVisualStateKey(overlayCtx, clip, width, height, t)),
          )
          if (stateKey !== captionOverlayStateKey) {
            captionOverlayStateKey = stateKey
            captionOverlayFrameVersion++
            perfWin.captionRedraws++
            perfTotal.captionRedraws++
            overlayCtx.setTransform(1, 0, 0, 1, 0, 0)
            overlayCtx.globalAlpha = 1
            overlayCtx.filter = 'none'
            overlayCtx.clearRect(0, 0, width, height)
            for (const clip of renderPlan.captionClips) {
              drawTextClip(overlayCtx, clip, width, height, t)
            }
          }
          drawDescriptors = [
            ...drawDescriptors,
            {
              ...renderPlan.captionOverlayDraw,
              frameVersion: captionOverlayFrameVersion,
            },
          ]
          frameCaptionOverlayAdded = true
        }
      }
      const draws = resolveRenderPlanDraws(drawDescriptors, (clipId) =>
        clipId === CAPTION_OVERLAY_CLIP_ID
          ? captionGpuCanvas
          : clipSources.get(clipId)?.source ?? null)
      gpu.retainTextures(new Set(draws.map((draw) => draw.cacheKey ?? draw.assetId)))
      if (draws.length === 0) {
        prepareCanvasFrame()
        drewOnGpu = true // nothing on screen this frame; encode the safe black frame
      } else {
        const status = gpu.render(draws)
        if (status === 'ok') {
          captionsRenderedOnGpu = frameCaptionOverlayAdded
          const overlayFree =
            renderPlan.fxClips.length === 0 &&
            (renderPlan.captionClips.length === 0 || frameCaptionOverlayAdded)
          let useZeroCopy = settings.browserZeroCopy === 'auto' && overlayFree
          if (useZeroCopy && !canStartZeroCopy(f, zeroCopyRealPathVerified)) {
            // Safe fallback: keep this export on the existing Canvas2D-fed
            // encoder session. Never introduce a second decoder configuration
            // after earlier samples have already entered the MP4.
            if (zeroCopyState !== 'fallback') zeroCopyState = 'ineligible'
            zeroCopyProbeComplete = true
            useZeroCopy = false
          }
          if (useZeroCopy && !zeroCopyProbeComplete) {
            // The one-time sacrificial probe still uses the strict queue fence.
            // No real muxer sample exists yet, so a driver stall can degrade to
            // Canvas2D without corrupting output.
            const presented = await withDeadline(
              gpu.waitForPresentedFrame(),
              5_000,
              'WebGPU frame presentation',
            ).catch(() => false)
            if (!presented) {
              zeroCopyState = 'fallback'
              zeroCopyProbeComplete = true
              useZeroCopy = false
            } else {
              zeroCopyProbeComplete = true
              const supported = await probeGpuZeroCopy(gpu.canvas, pickedVideo.config)
              zeroCopyState = supported ? 'active' : 'fallback'
              useZeroCopy = supported
            }
          } else if (useZeroCopy && zeroCopyState !== 'active') {
            useZeroCopy = false
          }
          if (useZeroCopy) {
            // In a worker, detach this frame into an immutable ImageBitmap. The
            // next WebGPU submission gets a fresh drawing buffer, so the encoder
            // no longer forces a full onSubmittedWorkDone() fence every frame.
            // If transfer is unavailable/unsupported, retain the old fenced
            // canvas path for compatibility with older WebViews and drivers.
            encodeBitmap = gpu.transferPresentedFrame()
            if (encodeBitmap) {
              encodeSource = encodeBitmap
              zeroCopySurface = 'image-bitmap'
            } else {
              const presented = await withDeadline(
                gpu.waitForPresentedFrame(),
                5_000,
                'WebGPU frame presentation',
              ).catch(() => false)
              if (presented) {
                encodeSource = gpu.canvas
                zeroCopySurface = 'canvas-fence'
              } else {
                zeroCopyState = 'fallback'
                useZeroCopy = false
              }
            }
          }
          if (!useZeroCopy) {
            prepareCanvasFrame()
            ctx.drawImage(gpu.canvas, 0, 0, width, height)
          }
          drewOnGpu = true
        } else if (status === 'lost') {
          gpuLost = true
          try { gpu.destroy() } catch { /* already lost */ }
          gpu = null
        }
        // 'empty' → all sources tainted/undecodeable → fall through to Canvas 2D
      }
    }

    if (!drewOnGpu) {
      prepareCanvasFrame()
      for (const clip of activeVideo) {
        const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
        if (!asset) continue
        const s = clipSources.get(clip.id)
        if (!s) continue
        ctx.globalAlpha = resolveClipOpacityAt(clip, t)
        const transform = resolveClipTransformAt(clip, t)
        const adjustFilter = clip.adjust && !isAdjustNeutral(clip.adjust) ? adjustToFilter(clip.adjust) : 'none'
        // Rasterize VideoFrame sources to RGBA so the filtered draws below don't
        // come out green (Chromium's filter path can't handle a planar VideoFrame).
        const drawSource = rasterizeForFilter(s.source)
        ctx.filter = adjustFilter
        drawCanvasFillCtx(ctx, drawSource, width, height, transform, clip.canvasFill, adjustFilter)
        ctx.filter = adjustFilter
        fitDrawCtx(ctx, drawSource, width, height, transform)
        ctx.filter = 'none'
        ctx.globalAlpha = 1
      }
    }

    if (renderPlan.fxClips.length > 0) prepareCanvasFrame()
    for (const clip of renderPlan.fxClips) {
      if (clip.fxData?.type === 'blur-sticker') drawBlurSticker(ctx, clip.fxData, width, height)
      else if (clip.fxData?.type === 'filter') drawFilterFx(ctx, canvasFilterString(clip.fxData), width, height)
    }

    // Captions: THE shared renderer (engine/timeline/draw-caption) — the exact
    // same code path the preview uses, so export text can never drift from it.
    if (!captionsRenderedOnGpu) {
      if (renderPlan.captionClips.length > 0) prepareCanvasFrame()
      for (const clip of renderPlan.captionClips) drawTextClip(ctx, clip, width, height, t)
    }

    const tPhase2 = performance.now() // frame composited (gpu or 2d + fx + captions)

    if (encodeSource !== canvas && !zeroCopyRealPathVerified) {
      // Drain earlier Canvas2D frames so the output counter below belongs only
      // to this first direct GPU frame; otherwise a late prior callback could
      // make an unsafe replay look impossible.
      try {
        await withDeadline(encoder.flush(), 30_000, 'pre-zero-copy encoder drain')
      } catch (e) {
        await fail(e)
      }
    }
    const encodedBeforeFrame = encodedVideoChunks
    const encodeOptions = {
      keyFrame: keyFrameFrames.has(f) || f % maxKeyframeFrames === 0,
    }
    const tEncSubmit = performance.now()
    let frame: VideoFrame
    try {
      frame = new VideoFrame(encodeSource, {
        timestamp: Math.round(t * 1_000_000),
        duration: Math.round((1 / fps) * 1_000_000),
      })
    } catch (e) {
      encodeBitmap?.close()
      encodeBitmap = null
      throw e
    }
    let encodeSubmitted = false
    try {
      encoder.encode(frame, encodeOptions)
      encodeSubmitted = true
    } finally {
      // encode() may throw synchronously after a hardware/device loss. This
      // frame is not part of frameOwnedVideoFrames, so close it locally.
      frame.close()
      if (!encodeSubmitted) {
        encodeBitmap?.close()
        encodeBitmap = null
      }
    }
    perfWin.encSubmitMs += performance.now() - tEncSubmit
    perfWin.maxQueue = Math.max(perfWin.maxQueue, encoder.encodeQueueSize)

    if (encodeSource !== canvas && !zeroCopyRealPathVerified) {
      try {
        // The sacrificial probe protects the muxer; this verifies the real
        // encoder session too. flush() is legal mid-stream and guarantees the
        // first direct GPU frame has produced output before we continue.
        await withDeadline(encoder.flush(), 5_000, 'WebGPU zero-copy real encoder')
        zeroCopyRealPathVerified = true
      } catch (e) {
        if (
          encodedVideoChunks !== encodedBeforeFrame ||
          !canRestartVideoEncoder(encodedVideoChunks)
        ) {
          // Some real output is already in the muxer, so replaying the frame
          // would corrupt timestamps. Funnel this rare late failure through the
          // normal teardown rather than pretending fallback is still possible.
          await fail(e)
        }
        encoderGeneration++ // invalidate already-posted callbacks before close()
        try { encoder.close() } catch { /* stalled session */ }
        encoderFatal = null
        encoder = createConfiguredVideoEncoder()
        zeroCopyState = 'fallback'
        zeroCopyRealPathVerified = true
        prepareCanvasFrame()
        ctx.drawImage(encodeSource, 0, 0, width, height)
        const safeFrame = new VideoFrame(canvas, {
          timestamp: Math.round(t * 1_000_000),
          duration: Math.round((1 / fps) * 1_000_000),
        })
        try {
          encoder.encode(safeFrame, encodeOptions)
        } finally {
          safeFrame.close()
        }
      }
    }

    // VideoFrame owns the submitted image from here. Keep a detached bitmap
    // alive through the first-frame fallback replay above, then release it so a
    // long export cannot retain one GPU surface per frame.
    encodeBitmap?.close()
    encodeBitmap = null

    // Close the per-clip VideoFrame clones we took this frame (we own them;
    // the reader owns its originals). Images/elements are pooled — leave them.
    for (const s of clipSources.values()) {
      if (s.source instanceof VideoFrame) {
        s.source.close()
        frameOwnedVideoFrames.delete(s.source)
      }
    }

    if (directOutput?.hybridSpec) {
      onProgress({
        frame: ((f + 1) / totalFrames) * 95,
        total: 100,
        phase: 'encoding',
        renderedFrame: f + 1,
        renderedTotal: totalFrames,
        zeroCopy: zeroCopyState,
        videoCodec: pickedVideo.codec,
      })
    } else {
      onProgress({
        frame: f + 1,
        total: totalFrames,
        phase: 'encoding',
        renderedFrame: f + 1,
        renderedTotal: totalFrames,
        zeroCopy: zeroCopyState,
        videoCodec: pickedVideo.codec,
      })
    }

    // Backpressure with hysteresis (see ENCODER_QUEUE_HIGH/LOW): only start
    // draining once the queue is genuinely deep, then drain a whole batch so the
    // ~2ms-per-`dequeue`-event cost is paid once per ~(HIGH-LOW) frames instead
    // of every frame. Holding at a single mark (the previous behaviour) capped
    // throughput at the event round-trip rate, not the encoder's real rate.
    // STALL GUARD: this loop used to have no abort check and no timeout — a
    // dead encoder spun here forever at "100%", unkillable even by Cancel.
    if (encoder.encodeQueueSize > ENCODER_QUEUE_HIGH) {
      const tDrain = performance.now()
      let lastQueue = encoder.encodeQueueSize
      let lastProgress = Date.now()
      while (encoder.encodeQueueSize > ENCODER_QUEUE_LOW) {
        if (isAborted()) await fail(new DOMException('Export cancelled', 'AbortError'))
        if (encoderFatal) await fail(new Error(`VideoEncoder failed: ${String(encoderFatal)}`))
        const q = encoder.encodeQueueSize
        if (q < lastQueue) {
          lastQueue = q
          lastProgress = Date.now()
        } else if (Date.now() - lastProgress > 15_000) {
          await fail(new Error('VideoEncoder stalled: no encoded output for 15s (hardware encoder session lost?)'))
        }
        await waitForEncoderDequeue(encoder)
      }
      perfWin.encDrainMs += performance.now() - tDrain
    } else if (
      (isWorker && f % 24 === 23) ||
      (!isWorker && performance.now() - lastCooperativeYield >= 16)
    ) {
      const tYield = performance.now()
      await yieldToMacrotask()
      lastCooperativeYield = performance.now()
      perfWin.yieldMs += lastCooperativeYield - tYield
    }
    if (directSink) {
      const tSink = performance.now()
      try {
        await directSink.waitForCapacity(isAborted)
      } catch (e) {
        await fail(e)
      }
      perfWin.sinkWaitMs += performance.now() - tSink
    }
    const frameEnd = performance.now()
    const decodeElapsed = tPhase1 - tPhase0
    const drawElapsed = tPhase2 - tPhase1
    const encodeElapsed = frameEnd - tPhase2
    perfWin.frames++
    perfTotal.frames++
    if (drewOnGpu) {
      perfWin.gpuFrames++
      perfTotal.gpuFrames++
    }
    perfWin.decodeMs += decodeElapsed
    perfTotal.decodeMs += decodeElapsed
    perfWin.drawMs += drawElapsed
    perfTotal.drawMs += drawElapsed
    perfWin.encodeMs += encodeElapsed
    perfTotal.encodeMs += encodeElapsed
    logPerfWindow()
    } catch (e) {
      // Canvas/WebGPU/WebCodecs expose synchronous failure paths. Funnel every
      // one through the bounded teardown so repeated exports cannot leak VRAM,
      // decoder readers, OPFS locks, or a backend stream reservation.
      if (teardownStarted) throw e
      await fail(e)
    }
  }
  logPerfTotal()

  // 5. Flush the encoder (video chunks streamed into the muxer as emitted).
  onProgress(directOutput?.hybridSpec
    ? { frame: 95, total: 100, phase: 'muxing' }
    : { frame: totalFrames, total: totalFrames, phase: 'muxing' })
  try {
    await withAbortAndDeadline(encoder.flush(), abortSignal, 30_000, 'VideoEncoder.flush')
  } catch (e) {
    await fail(e)
  }
  try {
    encoder.close()
  } catch (e) {
    await fail(e)
  }

  // 6. Encode audio — prefer S3B stream (bounded memory); else pre-mixed PCM.
  if (audioStream) {
    try {
      await encodeAudioStream(
        audioStream,
        muxer,
        isAborted,
        audioBitrate,
        directSink ? () => directSink!.waitForCapacity(isAborted) : undefined,
      )
    } catch (e) {
      await fail(e)
    }
  } else if (pcmAudio) {
    try {
      await encodeAudio(
        pcmAudio,
        muxer,
        audioBitrate,
        directSink ? () => directSink!.waitForCapacity(isAborted) : undefined,
      )
    } catch (e) {
      await fail(e)
    }
  }

  try {
    muxer.finalize()
  } catch (e) {
    await fail(e)
  }
  try { gpu?.destroy() } catch { /* device gone */ }
  releaseLoadedMedia()
  releaseFxBuffers('export-')

  if (directSink) {
    try {
      const savedPath = await directSink.finalize(
        isAborted,
        abortSignal,
        directOutput?.hybridSpec
          ? (pct) => onProgress({ frame: 95 + pct * 0.05, total: 100, phase: 'muxing' })
          : undefined,
        pickedVideo.codec,
      )
      onProgress(directOutput?.hybridSpec
        ? { frame: 100, total: 100, phase: 'done' }
        : { frame: totalFrames, total: totalFrames, phase: 'done' })
      return { blob: null, savedPath, videoCodec: pickedVideo.codec, zeroCopy: zeroCopyState }
    } catch (e) {
      await fail(e)
    }
  }

  if (opfsWritable) {
    try {
      // waits for all queued positioned writes
      await withAbortAndDeadline(opfsWritable.close(), abortSignal, 60_000, 'OPFS finalize')
      const blob = await readBlob(scratchKey)
      if (!blob) throw new Error('Export scratch file missing after finalize')
      onProgress({ frame: totalFrames, total: totalFrames, phase: 'done' })
      return { blob, videoCodec: pickedVideo.codec, zeroCopy: zeroCopyState }
    } catch (e) {
      await fail(e)
    }
  }
  const { buffer } = muxer.target as ArrayBufferTarget
  onProgress({ frame: totalFrames, total: totalFrames, phase: 'done' })
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    videoCodec: pickedVideo.codec,
    zeroCopy: zeroCopyState,
  }
}

/**
 * Main-thread entry point: mixes audio then delegates to exportVideoCore.
 * S3B: prefers block-streaming mix (no full-timeline OfflineAudioContext) when
 * OfflineAudioContext is available. Falls back to S3A-gated full offline mix
 * only when streaming is unavailable.
 * For non-blocking export, use the export worker instead (PCM pre-mixed or
 * long-form main-thread path with streaming).
 */
export async function exportVideo(
  settings: ExportSettings,
  durationSec: number,
  clips: Clip[],
  tracks: Track[],
  assets: MediaAsset[],
  urlCache: Map<string, string>,
  audioBuffers: Map<string, AudioBuffer>,
  signal: AbortSignal,
  onProgress: OnProgress,
  directOutput?: BrowserDirectOutput,
  scratchKey: string = EXPORT_TMP_KEY,
  desktopVideoSource?: DesktopVideoSourceReader,
): Promise<BrowserExportResult> {
  const totalFrames = Math.max(1, Math.ceil(durationSec * settings.fps))
  onProgress({ frame: 0, total: totalFrames, phase: 'audio' })

  const hasAudible = clips.some(
    (c) => isExportAudibleClip(c, tracks) && !!c.assetId && audioBuffers.has(c.assetId),
  )
  // Encode gate (#8): require real AAC AudioEncoder support, not merely mix CPU.
  const quality = exportQualityDefinition(settings.qualityProfile)
  const audioBitrate = Math.max(
    64_000,
    Math.round((settings.audioBitrateKbps ?? quality.audioBitrateKbps) * 1_000),
  )
  if (hasAudible && (await isStreamingAudioEncodeSupported(audioBitrate))) {
    // S3B path: generator is pull-driven inside encodeAudioStream after video.
    const createStream = () => streamMixAudioBlocks({
        durationSec,
        clips,
        tracks,
        audioBuffers,
        signal,
      })
    const mastering = settings.audioMastering ?? 'off'
    let audioStream: AsyncIterable<StreamMixBlock>
    if (mastering === 'off') {
      audioStream = createStream()
    } else {
      // Report the loudness-analysis pass as the 'audio' phase so a long export
      // does not sit at 0% while the two-pass mix runs before any video frame.
      const analysisFrames = Math.max(1, Math.ceil(durationSec * SAMPLE_RATE))
      const analysis = await analyzeAudioBlocks(createStream(), signal, (frames) => {
        onProgress({
          frame: Math.min(totalFrames, Math.round((frames / analysisFrames) * totalFrames)),
          total: totalFrames,
          phase: 'audio',
        })
      })
      audioStream = masterAudioBlocks(createStream(), mastering, analysis, signal)
    }
    return exportVideoCore(
      settings,
      durationSec,
      clips,
      tracks,
      assets,
      urlCache,
      null,
      () => signal.aborted,
      onProgress,
      audioStream,
      directOutput,
      scratchKey,
      signal,
      desktopVideoSource,
    )
  }

  // Fallback: full offline mix behind S3A budget gate.
  const audioMix = await renderAudioMix(durationSec, clips, tracks, audioBuffers, signal)
  const pcmAudio = audioMix ? audioMixToPcm(audioMix) : null
  return exportVideoCore(
    settings,
    durationSec,
    clips,
    tracks,
    assets,
    urlCache,
    pcmAudio,
    () => signal.aborted,
    onProgress,
    undefined,
    directOutput,
    scratchKey,
    signal,
    desktopVideoSource,
  )
}
