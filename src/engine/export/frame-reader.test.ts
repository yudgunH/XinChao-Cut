import { afterEach, describe, it, expect, vi } from 'vitest'

import {
  asVideoByteSource,
  buildKeyIndices,
  canRecoverCompletedDecoderFlush,
  createCachedVideoByteSource,
  createSharedVideoByteRangeCache,
  createVideoFrameReader,
  estimateVideoSampleRate,
  findSeekSampleIndex,
  shouldRestartForward,
  type SampleRef,
} from './frame-reader'

afterEach(() => vi.unstubAllGlobals())

describe('VideoReaderSource byte-range adapter', () => {
  it('maps Blob slices to bounded [start, end) reads', async () => {
    const source = asVideoByteSource(new Blob([Uint8Array.of(10, 20, 30, 40, 50)]))
    expect(source.size).toBe(5)
    expect([...new Uint8Array(await source.read(1, 4))]).toEqual([20, 30, 40])
  })

  it('passes desktop VideoByteSource through without materialising it', () => {
    const desktopSource = {
      size: 8 * 1024 * 1024 * 1024,
      read: vi.fn(async () => new ArrayBuffer(0)),
    }
    expect(asVideoByteSource(desktopSource)).toBe(desktopSource)
  })
})

describe('cached VideoByteSource', () => {
  it('shares exact immutable ranges and coalesces an in-flight read', async () => {
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const source = createCachedVideoByteSource({
      size: 64,
      async read(start, end) {
        reads++
        await gate
        return Uint8Array.from({ length: end - start }, (_, index) => start + index).buffer
      },
    }, 32)

    const first = source.read(4, 12)
    const second = source.read(4, 12)
    release()
    const firstBuffer = await first
    expect([...new Uint8Array(firstBuffer)]).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
    expect(await second).toBe(firstBuffer)
    expect(await source.read(4, 12)).toBe(firstBuffer)
    expect(reads).toBe(1)
  })

  it('serves a covered subrange and evicts least-recently-used bytes', async () => {
    const reads: string[] = []
    const source = createCachedVideoByteSource({
      size: 64,
      async read(start, end) {
        reads.push(`${start}:${end}`)
        return Uint8Array.from({ length: end - start }, (_, index) => start + index).buffer
      },
    }, 16)

    await source.read(0, 8)
    expect([...new Uint8Array(await source.read(2, 6))]).toEqual([2, 3, 4, 5])
    await source.read(8, 16)
    await source.read(16, 24)
    await source.read(0, 8)
    expect(reads).toEqual(['0:8', '8:16', '16:24', '0:8'])
  })

  it('enforces one LRU byte budget across different video assets', async () => {
    const reads: string[] = []
    const cache = createSharedVideoByteRangeCache(16)
    const makeSource = (id: string) => cache.wrap(id, {
      size: 64,
      async read(start, end) {
        reads.push(`${id}:${start}:${end}`)
        return new Uint8Array(end - start).fill(id.charCodeAt(0)).buffer
      },
    })
    const first = makeSource('a')
    const second = makeSource('b')

    await first.read(0, 8)
    await second.read(0, 8)
    await first.read(0, 8) // touch a; b is now the global LRU entry
    await first.read(8, 16) // evicts b to remain within the shared 16-byte cap
    await second.read(0, 8)
    expect(reads).toEqual(['a:0:8', 'b:0:8', 'a:8:16', 'b:0:8'])
  })
})

describe('source sample-rate telemetry', () => {
  it('estimates the encoded sample rate from track durations', () => {
    expect(estimateVideoSampleRate(Float64Array.from({ length: 1_000 }, () => 1_000_000 / 120)))
      .toBeCloseTo(120, 5)
    expect(estimateVideoSampleRate(Float64Array.of(0, Number.NaN, -1))).toBe(0)
  })
})

