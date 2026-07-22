import {
  cancelMediaNormalization,
  checkAssets,
  downloadMediaNormalizationTo,
  getCapabilities,
  getMediaNormalizationStatus,
  hashBlob,
  isRetryableBackendPollError,
  startMediaNormalization,
  uploadAsset,
} from '@engine/backend'
import {
  createVideoSampleIndex,
  type VideoByteSource,
  type VideoReaderSource,
  type VideoSampleIndex,
} from '@engine/export/frame-reader'
import { db } from '@lib/dexie-db'
import {
  deleteBlob,
  writeStreamAtomic,
} from '@engine/persistence/opfs'
import { useProjectStore } from '@store/project-store'

import {
  desktopMediaFileSize,
  isTauri,
  readDesktopMediaRange,
} from './desktop'
import { mediaManager } from './media-manager'
import type { MediaAsset } from './types'

export type BrowserNormalizationProbeSource = Blob | { sourcePath: string }

interface ProbeDeps {
  createSampleIndex?: (source: VideoReaderSource) => Promise<VideoSampleIndex>
  isConfigSupported?: (config: VideoDecoderConfig) => Promise<{ supported: boolean }>
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

/** Import-time WebCodecs probe. It only answers whether the source is fast-safe. */
export async function isBrowserVideoSourceSupported(
  source: VideoReaderSource,
  deps: ProbeDeps = {},
): Promise<boolean> {
  try {
    const index = await (deps.createSampleIndex ?? createVideoSampleIndex)(source)
    const check = deps.isConfigSupported ??
      (typeof VideoDecoder !== 'undefined'
        ? (config: VideoDecoderConfig) => VideoDecoder.isConfigSupported(config)
        : null)
    if (!check) return false
    const result = await check(decoderConfig(index))
    return !!result.supported
  } catch {
    return false
  }
}

async function probeSource(
  asset: MediaAsset,
  imported: BrowserNormalizationProbeSource | undefined,
): Promise<VideoReaderSource | null> {
  if (imported instanceof Blob) return imported
  if (imported && 'sourcePath' in imported) {
    if (isTauri()) {
      const size = await desktopMediaFileSize(imported.sourcePath)
      const source: VideoByteSource = {
        size,
        read: (start, end) => readDesktopMediaRange(imported.sourcePath, start, end),
      }
      return source
    }
  }
  if (asset.sourcePath && isTauri()) {
    const size = await desktopMediaFileSize(asset.sourcePath)
    const source: VideoByteSource = {
      size,
      read: (start, end) => readDesktopMediaRange(asset.sourcePath!, start, end),
    }
    return source
  }
  return mediaManager.getBlob(asset.id)
}

async function patchAsset(
  assetId: string,
  patch: Partial<MediaAsset>,
): Promise<MediaAsset | null> {
  const current = await db.assets.get(assetId)
  if (!current) return null
  await db.assets.update(assetId, patch)
  const store = useProjectStore.getState()
  if (store.assets.some((asset) => asset.id === assetId)) {
    store.updateAsset(assetId, patch)
  }
  return { ...current, ...patch }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|networkerror|load failed|offline/i.test(error.message))
}

const activeRuns = new Map<string, Promise<void>>()
const queuedRuns = new Set<string>()
const normalizationQueue: Array<{ asset: MediaAsset; imported?: BrowserNormalizationProbeSource }> = []
export const NORMALIZATION_CONCURRENCY = 2

function pumpNormalizationQueue(): void {
  while (activeRuns.size < NORMALIZATION_CONCURRENCY && normalizationQueue.length > 0) {
    const next = normalizationQueue.shift()!
    queuedRuns.delete(next.asset.id)
    const run = runVideoNormalization(next.asset.id, next.imported)
      .catch((error) => {
        console.warn(`[media] normalization failed for "${next.asset.name}"`, error)
      })
      .finally(() => {
        activeRuns.delete(next.asset.id)
        pumpNormalizationQueue()
      })
    activeRuns.set(next.asset.id, run)
  }
}

/**
 * Probe one imported video and, only on a real WebCodecs failure, enqueue the
 * backend normalization job. The returned promise is intentionally detached
 * from import UI: the original asset remains immediately usable on the slow
 * path while the OPFS key is published later.
 */
export function scheduleVideoNormalization(
  asset: MediaAsset,
  imported?: BrowserNormalizationProbeSource,
): void {
  if (asset.kind !== 'video' || asset.normalizedBlobKey) return
  if (activeRuns.has(asset.id) || queuedRuns.has(asset.id)) return
  queuedRuns.add(asset.id)
  // Do not retain many multi-GB File objects in closures. The first two jobs
  // can reuse import bytes; queued jobs reopen their durable OPFS/source copy.
  normalizationQueue.push({
    asset,
    imported: activeRuns.size < NORMALIZATION_CONCURRENCY ? imported : undefined,
  })
  pumpNormalizationQueue()
}

