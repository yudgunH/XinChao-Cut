import { describe, expect, it } from 'vitest'

import { snapTimelineSecWithinLimits } from './timeline-snap'

describe('timeline edge snapping with limits', () => {
  it('snaps a speed-stretched edge to a nearby clip/playhead target', () => {
    expect(snapTimelineSecWithinLimits(9.95, [0, 10, 20], 100, 2, 16))
      .toEqual({ sec: 10, guideSec: 10 })
  })

  it('does not show a guide when a hard neighbour limit blocks the target', () => {
    expect(snapTimelineSecWithinLimits(9.95, [10], 100, 2, 9.9))
      .toEqual({ sec: 9.9, guideSec: null })
  })

  it('leaves an edge unsnapped outside the eight-pixel threshold', () => {
    expect(snapTimelineSecWithinLimits(9.8, [10], 100, 2, 16))
      .toEqual({ sec: 9.8, guideSec: null })
  })
})
