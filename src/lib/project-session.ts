import { mediaManager } from '@engine/media'
import {
  createProject,
  getProject,
  saveProject,
  snapshotToTimeline,
  type ProjectSnapshot,
} from '@engine/persistence'
import { useProjectStore, type AspectRatio } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'

const SNAPSHOT_VERSION = 1

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

/** Serialize and persist the open project. No-op when nothing is open. */
export async function saveCurrentProject(): Promise<void> {
  const project = useProjectStore.getState()
  if (!project.id) return
  const timeline = useTimelineStore.getState().timeline
  const now = Date.now()
  const snapshot: ProjectSnapshot = {
    id: project.id,
    version: SNAPSHOT_VERSION,
    name: project.name,
    fps: timeline.fps,
    width: 1920,
    height: 1080,
    aspect: project.aspect.label,
    tracks: timeline.tracks,
    clips: timeline.clips,
    assetIds: project.assets.map((a) => a.id),
    thumbnailDataUrl: pickThumbnail(),
    createdAt: project.lastSavedAt ?? now,
    updatedAt: now,
  }
  await saveProject(snapshot)
  project.setLastSavedAt(now)
}

/** Load a project into the editor and switch to the editor view. */
export async function openProject(id: string): Promise<void> {
  const snapshot = await getProject(id)
  if (!snapshot) return
  const { clips, tracks, fps, durationSec } = snapshotToTimeline(snapshot)
  useTimelineStore.getState().replaceTimeline(clips, tracks, fps, durationSec)
  useProjectStore.getState().loadProject(snapshot)
  const assets = await mediaManager.list(id)
  useProjectStore.getState().setAssets(assets)
  useUIStore.getState().setView('editor')
}

/** Create a fresh project and open it. */
export async function createAndOpenProject(name: string, aspect: AspectRatio): Promise<void> {
  const snapshot = await createProject(name, aspect.label)
  await openProject(snapshot.id!)
}

/** Flush the open project to disk, then return to the Home grid. */
export async function leaveToHome(): Promise<void> {
  await saveCurrentProject()
  useUIStore.getState().setView('home')
}
