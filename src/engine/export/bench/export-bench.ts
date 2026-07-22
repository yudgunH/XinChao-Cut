import { ArrayBufferTarget, Muxer } from 'mp4-muxer'

import type { MediaAsset } from '@engine/media'
import { GpuCompositor } from '@engine/preview/gpu-compositor'
import {
  buildRenderPlan,
  resolveRenderPlanDraws,
  type RenderPlanSourceInfo,
} from '@engine/composition/render-plan'
import {
  ActiveClipIndex,
  clipSourceSec,
  makeDefaultAdjust,
  makeDefaultTransform,
  type Clip,
  type Track,
} from '@engine/timeline'
import { drawTextClip } from '@engine/timeline/draw-caption'
import { yieldToMacrotask } from '@engine/core/schedule'
import { deleteBlob } from '@engine/persistence/opfs'

import { createVideoFrameReader } from '../frame-reader'
import {
  exportVideo,
  muxerCodec,
  pickVideoConfig,
  type BrowserExportResult,
  type ExportProgress,
  type ExportSettings,
} from '../exporter'
import baseline from './baseline.json'

const FIXTURE_DURATION_SEC = 15
const FIXTURE_WIDTH = 1080
const FIXTURE_HEIGHT = 1920
const FIXTURE_FPS = 30
const FIXTURE_CAPTION_COUNT = 20
const FIXTURE_VIDEO_BITRATE_KBPS = 8_000
const FIXTURE_AUDIO_BITRATE_KBPS = 128
const GOLDEN_THRESHOLD_BYTES = 3
const GOLDEN_REQUIRED_PIXEL_RATIO = 0.99
const PERF_BUDGET_RATIO = 0.8
const GOLDEN_TILE_SIZE = 64
const DEFAULT_VIDEO_SEGMENTS = 1
const MAX_VIDEO_SEGMENTS = FIXTURE_DURATION_SEC * FIXTURE_FPS

export const EXPORT_BENCH_INSTRUCTIONS =
  'Open the app in Chrome dev or the packaged WebView2 build, then click "Run export benchmark". ' +
  'In a dev build you can also run window.__xinchaoExportBench({ browserZeroCopy: "auto" }) in the console.'

export type ExportBenchZeroCopy = 'off' | 'auto'

export interface ExportBenchOptions {
  browserZeroCopy?: ExportBenchZeroCopy | boolean
  /** Split the source into sequential same-asset clips to exercise decoder handoff. */
  videoSegments?: number
  signal?: AbortSignal
  goldenFrames?: boolean
  onProgress?: (progress: ExportBenchProgress) => void
}

export interface ExportBenchProgress {
  stage: 'fixture' | 'export' | 'golden'
  completed: number
  total: number
  message: string
}

export interface ExportPerfWindow {
  final: boolean
  frames: number
  fps: number
  decodeMsPerFrame: number
  drawMsPerFrame: number
  encodeAndBackpressureMsPerFrame: number
  path: string
  zeroCopy: BrowserExportResult['zeroCopy']
  worker: boolean
  seekFallbackAssets: number
  line: string
}

export interface AggregatedExportPerf {
  frames: number
  fps: number | null
  frameLoopMs: number | null
  decodeMsPerFrame: number | null
  drawMsPerFrame: number | null
  encodeAndBackpressureMsPerFrame: number | null
  path: string | null
  seekFallbackAssets: number
}

export interface GoldenMismatchRegion {
  x: number
  y: number
  width: number
  height: number
  meanAbsoluteDiffPerChannel: number
}

export interface GoldenFrameResult {
  label: 'start' | 'middle' | 'end'
  timelineSec: number
  pass: boolean
  passingPixelRatio: number
  mismatchedPixelPercent: number
  meanAbsoluteDiffPerChannel: number
  meanAbsoluteDiffNormalized: number
  maxPixelDiffPerChannel: number
  maxPixel: { x: number; y: number }
  largestMismatchRegion: GoldenMismatchRegion
}

export interface GoldenParityReport {
  pass: boolean
  thresholdPerChannel: number
  requiredPixelRatio: number
  compositor: 'webgpu'
  elapsedMs: number
  frames: GoldenFrameResult[]
}

export interface ExportBenchBudget {
  applicable: boolean
  baselineMachine: string
  baselineFps: number | null
  minimumFps: number | null
  actualFps: number
  ratioToBaseline: number | null
  pass: boolean
}

export interface ExportBenchReport {
  schemaVersion: 1
  createdAt: string
  pass: boolean
  environment: {
    userAgent: string
    webGpu: boolean
    performanceMemory: boolean
  }
  fixture: {
    durationSec: number
    width: number
    height: number
    fps: number
    captionCount: number
    videoSegments: number
    videoBitrateKbps: number
    sourceBytes: number
    outputBytes: number
    sourceCodec: string
    fixtureMs: number
  }
  settings: {
    browserZeroCopy: ExportBenchZeroCopy
  }
  metrics: {
    fps: number
    wallFps: number
    exportWallMs: number
    frameLoopMs: number | null
    decodeMsPerFrame: number | null
    drawMsPerFrame: number | null
    encodeAndBackpressureMsPerFrame: number | null
    peakJsHeapBytes: number | null
    jsHeapStartBytes: number | null
    jsHeapEndBytes: number | null
    zeroCopy: BrowserExportResult['zeroCopy']
    path: string | null
    seekFallbackAssets: {
      count: number
      names: string[]
    }
  }
  perfWindows: ExportPerfWindow[]
  golden: GoldenParityReport
  budget: ExportBenchBudget
}

