import { describe, expect, it } from 'vitest'

import type { ProjectSnapshot } from '@engine/persistence'

import { countAssetReferences } from './audio-library-delete'

function snapshot(): ProjectSnapshot {
  return {
    id: 'p1',
    version: 1,
    name: 'Project',
    fps: 30,
    width: 1920,
    height: 1080,
    aspect: '16:9',
    tracks: [],
    clips: [{ id: 'root', assetId: 'music', trackId: 'a', startSec: 0, inPointSec: 0, outPointSec: 1 }],
    compounds: {
      nested: {
        name: 'Nested',
        timeline: {
          fps: 30,
          durationSec: 1,
          tracks: [],
          clips: [{ id: 'child', assetId: 'music', trackId: 'a', startSec: 0, inPointSec: 0, outPointSec: 1 }],
        },
      },
    },
    assetIds: ['music'],
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('countAssetReferences', () => {
  it('counts root and compound references', () => {
    expect(countAssetReferences(snapshot(), 'music')).toBe(2)
    expect(countAssetReferences(snapshot(), 'other')).toBe(0)
  })
})
