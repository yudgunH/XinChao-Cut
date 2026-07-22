import { describe, expect, it } from 'vitest'

import type { Clip } from '@engine/timeline'

import type { VideoFrameReader } from './frame-reader'
import {
  ExportReaderPool,
  fetchActiveVideoFrames,
  sourceMappingKey,
  DEFAULT_MAX_EXPORT_READERS,
} from './reader-pool'

/** Mock reader that records seeks and counts backward resets (thrash signal). */
function mockReader(id: string) {
  let last = -Infinity
  let resets = 0
  let closed = false
  const calls: number[] = []
  const reader: VideoFrameReader = {
    async getFrameAt(sourceSec: number) {
      if (closed) throw new Error(`reader ${id} closed`)
      calls.push(sourceSec)
      if (sourceSec < last - 1e-3) resets++
      last = sourceSec
      // Stand-in "frame token" — distinct per source second (for layer parity).
      return {
        id,
        sourceSec,
        timestamp: Math.round(sourceSec * 1e6),
        close() {},
        clone() {
          return { id, sourceSec, timestamp: Math.round(sourceSec * 1e6), close() {}, clone() { return this } }
        },
      } as unknown as VideoFrame
    },
    close() {
      closed = true
    },
  }
  return {
    reader,
    get resets() {
      return resets
    },
    get calls() {
      return calls
    },
    get closed() {
      return closed
    },
    id,
  }
}