export async function runVideoNormalization(
  assetId: string,
  imported?: BrowserNormalizationProbeSource,
  deps: ProbeDeps = {},
): Promise<void> {
  const original = await db.assets.get(assetId)
  if (!original || original.kind !== 'video' || original.normalizedBlobKey) return
  const source = await probeSource(original, imported)
  if (!source) return

  const supported = await isBrowserVideoSourceSupported(source, deps)
  if (supported) return

  const capabilities = await getCapabilities()
  if (!capabilities?.media) {
    await patchAsset(assetId, {
      normalizationStatus: 'offline',
      normalizationProgress: 0,
      normalizationJobId: undefined,
      normalizationError: undefined,
    })
    return
  }

  let blobForUpload: Blob | null = source instanceof Blob ? source : null
  let contentHash = original.contentHash
  try {
    if (original.sourcePath) {
      await patchAsset(assetId, {
        normalizationStatus: 'queued',
        normalizationProgress: 0,
        normalizationError: undefined,
      })
    } else {
      if (!blobForUpload) blobForUpload = await mediaManager.getBlob(assetId)
      if (!blobForUpload) throw new Error('Media bytes are unavailable for normalization')
      if (!contentHash || !/^[0-9a-f]{64}$/i.test(contentHash)) {
        contentHash = await hashBlob(blobForUpload)
      }
      const missing = await checkAssets([contentHash])
      if (missing.includes(contentHash)) {
        await uploadAsset(blobForUpload, contentHash, original.name || 'video')
      }
      await patchAsset(assetId, { contentHash })
      await patchAsset(assetId, {
        normalizationStatus: 'queued',
        normalizationProgress: 0,
        normalizationError: undefined,
      })
    }

    const started = await startMediaNormalization(
      original.sourcePath
        ? { sourcePath: original.sourcePath, hash: contentHash }
        : { hash: contentHash },
      original.name || 'video',
    )
      contentHash = started.hash || contentHash
      await patchAsset(assetId, {
        contentHash,
        normalizationJobId: started.id,
        normalizationStatus: started.status,
        normalizationProgress: started.pct,
      })

    let status = started
    let consecutivePollFailures = 0
    while (status.status === 'queued' || status.status === 'running') {
      if (!await db.assets.get(assetId)) {
        await cancelMediaNormalization(status.id).catch(() => undefined)
        return
      }
      await sleep(600)
      try {
        status = await getMediaNormalizationStatus(status.id)
        consecutivePollFailures = 0
      } catch (error) {
        consecutivePollFailures += 1
        if (!isRetryableBackendPollError(error) || consecutivePollFailures >= 10) throw error
        await patchAsset(assetId, {
          normalizationStatus: 'offline',
          normalizationJobId: status.id,
          normalizationError: error instanceof Error ? error.message : String(error),
        })
        await sleep(Math.min(15_000, 500 * 2 ** Math.min(consecutivePollFailures, 5)))
        continue
      }
      await patchAsset(assetId, {
        normalizationStatus: status.status,
        normalizationProgress: status.pct,
        normalizationError: status.error || undefined,
      })
    }
    if (status.status === 'cancelled') {
      await patchAsset(assetId, {
        normalizationStatus: 'cancelled',
        normalizationProgress: status.pct,
      })
      return
    }
    if (status.status === 'error') {
      throw new Error(status.error || 'Backend normalization failed')
    }

    if (!await db.assets.get(assetId)) return
    const finalKey = `${assetId}__normalized.mp4`
    const tempKey = `${finalKey}.download-${crypto.randomUUID()}`
    await writeStreamAtomic(tempKey, finalKey, (write) =>
      downloadMediaNormalizationTo(status.id, write),
    )
    if (!await db.assets.get(assetId)) {
      await deleteBlob(finalKey).catch(() => undefined)
      return
    }
    await patchAsset(assetId, {
      normalizedBlobKey: finalKey,
      normalizedPath: undefined,
      normalizationStatus: 'done',
      normalizationProgress: 100,
      normalizationJobId: undefined,
      normalizationError: undefined,
    })
  } catch (error) {
    if (!await db.assets.get(assetId)) return
    const status: MediaAsset['normalizationStatus'] =
      isNetworkError(error) ? 'offline' : 'error'
    await patchAsset(assetId, {
      normalizationStatus: status,
      normalizationProgress: 0,
      normalizationJobId: undefined,
      normalizationError: error instanceof Error ? error.message : String(error),
    })
  }
}
