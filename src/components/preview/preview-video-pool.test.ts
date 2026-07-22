import { describe, expect, it, vi } from 'vitest'

import {
  buildPreviewPlaybackKeyMap,
  PreviewVideoPool,
  activeVideoMappingKeys,
  sourceMappingKey,
} from './preview-video-pool'

type PlaybackClip = Parameters<typeof buildPreviewPlaybackKeyMap>[0][number]

function playbackClip(overrides: Partial<PlaybackClip> = {}): PlaybackClip {
  return {
    id: 'clip-a',
    trackId: 'video-1',
    assetId: 'asset-1',
    startSec: 0,
    inPointSec: 0,
    outPointSec: 2,
    speed: 1,
    ...overrides,
  }
}

function fakeElFactory() {
  let n = 0
  return () => {
    n += 1
    const el = {
      id: `el-${n}`,
      src: '',
      readyState: 2,
      paused: true,
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      removeAttribute: vi.fn(),
      getAttribute: vi.fn(() => null),
      addEventListener: vi.fn(),
    } as unknown as HTMLVideoElement
    return el
  }
}

describe('PreviewVideoPool mapping keys', () => {
  it('sourceMappingKey matches export: same map shares, different in-point diverges', () => {
    const a = { assetId: 'v1', startSec: 0, inPointSec: 0, speed: 1 }
    const b = { assetId: 'v1', startSec: 5, inPointSec: 5, speed: 1 } // same affine map
    const c = { assetId: 'v1', startSec: 0, inPointSec: 10, speed: 1 }
    expect(sourceMappingKey(a)).toBe(sourceMappingKey(b))
    expect(sourceMappingKey(a)).not.toBe(sourceMappingKey(c))
  })

  it('activeVideoMappingKeys collects unique maps', () => {
    const keys = activeVideoMappingKeys([
      { assetId: 'v1', startSec: 0, inPointSec: 0, speed: 1 },
      { assetId: 'v1', startSec: 0, inPointSec: 0, speed: 1 },
      { assetId: 'v1', startSec: 0, inPointSec: 8, speed: 1 },
    ])
    expect(keys.size).toBe(2)
  })
})

describe('buildPreviewPlaybackKeyMap', () => {
  it('shares one preview decoder across a source-continuous variable-speed run', () => {
    const clips = [
      playbackClip({ id: 'a', startSec: 0, inPointSec: 0, outPointSec: 4, speed: 2 }),
      playbackClip({ id: 'b', startSec: 2, inPointSec: 4, outPointSec: 6, speed: 0.5 }),
      playbackClip({ id: 'c', startSec: 6, inPointSec: 6, outPointSec: 10, speed: 4 }),
    ]

    const keys = buildPreviewPlaybackKeyMap(clips)
    expect(new Set(clips.map((clip) => keys.get(clip.id))).size).toBe(1)
    expect(keys.get('a')).toContain('preview-chain|asset=asset-1|track=video-1|first=a')
  })

  it('is independent of input order', () => {
    const first = playbackClip({ id: 'first', startSec: 0, inPointSec: 0, outPointSec: 2 })
    const second = playbackClip({ id: 'second', startSec: 2, inPointSec: 2, outPointSec: 4 })

    const forward = buildPreviewPlaybackKeyMap([first, second])
    const reversed = buildPreviewPlaybackKeyMap([second, first])
    expect(reversed).toEqual(forward)
  })

  it.each([
    {
      name: 'timeline gap',
      second: { startSec: 2.01, inPointSec: 2 },
    },
    {
      name: 'source cut',
      second: { startSec: 2, inPointSec: 3 },
    },
    {
      name: 'different asset',
      second: { startSec: 2, inPointSec: 2, assetId: 'asset-2' },
    },
  ])('keeps independent decoder keys across a $name', ({ second }) => {
    const first = playbackClip({ id: 'first', startSec: 0, inPointSec: 0, outPointSec: 2 })
    const next = playbackClip({ id: 'second', outPointSec: 4, ...second })

    const keys = buildPreviewPlaybackKeyMap([first, next])
    expect(keys.get(first.id)).toBe(sourceMappingKey(first))
    expect(keys.get(next.id)).toBe(sourceMappingKey(next))
    expect(keys.get(first.id)).not.toBe(keys.get(next.id))
  })

  it('does not form a chain across tracks', () => {
    const first = playbackClip({ id: 'first', startSec: 0, inPointSec: 0, outPointSec: 2 })
    const next = playbackClip({
      id: 'second',
      trackId: 'video-2',
      startSec: 2,
      inPointSec: 2,
      outPointSec: 4,
    })

    const keys = buildPreviewPlaybackKeyMap([first, next])
    // Their ordinary affine keys happen to match, which is safe: at every
    // timeline time they request the same source frame. The important part is
    // that neither receives a track-spanning preview-chain key.
    expect(keys.get(first.id)).toBe(sourceMappingKey(first))
    expect(keys.get(next.id)).toBe(sourceMappingKey(next))
    expect(keys.get(first.id)).not.toContain('preview-chain')
  })

  it('does not collide when a persistent first clip is replaced with another asset', () => {
    const oldRun = [
      playbackClip({ id: 'first', assetId: 'old', outPointSec: 2 }),
      playbackClip({ id: 'second', assetId: 'old', startSec: 2, inPointSec: 2, outPointSec: 4 }),
    ]
    const newRun = oldRun.map((clip) => ({ ...clip, assetId: 'new' }))

    expect(buildPreviewPlaybackKeyMap(oldRun).get('first')).not.toBe(
      buildPreviewPlaybackKeyMap(newRun).get('first'),
    )
  })
})