interface RuntimeFixture {
  videoBlob: Blob
  sourceCodec: string
  clips: Clip[]
  tracks: Track[]
  assets: MediaAsset[]
  audioBuffers: Map<string, AudioBuffer>
}

interface PerformanceMemorySnapshot {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

interface PerformanceWithMemory {
  memory?: PerformanceMemorySnapshot
}

interface HeapSample {
  startBytes: number | null
  peakBytes: number | null
  stop(): { startBytes: number | null; peakBytes: number | null; endBytes: number | null }
}

interface PerfCapture {
  windows: ExportPerfWindow[]
  stop(): void
}

function abortError(): DOMException {
  return new DOMException('Export benchmark cancelled', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function normalizeZeroCopy(value: ExportBenchOptions['browserZeroCopy']): ExportBenchZeroCopy {
  if (value === false || value === 'off') return 'off'
  return 'auto'
}

function normalizeVideoSegments(value: ExportBenchOptions['videoSegments']): number {
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_SEGMENTS
  return Math.max(1, Math.min(MAX_VIDEO_SEGMENTS, Math.round(value!)))
}

export function getExportBenchSupport(): { supported: boolean; reason?: string } {
  if (typeof document === 'undefined') {
    return { supported: false, reason: 'This is a browser-less environment' }
  }
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoDecoder === 'undefined' ||
    typeof VideoFrame === 'undefined'
  ) {
    return { supported: false, reason: 'WebCodecs video APIs are unavailable' }
  }
  if (
    typeof AudioEncoder === 'undefined' ||
    typeof AudioData === 'undefined' ||
    typeof OfflineAudioContext === 'undefined'
  ) {
    return { supported: false, reason: 'WebCodecs audio or OfflineAudioContext is unavailable' }
  }
  if (!navigator.gpu) {
    return { supported: false, reason: 'WebGPU is unavailable for the golden preview compositor' }
  }
  return { supported: true }
}

function createHeapSample(): HeapSample {
  const memory = (performance as unknown as PerformanceWithMemory).memory
  if (!memory) {
    return {
      startBytes: null,
      peakBytes: null,
      stop: () => ({ startBytes: null, peakBytes: null, endBytes: null }),
    }
  }
  const startBytes = memory.usedJSHeapSize
  let peakBytes = startBytes
  const timer = setInterval(() => {
    const current = (performance as unknown as PerformanceWithMemory).memory?.usedJSHeapSize
    if (current !== undefined) peakBytes = Math.max(peakBytes, current)
  }, 50)
  return {
    startBytes,
    get peakBytes() {
      return peakBytes
    },
    stop() {
      clearInterval(timer)
      const endBytes =
        (performance as unknown as PerformanceWithMemory).memory?.usedJSHeapSize ?? null
      if (endBytes !== null) peakBytes = Math.max(peakBytes, endBytes)
      return { startBytes, peakBytes, endBytes }
    },
  }
}

export function parseExportPerfLine(line: string, frames = 0): ExportPerfWindow | null {
  const header = line.match(/^\[export perf( total)?\]\s+(final\s+)?/)
  if (!header) return null
  const readNumber = (key: string): number | null => {
    const match = line.match(new RegExp(`(?:^|\\s)${key}=([\\d.]+)`))
    return match ? Number(match[1]) : null
  }
  const fps = readNumber('fps')
  const decode = readNumber('decode')
  const draw = readNumber('draw')
  const encode = readNumber('encode\\+bp')
  const path = line.match(/(?:^|\s)path=(\S+)/)?.[1]
  if (fps === null || decode === null || draw === null || encode === null || !path) return null
  const explicitFrames = readNumber('frames')
  const zeroCopy = line.match(/(?:^|\s)zeroCopy=(off|active|fallback|ineligible)/)?.[1]
  const worker = line.match(/(?:^|\s)worker=(true|false)/)?.[1]
  return {
    final: !!header[1] || !!header[2],
    frames: explicitFrames ?? frames,
    fps,
    decodeMsPerFrame: decode,
    drawMsPerFrame: draw,
    encodeAndBackpressureMsPerFrame: encode,
    path,
    zeroCopy: (zeroCopy ?? 'off') as BrowserExportResult['zeroCopy'],
    worker: worker === 'true',
    seekFallbackAssets: readNumber('seekFallbackAssets') ?? 0,
    line,
  }
}

/* eslint-disable no-console */
function captureExportPerf(getRenderedFrame: () => number): PerfCapture {
  const windows: ExportPerfWindow[] = []
  const originalInfo = console.info
  let previousFrame = 0
  let stopped = false
  console.info = (...data) => {
    originalInfo(...data)
    const line = typeof data[0] === 'string' ? data[0] : ''
    const renderedFrame = getRenderedFrame()
    const parsed = parseExportPerfLine(line, Math.max(0, renderedFrame - previousFrame))
    if (!parsed) return
    previousFrame = renderedFrame
    // The total is authoritative and already covers every frame. Keeping both
    // it and the preceding 5-second windows would double-count the export.
    if (line.startsWith('[export perf total]')) windows.splice(0, windows.length, parsed)
    else windows.push(parsed)
  }
  return {
    windows,
    stop() {
      if (stopped) return
      stopped = true
      console.info = originalInfo
    },
  }
}
/* eslint-enable no-console */

export function aggregateExportPerfWindows(
  windows: readonly ExportPerfWindow[],
): AggregatedExportPerf {
  const usable = windows.filter((entry) => entry.frames > 0 && entry.fps > 0)
  const frames = usable.reduce((sum, entry) => sum + entry.frames, 0)
  if (frames === 0) {
    return {
      frames: 0,
      fps: null,
      frameLoopMs: null,
      decodeMsPerFrame: null,
      drawMsPerFrame: null,
      encodeAndBackpressureMsPerFrame: null,
      path: null,
      seekFallbackAssets: Math.max(0, ...windows.map((entry) => entry.seekFallbackAssets)),
    }
  }
  const weighted = (select: (entry: ExportPerfWindow) => number) =>
    usable.reduce((sum, entry) => sum + select(entry) * entry.frames, 0) / frames
  const frameLoopMs = usable.reduce(
    (sum, entry) => sum + (entry.frames / entry.fps) * 1_000,
    0,
  )
  const paths = new Set(usable.map((entry) => entry.path))
  return {
    frames,
    fps: frames / (frameLoopMs / 1_000),
    frameLoopMs,
    decodeMsPerFrame: weighted((entry) => entry.decodeMsPerFrame),
    drawMsPerFrame: weighted((entry) => entry.drawMsPerFrame),
    encodeAndBackpressureMsPerFrame: weighted(
      (entry) => entry.encodeAndBackpressureMsPerFrame,
    ),
    path: paths.size === 1 ? usable[0]!.path : 'mixed-windows',
    seekFallbackAssets: Math.max(0, ...windows.map((entry) => entry.seekFallbackAssets)),
  }
}

export function evaluateExportBenchBudget(
  actualFps: number,
  browserZeroCopy: ExportBenchZeroCopy,
  videoSegments = DEFAULT_VIDEO_SEGMENTS,
): ExportBenchBudget {
  // Continuous playback and jumping-cut stress exercise different decoder
  // behaviour, so each workload needs its own measured baseline. Unknown
  // segment counts remain informational until a matching profile is recorded.
  const baselineProfile = browserZeroCopy === 'auto'
    ? Object.values(baseline.profiles).find(
        (profile) => profile.videoSegments === videoSegments,
      )
    : undefined
  const baselineFps = baselineProfile?.fps ?? null
  if (baselineFps === null) {
    return {
      applicable: false,
      baselineMachine: baseline.machine.label,
      baselineFps: null,
      minimumFps: null,
      actualFps,
      ratioToBaseline: null,
      pass: true,
    }
  }
  const minimumFps = baselineFps * PERF_BUDGET_RATIO
  return {
    applicable: true,
    baselineMachine: baseline.machine.label,
    baselineFps,
    minimumFps,
    actualFps,
    ratioToBaseline: actualFps / baselineFps,
    pass: actualFps >= minimumFps,
  }
}

function drawFixtureFrame(
  context: CanvasRenderingContext2D,
  frame: number,
  totalFrames: number,
): void {
  const { width, height } = context.canvas
  const timeSec = frame / FIXTURE_FPS
  context.fillStyle = '#101827'
  context.fillRect(0, 0, width, height)

  const bandHeight = Math.ceil(height / 6)
  const colors = ['#14213d', '#183153', '#1d4e64', '#245f73', '#2a7081', '#31818f']
  for (let index = 0; index < colors.length; index++) {
    context.fillStyle = colors[index]!
    context.fillRect(0, index * bandHeight, width, bandHeight + 1)
  }

  const travel = width + 320
  const movingX = ((frame * 11) % travel) - 160
  const movingY = 300 + ((frame * 7) % (height - 600))
  context.fillStyle = '#00d4ff'
  context.beginPath()
  context.arc(movingX, movingY, 120, 0, Math.PI * 2)
  context.fill()

  const inverseX = width - ((frame * 8) % (width + 240)) - 120
  context.fillStyle = '#ff4d6d'
  context.fillRect(inverseX, height * 0.45, 240, 180)

  context.strokeStyle = '#ffd166'
  context.lineWidth = 18
  context.beginPath()
  context.moveTo(0, (frame * 13) % height)
  context.lineTo(width, ((frame * 13) + 520) % height)
  context.stroke()

  context.fillStyle = 'rgba(0, 0, 0, 0.72)'
  context.fillRect(52, 54, width - 104, 164)
  context.fillStyle = '#ffffff'
  context.font = 'bold 54px Arial, sans-serif'
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.fillText(`XinChao export bench  ${timeSec.toFixed(2)}s`, 82, 112)
  context.fillStyle = '#9bdcff'
  context.font = 'bold 34px Arial, sans-serif'
  context.fillText(`frame ${frame + 1}/${totalFrames}`, 82, 174)
}

async function createFixtureVideo(
  signal: AbortSignal | undefined,
  onProgress: ExportBenchOptions['onProgress'],
): Promise<{ blob: Blob; sourceCodec: string }> {
  const canvas = Object.assign(document.createElement('canvas'), {
    width: FIXTURE_WIDTH,
    height: FIXTURE_HEIGHT,
  })
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('Canvas2D is unavailable for the export fixture')
  const picked = await pickVideoConfig(
    {
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      bitrate: FIXTURE_VIDEO_BITRATE_KBPS * 1_000,
      framerate: FIXTURE_FPS,
      // Mirror the real export encoder config — no bitrateMode (see
      // exporter.ts pickVideoConfig call).
      latencyMode: 'quality',
    },
    'h264',
  )
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: {
      codec: muxerCodec(picked.codec),
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      frameRate: FIXTURE_FPS,
    },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  let fatal: unknown = null
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => {
      fatal = error
    },
  })
  const totalFrames = FIXTURE_DURATION_SEC * FIXTURE_FPS
  try {
    encoder.configure(picked.config)
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      throwIfAborted(signal)
      drawFixtureFrame(context, frameIndex, totalFrames)
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((frameIndex / FIXTURE_FPS) * 1_000_000),
        duration: Math.round((1 / FIXTURE_FPS) * 1_000_000),
      })
      try {
        encoder.encode(frame, {
          keyFrame: frameIndex === 0 || frameIndex % (FIXTURE_FPS * 2) === 0,
        })
      } finally {
        frame.close()
      }
      while (encoder.encodeQueueSize > 8) {
        throwIfAborted(signal)
        if (fatal) throw fatal
        await yieldToMacrotask()
      }
      if (frameIndex % FIXTURE_FPS === 0 || frameIndex === totalFrames - 1) {
        onProgress?.({
          stage: 'fixture',
          completed: frameIndex + 1,
          total: totalFrames,
          message: 'Encoding runtime H.264 fixture',
        })
      }
    }
    await encoder.flush()
    if (fatal) throw fatal
  } finally {
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* failed encoder */
    }
  }
  muxer.finalize()
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    sourceCodec: picked.config.codec,
  }
}

