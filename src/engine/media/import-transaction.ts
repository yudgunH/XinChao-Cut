/**
 * S9B / F12 — Transactional media import (OPFS write ↔ probe ↔ DB).
 *
 * Boundary:
 *  1. Register lease (protects orphan sweep for the unique final key)
 *  2. Write bytes **once** to the unique final storageKey under that lease
 *     (no temp→final re-read/re-write of multi-GB blobs)
 *  3. Probe + thumbnail from the final key URL
 *  4. DB put asset row pointing at final key
 *  5. Release lease
 *
 * `publishStarted` flips true immediately before the final-key write begins so
 * rollback deletes a partial/orphan final even when the write throws mid-stream
 * (previously `published` only became true *after* a successful full copy).
 *
 * On any failure/cancel: abort writable, delete uncommitted final (and any
 * leftover temp if a storage adapter still uses one), never leave a DB row
 * without a file or a final without a DB row.
 *
 * Storage is behind {@link ImportStorageAdapter} so unit tests inject failures
 * at every checkpoint without real OPFS.
 */

import { createId } from '../core/id'
import type { MediaAsset, MediaKind } from './types'

/** Prefix for in-flight import blobs — orphan sweep recognizes these. */
export const IMPORT_TMP_PREFIX = '__import_tmp__'

/** Grace period: after process restart, young temp files are kept (import may still finish). */
export const IMPORT_TMP_GRACE_MS = 30 * 60 * 1000

/** Export scratch must never be swept as an orphan media blob. */
export const EXPORT_TMP_KEY = '__export-tmp.mp4'

export type ImportCheckpoint =
  | 'create_writable'
  | 'write'
  | 'close_writable'
  | 'probe'
  | 'thumbnail'
  | 'db_put'
  | 'publish'
  | 'cancel'

export type MediaImportErrorCode =
  | 'unsupported'
  | 'quota'
  | 'write_failed'
  | 'probe_failed'
  | 'thumbnail_failed'
  | 'db_failed'
  | 'publish_failed'
  | 'cancelled'
  | 'unknown'

/** User-facing import error — no absolute paths / secrets. */
export class MediaImportError extends Error {
  readonly code: MediaImportErrorCode
  readonly fileName?: string
  readonly checkpoint?: ImportCheckpoint

  constructor(
    code: MediaImportErrorCode,
    message: string,
    opts?: { fileName?: string; checkpoint?: ImportCheckpoint; cause?: unknown },
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined)
    this.name = 'MediaImportError'
    this.code = code
    this.fileName = opts?.fileName
    this.checkpoint = opts?.checkpoint
  }
}

/** Short message safe for toasts. */
export function formatImportErrorForUi(err: unknown, fileName?: string): string {
  const name = fileName || (err instanceof MediaImportError ? err.fileName : undefined)
  const label = name ? `"${name}"` : 'File'
  if (err instanceof MediaImportError) {
    switch (err.code) {
      case 'quota':
        return `${label}: not enough storage space`
      case 'unsupported':
        return `${label}: unsupported media type`
      case 'cancelled':
        return `${label}: import cancelled`
      case 'probe_failed':
        return `${label}: could not read media metadata`
      case 'write_failed':
        return `${label}: failed to save media`
      case 'db_failed':
        return `${label}: failed to save media library entry`
      case 'publish_failed':
        return `${label}: failed to finalize media`
      default:
        return `${label}: import failed`
    }
  }
  if (err instanceof Error && /quota|exceeded/i.test(err.message)) {
    return `${label}: not enough storage space`
  }
  return `${label}: import failed`
}

export function makeTempImportKey(assetId: string): string {
  return `${IMPORT_TMP_PREFIX}${assetId}`
}

export function makeFinalStorageKey(assetId: string, fileName: string): string {
  const safe = fileName
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0)
      if (code < 32) return '_'
      if ('\\/:*?"<>|'.includes(ch)) return '_'
      return ch
    })
    .join('')
    .slice(0, 180)
  return `${assetId}__${safe || 'media'}`
}

export function isTempImportKey(key: string): boolean {
  return key.startsWith(IMPORT_TMP_PREFIX)
}

