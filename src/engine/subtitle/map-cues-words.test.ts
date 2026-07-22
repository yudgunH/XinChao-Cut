/**
 * #18: trim/split/speed must filter + shift word timestamps (no karaoke drift/repeat).
 */
import { describe, expect, it } from 'vitest'

import type { Clip } from '@engine/timeline'
import {
  mapCuesToTimeline,
  mapSegmentedCuesToTimeline,
  remapCueWordsForRange,
} from './transcribe'

function clip(partial: Partial<Clip> & { id: string }): Clip {
  return {
    trackId: 'v1',
    assetId: 'a1',
    startSec: 0,
    inPointSec: 0,
    outPointSec: 10,
    speed: 1,
    effects: [],
    muted: false,
    ...partial,
  } as Clip
}

describe('remapCueWordsForRange', () => {
  const words = [
    { word: 'hello', startSec: 0, endSec: 0.4 },
    { word: 'world', startSec: 0.5, endSec: 1.0 },
    { word: 'again', startSec: 1.1, endSec: 1.5 },
  ]

  it('drops words outside the remaining absolute range', () => {
    // Cue at 0..2, keep only source window 0.6..1.4 → only "world" fully/partially in
    const mapped = remapCueWordsForRange(words, 0, 0.6, 1.4, 1)
    expect(mapped?.map((w) => w.word)).toEqual(['world', 'again'])
    // Rebased to new cue start (0.6)
    expect(mapped![0]!.startSec).toBeCloseTo(0, 5) // 0.5 max 0.6 → 0 after rebase?
    // world 0.5..1.0 clamped to 0.6..1.0 → rel 0..0.4
    expect(mapped![0]!.startSec).toBeCloseTo(0, 5)
    expect(mapped![0]!.endSec).toBeCloseTo(0.4, 5)
  })

  it('scales word times by speed', () => {
    const mapped = remapCueWordsForRange(words, 0, 0, 1.0, 2)
    // Only hello+world in 0..1; duration halved
    expect(mapped!.length).toBe(2)
    expect(mapped![0]!.endSec).toBeCloseTo(0.2, 5) // 0.4/2
    expect(mapped![1]!.startSec).toBeCloseTo(0.25, 5) // 0.5/2
  })
})

describe('mapCuesToTimeline word filter', () => {
  it('trims words to clip in/out and shifts for speed', () => {
    const cues = [
      {
        startSec: 0,
        endSec: 3,
        content: 'one two three',
        words: [
          { word: 'one', startSec: 0, endSec: 0.5 },
          { word: 'two', startSec: 1.0, endSec: 1.5 },
          { word: 'three', startSec: 2.0, endSec: 2.5 },
        ],
      },
    ]
    // Clip shows source 1.0..2.0 at 2× starting at t=5
    const clips = [
      clip({
        id: 'c1',
        startSec: 5,
        inPointSec: 1,
        outPointSec: 2,
        speed: 2,
      }),
    ]
    const mapped = mapCuesToTimeline(cues, clips, 'a1')
    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.startSec).toBeCloseTo(5, 5)
    expect(mapped[0]!.durationSec).toBeCloseTo(0.5, 5) // 1s source / speed 2
    // Only "two" overlaps [1,2]
    expect(mapped[0]!.words?.map((w) => w.word)).toEqual(['two'])
    expect(mapped[0]!.words![0]!.startSec).toBeCloseTo(0, 5)
    expect(mapped[0]!.words![0]!.endSec).toBeCloseTo(0.25, 5) // 0.5s source / 2
    expect(mapped[0]!.content).toBe('two')
  })
})

describe('mapSegmentedCuesToTimeline word filter', () => {
  it('filters words to segment audio window with speed', () => {
    const cues = [
      {
        startSec: 0,
        endSec: 2,
        content: 'aa bb',
        words: [
          { word: 'aa', startSec: 0, endSec: 0.5 },
          { word: 'bb', startSec: 1.0, endSec: 1.5 },
        ],
      },
    ]
    const segs = [
      { clipStartSec: 10, audioStart: 0.8, audioEnd: 2.0, speed: 1 },
    ]
    const mapped = mapSegmentedCuesToTimeline(cues, segs)
    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.words?.map((w) => w.word)).toEqual(['bb'])
    expect(mapped[0]!.content).toBe('bb')
  })
})
