import { db } from '@lib/dexie-db'

import { createId } from '../core/id'
import {
  writeBlob,
  deleteBlob,
  getObjectUrl,
  readBlob,
  createWritable,
  listKeys,
  getKeyAgeMs,
  publishBlob,
} from '../persistence/opfs'

import {
  detectKind,
  probeVideo,
  probeAudio,
  probeImage,
  captureVideoThumbnail,
  captureImageThumbnail,
} from './probe'
import { ensureDesktopMediaScope, kindFromName, mimeFromName, pathToMediaUrl } from './desktop'
import {
  AUDIO_PROXY_SUFFIX,
  isAudioCapableProxyKey,
  type MediaAsset,
  type MediaKind,
} from './types'
import {
  runImportTransaction,
  sweepOrphanMedia,
  type ImportDbAdapter,
  type ImportStorageAdapter,
  type ImportWritable,
  MediaImportError,
  formatImportErrorForUi,
} from './import-transaction'

export const AUDIO_LIBRARY_PROJECT_ID = '__audio_library__'

export interface ImportOpts {
  /** Mark the asset timeline-only (hidden from the library grid, no waveform). */
  timelineOnly?: boolean
  signal?: AbortSignal
  /** Trusted metadata supplied by an already-probed backend source. */
  metadata?: Partial<Pick<MediaAsset, 'durationSec' | 'width' | 'height' | 'fps' | 'sizeBytes'>>
  /** Browser-safe URL for a path-backed source outside Tauri asset scope. */
  playbackUrl?: string
}

export interface MediaManager {
  import(file: File, projectId: string, opts?: ImportOpts): Promise<MediaAsset>
  /** Register an already-complete OPFS object without copying it again. */
  adoptStored(key: string, name: string, projectId: string, opts?: ImportOpts): Promise<MediaAsset>
  /** Desktop (Tauri): register a file by absolute path WITHOUT copying it into
   *  OPFS — the asset streams from the original via the asset protocol. */
  importPath(path: string, name: string, projectId: string, opts?: ImportOpts): Promise<MediaAsset>
  /** Register immediately; probe/thumbnail completes under a bounded queue. */
  importPathDeferred(
    path: string,
    name: string,
    projectId: string,
    opts?: ImportOpts,
  ): Promise<{ asset: MediaAsset; ready: Promise<MediaAsset> }>
  remove(id: string): Promise<void>
  /** Media owned by the given project, newest first. */
  list(projectId: string): Promise<MediaAsset[]>
  /** Persistent app-wide music library, newest first. */
  listAudioLibrary(): Promise<MediaAsset[]>
  /** Look up arbitrary assets by id, preserving only rows that still exist. */
  listByIds(ids: string[]): Promise<MediaAsset[]>
  /** Copy an audio file into the persistent app-wide music library. */
  importAudioLibrary(file: File): Promise<MediaAsset>
  getObjectUrl(id: string): Promise<string | null>
  /** Like getObjectUrl, but returns the low-res proxy when one exists. */
  getPreviewObjectUrl(id: string): Promise<string | null>
  getBlob(id: string): Promise<Blob | null>
  /** Store a generated preview proxy blob; returns its OPFS key. */
  setProxy(id: string, blob: Blob): Promise<string | null>
  removeProxy(id: string): Promise<void>
  /** Persist a computed content hash so future exports skip re-hashing. */
  setContentHash(id: string, hash: string): Promise<void>
  /** Startup / manual orphan cleanup (S9B). */
  sweepOrphans(): Promise<{ deleted: string[]; kept: string[] }>
}

/** Real OPFS adapter for import transactions. */
export function createOpfsImportStorage(): ImportStorageAdapter {
  return {
    async createWritable(key: string): Promise<ImportWritable> {
      const w = await createWritable(key)
      return {
        write: (data) => w.write(data),
        close: () => w.close(),
        abort: () => w.abort(),
      }
    },
    getObjectUrl,
    publish: publishBlob,
    deleteKey: deleteBlob,
    listKeys,
    getKeyAgeMs,
  }
}

