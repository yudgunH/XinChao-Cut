import { describe, expect, it } from 'vitest'

import type { MediaAsset } from '@engine/media'
import type { Clip, Track } from '@engine/timeline'

import { conventionalVideoBitrateKbps, recommendedVideoBitrateKbps } from './bitrate'

const track = {
  id: 'v', kind: 'video', name: 'Video', muted: false, hidden: false, locked: false,
} as Track
const clip = { id: 'c', trackId: 'v', assetId: 'a' } as Clip

function asset(rateKbps: number): MediaAsset {
  const durationSec = 17_070
  return {
    id: 'a', kind: 'video', name: 'long.mp4', mimeType: 'video/mp4',
    sizeBytes: rateKbps * 1_000 * durationSec / 8,
    durationSec, storageKey: 'a', createdAt: 1,
  }
}

describe('conventionalVideoBitrateKbps', () => {
  it('keeps the full ceiling for a 16:9 landscape frame', () => {
    expect(conventionalVideoBitrateKbps(1920, 1080, 30)).toBe(8_000)
    expect(conventionalVideoBitrateKbps(1920, 1080, 60)).toBe(12_000)
  })

  it('scales the ceiling down by area for a vertical frame', () => {
    // 608x1080 vertical ≈ 32% of a 1920x1080 landscape's width → clamped to the
    // 0.35 floor → 8000 * 0.35 = 2800, not the full 8000.
    expect(conventionalVideoBitrateKbps(608, 1080, 30)).toBe(2_800)
  })

  it('never inflates a wider-than-16:9 frame above base', () => {
    expect(conventionalVideoBitrateKbps(2560, 1080, 30)).toBe(8_000)
  })
})

describe('recommendedVideoBitrateKbps', () => {
  it('does not inflate a long low-bitrate source to the fixed 8 Mbps ceiling', () => {
    expect(recommendedVideoBitrateKbps({
      width: 1920, height: 1080, fps: 30, assets: [asset(1_370)], clips: [clip], tracks: [track],
    })).toBe(1_713)
  })

  it('uses the conventional ceiling for missing metadata and high-rate sources', () => {
    expect(recommendedVideoBitrateKbps({
      width: 1920, height: 1080, fps: 30, assets: [], clips: [clip], tracks: [track],
    })).toBe(8_000)
    expect(recommendedVideoBitrateKbps({
      width: 1920, height: 1080, fps: 30, assets: [asset(20_000)], clips: [clip], tracks: [track],
    })).toBe(8_000)
  })

  it('caps a vertical export at its area-scaled ceiling for a high-rate source', () => {
    // High-rate source would push above 8000, but the vertical ceiling (2800)
    // now bounds it instead of the full-landscape 8000.
    expect(recommendedVideoBitrateKbps({
      width: 608, height: 1080, fps: 30, assets: [asset(20_000)], clips: [clip], tracks: [track],
    })).toBe(2_800)
  })
})
