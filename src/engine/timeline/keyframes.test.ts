import { describe, it, expect } from 'vitest'

import {
  interpKeyframes,
  resolveClipTransformAt,
  resolveClipOpacityAt,
  currentKeyframeValue,
  makeDefaultTransform,
  makeDefaultAdjust,
  type Clip,
  type Keyframe,
} from './index'

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c', assetId: 'a', trackId: 'v1', startSec: 0, inPointSec: 0, outPointSec: 10,
    speed: 1, opacity: 1, volume: 1,
    adjust: makeDefaultAdjust(), transform: makeDefaultTransform(), effects: [],
    ...over,
  } as Clip
}

describe('interpKeyframes', () => {
  const lin: Keyframe[] = [
    { t: 0, v: 0, ease: 'linear' },
    { t: 10, v: 100, ease: 'linear' },
  ]

  it('holds the endpoints outside the range', () => {
    expect(interpKeyframes(lin, -5)).toBe(0)
    expect(interpKeyframes(lin, 0)).toBe(0)
    expect(interpKeyframes(lin, 10)).toBe(100)
    expect(interpKeyframes(lin, 99)).toBe(100)
  })

  it('lerps linearly between linear keyframes', () => {
    expect(interpKeyframes(lin, 5)).toBeCloseTo(50)
    expect(interpKeyframes(lin, 2.5)).toBeCloseTo(25)
  })

  it('eases (default easeInOut) slower at the segment start', () => {
    const ease: Keyframe[] = [{ t: 0, v: 0 }, { t: 10, v: 100 }]
    expect(interpKeyframes(ease, 5)).toBeCloseTo(50) // smoothstep(0.5) = 0.5
    expect(interpKeyframes(ease, 2.5)).toBeLessThan(25) // eased in
  })
})

describe('resolve with keyframes (clip-local time, static field ignored)', () => {
  it('animates opacity across the clip', () => {
    const c = clip({
      startSec: 4,
      opacity: 1,
      keyframes: { opacity: [{ t: 0, v: 1, ease: 'linear' }, { t: 2, v: 0, ease: 'linear' }] },
    })
    expect(resolveClipOpacityAt(c, 4)).toBeCloseTo(1) // local 0
    expect(resolveClipOpacityAt(c, 5)).toBeCloseTo(0.5) // local 1
    expect(resolveClipOpacityAt(c, 6)).toBeCloseTo(0) // local 2
  })

  it('animates position and overrides the static transform value', () => {
    const c = clip({
      transform: { ...makeDefaultTransform(), x: 0.9 },
      keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 10, v: 1, ease: 'linear' }] },
    })
    expect(resolveClipTransformAt(c, 0).x).toBeCloseTo(0) // keyframe wins over 0.9
    expect(resolveClipTransformAt(c, 5).x).toBeCloseTo(0.5)
  })

  it('currentKeyframeValue reads the interpolated value, else the static base', () => {
    const animated = clip({ keyframes: { rotation: [{ t: 0, v: 0 }, { t: 10, v: 90 }] } })
    expect(currentKeyframeValue(animated, 'rotation', 5)).toBeCloseTo(45)
    const stat = clip({ transform: { ...makeDefaultTransform(), scale: 1.5 } })
    expect(currentKeyframeValue(stat, 'scale', 3)).toBeCloseTo(1.5)
  })
})

describe('clip effects', () => {
  it('applies motion effects on top of the resolved transform', () => {
    const panned = clip({ effects: [{ id: 'e1', type: 'pan-right', params: { amount: 0.2 } }] })
    expect(resolveClipTransformAt(panned, 0).x).toBeLessThan(0.5)
    expect(resolveClipTransformAt(panned, 10).x).toBeGreaterThan(0.5)

    const pulse = clip({ effects: [{ id: 'e2', type: 'pulse', params: { amount: 0.4 } }] })
    expect(resolveClipTransformAt(pulse, 5).scale).toBeGreaterThan(resolveClipTransformAt(pulse, 0).scale)
  })

  it('slides transitions while fading the clip in and out', () => {
    const slideIn = clip({
      effects: [{ id: 'e1', type: 'slide-in-left', params: { duration: 1 } }],
    })
    expect(resolveClipTransformAt(slideIn, 0).x).toBeLessThan(0)
    expect(resolveClipTransformAt(slideIn, 1).x).toBeCloseTo(0.5)
    expect(resolveClipOpacityAt(slideIn, 0)).toBeCloseTo(0)
    expect(resolveClipOpacityAt(slideIn, 1)).toBeCloseTo(1)

    const dropOut = clip({
      effects: [{ id: 'e2', type: 'drop-out', params: { duration: 1 } }],
    })
    expect(resolveClipTransformAt(dropOut, 9).y).toBeCloseTo(0.5)
    expect(resolveClipTransformAt(dropOut, 10).y).toBeGreaterThan(0.5)
    expect(resolveClipOpacityAt(dropOut, 10)).toBeCloseTo(0)
  })
})