async function createSineAudio(
  signal: AbortSignal | undefined,
): Promise<AudioBuffer> {
  throwIfAborted(signal)
  const sampleRate = 48_000
  const offline = new OfflineAudioContext(
    2,
    Math.ceil(FIXTURE_DURATION_SEC * sampleRate),
    sampleRate,
  )
  const oscillator = offline.createOscillator()
  const gain = offline.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = 440
  gain.gain.value = 0.08
  oscillator.connect(gain).connect(offline.destination)
  oscillator.start(0)
  oscillator.stop(FIXTURE_DURATION_SEC)
  const buffer = await offline.startRendering()
  throwIfAborted(signal)
  return buffer
}

function baseClip(id: string, assetId: string | null, trackId: string): Clip {
  return {
    id,
    assetId,
    trackId,
    startSec: 0,
    inPointSec: 0,
    outPointSec: FIXTURE_DURATION_SEC,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
  }
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a)
  let right = Math.abs(b)
  while (right !== 0) [left, right] = [right, left % right]
  return left
}

function segmentJumpStride(segmentCount: number): number {
  if (segmentCount <= 2) return 1
  let stride = Math.max(2, Math.floor(segmentCount / 3))
  while (stride < segmentCount && greatestCommonDivisor(stride, segmentCount) !== 1) stride++
  return stride < segmentCount ? stride : 1
}

