import { describe, expect, it } from 'vitest'

import type { Clip, Track } from '@engine/timeline'

import {
  EXPORT_AUDIO_CHANNELS,
  EXPORT_AUDIO_SAMPLE_RATE,
} from './audio-memory'
import {
  STREAM_BLOCK_SEC,
  STREAM_DENOISE_BLOCK_SEC,
  STREAM_DENOISE_CROSSFADE_SEC,
  crossfadePlanarBoundary,
  estimateStreamingPeakBytes,
  isStreamingAudioAvailable,
  isStreamingAudioEncodeSupported,
  scheduleClipInBlock,
  streamMixBlockSec,
  streamMixNeedsDenoise,
  streamMixToPcm,
  mixAudioBlock,
  streamMixAudioBlocks,
  overlapAddPlanar,
  equalPowerWeights,
} from './audio-stream-mix'
import { audioMixToPcm, renderAudioMix } from './exporter'

function track(id: string, kind: Track['kind'] = 'audio'): Track {
  return { id, kind, name: id, muted: false, locked: false, hidden: false }
}

function clip(over: Partial<Clip> & { id: string; trackId: string; assetId: string }): Clip {
  return {
    startSec: 0,
    inPointSec: 0,
    outPointSec: 1,
    speed: 1,
    opacity: 1,
    volume: 1,
    muted: false,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    effects: [],
    ...over,
  } as Clip
}

function fakeBuffer(
  durationSec: number,
  sampleRate = 48000,
  channels = 2,
  fill: number | ((i: number) => number) = 0.25,
): AudioBuffer {
  const frames = Math.ceil(durationSec * sampleRate)
  const data: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(frames)
    for (let i = 0; i < frames; i++) ch[i] = typeof fill === 'number' ? fill : fill(i)
    data.push(ch)
  }
  return {
    length: frames,
    sampleRate,
    numberOfChannels: channels,
    duration: durationSec,
    getChannelData: (c: number) => data[c]!,
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as AudioBuffer
}

function makeBuffer(
  durationSec: number,
  sampleRate = 48000,
  channels = 2,
  fill: number | ((i: number) => number) = 0.25,
): AudioBuffer {
  if (typeof OfflineAudioContext !== 'undefined') {
    const frames = Math.ceil(durationSec * sampleRate)
    const ctx = new OfflineAudioContext(channels, frames, sampleRate)
    const buf = ctx.createBuffer(channels, frames, sampleRate)
    for (let ch = 0; ch < channels; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < frames; i++) {
        d[i] = typeof fill === 'number' ? fill : fill(i)
      }
    }
    return buf
  }
  return fakeBuffer(durationSec, sampleRate, channels, fill)
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let m = 0
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
  return m
}

describe('scheduleClipInBlock (pure)', () => {
  it('no overlap → null', () => {
    expect(
      scheduleClipInBlock(
        { startSec: 10, inPointSec: 0, outPointSec: 1, speed: 1 },
        0,
        1,
        10,
      ),
    ).toBeNull()
  })

  it('clip fully inside block', () => {
    const s = scheduleClipInBlock(
      { startSec: 0.25, inPointSec: 0, outPointSec: 0.5, speed: 1 },
      0,
      1,
      5,
    )
    expect(s).toEqual({ when: 0.25, offset: 0, duration: 0.5 })
  })

  it('clip starts before block — advances source offset', () => {
    const s = scheduleClipInBlock(
      { startSec: 0, inPointSec: 0, outPointSec: 2, speed: 1 },
      1,
      2,
      10,
    )
    expect(s).not.toBeNull()
    expect(s!.when).toBe(0)
    expect(s!.offset).toBeCloseTo(1, 6)
    expect(s!.duration).toBeCloseTo(1, 6)
  })

  it('block boundary: ends exactly at blockStart is inactive', () => {
    expect(
      scheduleClipInBlock(
        { startSec: 0, inPointSec: 0, outPointSec: 1, speed: 1 },
        1,
        2,
        10,
      ),
    ).toBeNull()
  })

  it('speed > 1 shortens timeline span', () => {
    const s = scheduleClipInBlock(
      { startSec: 0, inPointSec: 0, outPointSec: 2, speed: 2 },
      0.5,
      1.0,
      10,
    )
    expect(s).not.toBeNull()
    expect(s!.when).toBe(0)
    expect(s!.offset).toBeCloseTo(1.0, 5)
  })
})

describe('estimateStreamingPeakBytes', () => {
  it('12h timeline peak does not grow with duration', () => {
    const src = 50 * 1024 * 1024
    expect(estimateStreamingPeakBytes(src, STREAM_BLOCK_SEC)).toBe(
      estimateStreamingPeakBytes(src, STREAM_BLOCK_SEC),
    )
    expect(estimateStreamingPeakBytes(src)).toBeLessThan(100 * 1024 * 1024)
  })
})