export interface ImportWritable {
  write(data: Blob | ArrayBuffer | ArrayBufferView | string): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

/** Injectable storage surface (real OPFS or in-memory mock). */
export interface ImportStorageAdapter {
  createWritable(key: string): Promise<ImportWritable>
  /** Object URL or equivalent for probe; caller revokes when revokeUrl=true path. */
  getObjectUrl(key: string): Promise<string | null>
  /**
   * Optional temp→final promote (rename preferred; never required by the default
   * import path which writes the final key directly). Kept for adapters/tests.
   * After success final must exist; temp may be gone (rename) or still present.
   */
  publish?(tempKey: string, finalKey: string): Promise<void>
  deleteKey(key: string): Promise<void>
  listKeys(): Promise<string[]>
  /** Optional: lastModified ms for age-based orphan protection. */
  getKeyAgeMs?(key: string, now: number): Promise<number | null>
}

export interface ImportDbAdapter {
  putAsset(asset: MediaAsset): Promise<void>
  /** Optional rollback for deferred rows written before metadata probing. */
  deleteAsset?(id: string): Promise<void>
  /** All OPFS media keys currently referenced by an asset row. */
  listReferencedKeys(): Promise<Set<string>>
}

export interface ImportLease {
  assetId: string
  tempKey: string
  finalKey: string
  startedAt: number
}

/** Process-wide leases so orphan sweep never deletes an in-flight import. */
const activeLeases = new Map<string, ImportLease>() // assetId → lease

export function getActiveImportLeases(): ReadonlyMap<string, ImportLease> {
  return activeLeases
}

export function registerImportLease(lease: ImportLease): void {
  activeLeases.set(lease.assetId, lease)
}

export function releaseImportLease(assetId: string): void {
  activeLeases.delete(assetId)
}

/** Keys protected by any active lease (temp + final). */
export function leasedKeys(): Set<string> {
  const s = new Set<string>()
  for (const lease of activeLeases.values()) {
    s.add(lease.tempKey)
    s.add(lease.finalKey)
  }
  return s
}

export function classifyImportError(
  err: unknown,
  checkpoint: ImportCheckpoint,
  fileName?: string,
): MediaImportError {
  if (err instanceof MediaImportError) return err
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new MediaImportError('cancelled', 'Import cancelled', { fileName, checkpoint, cause: err })
  }
  const name = err instanceof DOMException ? err.name : ''
  const msg = err instanceof Error ? err.message : String(err)
  if (name === 'QuotaExceededError' || /quota|storage.*exceed|exceeded.*quota/i.test(msg)) {
    return new MediaImportError('quota', 'Storage quota exceeded', { fileName, checkpoint, cause: err })
  }
  if (checkpoint === 'probe' || checkpoint === 'thumbnail') {
    return new MediaImportError(
      checkpoint === 'probe' ? 'probe_failed' : 'thumbnail_failed',
      msg || 'Probe failed',
      { fileName, checkpoint, cause: err },
    )
  }
  if (checkpoint === 'db_put') {
    return new MediaImportError('db_failed', msg || 'DB put failed', { fileName, checkpoint, cause: err })
  }
  if (checkpoint === 'publish') {
    return new MediaImportError('publish_failed', msg || 'Publish failed', { fileName, checkpoint, cause: err })
  }
  if (
    checkpoint === 'create_writable' ||
    checkpoint === 'write' ||
    checkpoint === 'close_writable'
  ) {
    return new MediaImportError('write_failed', msg || 'Write failed', { fileName, checkpoint, cause: err })
  }
  if (checkpoint === 'cancel') {
    return new MediaImportError('cancelled', 'Import cancelled', { fileName, checkpoint, cause: err })
  }
  return new MediaImportError('unknown', msg || 'Import failed', { fileName, checkpoint, cause: err })
}

export interface RunImportTransactionInput {
  file: File
  projectId: string
  kind: MediaKind
  storage: ImportStorageAdapter
  db: ImportDbAdapter
  /** Probe duration/dims; may throw. */
  probe: (url: string, kind: MediaKind) => Promise<{
    durationSec: number
    width?: number
    height?: number
  }>
  /** Optional thumbnail; failure can be soft (null) unless failThumbnailHard. */
  captureThumbnail?: (url: string) => Promise<string | undefined>
  /** When true, thumbnail errors abort the transaction. */
  failThumbnailHard?: boolean
  signal?: AbortSignal
  timelineOnly?: boolean
  /** Test hook: throw at this checkpoint. */
  failAt?: ImportCheckpoint
  now?: () => number
  createAssetId?: () => string
}

export interface RunImportTransactionResult {
  asset: MediaAsset
  tempKey: string
  finalKey: string
}

function throwIfAborted(signal: AbortSignal | undefined, fileName: string) {
  if (signal?.aborted) {
    throw new MediaImportError('cancelled', 'Import cancelled', {
      fileName,
      checkpoint: 'cancel',
    })
  }
}