function createTimelineFixture(
  videoBlob: Blob,
  audioBuffer: AudioBuffer,
  videoSegments: number,
): RuntimeFixture {
  const tracks: Track[] = [
    { id: 'bench-video-track', kind: 'video', name: 'Benchmark video', muted: false, locked: false },
    { id: 'bench-text-track', kind: 'text', name: 'Benchmark captions', muted: false, locked: false },
    { id: 'bench-audio-track', kind: 'audio', name: 'Benchmark sine', muted: false, locked: false },
  ]
  const videoClips: Clip[] = []
  const segmentDuration = FIXTURE_DURATION_SEC / videoSegments
  const sourceStride = segmentJumpStride(videoSegments)
  for (let index = 0; index < videoSegments; index++) {
    const startSec = index * segmentDuration
    // A recap rarely keeps source time linear: each timeline cut jumps to a
    // different moment of the same recording. A coprime stride visits every
    // source segment exactly once and forces the real decoder handoff/seek path.
    const sourceIndex = (index * sourceStride) % videoSegments
    const sourceStartSec = sourceIndex * segmentDuration
    const sourceEndSec = sourceIndex === videoSegments - 1
      ? FIXTURE_DURATION_SEC
      : (sourceIndex + 1) * segmentDuration
    const clip = baseClip(
      `bench-video-clip-${index}`,
      'bench-video-asset',
      'bench-video-track',
    )
    clip.startSec = startSec
    clip.inPointSec = sourceStartSec
    clip.outPointSec = sourceEndSec
    videoClips.push(clip)
  }
  const audioClip = baseClip('bench-audio-clip', 'bench-audio-asset', 'bench-audio-track')
  audioClip.opacity = 0

  const captionDuration = FIXTURE_DURATION_SEC / FIXTURE_CAPTION_COUNT
  const captions: Clip[] = []
  for (let index = 0; index < FIXTURE_CAPTION_COUNT; index++) {
    const words = ['shared', 'renderer', 'karaoke', `${index + 1}`]
    const clip = baseClip(`bench-caption-${index}`, null, 'bench-text-track')
    clip.startSec = index * captionDuration
    clip.outPointSec = captionDuration
    clip.textData = {
      content: words.join(' '),
      fontSize: 62,
      color: '#ffffff',
      fontFamily: 'Arial, sans-serif',
      fontWeight: 'bold',
      align: 'center',
      x: 0.5,
      y: 0.84,
      hasBackground: false,
      backgroundColor: '#000000',
      stroke: { color: '#000000', width: 7 },
      anim: { kind: 'karaoke', groupSize: 1 },
      highlightColor: '#ffd400',
      wordTimestamps: words.map((word, wordIndex) => ({
        word,
        startSec: (wordIndex / words.length) * captionDuration,
        endSec: ((wordIndex + 1) / words.length) * captionDuration,
      })),
      letterSpacing: 1,
    }
    captions.push(clip)
  }

  const createdAt = Date.now()
  const assets: MediaAsset[] = [
    {
      id: 'bench-video-asset',
      kind: 'video',
      name: 'runtime-export-bench.mp4',
      mimeType: 'video/mp4',
      sizeBytes: videoBlob.size,
      durationSec: FIXTURE_DURATION_SEC,
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      fps: FIXTURE_FPS,
      storageKey: '',
      createdAt,
    },
    {
      id: 'bench-audio-asset',
      kind: 'audio',
      name: 'runtime-export-bench-sine.wav',
      mimeType: 'audio/wav',
      sizeBytes: audioBuffer.length * audioBuffer.numberOfChannels * 4,
      durationSec: FIXTURE_DURATION_SEC,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      storageKey: '',
      createdAt,
    },
  ]
  return {
    videoBlob,
    sourceCodec: '',
    clips: [...videoClips, ...captions, audioClip],
    tracks,
    assets,
    audioBuffers: new Map([['bench-audio-asset', audioBuffer]]),
  }
}

