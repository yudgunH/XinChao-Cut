import { describe, expect, it } from 'vitest'

import type { Clip, Track } from '@engine/timeline'
import { AudioScheduleIndex } from './schedule-index'

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
