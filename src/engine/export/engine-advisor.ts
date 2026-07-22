import type { BrowserAudioRoute } from './audio-memory'
import {
  MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS,
  MAX_BROWSER_GPU_TEXTURE_BYTES,
  type BrowserStorageSnapshot,
  type BrowserVideoLoad,
} from './browser-admission'

export type ExportEngine = 'browser' | 'server'

// Server has a startup/IPC cost and may use an approximation for captions or
// effects. Do not route short, preview-sensitive timelines away from the
// Browser merely because a stale throughput sample predicts a small speed win.
// Browser remains the default for short jobs unless admission actually fails.
export const AUTO_SERVER_MIN_DURATION_SEC = 5 * 60

export interface ExportThroughputProfile {
  browserSpeedX?: number
  serverSpeedX?: number
}

export interface ExportEngineAdviceInput {
  durationSec: number
  width: number
  height: number
  fps: number
  estimatedOutputBytes: number
  videoLoad: BrowserVideoLoad
  audioRoute: BrowserAudioRoute
  browserStorage: BrowserStorageSnapshot | null
  directOutput: boolean
  /** Backend can finalize Browser video with server-side audio, bypassing JS PCM limits. */
  hybridAudioAvailable?: boolean
  serverAvailable: boolean
  serverParityGaps: string[]
  exactParity: boolean
  serverEncoder?: string | null
  throughput?: ExportThroughputProfile
}

export interface ExportEngineAdvice {
  recommended: ExportEngine
  browserAllowed: boolean
  serverAllowed: boolean
  blockedReason?: string
  headline: string
  reasons: string[]
  warnings: string[]
  browserEstimateSec: number
  serverEstimateSec: number | null
  mode: 'browser' | 'browser-direct' | 'server'
}

