import {
  cancelSceneDetect,
  hashBlob,
  checkAssets,
  isRetryableBackendPollError,
  uploadAsset,
  startSceneDetect,
  getSceneDetectStatus,
  type SceneDetectSource,
} from '@engine/backend'
import { useProjectStore } from '@store/project-store'
import { useSceneSplitStore } from '@store/scene-split-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'
import { captureProjectOwnership, stillOwnsProject } from '@lib/project-session'

import { mediaManager } from './media-manager'
import type { MediaAsset } from './types'

let activeController: AbortController | null = null

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException('Cancelled', 'AbortError'))
    return
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    reject(new DOMException('Cancelled', 'AbortError'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
})

/** Cancel the in-flight scene-detection job, if any. */
export async function cancelSceneSplit(): Promise<void> {
  const controller = activeController
  activeController = null
  controller?.abort()
  const { jobId } = useSceneSplitStore.getState()
  if (jobId) {
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
async function resolveSceneSource(
  asset: MediaAsset,
  signal: AbortSignal,
  assertOwnership: () => void,
): Promise<SceneDetectSource> {
  if (asset.sourcePath) return { sourcePath: asset.sourcePath, filename: asset.name }

  let hash = asset.contentHash
  const blob = await mediaManager.getBlob(asset.id)
  assertOwnership()
  if (!hash) {
    if (!blob) throw new Error('Media not found')
    hash = await hashBlob(blob, signal)
    assertOwnership()
    await mediaManager.setContentHash(asset.id, hash)
    assertOwnership()
    useProjectStore.getState().updateAsset(asset.id, { contentHash: hash })
  }
  const missing = await checkAssets([hash], signal)
  assertOwnership()
  if (missing.includes(hash)) {
    if (!blob) throw new Error('Media not found')
    await uploadAsset(blob, hash, asset.name || 'video', signal)
    assertOwnership()
  }
  return { hash }
}

export async function runSceneSplit(clipId: string): Promise<void> {
  const timelineStore = useTimelineStore.getState()
  const clip = timelineStore.timeline.clips.find((candidate) => candidate.id === clipId)
  if (!clip?.assetId) return

  const asset = useProjectStore.getState().assets.find((candidate) => candidate.id === clip.assetId)
  if (!asset || asset.kind !== 'video') return
  const ownership = captureProjectOwnership()
  if (!stillOwnsProject(ownership)) return

  const split = useSceneSplitStore.getState()
  if (split.busy) {
    useToastStore.getState().push('Scene detection already running', 'info')
    return
  }

  const toast = useToastStore.getState()
  const controller = new AbortController()
  activeController = controller
  const { signal } = controller
  const ownershipWatch = setInterval(() => {
    if (!stillOwnsProject(ownership)) controller.abort()
  }, 100)
  const assertOwnership = () => {
    if (signal.aborted || !stillOwnsProject(ownership)) {
      throw new DOMException('Cancelled', 'AbortError')
    }
  }
  let jobId: string | null = null
  let jobDone = false
  split.start(asset.name || 'video')

  try {
    // Reuse media the server already has instead of re-uploading the (possibly
    // multi-GB) file every time: a desktop source streams by path; otherwise we
    // content-hash, upload once if missing, and reference it by hash thereafter.
    const source = await resolveSceneSource(asset, signal, assertOwnership)
    assertOwnership()

    jobId = await startSceneDetect(source, {
      filename: asset.name || 'video',
      maxScenes: 500,
      minGapSec: Math.max(0.35, 0.1 * Math.max(clip.speed, 0.01)),
      threshold: 0.35,
      signal,
    })
    assertOwnership()
    useSceneSplitStore.getState().setJob(jobId)

    // Poll until the job finishes. Cancelling clears the store, which we honour
    // by bailing out of the loop.
    let scenes: number[] = []
    let consecutivePollFailures = 0
    for (;;) {
      assertOwnership()
      if (useSceneSplitStore.getState().jobId !== jobId) {
        await cancelSceneDetect(jobId)
        return
      }
      let status: Awaited<ReturnType<typeof getSceneDetectStatus>>
      try {
        status = await getSceneDetectStatus(jobId, signal)
        consecutivePollFailures = 0
      } catch (error) {
        assertOwnership()
        if (!isRetryableBackendPollError(error) || consecutivePollFailures >= 10) throw error
        consecutivePollFailures += 1
        await sleep(Math.min(
          10_000,
          750 * 2 ** Math.min(consecutivePollFailures, 4),
        ), signal)
        continue
      }
      assertOwnership()
      useSceneSplitStore.getState().setPct(status.pct)
      if (status.status === 'cancelled') return
      if (status.status === 'error') throw new Error(status.error || 'Scene detection failed')
      if (status.status === 'done') {
        jobDone = true
        scenes = status.scenes
        break
      }
      await sleep(600, signal)
    }

    assertOwnership()
    const splitCount = useTimelineStore.getState().splitClipAtSourceTimes(clipId, scenes)
    if (splitCount === 0) {
      toast.push('No scene cuts found in this clip', 'info')
      return
    }
    toast.push(`Split into ${splitCount + 1} scenes`, 'success')
  } catch (e) {
    if (jobId && !jobDone) await cancelSceneDetect(jobId)
    if (
      stillOwnsProject(ownership) &&
      !(e instanceof DOMException && e.name === 'AbortError')
    ) {
      toast.push(e instanceof Error ? e.message : 'Split scenes failed', 'error')
    }
  } finally {
    clearInterval(ownershipWatch)
    if (activeController === controller) {
      activeController = null
      useSceneSplitStore.getState().clear()
    }
  }
}
