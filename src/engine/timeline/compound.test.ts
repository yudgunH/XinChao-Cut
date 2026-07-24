import { describe, expect, it } from 'vitest'

import {
  compoundWindowPeaks,
  flattenCompounds,
  makeDefaultAdjust,
  makeDefaultTransform,
  type Clip,
  type TimelineState,
  type Track,
} from './index'

const videoTrack: Track = { id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked: false }

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    assetId: 'asset',
    trackId: 'v1',
    startSec: 0,
    inPointSec: 0,
    outPointSec: 4,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
    ...over,
  }
}

function timeline(clips: Clip[]): TimelineState {
  return { tracks: [videoTrack], clips, durationSec: 4, fps: 30 }
}

describe('flattenCompounds', () => {
  it('composes child waveforms for a compound window', () => {
    const audio: Track = {
      id: 'a1',
      kind: 'audio',
      name: 'Audio',
      muted: false,
      locked: false,
    }
    const child = clip({
      id: 'audio-child',
      trackId: 'a1',
      assetId: 'song',
      startSec: 2,
      outPointSec: 4,
      volume: 0.5,
    })
    const sub: TimelineState = { tracks: [audio], clips: [child], durationSec: 4, fps: 30 }
    const peaks = compoundWindowPeaks(
      sub,
      1,
      4,
      new Map([['song', { durationSec: 4, waveformPeaks: [0.2, 0.8, 0.4, 0.6] }]]),
      16,
    )
    expect(peaks).toHaveLength(16)
    expect(Math.max(...peaks)).toBeGreaterThan(0.35)
    expect(peaks.slice(0, 2).every((value) => value === 0)).toBe(true)
  })

  it('composes a compound transform onto its child clips', () => {
    const parent = clip({
      id: 'parent',
      assetId: null,
      compoundId: 'compound-1',
      transform: { ...makeDefaultTransform(), x: 0.6, scale: 2, rotation: 0 },
    })
    const child = clip({
      id: 'child',
      transform: { ...makeDefaultTransform(), x: 0.25, scale: 1.5 },
    })

    const flat = flattenCompounds(timeline([parent]), {
      'compound-1': { timeline: timeline([child]) },
    })
    const flattenedChild = flat.clips[0]!

    expect(flattenedChild.id).toBe('parent::child')
    expect(flattenedChild.transform.x).toBeCloseTo(0.1)
    expect(flattenedChild.transform.scale).toBeCloseTo(3)
  })

  it('composes the compound colour adjust onto its child clips', () => {
    const parent = clip({
      id: 'parent', assetId: null, compoundId: 'compound-1',
      adjust: { brightness: 50, contrast: 0, saturation: 0 },
    })
    const child = clip({ id: 'child', adjust: { brightness: 0, contrast: 20, saturation: 0 } })

    const flat = flattenCompounds(timeline([parent]), {
      'compound-1': { timeline: timeline([child]) },
    })
    const adj = flat.clips[0]!.adjust

    // neutral side leaves the other exactly unchanged; brightness stacks as filters
    expect(adj.brightness).toBeCloseTo(50)   // 50 parent × neutral child
    expect(adj.contrast).toBeCloseTo(20)     // neutral parent × 20 child
  })

  it('bakes a compound zoom-in effect into child scale keyframes', () => {
    const parent = clip({
      id: 'parent', assetId: null, compoundId: 'cmp', startSec: 0, inPointSec: 0, outPointSec: 4,
      effects: [{ id: 'z', type: 'zoom-in', params: { amount: 0.5 } }],
    })
    const child = clip({ id: 'child' })
    const flat = flattenCompounds(timeline([parent]), { cmp: { timeline: timeline([child]) } })
    const scaleKf = flat.clips[0]!.keyframes?.scale ?? []
    expect(scaleKf.length).toBeGreaterThan(5)             // dense grid baked
    expect(scaleKf[0]!.v).toBeCloseTo(1)                  // zoom-in starts at 1x
    expect(scaleKf[scaleKf.length - 1]!.v).toBeCloseTo(1.5) // ends at 1 + amount
  })

  it('bakes a compound fade-out into descending child opacity keyframes', () => {
    const parent = clip({
      id: 'parent', assetId: null, compoundId: 'cmp', startSec: 0, inPointSec: 0, outPointSec: 4,
      effects: [{ id: 'f', type: 'fade-out', params: { duration: 1 } }],
    })
    const child = clip({ id: 'child' })
    const flat = flattenCompounds(timeline([parent]), { cmp: { timeline: timeline([child]) } })
    const opKf = flat.clips[0]!.keyframes?.opacity ?? []
    expect(opKf.length).toBeGreaterThan(3)
    expect(opKf[0]!.v).toBeCloseTo(1)                     // fully visible at start
    expect(opKf[opKf.length - 1]!.v).toBeCloseTo(0)       // faded out at the end
  })

  it('folds a centred compound crop into a 2x child scale', () => {
    const parent = clip({
      id: 'parent', assetId: null, compoundId: 'cmp',
      transform: { ...makeDefaultTransform(), crop: { l: 0.25, r: 0.25, t: 0, b: 0 } },
    })
    const child = clip({ id: 'child' })
    const flat = flattenCompounds(timeline([parent]), { cmp: { timeline: timeline([child]) } })
    const tr = flat.clips[0]!.transform
    expect(tr.scaleX).toBeCloseTo(2)   // 1/(1-0.25-0.25)
    expect(tr.x).toBeCloseTo(0.5)      // centred crop stays centred
  })

  it('splitting a compound windows each half to a different slice (no duplication)', () => {
    // One 10s video inside the compound; split at compound-time 4 → two halves.
    const child = clip({ id: 'child', inPointSec: 0, outPointSec: 10, startSec: 0 })
    const compounds = { 'cmp': { timeline: timeline([child]) } }
    const left = clip({
      id: 'L', assetId: null, compoundId: 'cmp', startSec: 20, inPointSec: 0, outPointSec: 4,
    })
    const right = clip({
      id: 'R', assetId: null, compoundId: 'cmp', startSec: 24, inPointSec: 4, outPointSec: 10,
    })

    const flat = flattenCompounds(timeline([left, right]), compounds)
    const lc = flat.clips.find((c) => c.id === 'L::child')!
    const rc = flat.clips.find((c) => c.id === 'R::child')!

    // Left plays source [0,4] at [20,24]; right plays source [4,10] at [24,30].
    expect([lc.inPointSec, lc.outPointSec]).toEqual([0, 4])
    expect(lc.startSec).toBeCloseTo(20)
    expect([rc.inPointSec, rc.outPointSec]).toEqual([4, 10])
    expect(rc.startSec).toBeCloseTo(24)
  })

  it('turns compound keyframes into child keyframes in flat timeline time', () => {
    const parent = clip({
      id: 'parent',
      assetId: null,
      compoundId: 'compound-1',
      keyframes: {
        x: [
          { t: 0, v: 0.5, ease: 'linear' },
          { t: 2, v: 0.7, ease: 'linear' },
        ],
      },
    })
    const child = clip({ id: 'child' })

    const flat = flattenCompounds(timeline([parent]), {
      'compound-1': { timeline: timeline([child]) },
    })
    const xKeyframes = flat.clips[0]!.keyframes?.x ?? []

    expect(xKeyframes.map((keyframe) => keyframe.t)).toEqual([0, 2, 4])
    expect(xKeyframes[0]!.v).toBeCloseTo(0.5)
    expect(xKeyframes[1]!.v).toBeCloseTo(0.7)
    expect(xKeyframes[2]!.v).toBeCloseTo(0.7)
  })
})