describe('stalled VideoDecoder.flush recovery', () => {
  it('recovers only after new output, an empty queue and a quiet interval', () => {
    expect(canRecoverCompletedDecoderFlush(10, 20, 0, 50)).toBe(true)
    expect(canRecoverCompletedDecoderFlush(10, 10, 0, 100)).toBe(false)
    expect(canRecoverCompletedDecoderFlush(10, 20, 1, 100)).toBe(false)
    expect(canRecoverCompletedDecoderFlush(10, 20, 0, 49)).toBe(false)
  })

  it('returns delayed frames without waiting for a never-resolving flush promise', async () => {
    class FakeFrame {
      constructor(readonly timestamp: number) {}
      close() {}
    }
    class FakeEncodedVideoChunk {
      constructor(_init: unknown) {}
    }
    class FakeVideoDecoder {
      readonly decodeQueueSize = 0
      private readonly output: (frame: unknown) => void

      constructor(init: { output: (frame: unknown) => void }) {
        this.output = init.output
      }

      configure() {}
      decode() {}
      close() {}

      flush(): Promise<void> {
        setTimeout(() => {
          for (let index = 0; index <= 10; index++) {
            this.output(new FakeFrame(index * 30_000))
          }
        }, 0)
        return new Promise<void>(() => {})
      }
    }

    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)

    const read = vi.fn(async () => Uint8Array.of(1).buffer)
    const reader = await createVideoFrameReader(
      {
        size: 1,
        read,
      },
      {
        codec: 'avc1.42001e',
        codedWidth: 16,
        codedHeight: 16,
        offsets: Float64Array.of(0),
        sizes: Uint32Array.of(1),
        keyFlags: Uint8Array.of(1),
        tsUs: Float64Array.of(0),
        durUs: Float64Array.of(33_333),
        keyIndices: Uint32Array.of(0),
      },
    )

    const started = performance.now()
    const frame = await reader.getFrameAt(0.3)

    expect(frame?.timestamp).toBe(300_000)
    expect(read).toHaveBeenCalledWith(0, 1)
    expect(performance.now() - started).toBeLessThan(1_000)
    reader.close()
  })
})

describe('GPU-first VideoDecoder configuration', () => {
  const index = {
    codec: 'avc1.42001e',
    codedWidth: 16,
    codedHeight: 16,
    offsets: Float64Array.of(0),
    sizes: Uint32Array.of(1),
    keyFlags: Uint8Array.of(1),
    tsUs: Float64Array.of(0),
    durUs: Float64Array.of(33_333),
    keyIndices: Uint32Array.of(0),
  }

  function installDecoder(configs: VideoDecoderConfig[], rejectHardware = false) {
    class FakeFrame {
      constructor(readonly timestamp: number) {}
      close() {}
    }
    class FakeEncodedVideoChunk {
      constructor(_init: unknown) {}
    }
    class FakeVideoDecoder {
      readonly decodeQueueSize = 0
      private readonly output: (frame: unknown) => void

      constructor(init: { output: (frame: unknown) => void }) {
        this.output = init.output
      }

      configure(config: VideoDecoderConfig) {
        configs.push(config)
        if (rejectHardware && config.hardwareAcceleration === 'prefer-hardware') {
          throw new DOMException('hardware unavailable', 'NotSupportedError')
        }
      }

      decode() {
        this.output(new FakeFrame(0))
        this.output(new FakeFrame(33_333))
      }

      close() {}
      flush(): Promise<void> { return Promise.resolve() }
    }

    vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk)
    vi.stubGlobal('VideoDecoder', FakeVideoDecoder)
  }

  it('requests hardware decode by default', async () => {
    const configs: VideoDecoderConfig[] = []
    installDecoder(configs)
    const reader = await createVideoFrameReader(
      { size: 1, read: async () => Uint8Array.of(1).buffer },
      index,
    )
    await reader.getFrameAt(0)
    expect(configs[0]?.hardwareAcceleration).toBe('prefer-hardware')
    reader.close()
  })

  it('falls back to software when hardware configure is rejected', async () => {
    const configs: VideoDecoderConfig[] = []
    installDecoder(configs, true)
    const reader = await createVideoFrameReader(
      { size: 1, read: async () => Uint8Array.of(1).buffer },
      index,
    )
    await reader.getFrameAt(0)
    expect(configs.map((config) => config.hardwareAcceleration)).toEqual([
      'prefer-hardware',
      'prefer-software',
    ])
    reader.close()
  })

})

it('uses a shared sample index without reparsing the source blob', async () => {
  const slice = () => { throw new Error('blob must not be reparsed') }
  const refs = makeRefs(1)
  const reader = await createVideoFrameReader(
    { size: 1000, slice } as unknown as Blob,
    {
      codec: 'avc1.42001e',
      codedWidth: 16,
      codedHeight: 16,
      offsets: Float64Array.from(refs.map((ref) => ref.offset)),
      sizes: Uint32Array.from(refs.map((ref) => ref.size)),
      keyFlags: Uint8Array.from(refs.map((ref) => ref.type === 'key' ? 1 : 0)),
      tsUs: Float64Array.from(refs.map((ref) => ref.tsUs)),
      durUs: Float64Array.from(refs.map((ref) => ref.durUs)),
      keyIndices: Uint32Array.of(0),
    },
  )
  reader.close()
})

