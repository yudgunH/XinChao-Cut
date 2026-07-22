import { audioEngine } from '@engine/audio'
import {
  cancelBrowserExportStream,
  preflightBrowserExportStream,
  type ServerExportDiag,
} from '@engine/backend'
import {
  desktopMediaFileSize,
  isTauri,
  mediaManager,
  readDesktopMediaRange,
  type MediaAsset,
} from '@engine/media'
import { buildSrt, type SubtitleCue } from '@engine/subtitle/srt'
import { clipEffectiveDuration, type Clip, type Track } from '@engine/timeline'

import {
  assertAudibleAssetsResolved,
  MissingMediaError,
  preflightAudibleMediaBlobs,
} from './audio-asset-preflight'
import {
  collectAudibleSourceEstimates,
  decideBrowserAudioRoute,
  estimateBrowserAudioPeakBytes,
  isExportAudibleClip,
  type BrowserAudioRoute,
} from './audio-memory'
import {
  MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS,
  MAX_BROWSER_GPU_TEXTURE_BYTES,
  estimateBrowserOutputBytes,
  measureBrowserVideoLoad,
} from './browser-admission'
import {
  browserVideoNormalizingWarning,
  browserVideoSlowWarning,
  findSlowBrowserVideoAssets,
  hasPathBackedVideoAssets,
  shouldUseMainThreadBrowserExport,
} from './browser-video-preflight'
import { encodeMp3, encodeWavAsync } from './audio-file'
import { isStreamingAudioAvailable, isStreamingAudioEncodeSupported } from './audio-stream-mix'
import { masterAudioBufferInPlace } from './audio-mastering'
import type { ExportEngine } from './engine-advisor'
import {
  audioMixToPcm,
  exportVideo,
  exportVideoCore,
  renderAudioMix,
  type BrowserExportResult,
  type DesktopVideoSourceReader,
  type ExportProgress,
  type ExportSettings,
  type ExportVideoCodec,
  type PcmAudio,
} from './exporter'
import type { ExportWorkload } from './performance-profile'
import type { ExportQualityDefinition } from './quality'
import type { ExportSpec } from './spec'

export interface RunExportTimeline {
  durationSec: number
  clips: Clip[]
  tracks: Track[]
}

export interface RunExportCallbacks {
  onProgress: (progress: ExportProgress) => void
  onNote: (note: string | null) => void
  onServerLabel: (label: string | null) => void
  onSavedPath: (path: string | null) => void
  onOutputUrl: (url: string | null) => void
  isCurrent: (opId: string) => boolean
  signal: AbortSignal
  onServerDiag: (diag: ServerExportDiag | null) => void
  onEngineChange: (engine: ExportEngine) => void
  onAssetHash: (assetId: string, hash: string) => void
  onDownload: (blob: Blob, ext: string) => void
  onRenderStart: (engine: ExportEngine) => void
}

export interface RunExportParams {
  opId: string
  settings: ExportSettings
  timeline: RunExportTimeline
  assets: MediaAsset[]
  engine: ExportEngine
  exportWorkload: ExportWorkload
  engineBlockedReason?: string
  serverAvailable: boolean
  mustUseBrowser: boolean
  exportDir: string
  name: string
  videoOn: boolean
  audioOn: boolean
  audioFormat: 'mp3' | 'wav'
  subsOn: boolean
  audioClipCount: number
  quality: Pick<ExportQualityDefinition, 'audioBitrateKbps'>
  urlCache: Map<string, string>
  urlSourceKeys: Map<string, string>
  scratchKey: string
}

export type RunExportValidationInput = Pick<
  RunExportParams,
  | 'settings'
  | 'timeline'
  | 'assets'
  | 'engine'
  | 'exportWorkload'
  | 'engineBlockedReason'
  | 'serverAvailable'
  | 'mustUseBrowser'
  | 'exportDir'
  | 'videoOn'
  | 'audioClipCount'
>

