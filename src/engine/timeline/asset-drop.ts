import type { MediaAsset } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { useReplaceStore } from '@store/replace-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'

import { clipEffectiveDuration } from './types'

export interface TimelineAssetDropTarget {
  trackId: string
  startSec: number
}

const ACCEPT_KIND = {
  video: new Set<MediaAsset['kind']>(['video', 'image']),
  audio: new Set<MediaAsset['kind']>(['audio']),
  text: new Set<MediaAsset['kind']>(),
  fx: new Set<MediaAsset['kind']>(),
} as const

/** Resolve the semantic target before an async native import can move layout. */
export function resolveTimelineAssetDropTarget(
  clientX: number,
  clientY: number,
): TimelineAssetDropTarget | null {
  if (typeof document === 'undefined') return null
  const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null
  const trackEl = hit?.closest<HTMLElement>('[data-timeline-track-id]')
  const trackId = trackEl?.dataset.timelineTrackId
  if (!trackEl || !trackId) return null
  const zoom = useTimelineStore.getState().zoom
  const rect = trackEl.getBoundingClientRect()
  return {
    trackId,
    startSec: Math.max(0, (clientX - rect.left) / Math.max(zoom, 1e-6)),
  }
}

/** Insert already-imported assets at a captured timeline target. */
export function placeAssetIdsOnTimeline(
  assetIds: readonly string[],
  target: TimelineAssetDropTarget | null,
): boolean {
  if (!target || assetIds.length === 0) return false
  const timelineStore = useTimelineStore.getState()
  const track = timelineStore.timeline.tracks.find((candidate) => candidate.id === target.trackId)
  if (!track || track.locked) return false
  const accepted = ACCEPT_KIND[track.kind]
  const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
  const compatible = assetIds
    .map((id) => assetById.get(id))
    .filter((asset): asset is MediaAsset => !!asset && accepted.has(asset.kind))
  if (compatible.length === 0) return false

  // Match the existing CapCut-style single-asset replace behavior.
  if (compatible.length === 1) {
    const asset = compatible[0]!
    const current = useTimelineStore.getState()
    const targetClip = current.timeline.clips.find(
      (clip) =>
        clip.trackId === track.id &&
        target.startSec >= clip.startSec &&
        target.startSec < clip.startSec + clipEffectiveDuration(clip),
    )
    if (targetClip) {
      const targetDur = clipEffectiveDuration(targetClip)
      if ((asset.durationSec || 0) + 1e-3 >= targetDur) {
        useReplaceStore.getState().openReplace(targetClip.id, asset.id)
      } else {
        useToastStore
          .getState()
          .push('The source clip is shorter than the target clip and cannot replace it', 'error')
      }
      return true
    }
  }

  let cursor = target.startSec
  for (const asset of compatible) {
    useTimelineStore.getState().insertClip({
      trackId: track.id,
      assetId: asset.id,
      startSec: cursor,
      durationSec: asset.durationSec,
    })
    cursor += asset.durationSec || 0
  }
  return true
}
