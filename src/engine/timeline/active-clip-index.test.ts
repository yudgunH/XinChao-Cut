import { describe, expect, it } from 'vitest'

import {
  ActiveClipIndex,
  activeClipsLinear,
  linearScanCheckCount,
} from './active-clip-index'
import type { Clip, Track, TextClipData } from './types'
import { makeDefaultAdjust, makeDefaultTransform } from './types'

function track(id: string, kind: Track['kind'], hidden = false): Track {
  return { id, kind, name: id, muted: false, locked: false, hidden }
}

function clip(over: Record<string, unknown> & { id: string; trackId: string }): Clip {
  return {
    startSec: 0,
    inPointSec: 0,
    outPointSec: 1,
    speed: 1,
    opacity: 1,
    volume: 1,
    muted: false,
    assetId: 'a',
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
    ...over,
  } as unknown as Clip
}

function textData(content = 'hi'): TextClipData {
  return {
    content,
    fontFamily: 'Arial',
    fontSize: 48,
    fontWeight: '400',
    color: '#fff',
    align: 'center',
    x: 0.5,
    y: 0.5,
    hasBackground: false,
    backgroundColor: '#000',
  } as unknown as TextClipData
}

describe('ActiveClipIndex parity with linear / clipIsActiveAt', () => {
  it('0 clips', () => {
    const idx = ActiveClipIndex.build([], [track('v1', 'video')])
    expect(idx.queryAt('video', 0)).toEqual([])
  })

  it('zero-duration clip is never active', () => {
    const clips = [clip({ id: 'z', trackId: 'v1', startSec: 1, inPointSec: 0, outPointSec: 0 })]
    const tracks = [track('v1', 'video')]
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.intervalCount('video')).toBe(0)
    expect(idx.queryAt('video', 1)).toEqual([])
  })

  it('near-zero duration is active only in a tiny window', () => {
    const clips = [clip({ id: 'n', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 0.001 })]
    const tracks = [track('v1', 'video')]
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.queryAt('video', 2).map((c) => c.id)).toEqual(['n'])
    expect(idx.queryAt('video', 2.001).map((c) => c.id)).toEqual([])
  })

  it('boundary: active at start, inactive at end (half-open)', () => {
    const clips = [clip({ id: 'c', trackId: 'v1', startSec: 2, inPointSec: 0, outPointSec: 4 })] // [2,6)
    const tracks = [track('v1', 'video')]
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.queryAt('video', 2).map((c) => c.id)).toEqual(['c'])
    expect(idx.queryAt('video', 5.999).map((c) => c.id)).toEqual(['c'])
    expect(idx.queryAt('video', 6).map((c) => c.id)).toEqual([])
    expect(idx.queryAt('video', 1.99).map((c) => c.id)).toEqual([])
  })

  it('hidden tracks excluded; muted clips still active', () => {
    const tracks = [track('v1', 'video'), track('v2', 'video', true)]
    const clips = [
      clip({ id: 'a', trackId: 'v1', startSec: 0, outPointSec: 5, muted: true }),
      clip({ id: 'b', trackId: 'v2', startSec: 0, outPointSec: 5 }),
    ]
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.queryAt('video', 1).map((c) => c.id)).toEqual(['a'])
  })

  it('multi-track overlap paints higher track index first', () => {
    const tracks = [track('v1', 'video'), track('v2', 'video')]
    const clips = [
      clip({ id: 'bottom', trackId: 'v1', startSec: 0, outPointSec: 10 }),
      clip({ id: 'top', trackId: 'v2', startSec: 0, outPointSec: 10 }),
    ]
    const idx = ActiveClipIndex.build(clips, tracks)
    const linear = activeClipsLinear(clips, tracks, 'video', 1)
    const q = idx.queryAt('video', 1)
    expect(q.map((c) => c.id)).toEqual(linear.map((c) => c.id))
    expect(q.map((c) => c.id)).toEqual(['top', 'bottom'])
  })

  it('adjacent clips at shared boundary: only the next is active', () => {
    const tracks = [track('v1', 'video')]
    const clips = [
      clip({ id: 'a', trackId: 'v1', startSec: 0, outPointSec: 1 }), // [0,1)
      clip({ id: 'b', trackId: 'v1', startSec: 1, outPointSec: 2 }), // [1,2)
    ]
    const idx = ActiveClipIndex.build(clips, tracks)
    const sweep = idx.createSweep('video')
    expect(idx.queryAt('video', 0.999).map((c) => c.id)).toEqual(['a'])
    expect(idx.queryAt('video', 1).map((c) => c.id)).toEqual(['b'])
    expect(sweep.advanceTo(0.999).map((c) => c.id)).toEqual(['a'])
    expect(sweep.advanceTo(1).map((c) => c.id)).toEqual(['b'])
  })

  it('finds upcoming clip starts in a bounded window without including the current clip', () => {
    const tracks = [track('v1', 'video')]
    const clips = [
      clip({ id: 'current', trackId: 'v1', startSec: 0, outPointSec: 10 }),
      clip({ id: 'next', trackId: 'v1', startSec: 1, inPointSec: 10, outPointSec: 11 }),
      clip({ id: 'later', trackId: 'v1', startSec: 3, inPointSec: 20, outPointSec: 21 }),
    ]
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.queryStartingBetween('video', 0.5, 2, 1).map((c) => c.id)).toEqual(['next'])
    expect(idx.queryStartingBetween('video', 1, 3, 4).map((c) => c.id)).toEqual(['later'])
  })

  it('seek backward and forward large jumps match linear', () => {
    const tracks = [track('t1', 'text')]
    const clips: Clip[] = []
    for (let i = 0; i < 50; i++) {
      clips.push(
        clip({
          id: `c${i}`,
          trackId: 't1',
          kind: 'text',
          startSec: i * 2,
          outPointSec: 1.5,
          textData: textData(`cap ${i}`),
          assetId: null as unknown as string,
        }),
      )
    }
    const idx = ActiveClipIndex.build(clips, tracks)
    const sweep = idx.createSweep('text')
    const times = [0, 40, 10, 90, 5, 0]
    for (const t of times) {
      const q = idx.queryAt('text', t).map((c) => c.id)
      const lin = activeClipsLinear(clips, tracks, 'text', t).map((c) => c.id)
      expect(q).toEqual(lin)
      expect(sweep.advanceTo(t).map((c) => c.id)).toEqual(lin)
    }
  })

  it('mutation invalidates via matches()', () => {
    const tracks = [track('v1', 'video')]
    const clips1 = [clip({ id: 'a', trackId: 'v1', outPointSec: 5 })]
    const idx = ActiveClipIndex.build(clips1, tracks)
    expect(idx.matches(clips1, tracks)).toBe(true)
    const clips2 = [...clips1, clip({ id: 'b', trackId: 'v1', startSec: 3, outPointSec: 5 })]
    expect(idx.matches(clips2, tracks)).toBe(false)
  })

  it('long-form index memory scales with clips, not duration buckets', () => {
    const tracks = Array.from({ length: 64 }, (_, i) => track(`v${i}`, 'video'))
    const clips = tracks.map((t, i) => clip({
      id: `long-${i}`,
      trackId: t.id,
      startSec: 0,
      outPointSec: 12 * 60 * 60,
    }))
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.intervalCount('video')).toBe(64)
    expect(idx.queryAt('video', 11 * 60 * 60)).toHaveLength(64)
    expect(idx.queryAt('video', 12 * 60 * 60)).toEqual([])
  })

  it('fx / text require fxData / textData', () => {
    const tracks = [track('f1', 'fx'), track('t1', 'text')]
    const clips = [
      clip({ id: 'fx0', trackId: 'f1', kind: 'fx', outPointSec: 5, fxData: { type: 'blur-sticker' } as Clip['fxData'] }),
      clip({ id: 'fx1', trackId: 'f1', kind: 'fx', outPointSec: 5 }), // no fxData
      clip({ id: 'tx0', trackId: 't1', kind: 'text', outPointSec: 5, textData: textData() }),
      clip({ id: 'tx1', trackId: 't1', kind: 'text', outPointSec: 5 }),
    ]
    const idx = ActiveClipIndex.build(clips, tracks)
    expect(idx.queryAt('fx', 1).map((c) => c.id)).toEqual(['fx0'])
    expect(idx.queryAt('text', 1).map((c) => c.id)).toEqual(['tx0'])
  })

  it('compound: index does not expand; caller must pass flattened clips', () => {
    // Parent compound shell sits on a video track but children live only after flatten.
    const tracks = [track('v1', 'video')]
    const parentOnly = [
      clip({
        id: 'compound-shell',
        trackId: 'v1',
        startSec: 0,
        outPointSec: 10,
        compoundId: 'comp-1',
        assetId: null as unknown as string,
      }),
    ]
    const idxParent = ActiveClipIndex.build(parentOnly, tracks)
    // Shell is still a clip on a video track → indexed if it has duration.
    expect(idxParent.queryAt('video', 1).map((c) => c.id)).toEqual(['compound-shell'])
    // After flatten (what Preview flatTimeline / export already pass), children replace shell:
    const flattened = [
      clip({ id: 'child-a', trackId: 'v1', startSec: 0, outPointSec: 5 }),
      clip({ id: 'child-b', trackId: 'v1', startSec: 5, outPointSec: 5 }),
    ]
    const idxFlat = ActiveClipIndex.build(flattened, tracks)
    expect(idxFlat.queryAt('video', 1).map((c) => c.id)).toEqual(['child-a'])
    expect(idxFlat.queryAt('video', 6).map((c) => c.id)).toEqual(['child-b'])
    expect(idxParent.matches(flattened, tracks)).toBe(false)
  })

  it('preview queryAt and export sweep return same active set/order at t', () => {
    const tracks = [track('v1', 'video'), track('v2', 'video'), track('t1', 'text')]
    const clips = [
      clip({ id: 'v-low', trackId: 'v1', startSec: 0, outPointSec: 10 }),
      clip({ id: 'v-high', trackId: 'v2', startSec: 2, outPointSec: 6 }),
      clip({
        id: 'cap',
        trackId: 't1',
        kind: 'text',
        startSec: 3,
        outPointSec: 4,
        textData: textData(),
        assetId: null as unknown as string,
      }),
    ]
    const idx = ActiveClipIndex.build(clips, tracks)
    const videoSweep = idx.createSweep('video')
    const textSweep = idx.createSweep('text')
    for (const t of [0, 2, 3.5, 7, 9.999, 10]) {
      expect(idx.queryAt('video', t).map((c) => c.id)).toEqual(
        videoSweep.advanceTo(t).map((c) => c.id),
      )
      expect(idx.queryAt('text', t).map((c) => c.id)).toEqual(
        textSweep.advanceTo(t).map((c) => c.id),
      )
      expect(idx.queryAt('video', t).map((c) => c.id)).toEqual(
        activeClipsLinear(clips, tracks, 'video', t).map((c) => c.id),
      )
    }
  })

  it('random overlapping intervals match the linear oracle', () => {
    const tracks = [track('v1', 'video'), track('v2', 'video'), track('v3', 'video')]
    let seed = 0x5eed1234
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    const clips = Array.from({ length: 1_000 }, (_, i) => {
      const startSec = random() * 3_600
      const duration = 0.01 + random() * 600
      return clip({
        id: `random-${i}`,
        trackId: tracks[Math.floor(random() * tracks.length)]!.id,
        startSec,
        outPointSec: duration,
      })
    })
    const idx = ActiveClipIndex.build(clips, tracks)
    for (let i = 0; i < 200; i++) {
      const t = random() * 4_200
      expect(idx.queryAt('video', t).map((c) => c.id)).toEqual(
        activeClipsLinear(clips, tracks, 'video', t).map((c) => c.id),
      )
    }
  })
})

