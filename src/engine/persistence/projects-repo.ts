import { createId } from '@engine/core/id'
import Dexie from 'dexie'
import type { MediaAsset } from '@engine/media'
import { registerImportLease, releaseImportLease } from '@engine/media/import-transaction'
import { makeDefaultTracks } from '@engine/timeline'
import {
  db,
  type MediaDeletionRow,
  type ProjectListRow,
  type ProjectRow,
} from '@lib/dexie-db'

import { mayCommitRevision, type SaveOutcome } from '@lib/project-save-coordinator'

import { deleteBlob, readBlob, writeBlob } from './opfs'
import type { ProjectSnapshot } from './types'

const SNAPSHOT_VERSION = 1

function rowFromSnapshot(snap: ProjectSnapshot): ProjectRow {
  return { id: snap.id!, name: snap.name, updatedAt: snap.updatedAt, snapshot: snap }
}

function headerFromSnapshot(snap: ProjectSnapshot): ProjectListRow {
  return {
    id: snap.id!,
    name: snap.name,
    updatedAt: snap.updatedAt,
    clipCount: snap.clips.length,
    thumbnailDataUrl: snap.thumbnailDataUrl,
  }
}

/** All projects, most-recently-edited first. */
export async function listProjects(): Promise<ProjectListRow[]> {
  await resumePendingProjectDeletions()
  return db.projectHeaders.orderBy('updatedAt').reverse().toArray()
}

export async function getProject(id: string): Promise<ProjectSnapshot | null> {
  const row = await db.projects.get(id)
  return row?.snapshot ?? null
}

/** Keep this many rolling backups per project. */
const KEEP_BACKUPS = 10
/** Don't take a new backup more often than this (keeps the history window
 *  useful — a 3s-debounced autosave would otherwise churn all slots in
 *  seconds) … EXCEPT when the incoming save would shrink the clip count
 *  sharply, which is exactly the state a recovery needs. */
const BACKUP_MIN_INTERVAL_MS = 2 * 60_000

/**
 * Persist a snapshot (insert or update), syncing the denormalized row fields.
 * The row being overwritten is first copied into `projectBackups`, so a bad
 * autosave (store reset by a dev-server reload, crash mid-hydration) can
 * always be rolled back via `restoreProjectBackup`.
 *
 * S13: runs inside a Dexie RW transaction covering projects + backups, and
 * skips the put when `saveRevision` is strictly older than the DB row
 * (compare-and-set against out-of-order writers).
 */
export async function saveProject(snapshot: ProjectSnapshot): Promise<SaveOutcome> {
  const id = snapshot.id!
  let outcome: SaveOutcome = { committed: true }
  await db.transaction('rw', db.projects, db.projectHeaders, db.projectBackups, async () => {
    const existing = await db.projects.get(id)
    const dbRevision = existing?.snapshot.saveRevision
    if (
      existing &&
      !mayCommitRevision(snapshot.saveRevision, dbRevision)
    ) {
      // Stale writer — leave the newer row intact, but SIGNAL the skip so the
      // save coordinator can bump its counter and retry instead of reporting a
      // false "saved" (silent data loss after an app restart — S13/F19 fix).
      outcome = { committed: false, dbRevision }
      return
    }
    if (existing) {
      const backupRange = () => db.projectBackups
        .where('[projectId+updatedAt]')
        .between([id, Dexie.minKey], [id, Dexie.maxKey])
      const newest = (await backupRange().reverse().first())?.updatedAt ?? 0
      const oldClips = ((existing.snapshot.clips as unknown[]) ?? []).length
      const newClips = ((snapshot.clips as unknown[]) ?? []).length
      const shrinks = newClips < oldClips / 2 && oldClips > 4
      if (existing.updatedAt - newest > BACKUP_MIN_INTERVAL_MS || newest === 0 || shrinks) {
        await db.projectBackups.put({
          id: createId('backup'),
          projectId: id,
          updatedAt: existing.updatedAt,
          snapshot: existing.snapshot,
        })
        const excess = await backupRange().count() + 1 - KEEP_BACKUPS
        if (excess > 0) {
          const oldestIds = await backupRange().limit(excess).primaryKeys()
          await db.projectBackups.bulkDelete(oldestIds as string[])
        }
      }
    }
    await db.projects.put(rowFromSnapshot(snapshot))
    await db.projectHeaders.put(headerFromSnapshot(snapshot))
  })
  return outcome
}