/** Build a synthetic sample table: key every `gop` frames, 30 fps. */
function makeRefs(count: number, gop = 30, fps = 30): SampleRef[] {
  const frameUs = 1e6 / fps
  const refs: SampleRef[] = []
  for (let i = 0; i < count; i++) {
    refs.push({
      offset: i * 1000,
      size: 1000,
      type: i % gop === 0 ? 'key' : 'delta',
      tsUs: i * frameUs,
      durUs: frameUs,
    })
  }
  return refs
}

/**
 * B-frame-ish table: decode order has key then deltas, but one delta near the
 * end of a GOP has a CTS that sits just after the *next* keyframe's CTS would
 * be wrong if we only used "last key ≤ target" without retreat — we model the
 * common case where seeking mid-GOP must start at (or before) that GOP's key.
 */
function makeGopRefs(): SampleRef[] {
  // 3 GOPs × 10 frames @ 10 fps → 0.1s per frame. Keys at 0, 10, 20.
  return makeRefs(30, 10, 10)
}

describe('buildKeyIndices', () => {
  it('collects every keyframe sample index', () => {
    const refs = makeRefs(90, 30) // keys at 0, 30, 60
    expect(buildKeyIndices(refs)).toEqual([0, 30, 60])
  })

  it('falls back to sample 0 when no keys are marked', () => {
    const allDelta = makeRefs(5, 30).map((r) => ({ ...r, type: 'delta' as const }))
    expect(buildKeyIndices(allDelta)).toEqual([0])
  })

  it('returns empty for empty refs', () => {
    expect(buildKeyIndices([])).toEqual([])
  })
})

describe('findSeekSampleIndex (keyframe restart for backward jump)', () => {
  const refs = makeGopRefs() // keys @ 0, 10, 20  (0s, 1s, 2s)
  const keys = buildKeyIndices(refs)

  it('starts at first key when target is at t=0', () => {
    // best key = 0 → no previous key to retreat to
    expect(findSeekSampleIndex(refs, keys, 0)).toBe(0)
  })

  it('jumps into mid-GOP: retreats one keyframe for B-frame safety', () => {
    // Target 1.5s → frame index 15 (delta in GOP starting at key 10).
    // Last key with CTS ≤ 1.5s is key@10 (1.0s). B-frame safety → key@0.
    expect(findSeekSampleIndex(refs, keys, 1.5)).toBe(0)
  })

  it('jumps into third GOP mid-way: lands on previous keyframe', () => {
    // Target 2.5s → frame 25. Last key ≤ 2.5s is key@20. Safety → key@10.
    expect(findSeekSampleIndex(refs, keys, 2.5)).toBe(10)
  })

  it('exactly on a keyframe (not the first): still retreats one key', () => {
    // Target exactly at key@20 (2.0s). best=2 → safe=1 → sample 10.
    // Slightly conservative but guarantees the key itself is always decodable
    // from a clean restart (decoder receives an earlier IDR first).
    expect(findSeekSampleIndex(refs, keys, 2.0)).toBe(10)
  })

  it('target past end of stream still uses last key with B-frame retreat', () => {
    // Last key is 20; best=2 → safe → 10
    expect(findSeekSampleIndex(refs, keys, 99)).toBe(10)
  })

  it('target before first key CTS still starts at first key', () => {
    const shifted = refs.map((r) => ({ ...r, tsUs: r.tsUs + 500_000 })) // keys at 0.5s, 1.5s, 2.5s
    const k = buildKeyIndices(shifted)
    expect(findSeekSampleIndex(shifted, k, 0.1)).toBe(0)
  })

  it('never returns sample 0 when a closer keyframe exists far into the file', () => {
    // 1 hour @ 30fps, key every 2s (60 frames) → ~1800 keys.
    // Old behaviour always reset to 0; new must pick near the target.
    const long = makeRefs(30 * 3600, 60, 30)
    const k = buildKeyIndices(long)
    const targetSec = 3500 // near end of hour
    const start = findSeekSampleIndex(long, k, targetSec)
    // Must not be 0. With B-frame retreat, about one GOP (~2s) before target.
    expect(start).toBeGreaterThan(0)
    // Start sample time should be within ~5s of target (2 GOPs of slack).
    const startSec = long[start]!.tsUs / 1e6
    expect(targetSec - startSec).toBeLessThan(5)
    expect(startSec).toBeLessThanOrEqual(targetSec)
  })

  it('simulates reverse-order export: late then early source time', () => {
    // Clip A reads source at 2.4s, then clip B needs 0.3s (backward jump).
    const afterLate = findSeekSampleIndex(refs, keys, 2.4)
    expect(afterLate).toBe(10) // mid 3rd GOP → key@10
    const afterEarly = findSeekSampleIndex(refs, keys, 0.3)
    // Mid first GOP → only key@0
    expect(afterEarly).toBe(0)
    // Critical: early seek is O(1) key pick, not "decode from 0 through 2.4"
    // (caller still only decodes from afterEarly forward).
    expect(afterEarly).toBeLessThan(afterLate)
  })

  it('PiP-style alternating source times each land near their own keyframe', () => {
    // Same asset, two in-points every frame: 0.5s and 2.5s.
    const a = findSeekSampleIndex(refs, keys, 0.5)
    const b = findSeekSampleIndex(refs, keys, 2.5)
    expect(a).toBe(0)
    expect(b).toBe(10)
    expect(a).not.toBe(b)
  })
})