describe('PreviewVideoPool acquire / idle cap vs protected active set', () => {
  const hooks = {
    onFrame: () => {},
    onError: () => {},
  }

  it('gives distinct elements for concurrent different mappings of same asset', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(6, (url, _k, _h) => {
      const el = make()
      el.src = url
      return el
    })
    const protect = new Set(['k0', 'k1'])
    const el0 = pool.acquire('k0', 'assetA', 'blob:a', protect, hooks)
    const el1 = pool.acquire('k1', 'assetA', 'blob:a', protect, hooks)
    expect(el0).toBeTruthy()
    expect(el1).toBeTruthy()
    expect(el0).not.toBe(el1)
    expect(pool.keys().sort()).toEqual(['k0', 'k1'])
  })

  it('reuses the same element for the same mapping key', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(6, (url) => {
      const el = make()
      el.src = url
      return el
    })
    const protect = new Set(['k0'])
    const a = pool.acquire('k0', 'assetA', 'blob:a', protect, hooks)
    const b = pool.acquire('k0', 'assetA', 'blob:a', protect, hooks)
    expect(a).toBe(b)
    expect(pool.keys()).toHaveLength(1)
  })

  it('hands an idle decoder to the next mapping at a clip boundary', () => {
    const make = fakeElFactory()
    let creates = 0
    const reassign = vi.fn()
    const pool = new PreviewVideoPool(6, (url) => {
      creates += 1
      const el = make()
      el.src = url
      return el
    })
    const first = pool.acquire('map-before-cut', 'assetA', 'blob:a', new Set(['map-before-cut']), {
      ...hooks,
      onReassign: reassign,
    })
    const second = pool.acquire('map-after-cut', 'assetA', 'blob:a', new Set(['map-after-cut']), {
      ...hooks,
      onReassign: reassign,
    })

    expect(second).toBe(first)
    expect(creates).toBe(1)
    expect(pool.has('map-before-cut')).toBe(false)
    expect(pool.has('map-after-cut')).toBe(true)
    expect(reassign).toHaveBeenCalledWith('map-before-cut', 'map-after-cut', first)
  })

  it('never reassigns a decoder protected by an overlapping clip', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(6, (url) => {
      const el = make()
      el.src = url
      return el
    })
    const protectedKeys = new Set(['a', 'b'])
    const a = pool.acquire('a', 'assetA', 'blob:a', protectedKeys, hooks)
    const b = pool.acquire('b', 'assetA', 'blob:a', protectedKeys, hooks)
    expect(a).not.toBe(b)
    expect(pool.keys().sort()).toEqual(['a', 'b'])
  })

  it('evicts inactive LRU idle when over idle cap', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(2, (url) => {
      const el = make()
      el.src = url
      return el
    })
    // a,b were active, then c becomes the only protected key → a,b are idle.
    const p1 = new Set(['a', 'b'])
    pool.acquire('a', 'A', 'blob:1', p1, hooks)
    pool.acquire('b', 'B', 'blob:2', p1, hooks)
    const p2 = new Set(['c'])
    pool.acquire('c', 'C', 'blob:3', p2, hooks)
    expect(pool.has('c')).toBe(true)
    // Idle cap = 2: after acquiring c (protected), idle a+b may be trimmed to ≤2 total
    // with c protected — at most 2 idle kept; total can be 1 protected + ≤2 idle.
    pool.trimIdle(p2, hooks)
    const idle = pool.keys().filter((k) => k !== 'c')
    expect(idle.length).toBeLessThanOrEqual(2)
    expect(pool.has('c')).toBe(true)
  })

  it('7+ protected keys each get a DISTINCT element (never share, never null)', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(6, (url) => {
      const el = make()
      el.src = url
      return el
    })
    const n = 8
    const protect = new Set(Array.from({ length: n }, (_, i) => `k${i}`))
    const els: HTMLVideoElement[] = []
    for (let i = 0; i < n; i++) {
      const el = pool.acquire(`k${i}`, 'sameAsset', `blob:a`, protect, hooks)
      expect(el, `key k${i} must not be null`).toBeTruthy()
      els.push(el!)
    }
    // No two keys share the same object (the old sibling-reuse bug).
    const unique = new Set(els)
    expect(unique.size).toBe(n)
    expect(pool.keys()).toHaveLength(n)
    // Active overflow is allowed — size may exceed idle cap.
    expect(pool.keys().length).toBeGreaterThan(pool.max)
  })

  it('hard-caps protected active mappings and marks overflow degraded', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(
      2,
      (url) => {
        const el = make()
        el.src = url
        return el
      },
      3,
    )
    const protect = new Set(['a', 'b', 'c', 'd'])
    expect(pool.acquire('a', 'A', 'blob:a', protect, hooks)).toBeTruthy()
    expect(pool.acquire('b', 'B', 'blob:b', protect, hooks)).toBeTruthy()
    expect(pool.acquire('c', 'C', 'blob:c', protect, hooks)).toBeTruthy()
    expect(pool.acquire('d', 'D', 'blob:d', protect, hooks)).toBeNull()
    expect(pool.keys()).toHaveLength(3)
    expect(pool.degradedKeys()).toContain('d')
  })

  it('never returns another mapping element when create fails — null + degraded', () => {
    let n = 0
    const pool = new PreviewVideoPool(6, (url) => {
      n += 1
      if (n > 2) throw new Error('decoder limit')
      const el = {
        id: `el-${n}`,
        src: url,
        readyState: 2,
        paused: true,
        load: vi.fn(),
        pause: vi.fn(),
        play: vi.fn(),
        removeAttribute: vi.fn(),
        getAttribute: vi.fn(() => null),
        addEventListener: vi.fn(),
      } as unknown as HTMLVideoElement
      return el
    })
    const protect = new Set(['k0', 'k1', 'k2'])
    const e0 = pool.acquire('k0', 'A', 'blob:a', protect, hooks)
    const e1 = pool.acquire('k1', 'A', 'blob:a', protect, hooks)
    const e2 = pool.acquire('k2', 'A', 'blob:a', protect, hooks)
    expect(e0).toBeTruthy()
    expect(e1).toBeTruthy()
    expect(e2).toBeNull()
    // Must NOT have handed out e0/e1 for k2
    expect(e2).not.toBe(e0)
    expect(e2).not.toBe(e1)
    expect(pool.degradedKeys()).toContain('k2')
  })

  it('after leaving active set, trimIdle reclaims down to idle cap', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(6, (url) => {
      const el = make()
      el.src = url
      return el
    })
    const n = 8
    const all = new Set(Array.from({ length: n }, (_, i) => `k${i}`))
    for (let i = 0; i < n; i++) {
      expect(pool.acquire(`k${i}`, 'A', 'blob:a', all, hooks)).toBeTruthy()
    }
    expect(pool.keys()).toHaveLength(n)

    // All leave the playhead — everything is idle; keep at most `max`.
    const empty = new Set<string>()
    const disposed = pool.trimIdle(empty, hooks)
    expect(disposed.length).toBe(n - 6)
    expect(pool.keys()).toHaveLength(6)
  })

  it('partial leave: remaining protected keys stay; idle trimmed to cap', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(3, (url) => {
      const el = make()
      el.src = url
      return el
    })
    const all = new Set(['a', 'b', 'c', 'd', 'e'])
    for (const k of all) {
      pool.acquire(k, 'A', 'blob:a', all, hooks)
    }
    expect(pool.keys()).toHaveLength(5)

    // Keep a,b protected; c,d,e become idle → idle cap 3, so all 3 idle may stay
    // (idle count 3 ≤ max 3) → total 5. With max=3 idle, 3 idle + 2 protected = 5.
    const keep = new Set(['a', 'b'])
    pool.trimIdle(keep, hooks)
    expect(pool.has('a')).toBe(true)
    expect(pool.has('b')).toBe(true)
    const idle = pool.keys().filter((k) => !keep.has(k))
    expect(idle.length).toBeLessThanOrEqual(3)
  })

  it('disposeAsset removes all instances for that asset', () => {
    const make = fakeElFactory()
    const pool = new PreviewVideoPool(6, (url) => {
      const el = make()
      el.src = url
      return el
    })
    const p = new Set(['k0', 'k1'])
    pool.acquire('k0', 'A', 'blob:a', p, hooks)
    pool.acquire('k1', 'A', 'blob:a', p, hooks)
    pool.acquire('k2', 'B', 'blob:b', p, hooks)
    const removed = pool.disposeAsset('A')
    expect(removed.sort()).toEqual(['k0', 'k1'])
    expect(pool.has('k2')).toBe(true)
  })
})