function browserStreamRequestId(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto?.randomUUID === 'function') {
    return browserCrypto.randomUUID().replaceAll('-', '')
  }
  if (typeof browserCrypto?.getRandomValues === 'function') {
    return Array.from(browserCrypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0')).join('')
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

export const newBrowserExportScratchKey = () =>
  `__export-tmp-${browserStreamRequestId()}.mp4`

const abortError = () => new DOMException('Export cancelled', 'AbortError')

function assertCurrent(
  opId: string,
  callbacks: Pick<RunExportCallbacks, 'isCurrent' | 'signal'>,
): void {
  if (!callbacks.isCurrent(opId) || callbacks.signal.aborted) throw abortError()
}

function applyIfCurrent(
  opId: string,
  callbacks: Pick<RunExportCallbacks, 'isCurrent'>,
  fn: () => void,
): void {
  if (!callbacks.isCurrent(opId)) return
  fn()
}

/** Collect subtitle cues exactly as the dialog's SRT option has historically done. */
export function buildSubtitleCues(timeline: RunExportTimeline): SubtitleCue[] {
  const textTrackIds = new Set(
    timeline.tracks.filter((track) => track.kind === 'text' && !track.hidden).map((track) => track.id),
  )
  return timeline.clips
    .filter((clip) => {
      if (!textTrackIds.has(clip.trackId)) return false
      const text = clip.textData
      return !!text?.content?.trim() && !!(text.stroke || text.wordTimestamps)
    })
    .map((clip) => ({
      startSec: clip.startSec,
      endSec: clip.startSec + clipEffectiveDuration(clip),
      content: clip.textData!.content,
    }))
    .sort((a, b) => a.startSec - b.startSec)
}

/** Assets that appear on the timeline; unused library media is never decoded. */
export function collectUsedAssets(timeline: RunExportTimeline, assets: MediaAsset[]): MediaAsset[] {
  const used = new Set<string>()
  for (const clip of timeline.clips) {
    if (clip.assetId) used.add(clip.assetId)
  }
  return assets.filter((asset) => used.has(asset.id))
}

export function collectAudibleAssetIds(timeline: RunExportTimeline): Set<string> {
  const ids = new Set<string>()
  for (const clip of timeline.clips) {
    if (clip.assetId && isExportAudibleClip(clip, timeline.tracks)) ids.add(clip.assetId)
  }
  return ids
}

export function countAudibleClips(timeline: RunExportTimeline, assets: MediaAsset[]): number {
  return timeline.clips.filter((clip) => {
    if (!isExportAudibleClip(clip, timeline.tracks)) return false
    const asset = assets.find((candidate) => candidate.id === clip.assetId)
    return !!asset && (asset.kind === 'audio' || asset.kind === 'video')
  }).length
}

export function preflightBrowserAudio(
  input: Pick<RunExportParams, 'timeline' | 'assets' | 'serverAvailable' | 'mustUseBrowser'>,
  purpose: 'video' | 'audio-file',
  encode: 'none' | 'wav' | 'mp3',
): BrowserAudioRoute {
  const sources = collectAudibleSourceEstimates(
    input.timeline.clips,
    input.timeline.tracks,
    input.assets,
  )
  const estimate = estimateBrowserAudioPeakBytes({
    durationSec: input.timeline.durationSec,
    sources,
    encode,
  })
  return decideBrowserAudioRoute({
    estimate,
    serverAvailable: input.serverAvailable,
    serverParityOk: !input.mustUseBrowser,
    purpose,
    // S3B: long video may use block-streaming mix (not full OfflineAudioContext).
    streamingAvailable: purpose === 'video' && isStreamingAudioAvailable(),
  })
}

export function preflightBrowserVideo(
  input: Pick<RunExportParams, 'timeline' | 'assets'>,
): { action: 'browser'; warning?: string } {
  const load = measureBrowserVideoLoad(
    input.timeline.clips,
    input.timeline.tracks,
    input.assets,
  )
  const mappingHeavy = load.maxMappings > MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS
  const textureHeavy = load.peakTextureBytes > MAX_BROWSER_GPU_TEXTURE_BYTES
  if (!mappingHeavy && !textureHeavy) return { action: 'browser' }

  const details: string[] = []
  if (mappingHeavy) {
    details.push(
      `${load.maxMappings} simultaneous video mappings near ${load.atSec.toFixed(1)}s ` +
        `(resident decoder limit ${MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS})`,
    )
  }
  if (textureHeavy) {
    details.push(
      `about ${(load.peakTextureBytes / 1024 ** 2).toFixed(0)} MiB of source textures ` +
        '(before decoder and encoder surfaces)',
    )
  }
  return {
    action: 'browser',
    warning:
      `${details.join('; ')}. Browser export may fall back to slower Canvas 2D/transient ` +
      'decoding, but Browser remains selected to preserve preview parity.',
  }
}

/** Synchronous validation that must run before ExportOperationOwner.tryBegin(). */
export function validateRunExport(input: RunExportValidationInput): string | null {
  if (
    input.videoOn && input.settings.dynamicRange === 'hdr10' &&
    (input.engine !== 'server' || input.exportWorkload !== 'simple' ||
      !input.timeline.clips.some((clip) => input.timeline.tracks.some(
        (track) => track.id === clip.trackId && track.kind === 'video' && !track.hidden,
      )))
  ) {
    return (
      'HDR10 currently requires Server export with one unedited HDR video and no captions/effects. ' +
      'Use SDR for composited timelines.'
    )
  }
  const initialAudioRoute = preflightBrowserAudio(input, 'video', 'none')
  const hybridCanHandleAudio =
    input.engine === 'browser' && !!input.exportDir && input.serverAvailable &&
    input.audioClipCount > 0 && initialAudioRoute.action !== 'browser'
  if (input.videoOn && input.engineBlockedReason && !hybridCanHandleAudio) {
    return input.engineBlockedReason
  }
  return null
}

async function prepareAudioBuffers(
  timeline: RunExportTimeline,
  assets: MediaAsset[],
  signal?: AbortSignal,
): Promise<Map<string, AudioBuffer>> {
  const map = new Map<string, AudioBuffer>()
  const need = collectAudibleAssetIds(timeline)
  const blobs = await preflightAudibleMediaBlobs({
    audibleAssetIds: need,
    assets,
    hasBuffer: (id) => audioEngine.hasBuffer(id),
    getBlob: (id) => mediaManager.getBlob(id),
    signal,
  })
  for (const asset of assets) {
    if (signal?.aborted) throw abortError()
    if (!need.has(asset.id)) continue
    if (asset.kind !== 'audio' && asset.kind !== 'video') continue
    if (!audioEngine.hasBuffer(asset.id)) {
      const blob = blobs.get(asset.id)
      if (signal?.aborted) throw abortError()
      if (!blob) throw new MissingMediaError(asset)
      await audioEngine.ensureDecoded(asset.id, blob, signal)
    }
    const buffer = audioEngine.getBuffer(asset.id)
    if (buffer) {
      map.set(asset.id, buffer)
    } else {
      const why = audioEngine.getDecodeError(asset.id)
      if (why) {
        throw new Error(`Cannot export: audio for "${asset.name}" could not be decoded. ${why}`)
      }
    }
  }
  assertAudibleAssetsResolved(need, assets, map)
  return map
}

async function downloadAudio(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
): Promise<boolean> {
  const { opId } = params
  assertCurrent(opId, callbacks)
  // S3A: block long-form audio-file export before decoding sources.
  const route = preflightBrowserAudio(params, 'audio-file', params.audioFormat)
  if (route.action === 'block') throw new Error(route.message)
  if (route.action === 'server') {
    // Server only yields MP4 video; never silently change audio-file output.
    throw new Error(route.reason)
  }

  const buffers = await prepareAudioBuffers(params.timeline, params.assets, callbacks.signal)
  assertCurrent(opId, callbacks)
  const mix = await renderAudioMix(
    params.timeline.durationSec,
    params.timeline.clips,
    params.timeline.tracks,
    buffers,
    callbacks.signal,
  )
  assertCurrent(opId, callbacks)
  if (!mix) return false
  const mastering = params.settings.audioMastering
  if (mastering && mastering !== 'off') {
    masterAudioBufferInPlace(mix, mastering)
  }
  const blob = params.audioFormat === 'wav'
    ? await encodeWavAsync(mix, callbacks.signal)
    : await encodeMp3(mix, 192, callbacks.signal)
  if (!callbacks.isCurrent(opId)) return false
  callbacks.onDownload(blob, params.audioFormat)
  return true
}

function reportBrowserRenderPath(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
  result: { videoCodec?: ExportVideoCodec; zeroCopy?: 'off' | 'active' | 'fallback' | 'ineligible' },
): void {
  if (!callbacks.isCurrent(params.opId)) return
  const messages: string[] = []
  const requestedVideoCodec = params.settings.videoCodec ?? 'h264'
  if (result.videoCodec && result.videoCodec !== requestedVideoCodec) {
    messages.push(`${requestedVideoCodec.toUpperCase()} unavailable; exported H.264 safely.`)
  }
  if (params.settings.browserZeroCopy !== 'off') {
    if (result.zeroCopy === 'active') messages.push('GPU zero-copy active on eligible frames.')
    else if (result.zeroCopy === 'fallback') {
      messages.push('GPU zero-copy probe failed; used safe Canvas2D fallback.')
    } else if (result.zeroCopy === 'ineligible') {
      messages.push('No overlay-free GPU frames; used Canvas2D path.')
    }
  }
  if (messages.length > 0) callbacks.onNote(messages.join(' '))
}

function publishBrowserResult(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
  result: BrowserExportResult,
): void {
  assertCurrent(params.opId, callbacks)
  reportBrowserRenderPath(params, callbacks, result)
  if (result.savedPath) {
    applyIfCurrent(params.opId, callbacks, () => callbacks.onSavedPath(result.savedPath!))
    callbacks.onProgress({ frame: 1, total: 1, phase: 'done' })
  } else if (result.blob) {
    const url = URL.createObjectURL(result.blob)
    callbacks.onOutputUrl(url)
    callbacks.onProgress({ frame: 1, total: 1, phase: 'done' })
  } else {
    throw new Error('Browser export completed without a file or saved path')
  }
}

async function runBrowserWorker(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
  exportAssets: MediaAsset[],
  pcmAudio: PcmAudio | null,
  directOutput: Parameters<typeof exportVideoCore>[10],
): Promise<BrowserExportResult> {
  return new Promise<BrowserExportResult>((resolve, reject) => {
    if (!callbacks.isCurrent(params.opId) || callbacks.signal.aborted) {
      reject(abortError())
      return
    }
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    let hardCancelTimer: ReturnType<typeof setTimeout> | null = null
    const cleanupWorker = () => {
      if (hardCancelTimer !== null) clearTimeout(hardCancelTimer)
      hardCancelTimer = null
      callbacks.signal.removeEventListener('abort', onAbort)
    }
    const finish = (outcome: { result: BrowserExportResult } | { error: unknown }) => {
      if (settled) return
      settled = true
      cleanupWorker()
      worker.terminate()
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.result)
    }
    const onAbort = () => {
      try { worker.postMessage({ type: 'abort' }) } catch { /* hard kill below */ }
      hardCancelTimer ??= setTimeout(() => {
        if (directOutput?.requestId) void cancelBrowserExportStream(directOutput.requestId)
        finish({ error: abortError() })
      }, 10_000)
    }
    callbacks.signal.addEventListener('abort', onAbort, { once: true })
    if (callbacks.signal.aborted) onAbort()

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; [key: string]: unknown }
      if (message.type === 'desktop-source-size') {
        const requestId = message.requestId as number
        const sourcePath = message.sourcePath as string
        void desktopMediaFileSize(sourcePath).then(
          (size) => worker.postMessage({ type: 'desktop-source-response', requestId, size }),
          (error) => worker.postMessage({
            type: 'desktop-source-response',
            requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      } else if (message.type === 'desktop-source-read') {
        const requestId = message.requestId as number
        const sourcePath = message.sourcePath as string
        const start = message.start as number
        const end = message.end as number
        void readDesktopMediaRange(sourcePath, start, end).then(
          (buffer) => worker.postMessage(
            { type: 'desktop-source-response', requestId, buffer },
            [buffer],
          ),
          (error) => worker.postMessage({
            type: 'desktop-source-response',
            requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      } else if (message.type === 'progress') {
        callbacks.onProgress({
          frame: message.frame as number,
          total: message.total as number,
          phase: message.phase as ExportProgress['phase'],
          renderedFrame: message.renderedFrame as number | undefined,
          renderedTotal: message.renderedTotal as number | undefined,
          seekFallbackAsset: message.seekFallbackAsset as string | undefined,
          zeroCopy: message.zeroCopy as ExportProgress['zeroCopy'],
          videoCodec: message.videoCodec as ExportProgress['videoCodec'],
        })
      } else if (message.type === 'done') {
        if (!callbacks.isCurrent(params.opId)) {
          finish({ error: abortError() })
          return
        }
        finish({
          result: {
            blob: (message.blob as Blob | null) ?? null,
            savedPath: message.savedPath as string | undefined,
            videoCodec: (message.videoCodec as ExportVideoCodec | undefined) ?? 'h264',
            zeroCopy:
              (message.zeroCopy as BrowserExportResult['zeroCopy'] | undefined) ?? 'off',
          },
        })
      } else if (message.type === 'aborted') {
        finish({ error: abortError() })
      } else if (message.type === 'unsupported') {
        finish({ error: new DOMException('worker decode unsupported', 'NotSupportedError') })
      } else if (message.type === 'error') {
        finish({ error: new Error(message.message as string) })
      }
    }
    worker.onerror = (event) => {
      if (directOutput?.requestId) void cancelBrowserExportStream(directOutput.requestId)
      finish({ error: new Error(event.message) })
    }

    const transfer: Transferable[] = pcmAudio?.channels.map((channel) => channel.buffer) ?? []
    try {
      worker.postMessage({
        type: 'start',
        settings: params.settings,
        durationSec: params.timeline.durationSec,
        clips: params.timeline.clips,
        tracks: params.timeline.tracks,
        assets: exportAssets,
        urlEntries: [...params.urlCache.entries()],
        pcmAudio,
        directOutput,
        scratchKey: params.scratchKey,
      }, transfer)
    } catch (error) {
      finish({ error })
    }
  })
}

export async function runBrowserExport(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
): Promise<void> {
  assertCurrent(params.opId, callbacks)
  const videoRoute = preflightBrowserVideo(params)
  if (videoRoute.warning) {
    applyIfCurrent(params.opId, callbacks, () => callbacks.onNote(videoRoute.warning!))
  }
  const exportAssets = collectUsedAssets(params.timeline, params.assets)
  const desktopVideoSource: DesktopVideoSourceReader | undefined = isTauri()
    ? { size: desktopMediaFileSize, read: readDesktopMediaRange }
    : undefined
  const hasSourcePathVideo = hasPathBackedVideoAssets(exportAssets)
  try {
    const slowAssets = await findSlowBrowserVideoAssets({
      assets: exportAssets,
      desktopVideoSource,
      getBlob: (assetId) => mediaManager.getBlob(assetId),
      signal: callbacks.signal,
    })
    const warning = browserVideoSlowWarning(slowAssets, params.serverAvailable)
    const normalizingWarning = browserVideoNormalizingWarning(
      exportAssets,
      params.serverAvailable,
    )
    if (normalizingWarning) {
      applyIfCurrent(params.opId, callbacks, () => callbacks.onNote(normalizingWarning))
    } else if (warning) {
      applyIfCurrent(params.opId, callbacks, () => callbacks.onNote(warning))
    }
  } catch (preflightError) {
    if (preflightError instanceof DOMException && preflightError.name === 'AbortError') {
      throw preflightError
    }
    // Advisory only: the exporter keeps the authoritative fallback/error path.
  }
  if (hasSourcePathVideo && desktopVideoSource) {
    // eslint-disable-next-line no-console
    console.info('[export] sourcePath assets → worker WebCodecs path (desktop-source proxy)')
  }

  const route = preflightBrowserAudio(params, 'video', 'none')
  const audibleIds = collectAudibleAssetIds(params.timeline)
  const pathBackedAudioNeedsBackend = params.assets.some(
    (asset) => audibleIds.has(asset.id) && !audioEngine.hasBuffer(asset.id) &&
      !!(asset.sourcePath || asset.playbackUrl),
  )
  const streamingAudioSupported =
    route.action === 'browser' && route.estimate.overBudget
      ? await isStreamingAudioEncodeSupported(params.quality.audioBitrateKbps * 1_000)
      : false
  const useHybrid =
    !!params.exportDir && params.serverAvailable && audibleIds.size > 0 &&
    (pathBackedAudioNeedsBackend || route.action !== 'browser' ||
      (route.estimate.overBudget && !streamingAudioSupported))
  if (pathBackedAudioNeedsBackend && !useHybrid) {
    throw new Error(
      'This timeline uses path-backed audio/video that must stay streamed to avoid multi-GB browser RAM usage. ' +
      'Choose an output folder with the backend online for Hybrid Export, or use Server Export.',
    )
  }
  if (route.action !== 'browser' && !useHybrid) {
    throw new Error(route.action === 'block' ? route.message : route.reason)
  }

  const audioBuffers = new Map<string, AudioBuffer>()
  const browserAudioBlobs = useHybrid
    ? new Map<string, Blob>()
    : await preflightAudibleMediaBlobs({
        audibleAssetIds: audibleIds,
        assets: exportAssets,
        hasBuffer: (id) => audioEngine.hasBuffer(id),
        getBlob: (id) => mediaManager.getBlob(id),
        signal: callbacks.signal,
      })
  let hybridSpec: ExportSpec | undefined
  if (useHybrid) {
    const { prepareHybridExportSpec } = await import('./server-export')
    hybridSpec = await prepareHybridExportSpec({
      settings: params.settings,
      durationSec: params.timeline.durationSec,
      clips: params.timeline.clips,
      tracks: params.timeline.tracks,
      assets: params.assets,
      signal: callbacks.signal,
      onAssetHash: (assetId, hash) => {
        if (callbacks.isCurrent(params.opId)) callbacks.onAssetHash(assetId, hash)
      },
      onProgress: (pct, stage) => {
        applyIfCurrent(params.opId, callbacks, () => {
          callbacks.onServerLabel(stage.replace('media', 'audio'))
          callbacks.onNote('Preparing Hybrid Export audio on the backend…')
        })
        callbacks.onProgress({ frame: pct, total: 100, phase: 'audio' })
      },
    })
  }

  for (const asset of exportAssets) {
    assertCurrent(params.opId, callbacks)
    const sourceKey =
      asset.normalizedBlobKey ?? asset.proxyStorageKey ?? asset.storageKey ??
      asset.sourcePath ?? asset.playbackUrl ?? ''
    if (params.urlSourceKeys.get(asset.id) !== sourceKey) {
      const previous = params.urlCache.get(asset.id)
      if (previous) URL.revokeObjectURL(previous)
      params.urlCache.delete(asset.id)
      params.urlSourceKeys.set(asset.id, sourceKey)
    }
    if (!params.urlCache.has(asset.id)) {
      const url = await mediaManager.getObjectUrl(asset.id)
      if (url) params.urlCache.set(asset.id, url)
    }
    if (!useHybrid && audibleIds.has(asset.id) &&
      (asset.kind === 'audio' || asset.kind === 'video')) {
      if (!audioEngine.hasBuffer(asset.id)) {
        const blob = browserAudioBlobs.get(asset.id)
        if (!blob) throw new MissingMediaError(asset)
        await audioEngine.ensureDecoded(asset.id, blob, callbacks.signal)
      }
      const buffer = audioEngine.getBuffer(asset.id)
      if (buffer) {
        audioBuffers.set(asset.id, buffer)
      } else {
        const why = audioEngine.getDecodeError(asset.id)
        if (why) {
          throw new Error(`Cannot export: audio for "${asset.name}" could not be decoded. ${why}`)
        }
      }
    }
  }
  if (!useHybrid) assertAudibleAssetsResolved(audibleIds, exportAssets, audioBuffers)

  assertCurrent(params.opId, callbacks)
  const totalFrames = Math.max(1, Math.ceil(params.timeline.durationSec * params.settings.fps))
  callbacks.onProgress({ frame: 0, total: totalFrames, phase: 'audio' })

  const canStreamEncode =
    !useHybrid && audibleIds.size > 0 && route.action === 'browser' &&
    route.estimate.overBudget && streamingAudioSupported
  let directOutput = params.exportDir
    ? {
        outputDir: params.exportDir,
        outputName: (params.name || 'export').trim(),
        estimatedBytes: estimateBrowserOutputBytes(
          params.timeline.durationSec,
          params.settings.videoBitrateKbps,
          audibleIds.size > 0,
          params.quality.audioBitrateKbps,
        ),
        requestId: browserStreamRequestId(),
        ...(hybridSpec ? { hybridSpec } : {}),
      }
    : undefined

  if (shouldUseMainThreadBrowserExport(canStreamEncode)) {
    // eslint-disable-next-line no-console
    console.info(
      '[export] streaming audio encode → main-thread path ' +
        '(interleaved AAC encode shares the frame loop thread)',
    )
    const result = await exportVideo(
      params.settings,
      params.timeline.durationSec,
      params.timeline.clips,
      params.timeline.tracks,
      exportAssets,
      params.urlCache,
      audioBuffers,
      callbacks.signal,
      callbacks.onProgress,
      directOutput,
      params.scratchKey,
      desktopVideoSource,
    )
    publishBrowserResult(params, callbacks, result)
    return
  }

  const audioMix = useHybrid
    ? null
    : await renderAudioMix(
        params.timeline.durationSec,
        params.timeline.clips,
        params.timeline.tracks,
        audioBuffers,
        callbacks.signal,
      )
  assertCurrent(params.opId, callbacks)
  const pcmAudio = audioMix ? audioMixToPcm(audioMix) : null

  let result: BrowserExportResult
  try {
    result = await runBrowserWorker(params, callbacks, exportAssets, pcmAudio, directOutput)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotSupportedError') {
      applyIfCurrent(params.opId, callbacks, () => callbacks.onNote(
        'This source codec/container is not supported by WebCodecs. ' +
        'Browser export is continuing with the exact-preview seek fallback, which is much slower. ' +
        'Remux/transcode the source to MP4 H.264 to restore the fast browser path.',
      ))
      assertCurrent(params.opId, callbacks)
      if (directOutput) directOutput = { ...directOutput, requestId: browserStreamRequestId() }
      result = useHybrid
        ? await exportVideoCore(
            params.settings,
            params.timeline.durationSec,
            params.timeline.clips,
            params.timeline.tracks,
            exportAssets,
            params.urlCache,
            null,
            () => callbacks.signal.aborted,
            callbacks.onProgress,
            undefined,
            directOutput,
            params.scratchKey,
            callbacks.signal,
            desktopVideoSource,
          )
        : await exportVideo(
            params.settings,
            params.timeline.durationSec,
            params.timeline.clips,
            params.timeline.tracks,
            exportAssets,
            params.urlCache,
            audioBuffers,
            callbacks.signal,
            callbacks.onProgress,
            directOutput,
            params.scratchKey,
            desktopVideoSource,
          )
    } else {
      throw error
    }
  }
  publishBrowserResult(params, callbacks, result)
}

export async function runServerExport(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
): Promise<void> {
  assertCurrent(params.opId, callbacks)
  const { runServerExport: render } = await import('./server-export')
  callbacks.onProgress({ frame: 0, total: 100, phase: 'encoding' })
  const result = await render({
    settings: params.settings,
    durationSec: params.timeline.durationSec,
    clips: params.timeline.clips,
    tracks: params.timeline.tracks,
    assets: params.assets,
    signal: callbacks.signal,
    onProgress: (pct, stage) => {
      applyIfCurrent(params.opId, callbacks, () => callbacks.onServerLabel(stage))
      callbacks.onProgress({ frame: pct, total: 100, phase: 'encoding' })
    },
    onAssetHash: (assetId, hash) => {
      if (callbacks.isCurrent(params.opId)) callbacks.onAssetHash(assetId, hash)
    },
    outputDir: params.exportDir || undefined,
    outputName: (params.name || 'export').trim(),
  })
  assertCurrent(params.opId, callbacks)
  applyIfCurrent(params.opId, callbacks, () => callbacks.onServerLabel('Done'))
  callbacks.onProgress({ frame: 100, total: 100, phase: 'done' })
  callbacks.onOutputUrl(result.downloadUrl)
  if (result.savedPath) {
    applyIfCurrent(params.opId, callbacks, () => callbacks.onSavedPath(result.savedPath!))
  }
  if (result.diag) {
    applyIfCurrent(params.opId, callbacks, () => callbacks.onServerDiag(result.diag!))
    const requestedVideoCodec = params.settings.videoCodec ?? 'h264'
    if (result.diag.videoCodec && result.diag.videoCodec !== requestedVideoCodec) {
      applyIfCurrent(params.opId, callbacks, () => callbacks.onNote(
        `${requestedVideoCodec.toUpperCase()} encoder unavailable; ` +
        `Server exported ${result.diag!.videoCodec!.toUpperCase()} safely.`,
      ))
    }
  }
}

export async function runExport(
  params: RunExportParams,
  callbacks: RunExportCallbacks,
): Promise<void> {
  const { opId } = params
  assertCurrent(opId, callbacks)

  if (params.videoOn && params.engine === 'browser' && params.exportDir) {
    if (!params.serverAvailable) {
      throw new Error(
        'Direct browser export to a native folder requires the local backend. ' +
        'Start the backend, or clear “Save to” to export through browser storage.',
      )
    }
    await preflightBrowserExportStream(
      params.exportDir,
      (params.name || 'export').trim(),
      estimateBrowserOutputBytes(
        params.timeline.durationSec,
        params.settings.videoBitrateKbps,
        params.audioClipCount > 0,
        params.quality.audioBitrateKbps,
      ),
    )
  }

  const done: string[] = []
  if (params.subsOn) {
    if (!callbacks.isCurrent(opId)) return
    const cues = buildSubtitleCues(params.timeline)
    if (cues.length > 0) {
      callbacks.onDownload(
        new Blob([buildSrt(cues)], { type: 'text/plain;charset=utf-8' }),
        'srt',
      )
      done.push('captions (.srt)')
    }
  }

  if (params.audioOn) {
    assertCurrent(opId, callbacks)
    applyIfCurrent(opId, callbacks, () => callbacks.onNote('Mixing audio…'))
    try {
      if (await downloadAudio(params, callbacks)) done.push(`audio (.${params.audioFormat})`)
    } catch (error) {
      if (!callbacks.isCurrent(opId)) return
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      applyIfCurrent(opId, callbacks, () => callbacks.onNote(null))
      throw error instanceof Error ? error : new Error('Audio export failed')
    }
  }

  if (!params.videoOn || params.timeline.durationSec === 0) {
    applyIfCurrent(opId, callbacks, () => callbacks.onNote(
      done.length ? `Exported ${done.join(' + ')}` : 'Nothing to export',
    ))
    return
  }
  assertCurrent(opId, callbacks)
  applyIfCurrent(opId, callbacks, () => callbacks.onNote(null))

  let useEngine: ExportEngine = params.engine
  if (params.engine === 'browser') {
    const videoRoute = preflightBrowserVideo(params)
    if (videoRoute.warning) {
      applyIfCurrent(opId, callbacks, () => callbacks.onNote(videoRoute.warning!))
    }
    const route = preflightBrowserAudio(params, 'video', 'none')
    const hybridAvailable =
      !!params.exportDir && params.serverAvailable && params.audioClipCount > 0 &&
      route.action !== 'browser'
    if (route.action === 'block' && !hybridAvailable) throw new Error(route.message)
    if (route.action === 'server' && useEngine === 'browser' && !hybridAvailable) {
      useEngine = 'server'
      applyIfCurrent(opId, callbacks, () => {
        callbacks.onEngineChange('server')
        callbacks.onNote(route.reason)
      })
    } else if (hybridAvailable) {
      applyIfCurrent(opId, callbacks, () => callbacks.onNote(
        'Hybrid Export: Browser renders exact preview pixels; ' +
        'server mixes audio and finalizes without re-encoding video.',
      ))
    }
  }
  if (useEngine === 'browser' && params.exportDir && !params.serverAvailable) {
    throw new Error(
      'Direct browser export to a native folder requires the local backend. ' +
      'Start the backend, or clear “Save to” to export through browser storage.',
    )
  }

  assertCurrent(opId, callbacks)
  callbacks.onRenderStart(useEngine)
  if (useEngine === 'server') await runServerExport(params, callbacks)
  else await runBrowserExport(params, callbacks)
}
