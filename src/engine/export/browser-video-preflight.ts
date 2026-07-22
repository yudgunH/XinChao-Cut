import type { MediaAsset } from '@engine/media'

import type { DesktopVideoSourceReader } from './exporter'
import {
  createVideoSampleIndex,
  type VideoReaderSource,
  type VideoSampleIndex,
} from './frame-reader'

interface BrowserVideoPreflightOptions {
  assets: readonly MediaAsset[]
  desktopVideoSource?: DesktopVideoSourceReader
  getBlob(assetId: string): Promise<Blob | null>
  signal?: AbortSignal
  createSampleIndex?: (source: VideoReaderSource) => Promise<VideoSampleIndex>
  isConfigSupported?: (config: VideoDecoderConfig) => Promise<{ supported: boolean }>
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
}

function decoderConfig(index: VideoSampleIndex): VideoDecoderConfig {
  const config: VideoDecoderConfig = {
    codec: index.codec,
    codedWidth: index.codedWidth,
    codedHeight: index.codedHeight,
    hardwareAcceleration: 'prefer-hardware',
  }
  if (index.description) config.description = index.description
  return config
}

export function hasPathBackedVideoAssets(assets: readonly MediaAsset[]): boolean {
  return assets.some(
    (asset) => asset.kind === 'video' && !!asset.sourcePath && !asset.normalizedBlobKey,
  )
}

/**
 * Path-backed video no longer forces the main thread: the export worker reads
 * desktop files through the desktop-source postMessage proxy (export.worker.ts
 * ↔ runBrowserWorker), so those exports keep the worker's UI-free encode loop.
 * Only the streaming-audio encode path still requires the main thread.
 */
export function shouldUseMainThreadBrowserExport(canStreamEncode: boolean): boolean {
  return canStreamEncode
}

/**
 * Best-effort warning probe only. Expected demux/codec incompatibility marks an
 * asset slow; incidental probe I/O/API errors are ignored so preflight never
 * blocks the real export path.
 */
export async function findSlowBrowserVideoAssets(
  options: BrowserVideoPreflightOptions,
): Promise<string[]> {
  const createIndex = options.createSampleIndex ?? createVideoSampleIndex
  const checkConfig =
    options.isConfigSupported ??
    (typeof VideoDecoder !== 'undefined'
      ? (config: VideoDecoderConfig) => VideoDecoder.isConfigSupported(config)
      : null)
  const slowAssets: string[] = []
  for (const asset of options.assets) {
    if (asset.kind !== 'video') continue
    abortIfNeeded(options.signal)

    let source: VideoReaderSource
    if (asset.normalizedBlobKey) {
      try {
        const blob = await options.getBlob(asset.id)
        if (!blob) continue
        source = blob
      } catch {
        abortIfNeeded(options.signal)
        continue
      }
    } else if (asset.sourcePath) {
      if (!options.desktopVideoSource) {
        slowAssets.push(asset.name)
        continue
      }
      try {
        const sourcePath = asset.sourcePath
        const size = await options.desktopVideoSource.size(sourcePath)
        source = {
          size,
          read: (start, end) => options.desktopVideoSource!.read(sourcePath, start, end),
        }
      } catch {
        abortIfNeeded(options.signal)
        continue
      }
    } else {
      try {
        const blob = await options.getBlob(asset.id)
        if (!blob) continue
        source = blob
      } catch {
        abortIfNeeded(options.signal)
        continue
      }
    }

    let index: VideoSampleIndex
    try {
      index = await createIndex(source)
    } catch {
      abortIfNeeded(options.signal)
      slowAssets.push(asset.name)
      continue
    }
    if (!checkConfig) continue
    try {
      const support = await checkConfig(decoderConfig(index))
      if (!support.supported) slowAssets.push(asset.name)
    } catch {
      abortIfNeeded(options.signal)
      // Capability probing is advisory. The real export retains its own
      // authoritative decoder/fallback handling.
    }
  }
  return slowAssets
}

export function browserVideoSlowWarning(
  slowAssets: readonly string[],
  serverAvailable: boolean,
): string | null {
  if (slowAssets.length === 0) return null
  const names = slowAssets.map((name) => `"${name}"`).join(', ')
  const action = serverAvailable
    ? 'Switch to Server export for full speed on this file.'
    : 'Start the backend, then switch to Server export for full speed on this file.'
  return (
    `${names} cannot use the fast WebCodecs decoder — ` +
    `browser export will run at ~20fps. ${action}`
  )
}

export function browserVideoNormalizingWarning(
  assets: readonly MediaAsset[],
  serverAvailable: boolean,
): string | null {
  const active = assets.filter(
    (asset) =>
      asset.kind === 'video' &&
      (asset.normalizationStatus === 'queued' || asset.normalizationStatus === 'running'),
  )
  if (active.length === 0) return null
  const names = active.map((asset) => `"${asset.name}"`).join(', ')
  const action = serverAvailable
    ? 'Wait for normalization to finish for fast browser export, or use Server export now.'
    : 'Wait for normalization to finish; the backend must be online to complete it.'
  return `${names} is still being normalized — ${action}`
}