function injectFail(failAt: ImportCheckpoint | undefined, checkpoint: ImportCheckpoint, fileName: string) {
  if (failAt === checkpoint) {
    if (checkpoint === 'cancel') {
      throw new MediaImportError('cancelled', 'Import cancelled', { fileName, checkpoint })
    }
    throw classifyImportError(new Error(`injected failure at ${checkpoint}`), checkpoint, fileName)
  }
}

/**
 * Write blob to a key with create → write → close, aborting on failure.
 */
export async function writeKeyTransactional(
  storage: ImportStorageAdapter,
  key: string,
  blob: Blob,
  opts: { failAt?: ImportCheckpoint; signal?: AbortSignal; fileName?: string },
): Promise<void> {
  const fileName = opts.fileName
  throwIfAborted(opts.signal, fileName ?? '')
  injectFail(opts.failAt, 'create_writable', fileName ?? '')
  let writable: ImportWritable | null = null
  try {
    writable = await storage.createWritable(key)
    let aborting = false
    const abortWrite = () => {
      aborting = true
      void writable?.abort().catch(() => {})
    }
    opts.signal?.addEventListener('abort', abortWrite, { once: true })
    throwIfAborted(opts.signal, fileName ?? '')
    injectFail(opts.failAt, 'write', fileName ?? '')
    try {
      // Bound each non-interruptible OPFS write. A multi-GB Blob write used to
      // ignore project-close/cancel until the entire file had copied.
      const chunkBytes = 8 * 1024 * 1024
      for (let offset = 0; offset < blob.size; offset += chunkBytes) {
        throwIfAborted(opts.signal, fileName ?? '')
        await writable.write(blob.slice(offset, Math.min(blob.size, offset + chunkBytes)))
      }
      if (blob.size === 0) await writable.write(blob)
    } finally {
      opts.signal?.removeEventListener('abort', abortWrite)
    }
    if (aborting) throwIfAborted(opts.signal, fileName ?? '')
    throwIfAborted(opts.signal, fileName ?? '')
    injectFail(opts.failAt, 'close_writable', fileName ?? '')
    await writable.close()
    writable = null
  } catch (e) {
    if (writable) {
      try {
        await writable.abort()
      } catch {
        /* ignore abort errors */
      }
    }
    throw classifyImportError(e, opts.failAt ?? 'write', fileName)
  }
}