async function createRuntimeFixture(
  signal: AbortSignal | undefined,
  onProgress: ExportBenchOptions['onProgress'],
  videoSegments: number,
): Promise<RuntimeFixture> {
  const [{ blob, sourceCodec }, audioBuffer] = await Promise.all([
    createFixtureVideo(signal, onProgress),
    createSineAudio(signal),
  ])
  const fixture = createTimelineFixture(blob, audioBuffer, videoSegments)
  fixture.sourceCodec = sourceCodec
  return fixture
}

export function compareGoldenPixels(
  expected: Uint8ClampedArray,
  actual: Uint8ClampedArray,
  width: number,
  height: number,
  label: GoldenFrameResult['label'] = 'start',
  timelineSec = 0,
): GoldenFrameResult {
  if (expected.length !== actual.length || expected.length !== width * height * 4) {
    throw new Error('Golden pixel buffers do not match the requested dimensions')
  }
  const tileColumns = Math.ceil(width / GOLDEN_TILE_SIZE)
  const tileRows = Math.ceil(height / GOLDEN_TILE_SIZE)
  const tileDiff = new Float64Array(tileColumns * tileRows)
  const tilePixels = new Uint32Array(tileColumns * tileRows)
  let passingPixels = 0
  let absoluteDiff = 0
  let maxPixelDiff = -1
  let maxPixelIndex = 0
  const totalPixels = width * height
  for (let pixel = 0; pixel < totalPixels; pixel++) {
    const offset = pixel * 4
    const red = Math.abs(expected[offset]! - actual[offset]!)
    const green = Math.abs(expected[offset + 1]! - actual[offset + 1]!)
    const blue = Math.abs(expected[offset + 2]! - actual[offset + 2]!)
    const pixelMean = (red + green + blue) / 3
    absoluteDiff += red + green + blue
    if (pixelMean < GOLDEN_THRESHOLD_BYTES) passingPixels++
    if (pixelMean > maxPixelDiff) {
      maxPixelDiff = pixelMean
      maxPixelIndex = pixel
    }
    const x = pixel % width
    const y = Math.floor(pixel / width)
    const tileIndex =
      Math.floor(y / GOLDEN_TILE_SIZE) * tileColumns + Math.floor(x / GOLDEN_TILE_SIZE)
    tileDiff[tileIndex]! += pixelMean
    tilePixels[tileIndex]!++
  }

  let largestTileIndex = 0
  let largestTileMean = -1
  for (let tileIndex = 0; tileIndex < tileDiff.length; tileIndex++) {
    const tileMean = tileDiff[tileIndex]! / Math.max(1, tilePixels[tileIndex]!)
    if (tileMean > largestTileMean) {
      largestTileMean = tileMean
      largestTileIndex = tileIndex
    }
  }
  const largestTileX = (largestTileIndex % tileColumns) * GOLDEN_TILE_SIZE
  const largestTileY = Math.floor(largestTileIndex / tileColumns) * GOLDEN_TILE_SIZE
  const passingPixelRatio = passingPixels / Math.max(1, totalPixels)
  const meanAbsoluteDiffPerChannel = absoluteDiff / Math.max(1, totalPixels * 3)
  return {
    label,
    timelineSec,
    pass: passingPixelRatio >= GOLDEN_REQUIRED_PIXEL_RATIO,
    passingPixelRatio,
    mismatchedPixelPercent: (1 - passingPixelRatio) * 100,
    meanAbsoluteDiffPerChannel,
    meanAbsoluteDiffNormalized: meanAbsoluteDiffPerChannel / 255,
    maxPixelDiffPerChannel: maxPixelDiff,
    maxPixel: {
      x: maxPixelIndex % width,
      y: Math.floor(maxPixelIndex / width),
    },
    largestMismatchRegion: {
      x: largestTileX,
      y: largestTileY,
      width: Math.min(GOLDEN_TILE_SIZE, width - largestTileX),
      height: Math.min(GOLDEN_TILE_SIZE, height - largestTileY),
      meanAbsoluteDiffPerChannel: largestTileMean,
    },
  }
}

