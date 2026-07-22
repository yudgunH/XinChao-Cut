import { describe, expect, it } from 'vitest'

import { makeDefaultAdjust, makeDefaultTransform, type Clip } from '@engine/timeline'
import { patchClipById, patchClipsById } from './clip-patch'

function clips(count: number): Clip[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    trackId: 'v1',
    assetId: 'a',
    kind: 'video',
    startSec: i,
    inPointSec: 0,
    outPointSec: 1,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
  }))
}

describe('clip patch helpers', () => {
  it('replaces one position and preserves every other clip reference', () => {
    const before = clips(10_000)
    const after = patchClipById(before, 'c9000', (clip) => ({ ...clip, opacity: 0.5 }))
    expect(after).not.toBe(before)
    expect(after[9000]!.opacity).toBe(0.5)
    expect(after[8999]).toBe(before[8999])
  })

  it('returns the same array for missing ids and no-op patches', () => {
    const before = clips(3)
    expect(patchClipById(before, 'missing', (clip) => ({ ...clip }))).toBe(before)
    expect(patchClipById(before, 'c1', (clip) => clip)).toBe(before)
  })

  it('multi-patch clones once and carries the index to the next revision', () => {
    const before = clips(10_000)
    const first = patchClipsById(before, ['c5', 'c9999'], (clip) => ({ ...clip, volume: 0.2 }))
    const second = patchClipById(first, 'c9999', (clip) => ({ ...clip, volume: 0.3 }))
    expect(first[5]!.volume).toBe(0.2)
    expect(second[9999]!.volume).toBe(0.3)
    expect(second[5]).toBe(first[5])
  })

  it('patches only requested ids instead of scanning every clip for every id', () => {
    const before = clips(10_000)
    let patchCalls = 0
    const after = patchClipsById(before, ['c5', 'c9999'], (clip) => {
      patchCalls += 1
      return { ...clip, opacity: 0.25 }
    })

    expect(patchCalls).toBe(2)
    expect(after[5]!.opacity).toBe(0.25)
    expect(after[9999]!.opacity).toBe(0.25)
  })
})
