import { GpuCompositor, type GpuMediaDraw } from '@engine/preview/gpu-compositor'
import {
  requestHighPerformanceGpuAdapter,
  webViewRuntimeVersion,
  type BrowserGpuAdapterInfo,
} from '@engine/preview/gpu-adapter'
import {
  pickVideoConfig,
  type ExportVideoCodec,
} from './exporter'

// v3 adds the transparent caption-texture composition used by production.
// Never trust an older media-only matrix for caption zero-copy output.
export const ZERO_COPY_REPORT_SCHEMA = 3
export const ZERO_COPY_REPORT_STORAGE_KEY = 'xinchao-zero-copy-matrix-v3'
export const ZERO_COPY_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface ZeroCopyMatrixCase {
  id: string
  codec: ExportVideoCodec
  width: number
  height: number
  fps: number
  frames: number
}

export const DEFAULT_ZERO_COPY_MATRIX: readonly ZeroCopyMatrixCase[] = [
  { id: 'h264-1080p30', codec: 'h264', width: 1920, height: 1080, fps: 30, frames: 45 },
  { id: 'h264-1080p60', codec: 'h264', width: 1920, height: 1080, fps: 60, frames: 60 },
  { id: 'h264-4k30', codec: 'h264', width: 3840, height: 2160, fps: 30, frames: 30 },
  { id: 'hevc-1080p30', codec: 'hevc', width: 1920, height: 1080, fps: 30, frames: 30 },
  { id: 'av1-1080p30', codec: 'av1', width: 1920, height: 1080, fps: 30, frames: 30 },
]

export type ZeroCopyCaseStatus = 'active' | 'fallback' | 'unsupported' | 'failed'

export interface ZeroCopyPathResult {
  ok: boolean
  elapsedMs: number
  encodedChunks: number
  maxQueue: number
  fps: number
  pixelSamples?: ZeroCopyPixelSample[]
  error?: string
}

export interface ZeroCopyPixelSample {
  timestamp: number
  meanLuma: number
  variance: number
  hash: string
}

export interface CapturedPixelSample extends ZeroCopyPixelSample {
  pixels: Uint8ClampedArray
}

interface EncodedPacket {
  type: EncodedVideoChunk['type']
  timestamp: number
  duration?: number
  data: Uint8Array
}

interface InternalPathResult extends ZeroCopyPathResult {
  capturedSamples?: CapturedPixelSample[]
}

export interface ZeroCopyCaseResult extends ZeroCopyMatrixCase {
  status: ZeroCopyCaseStatus
  actualCodec: ExportVideoCodec
  encoderCodec: string
  safe?: ZeroCopyPathResult
  direct?: ZeroCopyPathResult
  reason?: string
}

export interface ZeroCopyEnvironment {
  userAgent: string
  webViewVersion: string
  gpuDriver: string | null
  backendGpu: string | null
  adapter: BrowserGpuAdapterInfo | null
  runtimeKey: string
}

export interface ZeroCopyMatrixReport {
  schemaVersion: typeof ZERO_COPY_REPORT_SCHEMA
  createdAt: string
  environment: ZeroCopyEnvironment
  verdict: 'verified' | 'fallback' | 'failed'
  cases: ZeroCopyCaseResult[]
}

export interface RunZeroCopyMatrixOptions {
  signal?: AbortSignal
  gpuDriver?: string | null
  backendGpu?: string | null
  cases?: readonly ZeroCopyMatrixCase[]
  /** Optional long-run stability pass. Values are clamped to 10-30 seconds. */
  soakSeconds?: number
  onProgress?: (completed: number, total: number, current: ZeroCopyMatrixCase) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): DOMException {
  return new DOMException('Zero-copy diagnostics cancelled', 'AbortError')
}

async function withAbortDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (signal?.aborted) throw abortError()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function runtimeKey(
  webViewVersion: string,
  gpuDriver: string | null,
  adapter: BrowserGpuAdapterInfo | null,
  backendGpu: string | null,
): string {
  const gpu = adapter
    ? [adapter.vendor, adapter.architecture, adapter.device, adapter.description, adapter.isFallbackAdapter]
        .join(':')
    : 'no-webgpu'
  return [
    ZERO_COPY_REPORT_SCHEMA,
    webViewVersion,
    gpuDriver ?? 'unknown-driver',
    backendGpu ?? 'unknown-backend-gpu',
    gpu,
  ].join('|')
}

