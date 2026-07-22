/**
 * Pure helpers for timeline track performance:
 *  - group clips by track once (O(C)) instead of each track filtering all clips
 *  - compute which tracks intersect the vertical viewport for virtualization
 *
 * Benchmarked with 100 tracks × ~100 clips (10_000 total) — see
 * track-virtualization.test.ts.
 */

import type { Clip, Track } from '@engine/timeline'

/** One O(C) pass → Map<trackId, Clip[]>. Arrays preserve clip order. */
export function buildClipsByTrack(clips: readonly Clip[]): Map<string, Clip[]> {
  const map = new Map<string, Clip[]>()
  for (const clip of clips) {
    const list = map.get(clip.trackId)
    if (list) list.push(clip)
    else map.set(clip.trackId, [clip])
  }
  return map
}

export interface TrackLayout {
  id: string
  top: number
  height: number
  bottom: number
  index: number
}

/** Cumulative Y layout for each track (same order as `tracks`). */
export function buildTrackLayouts(
  tracks: readonly Track[],
  heightOf: (kind: Track['kind']) => number,
): TrackLayout[] {
  const layouts: TrackLayout[] = []
  let top = 0
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]!
    const height = heightOf(t.kind)
    layouts.push({ id: t.id, top, height, bottom: top + height, index: i })
    top += height
  }
  return layouts
}

export interface VisibleTrackWindow {
  /** Inclusive start index into tracks/layouts. */
  start: number
  /** Exclusive end index. */
  end: number
  /** Y of first visible track (spacer above). */
  offsetTop: number
  /** Total height of the track stack. */
  totalHeight: number
}

/**
 * Vertical window of tracks intersecting [scrollTop, scrollTop + viewportHeight]
 * expanded by `overscanPx` on each side (smooth scroll).
 */
export function visibleTrackWindow(
  layouts: readonly TrackLayout[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 200,
): VisibleTrackWindow {
  const totalHeight = layouts.length === 0 ? 0 : layouts[layouts.length - 1]!.bottom
  if (layouts.length === 0 || viewportHeight <= 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight }
  }
  const minY = Math.max(0, scrollTop - overscanPx)
  const maxY = scrollTop + viewportHeight + overscanPx

  // Binary search first layout with bottom > minY
  let lo = 0
  let hi = layouts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (layouts[mid]!.bottom <= minY) lo = mid + 1
    else hi = mid
  }
  const start = lo

  lo = start
  hi = layouts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (layouts[mid]!.top < maxY) lo = mid + 1
    else hi = mid
  }
  const end = lo
  const offsetTop = start < layouts.length ? layouts[start]!.top : 0
  return { start, end, offsetTop, totalHeight }
}
