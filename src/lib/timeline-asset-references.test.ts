import { describe, expect, it } from 'vitest'

import {
  countTimelineAssetReferences,
  countTimelineAssetReferencesMany,
} from './timeline-asset-references'

describe('countTimelineAssetReferences', () => {
  it('counts the root and every compound timeline', () => {
    expect(countTimelineAssetReferences(
      { clips: [{ assetId: 'a' }, { assetId: 'other' }] },
      {
        one: { timeline: { clips: [{ assetId: 'a' }] } },
        two: { timeline: { clips: [{ assetId: 'a' }, { assetId: null }] } },
      },
      'a',
    )).toBe(3)
  })

  it('counts a large selection in one pass with the same root/compound semantics', () => {
    const counts = countTimelineAssetReferencesMany(
      { clips: [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'a' }] },
      {
        one: { timeline: { clips: [{ assetId: 'b' }, { assetId: 'ignored' }] } },
        two: { timeline: { clips: [{ assetId: 'c' }, { assetId: null }] } },
      },
      ['a', 'b', 'c', 'unused'],
    )
    expect(Object.fromEntries(counts)).toEqual({ a: 2, b: 2, c: 1 })
    expect(counts.get('unused') ?? 0).toBe(0)
  })
})
