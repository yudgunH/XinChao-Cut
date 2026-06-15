import { db } from '@lib/dexie-db'

import { createId } from '../core/id'
import { writeBlob, deleteBlob, getObjectUrl, readBlob } from '../persistence/opfs'

import { detectKind, probeVideo, probeAudio, probeImage, captureVideoThumbnail } from './probe'
import { kindFromName, mimeFromName, pathToMediaUrl } from './desktop'
import type { MediaAsset, MediaKind } from './types'

export interface MediaManager {
  import(file: File, projectId: string): Promise<MediaAsset>
  /** Desktop (Tauri): register a file by absolute path WITHOUT copying it into
   *  OPFS — the asset streams from the original via the asset protocol. */
  importPath(path: string, name: string, projectId: string): Promise<MediaAsset>
  remove(id: string): Promise<void>
  /** Media owned by the given project, newest first. */
  list(projectId: string): Promise<MediaAsset[]>
  getObjectUrl(id: string): Promise<string | null>
  /** Like getObjectUrl, but returns the low-res proxy when one exists. */
  getPreviewObjectUrl(id: string): Promise<string | null>
  getBlob(id: string): Promise<Blob | null>
  /** Store a generated preview proxy blob; returns its OPFS key. */
  setProxy(id: string, blob: Blob): Promise<string | null>
  removeProxy(id: string): Promise<void>
  /** Persist a computed content hash so future exports skip re-hashing. */
  setContentHash(id: string, hash: string): Promise<void>
}

/** Probe duration/dimensions/thumbnail into `base`. `revokeUrl` for blob: URLs
 * that must be released afterwards (path-backed asset URLs are persistent and
 * double as the image thumbnail, so they are never revoked). */
async function probeInto(base: MediaAsset, kind: MediaKind, url: string, revokeUrl: boolean) {
  try {
    if (kind === 'video') {
      const probe = await probeVideo(url)
      base.durationSec = probe.durationSec
      base.width = probe.width
      base.height = probe.height
      // Only the cheap single-frame thumbnail runs inline (one seek) so the
      // media card and a tiled placeholder appear instantly. The expensive
      // frame strip + audio waveform are deferred to background backfill hooks
      // (useThumbnailStripBackfill / useWaveformBackfill) to keep import fast.
      try {
        base.thumbnailDataUrl = await captureVideoThumbnail(url, 0)
      } catch {
        /* thumbnail optional */
      }
    } else if (kind === 'audio') {
      const probe = await probeAudio(url)
      base.durationSec = probe.durationSec
      // Waveform deferred to useWaveformBackfill (keeps import fast).
    } else if (kind === 'image') {
      const probe = await probeImage(url)
      base.width = probe.width
      base.height = probe.height
      base.durationSec = 5
      base.thumbnailDataUrl = url
    }
  } finally {
    if (revokeUrl && kind !== 'image') URL.revokeObjectURL(url)
  }
}

async function buildAsset(file: File, projectId: string): Promise<MediaAsset> {
  const kind = detectKind(file)
  if (!kind) throw new Error(`Unsupported file type: ${file.type || file.name}`)

  const id = createId('asset')
  const storageKey = `${id}__${file.name}`
  await writeBlob(storageKey, file)
  const url = await getObjectUrl(storageKey)
  if (!url) throw new Error('Failed to read stored media')

  const base: MediaAsset = {
    id,
    projectId,
    kind,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    durationSec: 0,
    storageKey,
    createdAt: Date.now(),
  }
  await probeInto(base, kind, url, true)
  return base
}

async function buildPathAsset(path: string, name: string, projectId: string): Promise<MediaAsset> {
  const kind = kindFromName(name)
  if (!kind) throw new Error(`Unsupported file type: ${name}`)

  const url = pathToMediaUrl(path)
  const base: MediaAsset = {
    id: createId('asset'),
    projectId,
    kind,
    name,
    mimeType: mimeFromName(name),
    sizeBytes: 0, // unknown without reading the file; nothing relies on it
    durationSec: 0,
    storageKey: '', // not in OPFS — streams from sourcePath
    sourcePath: path,
    createdAt: Date.now(),
  }
  await probeInto(base, kind, url, false)
  return base
}

export function createMediaManager(): MediaManager {
  return {
    async import(file, projectId) {
      const asset = await buildAsset(file, projectId)
      await db.assets.put(asset)
      return asset
    },
    async importPath(path, name, projectId) {
      const asset = await buildPathAsset(path, name, projectId)
      await db.assets.put(asset)
      return asset
    },
    async remove(id) {
      const asset = await db.assets.get(id)
      if (asset) {
        if (asset.storageKey) await deleteBlob(asset.storageKey)
        if (asset.proxyStorageKey) await deleteBlob(asset.proxyStorageKey)
      }
      await db.assets.delete(id)
    },
    async list(projectId) {
      const assets = await db.assets.where('projectId').equals(projectId).toArray()
      return assets.sort((a, b) => b.createdAt - a.createdAt)
    },
    async getObjectUrl(id) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      if (asset.sourcePath) return pathToMediaUrl(asset.sourcePath)
      return getObjectUrl(asset.storageKey)
    },
    async getPreviewObjectUrl(id) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      if (asset.proxyStorageKey) {
        const url = await getObjectUrl(asset.proxyStorageKey)
        if (url) return url // fall through to the original if the proxy is gone
      }
      if (asset.sourcePath) return pathToMediaUrl(asset.sourcePath)
      return getObjectUrl(asset.storageKey)
    },
    async getBlob(id) {
      const asset = await db.assets.get(id)
      if (!asset) return null
      if (asset.sourcePath) {
        // Stream the original through the asset protocol (export/transcribe/
        // hash all consume Blobs). Missing/moved file → null, same contract
        // as a missing OPFS entry.
        try {
          const res = await fetch(pathToMediaUrl(asset.sourcePath))
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
      const key = `${id}__proxy.mp4`
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
  }
}

export const mediaManager = createMediaManager()
