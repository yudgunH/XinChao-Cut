import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer'

import {
  adjustToFilter,
  clipEffectiveDuration,
  clipIsActiveAt,
  clipSourceSec,
  isAdjustNeutral,
  makeDefaultTransform,
  resolveClipTransformAt,
  resolveClipOpacityAt,
} from '@engine/timeline'
import type { BlurStickerData, Clip, ClipTransform, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

import { measureWrappedText, drawWrappedLines, drawCaptionReveal, getCurrentRevealUnit } from '@engine/timeline/text-layout'

import { createDenoiseNode, loadDenoiseModule } from '@engine/audio/denoise'
import { createWritable, readBlob, deleteBlob } from '@engine/persistence/opfs'

import { createVideoFrameReader, type VideoFrameReader } from './frame-reader'

const TEXT_MAX_WIDTH_RATIO = 0.92

/** OPFS scratch file the export muxer streams into (overwritten per export). */
const EXPORT_TMP_KEY = '__export-tmp.mp4'

export interface ExportSettings {
  width: number
  height: number
  fps: number
  videoBitrateKbps: number
}

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

const SAMPLE_RATE = 48000
const AUDIO_BITRATE = 128_000
const AUDIO_CHANNELS = 2
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
}

export type OnProgress = (p: ExportProgress) => void

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
async function pickVideoConfig(
  base: Omit<VideoEncoderConfig, 'codec'>,
): Promise<VideoEncoderConfig> {
  for (const hw of ['prefer-hardware', 'no-preference'] as const) {
    for (const codec of AVC_CODECS) {
      const cfg: VideoEncoderConfig = { ...base, codec, hardwareAcceleration: hw }
      try {
        const support = await VideoEncoder.isConfigSupported(cfg)
        if (support.supported) return cfg
      } catch {
        /* try next */
      }
    }
  }
  // Nothing reported support — hand back a Baseline config and let configure()
  // surface a meaningful error if the machine truly can't encode H.264.
  return { ...base, codec: 'avc1.420034' }
}

function seekVideoToSec(el: HTMLVideoElement, sec: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - sec) < 0.001) {
      resolve()
      return
    }
    const onSeeked = () => {
      el.removeEventListener('seeked', onSeeked)
      resolve()
    }
    el.addEventListener('seeked', onSeeked)
    el.currentTime = sec
  })
}

function fitDrawCtx(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement | HTMLImageElement | VideoFrame,
  cw: number,
  ch: number,
  transform: ClipTransform,
) {
  const t = { ...makeDefaultTransform(), ...transform }
  const sw =
    src instanceof HTMLVideoElement
      ? src.videoWidth || cw
      : src instanceof HTMLImageElement
        ? src.naturalWidth || cw
        : src.displayWidth || cw
  const sh =
    src instanceof HTMLVideoElement
      ? src.videoHeight || ch
      : src instanceof HTMLImageElement
        ? src.naturalHeight || ch
        : src.displayHeight || ch
  const scale = Math.min(cw / sw, ch / sh) * Math.max(0.05, t.scale)
  const dw = sw * scale * Math.max(MIN_AXIS_SCALE, t.scaleX)
  const dh = sh * scale * Math.max(MIN_AXIS_SCALE, t.scaleY)
  ctx.save()
  ctx.translate(t.x * cw, t.y * ch)
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180)
  ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh)
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

function drawBlurSticker(
  ctx: CanvasRenderingContext2D,
  fx: BlurStickerData,
  cw: number,
  ch: number,
): void {
  const rect = clampRect(getBlurStickerRect(fx, cw, ch), cw, ch)
  if (rect.w < 1 || rect.h < 1) return
  const blur = Math.max(0, Math.min(80, fx.blurPx))
  const pad = Math.ceil(blur * 2)
  const sx = Math.max(0, Math.floor(rect.x - pad))
  const sy = Math.max(0, Math.floor(rect.y - pad))
  const sw = Math.min(cw - sx, Math.ceil(rect.w + pad * 2))
  const sh = Math.min(ch - sy, Math.ceil(rect.h + pad * 2))
  if (sw <= 0 || sh <= 0) return

  const buffer = document.createElement('canvas')
  buffer.width = sw
  buffer.height = sh
  const bctx = buffer.getContext('2d')
  if (!bctx) return
  bctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh)

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, Math.max(0, fx.radius))
  ctx.clip()
  ctx.filter = `blur(${blur}px)`
  ctx.drawImage(buffer, sx, sy, sw, sh)
  ctx.filter = 'none'
  ctx.restore()
}