async function runGoldenParity(
  fixture: RuntimeFixture,
  outputBlob: Blob,
  signal: AbortSignal | undefined,
  onProgress: ExportBenchOptions['onProgress'],
): Promise<GoldenParityReport> {
  const started = performance.now()
  const gpu = await GpuCompositor.create(FIXTURE_WIDTH, FIXTURE_HEIGHT)
  if (!gpu) throw new Error('Golden parity requires the WebGPU preview compositor')
  const sourceReader = await createVideoFrameReader(fixture.videoBlob)
  const outputReader = await createVideoFrameReader(outputBlob)
  const previewCanvas = Object.assign(document.createElement('canvas'), {
    width: FIXTURE_WIDTH,
    height: FIXTURE_HEIGHT,
  })
  const outputCanvas = Object.assign(document.createElement('canvas'), {
    width: FIXTURE_WIDTH,
    height: FIXTURE_HEIGHT,
  })
  const previewContext = previewCanvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  })
  const outputContext = outputCanvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  })
  if (!previewContext || !outputContext) {
    sourceReader.close()
    outputReader.close()
    gpu.destroy()
    throw new Error('Canvas2D is unavailable for golden pixel capture')
  }
  const activeIndex = ActiveClipIndex.build(fixture.clips, fixture.tracks)
  const targets: Array<{ label: GoldenFrameResult['label']; timelineSec: number }> = [
    { label: 'start', timelineSec: 0 },
    { label: 'middle', timelineSec: FIXTURE_DURATION_SEC / 2 },
    { label: 'end', timelineSec: FIXTURE_DURATION_SEC - 1 / FIXTURE_FPS },
  ]
  const frames: GoldenFrameResult[] = []
  try {
    for (let index = 0; index < targets.length; index++) {
      throwIfAborted(signal)
      const target = targets[index]!
      const mediaClips = activeIndex.queryAt('video', target.timelineSec)
      const sourceTimelineClip = mediaClips[0]
      const sourceTargetSec = sourceTimelineClip
        ? clipSourceSec(sourceTimelineClip, target.timelineSec)
        : target.timelineSec
      const [sourceFrame, outputFrame] = await Promise.all([
        sourceReader.getFrameAt(sourceTargetSec),
        outputReader.getFrameAt(target.timelineSec),
      ])
      if (!sourceFrame || !outputFrame) {
        throw new Error(`Golden frame decode failed at ${target.timelineSec.toFixed(3)}s`)
      }

      previewContext.setTransform(1, 0, 0, 1, 0, 0)
      previewContext.globalAlpha = 1
      previewContext.filter = 'none'
      previewContext.fillStyle = '#000'
      previewContext.fillRect(0, 0, FIXTURE_WIDTH, FIXTURE_HEIGHT)
      const sourceInfo: RenderPlanSourceInfo = {
        sourceW: sourceFrame.displayWidth || FIXTURE_WIDTH,
        sourceH: sourceFrame.displayHeight || FIXTURE_HEIGHT,
        frameVersion: index,
      }
      const renderPlan = buildRenderPlan({
        mediaClips,
        captionClips: activeIndex.queryAt('text', target.timelineSec),
        fxClips: activeIndex.queryAt('fx', target.timelineSec),
        tracks: fixture.tracks,
        outputWidth: FIXTURE_WIDTH,
        outputHeight: FIXTURE_HEIGHT,
        timelineSec: target.timelineSec,
        overlayFrameVersion: index,
        sources: new Map(mediaClips.map((clip) => [clip.id, sourceInfo])),
      })
      const mediaDraws = resolveRenderPlanDraws(
        renderPlan.mediaDraws,
        () => sourceFrame,
      )
      gpu.retainTextures(new Set(mediaDraws.map((draw) => draw.cacheKey ?? draw.assetId)))
      const renderStatus = gpu.render(mediaDraws)
      if (renderStatus !== 'ok') {
        throw new Error(`Golden preview compositor returned ${renderStatus}`)
      }
      if (!(await gpu.waitForPresentedFrame())) {
        throw new Error('Golden preview compositor lost the WebGPU device')
      }
      previewContext.drawImage(gpu.canvas, 0, 0, FIXTURE_WIDTH, FIXTURE_HEIGHT)
      for (const clip of renderPlan.captionClips) {
        drawTextClip(
          previewContext,
          clip,
          FIXTURE_WIDTH,
          FIXTURE_HEIGHT,
          target.timelineSec,
        )
      }

      outputContext.setTransform(1, 0, 0, 1, 0, 0)
      outputContext.globalAlpha = 1
      outputContext.filter = 'none'
      outputContext.fillStyle = '#000'
      outputContext.fillRect(0, 0, FIXTURE_WIDTH, FIXTURE_HEIGHT)
      outputContext.drawImage(outputFrame, 0, 0, FIXTURE_WIDTH, FIXTURE_HEIGHT)
      const expected = previewContext.getImageData(
        0,
        0,
        FIXTURE_WIDTH,
        FIXTURE_HEIGHT,
      ).data
      const actual = outputContext.getImageData(
        0,
        0,
        FIXTURE_WIDTH,
        FIXTURE_HEIGHT,
      ).data
      const comparison = compareGoldenPixels(
        expected,
        actual,
        FIXTURE_WIDTH,
        FIXTURE_HEIGHT,
        target.label,
        target.timelineSec,
      )
      frames.push(comparison)
      if (!comparison.pass) {
        const region = comparison.largestMismatchRegion
        console.error(
          `[export bench] GOLDEN FAIL ${target.label}@${target.timelineSec.toFixed(3)}s: ` +
            `${comparison.mismatchedPixelPercent.toFixed(2)}% pixels exceed 3/255; ` +
            `largest region x=${region.x}, y=${region.y}, w=${region.width}, h=${region.height}, ` +
            `region MAE=${region.meanAbsoluteDiffPerChannel.toFixed(2)}/255`,
        )
      }
      onProgress?.({
        stage: 'golden',
        completed: index + 1,
        total: targets.length,
        message: `Comparing ${target.label} golden frame`,
      })
    }
  } finally {
    sourceReader.close()
    outputReader.close()
    gpu.destroy()
  }
  return {
    pass: frames.every((entry) => entry.pass),
    thresholdPerChannel: GOLDEN_THRESHOLD_BYTES / 255,
    requiredPixelRatio: GOLDEN_REQUIRED_PIXEL_RATIO,
    compositor: 'webgpu',
    elapsedMs: performance.now() - started,
    frames,
  }
}

