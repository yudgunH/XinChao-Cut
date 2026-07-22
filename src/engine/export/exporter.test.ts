import { describe, it, expect } from 'vitest'

import {
  buildSceneKeyframeFrames,
  canRestartVideoEncoder,
  canStartZeroCopy,
  BrowserVideoUnsupportedError,
  DesktopVideoSourceReadError,
  isBrowserVideoUnsupportedError,
  mediaDrawCacheKey,
  muxerCodec,
  shouldPredecodeAdjacentCut,
} from './exporter'

describe('output codec contract', () => {
  it('maps WebCodecs families to matching MP4 sample entries', () => {
    expect(muxerCodec('h264')).toBe('avc')
    expect(muxerCodec('hevc')).toBe('hevc')
    expect(muxerCodec('av1')).toBe('av1')
  })

  it('never restarts an encoder after the muxer has received samples', () => {
    expect(canRestartVideoEncoder(0)).toBe(true)
    expect(canRestartVideoEncoder(1)).toBe(false)
    expect(canRestartVideoEncoder(10_000)).toBe(false)
  })

  it('only starts the unverified zero-copy path on the first output frame', () => {
    expect(canStartZeroCopy(0, false)).toBe(true)
    expect(canStartZeroCopy(1, false)).toBe(false)
    expect(canStartZeroCopy(500, true)).toBe(true)
  })
})

describe('browser video fallback classification', () => {
  it('allows fallback only for explicit demux/codec unsupported errors', () => {
    expect(isBrowserVideoUnsupportedError(
      new BrowserVideoUnsupportedError('unsupported container'),
    )).toBe(true)
    expect(isBrowserVideoUnsupportedError(
      new Error('pool wrapper', {
        cause: new DOMException('decoder codec unsupported', 'NotSupportedError'),
      }),
    )).toBe(true)
  })

  it('does not turn desktop I/O or timeouts into the slow seek fallback', () => {
    expect(isBrowserVideoUnsupportedError(
      new DesktopVideoSourceReadError('disk read failed'),
    )).toBe(false)
    expect(isBrowserVideoUnsupportedError(
      new Error('video sample index timed out'),
    )).toBe(false)
  })
})

describe('mediaDrawCacheKey (duplicate asset in one frame)', () => {
  it('keeps the bare assetId for the first occurrence', () => {
    expect(mediaDrawCacheKey('asset-1', 0)).toBe('asset-1')
  })

  it('suffixes the 2nd+ occurrence so duplicates get distinct keys', () => {
    expect(mediaDrawCacheKey('asset-1', 1)).toBe('asset-1#1')
    expect(mediaDrawCacheKey('asset-1', 2)).toBe('asset-1#2')
  })

  it('gives every draw of a repeated asset a distinct texture key', () => {
    // Simulate the per-frame occurrence counter from the export GPU draw loop:
    // two clips of the SAME video (PiP/duplicate) plus an unrelated asset.
    const drawAssetIds = ['vidA', 'vidA', 'vidB']
    const seen = new Map<string, number>()
    const keys = drawAssetIds.map((id) => {
      const occ = seen.get(id) ?? 0
      seen.set(id, occ + 1)
      return mediaDrawCacheKey(id, occ)
    })
    // The two vidA draws must NOT collide (else clip 2 shows clip 1's frame),
    // and the first vidA still uses the bare id (bounded VRAM in the common case).
    expect(keys).toEqual(['vidA', 'vidA#1', 'vidB'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('triple-duplicate of one asset yields three distinct keys', () => {
    const keys = [0, 1, 2].map((occ) => mediaDrawCacheKey('vid', occ))
    expect(new Set(keys).size).toBe(3)
  })
})

describe('buildSceneKeyframeFrames', () => {
  it('adds visible video clip starts and ends but ignores hidden tracks', () => {
    const frames = buildSceneKeyframeFrames([
      {
        id: 'a', trackId: 'v', assetId: 'asset', startSec: 1, muted: true,
        inPointSec: 0, outPointSec: 2, speed: 1,
      },
      {
        id: 'hidden', trackId: 'h', assetId: 'asset', startSec: 3,
        inPointSec: 0, outPointSec: 1, speed: 1,
      },
    ] as never, [
      { id: 'v', kind: 'video' },
      { id: 'h', kind: 'video', hidden: true },
    ] as never, 30, 300)

    expect([...frames].sort((a, b) => a - b)).toEqual([0, 30, 90])
  })
})

describe('shouldPredecodeAdjacentCut', () => {
  const cut = (over: Record<string, unknown>) => ({
    id: 'cut', assetId: 'video', trackId: 'v', startSec: 0,
    inPointSec: 0, outPointSec: 10, speed: 1,
    ...over,
  }) as never

  it('skips continuous and small forward same-source cuts', () => {
    const current = cut({ id: 'a', outPointSec: 10 })
    expect(shouldPredecodeAdjacentCut(current, cut({ id: 'b', inPointSec: 10 }))).toBe(false)
    expect(shouldPredecodeAdjacentCut(current, cut({ id: 'b', inPointSec: 10.5 }))).toBe(false)
  })

  it('targets backward, large-forward, and different-asset discontinuities', () => {
    const current = cut({ id: 'a', outPointSec: 10 })
    expect(shouldPredecodeAdjacentCut(current, cut({ id: 'b', inPointSec: 3 }))).toBe(true)
    expect(shouldPredecodeAdjacentCut(current, cut({ id: 'b', inPointSec: 13 }))).toBe(true)
    expect(shouldPredecodeAdjacentCut(current, cut({ id: 'b', assetId: 'other', inPointSec: 10 }))).toBe(true)
  })
})