function clip(over: Partial<Clip> & { id: string; assetId: string }): Clip {
  return {
    startSec: 0,
    inPointSec: 0,
    outPointSec: 10,
    speed: 1,
    opacity: 1,
    volume: 1,
    muted: false,
    trackId: 'v1',
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

describe('sourceMappingKey', () => {
  it('is stable for the same affine map', () => {
    const a = clip({ id: 'a', assetId: 'vid', startSec: 0, inPointSec: 5, speed: 1 })
    const b = clip({ id: 'b', assetId: 'vid', startSec: 0, inPointSec: 5, speed: 1 })
    expect(sourceMappingKey(a)).toBe(sourceMappingKey(b))
  })

  it('differs when in-point / start / speed change the map', () => {
    const base = clip({ id: 'a', assetId: 'vid', startSec: 0, inPointSec: 0, speed: 1 })
    const far = clip({ id: 'b', assetId: 'vid', startSec: 0, inPointSec: 40, speed: 1 })
    const sped = clip({ id: 'c', assetId: 'vid', startSec: 0, inPointSec: 0, speed: 2 })
    expect(sourceMappingKey(base)).not.toBe(sourceMappingKey(far))
    expect(sourceMappingKey(base)).not.toBe(sourceMappingKey(sped))
  })

  it('two clips that align on the same source timeline share a key', () => {
    // start=10, in=5, speed=1 → intercept = 5 - 10 = -5
    // start=0, in=-5 would be invalid; use: start=2, in=0, speed=1 → b=-2
    // start=5, in=3, speed=1 → b=3-5=-2  → same intercept and speed
    const a = clip({ id: 'a', assetId: 'vid', startSec: 2, inPointSec: 0, speed: 1 })
    const b = clip({ id: 'b', assetId: 'vid', startSec: 5, inPointSec: 3, speed: 1 })
    expect(sourceMappingKey(a)).toBe(sourceMappingKey(b))
  })

  it('empty assetId → empty key', () => {
    expect(sourceMappingKey({ assetId: '', startSec: 0, inPointSec: 0, speed: 1 })).toBe('')
  })
})

describe('ExportReaderPool', () => {
  it('same mapping shares one reader (create once)', async () => {
    let creates = 0
    const m = mockReader('r0')
    const pool = new ExportReaderPool({
      maxReaders: 4,
      createReader: async () => {
        creates++
        return m.reader
      },
    })
    const key = sourceMappingKey(clip({ id: 'a', assetId: 'vid', inPointSec: 0 }))
    const a = await pool.acquire(key, 'vid')
    const b = await pool.acquire(key, 'vid')
    expect(a.reader).toBe(b.reader)
    expect(a.degraded).toBe(false)
    expect(creates).toBe(1)
    expect(pool.getStats().shareHits).toBeGreaterThanOrEqual(1)
    pool.closeAll()
  })

  it('two far source offsets use independent readers — no thrash', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 4,
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const near = clip({ id: 'near', assetId: 'vid', startSec: 0, inPointSec: 1, outPointSec: 11 })
    const far = clip({ id: 'far', assetId: 'vid', startSec: 0, inPointSec: 50, outPointSec: 60 })
    const kNear = sourceMappingKey(near)
    const kFar = sourceMappingKey(far)
    expect(kNear).not.toBe(kFar)

    // 30 export frames @ 30fps: both clips active, source times advance independently.
    for (let f = 0; f < 30; f++) {
      const t = f / 30
      await fetchActiveVideoFrames({
        pool,
        clips: [
          {
            id: near.id,
            assetId: 'vid',
            key: kNear,
            sourceSec: near.inPointSec + (t - near.startSec) * near.speed,
          },
          {
            id: far.id,
            assetId: 'vid',
            key: kFar,
            sourceSec: far.inPointSec + (t - far.startSec) * far.speed,
          },
        ],
        getFrame: async (reader, sec) => reader.getFrameAt(sec),
      })
    }

    expect(mocks.length).toBe(2)
    expect(mocks[0]!.resets + mocks[1]!.resets).toBe(0)
    // Each reader only saw monotonic-ish times in its own range.
    expect(mocks[0]!.calls.every((s) => s < 20)).toBe(true)
    expect(mocks[1]!.calls.every((s) => s >= 50)).toBe(true)
    pool.closeAll()
  })

  it('baseline thrash: one shared reader for two offsets resets every frame', async () => {
    // Documents F07 pre-S7 behaviour for the benchmark report.
    const m = mockReader('shared')
    for (let f = 0; f < 30; f++) {
      const t = f / 30
      await m.reader.getFrameAt(1 + t) // near
      await m.reader.getFrameAt(50 + t) // far → backward from prev on next frame
    }
    // After first pair, every subsequent near (1+t) is < last far (50+t) → reset.
    expect(m.resets).toBeGreaterThanOrEqual(29)
  })

  it('benchmark: pool path has 0 resets vs shared thrash on 60 frames', async () => {
    const frames = 60
    // Shared (pre-S7)
    const shared = mockReader('shared')
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) {
      const t = f / 30
      await shared.reader.getFrameAt(1 + t)
      await shared.reader.getFrameAt(50 + t)
    }
    const sharedMs = performance.now() - t0
    const sharedResets = shared.resets

    // Pool (S7)
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 4,
      createReader: async () => {
        const m = mockReader(`p${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const k1 = 'vid|s=1|b=1'
    const k2 = 'vid|s=1|b=50'
    const t1 = performance.now()
    for (let f = 0; f < frames; f++) {
      const t = f / 30
      await fetchActiveVideoFrames({
        pool,
        clips: [
          { id: 'a', assetId: 'vid', key: k1, sourceSec: 1 + t },
          { id: 'b', assetId: 'vid', key: k2, sourceSec: 50 + t },
        ],
        getFrame: async (r, sec) => r.getFrameAt(sec),
      })
    }
    const poolMs = performance.now() - t1
    const poolResets = mocks.reduce((n, m) => n + m.resets, 0)

    // eslint-disable-next-line no-console
    console.log(
      `[S7 benchmark] ${frames} frames dual-offset: ` +
        `shared resets=${sharedResets} (${sharedMs.toFixed(1)}ms) ` +
        `pool resets=${poolResets} (${poolMs.toFixed(1)}ms) creates=${pool.getStats().creates}`,
    )
    expect(sharedResets).toBeGreaterThanOrEqual(frames - 1)
    expect(poolResets).toBe(0)
    expect(pool.getStats().creates).toBe(2)
    pool.closeAll()
  })

  it('two layers get distinct frame tokens at far-apart source times', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const out = await fetchActiveVideoFrames({
      pool,
      clips: [
        { id: 'layer-a', assetId: 'vid', key: 'vid|s=1|b=0', sourceSec: 1.0 },
        { id: 'layer-b', assetId: 'vid', key: 'vid|s=1|b=40', sourceSec: 40.0 },
      ],
      getFrame: async (r, sec) => {
        const vf = await r.getFrameAt(sec)
        return { ts: (vf as unknown as { timestamp: number }).timestamp, readerId: (vf as unknown as { id: string }).id }
      },
    })
    const a = out.get('layer-a') as { ts: number; readerId: string }
    const b = out.get('layer-b') as { ts: number; readerId: string }
    expect(a.ts).toBe(1_000_000)
    expect(b.ts).toBe(40_000_000)
    expect(a.readerId).not.toBe(b.readerId)
    pool.closeAll()
  })

  it('releaseUnused closes readers when occurrence leaves active range', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const kA = 'vid|s=1|b=0'
    const kB = 'vid|s=1|b=30'
    await pool.acquire(kA, 'vid')
    await pool.acquire(kB, 'vid')
    expect(pool.getStats().size).toBe(2)
    // Only A remains active.
    pool.releaseUnused(new Set([kA]))
    expect(pool.getStats().size).toBe(1)
    expect(mocks[1]!.closed).toBe(true)
    expect(mocks[0]!.closed).toBe(false)
    expect(pool.getStats().releases).toBe(1)
    pool.closeAll()
    expect(mocks[0]!.closed).toBe(true)
  })

  it('keeps recently inactive mappings warm, then evicts them after the grace window', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      warmRetentionTicks: 3,
      createReader: async (assetId) => {
        const m = mockReader(`${assetId}-${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const a = 'a|s=1|b=0'
    const b = 'b|s=1|b=0'
    await pool.acquire(a, 'a')
    const b1 = await pool.acquire(b, 'b')

    pool.releaseUnused(new Set([a]))
    expect(pool.getStats().size).toBe(2)
    expect(pool.getStats().releases).toBe(0)
    expect(mocks[1]!.closed).toBe(false)

    // Re-activating the exact mapping reuses the warm decoder.
    const b2 = await pool.acquire(b, 'b')
    expect(b2.reader).toBe(b1.reader)
    expect(mocks.length).toBe(2)

    // Let b age out while a remains active.
    pool.releaseUnused(new Set([a]))
    pool.releaseUnused(new Set([a]))
    pool.releaseUnused(new Set([a]))
    pool.releaseUnused(new Set([a]))
    expect(mocks[1]!.closed).toBe(true)
    expect(pool.getStats().releases).toBe(1)
    pool.closeAll()
  })

  it('prewarms the exact next mapping without aliasing another decoder', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      createReader: async (assetId) => {
        const m = mockReader(`${assetId}-${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const first = 'vid|s=1|b=0'
    const next = 'vid|s=1|b=30'
    await pool.acquire(first, 'vid')
    expect(await pool.prewarm(next, 'vid')).toBe(true)
    expect(mocks.length).toBe(2)
    const acquired = await pool.acquire(next, 'vid')
    expect(acquired.degraded).toBe(false)
    expect(acquired.reader).toBe(mocks[1]!.reader)
    expect(mocks[0]!.closed).toBe(false)
    expect(pool.getStats().handoffs).toBe(0)
    pool.closeAll()
  })

  it('predecodes the first frame once and reuses that reader at the cut', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      warmRetentionTicks: 30,
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const currentKey = 'vid|s=1|b=0'
    const nextKey = 'vid|s=1|b=30'
    await pool.acquire(currentKey, 'vid')

    expect(await pool.prewarmFrame(nextKey, 'vid', 30)).toBe(true)
    expect(mocks.length).toBe(2)
    expect(mocks[1]!.calls).toEqual([30])
    expect(pool.getStats().framePrewarms).toBe(1)

    // The lookahead runs every output frame. A completed cut must not decode
    // the same first frame repeatedly while waiting to become active.
    expect(await pool.prewarmFrame(nextKey, 'vid', 30)).toBe(true)
    expect(mocks[1]!.calls).toEqual([30])
    expect(pool.getStats().framePrewarms).toBe(1)

    const next = await pool.acquire(nextKey, 'vid')
    expect(next.reader).toBe(mocks[1]!.reader)
    pool.closeAll()
  })

  it('declines frame prewarm when the mapping is only an alias of an active reader', async () => {
    const shared = mockReader('shared')
    const pool = new ExportReaderPool({
      maxReaders: 1,
      warmRetentionTicks: 30,
      createReader: async () => shared.reader,
    })
    const primaryKey = 'vid|s=1|b=0'
    const aliasKey = 'vid|s=1|b=30'
    await pool.acquire(primaryKey, 'vid')
    pool.releaseUnused(new Set([primaryKey]))
    const alias = await pool.acquire(aliasKey, 'vid')
    expect(alias.degraded).toBe(true)

    expect(await pool.prewarmFrame(aliasKey, 'vid', 30)).toBe(false)
    expect(shared.calls).toEqual([])
    expect(shared.closed).toBe(false)
    pool.closeAll()
  })

  it('does not leave a transient slot when speculative creates race for the cap', async () => {
    const releases: Array<(reader: VideoFrameReader) => void> = []
    const mocks = [mockReader('first'), mockReader('second')]
    const pool = new ExportReaderPool({
      maxReaders: 1,
      createReader: async () => new Promise<VideoFrameReader>((resolve) => {
        releases.push(resolve)
      }),
    })
    const first = pool.prewarm('a|s=1|b=0', 'a')
    const second = pool.prewarm('b|s=1|b=0', 'b')
    expect(releases).toHaveLength(2)

    releases[0]!(mocks[0]!.reader)
    await expect(first).resolves.toBe(true)
    releases[1]!(mocks[1]!.reader)
    await expect(second).resolves.toBe(false)
    expect(pool.isTransient('b|s=1|b=0')).toBe(false)
    expect(mocks[1]!.closed).toBe(true)
    pool.closeAll()
  })

  it('removes an exclusive speculative reader after first-frame decode fails', async () => {
    const failed = mockReader('failed')
    failed.reader.getFrameAt = async () => { throw new Error('decode failed') }
    const healthy = mockReader('healthy')
    let creates = 0
    const pool = new ExportReaderPool({
      maxReaders: 1,
      createReader: async () => creates++ === 0 ? failed.reader : healthy.reader,
    })
    const key = 'vid|s=1|b=30'

    expect(await pool.prewarmFrame(key, 'vid', 30)).toBe(false)
    expect(pool.hasPrimary(key)).toBe(false)
    expect(failed.closed).toBe(true)
    const acquired = await pool.acquire(key, 'vid')
    expect(acquired.reader).toBe(healthy.reader)
    expect(acquired.degraded).toBe(false)
    pool.closeAll()
  })

  it('times out and discards a stalled speculative first-frame decode', async () => {
    let releaseDecode!: () => void
    const gate = new Promise<void>((resolve) => { releaseDecode = resolve })
    const stalled = mockReader('stalled')
    stalled.reader.getFrameAt = async () => {
      await gate
      return null
    }
    const healthy = mockReader('healthy')
    let creates = 0
    const pool = new ExportReaderPool({
      maxReaders: 1,
      framePrewarmTimeoutMs: 20,
      createReader: async () => creates++ === 0 ? stalled.reader : healthy.reader,
    })
    const key = 'vid|s=1|b=30'

    await expect(pool.prewarmFrame(key, 'vid', 30)).resolves.toBe(false)
    expect(pool.hasPrimary(key)).toBe(false)
    expect(stalled.closed).toBe(true)
    const acquired = await pool.acquire(key, 'vid')
    expect(acquired.reader).toBe(healthy.reader)
    releaseDecode()
    pool.closeAll()
  })

  it('protects a frame-prewarm from release until its decode settles', async () => {
    let releaseDecode!: () => void
    let markStarted!: () => void
    const decodeGate = new Promise<void>((resolve) => { releaseDecode = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let nextClosed = false
    const current = mockReader('current')
    let creates = 0
    const pool = new ExportReaderPool({
      maxReaders: 2,
      createReader: async () => {
        if (creates++ === 0) return current.reader
        return {
          async getFrameAt(sourceSec: number) {
            markStarted()
            await decodeGate
            return { timestamp: sourceSec * 1e6, close() {} } as VideoFrame
          },
          close() { nextClosed = true },
        }
      },
    })
    const currentKey = 'vid|s=1|b=0'
    const nextKey = 'vid|s=1|b=30'
    await pool.acquire(currentKey, 'vid')
    const warming = pool.prewarmFrame(nextKey, 'vid', 30)
    await started

    pool.releaseUnused(new Set([currentKey]))
    expect(nextClosed).toBe(false)
    releaseDecode()
    await expect(warming).resolves.toBe(true)
    expect(pool.getStats().framePrewarms).toBe(1)
    pool.closeAll()
  })

  it('never aliases a reader whose background frame-prewarm is still decoding', async () => {
    let releaseDecode!: () => void
    let markStarted!: () => void
    const decodeGate = new Promise<void>((resolve) => { releaseDecode = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const prewarmCalls: number[] = []
    let vidCreates = 0
    const pool = new ExportReaderPool({
      maxReaders: 2,
      createReader: async (assetId) => {
        if (assetId !== 'vid' || vidCreates++ > 0) return mockReader(assetId).reader
        return {
          async getFrameAt(sourceSec: number) {
            prewarmCalls.push(sourceSec)
            markStarted()
            await decodeGate
            return { timestamp: sourceSec * 1e6, close() {} } as VideoFrame
          },
          close() {},
        }
      },
    })
    const otherKey = 'other|s=1|b=0'
    const prewarmKey = 'vid|s=1|b=30'
    const cutKey = 'vid|s=1|b=60'
    await pool.acquire(otherKey, 'other')
    pool.releaseUnused(new Set([otherKey]))
    const warming = pool.prewarmFrame(prewarmKey, 'vid', 30)
    await started

    // Pool full and nothing evictable: the only same-asset sibling is still
    // background-decoding. Acquire must take the transient overflow path — an
    // alias would run a second concurrent getFrameAt on that reader.
    const acquired = await pool.acquire(cutKey, 'vid')
    expect(acquired.degraded).toBe(true)
    expect(pool.isTransient(cutKey)).toBe(true)
    await acquired.reader.getFrameAt(60)
    expect(prewarmCalls).toEqual([30])

    releaseDecode()
    await expect(warming).resolves.toBe(true)
    pool.closeAll()
  })

  it('hands an inactive same-asset decoder to the next sequential mapping', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      warmRetentionTicks: 30,
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const oldKey = 'vid|s=1|b=0'
    const nextKey = 'vid|s=1|b=30'
    const old = await pool.acquire(oldKey, 'vid')
    pool.releaseUnused(new Set())

    expect(await pool.prewarm(nextKey, 'vid')).toBe(true)
    expect(mocks.length).toBe(1)
    expect(pool.hasPrimary(oldKey)).toBe(false)
    expect(pool.hasPrimary(nextKey)).toBe(true)
    expect(pool.getStats().handoffs).toBe(1)

    const next = await pool.acquire(nextKey, 'vid')
    expect(next.reader).toBe(old.reader)
    expect(next.degraded).toBe(false)
    pool.closeAll()
  })

  it('defers same-asset prewarm creation so the active reader can hand off at the cut', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      warmRetentionTicks: 30,
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    const currentKey = 'vid|s=1|b=0'
    const nextKey = 'vid|s=1|b=30'
    const current = await pool.acquire(currentKey, 'vid')

    // Current is still active: do not allocate a second decoder just to prewarm.
    expect(await pool.prewarm(nextKey, 'vid', { allowCreate: false })).toBe(false)
    expect(mocks.length).toBe(1)

    // At the cut current becomes inactive, so acquire rebinds it to nextKey.
    pool.releaseUnused(new Set([nextKey]))
    const next = await pool.acquire(nextKey, 'vid')
    expect(next.reader).toBe(current.reader)
    expect(pool.getStats().creates).toBe(1)
    expect(pool.getStats().handoffs).toBe(1)
    pool.closeAll()
  })

  it('closeAll on cancel/error path closes every reader', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
    })
    await pool.acquire('a|s=1|b=0', 'a')
    await pool.acquire('b|s=1|b=0', 'b')
    pool.closeAll()
    expect(mocks.every((m) => m.closed)).toBe(true)
    await expect(pool.acquire('c|s=1|b=0', 'c')).rejects.toThrow(/closed/)
  })

  it('pool limit: third distinct mapping degrades to sibling (no OOM create)', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const degraded: string[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      createReader: async () => {
        const m = mockReader(`r${mocks.length}`)
        mocks.push(m)
        return m.reader
      },
      onDegraded: (info) => degraded.push(info.reason),
    })
    const r1 = await pool.acquire('vid|s=1|b=0', 'vid')
    const r2 = await pool.acquire('vid|s=1|b=10', 'vid')
    expect(r1.degraded).toBe(false)
    expect(r2.degraded).toBe(false)
    expect(mocks.length).toBe(2)
    // Third mapping same asset → degraded reuse.
    const r3 = await pool.acquire('vid|s=1|b=20', 'vid')
    expect(r3.degraded).toBe(true)
    expect(mocks.length).toBe(2) // no third decoder
    expect(pool.getStats().degradedAcquires).toBe(1)
    expect(degraded.length).toBe(1)
    // Different asset with full pool → transient (no permanent 3rd live decoder).
    const rOther = await pool.acquire('other|s=1|b=0', 'other')
    expect(rOther.degraded).toBe(true)
    expect(pool.isTransient('other|s=1|b=0')).toBe(true)
    expect(pool.liveDecoderCount()).toBe(2)
    expect(pool.getStats().size).toBe(2)
    expect(pool.getStats().degradedAcquires).toBe(2)
    // getFrameAt opens then closes underlying reader.
    await rOther.reader.getFrameAt(0)
    expect(mocks.length).toBe(3)
    expect(mocks[2]!.closed).toBe(true)
    pool.closeAll()
    expect(mocks.every((m) => m.closed)).toBe(true)
  })

  it('7 distinct assets: live decoders ≤ maxReaders; 7th transient — no throw', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const degradedKeys: string[] = []
    const pool = new ExportReaderPool({
      maxReaders: DEFAULT_MAX_EXPORT_READERS, // 6
      createReader: async (assetId) => {
        const m = mockReader(assetId)
        mocks.push(m)
        return m.reader
      },
      onDegraded: (info) => degradedKeys.push(info.key),
    })

    const clips = Array.from({ length: 7 }, (_, i) => {
      const assetId = `asset${i}`
      return {
        id: `c${i}`,
        assetId,
        key: `${assetId}|s=1|b=0`,
        sourceSec: i * 0.1,
      }
    })

    const out = await fetchActiveVideoFrames({
      pool,
      clips,
      getFrame: async (r, sec) => r.getFrameAt(sec),
    })
    expect(out.size).toBe(7)
    // Permanent creates + transient opens, but live permanent size stays capped.
    expect(pool.getStats().creates).toBe(DEFAULT_MAX_EXPORT_READERS)
    expect(pool.liveDecoderCount()).toBeLessThanOrEqual(DEFAULT_MAX_EXPORT_READERS)
    expect(pool.getStats().size).toBe(DEFAULT_MAX_EXPORT_READERS)
    expect(pool.getStats().degradedAcquires).toBe(1)
    expect(pool.isTransient('asset6|s=1|b=0')).toBe(true)
    expect(degradedKeys[0]).toBe('asset6|s=1|b=0')
    // Transient open was closed after getFrameAt — not left alive.
    const transientMocks = mocks.filter((m) => m.id === 'asset6')
    expect(transientMocks.length).toBeGreaterThanOrEqual(1)
    expect(transientMocks.every((m) => m.closed)).toBe(true)

    pool.closeAll()
    expect(mocks.every((m) => m.closed)).toBe(true)
    await expect(pool.acquire('x|s=1|b=0', 'x')).rejects.toThrow(/closed/)
  })

  it('25 distinct assets active — live decoders ≤ cap; frames still distinct', async () => {
    const maxReaders = 6
    let peakLiveOpens = 0
    let openNow = 0
    const frames = new Map<string, number>()

    const pool = new ExportReaderPool({
      maxReaders,
      createReader: async (assetId) => {
        openNow++
        peakLiveOpens = Math.max(peakLiveOpens, openNow)
        let closed = false
        const reader = {
          async getFrameAt(sourceSec: number) {
            if (closed) throw new Error('closed')
            return {
              id: assetId,
              sourceSec,
              timestamp: Math.round(sourceSec * 1e6),
              close() {},
              clone() {
                return {
                  id: assetId,
                  sourceSec,
                  timestamp: Math.round(sourceSec * 1e6),
                  close() {},
                  clone() {
                    return this
                  },
                }
              },
            } as unknown as VideoFrame
          },
          close() {
            if (!closed) {
              closed = true
              openNow--
            }
          },
        }
        return reader
      },
    })

    const clips = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`,
      assetId: `a${i}`,
      key: `a${i}|s=1|b=0`,
      sourceSec: i + 0.5,
    }))

    const out = await fetchActiveVideoFrames({
      pool,
      clips,
      getFrame: async (r, sec, clipId) => {
        const vf = await r.getFrameAt(sec)
        frames.set(clipId, (vf as unknown as { sourceSec: number }).sourceSec)
        return vf
      },
    })

    expect(out.size).toBe(25)
    expect(pool.liveDecoderCount()).toBeLessThanOrEqual(maxReaders)
    expect(pool.getStats().size).toBeLessThanOrEqual(maxReaders)
    // Peak simultaneous opens: permanent slots + at most one transient in-flight.
    expect(peakLiveOpens).toBeLessThanOrEqual(maxReaders + 1)
    // Frame identity preserved per clip.
    for (let i = 0; i < 25; i++) {
      expect(frames.get(`c${i}`)).toBeCloseTo(i + 0.5, 5)
    }
    pool.closeAll()
    expect(openNow).toBe(0)
  })

  it('evicts inactive slot before soft-expand when active set leaves room', async () => {
    const mocks: ReturnType<typeof mockReader>[] = []
    const pool = new ExportReaderPool({
      maxReaders: 2,
      createReader: async (assetId) => {
        const m = mockReader(assetId)
        mocks.push(m)
        return m.reader
      },
    })
    await pool.acquire('a|s=1|b=0', 'a')
    await pool.acquire('b|s=1|b=0', 'b')
    // Only b+c active next frame → release a, create c as primary (not degraded).
    pool.releaseUnused(new Set(['b|s=1|b=0', 'c|s=1|b=0']))
    const c = await pool.acquire('c|s=1|b=0', 'c')
    expect(c.degraded).toBe(false)
    expect(pool.hasPrimary('c|s=1|b=0')).toBe(true)
    expect(mocks[0]!.closed).toBe(true) // a evicted
    expect(pool.getStats().degradedAcquires).toBe(0)
    pool.closeAll()
  })

  it('throws only when createReader fails (clear message)', async () => {
    const pool = new ExportReaderPool({
      maxReaders: 1,
      createReader: async () => {
        throw new Error('demux boom')
      },
    })
    await expect(pool.acquire('a|s=1|b=0', 'a')).rejects.toThrow(
      /failed to create reader for asset a.*demux boom/,
    )
    pool.closeAll()
  })

  it('does not create a new reader every output frame', async () => {
    let creates = 0
    const pool = new ExportReaderPool({
      createReader: async () => {
        creates++
        return mockReader(`r${creates}`).reader
      },
    })
    const key = 'vid|s=1|b=0'
    for (let f = 0; f < 100; f++) {
      await fetchActiveVideoFrames({
        pool,
        clips: [{ id: 'c', assetId: 'vid', key, sourceSec: f / 30 }],
        getFrame: async (r, sec) => r.getFrameAt(sec),
      })
    }
    expect(creates).toBe(1)
    pool.closeAll()
  })

  it('default max is positive budget', () => {
    expect(DEFAULT_MAX_EXPORT_READERS).toBeGreaterThanOrEqual(2)
  })
})

describe('S7 fixture: dual-layer frame markers (synthetic)', () => {
  /**
   * Stand-in for a real marker video: each source second maps to a unique
   * 32-bit fingerprint. Dual-layer export must keep two different fingerprints
   * when offsets differ — the same property a painted frame-number video would
   * show by eye / frame hash.
   */
  function markerFingerprint(sourceSec: number): number {
    // Distinct, stable, non-colliding for whole seconds 0..3600.
    return (Math.floor(sourceSec * 1000) * 2654435761) >>> 0
  }

  it('two overlapping occurrences with far offsets produce different layer hashes', async () => {
    const pool = new ExportReaderPool({
      createReader: async (assetId) => mockReader(assetId).reader,
    })
    const hashes: Array<{ a: number; b: number }> = []
    for (let f = 0; f < 15; f++) {
      const t = f / 30
      const out = await fetchActiveVideoFrames({
        pool,
        clips: [
          { id: 'full', assetId: 'marker', key: 'marker|s=1|b=0', sourceSec: 0 + t },
          { id: 'pip', assetId: 'marker', key: 'marker|s=1|b=5', sourceSec: 5 + t },
        ],
        getFrame: async (r, sec) => {
          await r.getFrameAt(sec)
          return markerFingerprint(sec)
        },
      })
      hashes.push({ a: out.get('full') as number, b: out.get('pip') as number })
    }
    for (const h of hashes) {
      expect(h.a).not.toBe(h.b)
    }
    // Monotonic independence: layer B always maps ~5s ahead of A.
    expect(hashes[0]!.b).toBe(markerFingerprint(5))
    expect(hashes[0]!.a).toBe(markerFingerprint(0))
    pool.closeAll()
  })
})