function emptyGoldenReport(): GoldenParityReport {
  return {
    pass: true,
    thresholdPerChannel: GOLDEN_THRESHOLD_BYTES / 255,
    requiredPixelRatio: GOLDEN_REQUIRED_PIXEL_RATIO,
    compositor: 'webgpu',
    elapsedMs: 0,
    frames: [],
  }
}

function printReport(report: ExportBenchReport): void {
  const phase = report.metrics
  // eslint-disable-next-line no-console
  console.table([
    {
      metric: 'fps',
      actual: report.metrics.fps.toFixed(1),
      baseline: report.budget.baselineFps?.toFixed(1) ?? 'n/a',
      status: report.budget.pass ? 'PASS' : 'FAIL',
    },
    {
      metric: 'decode ms/frame',
      actual: phase.decodeMsPerFrame?.toFixed(2) ?? 'n/a',
      baseline: 'n/a',
      status: 'info',
    },
    {
      metric: 'draw ms/frame',
      actual: phase.drawMsPerFrame?.toFixed(2) ?? 'n/a',
      baseline: 'n/a',
      status: 'info',
    },
    {
      metric: 'encode+bp ms/frame',
      actual: phase.encodeAndBackpressureMsPerFrame?.toFixed(2) ?? 'n/a',
      baseline: 'n/a',
      status: 'info',
    },
    {
      metric: 'golden parity',
      actual: report.golden.pass ? 'PASS' : 'FAIL',
      baseline: '99% pixels < 3/255',
      status: report.golden.pass ? 'PASS' : 'FAIL',
    },
  ])
  if (report.golden.frames.length > 0) {
    // eslint-disable-next-line no-console
    console.table(
      report.golden.frames.map((frame) => ({
        frame: frame.label,
        timeSec: frame.timelineSec.toFixed(3),
        pass: frame.pass,
        mismatchedPixels: `${frame.mismatchedPixelPercent.toFixed(2)}%`,
        meanAbsDiff: `${frame.meanAbsoluteDiffPerChannel.toFixed(2)}/255`,
        largestRegion:
          `${frame.largestMismatchRegion.x},${frame.largestMismatchRegion.y} ` +
          `${frame.largestMismatchRegion.width}x${frame.largestMismatchRegion.height}`,
      })),
    )
  }
  if (!report.budget.pass) {
    console.error(
      '%c[EXPORT BENCH PERF REGRESSION] ' +
        `${report.metrics.fps.toFixed(1)} fps is below the ` +
        `${report.budget.minimumFps?.toFixed(1)} fps budget ` +
        `(80% of ${report.budget.baselineFps?.toFixed(1)} fps).`,
      'color:#fff;background:#b91c1c;font-weight:bold;padding:3px 7px',
    )
  }
  // eslint-disable-next-line no-console
  console.info(`[export bench] JSON\n${JSON.stringify(report, null, 2)}`)
}