export function createDexieImportDb(): ImportDbAdapter {
  return {
    async putAsset(asset) {
      await db.assets.put(asset)
    },
    async deleteAsset(id) {
      await db.assets.delete(id)
    },
    async listReferencedKeys() {
      const rows = await db.assets.toArray()
      const keys = new Set<string>()
      for (const row of rows) {
        if (row.storageKey) keys.add(row.storageKey)
        if (row.proxyStorageKey) keys.add(row.proxyStorageKey)
        if (row.normalizedBlobKey) keys.add(row.normalizedBlobKey)
      }
      return keys
    },
  }
}

function scheduleBrowserNormalization(asset: MediaAsset, source?: Blob): void {
  // MediaManager is also used by server-backed flows and Node-side tests.
  // Only the browser app owns a WebCodecs probe/OPFS normalization lifecycle.
  if (typeof window === 'undefined' || asset.kind !== 'video') return
  void import('./normalization-runner')
    .then(({ scheduleVideoNormalization }) => scheduleVideoNormalization(asset, source))
    .catch((error) => {
      console.warn('[media] browser normalization scheduler unavailable', error)
    })
}

async function probeDims(
  url: string,
  kind: MediaKind,
  signal?: AbortSignal,
): Promise<{ durationSec: number; width?: number; height?: number }> {
  if (kind === 'video') {
    const p = await probeVideo(url, signal)
    return { durationSec: p.durationSec, width: p.width, height: p.height }
  }
  if (kind === 'audio') {
    const p = await probeAudio(url, signal)
    return { durationSec: p.durationSec }
  }
  const p = await probeImage(url, signal)
  return { durationSec: 5, width: p.width, height: p.height }
}

async function buildPathAsset(
  path: string,
  name: string,
  projectId: string,
  opts?: ImportOpts,
): Promise<MediaAsset> {
  const kind = kindFromName(name)
  if (!kind) throw new MediaImportError('unsupported', `Unsupported file type: ${name}`, { fileName: name })

  const url = opts?.playbackUrl || pathToMediaUrl(path)
  const hint = opts?.metadata
  const base: MediaAsset = {
    id: createId('asset'),
    projectId,
    kind,
    name,
    mimeType: mimeFromName(name),
    sizeBytes: Math.max(0, Number(hint?.sizeBytes) || 0),
    durationSec: 0,
    storageKey: '',
    sourcePath: path,
    playbackUrl: opts?.playbackUrl,
    createdAt: Date.now(),
  }
  try {
    if (kind === 'video') {
      const hinted = Number(hint?.durationSec) > 0 && Number(hint?.width) > 0 && Number(hint?.height) > 0
      if (hinted) {
        base.durationSec = Number(hint!.durationSec)
        base.width = Number(hint!.width)
        base.height = Number(hint!.height)
        if (Number(hint?.fps) > 0) base.fps = Number(hint!.fps)
      } else {
        const probe = await probeVideo(url, opts?.signal)
        base.durationSec = probe.durationSec
        base.width = probe.width
        base.height = probe.height
      }
      try {
        base.thumbnailDataUrl = await captureVideoThumbnail(url, 0, opts?.signal)
      } catch {
        if (opts?.signal?.aborted) throw new DOMException('Media import aborted', 'AbortError')
        /* optional */
      }
    } else if (kind === 'audio') {
      if (Number(hint?.durationSec) > 0) base.durationSec = Number(hint!.durationSec)
      else {
        const probe = await probeAudio(url, opts?.signal)
        base.durationSec = probe.durationSec
      }
    } else if (kind === 'image') {
      const probe = await probeImage(url, opts?.signal)
      base.width = probe.width
      base.height = probe.height
      base.durationSec = 5
      // Durable JPEG — not the asset-protocol/object URL (those are not stable
      // library thumbs and must not pin a revoked blob:).
      try {
        base.thumbnailDataUrl = await captureImageThumbnail(url, 320, opts?.signal)
      } catch {
        if (opts?.signal?.aborted) throw new DOMException('Media import aborted', 'AbortError')
        /* optional */
      }
    }
  } catch (e) {
    throw e instanceof MediaImportError
      ? e
      : new MediaImportError('probe_failed', 'Could not read media metadata', {
          fileName: name,
          checkpoint: 'probe',
          cause: e,
        })
  }
  return base
}