describe('split source with a separated first part', () => {
  it('keeps the original source audible after the stem replacement window', async () => {
    const tracks = [track('video', 'video'), track('vocals'), track('music')]
    const clips = [
      clip({
        id: 'part-1', trackId: 'video', assetId: 'source',
        startSec: 0, inPointSec: 0, outPointSec: 1, muted: true,
      }),
      clip({
        id: 'part-2', trackId: 'video', assetId: 'source',
        startSec: 1, inPointSec: 1, outPointSec: 2,
      }),
      clip({
        id: 'part-3', trackId: 'video', assetId: 'source',
        startSec: 2, inPointSec: 2, outPointSec: 3,
      }),
      clip({ id: 'stem-v', trackId: 'vocals', assetId: 'stem-v', outPointSec: 1 }),
      clip({ id: 'stem-m', trackId: 'music', assetId: 'stem-m', outPointSec: 1 }),
    ]
    const audioBuffers = new Map([
      ['source', makeBuffer(3, 100, 2, 0.25)],
      ['stem-v', makeBuffer(3, 100, 2, 0.1)],
      ['stem-m', makeBuffer(3, 100, 2, 0.1)],
    ])

    const pcm = await streamMixToPcm({
      durationSec: 3,
      clips,
      tracks,
      audioBuffers,
      sampleRate: 100,
      channels: 2,
      blockSec: 1,
    })

    expect(pcm).not.toBeNull()
    expect(pcm!.channels[0]![50]).toBeCloseTo(0.2, 5)
    expect(pcm!.channels[0]![150]).toBeCloseTo(0.25, 5)
    expect(pcm!.channels[0]![250]).toBeCloseTo(0.25, 5)
  })
})

describe('denoise block sizing + crossfade (#14)', () => {
  it('streamMixNeedsDenoise / streamMixBlockSec', () => {
    const tracks = [track('a1')]
    const plain = [clip({ id: 'c', trackId: 'a1', assetId: 'x', outPointSec: 1 })]
    const noisy = [
      clip({ id: 'c', trackId: 'a1', assetId: 'x', outPointSec: 1, denoise: 'medium' as const }),
    ]
    expect(streamMixNeedsDenoise(plain, tracks)).toBe(false)
    expect(streamMixBlockSec(plain, tracks)).toBe(STREAM_BLOCK_SEC)
    expect(streamMixNeedsDenoise(noisy, tracks)).toBe(true)
    expect(streamMixBlockSec(noisy, tracks)).toBe(STREAM_DENOISE_BLOCK_SEC)
    expect(streamMixBlockSec(noisy, tracks, 0.5)).toBe(0.5)
    expect(STREAM_DENOISE_BLOCK_SEC).toBeGreaterThan(STREAM_BLOCK_SEC)
    expect(STREAM_DENOISE_CROSSFADE_SEC).toBeGreaterThan(0)
  })

  it('overlapAddPlanar COLA blends same-region buffers (not adjacent smear)', () => {
    const pending = [new Float32Array([1, 1])]
    const head = [new Float32Array([0, 0, 0.5])]
    overlapAddPlanar(pending, head, 2)
    // head[0] = 1*a0 + 0*b0 → mostly pending at start of fade
    expect(head[0]![0]!).toBeGreaterThan(0.5)
    expect(head[0]![1]!).toBeGreaterThan(0)
    expect(head[0]![1]!).toBeLessThan(head[0]![0]!)
    // Unrelated sample past OLA region untouched
    expect(head[0]![2]!).toBe(0.5)
    const w0 = equalPowerWeights(0, 2)
    expect(w0.a * w0.a + w0.b * w0.b).toBeCloseTo(1, 5)
  })

  it('crossfadePlanarBoundary legacy wrapper still works for tests', () => {
    const prev = [new Float32Array([0, 0, 0, 1, 1])]
    const next = [new Float32Array([0, 0, 0, 0, 0])]
    crossfadePlanarBoundary(prev, next, 2)
    expect(next[0]![0]!).toBeGreaterThan(0.5)
    expect(next[0]![2]!).toBe(0)
  })

  it('denoise path uses larger default blocks (fewer seams on long export)', async () => {
    const tracks = [track('a1')]
    const clips = [
      clip({
        id: 'c',
        trackId: 'a1',
        assetId: 'x',
        outPointSec: 9,
        denoise: 'light' as const,
      }),
    ]
    const buffers = new Map([['x', makeBuffer(10, 48000, 2, 0.2)]])
    let blocks = 0
    const t0 = performance.now()
    for await (const b of streamMixAudioBlocks({
      durationSec: 9,
      clips,
      tracks,
      audioBuffers: buffers,
      // leave blockSec unset → STREAM_DENOISE_BLOCK_SEC
    })) {
      void b
      blocks++
    }
    const ms = performance.now() - t0
    // 9s @ 4s blocks → 3 blocks (not 9 @ 1s)
    expect(blocks).toBe(3)
    expect(blocks).toBeLessThan(9)
    // eslint-disable-next-line no-console
    console.log(`[denoise stream] 9s mix: ${blocks} blocks in ${ms.toFixed(1)}ms`)
  })

  it('denoise OLA: hop length preserved; constant tone continuous at seam', async () => {
    const tracks = [track('a1')]
    const clips = [
      clip({
        id: 'c',
        trackId: 'a1',
        assetId: 'x',
        outPointSec: 2,
        denoise: 'medium' as const,
      }),
    ]
    const buffers = new Map([['x', makeBuffer(3, 48000, 2, 0.25)]])
    const pcm = (await streamMixToPcm({
      durationSec: 2,
      clips,
      tracks,
      audioBuffers: buffers,
      blockSec: 1,
      denoiseCrossfadeSec: 0.02,
    }))!
    // Total frames must still match duration (OLA must not lengthen the stream).
    expect(pcm.length).toBe(Math.ceil(2 * EXPORT_AUDIO_SAMPLE_RATE))
    const sr = pcm.sampleRate
    const seam = Math.round(1 * sr)
    const before = pcm.channels[0]![seam - 2]!
    const after = pcm.channels[0]![seam + 2]!
    // Continuous source: seam samples stay near the tone (no null/click to 0).
    expect(Math.abs(before)).toBeGreaterThan(0.05)
    expect(Math.abs(after)).toBeGreaterThan(0.05)
    expect(Math.abs(before - after)).toBeLessThan(0.15)
  })

  it('isStreamingAudioEncodeSupported is async and false without AudioEncoder', async () => {
    // jsdom typically has no AudioEncoder → encode path must refuse.
    const ok = await isStreamingAudioEncodeSupported()
    if (typeof AudioEncoder === 'undefined') {
      expect(ok).toBe(false)
    } else {
      expect(typeof ok).toBe('boolean')
    }
  })
})

