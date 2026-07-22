import { describe, expect, it } from 'vitest'

import {
  THUMB_HARD_CAP,
  clipLocalVisibleRange,
  planThumbnailSlots,
} from './thumbnail-virtualization'

/** Pre-S8 formula: one slot per frame width across the entire clip. */
function legacySlotCount(clipWidthPx: number, clipHeightPx: number, aspect = 16 / 9): number {
  const frameW = Math.round(clipHeightPx * aspect)
  if (frameW <= 0) return 0
  return Math.ceil(clipWidthPx / frameW) + 1
}

describe('clipLocalVisibleRange', () => {
  it('maps viewport intersection into clip-local px', () => {
    // Clip at 1000..5000, viewport 2000..3200 → local 1000..2200
    const r = clipLocalVisibleRange({
      clipLeftPx: 1000,
      clipWidthPx: 4000,
      scrollLeft: 2000,
      viewportWidth: 1200,
    })
    expect(r.startPx).toBe(1000)
    expect(r.endPx).toBe(2200)
  })

  it('returns empty when clip is fully left of viewport', () => {
    const r = clipLocalVisibleRange({
      clipLeftPx: 0,
      clipWidthPx: 500,
      scrollLeft: 1000,
      viewportWidth: 800,
    })
    expect(r.endPx).toBe(0)
  })

  it('clamps to clip bounds when viewport covers past the end', () => {
    const r = clipLocalVisibleRange({
      clipLeftPx: 0,
      clipWidthPx: 500,
      scrollLeft: 400,
      viewportWidth: 800,
    })
    expect(r.startPx).toBe(400)
    expect(r.endPx).toBe(500)
  })
})

describe('planThumbnailSlots (F08)', () => {
  const stripLen = 100

  it('multi-hour clip at high zoom only mounts bounded nodes (not thousands)', () => {
    // 4 hours @ 50 px/s = 720_000 px wide clip; viewport 1200 px.
    const clipWidthPx = 4 * 3600 * 50
    const legacy = legacySlotCount(clipWidthPx, 48)
    expect(legacy).toBeGreaterThan(5000)

    const slots = planThumbnailSlots({
      stripLength: stripLen,
      assetWidth: 1920,
      assetHeight: 1080,
      assetDurationSec: 4 * 3600,
      inPointSec: 0,
      clipDurationSec: 4 * 3600,
      clipWidthPx,
      clipHeightPx: 48,
      clipLeftPx: 0,
      scrollLeft: 10_000,
      viewportWidth: 1200,
    })
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.length).toBeLessThanOrEqual(THUMB_HARD_CAP)
    expect(slots.length).toBeLessThan(legacy / 50)
  })

  it('scroll shifts which slot indices are mounted but source time stays consistent', () => {
    const base = {
      stripLength: stripLen,
      assetWidth: 1920,
      assetHeight: 1080,
      assetDurationSec: 600,
      inPointSec: 10,
      clipDurationSec: 300,
      clipWidthPx: 300 * 40, // 12_000
      clipHeightPx: 48,
      clipLeftPx: 0,
      viewportWidth: 800,
    }
    const a = planThumbnailSlots({ ...base, scrollLeft: 0 })
    const b = planThumbnailSlots({ ...base, scrollLeft: 4000 })
    expect(a[0]!.slotIndex).toBeLessThan(b[0]!.slotIndex)
    // Same slotIndex → same srcSec / stripIdx regardless of scroll.
    const shared = a.find((s) => b.some((t) => t.slotIndex === s.slotIndex))
    if (shared) {
      const other = b.find((t) => t.slotIndex === shared.slotIndex)!
      expect(other.srcSec).toBeCloseTo(shared.srcSec, 6)
      expect(other.stripIdx).toBe(shared.stripIdx)
    }
    // Formula parity with pre-S8 for an arbitrary slot.
    const sample = b[Math.floor(b.length / 2)]!
    const expectedSrc =
      base.inPointSec + (sample.leftPx / base.clipWidthPx) * base.clipDurationSec
    expect(sample.srcSec).toBeCloseTo(expectedSrc, 6)
  })

  it('trim (inPoint / duration) moves strip index correctly', () => {
    const wide = planThumbnailSlots({
      stripLength: stripLen,
      assetWidth: 1920,
      assetHeight: 1080,
      assetDurationSec: 100,
      inPointSec: 0,
      clipDurationSec: 50,
      clipWidthPx: 2000,
      clipHeightPx: 48,
      clipLeftPx: 0,
      scrollLeft: 0,
      viewportWidth: 2000,
    })
    const trimmed = planThumbnailSlots({
      stripLength: stripLen,
      assetWidth: 1920,
      assetHeight: 1080,
      assetDurationSec: 100,
      inPointSec: 40,
      clipDurationSec: 20,
      clipWidthPx: 2000,
      clipHeightPx: 48,
      clipLeftPx: 0,
      scrollLeft: 0,
      viewportWidth: 2000,
    })
    // Same left edge of clip → different source times after trim.
    expect(trimmed[0]!.srcSec).toBeGreaterThan(wide[0]!.srcSec)
    expect(trimmed[0]!.stripIdx).toBeGreaterThan(wide[0]!.stripIdx)
  })

  it('hard cap holds even when viewport is huge', () => {
    const slots = planThumbnailSlots({
      stripLength: stripLen,
      assetWidth: 16,
      assetHeight: 9,
      assetDurationSec: 10_000,
      inPointSec: 0,
      clipDurationSec: 10_000,
      clipWidthPx: 1_000_000,
      clipHeightPx: 40,
      clipLeftPx: 0,
      scrollLeft: 0,
      viewportWidth: 1_000_000,
      hardCap: 48,
    })
    expect(slots.length).toBeLessThanOrEqual(48)
  })

  it('zoom change keeps srcSec formula on left edge of each slot', () => {
    // Doubling zoom doubles clip width; slot at same source fraction maps accordingly.
    const common = {
      stripLength: stripLen,
      assetWidth: 1920,
      assetHeight: 1080,
      assetDurationSec: 60,
      inPointSec: 5,
      clipDurationSec: 30,
      clipHeightPx: 48,
      clipLeftPx: 0,
      scrollLeft: 0,
      viewportWidth: 900,
    }
    const z1 = planThumbnailSlots({ ...common, clipWidthPx: 30 * 20 })
    const z2 = planThumbnailSlots({ ...common, clipWidthPx: 30 * 40 })
    expect(z1.length).toBeGreaterThan(0)
    expect(z2.length).toBeGreaterThan(0)
    // First visible slot starts near in-point for both.
    expect(z1[0]!.srcSec).toBeCloseTo(5, 0)
    expect(z2[0]!.srcSec).toBeCloseTo(5, 0)
  })

  it('off-screen clip plans zero slots', () => {
    const slots = planThumbnailSlots({
      stripLength: stripLen,
      assetWidth: 1920,
      assetHeight: 1080,
      assetDurationSec: 60,
      inPointSec: 0,
      clipDurationSec: 10,
      clipWidthPx: 500,
      clipHeightPx: 48,
      clipLeftPx: 0,
      scrollLeft: 10_000,
      viewportWidth: 800,
    })
    expect(slots).toEqual([])
  })
})