function minimalPathAsset(
  path: string,
  name: string,
  projectId: string,
  opts?: ImportOpts,
): MediaAsset {
  const kind = kindFromName(name)
  if (!kind) throw new MediaImportError('unsupported', `Unsupported file type: ${name}`, { fileName: name })
  return {
    id: createId('asset'),
    projectId,
    kind,
    name,
    mimeType: mimeFromName(name),
    sizeBytes: Math.max(0, Number(opts?.metadata?.sizeBytes) || 0),
    durationSec: Math.max(0, Number(opts?.metadata?.durationSec) || 0),
    width: Number(opts?.metadata?.width) || undefined,
    height: Number(opts?.metadata?.height) || undefined,
    fps: Number(opts?.metadata?.fps) || undefined,
    storageKey: '',
    sourcePath: path,
    playbackUrl: opts?.playbackUrl,
    timelineOnly: opts?.timelineOnly,
    createdAt: Date.now(),
  }
}

const PATH_PROBE_CONCURRENCY = 3
let activePathProbes = 0
interface PathProbeWaiter {
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  onAbort?: () => void
}
const pathProbeWaiters: PathProbeWaiter[] = []

function abortError(): DOMException {
  return new DOMException('Media import aborted', 'AbortError')
}

function drainPathProbeWaiters(): void {
  while (activePathProbes < PATH_PROBE_CONCURRENCY && pathProbeWaiters.length > 0) {
    const waiter = pathProbeWaiters.shift()!
    if (waiter.signal?.aborted) {
      waiter.reject(abortError())
      continue
    }
    activePathProbes += 1
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true
      activePathProbes -= 1
      drainPathProbeWaiters()
    })
  }
}

function acquirePathProbeSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<() => void>((resolve, reject) => {
    const waiter: PathProbeWaiter = { signal, resolve, reject }
    waiter.onAbort = () => {
      const index = pathProbeWaiters.indexOf(waiter)
      if (index >= 0) pathProbeWaiters.splice(index, 1)
      reject(abortError())
      drainPathProbeWaiters()
    }
    signal?.addEventListener('abort', waiter.onAbort, { once: true })
    pathProbeWaiters.push(waiter)
    drainPathProbeWaiters()
  })
}

export async function withPathProbeSlot<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquirePathProbeSlot(signal)
  try {
    if (signal?.aborted) throw abortError()
    return await work()
  } finally {
    release()
  }
}

export function isOrphanedEditorMedia(
  row: MediaAsset,
  liveProjects: ReadonlySet<string>,
  referencedAssetIds: ReadonlySet<string>,
): boolean {
  return !!row.projectId
    && row.projectId !== AUDIO_LIBRARY_PROJECT_ID
    && !liveProjects.has(row.projectId)
    && !referencedAssetIds.has(row.id)
}

