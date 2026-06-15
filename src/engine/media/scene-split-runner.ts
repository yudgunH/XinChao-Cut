import type { SceneDetectSource } from '@engine/backend'
import { useProjectStore } from '@store/project-store'
import { useSceneSplitStore } from '@store/scene-split-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'

import { mediaManager } from './media-manager'
import type { MediaAsset } from './types'

/** Cancel the in-flight scene-detection job, if any. */
export async function cancelSceneSplit(): Promise<void> {
  const { jobId } = useSceneSplitStore.getState()
  if (jobId) {
    const { cancelSceneDetect } = await import('@engine/backend')
    await cancelSceneDetect(jobId)
  }
  useSceneSplitStore.getState().clear()
}

/**
 * Resolve a scene-detection source that avoids re-uploading the file when the
 * server already has it. Mirrors the export upload path: prefer a desktop
 * `sourcePath`; otherwise content-hash (cached on the asset), upload once if the
 * server is missing it, then reference it by hash.
 */
async function resolveSceneSource(asset: MediaAsset): Promise<SceneDetectSource> {
  if (asset.sourcePath) return { sourcePath: asset.sourcePath, filename: asset.name }

  const { hashBlob, checkAssets, uploadAsset } = await import('@engine/backend')
  let hash = asset.contentHash
  const blob = await mediaManager.getBlob(asset.id)
  if (!hash) {
    if (!blob) throw new Error('Media not found')
    hash = await hashBlob(blob)
    await mediaManager.setContentHash(asset.id, hash)
    useProjectStore.getState().updateAsset(asset.id, { contentHash: hash })
  }
  const missing = await checkAssets([hash])
  if (missing.includes(hash)) {
    if (!blob) throw new Error('Media not found')
    await uploadAsset(blob, hash, asset.name || 'video')
  }
  return { hash }
}

export async function runSceneSplit(clipId: string): Promise<void> {
  const timelineStore = useTimelineStore.getState()
  const clip = timelineStore.timeline.clips.find((candidate) => candidate.id === clipId)
  if (!clip?.assetId) return

  const asset = useProjectStore.getState().assets.find((candidate) => candidate.id === clip.assetId)
  if (!asset || asset.kind !== 'video') return

  const split = useSceneSplitStore.getState()
  if (split.busy) {
    useToastStore.getState().push('Scene detection already running', 'info')
    return
  }

  const toast = useToastStore.getState()
  split.start(asset.name || 'video')

  try {
    const { startSceneDetect, getSceneDetectStatus } = await import('@engine/backend')

    // Reuse media the server already has instead of re-uploading the (possibly
    // multi-GB) file every time: a desktop source streams by path; otherwise we
    // content-hash, upload once if missing, and reference it by hash thereafter.
    const source = await resolveSceneSource(asset)

    const jobId = await startSceneDetect(source, {
      filename: asset.name || 'video',
      maxScenes: 500,
      minGapSec: Math.max(0.35, 0.1 * Math.max(clip.speed, 0.01)),
      threshold: 0.35,
    })
    useSceneSplitStore.getState().setJob(jobId)

    // Poll until the job finishes. Cancelling clears the store, which we honour
    // by bailing out of the loop.
    let scenes: number[] = []
    for (;;) {
      await new Promise((r) => setTimeout(r, 600))
      if (useSceneSplitStore.getState().jobId !== jobId) return // cancelled
      const status = await getSceneDetectStatus(jobId)
      useSceneSplitStore.getState().setPct(status.pct)
      if (status.status === 'cancelled') return
      if (status.status === 'error') throw new Error(status.error || 'Scene detection failed')
      if (status.status === 'done') {
        scenes = status.scenes
        break
      }
    }

    const splitCount = useTimelineStore.getState().splitClipAtSourceTimes(clipId, scenes)
    if (splitCount === 0) {
      toast.push('No scene cuts found in this clip', 'info')
      return
    }
    toast.push(`Split into ${splitCount + 1} scenes`, 'success')
  } catch (e) {
    toast.push(e instanceof Error ? e.message : 'Split scenes failed', 'error')
  } finally {
    useSceneSplitStore.getState().clear()
  }
}