export function buildZeroCopyEnvironment(
  userAgent: string,
  gpuDriver: string | null,
  adapter: BrowserGpuAdapterInfo | null,
  backendGpu: string | null = null,
): ZeroCopyEnvironment {
  const webViewVersion = webViewRuntimeVersion(userAgent)
  return {
    userAgent,
    webViewVersion,
    gpuDriver,
    backendGpu,
    adapter,
    runtimeKey: runtimeKey(webViewVersion, gpuDriver, adapter, backendGpu),
  }
}

function makeSourceCanvas(): OffscreenCanvas {
  const source = new OffscreenCanvas(640, 360)
  const ctx = source.getContext('2d')
  if (!ctx) throw new Error('Canvas2D is unavailable')
  const gradient = ctx.createLinearGradient(0, 0, source.width, source.height)
  gradient.addColorStop(0, '#00c2ff')
  gradient.addColorStop(0.5, '#7b2cff')
  gradient.addColorStop(1, '#ff9d00')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, source.width, source.height)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 72px sans-serif'
  ctx.fillText('XinChao-Cut GPU', 54, 205)
  return source
}

function makeOverlayCanvas(width: number, height: number): OffscreenCanvas {
  const overlay = new OffscreenCanvas(width, height)
  const ctx = overlay.getContext('2d')
  if (!ctx) throw new Error('Caption-overlay Canvas2D is unavailable')
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(width * 0.125, height * 0.75, width * 0.75, height * 0.172)
  ctx.fillStyle = '#ffd400'
  ctx.font = `bold ${Math.max(18, Math.round(height * 0.094))}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('GPU CAPTION OVERLAY', width / 2, height * 0.867)
  return overlay
}

function syntheticDraw(
  bitmap: ImageBitmap,
  testCase: ZeroCopyMatrixCase,
  frame: number,
): GpuMediaDraw {
  return {
    assetId: 'zero-copy-self-test',
    cacheKey: 'zero-copy-self-test',
    source: bitmap,
    sourceW: bitmap.width,
    sourceH: bitmap.height,
    rect: { x: 0, y: 0, w: testCase.width, h: testCase.height },
    rotationRad: 0,
    flipH: false,
    flipV: false,
    uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
    opacity: 1,
    adjust: {
      // A deterministic temporal change lets decoded-output validation catch
      // a stale GPU surface that repeatedly encodes the first frame.
      b: 0.68 + 0.32 * (frame / Math.max(1, testCase.frames - 1)),
      c: 0.92 + 0.08 * ((frame % 7) / 6),
      s: 0.95,
    },
    frameVersion: 1,
  }
}

function syntheticOverlayDraw(
  overlay: OffscreenCanvas,
  testCase: ZeroCopyMatrixCase,
  frame: number,
): GpuMediaDraw {
  return {
    assetId: 'zero-copy-caption-overlay',
    cacheKey: 'zero-copy-caption-overlay',
    source: overlay,
    sourceW: overlay.width,
    sourceH: overlay.height,
    rect: { x: 0, y: 0, w: testCase.width, h: testCase.height },
    rotationRad: 0,
    flipH: false,
    flipV: false,
    uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
    opacity: 1,
    adjust: { b: 1, c: 1, s: 1 },
    // Production karaoke/reveal captions upload changing pixels every frame.
    frameVersion: frame,
  }
}

function copyDecoderConfig(
  metadata: EncodedVideoChunkMetadata | undefined,
  encoderConfig: VideoEncoderConfig,
): VideoDecoderConfig {
  const supplied = metadata?.decoderConfig
  let description: ArrayBuffer | undefined
  if (supplied?.description) {
    const source = supplied.description
    const bytes = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source)
    description = bytes.slice().buffer
  }
  return {
    codec: supplied?.codec ?? encoderConfig.codec,
    codedWidth: supplied?.codedWidth ?? encoderConfig.width,
    codedHeight: supplied?.codedHeight ?? encoderConfig.height,
    description,
    hardwareAcceleration: 'prefer-hardware',
  }
}

function getValidationContext(canvas: OffscreenCanvas) {
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) throw new Error('Validation Canvas2D is unavailable')
  return context
}

function capturePixels(
  context: ReturnType<typeof getValidationContext>,
  frame: VideoFrame,
): CapturedPixelSample {
  context.drawImage(frame, 0, 0, context.canvas.width, context.canvas.height)
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height).data
  let sum = 0
  let hash = 0x811c9dc5
  const count = pixels.length / 4
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const luma = pixels[offset]! * 0.2126 + pixels[offset + 1]! * 0.7152 + pixels[offset + 2]! * 0.0722
    sum += luma
    hash ^= pixels[offset]!
    hash = Math.imul(hash, 0x01000193)
    hash ^= pixels[offset + 1]!
    hash = Math.imul(hash, 0x01000193)
    hash ^= pixels[offset + 2]!
    hash = Math.imul(hash, 0x01000193)
  }
  const meanLuma = sum / count
  let squared = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const luma = pixels[offset]! * 0.2126 + pixels[offset + 1]! * 0.7152 + pixels[offset + 2]! * 0.0722
    squared += (luma - meanLuma) ** 2
  }
  return {
    timestamp: frame.timestamp,
    meanLuma,
    variance: squared / count,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    pixels: new Uint8ClampedArray(pixels),
  }
}

async function decodePixelSamples(
  packets: readonly EncodedPacket[],
  decoderConfig: VideoDecoderConfig,
  targetTimestamps: ReadonlySet<number>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<CapturedPixelSample[]> {
  const canvas = new OffscreenCanvas(64, 36)
  const context = getValidationContext(canvas)
  const samples: CapturedPixelSample[] = []
  let fatal: unknown = null
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (targetTimestamps.has(frame.timestamp)) samples.push(capturePixels(context, frame))
      } catch (error) {
        fatal = error
      } finally {
        frame.close()
      }
    },
    error: (error) => { fatal = error },
  })
  try {
    decoder.configure(decoderConfig)
    for (const packet of packets) {
      if (signal?.aborted) throw abortError()
      decoder.decode(new EncodedVideoChunk(packet))
    }
    await withAbortDeadline(decoder.flush(), signal, 30_000, `${label} decode validation`)
    if (fatal) throw fatal
    samples.sort((a, b) => a.timestamp - b.timestamp)
    if (samples.length !== targetTimestamps.size) {
      throw new Error(`${label} decoded ${samples.length}/${targetTimestamps.size} validation frames`)
    }
    return samples
  } finally {
    try { decoder.close() } catch { /* failed decoder */ }
  }
}

export function compareDecodedPixelSamples(
  safe: readonly CapturedPixelSample[],
  direct: readonly CapturedPixelSample[],
): { ok: boolean; reason?: string; meanAbsoluteError?: number } {
  if (safe.length === 0 || safe.length !== direct.length) {
    return { ok: false, reason: 'Decoded validation sample count differs' }
  }
  let absoluteError = 0
  let channelCount = 0
  for (let index = 0; index < safe.length; index++) {
    const expected = safe[index]!
    const actual = direct[index]!
    if (expected.timestamp !== actual.timestamp || expected.pixels.length !== actual.pixels.length) {
      return { ok: false, reason: 'Decoded validation timestamps or dimensions differ' }
    }
    if (actual.meanLuma < 4 || actual.variance < 8) {
      return { ok: false, reason: 'Direct path decoded a blank or near-uniform frame' }
    }
    for (let offset = 0; offset < expected.pixels.length; offset += 4) {
      absoluteError += Math.abs(expected.pixels[offset]! - actual.pixels[offset]!)
      absoluteError += Math.abs(expected.pixels[offset + 1]! - actual.pixels[offset + 1]!)
      absoluteError += Math.abs(expected.pixels[offset + 2]! - actual.pixels[offset + 2]!)
      channelCount += 3
    }
  }
  const first = direct[0]!
  const last = direct[direct.length - 1]!
  if (direct.length > 1 && Math.abs(first.meanLuma - last.meanLuma) < 2) {
    return { ok: false, reason: 'Direct path appears to repeat a stale GPU frame' }
  }
  const meanAbsoluteError = absoluteError / Math.max(1, channelCount)
  if (meanAbsoluteError > 18) {
    return {
      ok: false,
      reason: `Direct decoded pixels differ from safe path (MAE ${meanAbsoluteError.toFixed(1)})`,
      meanAbsoluteError,
    }
  }
  return { ok: true, meanAbsoluteError }
}

function publicPathResult(result: InternalPathResult): ZeroCopyPathResult {
  const publicResult = { ...result }
  delete publicResult.capturedSamples
  return publicResult
}

async function reserveConcurrentEncoderSession(
  config: VideoEncoderConfig,
  source: OffscreenCanvas,
  signal: AbortSignal | undefined,
  label: string,
): Promise<VideoEncoder> {
  let fatal: unknown = null
  const encoder = new VideoEncoder({
    output: () => {},
    error: (error) => { fatal = error },
  })
  try {
    encoder.configure(config)
    const frame = new VideoFrame(source, { timestamp: 0 })
    try {
      encoder.encode(frame, { keyFrame: true })
    } finally {
      frame.close()
    }
    await withAbortDeadline(encoder.flush(), signal, 20_000, `${label} concurrent-session probe`)
    if (fatal) throw fatal
    return encoder
  } catch (error) {
    try { encoder.close() } catch { /* failed session */ }
    throw error
  }
}

async function encodePath(
  config: VideoEncoderConfig,
  testCase: ZeroCopyMatrixCase,
  prepare: (frame: number) => Promise<HTMLCanvasElement | OffscreenCanvas>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<InternalPathResult> {
  let encodedChunks = 0
  let maxQueue = 0
  let fatal: unknown = null
  let encoder: VideoEncoder | null = null
  const packets: EncodedPacket[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  const started = performance.now()
  try {
    encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        encodedChunks++
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        packets.push({
          type: chunk.type,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? undefined,
          data,
        })
        decoderConfig ??= copyDecoderConfig(metadata, config)
      },
      error: (error) => { fatal = error },
    })
    encoder.configure(config)
    const frameDuration = Math.round(1_000_000 / testCase.fps)
    for (let index = 0; index < testCase.frames; index++) {
      if (signal?.aborted) throw abortError()
      const canvas = await prepare(index)
      const frame = new VideoFrame(canvas, {
        timestamp: index * frameDuration,
        duration: frameDuration,
      })
      try {
        encoder.encode(frame, { keyFrame: index === 0 })
      } finally {
        frame.close()
      }
      maxQueue = Math.max(maxQueue, encoder.encodeQueueSize)
      if (encoder.encodeQueueSize >= 8) {
        await withAbortDeadline(encoder.flush(), signal, 20_000, `${label} backpressure`)
      }
      if (fatal) throw fatal
    }
    await withAbortDeadline(encoder.flush(), signal, 30_000, `${label} flush`)
    if (fatal) throw fatal
    if (encodedChunks <= 0) throw new Error(`${label} produced no encoded chunks`)
    if (!decoderConfig) throw new Error(`${label} produced no decoder configuration`)
    const encodeElapsedMs = performance.now() - started
    const targetFrames = new Set([
      0,
      Math.floor((testCase.frames - 1) / 2),
      testCase.frames - 1,
    ])
    const targetTimestamps = new Set([...targetFrames].map((frame) => frame * frameDuration))
    const capturedSamples = await decodePixelSamples(
      packets,
      decoderConfig,
      targetTimestamps,
      signal,
      label,
    )
    return {
      ok: true,
      elapsedMs: encodeElapsedMs,
      encodedChunks,
      maxQueue,
      fps: testCase.frames / Math.max(0.001, encodeElapsedMs / 1000),
      pixelSamples: capturedSamples.map(({ pixels: _pixels, ...sample }) => sample),
      capturedSamples,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    const elapsedMs = performance.now() - started
    return {
      ok: false,
      elapsedMs,
      encodedChunks,
      maxQueue,
      fps: 0,
      error: errorText(error),
    }
  } finally {
    try { encoder?.close() } catch { /* failed/stalled session */ }
  }
}

async function runCase(
  testCase: ZeroCopyMatrixCase,
  signal: AbortSignal | undefined,
): Promise<ZeroCopyCaseResult> {
  if (
    typeof VideoEncoder === 'undefined' ||
    typeof VideoDecoder === 'undefined' ||
    typeof VideoFrame === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    return {
      ...testCase,
      status: 'unsupported',
      actualCodec: testCase.codec,
      encoderCodec: '',
      reason: 'Required WebCodecs/OffscreenCanvas APIs are unavailable',
    }
  }

  const picked = await withAbortDeadline(
    pickVideoConfig({
      width: testCase.width,
      height: testCase.height,
      bitrate: testCase.height >= 2160 ? 35_000_000 : 8_000_000,
      framerate: testCase.fps,
      // Mirror the real export encoder config (exporter.ts pickVideoConfig
      // call): no explicit bitrateMode — 'variable' is the WebCodecs default.
      latencyMode: 'quality',
    }, testCase.codec),
    signal,
    20_000,
    `${testCase.id} codec discovery`,
  )
  if (picked.codec !== testCase.codec) {
    return {
      ...testCase,
      status: 'unsupported',
      actualCodec: picked.codec,
      encoderCodec: picked.config.codec,
      reason: `${testCase.codec.toUpperCase()} fell back to ${picked.codec.toUpperCase()}`,
    }
  }

  const gpu = await withAbortDeadline(
    GpuCompositor.create(testCase.width, testCase.height),
    signal,
    20_000,
    `${testCase.id} WebGPU setup`,
  )
  if (!gpu) {
    return {
      ...testCase,
      status: 'unsupported',
      actualCodec: picked.codec,
      encoderCodec: picked.config.codec,
      reason: 'No hardware WebGPU compositor is available',
    }
  }

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await withAbortDeadline(
      createImageBitmap(makeSourceCanvas()),
      signal,
      10_000,
      `${testCase.id} source bitmap`,
    )
    const captionOverlay = makeOverlayCanvas(testCase.width, testCase.height)
    const drawFrame = (frame: number) => {
      const status = gpu.render([
        syntheticDraw(bitmap!, testCase, frame),
        syntheticOverlayDraw(captionOverlay, testCase, frame),
      ])
      if (status !== 'ok') throw new Error(`WebGPU render returned ${status}`)
    }

    const safeCanvas = new OffscreenCanvas(testCase.width, testCase.height)
    const safeContext = safeCanvas.getContext('2d', { alpha: false })
    if (!safeContext) throw new Error('Safe Canvas2D context is unavailable')
    const safe = await encodePath(
      picked.config,
      testCase,
      async (frame) => {
        drawFrame(frame)
        // Match the production safe path: drawImage performs the necessary
        // canvas readback synchronization. An explicit queue fence here made
        // the baseline artificially slower than real exports.
        safeContext.drawImage(gpu.canvas, 0, 0, testCase.width, testCase.height)
        return safeCanvas
      },
      signal,
      `${testCase.id} safe path`,
    )
    if (!safe.ok) {
      return {
        ...testCase,
        status: 'failed',
        actualCodec: picked.codec,
        encoderCodec: picked.config.codec,
        safe: publicPathResult(safe),
        reason: safe.error ?? 'Safe Canvas2D encode failed',
      }
    }

    let reservation: VideoEncoder | null = null
    let direct: InternalPathResult
    try {
      // Production configures the real encoder before opening its sacrificial
      // zero-copy probe. Keep a live encoded session here so the matrix catches
      // driver/session limits under the same two-encoder topology.
      reservation = await reserveConcurrentEncoderSession(
        picked.config,
        safeCanvas,
        signal,
        testCase.id,
      )
      direct = await encodePath(
        picked.config,
        testCase,
        async (frame) => {
          drawFrame(frame)
          const presented = await withAbortDeadline(
            gpu.waitForPresentedFrame(),
            signal,
            10_000,
            `${testCase.id} direct frame presentation`,
          )
          if (!presented) throw new Error('WebGPU device was lost')
          return gpu.canvas
        },
        signal,
        `${testCase.id} direct path`,
      )
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      direct = {
        ok: false,
        elapsedMs: 0,
        encodedChunks: 0,
        maxQueue: 0,
        fps: 0,
        error: `Concurrent encoder topology failed: ${errorText(error)}`,
      }
    } finally {
      try { reservation?.close() } catch { /* already failed */ }
    }
    const pixelValidation = direct.ok && safe.capturedSamples && direct.capturedSamples
      ? compareDecodedPixelSamples(safe.capturedSamples, direct.capturedSamples)
      : { ok: false, reason: direct.error ?? 'Direct path did not produce decoded validation frames' }
    const throughputOk = direct.ok && direct.fps >= safe.fps * 0.9
    const active = direct.ok && pixelValidation.ok && throughputOk
    const reason = !direct.ok
      ? (direct.error ?? 'Direct GPU encode failed')
      : !pixelValidation.ok
        ? pixelValidation.reason
        : !throughputOk
          ? `Direct path is slower than safe path (${direct.fps.toFixed(1)} vs ${safe.fps.toFixed(1)} fps)`
          : undefined
    return {
      ...testCase,
      status: active ? 'active' : 'fallback',
      actualCodec: picked.codec,
      encoderCodec: picked.config.codec,
      safe: publicPathResult(safe),
      direct: publicPathResult(direct),
      ...(reason ? { reason } : {}),
    }
  } finally {
    try { bitmap?.close() } catch { /* already closed */ }
    try { gpu.destroy() } catch { /* device already lost */ }
  }
}

export function matrixVerdict(cases: readonly ZeroCopyCaseResult[]): ZeroCopyMatrixReport['verdict'] {
  const core = cases.find((entry) => entry.id === 'h264-1080p30')
  if (core?.status === 'active') return 'verified'
  if (core?.safe?.ok || cases.some((entry) => entry.status === 'fallback')) return 'fallback'
  return 'failed'
}

export async function runZeroCopyMatrix(
  options: RunZeroCopyMatrixOptions = {},
): Promise<ZeroCopyMatrixReport> {
  const requested = await withAbortDeadline(
    requestHighPerformanceGpuAdapter(),
    options.signal,
    10_000,
    'WebGPU adapter discovery',
  ).catch((error) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return null
  })
  const userAgent = typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent
  const environment = buildZeroCopyEnvironment(
    userAgent,
    options.gpuDriver ?? null,
    requested?.info ?? null,
    options.backendGpu ?? null,
  )
  const baseMatrix = options.cases ?? DEFAULT_ZERO_COPY_MATRIX
  const soakSeconds = options.soakSeconds == null
    ? null
    : Math.min(30, Math.max(10, options.soakSeconds))
  const matrix = soakSeconds == null
    ? baseMatrix
    : baseMatrix.map((entry) => ({
        ...entry,
        frames: Math.max(entry.frames, Math.round(entry.fps * soakSeconds)),
      }))
  const results: ZeroCopyCaseResult[] = []
  for (let index = 0; index < matrix.length; index++) {
    const current = matrix[index]!
    options.onProgress?.(index, matrix.length, current)
    if (options.signal?.aborted) throw abortError()
    results.push(await runCase(current, options.signal))
  }
  const lastCase = matrix[matrix.length - 1]
  if (lastCase) options.onProgress?.(matrix.length, matrix.length, lastCase)
  const report: ZeroCopyMatrixReport = {
    schemaVersion: ZERO_COPY_REPORT_SCHEMA,
    createdAt: new Date().toISOString(),
    environment,
    verdict: matrixVerdict(results),
    cases: results,
  }
  saveZeroCopyReport(report)
  return report
}

export function saveZeroCopyReport(report: ZeroCopyMatrixReport): void {
  try {
    localStorage.setItem(ZERO_COPY_REPORT_STORAGE_KEY, JSON.stringify(report))
  } catch {
    // Diagnostics remain useful even when storage is disabled/full.
  }
}

export function loadZeroCopyReport(
  current?: {
    userAgent?: string
    gpuDriver?: string | null
    backendGpu?: string | null
    adapter?: BrowserGpuAdapterInfo | null
  },
): ZeroCopyMatrixReport | null {
  try {
    const raw = localStorage.getItem(ZERO_COPY_REPORT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ZeroCopyMatrixReport
    if (parsed.schemaVersion !== ZERO_COPY_REPORT_SCHEMA || !Array.isArray(parsed.cases)) return null
    const createdAt = Date.parse(parsed.createdAt)
    const age = Date.now() - createdAt
    if (!Number.isFinite(createdAt) || age < -5 * 60_000 || age > ZERO_COPY_REPORT_MAX_AGE_MS) return null
    const userAgent = current?.userAgent ?? (typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent)
    if (parsed.environment.webViewVersion !== webViewRuntimeVersion(userAgent)) return null
    if (
      current?.gpuDriver !== undefined &&
      parsed.environment.gpuDriver !== (current.gpuDriver ?? null)
    ) return null
    if (
      current?.backendGpu !== undefined &&
      parsed.environment.backendGpu !== (current.backendGpu ?? null)
    ) return null
    if (current && Object.hasOwn(current, 'adapter')) {
      const expectedRuntimeKey = runtimeKey(
        webViewRuntimeVersion(userAgent),
        current.gpuDriver === undefined
          ? parsed.environment.gpuDriver
          : (current.gpuDriver ?? null),
        current.adapter ?? null,
        current.backendGpu === undefined
          ? parsed.environment.backendGpu
          : (current.backendGpu ?? null),
      )
      if (parsed.environment.runtimeKey !== expectedRuntimeKey) return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Load only a report produced by the adapter currently selected by WebGPU.
 * Adapter discovery is asynchronous, so export admission must use this helper
 * rather than trusting the synchronous storage parser alone. */
export async function loadValidatedZeroCopyReport(
  current?: {
    userAgent?: string
    gpuDriver?: string | null
    backendGpu?: string | null
    signal?: AbortSignal
  },
): Promise<ZeroCopyMatrixReport | null> {
  const requested = await withAbortDeadline(
    requestHighPerformanceGpuAdapter(),
    current?.signal,
    10_000,
    'WebGPU adapter validation',
  ).catch((error) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return null
  })
  return loadZeroCopyReport({
    ...current,
    adapter: requested?.info ?? null,
  })
}

export function zeroCopyCompatibility(
  report: ZeroCopyMatrixReport | null,
  codec: ExportVideoCodec,
  width: number,
  height: number,
  fps: number,
): ZeroCopyCaseStatus | 'untested' {
  if (!report) return 'untested'
  const exact = report.cases.find(
    (entry) => entry.codec === codec && entry.width === width && entry.height === height && entry.fps === fps,
  )
  return exact?.status ?? 'untested'
}

/**
 * Match a verified matrix case that exercised at least the requested codec,
 * frame rate and surface dimensions for an optional minimum duration.
 * Width/height are orientation-independent: a 1920x1080 surface also
 * covers 1080x1920, while a larger edge or higher frame rate still requires its
 * own case. The exporter performs an additional exact-config sacrificial probe
 * and can fall back before committing the first direct frame.
 */
function hasZeroCopyCoverageForSeconds(
  report: ZeroCopyMatrixReport | null,
  codec: ExportVideoCodec,
  width: number,
  height: number,
  fps: number,
  minimumSeconds: number,
): boolean {
  if (!report || report.verdict !== 'verified') return false
  const targetLongEdge = Math.max(width, height)
  const targetShortEdge = Math.min(width, height)
  return report.cases.some((entry) => {
    if (entry.codec !== codec || entry.status !== 'active') return false
    if (entry.fps < fps || entry.frames / Math.max(1, entry.fps) < minimumSeconds) return false
    const caseLongEdge = Math.max(entry.width, entry.height)
    const caseShortEdge = Math.min(entry.width, entry.height)
    return caseLongEdge >= targetLongEdge && caseShortEdge >= targetShortEdge
  })
}

/** A verified covering matrix case; the exporter still probes the exact config. */
export function hasZeroCopyCoverage(
  report: ZeroCopyMatrixReport | null,
  codec: ExportVideoCodec,
  width: number,
  height: number,
  fps: number,
): boolean {
  return hasZeroCopyCoverageForSeconds(report, codec, width, height, fps, 0)
}

/** Stronger long-run qualification used for diagnostics and soak reporting. */
export function hasSustainedZeroCopyCoverage(
  report: ZeroCopyMatrixReport | null,
  codec: ExportVideoCodec,
  width: number,
  height: number,
  fps: number,
  minimumSeconds = 10,
): boolean {
  return hasZeroCopyCoverageForSeconds(
    report,
    codec,
    width,
    height,
    fps,
    minimumSeconds,
  )
}