export function shouldApplyEngineRecommendation(
  userPicked: boolean,
  current: ExportEngine,
  advice: Pick<ExportEngineAdvice, 'browserAllowed' | 'serverAllowed'>,
): boolean {
  if (!userPicked) return true
  return current === 'browser' ? !advice.browserAllowed : !advice.serverAllowed
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

function defaultBrowserSpeedX(input: ExportEngineAdviceInput): number {
  const pixelRate = Math.max(1, input.width * input.height * input.fps)
  const baseline = 1920 * 1080 * 30
  const resolutionFactor = Math.sqrt(baseline / pixelRate)
  const mappingFactor = 1 / Math.max(1, input.videoLoad.maxMappings / 2)
  return clamp(0.55 * resolutionFactor * mappingFactor, 0.04, 1.25)
}

function defaultServerSpeedX(input: ExportEngineAdviceInput): number {
  const pixelRate = Math.max(1, input.width * input.height * input.fps)
  const baseline = 1920 * 1080 * 30
  const resolutionFactor = Math.sqrt(baseline / pixelRate)
  const encoder = (input.serverEncoder ?? '').toLowerCase()
  const baseSpeed = encoder.startsWith('libaom')
    ? 0.15
    : encoder.startsWith('libsvtav1')
      ? 0.35
      : encoder.startsWith('lib')
        ? 0.8
        : 2.8
  return clamp(baseSpeed * resolutionFactor, 0.04, 8)
}

function estimateSeconds(durationSec: number, speedX: number): number {
  if (durationSec <= 0) return 0
  return durationSec / Math.max(0.01, speedX)
}

export function adviseExportEngine(input: ExportEngineAdviceInput): ExportEngineAdvice {
  const warnings: string[] = []
  const reasons: string[] = []
  const serverAllowed = input.serverAvailable && input.serverParityGaps.length === 0
  const hybridAudioNeeded = !!input.hybridAudioAvailable && input.audioRoute.action !== 'browser'
  let browserAllowed = input.audioRoute.action === 'browser' || hybridAudioNeeded

  if (input.videoLoad.maxMappings > MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS) {
    warnings.push(
      `${input.videoLoad.maxMappings} video mappings exceed the resident browser decoder budget ` +
        `(${MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS}).`,
    )
  }
  if (input.videoLoad.peakTextureBytes > MAX_BROWSER_GPU_TEXTURE_BYTES) {
    warnings.push(
      `Source textures peak near ${Math.ceil(input.videoLoad.peakTextureBytes / 1024 ** 2)} MiB ` +
        'before decoder and encoder surfaces.',
    )
  }
  if (
    !input.directOutput &&
    input.browserStorage &&
    input.browserStorage.availableBytes < input.estimatedOutputBytes
  ) {
    browserAllowed = false
    warnings.push('Browser storage does not have enough estimated free space for this output.')
  }

  if (input.audioRoute.action === 'server') {
    reasons.push(hybridAudioNeeded
      ? 'Hybrid mode keeps the audio mix out of browser memory.'
      : 'The browser audio memory estimate exceeds its safe budget.')
  } else if (input.audioRoute.action === 'block') {
    reasons.push(hybridAudioNeeded
      ? 'Hybrid mode bypasses the browser audio allocation that would otherwise block export.'
      : input.audioRoute.message)
  }
  if (input.exactParity && input.serverParityGaps.length > 0) {
    reasons.push('This timeline uses visual features that FFmpeg cannot reproduce pixel-identically.')
  }

  const browserSpeedX = input.throughput?.browserSpeedX ?? defaultBrowserSpeedX(input)
  const serverSpeedX = input.throughput?.serverSpeedX ?? defaultServerSpeedX(input)
  const browserEstimateSec = estimateSeconds(input.durationSec, browserSpeedX)
  const serverEstimateSec = input.serverAvailable
    ? estimateSeconds(input.durationSec, serverSpeedX)
    : null

  let recommended: ExportEngine = 'browser'
  if (!browserAllowed && serverAllowed) {
    recommended = 'server'
    reasons.push('Browser admission failed; Server is the safe available path.')
  } else if (input.audioRoute.action === 'server' && serverAllowed && !hybridAudioNeeded) {
    recommended = 'server'
  } else if (serverAllowed) {
    const browserHeavy =
      warnings.length > 0 ||
      input.durationSec >= 30 * 60 ||
      input.estimatedOutputBytes >= 2 * 1024 ** 3
    const serverMateriallyFaster =
      input.durationSec >= AUTO_SERVER_MIN_DURATION_SEC &&
      (serverEstimateSec ?? Infinity) < browserEstimateSec * 0.7
    if (browserHeavy || serverMateriallyFaster) {
      recommended = 'server'
      reasons.push('Server is expected to finish materially faster for this workload.')
    }
  }

  if (recommended === 'browser') {
    if (input.exactParity && input.serverParityGaps.length > 0) {
      reasons.push('Browser uses the same visual renderer as Preview.')
    } else if (!input.serverAvailable) {
      reasons.push('The Server exporter is not available.')
    } else {
      reasons.push('Browser remains within the current decoder, memory and storage budgets.')
    }
  }

  const bothBlocked = !browserAllowed && !serverAllowed
  return {
    recommended,
    browserAllowed,
    serverAllowed,
    blockedReason: bothBlocked
      ? input.audioRoute.action === 'block'
        ? input.audioRoute.message
        : 'Neither exporter can safely handle the current timeline and output destination.'
      : undefined,
    headline:
      recommended === 'server'
        ? 'Server recommended for throughput and bounded resources.'
        : hybridAudioNeeded
          ? 'Hybrid Browser + Server audio recommended for preview parity and bounded memory.'
        : input.directOutput
          ? 'Browser Direct recommended for preview parity without an OPFS copy.'
          : 'Browser recommended for preview parity.',
    reasons: [...new Set(reasons)],
    warnings,
    browserEstimateSec,
    serverEstimateSec,
    mode: recommended === 'server' ? 'server' : input.directOutput ? 'browser-direct' : 'browser',
  }
}
