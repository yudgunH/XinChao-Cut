export interface TimelineWithClips {
  clips: Array<{ assetId?: string | null }>
}

export interface CompoundTimelineLike {
  timeline: TimelineWithClips
}

function countInClips(clips: TimelineWithClips['clips'], assetId: string): number {
  let count = 0
  for (const clip of clips) if (clip.assetId === assetId) count++
  return count
}

/** Count root + nested references from an already resolved root snapshot. */
export function countTimelineAssetReferences(
  timeline: TimelineWithClips,
  compounds: Record<string, CompoundTimelineLike>,
  assetId: string,
): number {
  let count = countInClips(timeline.clips, assetId)
  for (const compound of Object.values(compounds)) {
    count += countInClips(compound.timeline.clips, assetId)
  }
  return count
}

/** Count a selected asset set in one timeline traversal.

Deleting hundreds of library items used to rescan every clip/compound once per
asset (O(selected × clips)), which freezes a caption-heavy timeline. Unknown
asset ids are omitted; callers can treat a missing entry as zero.
*/
export function countTimelineAssetReferencesMany(
  timeline: TimelineWithClips,
  compounds: Record<string, CompoundTimelineLike>,
  assetIds: Iterable<string>,
): Map<string, number> {
  const wanted = new Set(assetIds)
  const counts = new Map<string, number>()
  const visit = (clips: TimelineWithClips['clips']) => {
    for (const clip of clips) {
      const id = clip.assetId
      if (!id || !wanted.has(id)) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  visit(timeline.clips)
  for (const compound of Object.values(compounds)) visit(compound.timeline.clips)
  return counts
}
