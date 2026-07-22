import { describe, expect, it } from 'vitest'

import { makeDefaultAdjust, makeDefaultTransform, type Clip, type Track } from './types'
import { computeRipplePreview, prepareRipplePreview, type RipplePreviewStats } from './ripple-preview'

function clip(id: string, trackId: string, startSec: number, duration = 1): Clip {
  return {
    id,
    trackId,
    assetId: 'asset',
    startSec,
    inPointSec: 0,
    outPointSec: duration,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
  }
}

const tracks: Track[] = [
  { id: 'main', kind: 'video', name: 'Main', muted: false, locked: false },
  { id: 'text', kind: 'text', name: 'Text', muted: false, locked: false },
  { id: 'audio', kind: 'audio', name: 'Audio', muted: false, locked: false },
]

describe('ripple preview index', () => {
  it('moves linked captions with their precomputed main clip owner', () => {
    const context = prepareRipplePreview([
      clip('m0', 'main', 0),
      clip('drag', 'main', 1),
      clip('m2', 'main', 2),
      clip('caption', 'text', 2.1, 0.5),
      clip('sound', 'audio', 2.1, 0.5),
    ], tracks, 'main', ['drag'], true)!

    const preview = computeRipplePreview(context, 2)
    expect(preview?.m2).toBe(1)
    expect(preview?.caption).toBeCloseTo(1.1)
    expect(preview?.sound).toBeUndefined()
    expect(computeRipplePreview(context, 2.2)).toBe(preview)
  })

  it('builds linkage near-linearly instead of checking every caption against every main clip', () => {
    const main = Array.from({ length: 1_000 }, (_, index) => clip(`m${index}`, 'main', index))
    const captions = Array.from({ length: 10_000 }, (_, index) =>
      clip(`t${index}`, 'text', Math.floor(index / 10) + 0.1, 0.2),
    )
    const stats: RipplePreviewStats = { overlapChecks: 0 }

    const context = prepareRipplePreview(
      [...main, ...captions],
      tracks,
      'main',
      ['m999'],
      true,
      stats,
    )

    expect(context).not.toBeNull()
    expect(stats.overlapChecks).toBeLessThan(12_000)
  })
})
