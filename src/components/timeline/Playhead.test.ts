import { describe, expect, it } from 'vitest'

import { playheadDragSec, playheadEdgeScrollSpeed } from './Playhead'

describe('multi-hour playhead dragging', () => {
  it('adds horizontal auto-scroll distance to the dragged time', () => {
    expect(playheadDragSec(2_160, 1_900, 1_900, 0, 10_000, 1, 18_000)).toBe(12_160)
  })

  it('clamps dragging to the full timeline duration', () => {
    expect(playheadDragSec(17_000, 100, 2_000, 0, 10_000, 1, 18_000)).toBe(18_000)
    expect(playheadDragSec(10, 100, -2_000, 500, 0, 1, 18_000)).toBe(0)
  })

  it('scrolls in the direction of the viewport edge and stops in the center', () => {
    expect(playheadEdgeScrollSpeed(995, 0, 1_000)).toBeGreaterThan(0)
    expect(playheadEdgeScrollSpeed(5, 0, 1_000)).toBeLessThan(0)
    expect(playheadEdgeScrollSpeed(500, 0, 1_000)).toBe(0)
  })
})
