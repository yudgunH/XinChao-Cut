import { mediaManager } from '@engine/media'
import type { ProjectSnapshot } from '@engine/persistence'
import { db } from '@lib/dexie-db'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import {
  countTimelineAssetReferences,
  type CompoundTimelineLike,
} from './timeline-asset-references'

export interface AssetProjectReference {
  projectId: string
  projectName: string
  clipCount: number
}

export function countAssetReferences(snapshot: ProjectSnapshot, assetId: string): number {
  return countTimelineAssetReferences(
    { clips: snapshot.clips as Array<{ assetId?: string | null }> },
    (snapshot.compounds ?? {}) as Record<string, CompoundTimelineLike>,
    assetId,
  )
}

/** Includes the unsaved live editor plus every persisted project snapshot. */
export async function findAssetProjectReferences(assetId: string): Promise<AssetProjectReference[]> {
  const refs = new Map<string, AssetProjectReference>()
  const openProject = useProjectStore.getState()
  const openId = openProject.id
  if (openId) {
    const { timeline, compounds } = useTimelineStore.getState().rootSnapshot()
    const liveCount = countAssetReferences(
      {
        id: openId,
        version: 1,
        name: openProject.name,
        fps: timeline.fps,
        width: 1920,
        height: 1080,
        aspect: openProject.aspect.label,
        tracks: timeline.tracks,
        clips: timeline.clips,
        compounds,
        assetIds: openProject.assets.map((asset) => asset.id),
        createdAt: 0,
        updatedAt: 0,
      },
      assetId,
    )
    if (liveCount > 0) {
      refs.set(openId, { projectId: openId, projectName: openProject.name, clipCount: liveCount })
    }
  }

  const [projects, backups] = await Promise.all([
    db.projects.toArray(),
    db.projectBackups.toArray(),
  ])
  const projectNames = new Map(projects.map((row) => [row.id, row.name]))
  for (const row of projects) {
    if (row.id === openId) continue // the live root snapshot is newer than disk
    const clipCount = countAssetReferences(row.snapshot, assetId)
    if (clipCount > 0) {
      refs.set(row.id, { projectId: row.id, projectName: row.name, clipCount })
    }
  }
  // A rolling backup is expected to be restorable. Deleting its only global
  // music blob would make recovery produce a dangling clip even when the live
  // project no longer references the track.
  for (const backup of backups) {
    const clipCount = countAssetReferences(backup.snapshot, assetId)
    if (clipCount <= 0) continue
    const existing = refs.get(backup.projectId)
    refs.set(backup.projectId, {
      projectId: backup.projectId,
      projectName: projectNames.get(backup.projectId) ?? backup.snapshot.name ?? 'Project backup',
      clipCount: (existing?.clipCount ?? 0) + clipCount,
    })
  }
  return [...refs.values()]
}

export class AudioLibraryAssetInUseError extends Error {
  constructor(public readonly references: AssetProjectReference[]) {
    const projects = references.slice(0, 3).map((ref) => `“${ref.projectName}”`).join(', ')
    const extra = references.length > 3 ? ` and ${references.length - 3} other projects` : ''
    super(`Unable to delete: this asset is used in ${projects}${extra}.`)
    this.name = 'AudioLibraryAssetInUseError'
  }
}

export async function removeAudioLibraryAssetSafely(assetId: string): Promise<void> {
  const references = await findAssetProjectReferences(assetId)
  if (references.length > 0) throw new AudioLibraryAssetInUseError(references)

  // Re-check the live store after the asynchronous IndexedDB scan closes the
  // common check -> user inserts clip -> delete race in this renderer.
  const liveReferences = await findAssetProjectReferences(assetId)
  if (liveReferences.length > 0) throw new AudioLibraryAssetInUseError(liveReferences)
  await mediaManager.remove(assetId)
}