/** Backups for a project, newest first. */
export async function listProjectBackups(projectId: string) {
  return db.projectBackups
    .where('[projectId+updatedAt]')
    .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
    .reverse()
    .limit(KEEP_BACKUPS)
    .toArray()
}

/** Roll a project back to a backup (the current row is backed up first by the
 *  saveProject call, so a restore is itself reversible). Returns the restored
 *  snapshot, or null when the backup id doesn't exist. */
export async function restoreProjectBackup(backupId: string): Promise<ProjectSnapshot | null> {
  const row = await db.projectBackups.get(backupId)
  if (!row) return null
  // A backup carries an OLD (lower) saveRevision; restoring it verbatim would be
  // rejected by the revision CAS. Stamp a revision strictly above whatever the
  // live row holds so the rollback actually commits and wins subsequent saves.
  const current = await db.projects.get(row.snapshot.id ?? row.projectId)
  const nextRev = Math.max(
    current?.snapshot.saveRevision ?? 0,
    row.snapshot.saveRevision ?? 0,
  ) + 1
  const snapshot: ProjectSnapshot = { ...row.snapshot, updatedAt: Date.now(), saveRevision: nextRev }
  await saveProject(snapshot)
  return snapshot
}

/** Create an empty project with default tracks and persist it. */
export async function createProject(name: string, aspectLabel: string): Promise<ProjectSnapshot> {
  const now = Date.now()
  const snapshot: ProjectSnapshot = {
    id: createId('project'),
    version: SNAPSHOT_VERSION,
    name: name.trim() || 'Untitled Project',
    fps: 30,
    width: 1920,
    height: 1080,
    aspect: aspectLabel,
    tracks: makeDefaultTracks(),
    clips: [],
    assetIds: [],
    createdAt: now,
    updatedAt: now,
  }
  await saveProject(snapshot)
  return snapshot
}

/** Delete a project and all media owned by it (OPFS blobs + asset rows). */
export async function deleteProject(id: string): Promise<void> {
  const owned = await db.assets.where('projectId').equals(id).toArray()
  const row: MediaDeletionRow = {
    id: `project:${id}`,
    projectId: id,
    assetIds: owned.map((asset) => asset.id),
    keys: owned.flatMap((asset) => [
      asset.storageKey,
      asset.proxyStorageKey,
      asset.normalizedBlobKey,
    ])
      .filter((key): key is string => !!key),
    createdAt: Date.now(),
  }
  // Durable tombstone first: Home hides the project immediately, while a crash
  // or locked OPFS key leaves enough information to finish cleanup on restart.
  await db.transaction(
    'rw',
    db.projectHeaders,
    db.mediaDeletions,
    async () => {
      await db.mediaDeletions.put(row)
      await db.projectHeaders.delete(id)
    },
  )
  await finishProjectDeletion(row)
}

async function finishProjectDeletion(row: MediaDeletionRow): Promise<void> {
  for (const key of row.keys) await deleteBlob(key)
  await db.transaction(
    'rw',
    [db.assets, db.projects, db.projectHeaders, db.projectBackups, db.mediaDeletions],
    async () => {
      await db.assets.bulkDelete(row.assetIds)
      await db.projects.delete(row.projectId)
      await db.projectHeaders.delete(row.projectId)
      await db.projectBackups.where('projectId').equals(row.projectId).delete()
      await db.mediaDeletions.delete(row.id)
    },
  )
}

export async function resumePendingProjectDeletions(): Promise<number> {
  const pending = await db.mediaDeletions.toArray()
  let completed = 0
  for (const row of pending) {
    try {
      await finishProjectDeletion(row)
      completed++
    } catch {
      // Locked/permission failures remain durable and retry next Home load.
    }
  }
  return completed
}

export interface DuplicateOptions {
  /** Asset ids NOT to copy into the clone. Skipped ids are dropped from assetIds;
   *  clips still referencing them keep the original id for the caller to repoint. */
  skipAssetIds?: Set<string>
  /** Override the clone's name (default: "<source> copy"). */
  name?: string
}

