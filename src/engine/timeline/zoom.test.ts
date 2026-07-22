import { describe, expect, it } from 'vitest'

import {
  MAX_SAFE_TIMELINE_WIDTH_PX,
  clampTimelineZoom,
  fitTimelineZoom,
  maxSafeTimelineZoom,
} from './zoom'

describe('timeline zoom for arbitrarily long media', () => {
  it('fits a five-hour video inside a normal viewport', () => {
    expect(fitTimelineZoom(5 * 3600, 2_000)).toBeCloseTo(0.1)
  })

  it('caps high zoom before Chromium layout width becomes unsafe', () => {
    const duration = 48 * 3600
    const zoom = maxSafeTimelineZoom(duration)
    expect(duration * zoom).toBeLessThanOrEqual(MAX_SAFE_TIMELINE_WIDTH_PX)
    expect(clampTimelineZoom(400, duration)).toBe(zoom)
  })
})
