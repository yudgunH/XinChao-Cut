import { describe, expect, it } from 'vitest'

import {
  makeDefaultAdjust,
  makeDefaultTransform,
  type Clip,
  type Track,
} from '@engine/timeline'

import {
  buildRenderPlan,
  resolveRenderPlanDraws,
  type RenderPlanSourceInfo,
} from './render-plan'

function clip(overrides: Partial<Clip>): Clip {
  return {
    id: 'clip',
    assetId: 'asset',
    trackId: 'video',
    startSec: 0,
    inPointSec: 0,
    outPointSec: 10,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
    ...overrides,
  }
}

const tracks: Track[] = [
  { id: 'video', kind: 'video', name: 'Video', muted: false, locked: false },
  { id: 'text', kind: 'text', name: 'Text', muted: false, locked: false },
  { id: 'fx', kind: 'fx', name: 'FX', muted: false, locked: false },
]

function sourceMap(entries: Array<[string, RenderPlanSourceInfo]>) {
  return new Map(entries)
}

describe('buildRenderPlan', () => {
  it('produces a stable plan for crop/rotation, PiP occurrences, blur fill, and captions', () => {
    const primary = clip({
      id: 'primary',
      opacity: 0.75,
      adjust: { brightness: 10, contrast: -20, saturation: 30 },
      transform: {
        x: 0.4,
        y: 0.6,
        scale: 1.2,
        scaleX: 0.8,
        scaleY: 1.1,
        rotation: 90,
        flipH: true,
        flipV: false,
        crop: { l: 0.1, r: 0.2, t: 0.05, b: 0.15 },
      },
      canvasFill: { mode: 'blur', blurPx: 40, scale: 1.2, opacity: 0.5 },
    })
    const pip = clip({
      id: 'pip',
      transform: { ...makeDefaultTransform(), x: 0.8, y: 0.2, scale: 0.3 },
    })
    const caption = clip({ id: 'caption', assetId: null, trackId: 'text' })
    const plan = buildRenderPlan({
      mediaClips: [primary, pip],
      captionClips: [caption],
      fxClips: [],
      tracks,
      outputWidth: 1080,
      outputHeight: 1920,
      timelineSec: 2,
      overlayFrameVersion: 60,
      sources: sourceMap([
        ['primary', { sourceW: 1920, sourceH: 1080, frameVersion: 10 }],
        ['pip', { sourceW: 1920, sourceH: 1080, frameVersion: 20 }],
      ]),
    })

    expect({
      mediaDraws: plan.mediaDraws,
      captionIds: plan.captionClips.map((item) => item.id),
      fxIds: plan.fxClips.map((item) => item.id),
      captionOverlayDraw: plan.captionOverlayDraw,
    }).toMatchInlineSnapshot(`
      {
        "captionIds": [
          "caption",
        ],
        "captionOverlayDraw": {
          "adjust": {
            "b": 1,
            "c": 1,
            "s": 1,
          },
          "assetId": "__xinchao_caption_overlay__",
          "clipId": "__xinchao_caption_overlay__",
          "flipH": false,
          "flipV": false,
          "frameVersion": 60,
          "opacity": 1,
          "rect": {
            "h": 1920,
            "w": 1080,
            "x": 0,
            "y": 0,
          },
          "rotationRad": 0,
          "sourceH": 1920,
          "sourceW": 1080,
          "uv": {
            "u0": 0,
            "u1": 1,
            "v0": 0,
            "v1": 1,
          },
        },
        "fxIds": [],
        "mediaDraws": [
          {
            "adjust": {
              "b": 1.1,
              "c": 0.8,
              "s": 1.3,
            },
            "assetId": "asset",
            "blurFill": {
              "extraScale": 1.2,
              "opacity": 0.375,
              "sigma": 106.66666666666666,
            },
            "cacheKey": "asset",
            "clipId": "primary",
            "flipH": true,
            "flipV": false,
            "frameVersion": 10,
            "opacity": 0.75,
            "rect": {
              "h": 916.4571428571428,
              "w": 1036.8,
              "x": -86.39999999999998,
              "y": 693.7714285714286,
            },
            "rotationRad": 1.5707963267948966,
            "sourceH": 1080,
            "sourceW": 1920,
            "uv": {
              "u0": 0.1,
              "u1": 0.8,
              "v0": 0.05,
              "v1": 0.85,
            },
          },
          {
            "adjust": {
              "b": 1,
              "c": 1,
              "s": 1,
            },
            "assetId": "asset",
            "blurFill": undefined,
            "cacheKey": "asset#1",
            "clipId": "pip",
            "flipH": false,
            "flipV": false,
            "frameVersion": 20,
            "opacity": 1,
            "rect": {
              "h": 182.24999999999997,
              "w": 323.99999999999994,
              "x": 702,
              "y": 292.875,
            },
            "rotationRad": 0,
            "sourceH": 1080,
            "sourceW": 1920,
            "uv": {
              "u0": 0,
              "u1": 1,
              "v0": 0,
              "v1": 1,
            },
          },
        ],
      }
    `)
  })

  it('disables the GPU caption overlay when an fx clip is active', () => {
    const caption = clip({ id: 'caption', assetId: null, trackId: 'text' })
    const fx = clip({ id: 'filter', assetId: null, trackId: 'fx' })
    const plan = buildRenderPlan({
      mediaClips: [],
      captionClips: [caption],
      fxClips: [fx],
      tracks,
      outputWidth: 1080,
      outputHeight: 1920,
      timelineSec: 1,
      overlayFrameVersion: 30,
      sources: new Map(),
    })

    expect(plan.captionClips.map((item) => item.id)).toEqual(['caption'])
    expect(plan.fxClips.map((item) => item.id)).toEqual(['filter'])
    expect(plan.captionOverlayDraw).toBeUndefined()
  })

  it('materializes descriptors only when the caller resolves a source', () => {
    const media = clip({ id: 'media' })
    const plan = buildRenderPlan({
      mediaClips: [media],
      captionClips: [],
      fxClips: [],
      tracks,
      outputWidth: 100,
      outputHeight: 100,
      timelineSec: 0,
      overlayFrameVersion: 0,
      sources: sourceMap([
        ['media', { sourceW: 100, sourceH: 100, frameVersion: 1 }],
      ]),
    })
    const source = {} as ImageBitmap
    expect(resolveRenderPlanDraws(plan.mediaDraws, () => source)).toEqual([
      expect.objectContaining({ assetId: 'asset', source }),
    ])
    expect(resolveRenderPlanDraws(plan.mediaDraws, () => null)).toEqual([])
  })
})
