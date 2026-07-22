import { describe, expect, it } from 'vitest'

import { getTimelineTickConfig } from './TimelineRuler'

describe('timeline ruler for very long media', () => {
  it('keeps tick density bounded below one pixel per second', () => {
    const zoom = 0.0001
    const viewportWidth = 2_000
    const { minorSec, majorSec } = getTimelineTickConfig(zoom)
    expect(majorSec * zoom).toBeGreaterThanOrEqual(120)
    expect(viewportWidth / (minorSec * zoom)).toBeLessThan(100)
  })

  it('preserves familiar intervals for ordinary editor zoom', () => {
    expect(getTimelineTickConfig(1).majorSec).toBe(120)
    expect(getTimelineTickConfig(80).majorSec).toBe(2)
  })
})