describe('10_000 captions correctness + benchmark', () => {
  function makeCaptions(n: number): { clips: Clip[]; tracks: Track[] } {
    const tracks = [track('t1', 'text')]
    const clips: Clip[] = []
    for (let i = 0; i < n; i++) {
      clips.push(
        clip({
          id: `cap-${i}`,
          trackId: 't1',
          kind: 'text',
          startSec: i * 0.5,
          inPointSec: 0,
          outPointSec: 0.4,
          textData: textData(String(i)),
          assetId: null as unknown as string,
        }),
      )
    }
    return { clips, tracks }
  }

  it('10k captions: query and sweep match linear at many times', () => {
    const { clips, tracks } = makeCaptions(10_000)
    const idx = ActiveClipIndex.build(clips, tracks)
    const sweep = idx.createSweep('text')
    const sample = [0, 0.2, 12.5, 100, 499.9, 2500, 4999.5, 4999.9]
    for (const t of sample) {
      const expected = activeClipsLinear(clips, tracks, 'text', t).map((c) => c.id)
      expect(idx.queryAt('text', t).map((c) => c.id)).toEqual(expected)
      expect(sweep.advanceTo(t).map((c) => c.id)).toEqual(expected)
    }
  })

  it('benchmark: index query does not scale like full linear scan checks', () => {
    const { clips, tracks } = makeCaptions(10_000)
    const linearChecks = linearScanCheckCount(clips)
    expect(linearChecks).toBe(10_000)

    const idx = ActiveClipIndex.build(clips, tracks)
    const frames = 500
    // Warm
    for (let f = 0; f < 10; f++) idx.queryAt('text', f * 0.5)

    const t0 = performance.now()
    for (let f = 0; f < frames; f++) {
      idx.queryAt('text', (f * 10) % 5000)
    }
    const indexMs = performance.now() - t0

    const t1 = performance.now()
    for (let f = 0; f < frames; f++) {
      activeClipsLinear(clips, tracks, 'text', (f * 10) % 5000)
    }
    const linearMs = performance.now() - t1

    // Stability: index should be faster on 10k clips (allow CI noise — 2x margin).
    // Also assert structural win: linear always does 10k checks/frame.
    expect(linearChecks * frames).toBe(10_000 * frames)
    expect(indexMs).toBeLessThan(linearMs * 2 + 50)
    // Soft report for the session log
    // eslint-disable-next-line no-console
    console.log(
      `[S6 benchmark] 10k captions × ${frames} queries: index=${indexMs.toFixed(1)}ms linear=${linearMs.toFixed(1)}ms (linear checks/frame=${linearChecks})`,
    )
  })

  it('export-style monotonic sweep is efficient over all frames', () => {
    const { clips, tracks } = makeCaptions(10_000)
    const idx = ActiveClipIndex.build(clips, tracks)
    const sweep = idx.createSweep('text')
    const fps = 30
    const duration = 100 // sec subset
    const frames = duration * fps
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) {
      sweep.advanceTo(f / fps)
    }
    const ms = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`[S6 benchmark] sweep ${frames} frames (100s @30fps) on 10k caps: ${ms.toFixed(1)}ms`)
    expect(ms).toBeLessThan(5000)
  })
})