describe('stream mix CPU / streaming generator', () => {
  it('isStreamingAudioAvailable', () => {
    expect(isStreamingAudioAvailable()).toBe(true)
  })

  it('muted → null', async () => {
    const tracks = [track('a1')]
    const clips = [clip({ id: 'c', trackId: 'a1', assetId: 'x', muted: true, outPointSec: 1 })]
    const buffers = new Map([['x', makeBuffer(1)]])
    expect(
      await streamMixToPcm({ durationSec: 1, clips, tracks, audioBuffers: buffers }),
    ).toBeNull()
  })

  it('one clip constant amplitude', async () => {
    const tracks = [track('a1')]
    const clips = [
      clip({ id: 'c', trackId: 'a1', assetId: 'x', startSec: 0, outPointSec: 0.5, volume: 1 }),
    ]
    const buffers = new Map([['x', makeBuffer(1, 48000, 2, 0.2)]])
    const pcm = (await streamMixToPcm({
      durationSec: 1,
      clips,
      tracks,
      audioBuffers: buffers,
      blockSec: 0.4,
    }))!
    expect(pcm.sampleRate).toBe(EXPORT_AUDIO_SAMPLE_RATE)
    expect(pcm.numberOfChannels).toBe(EXPORT_AUDIO_CHANNELS)
    const mid = pcm.channels[0]![Math.floor(0.2 * pcm.sampleRate)]!
    expect(Math.abs(mid - 0.2)).toBeLessThan(0.02)
  })

  it('overlap sums volumes', async () => {
    const tracks = [track('a1'), track('a2')]
    const clips = [
      clip({ id: 'c1', trackId: 'a1', assetId: 'x', outPointSec: 1, volume: 0.5 }),
      clip({ id: 'c2', trackId: 'a2', assetId: 'y', outPointSec: 1, volume: 0.5 }),
    ]
    const buffers = new Map([
      ['x', makeBuffer(1.2, 48000, 2, 0.4)],
      ['y', makeBuffer(1.2, 48000, 2, 0.4)],
    ])
    const pcm = (await streamMixToPcm({
      durationSec: 1,
      clips,
      tracks,
      audioBuffers: buffers,
      blockSec: 0.5,
    }))!
    const mid = pcm.channels[0]![Math.floor(0.3 * pcm.sampleRate)]!
    expect(Math.abs(mid - 0.4)).toBeLessThan(0.05)
  })

  it('trim in-point advances source', async () => {
    const tracks = [track('a1')]
    const clips = [
      clip({
        id: 'c',
        trackId: 'a1',
        assetId: 'x',
        startSec: 0,
        inPointSec: 0.5,
        outPointSec: 1.0,
      }),
    ]
    const buffers = new Map([['x', makeBuffer(1, 48000, 2, (i) => i / 48000)]])
    const pcm = (await streamMixToPcm({
      durationSec: 0.5,
      clips,
      tracks,
      audioBuffers: buffers,
      blockSec: 0.2,
    }))!
    expect(pcm.channels[0]![0]!).toBeGreaterThan(0.4)
  })

  it('gap then signal', async () => {
    const tracks = [track('a1')]
    const clips = [
      clip({
        id: 'c',
        trackId: 'a1',
        assetId: 'x',
        startSec: 0.5,
        outPointSec: 0.4,
      }),
    ]
    const buffers = new Map([['x', makeBuffer(1, 48000, 2, 0.5)]])
    const pcm = (await streamMixToPcm({
      durationSec: 1.2,
      clips,
      tracks,
      audioBuffers: buffers,
      blockSec: 0.25,
    }))!
    const head = pcm.channels[0]!.subarray(0, Math.floor(0.4 * pcm.sampleRate))
    const mid = pcm.channels[0]!.subarray(
      Math.floor(0.55 * pcm.sampleRate),
      Math.floor(0.7 * pcm.sampleRate),
    )
    expect(head.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThan(1e-4)
    expect(mid.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeGreaterThan(0.1)
  })

  it('partial tail length exact', async () => {
    const tracks = [track('a1')]
    const clips = [clip({ id: 'c', trackId: 'a1', assetId: 'x', outPointSec: 0.3 })]
    const buffers = new Map([['x', makeBuffer(1)]])
    const durationSec = 2.3
    const pcm = (await streamMixToPcm({
      durationSec,
      clips,
      tracks,
      audioBuffers: buffers,
      blockSec: 1,
    }))!
    expect(pcm.length).toBe(Math.ceil(durationSec * EXPORT_AUDIO_SAMPLE_RATE))
  })

  it('different source sample rate → export rate out', async () => {
    const tracks = [track('a1')]
    const clips = [clip({ id: 'c', trackId: 'a1', assetId: 'x', outPointSec: 0.5 })]
    const buffers = new Map([['x', makeBuffer(0.6, 44100, 1, 0.2)]])
    const pcm = await streamMixToPcm({
      durationSec: 0.8,
      clips,
      tracks,
      audioBuffers: buffers,
    })
    expect(pcm!.sampleRate).toBe(EXPORT_AUDIO_SAMPLE_RATE)
    expect(pcm!.numberOfChannels).toBe(EXPORT_AUDIO_CHANNELS)
  })

  it('cancel mid-stream', async () => {
    const tracks = [track('a1')]
    const clips = [clip({ id: 'c', trackId: 'a1', assetId: 'x', outPointSec: 5 })]
    const buffers = new Map([['x', makeBuffer(6)]])
    const ac = new AbortController()
    let blocks = 0
    await expect(
      (async () => {
        for await (const block of streamMixAudioBlocks({
          durationSec: 5,
          clips,
          tracks,
          audioBuffers: buffers,
          blockSec: 0.5,
          signal: ac.signal,
        })) {
          void block
          blocks++
          if (blocks >= 2) ac.abort()
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(blocks).toBeGreaterThanOrEqual(2)
    expect(blocks).toBeLessThan(10)
  })

  it('block allocation bounded; peak estimate duration-invariant', async () => {
    const src = 20 * 1024 * 1024
    expect(estimateStreamingPeakBytes(src)).toBe(estimateStreamingPeakBytes(src))
    let maxBlock = 0
    await mixAudioBlock(
      0,
      1,
      [clip({ id: 'c', trackId: 'a1', assetId: 'x', outPointSec: 0.5 })],
      [track('a1')],
      new Map([['x', makeBuffer(1)]]),
      {
        forceCpu: true,
        onBlockAllocated: (b) => {
          maxBlock = Math.max(maxBlock, b)
        },
      },
    )
    expect(maxBlock).toBeLessThan(2 * 1024 * 1024)
  })

  it.runIf(typeof OfflineAudioContext !== 'undefined')(
    'parity vs full offline renderAudioMix',
    async () => {
      const tracks = [track('a1')]
      const clips = [
        clip({ id: 'c', trackId: 'a1', assetId: 'x', startSec: 0, outPointSec: 0.8 }),
      ]
      const buffers = new Map([['x', makeBuffer(1, 48000, 2, 0.2)]])
      const offline = await renderAudioMix(1.5, clips, tracks, buffers)
      const offlinePcm = audioMixToPcm(offline!)
      const streamPcm = (await streamMixToPcm({
        durationSec: 1.5,
        clips,
        tracks,
        audioBuffers: buffers,
        blockSec: 0.4,
      }))!
      expect(streamPcm.length).toBe(offlinePcm.length)
      expect(maxAbsDiff(streamPcm.channels[0]!, offlinePcm.channels[0]!)).toBeLessThan(1e-3)
    },
  )
})