describe('shouldRestartForward (forward jump past the fetch cursor)', () => {
  // 10 min @ 30fps, key every 2s (60 frames) → keys at 0, 60, 120, …
  const refs = makeRefs(30 * 600, 60, 30)
  const keys = buildKeyIndices(refs)

  it('steady playback never restarts: retreat keeps the restart point behind the cursor', () => {
    // Cursor prefetched a bit past the playhead at 100s (sample 3000).
    const cursor = 3020
    // Next frame, one GOP ahead, two GOPs ahead — all reachable sequentially
    // cheaper than (or equal to) a keyframe restart with one-GOP retreat.
    expect(shouldRestartForward(refs, keys, 100.033, cursor)).toBe(false)
    expect(shouldRestartForward(refs, keys, 102, cursor)).toBe(false)
    expect(shouldRestartForward(refs, keys, 104, cursor)).toBe(false)
  })

  it('clip boundary skipping minutes of source restarts near the target', () => {
    // Clip 1 ended at 100s (cursor ~ sample 3000); clip 2 starts at 500s.
    const cursor = 3000
    expect(shouldRestartForward(refs, keys, 500, cursor)).toBe(true)
    // And the restart point is within 2 GOPs of the target, not the cursor.
    const start = findSeekSampleIndex(refs, keys, 500)
    const startSec = refs[start]!.tsUs / 1e6
    expect(500 - startSec).toBeLessThanOrEqual(4)
    expect(start).toBeGreaterThan(cursor)
  })

  it('PiP alternation with far-apart in-points restarts on the way FORWARD too', () => {
    // Frame n: B at 10s reset the decoder → cursor sits just past 10s.
    const cursorAfterB = findSeekSampleIndex(refs, keys, 10) + 30
    // Frame n+1: A wants 300.033s — without the forward branch this decoded
    // ~290s of gap every exported frame.
    expect(shouldRestartForward(refs, keys, 300.033, cursorAfterB)).toBe(true)
  })

  it('gap smaller than the retreat window stays sequential', () => {
    // Cursor exactly at the 100s keyframe (sample 3000); target 3s ahead:
    // covering key = 102s, retreat → 100s = cursor → not strictly beyond.
    expect(shouldRestartForward(refs, keys, 103, 3000)).toBe(false)
  })

  it('end of stream: cursor past every sample never restarts', () => {
    expect(shouldRestartForward(refs, keys, 9999, refs.length)).toBe(false)
  })

  it('empty refs never restarts', () => {
    expect(shouldRestartForward([], [], 5, 0)).toBe(false)
  })
})

describe('findSeekSampleIndex edge cases', () => {
  it('handles a single-key stream', () => {
    const refs = makeRefs(10, 1000) // only sample 0 is key
    const keys = buildKeyIndices(refs)
    expect(keys).toEqual([0])
    expect(findSeekSampleIndex(refs, keys, 0)).toBe(0)
    expect(findSeekSampleIndex(refs, keys, 0.3)).toBe(0)
  })

  it('handles empty inputs safely', () => {
    expect(findSeekSampleIndex([], [], 1)).toBe(0)
  })
})