/** Clone a project (timeline + media) into a fresh, independent project. */
export async function duplicateProject(
  id: string,
  opts: DuplicateOptions = {},
): Promise<ProjectSnapshot | null> {
  const source = await getProject(id)
  if (!source) return null

  const now = Date.now()
  const newId = createId('project')
  const skip = opts.skipAssetIds ?? new Set<string>()

  // Prepare every copy before mutating DB. OPFS cannot participate in a Dexie
  // transaction, so bytes are written under leases first and DB ownership is
  // committed atomically only after every write succeeds.
  const owned = await db.assets.where('projectId').equals(id).toArray()
  const idMap = new Map<string, string>()
  const prepared: Array<{ copy: MediaAsset; blob: Blob | null; key: string }> = []
  let additionalBytes = 0
  for (const asset of owned) {
    if (skip.has(asset.id)) continue
    const copyId = createId('asset')
    idMap.set(asset.id, copyId)
    const copy: MediaAsset = { ...asset, id: copyId, projectId: newId, createdAt: now }
    let blob: Blob | null = null
    let key = ''
    if (asset.storageKey) {
      blob = await readBlob(asset.storageKey)
      if (!blob) throw new Error(`Cannot duplicate missing media: ${asset.name}`)
      key = `${copyId}__${asset.name}`
      copy.storageKey = key
      additionalBytes += blob.size
    }
    // Proxy blobs are regenerated lazily; drop the stale reference.
    copy.proxyStorageKey = undefined
    // Normalized OPFS blobs are keyed by the source asset id. Do not share one
    // mutable key between the original and a clone; the clone will use the
    // source path/blob until its next normalization pass.
    copy.normalizedPath = undefined
    copy.normalizedBlobKey = undefined
    copy.normalizationStatus = undefined
    copy.normalizationProgress = undefined
    copy.normalizationJobId = undefined
    copy.normalizationError = undefined
    prepared.push({ copy, blob, key })
  }

  const estimate = typeof navigator !== 'undefined' && navigator.storage?.estimate
    ? await navigator.storage.estimate().catch(() => null)
    : null
  if (estimate?.quota) {
    const available = Math.max(0, estimate.quota - (estimate.usage ?? 0))
    const required = Math.ceil(additionalBytes * 1.05)
    if (available < required) {
      throw new DOMException(
        `Not enough browser storage to duplicate this project ` +
          `(need about ${(required / 1024 ** 3).toFixed(2)} GB, ` +
          `${(available / 1024 ** 3).toFixed(2)} GB available).`,
        'QuotaExceededError',
      )
    }
  }

  // Repoint every clip at its copied asset.
  const clips = (source.clips as { assetId?: string }[]).map((clip) =>
    clip.assetId && idMap.has(clip.assetId)
      ? { ...clip, assetId: idMap.get(clip.assetId) }
      : { ...clip },
  )

  const snapshot: ProjectSnapshot = {
    ...source,
    id: newId,
    name: opts.name ?? `${source.name} copy`,
    clips,
    assetIds: source.assetIds.filter((a) => !skip.has(a)).map((a) => idMap.get(a) ?? a),
    createdAt: now,
    updatedAt: now,
  }
  const writtenKeys: string[] = []
  try {
    for (const item of prepared) {
      if (!item.blob || !item.key) continue
      registerImportLease({
        assetId: item.copy.id,
        tempKey: item.key,
        finalKey: item.key,
        startedAt: now,
      })
      writtenKeys.push(item.key)
      await writeBlob(item.key, item.blob)
    }
    await db.transaction('rw', db.assets, db.projects, db.projectHeaders, async () => {
      await db.assets.bulkPut(prepared.map((item) => item.copy))
      await db.projects.put(rowFromSnapshot(snapshot))
      await db.projectHeaders.put(headerFromSnapshot(snapshot))
    })
    return snapshot
  } catch (error) {
    await db.assets.bulkDelete(prepared.map((item) => item.copy.id)).catch(() => {})
    await db.projects.delete(newId).catch(() => {})
    await db.projectHeaders.delete(newId).catch(() => {})
    // Cleanup is best-effort and must not hide the original quota/transaction
    // failure if one OPFS deletion also fails.
    await Promise.allSettled(writtenKeys.map((key) => deleteBlob(key)))
    throw error
  } finally {
    for (const item of prepared) releaseImportLease(item.copy.id)
  }
}