export async function runImportTransaction(
  input: RunImportTransactionInput,
): Promise<RunImportTransactionResult> {
  const fileName = input.file.name
  const kind = input.kind
  if (!kind) {
    throw new MediaImportError('unsupported', `Unsupported file type: ${fileName}`, { fileName })
  }

  const assetId = input.createAssetId?.() ?? createId('asset')
  const tempKey = makeTempImportKey(assetId)
  const finalKey = makeFinalStorageKey(assetId, fileName)
  const now = input.now?.() ?? Date.now()
  const lease: ImportLease = { assetId, tempKey, finalKey, startedAt: now }
  registerImportLease(lease)

  /**
   * True once we begin writing the unique final key. Rollback deletes final
   * whenever this is set and DB has not committed — including mid-write throws
   * that never finished a successful publish.
   */
  let publishStarted = false
  let dbCommitted = false
  let objectUrl: string | null = null

  try {
    throwIfAborted(input.signal, fileName)
    injectFail(input.failAt, 'cancel', fileName)

    // Single write to the unique final key under lease (no temp→final re-copy).
    // Mark publishStarted *before* createWritable so a partial OPFS object is
    // always eligible for rollback cleanup.
    publishStarted = true
    await writeKeyTransactional(input.storage, finalKey, input.file, {
      failAt: input.failAt,
      signal: input.signal,
      fileName,
    })

    objectUrl = await input.storage.getObjectUrl(finalKey)
    if (!objectUrl) {
      throw new MediaImportError('write_failed', 'Failed to read stored media', {
        fileName,
        checkpoint: 'write',
      })
    }

    injectFail(input.failAt, 'probe', fileName)
    let probeResult: { durationSec: number; width?: number; height?: number }
    try {
      probeResult = await input.probe(objectUrl, kind)
    } catch (e) {
      throw classifyImportError(e, 'probe', fileName)
    }

    // Thumbnails must be durable (data: URL / regenerated from storageKey) —
    // never keep the probe object URL (revoked in finally; blob: dies after reload).
    let thumbnailDataUrl: string | undefined
    if ((kind === 'video' || kind === 'image') && input.captureThumbnail) {
      injectFail(input.failAt, 'thumbnail', fileName)
      try {
        const thumb = await input.captureThumbnail(objectUrl)
        // Guard against callers accidentally returning the live blob: URL.
        thumbnailDataUrl = thumb && !thumb.startsWith('blob:') ? thumb : undefined
      } catch (e) {
        if (input.failThumbnailHard || input.failAt === 'thumbnail') {
          throw classifyImportError(e, 'thumbnail', fileName)
        }
        // Soft: thumbnail optional in production path
        thumbnailDataUrl = undefined
      }
    }
    // Thumbnail failure is intentionally soft, cancellation is not. Without
    // this check an aborted thumbnail could still commit a DB row after the
    // project had changed because the optional-thumbnail catch swallowed it.
    throwIfAborted(input.signal, fileName)

    const asset: MediaAsset = {
      id: assetId,
      projectId: input.projectId,
      kind,
      name: fileName,
      mimeType: input.file.type,
      sizeBytes: input.file.size,
      durationSec: kind === 'image' ? 5 : probeResult.durationSec,
      width: probeResult.width,
      height: probeResult.height,
      storageKey: finalKey,
      thumbnailDataUrl,
      createdAt: now,
      timelineOnly: input.timelineOnly || undefined,
    }

    // Checkpoint kept for inject-failure tests / API stability. Default path
    // already wrote the unique final key once — no temp→final re-copy.
    injectFail(input.failAt, 'publish', fileName)

    injectFail(input.failAt, 'db_put', fileName)
    try {
      await input.db.putAsset(asset)
      dbCommitted = true
    } catch (e) {
      throw classifyImportError(e, 'db_put', fileName)
    }

    // Best-effort: drop any leftover temp staging key (rename path / legacy).
    try {
      await input.storage.deleteKey(tempKey)
    } catch {
      /* orphan sweep will catch leftovers */
    }

    return { asset, tempKey, finalKey }
  } catch (e) {
    // Rollback uncommitted storage. Never delete if DB already committed.
    if (!dbCommitted) {
      try {
        await input.storage.deleteKey(tempKey)
      } catch {
        /* ignore */
      }
      // publishStarted covers mid-write partial finals (published was too late).
      if (publishStarted) {
        try {
          await input.storage.deleteKey(finalKey)
        } catch {
          /* ignore */
        }
      }
    }
    // Preserve classified MediaImportError (including injected checkpoint codes).
    if (e instanceof MediaImportError) throw e
    throw classifyImportError(e, 'write', fileName)
  } finally {
    // Always revoke the probe/object URL — thumbnails are data: copies, not this URL.
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl)
      } catch {
        /* ignore */
      }
    }
    releaseImportLease(assetId)
  }
}

export interface OrphanSweepOptions {
  storage: ImportStorageAdapter
  db: ImportDbAdapter
  now?: number
  /** Max age for unprotected temp keys (default IMPORT_TMP_GRACE_MS). */
  tempGraceMs?: number
  /** Extra keys that must never be deleted (e.g. export scratch). */
  protectKeys?: ReadonlySet<string>
}

export interface OrphanSweepResult {
  deleted: string[]
  kept: string[]
}

/**
 * Delete OPFS keys not referenced by DB, unless protected by lease, temp grace,
 * or explicit protect set. Idempotent.
 */
export async function sweepOrphanMedia(opts: OrphanSweepOptions): Promise<OrphanSweepResult> {
  const now = opts.now ?? Date.now()
  const grace = opts.tempGraceMs ?? IMPORT_TMP_GRACE_MS
  const referenced = await opts.db.listReferencedKeys()
  const protect = new Set(opts.protectKeys ?? [])
  protect.add(EXPORT_TMP_KEY)
  for (const k of leasedKeys()) protect.add(k)

  const keys = await opts.storage.listKeys()
  const deleted: string[] = []
  const kept: string[] = []

  for (const key of keys) {
    if (referenced.has(key) || protect.has(key)) {
      kept.push(key)
      continue
    }
    if (isTempImportKey(key)) {
      let age: number | null = null
      if (opts.storage.getKeyAgeMs) {
        age = await opts.storage.getKeyAgeMs(key, now)
      }
      // Unknown age → treat as young (safe); only delete when clearly stale.
      if (age === null || age < grace) {
        kept.push(key)
        continue
      }
    }
    // Unreferenced final/proxy/other key, or stale temp → delete.
    try {
      await opts.storage.deleteKey(key)
      deleted.push(key)
    } catch {
      kept.push(key)
    }
  }
  return { deleted, kept }
}
