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

/** Lean Home row. Large timeline snapshots stay in `projects` and are
 * loaded only when a project is opened. */
export interface ProjectListRow {
  id: string
  name: string
  updatedAt: number
  clipCount: number
  thumbnailDataUrl?: string
}

/** Rolling pre-overwrite copies of a project row — the recovery path when an
 *  autosave persists a degraded state (dev-server reload mid-session, crash
 *  during hydration, …) over the single live row. */
export interface ProjectBackupRow {
  id: string
  projectId: string
  /** updatedAt of the snapshot at the moment it was backed up. */
  updatedAt: number
  snapshot: ProjectSnapshot
}

export interface MediaDeletionRow {
  id: string
  projectId: string
  assetIds: string[]
  keys: string[]
  createdAt: number
}

class XinChaoDB extends Dexie {
  assets!: Table<MediaAsset, string>
  projects!: Table<ProjectRow, string>
  projectHeaders!: Table<ProjectListRow, string>
  projectBackups!: Table<ProjectBackupRow, string>
  mediaDeletions!: Table<MediaDeletionRow, string>

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
    // v3: rolling project backups (see ProjectBackupRow).
    this.version(3).stores({
      assets: 'id, projectId, kind, createdAt',
      projects: 'id, updatedAt',
      projectBackups: 'id, projectId, updatedAt',
    })
    // v4: keep Home metadata separate from multi-MB snapshots, and add
    // an ordered per-project backup index so autosave never loads every backup.
    this.version(4)
      .stores({
        assets: 'id, projectId, kind, createdAt',
        projects: 'id, updatedAt',
        projectHeaders: 'id, updatedAt',
        projectBackups: 'id, projectId, updatedAt, [projectId+updatedAt]',
      })
      .upgrade(async (tx) => {
        const projects = await tx.table<ProjectRow, string>('projects').toArray()
        const headers = tx.table<ProjectListRow, string>('projectHeaders')
        await headers.bulkPut(projects.map((row) => ({
          id: row.id,
          name: row.name,
          updatedAt: row.updatedAt,
          clipCount: row.snapshot.clips.length,
          thumbnailDataUrl: row.snapshot.thumbnailDataUrl,
        })))
      })
    // v5: durable tombstones bridge the OPFS/IndexedDB transaction boundary
    // for project deletion and are resumed on the next Home load after a crash.
    this.version(5).stores({
      assets: 'id, projectId, kind, createdAt',
      projects: 'id, updatedAt',
      projectHeaders: 'id, updatedAt',
      projectBackups: 'id, projectId, updatedAt, [projectId+updatedAt]',
      mediaDeletions: 'id, projectId, createdAt',
    })
    // v6: normalize the Home metadata index while preserving existing projects.
    this.version(6).stores({
      assets: 'id, projectId, kind, createdAt',
      projects: 'id, updatedAt',
      projectHeaders: 'id, updatedAt',
      projectBackups: 'id, projectId, updatedAt, [projectId+updatedAt]',
      mediaDeletions: 'id, projectId, createdAt',
    })
  }
}

export const db = new XinChaoDB()
