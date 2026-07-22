import { describe, it, expect } from 'vitest'

import type { Clip } from './types'

import {
  captionClipIdsOnTrack,
  clipEffectiveDuration,
  clipSourceSec,
  clipIsActiveAt,
  isCaptionClip,
  filterParams,
  filterToCanvas,
} from './index'

describe('look filters', () => {
  it('scales preset deltas by intensity', () => {
    const full = filterParams({ type: 'filter', filter: '4k', intensity: 1 })
    expect(full).toMatchObject({ contrast: 20, saturation: 24, sharpen: 0.8 })
    const half = filterParams({ type: 'filter', filter: '4k', intensity: 0.5 })
    expect(half.saturation).toBeCloseTo(12)
  })

  it('builds a CSS filter string; B&W fully desaturates', () => {
    expect(filterToCanvas({ type: 'filter', filter: '4k', intensity: 1 }))
      .toBe('brightness(1.040) contrast(1.200) saturate(1.240)')
    expect(filterToCanvas({ type: 'filter', filter: 'bw', intensity: 1 }))
      .toContain('saturate(0.000)')
    expect(filterToCanvas({ type: 'filter', filter: 'warm', intensity: 1 }))
      .toContain('hue-rotate(-10.0deg)')
  })
})

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    assetId: 'a1',
    kind: 'video',
    startSec: 0,
    inPointSec: 0,
    outPointSec: 6,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: { scale: 1, scaleX: 1, scaleY: 1, x: 0.5, y: 0.5, rotation: 0 },
    effects: [],
    ...over,
  } as Clip
}

describe('clipEffectiveDuration', () => {
  it('is source length at speed 1', () => {
    expect(clipEffectiveDuration(clip({ inPointSec: 1, outPointSec: 7 }))).toBe(6)
  })

  it('shrinks with higher speed', () => {
    expect(clipEffectiveDuration(clip({ outPointSec: 6, speed: 2 }))).toBe(3)
  })

  it('clamps non-positive speed to avoid divide-by-zero', () => {
    expect(Number.isFinite(clipEffectiveDuration(clip({ speed: 0 })))).toBe(true)
  })
})

describe('clipSourceSec', () => {
  it('maps a timeline time back to a source time accounting for speed', () => {
    // clip starts at 10s on the timeline, 2x speed → 1s of timeline = 2s of source.
    const c = clip({ startSec: 10, inPointSec: 4, speed: 2 })
    expect(clipSourceSec(c, 10)).toBe(4)
    expect(clipSourceSec(c, 11)).toBe(6)
  })
})

describe('clipIsActiveAt', () => {
  const c = clip({ startSec: 2, inPointSec: 0, outPointSec: 4, speed: 1 }) // active [2,6)
  it('is active inside its span', () => {
    expect(clipIsActiveAt(c, 2)).toBe(true)
    expect(clipIsActiveAt(c, 5.9)).toBe(true)
  })
  it('is inactive at/after the end and before the start', () => {
    expect(clipIsActiveAt(c, 6)).toBe(false)
    expect(clipIsActiveAt(c, 1.99)).toBe(false)
  })
})

describe('isCaptionClip', () => {
  it('treats word-timed or stroked text as a caption', () => {
    const captioned = clip({
      kind: 'text',
      textData: { wordTimestamps: [{ word: 'hi', startSec: 0, endSec: 0.3 }] },
    } as unknown as Partial<Clip>)
    expect(isCaptionClip(captioned)).toBe(true)
  })
  it('plain text without timing/stroke is not a caption', () => {
    const plain = clip({ kind: 'text', textData: { content: 'Title' } } as unknown as Partial<Clip>)
    expect(isCaptionClip(plain)).toBe(false)
  })
  it('a video clip is never a caption', () => {
    expect(isCaptionClip(clip())).toBe(false)
  })
})

describe('captionClipIdsOnTrack', () => {
  it('returns caption ids only from the requested text track', () => {
    const original = clip({
      id: 'original',
      trackId: 't1',
      kind: 'text',
      textData: { content: 'Hallo', stroke: { color: '#000', width: 6 } },
    } as unknown as Partial<Clip>)
    const translated = clip({
      id: 'translated',
      trackId: 't2',
      kind: 'text',
      textData: { content: 'Hello', stroke: { color: '#000', width: 6 } },
    } as unknown as Partial<Clip>)
    const title = clip({
      id: 'title',
      trackId: 't1',
      kind: 'text',
      textData: { content: 'Title' },
    } as unknown as Partial<Clip>)

    expect(captionClipIdsOnTrack([original, translated, title], 't1')).toEqual(['original'])
    expect(captionClipIdsOnTrack([original, translated, title], 't2')).toEqual(['translated'])
  })
})
