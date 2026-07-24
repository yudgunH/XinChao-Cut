import { describe, expect, it } from 'vitest'

import type { Clip, Track } from '@engine/timeline'
import { AudioScheduleIndex, coalesceContinuousAudioClips } from './schedule-index'

const track = {
  id: 'audio', kind: 'audio', name: 'Audio', muted: false, locked: false,
} as Track

function clip(index: number): Clip {
  return {
    id: `c-${String(index).padStart(5, '0')}`,
    assetId: `a-${index}`,
    trackId: 'audio',
    startSec: index,
    inPointSec: 0,
    outPointSec: 1,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
    effects: [],
  }
}

describe('AudioScheduleIndex complexity', () => {
  it('keeps source-continuous split pieces on one decoder chain', () => {
    const pieces = [0, 1, 2].map((index) => ({
      ...clip(index),
      assetId: 'same-source',
      startSec: index,
      inPointSec: index,
      outPointSec: index + 1,
    }))
    const chained = coalesceContinuousAudioClips(pieces)
    expect(chained).toHaveLength(1)
    expect(chained[0]).toMatchObject({
      id: pieces[0]!.id,
      startSec: 0,
      inPointSec: 0,
      outPointSec: 3,
    })
  })

  it('does not chain a real source jump or volume change', () => {
    const first = { ...clip(0), assetId: 'same-source' }
    const sourceJump = { ...clip(1), assetId: 'same-source', inPointSec: 3, outPointSec: 4 }
    const volumeChange = {
      ...clip(2),
      assetId: 'same-source',
      inPointSec: 4,
      outPointSec: 5,
      volume: 0.5,
    }
    expect(coalesceContinuousAudioClips([first, sourceJump, volumeChange])).toHaveLength(3)
  })

  it('examines 10k clips once across repeated horizon pumps', () => {
    const clips = Array.from({ length: 10_000 }, (_, index) => clip(index))
    const index = new AudioScheduleIndex(clips, [track])
    for (let at = 0; at < 10_000; at += 10) {
      const pending = index.advance(at, at + 20)
      for (const item of pending) index.remove(item.id)
      index.advance(at, at + 20)
    }
    expect(index.getExaminedCount()).toBe(10_000)
  })
})
