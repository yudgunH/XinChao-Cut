import { audioEngine } from '@engine/audio'
import { mediaManager } from '@engine/media'
import {
  createProject,
  getProject,
  saveProject,
  snapshotToTimeline,
  snapshotToCompounds,
  type ProjectSnapshot,
} from '@engine/persistence'
import { usePlaybackStore } from '@store/playback-store'
import { useProjectStore, type AspectRatio } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'

import { ProjectOwnershipCoordinator, type ProjectOwnership } from './project-ownership'
import { runProjectLoadPipeline } from './project-load-pipeline'
import { projectSaveCoordinator } from './project-save-coordinator'

export type { ProjectOwnership }

const SNAPSHOT_VERSION = 1

/**
 * Process-wide project session generation. Shared by open/close/switch/import
 * so a single token contract covers F09 + F10.
 */
export const projectSessionCoord = new ProjectOwnershipCoordinator()

export function getProjectSessionGeneration(): number {
  return projectSessionCoord.getGeneration()
}

/** Invalidate in-flight load/import (close / leave home / explicit abort). */
export function invalidateProjectSession(): number {
  return projectSessionCoord.bump()
}

/** Capture ownership for a long-running import against the open project. */
export function captureProjectOwnership(): ProjectOwnership {
  return projectSessionCoord.capture(useProjectStore.getState().id)
}

/** True if an import/load continuation may still mutate the live editor stores. */
export function stillOwnsProject(ownership: ProjectOwnership): boolean {
  return projectSessionCoord.stillOwns(ownership, useProjectStore.getState().id)
}

function mergeAssets(
  ...groups: Awaited<ReturnType<typeof mediaManager.list>>[]
): Awaited<ReturnType<typeof mediaManager.list>> {
  const merged = new Map<string, Awaited<ReturnType<typeof mediaManager.list>>[number]>()
  for (const group of groups) {
    for (const asset of group) merged.set(asset.id, asset)
  }
  return Array.from(merged.values())
}

/** Thumbnail for the Home card: first video/image clip's asset frame, else the
 *  first asset's frame. */
function pickThumbnail(): string | undefined {
  const { assets } = useProjectStore.getState()
  const { clips } = useTimelineStore.getState().timeline
  for (const clip of clips) {
    const asset = assets.find((a) => a.id === clip.assetId)
    if (asset?.thumbnailDataUrl) return asset.thumbnailDataUrl
  }
  return assets.find((a) => a.thumbnailDataUrl)?.thumbnailDataUrl
}

/**
 * Capture the current editor stores into a ProjectSnapshot. Used by the S13
 * save coordinator so a trailing
 * coalesced save always reads the *latest* dirty state.
 */
async function captureCurrentSnapshot(expectedId?: string): Promise<ProjectSnapshot | null> {
  const project = useProjectStore.getState()
  if (!project.id) return null
  // If the store has already switched to a different project (a fast open/close
  // that raced this drain), do NOT capture — capturing here would snapshot the
  // WRONG project and, worse, let the outgoing project's queued save silently
  // drop the incoming project's first edit (P0 #3). The switch path flushes the
  // outgoing project before load, so the correct capture already happened.
  if (expectedId && project.id !== expectedId) return null
  // rootSnapshot resolves the ROOT timeline + flushed compound registry even when
  // the user is currently editing inside a compound (the live `timeline` would
  // otherwise be a sub-timeline — saving it as the project would corrupt it).
  const { timeline, compounds } = useTimelineStore.getState().rootSnapshot()
  // An empty timeline is a valid user state (Select all -> Delete). Hydration
  // races are prevented by the project ownership/load transaction above; clip
  // count must not be used as a proxy for user intent. Rolling backups remain
  // the recovery path for an actually bad save.
  const now = Date.now()
  return {
    id: project.id,
    version: SNAPSHOT_VERSION,
    name: project.name,
    fps: timeline.fps,
    width: 1920,
    height: 1080,
    aspect: project.aspect.label,
    tracks: timeline.tracks,
    clips: timeline.clips,
    compounds,
    assetIds: project.assets.map((a) => a.id),
    thumbnailDataUrl: pickThumbnail(),
    createdAt: project.lastSavedAt ?? now,
    updatedAt: now,
  }
}

/**
 * Serialize and persist the open project. No-op when nothing is open.
 *
 * S13: goes through {@link projectSaveCoordinator} so concurrent autosaves for
 * the same project are serialized and coalesced to the latest dirty snapshot.
 * A failed persist re-arms dirty (status left to the caller).
 */
export async function saveCurrentProject(): Promise<void> {
  const projectId = useProjectStore.getState().id
  if (!projectId) return

  await projectSaveCoordinator.requestSave(
    projectId,
    () => captureCurrentSnapshot(projectId),
    async (snapshot) => {
      // Drop if the user switched/closed mid-flight (different open project).
      if (useProjectStore.getState().id !== projectId) return { committed: true }
      const outcome = await saveProject(snapshot)
      // Only stamp lastSavedAt when the write actually committed AND we still
      // have this project open (a stale skip retries with a higher revision).
      if (outcome.committed && useProjectStore.getState().id === projectId) {
        useProjectStore.getState().setLastSavedAt(snapshot.updatedAt)
      }
      return outcome
    },
  )
}

