import { clipEffectiveDuration, type Clip, type Track } from './types'

export interface RipplePreviewStats {
  overlapChecks: number
}

export interface RipplePreviewContext {
  readonly draggedStartSec: number
  readonly draggedDurationSec: number
  readonly others: readonly Clip[]
  readonly linkedOwnerByClipId: ReadonlyMap<string, string>
  readonly linkedStartByClipId: ReadonlyMap<string, number>
  lastInsertIndex: number
  lastPreview: Record<string, number> | null
}

/** Build the expensive linkage index once at drag start, not per mousemove. */
export function prepareRipplePreview(
  clips: readonly Clip[],
  tracks: readonly Track[],
  mainId: string,
  draggedIds: readonly string[],
  linkEnabled: boolean,
  stats?: RipplePreviewStats,
): RipplePreviewContext | null {
  const dragged = new Set(draggedIds)
  const draggedMain = clips
    .filter((clip) => dragged.has(clip.id) && clip.trackId === mainId)
    .sort((a, b) => a.startSec - b.startSec)
  if (draggedMain.length === 0) return null

  const others = clips
    .filter((clip) => clip.trackId === mainId && !dragged.has(clip.id))
    .sort((a, b) => a.startSec - b.startSec)
  const linkedOwnerByClipId = new Map<string, string>()
  const linkedStartByClipId = new Map<string, number>()

  if (linkEnabled && others.length > 0) {
    const trackById = new Map(tracks.map((track) => [track.id, track]))
    const linked = clips
      .filter((clip) => {
        if (dragged.has(clip.id)) return false
        const kind = trackById.get(clip.trackId)?.kind
        return kind === 'text'
      })
      .sort((a, b) => a.startSec - b.startSec)

    // Main-track clips are non-overlapping after magnetic ripple. Walking both
    // sorted lists makes ownership O(main + linked + actual overlaps).
    let firstCandidate = 0
    for (const clip of linked) {
      const start = clip.startSec
      const end = start + clipEffectiveDuration(clip)
      while (
        firstCandidate < others.length &&
        others[firstCandidate]!.startSec + clipEffectiveDuration(others[firstCandidate]!) <= start
      ) {
        firstCandidate += 1
      }
      let bestId: string | null = null
      let bestOverlap = 1e-4
      for (let index = firstCandidate; index < others.length; index++) {
        const main = others[index]!
        if (main.startSec >= end) break
        if (stats) stats.overlapChecks += 1
        const mainEnd = main.startSec + clipEffectiveDuration(main)
        const overlap = Math.min(end, mainEnd) - Math.max(start, main.startSec)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          bestId = main.id
        }
      }
      if (bestId) {
        linkedOwnerByClipId.set(clip.id, bestId)
        linkedStartByClipId.set(clip.id, clip.startSec)
      }
    }
  }

  return {
    draggedStartSec: draggedMain[0]!.startSec,
    draggedDurationSec: draggedMain.reduce((sum, clip) => sum + clipEffectiveDuration(clip), 0),
    others,
    linkedOwnerByClipId,
    linkedStartByClipId,
    lastInsertIndex: -1,
    lastPreview: null,
  }
}

function insertionIndex(clips: readonly Clip[], startSec: number): number {
  let low = 0
  let high = clips.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (clips[mid]!.startSec < startSec) low = mid + 1
    else high = mid
  }
  return low
}

/** Recompute only when the drag crosses a sibling boundary. */
export function computeRipplePreview(
  context: RipplePreviewContext,
  deltaSec: number,
): Record<string, number> | null {
  const insertIndex = insertionIndex(
    context.others,
    Math.max(0, context.draggedStartSec + deltaSec),
  )
  if (insertIndex === context.lastInsertIndex) return context.lastPreview

  const preview: Record<string, number> = {}
  const movedDelta = new Map<string, number>()
  let cursor = 0
  for (let index = 0; index < context.others.length; index++) {
    if (index === insertIndex) cursor += context.draggedDurationSec
    const clip = context.others[index]!
    if (Math.abs(clip.startSec - cursor) > 1e-4) {
      preview[clip.id] = cursor
      movedDelta.set(clip.id, cursor - clip.startSec)
    }
    cursor += clipEffectiveDuration(clip)
  }

  for (const [clipId, ownerId] of context.linkedOwnerByClipId) {
    const delta = movedDelta.get(ownerId)
    if (delta === undefined) continue
    const start = context.linkedStartByClipId.get(clipId)
    if (start !== undefined) preview[clipId] = Math.max(0, start + delta)
  }

  context.lastInsertIndex = insertIndex
  context.lastPreview = Object.keys(preview).length > 0 ? preview : null
  return context.lastPreview
}
