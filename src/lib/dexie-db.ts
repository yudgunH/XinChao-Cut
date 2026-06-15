import Dexie, { type Table } from 'dexie'

import { createId } from '@engine/core/id'
import type { MediaAsset } from '@engine/media/types'
import type { ProjectSnapshot } from '@engine/persistence/types'

/** Legacy single-project key used before multi-project support. */
const LEGACY_PROJECT_KEY = 'current'

export interface ProjectRow {
  id: string
  /** Denormalized from snapshot so the Home list can sort/show without
   *  deserializing every snapshot. */
  name: string
  updatedAt: number
  snapshot: ProjectSnapshot
}

class XinChaoDB extends Dexie {
  assets!: Table<MediaAsset, string>
  projects!: Table<ProjectRow, string>

  constructor() {
    super('xinchao-cut')
    this.version(1).stores({
      assets: 'id, kind, createdAt',
      projects: 'id',
    })
    // v2: multi-project support — index assets by owning project, projects by
    // updatedAt for the Home list, and migrate the legacy single project.
    this.version(2)
      .stores({
        assets: 'id, projectId, kind, createdAt',
        projects: 'id, updatedAt',
      })
      .upgrade(async (tx) => {
        const projects = tx.table<ProjectRow, string>('projects')
        const assets = tx.table<MediaAsset, string>('assets')

        // Pull the legacy row, whose shape was { id: 'current', snapshot }.
        const legacy = (await projects.get(LEGACY_PROJECT_KEY)) as
          | { id: string; snapshot?: ProjectSnapshot }
          | undefined

        const assetCount = await assets.count()
        const needsDefault = !!legacy?.snapshot || assetCount > 0
        if (!needsDefault) return

        const projectId = createId('project')
        const now = Date.now()
        const snap = legacy?.snapshot
        const migrated: ProjectSnapshot = snap
          ? { ...snap, id: projectId, createdAt: snap.createdAt ?? now, updatedAt: snap.updatedAt ?? now }
          : {
              id: projectId,
              version: 1,
              name: 'My Project',
              fps: 30,
              width: 1920,
              height: 1080,
              aspect: '16:9',
              tracks: [],
              clips: [],
              assetIds: [],
              createdAt: now,
              updatedAt: now,
            }

        await projects.put({
          id: projectId,
          name: migrated.name,
          updatedAt: migrated.updatedAt,
          snapshot: migrated,
        })
        if (legacy) await projects.delete(LEGACY_PROJECT_KEY)

        // Attach all pre-existing (unscoped) assets to the migrated project.
        await assets.toCollection().modify((asset) => {
          if (!asset.projectId) asset.projectId = projectId
        })
      })
  }
}

export const db = new XinChaoDB()