export function createMediaManager(
  storage: ImportStorageAdapter = createOpfsImportStorage(),
  importDb: ImportDbAdapter = createDexieImportDb(),
): MediaManager {
  return {
    async import(file, projectId, opts) {
      const kind = detectKind(file)
      if (!kind) {
        throw new MediaImportError('unsupported', `Unsupported file type: ${file.type || file.name}`, {
          fileName: file.name,
        })
      }
      const { asset } = await runImportTransaction({
        file,
        projectId,
        kind,
        storage,
        db: importDb,
        probe: (url, mediaKind) => probeDims(url, mediaKind, opts?.signal),
        // Always produce a durable data: thumbnail (never keep the probe blob: URL).
        captureThumbnail: (url) =>
          kind === 'image'
            ? captureImageThumbnail(url, 320, opts?.signal)
            : captureVideoThumbnail(url, 0, opts?.signal),
        signal: opts?.signal,
        timelineOnly: opts?.timelineOnly,
      })
      scheduleBrowserNormalization(asset, file)
      return asset
    },
    async adoptStored(key, name, projectId, opts) {
      const blob = await readBlob(key)
      if (!blob) throw new MediaImportError('probe_failed', `Missing stored media: ${name}`)
      const kind = kindFromName(name)
      if (!kind) {
        await deleteBlob(key)
        throw new MediaImportError('unsupported', `Unsupported file type: ${name}`)
      }
      const url = URL.createObjectURL(blob)
      try {
        const dims = await probeDims(url, kind, opts?.signal)
        const asset: MediaAsset = {
          id: createId('asset'),
          projectId,
          kind,
          name,
          mimeType: mimeFromName(name),
          sizeBytes: blob.size,
          durationSec: dims.durationSec,
          width: dims.width,
          height: dims.height,
          storageKey: key,
          timelineOnly: opts?.timelineOnly,
          createdAt: Date.now(),
        }
        await importDb.putAsset(asset)
        scheduleBrowserNormalization(asset, blob)
        return asset
      } catch (error) {
        await deleteBlob(key).catch(() => undefined)
        throw error instanceof MediaImportError
          ? error
          : new MediaImportError('probe_failed', 'Could not register stored media', {
              fileName: name,
              checkpoint: 'probe',
              cause: error,
            })
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    async importPath(path, name, projectId, opts) {
      // Record the user's import as an asset-scope grant NOW — drag-drop paths
      // never get the dialog plugin's automatic grant, and without it preview
      // (asset protocol) and export byte-range IPC reject the file.
      await ensureDesktopMediaScope(path)
      const asset = await buildPathAsset(path, name, projectId, opts)
      if (opts?.timelineOnly) asset.timelineOnly = true
      try {
        await importDb.putAsset(asset)
      } catch (e) {
        throw new MediaImportError('db_failed', 'Failed to save media library entry', {
          fileName: name,
          checkpoint: 'db_put',
          cause: e,
        })
      }
      scheduleBrowserNormalization(asset)
      return asset
    },
    async importPathDeferred(path, name, projectId, opts) {
      // Same grant as importPath — see the comment there.
      await ensureDesktopMediaScope(path)
      const asset = minimalPathAsset(path, name, projectId, opts)
      await importDb.putAsset(asset)
      const ready = withPathProbeSlot(async () => {
        const probed = await buildPathAsset(path, name, projectId, opts)
        const enriched = {
          ...probed,
          id: asset.id,
          createdAt: asset.createdAt,
          timelineOnly: asset.timelineOnly,
        }
        await importDb.putAsset(enriched)
        scheduleBrowserNormalization(enriched)
        return enriched
      }, opts?.signal).catch(async (error) => {
        // Never leave the optimistic duration-0 row behind when probe fails.
        await importDb.deleteAsset?.(asset.id).catch(() => undefined)
        throw error
      })
      return { asset, ready }
    },
    async remove(id) {
      const asset = await db.assets.get(id)
      if (asset) {
        if (asset.storageKey) await deleteBlob(asset.storageKey)
        if (asset.proxyStorageKey) await deleteBlob(asset.proxyStorageKey)
        if (asset.normalizedBlobKey) await deleteBlob(asset.normalizedBlobKey)
      }
      await db.assets.delete(id)
    },
    async list(projectId) {
      const assets = await db.assets.where('projectId').equals(projectId).toArray()
      return assets.sort((a, b) => b.createdAt - a.createdAt)
    },
    async listAudioLibrary() {
      const assets = await db.assets.where('projectId').equals(AUDIO_LIBRARY_PROJECT_ID).toArray()
      return assets.sort((a, b) => b.createdAt - a.createdAt)
    },
    async listByIds(ids) {
      const uniqueIds = Array.from(new Set(ids))
      const rows = await db.assets.bulkGet(uniqueIds)
      const byId = new Map(rows.filter((row): row is MediaAsset => !!row).map((row) => [row.id, row]))
      return uniqueIds.map((id) => byId.get(id)).filter((row): row is MediaAsset => !!row)
    },
    async importAudioLibrary(file) {
      const asset = await this.import(file, AUDIO_LIBRARY_PROJECT_ID)
      if (asset.kind !== 'audio') {
        await this.remove(asset.id)
        throw new MediaImportError('unsupported', `Unsupported audio file: ${file.type || file.name}`, {
          fileName: file.name,
        })
      }
      return asset
    },
    async getObjectUrl(id) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      if (asset.normalizedBlobKey) {
        const url = await getObjectUrl(asset.normalizedBlobKey)
        if (url) return url
      }
      if (asset.playbackUrl) return asset.playbackUrl
      if (asset.sourcePath) return pathToMediaUrl(asset.sourcePath)
      return getObjectUrl(asset.storageKey)
    },
    async getPreviewObjectUrl(id) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      if (asset.normalizedBlobKey) {
        const url = await getObjectUrl(asset.normalizedBlobKey)
        if (url) return url
      }
      if (isAudioCapableProxyKey(asset.proxyStorageKey)) {
        const url = await getObjectUrl(asset.proxyStorageKey)
        if (url) return url
      }
      if (asset.playbackUrl) return asset.playbackUrl
      if (asset.sourcePath) return pathToMediaUrl(asset.sourcePath)
      return getObjectUrl(asset.storageKey)
    },
    async getBlob(id) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      if (asset.normalizedBlobKey) {
        const normalized = await readBlob(asset.normalizedBlobKey)
        if (normalized) return normalized
      }
      if (asset.playbackUrl || asset.sourcePath) {
        try {
          const res = await fetch(asset.playbackUrl || pathToMediaUrl(asset.sourcePath!))
          if (!res.ok) return null
          return await res.blob()
        } catch {
          return null
        }
      }
      return readBlob(asset.storageKey)
    },
    async setProxy(id, blob) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      const key = `${id}${AUDIO_PROXY_SUFFIX}`
      await writeBlob(key, blob)
      await db.assets.update(id, { proxyStorageKey: key })
      return key
    },
    async removeProxy(id) {
      const asset = await db.assets.get(id)
      if (asset?.proxyStorageKey) {
        await deleteBlob(asset.proxyStorageKey)
        await db.assets.update(id, { proxyStorageKey: undefined })
      }
    },
    async setContentHash(id, hash) {
      await db.assets.update(id, { contentHash: hash })
    },
    async sweepOrphans() {
      // Remove invisible asset rows left by older interrupted project clones.
      // Keeping those rows makes their OPFS keys look referenced forever, so
      // the byte-level orphan sweep below can never reclaim them.
      await db.transaction('rw', db.projects, db.assets, async () => {
        const projects = await db.projects.toArray()
        const liveProjects = new Set(projects.map((row) => row.id))
        const referencedAssetIds = new Set(
          projects.flatMap((row) => row.snapshot.assetIds ?? []),
        )
        const rows = await db.assets.toArray()
        const dead = rows
          .filter((row) => isOrphanedEditorMedia(row, liveProjects, referencedAssetIds))
          .map((row) => row.id)
        if (dead.length > 0) await db.assets.bulkDelete(dead)
      })
      return sweepOrphanMedia({ storage, db: importDb })
    },
  }
}

export const mediaManager = createMediaManager()

export { MediaImportError, formatImportErrorForUi }

/** Fire-and-forget startup orphan sweep (safe: leases + grace protect active work). */
export function scheduleMediaOrphanSweep(): void {
  if (typeof window === 'undefined') return
  void mediaManager.sweepOrphans().catch((e) => {
    console.warn('[media] orphan sweep failed', e)
  })
}

// Kick once after module load (Dexie open races are handled inside sweep).
scheduleMediaOrphanSweep()