/**
 * Flush the given project's pending autosave to disk BEFORE the store is
 * replaced by another project. The debounced autosave captures at drain time, so
 * without this a project switch inside the 3s debounce window would let the drain
 * capture the NEW project and lose the outgoing project's last edit (P0 #3).
 * Only captures while the store still owns `projectId`; always drains the queue.
 */
export async function flushProject(projectId: string): Promise<void> {
  if (!projectId) return
  if (useProjectStore.getState().id === projectId) {
    await saveCurrentProject()
  }
  await projectSaveCoordinator.whenIdle(projectId)
}

/**
 * Hydrate the editor stores from a project WITHOUT switching to the editor
 * view. Transactional (S9A): snapshot + assets load fully under a generation
 * token; only then timeline/project/assets commit as one sync batch. A stale
 * load (superseded by a later open/close) discards without mutating.
 */
export async function loadProjectHeadless(id: string): Promise<void> {
  // Save the outgoing project's pending edits before its store is overwritten
  // (P0 #3 — switching projects fast must not drop the last edit).
  const outgoing = useProjectStore.getState().id
  if (outgoing && outgoing !== id) {
    await flushProject(outgoing)
  }
  await runProjectLoadPipeline(id, {
    coord: projectSessionCoord,
    getProject: async (projectId) => {
      const snapshot = await getProject(projectId)
      if (!snapshot) return null
      return {
        id: snapshot.id ?? projectId,
        name: snapshot.name,
        assetIds: snapshot.assetIds ?? [],
        payload: snapshot,
      }
    },
    listOwnedAssets: (projectId) => mediaManager.list(projectId),
    listAssetsByIds: (ids) => mediaManager.listByIds(ids),
    mergeAssets: (owned, referenced) =>
      mergeAssets(
        owned as Awaited<ReturnType<typeof mediaManager.list>>,
        referenced as Awaited<ReturnType<typeof mediaManager.list>>,
      ),
    commitBatch: ({ snapshot, assets }) => {
      const full = snapshot.payload as ProjectSnapshot
      const { clips, tracks, fps, durationSec } = snapshotToTimeline(full)
      // Synchronous multi-store batch — no await between these lines.
      // Reset transport FIRST: leaving the editor mid-play only stops the audio
      // engine, it never cleared isPlaying / currentSec. Loading another project
      // would otherwise mount playback at the old project's playhead (e.g. 30:00
      // on a 2-min video) and could auto-resume (#10).
      const pb = usePlaybackStore.getState()
      pb.pause()
      pb.seek(0)
      useTimelineStore.getState().replaceTimeline(clips, tracks, fps, durationSec)
      useTimelineStore.getState().setCompounds(snapshotToCompounds(full))
      useProjectStore.getState().loadProject(full)
      useProjectStore.getState().setAssets(
        assets as Awaited<ReturnType<typeof mediaManager.list>>,
      )
      // Seed the save counter from disk so the first autosave after an app
      // restart doesn't stamp revision 1 and get silently CAS-rejected against a
      // higher on-disk revision (S13/F19 — silent data loss otherwise).
      if (full.id && full.saveRevision) {
        projectSaveCoordinator.seedRevision(full.id, full.saveRevision)
      }
    },
    afterCommit: ({ assets, generation }) => {
      // Drop PCM buffers from the previous project so RAM does not accumulate.
      // Only if we still own the session — a stale afterCommit must never
      // evict the newer project's media (F09/F10).
      if (!projectSessionCoord.isCurrent(generation)) return
      audioEngine.evictExcept(new Set(assets.map((a) => a.id)))
    },
  })
}

/** Load a project into the editor and switch to the editor view. */
export async function openProject(id: string): Promise<void> {
  await loadProjectHeadless(id)
  // Only enter the editor if this open actually committed (stale A after B
  // leaves project id === B, so A's openProject does not flip the view).
  if (useProjectStore.getState().id === id) {
    useUIStore.getState().setView('editor')
  }
}

/** Create a fresh project and open it. */
export async function createAndOpenProject(name: string, aspect: AspectRatio): Promise<void> {
  const snapshot = await createProject(name, aspect.label)
  await openProject(snapshot.id!)
}

/**
 * Flush the open project to disk, invalidate pending load/import, then return
 * to the Home grid. Invalidation ensures a late open A cannot commit after the
 * user left (or closed) the editor.
 */
export async function leaveToHome(): Promise<void> {
  // Stop transport before a potentially slow project flush. Otherwise audio
  // keeps playing behind Home for the whole IndexedDB/OPFS save.
  const pb = usePlaybackStore.getState()
  pb.pause()
  pb.seek(0)
  audioEngine.stop()
  const current = useProjectStore.getState().id
  if (current) await flushProject(current)
  else await saveCurrentProject()
  invalidateProjectSession()
  useUIStore.getState().setView('home')
}
