import { describe, expect, it } from 'vitest'

import { captionVisualStateKey } from './draw-caption'
import { makeDefaultTextData, makeDefaultTransform, type Clip } from './types'

const context = {} as CanvasRenderingContext2D

function captionClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'caption-1',
    assetId: null,
    trackId: 'text',
    startSec: 0,
    inPointSec: 0,
    outPointSec: 2,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: makeDefaultTransform(),
    textData: { ...makeDefaultTextData(), content: 'one two' },
    effects: [],
    ...overrides,
  }
}

describe('captionVisualStateKey', () => {
  it('keeps a static caption texture across frames', () => {
    const clip = captionClip()
    expect(captionVisualStateKey(context, clip, 608, 1080, 0.1)).toBe(
      captionVisualStateKey(context, clip, 608, 1080, 1.9),
    )
  })

  it('invalidates karaoke only at active-word boundaries', () => {
    const clip = captionClip({
      textData: {
        ...makeDefaultTextData(),
        content: 'one two',
        anim: { kind: 'karaoke', groupSize: 1 },
        wordTimestamps: [
          { word: 'one', startSec: 0, endSec: 1 },
          { word: 'two', startSec: 1, endSec: 2 },
        ],
      },
    })
    const firstA = captionVisualStateKey(context, clip, 608, 1080, 0.2)
    const firstB = captionVisualStateKey(context, clip, 608, 1080, 0.8)
    const second = captionVisualStateKey(context, clip, 608, 1080, 1.2)
    expect(firstA).toBe(firstB)
    expect(second).not.toBe(firstA)
  })

  it('invalidates when opacity animation changes visible pixels', () => {
    const clip = captionClip({
      keyframes: {
        opacity: [
          { t: 0, v: 0 },
          { t: 2, v: 1, ease: 'linear' },
        ],
      },
    })
    expect(captionVisualStateKey(context, clip, 608, 1080, 0.5)).not.toBe(
      captionVisualStateKey(context, clip, 608, 1080, 1.5),
    )
  })
})