function textAxisScale(transform: ClipTransform, axis: 'x' | 'y'): number {
  const axisScale = axis === 'x' ? transform.scaleX : transform.scaleY
  return Math.max(0.05, transform.scale) * Math.max(MIN_AXIS_SCALE, axisScale)
}

async function loadTextClipFonts(clips: Clip[]): Promise<void> {
  if (!('fonts' in document)) return
  const requests = clips
    .map((clip) => clip.textData)
    .filter((td): td is NonNullable<typeof td> => !!td)
    .map((td) => document.fonts.load(`${td.fontWeight} 64px ${td.fontFamily}`, td.content || 'Hg'))
  await Promise.all(requests)
}

/** Mix all audible clips into a single stereo AudioBuffer via offline rendering. */
export async function renderAudioMix(
  durationSec: number,
  clips: Clip[],
  tracks: Track[],
  audioBuffers: Map<string, AudioBuffer>,
): Promise<AudioBuffer | null> {
  const audible = clips.filter((c) => {
    if (!c.assetId || c.muted || !audioBuffers.has(c.assetId)) return false
    const track = tracks.find((t) => t.id === c.trackId)
    return !!track && !track.muted && (track.kind === 'audio' || track.kind === 'video')
  })
  if (audible.length === 0 || durationSec <= 0) return null

  const length = Math.ceil(durationSec * SAMPLE_RATE)
  const octx = new OfflineAudioContext(AUDIO_CHANNELS, length, SAMPLE_RATE)

  // Load the denoise worklet up front if any clip needs it (offline contexts
  // require the module registered before rendering). Keeps mp3/wav export
  // consistent with live preview.
  const denoiseReady = audible.some((c) => c.denoise)
    ? await loadDenoiseModule(octx)
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

  return octx.startRendering()
}