export async function runExportBenchmark(
  options: ExportBenchOptions = {},
): Promise<ExportBenchReport> {
  const support = getExportBenchSupport()
  if (!support.supported) {
    throw new Error(`${support.reason ?? 'Export benchmark is unsupported'}. ${EXPORT_BENCH_INSTRUCTIONS}`)
  }
  const browserZeroCopy = normalizeZeroCopy(options.browserZeroCopy)
  const videoSegments = normalizeVideoSegments(options.videoSegments)
  const fixtureStarted = performance.now()
  options.onProgress?.({
    stage: 'fixture',
    completed: 0,
    total: FIXTURE_DURATION_SEC * FIXTURE_FPS,
    message: 'Building runtime fixture',
  })
  const fixture = await createRuntimeFixture(options.signal, options.onProgress, videoSegments)
  const fixtureMs = performance.now() - fixtureStarted
  throwIfAborted(options.signal)

  const sourceUrl = URL.createObjectURL(fixture.videoBlob)
  const urlCache = new Map([['bench-video-asset', sourceUrl]])
  const settings: ExportSettings = {
    width: FIXTURE_WIDTH,
    height: FIXTURE_HEIGHT,
    fps: FIXTURE_FPS,
    videoBitrateKbps: FIXTURE_VIDEO_BITRATE_KBPS,
    audioBitrateKbps: FIXTURE_AUDIO_BITRATE_KBPS,
    videoCodec: 'h264',
    dynamicRange: 'sdr',
    browserZeroCopy,
  }
  const scratchKey = `__export-bench-${crypto.randomUUID()}.mp4`
  const totalFrames = FIXTURE_DURATION_SEC * FIXTURE_FPS
  const fallbackNames = new Set<string>()
  let renderedFrame = 0
  const perfCapture = captureExportPerf(() => renderedFrame)
  const heapSample = createHeapSample()
  const exportStarted = performance.now()
  let exportResult: BrowserExportResult | null = null
  let exportWallMs = 0
  let heap: ReturnType<HeapSample['stop']> | null = null
  try {
    try {
      exportResult = await exportVideo(
        settings,
        FIXTURE_DURATION_SEC,
        fixture.clips,
        fixture.tracks,
        fixture.assets,
        urlCache,
        fixture.audioBuffers,
        options.signal ?? new AbortController().signal,
        (progress: ExportProgress) => {
          if (progress.phase === 'encoding') {
            renderedFrame = progress.renderedFrame ?? progress.frame
          }
          if (progress.seekFallbackAsset) fallbackNames.add(progress.seekFallbackAsset)
          options.onProgress?.({
            stage: 'export',
            completed: progress.renderedFrame ?? progress.frame,
            total: progress.renderedTotal ?? progress.total,
            message:
              progress.phase === 'audio'
                ? 'Mixing sine audio'
                : progress.phase === 'muxing'
                  ? 'Finalizing MP4'
                  : `Exporting frame ${Math.round(progress.renderedFrame ?? progress.frame)}/${progress.renderedTotal ?? progress.total}`,
          })
        },
        undefined,
        scratchKey,
      )
    } finally {
      perfCapture.stop()
      exportWallMs = performance.now() - exportStarted
      heap = heapSample.stop()
    }
    if (!exportResult.blob) throw new Error('Browser export benchmark produced no MP4 blob')

    let golden = emptyGoldenReport()
    if (options.goldenFrames !== false) {
      golden = await runGoldenParity(
        fixture,
        exportResult.blob,
        options.signal,
        options.onProgress,
      )
    }

    const aggregate = aggregateExportPerfWindows(perfCapture.windows)
    const wallFps = totalFrames / Math.max(0.001, exportWallMs / 1_000)
    const fps = aggregate.fps ?? wallFps
    const budget = evaluateExportBenchBudget(fps, browserZeroCopy, videoSegments)
    const seekFallbackCount = Math.max(aggregate.seekFallbackAssets, fallbackNames.size)
    const report: ExportBenchReport = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      pass: golden.pass && budget.pass && seekFallbackCount === 0,
      environment: {
        userAgent: navigator.userAgent,
        webGpu: !!navigator.gpu,
        performanceMemory:
          (performance as unknown as PerformanceWithMemory).memory !== undefined,
      },
      fixture: {
        durationSec: FIXTURE_DURATION_SEC,
        width: FIXTURE_WIDTH,
        height: FIXTURE_HEIGHT,
        fps: FIXTURE_FPS,
        captionCount: FIXTURE_CAPTION_COUNT,
        videoSegments,
        videoBitrateKbps: FIXTURE_VIDEO_BITRATE_KBPS,
        sourceBytes: fixture.videoBlob.size,
        outputBytes: exportResult.blob.size,
        sourceCodec: fixture.sourceCodec,
        fixtureMs,
      },
      settings: { browserZeroCopy },
      metrics: {
        fps,
        wallFps,
        exportWallMs,
        frameLoopMs: aggregate.frameLoopMs,
        decodeMsPerFrame: aggregate.decodeMsPerFrame,
        drawMsPerFrame: aggregate.drawMsPerFrame,
        encodeAndBackpressureMsPerFrame: aggregate.encodeAndBackpressureMsPerFrame,
        peakJsHeapBytes: heap?.peakBytes ?? null,
        jsHeapStartBytes: heap?.startBytes ?? null,
        jsHeapEndBytes: heap?.endBytes ?? null,
        zeroCopy: exportResult.zeroCopy,
        path: aggregate.path,
        seekFallbackAssets: {
          count: seekFallbackCount,
          names: [...fallbackNames],
        },
      },
      perfWindows: perfCapture.windows,
      golden,
      budget,
    }
    printReport(report)
    return report
  } finally {
    perfCapture.stop()
    if (!heap) heapSample.stop()
    URL.revokeObjectURL(sourceUrl)
    await deleteBlob(scratchKey).catch(() => {})
  }
}

export function exposeExportBenchGlobal(): void {
  if (typeof window === 'undefined') return
  window.__xinchaoExportBench = runExportBenchmark
}

declare global {
  interface Window {
    __xinchaoExportBench?: (options?: ExportBenchOptions) => Promise<ExportBenchReport>
  }
}
