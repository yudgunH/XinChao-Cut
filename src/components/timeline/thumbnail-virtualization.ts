/**
 * S8 / F08 — Virtualize per-clip video thumbnail strips.
 *
 * TimelineTrack already culls clips outside the horizontal viewport, but a
 * single multi-hour clip that intersects the viewport still used to allocate
 * one <img> per filmstrip slot across the *entire* clip width
 * (`ceil(clipWidthPx / frameW)` → thousands of nodes at high zoom).
 *
 * This module plans only the slots that cover the clip-local intersection of
 * the viewport (+ small overscan), with a hard cap so a pathological zoom
 * never blows the DOM.
 */

/** Extra slots past each edge of the visible range (smooth scroll). */
export const THUMB_OVERSCAN_SLOTS = 2

/**
 * Max <img> nodes per clip strip. When the ideal slot count would exceed this,
 * slot width is widened so the visible window still fits within the budget.
 */
export const THUMB_HARD_CAP = 48

export interface VisibleClipRangePx {
  /** Inclusive start in clip-local pixels [0, clipWidthPx]. */
  startPx: number
  /** Exclusive end in clip-local pixels. */
  endPx: number
}

/**
 * Intersection of the timeline viewport with a clip's pixel box, in clip-local
 * coordinates. Returns a zero-width range when the clip is fully off-screen.
 */
export function clipLocalVisibleRange(opts: {
  clipLeftPx: number
  clipWidthPx: number
  scrollLeft: number
  viewportWidth: number
}): VisibleClipRangePx {
  const clipW = Math.max(0, opts.clipWidthPx)
  if (clipW <= 0) return { startPx: 0, endPx: 0 }
  const vw = Math.max(0, opts.viewportWidth)
  // If viewport is unknown, treat the whole clip as "visible" so callers still
  // get a plan (hard cap applies). Prefer real viewport from Timeline.
  const viewStart = opts.scrollLeft
  const viewEnd = opts.scrollLeft + (vw > 0 ? vw : clipW)
  const startPx = Math.max(0, viewStart - opts.clipLeftPx)
  const endPx = Math.min(clipW, viewEnd - opts.clipLeftPx)
  if (endPx <= startPx) return { startPx: 0, endPx: 0 }
  return { startPx, endPx }
}

export interface ThumbnailSlotPlan {
  /** Slot index along the full-clip grid (stable under scroll within a frameW). */
  slotIndex: number
  /** Left edge in clip-local px. */
  leftPx: number
  /** Source time at the left edge of this slot (seconds). */
  srcSec: number
  /** Index into asset.thumbnailStrip. */
  stripIdx: number
  /** Slot width in px (may be widened under hard cap). */
  frameW: number
}

export interface PlanThumbnailSlotsInput {
  stripLength: number
  assetWidth: number
  assetHeight: number
  assetDurationSec: number
  inPointSec: number
  clipDurationSec: number
  clipWidthPx: number
  clipHeightPx: number
  /** Timeline x of the clip's left edge (startSec * zoom + drag). */
  clipLeftPx: number
  scrollLeft: number
  viewportWidth: number
  overscanSlots?: number
  hardCap?: number
}

/**
 * Plan the filmstrip slots to mount. Source-time / strip index use the same
 * formulas as the pre-S8 full-strip path so scroll/zoom/trim stay accurate:
 *   srcSec = inPoint + (slotX / clipWidthPx) * clipDuration
 *   t = clamp(srcSec / assetDuration, 0, 1)
 *   stripIdx = round(t * (stripLength - 1))
 */
export function planThumbnailSlots(input: PlanThumbnailSlotsInput): ThumbnailSlotPlan[] {
  const {
    stripLength,
    assetWidth,
    assetHeight,
    assetDurationSec,
    inPointSec,
    clipDurationSec,
    clipWidthPx,
    clipHeightPx,
    clipLeftPx,
    scrollLeft,
    viewportWidth,
  } = input
  const overscan = input.overscanSlots ?? THUMB_OVERSCAN_SLOTS
  const hardCap = Math.max(1, input.hardCap ?? THUMB_HARD_CAP)

  if (stripLength <= 0 || clipWidthPx <= 0 || clipHeightPx <= 0) return []

  const aspect = assetWidth && assetHeight ? assetWidth / assetHeight : 16 / 9
  let frameW = Math.round(clipHeightPx * aspect)
  if (frameW <= 0) return []

  const { startPx, endPx } = clipLocalVisibleRange({
    clipLeftPx,
    clipWidthPx,
    scrollLeft,
    viewportWidth,
  })
  if (endPx <= startPx) return []

  const maxSlot = Math.max(0, Math.ceil(clipWidthPx / frameW))

  let first = Math.floor(startPx / frameW) - overscan
  let last = Math.ceil(endPx / frameW) + overscan
  first = Math.max(0, first)
  last = Math.min(maxSlot, last)

  let count = last - first + 1
  if (count <= 0) return []

  // Hard cap: widen slots so the visible window fits in ≤ hardCap images.
  if (count > hardCap) {
    const visibleW = Math.max(1, endPx - startPx)
    frameW = Math.max(frameW, Math.ceil(visibleW / hardCap))
    const maxSlot2 = Math.max(0, Math.ceil(clipWidthPx / frameW))
    first = Math.floor(startPx / frameW)
    last = Math.min(maxSlot2, first + hardCap - 1)
    first = Math.max(0, Math.min(first, maxSlot2))
    count = last - first + 1
  }

  const assetDur = Math.max(assetDurationSec, 1e-6)
  const clipDur = Math.max(clipDurationSec, 0)
  const plans: ThumbnailSlotPlan[] = []
  for (let i = 0; i < count; i++) {
    const slotIndex = first + i
    const leftPx = slotIndex * frameW
    if (leftPx >= clipWidthPx) break
    const srcSec = inPointSec + (leftPx / clipWidthPx) * clipDur
    const t = Math.max(0, Math.min(srcSec / assetDur, 1))
    const stripIdx = Math.round(t * (stripLength - 1))
    plans.push({
      slotIndex,
      leftPx,
      srcSec,
      stripIdx: Math.max(0, Math.min(stripLength - 1, stripIdx)),
      frameW,
    })
  }
  return plans
}