/** Encode an AudioBuffer to AAC and feed chunks to the muxer. */
async function encodeAudio(
  audioBuffer: AudioBuffer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  muxer: any,
): Promise<void> {
  const numCh = Math.min(audioBuffer.numberOfChannels, AUDIO_CHANNELS)
  const total = audioBuffer.length

  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => console.error('AudioEncoder error:', e),
  })
  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: numCh,
    bitrate: AUDIO_BITRATE,
  })

  const CHUNK = 4096
  let timestampUs = 0
  for (let offset = 0; offset < total; offset += CHUNK) {
    const frames = Math.min(CHUNK, total - offset)
    const planar = new Float32Array(frames * numCh)
    for (let ch = 0; ch < numCh; ch++) {
      planar.set(audioBuffer.getChannelData(ch).subarray(offset, offset + frames), ch * frames)
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: numCh,
      timestamp: timestampUs,
      data: planar,
    })
    encoder.encode(data)
    data.close()
    timestampUs += Math.round((frames / SAMPLE_RATE) * 1_000_000)
  }

  await encoder.flush()
  encoder.close()
}

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
): Promise<Blob> {
  const { width, height, fps, videoBitrateKbps } = settings
  const totalFrames = Math.max(1, Math.ceil(durationSec * fps))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  // Video sources: prefer a WebCodecs sequential decoder (fast, CapCut-like);
  // fall back to <video> seeking only if demux/decode is unavailable.
  const exportReaders = new Map<string, VideoFrameReader>()
  const exportVideoPool = new Map<string, HTMLVideoElement>()
  const exportImagePool = new Map<string, HTMLImageElement>()
  for (const asset of assets) {
    const url = urlCache.get(asset.id)
    if (!url) continue
    if (asset.kind === 'video') {
      let readerReady = false
      if (!asset.sourcePath) {
        try {
          const blob = await fetch(url).then((r) => r.blob())
          exportReaders.set(asset.id, await createVideoFrameReader(blob))
          readerReady = true
        } catch {
          readerReady = false // unsupported codec/container → seek fallback
        }
      }
      if (!readerReady) {
        const el = document.createElement('video')
        el.src = url
        el.preload = 'auto'
        el.muted = true
        el.playsInline = true
        exportVideoPool.set(asset.id, el)
        await new Promise<void>((r) => {
          if (el.readyState >= 1) {
            r()
            return
          }
          el.onloadedmetadata = () => r()
        })
      }
    } else if (asset.kind === 'image') {
      const img = new Image()
      exportImagePool.set(asset.id, img)
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error(`Failed to load image for export: ${asset.name}`))
        img.src = url
      })
    }
  }

  await loadTextClipFonts(clips)

  // 1. Render audio mix first (so we know if there is an audio track)
  onProgress({ frame: 0, total: totalFrames, phase: 'audio' })
  const audioMix = await renderAudioMix(durationSec, clips, tracks, audioBuffers)

  // 2. Muxer with video (+ audio if present). The MP4 streams into an OPFS
  // scratch file as it's muxed, so memory stays bounded no matter how long the
  // export is (the old ArrayBufferTarget held the whole file in RAM). The
  // tradeoff: fastStart false puts the moov atom at the end, fine for a
  // downloaded file. Falls back to the in-memory path if OPFS is unavailable
  // (or a leaked lock from a crashed export blocks the scratch file).
  let opfsWritable: FileSystemWritableFileStream | null = null
  try {
    await deleteBlob(EXPORT_TMP_KEY) // reclaim the previous export's space
    opfsWritable = await createWritable(EXPORT_TMP_KEY)
  } catch {
    opfsWritable = null
  }
  const muxerCommon = {
    video: { codec: 'avc' as const, width, height },
    ...(audioMix
      ? {
          audio: {
            codec: 'aac' as const,
            numberOfChannels: Math.min(audioMix.numberOfChannels, AUDIO_CHANNELS),
            sampleRate: SAMPLE_RATE,
          },
        }
      : {}),
    firstTimestampBehavior: 'offset' as const,
  }
  const muxer = opfsWritable
    ? new Muxer({
        ...muxerCommon,
        target: new FileSystemWritableFileStreamTarget(opfsWritable),
        fastStart: false as const,
      })
    : new Muxer({ ...muxerCommon, target: new ArrayBufferTarget(), fastStart: 'in-memory' as const })

  // 3. Video encoder (prefer GPU hardware encoding for speed). Encoded chunks
  // go straight into the muxer — buffering them and adding after the loop kept
  // the entire encoded video in RAM for no benefit (audio is a separate track,
  // so track-local timestamp ordering is preserved either way).
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('VideoEncoder error:', e),
  })
  encoder.configure(
    await pickVideoConfig({
      width,
      height,
      bitrate: videoBitrateKbps * 1000,
      framerate: fps,
      latencyMode: 'quality',
    }),
  )

  // Precompute lookups so the per-frame loop stays O(activeClips), not O(all).
  const assetById = new Map(assets.map((a) => [a.id, a]))
  const videoOrder = new Map<string, number>()
  const fxOrder = new Map<string, number>()
  const textOrder = new Map<string, number>()
  tracks.forEach((t) => {
    if (t.kind === 'video') videoOrder.set(t.id, videoOrder.size)
    else if (t.kind === 'fx') fxOrder.set(t.id, fxOrder.size)
    else if (t.kind === 'text') textOrder.set(t.id, textOrder.size)
  })
  const lastSeek = new Map<string, number>() // skip redundant seeks per element

  // 4. Frame loop
  for (let f = 0; f < totalFrames; f++) {
    if (signal.aborted) {
      encoder.close()
      // Discard the partial scratch file (also releases its OPFS lock).
      if (opfsWritable) await opfsWritable.abort().catch(() => {})
      throw new DOMException('Export cancelled', 'AbortError')
    }

    const t = f / fps
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)

    const activeVideo = clips
      .filter((c) => videoOrder.has(c.trackId) && clipIsActiveAt(c, t))
      .sort((a, b) => videoOrder.get(b.trackId)! - videoOrder.get(a.trackId)!)

    for (const clip of activeVideo) {
      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
      if (!asset) continue
      ctx.globalAlpha = resolveClipOpacityAt(clip, t)
      ctx.filter =
        clip.adjust && !isAdjustNeutral(clip.adjust) ? adjustToFilter(clip.adjust) : 'none'

      if (asset.kind === 'video') {
        const srcSec = clipSourceSec(clip, t)
        const reader = exportReaders.get(asset.id)
        if (reader) {
          const vf = await reader.getFrameAt(srcSec)
          if (vf) fitDrawCtx(ctx, vf, width, height, resolveClipTransformAt(clip, t))
        } else {
          const el = exportVideoPool.get(asset.id)
          if (el) {
            const frameEps = Math.max(clip.speed, 0.01) / (fps * 2)
            if (Math.abs((lastSeek.get(asset.id) ?? -1) - srcSec) > frameEps) {
              await seekVideoToSec(el, srcSec)
              lastSeek.set(asset.id, srcSec)
            }
            if (el.readyState >= 2) {
              fitDrawCtx(ctx, el, width, height, resolveClipTransformAt(clip, t))
            }
          }
        }
      } else if (asset.kind === 'image') {
        const img = exportImagePool.get(asset.id)
        if (img) fitDrawCtx(ctx, img, width, height, resolveClipTransformAt(clip, t))
      }
      ctx.filter = 'none'
      ctx.globalAlpha = 1
    }

    const activeFx = clips
      .filter((c) => fxOrder.has(c.trackId) && clipIsActiveAt(c, t) && c.fxData)
      .sort((a, b) => fxOrder.get(b.trackId)! - fxOrder.get(a.trackId)!)

    for (const clip of activeFx) {
      if (clip.fxData?.type === 'blur-sticker') drawBlurSticker(ctx, clip.fxData, width, height)
    }

    const activeText = clips
      .filter((c) => textOrder.has(c.trackId) && clipIsActiveAt(c, t) && c.textData)
      .sort((a, b) => textOrder.get(b.trackId)! - textOrder.get(a.trackId)!)

    for (const clip of activeText) {
      const td = clip.textData!
      const transform = resolveClipTransformAt(clip, t)
      const fontSize = Math.round((td.fontSize / 1080) * height)
      ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
      ctx.textAlign = td.align
      ctx.textBaseline = 'middle'
      ctx.globalAlpha = resolveClipOpacityAt(clip, t)
      const sx = textAxisScale(transform, 'x')
      const sy = textAxisScale(transform, 'y')
      const maxWidth = (width * TEXT_MAX_WIDTH_RATIO) / sx
      const { lines, rect } = measureWrappedText(ctx, td.content, fontSize, td.align, maxWidth)

      const stroke =
        td.stroke && td.stroke.width > 0
          ? { color: td.stroke.color, width: (td.stroke.width / 1080) * height }
          : undefined

      const isReveal = !!(td.anim && td.anim.kind !== 'none')
      const revealOpts = isReveal
        ? {
            unit: td.anim!.kind === 'group' ? Math.max(1, td.anim!.groupSize) : 1,
            elapsedSec: Math.max(0, t - clip.startSec),
            clipDuration: clipEffectiveDuration(clip),
            wordTimestamps: td.wordTimestamps,
          }
        : null
      const revealUnit = revealOpts ? getCurrentRevealUnit(ctx, lines, fontSize, revealOpts) : null

      ctx.save()
      ctx.translate(td.x * width, td.y * height)
      ctx.scale(sx, sy)
      if (td.hasBackground) {
        const pad = fontSize * 0.2
        if (revealUnit) {
          ctx.save()
          ctx.scale(revealUnit.popScale, revealUnit.popScale)
          ctx.fillStyle = td.backgroundColor
          ctx.fillRect(revealUnit.rect.x - pad, revealUnit.rect.y - pad, revealUnit.rect.w + pad * 2, revealUnit.rect.h + pad * 2)
          ctx.restore()
        } else {
          ctx.fillStyle = td.backgroundColor
          ctx.fillRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2)
        }
      }
      if (!stroke) {
        ctx.shadowColor = 'rgba(0,0,0,0.6)'
        ctx.shadowBlur = 4
        ctx.shadowOffsetX = 2
        ctx.shadowOffsetY = 2
      }
      ctx.fillStyle = td.color
      if (revealOpts) {
        drawCaptionReveal(ctx, lines, fontSize, td.align, revealOpts, stroke)
      } else {
        drawWrappedLines(ctx, lines, fontSize, stroke)
      }
      ctx.restore()
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
    }

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(t * 1_000_000),
      duration: Math.round((1 / fps) * 1_000_000),
    })
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 })
    frame.close()

    onProgress({ frame: f + 1, total: totalFrames, phase: 'encoding' })

    // Backpressure: only pause when the encoder queue grows, instead of a
    // fixed macrotask every few frames — lets frames stream through faster.
    if (encoder.encodeQueueSize > 12) {
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0))
    } else if (f % 24 === 23) {
      await new Promise((r) => setTimeout(r, 0)) // yield for UI/abort responsiveness
    }
  }

  // 5. Flush the encoder (video chunks streamed into the muxer as emitted).
  onProgress({ frame: totalFrames, total: totalFrames, phase: 'muxing' })
  await encoder.flush()
  encoder.close()

  // 6. Encode audio
  if (audioMix) {
    await encodeAudio(audioMix, muxer)
  }

  muxer.finalize()
  for (const reader of exportReaders.values()) reader.close()
  for (const el of exportVideoPool.values()) el.src = ''
  for (const img of exportImagePool.values()) img.src = ''

  onProgress({ frame: totalFrames, total: totalFrames, phase: 'done' })

  if (opfsWritable) {
    await opfsWritable.close() // waits for all queued positioned writes
    const blob = await readBlob(EXPORT_TMP_KEY)
    if (!blob) throw new Error('Export scratch file missing after finalize')
    return blob
  }
  const { buffer } = muxer.target as ArrayBufferTarget
  return new Blob([buffer], { type: 'video/mp4' })
}
