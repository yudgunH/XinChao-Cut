import { createId } from '@engine/core/id'
import { mediaManager, type MediaAsset } from '@engine/media'
import { makeDefaultTracks } from '@engine/timeline'
import { db, type ProjectRow } from '@lib/dexie-db'

import { readBlob, writeBlob } from './opfs'
import type { ProjectSnapshot } from './types'

const SNAPSHOT_VERSION = 1

function rowFromSnapshot(snap: ProjectSnapshot): ProjectRow {
  return { id: snap.id!, name: snap.name, updatedAt: snap.updatedAt, snapshot: snap }
}

/** All projects, most-recently-edited first. */
export async function listProjects(): Promise<ProjectRow[]> {
  const rows = await db.projects.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getProject(id: string): Promise<ProjectSnapshot | null> {
  const row = await db.projects.get(id)
  return row?.snapshot ?? null
}

/** Persist a snapshot (insert or update), syncing the denormalized row fields. */
export async function saveProject(snapshot: ProjectSnapshot): Promise<void> {
  await db.projects.put(rowFromSnapshot(snapshot))
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
  for (const asset of owned) await mediaManager.remove(asset.id)
  await db.projects.delete(id)
}

/** Clone a project (timeline + media) into a fresh, independent project. */
export async function duplicateProject(id: string): Promise<ProjectSnapshot | null> {
  const source = await getProject(id)
  if (!source) return null

  const now = Date.now()
  const newId = createId('project')

  // Copy each owned asset: new id + OPFS blob, remapped to the new project.
  const owned = await db.assets.where('projectId').equals(id).toArray()
  const idMap = new Map<string, string>()
  for (const asset of owned) {
    const copyId = createId('asset')
    idMap.set(asset.id, copyId)
    const copy: MediaAsset = { ...asset, id: copyId, projectId: newId, createdAt: now }
    if (asset.storageKey) {
      const blob = await readBlob(asset.storageKey)
      if (blob) {
        const key = `${copyId}__${asset.name}`
        await writeBlob(key, blob)
        copy.storageKey = key
      }
    }
    // Proxy blobs are regenerated lazily; drop the stale reference.
    copy.proxyStorageKey = undefined
    await db.assets.put(copy)
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
    name: `${source.name} copy`,
    clips,
    assetIds: source.assetIds.map((a) => idMap.get(a) ?? a),
    createdAt: now,
    updatedAt: now,
  }
  await saveProject(snapshot)
  return snapshot
}
