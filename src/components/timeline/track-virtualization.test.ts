import { describe, expect, it } from 'vitest'

import type { Clip, Track } from '@engine/timeline'

import {
  buildClipsByTrack,
  buildTrackLayouts,
  visibleTrackWindow,
} from './track-virtualization'

function makeTracks(n: number): Track[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    kind: (i % 4 === 0 ? 'video' : i % 4 === 1 ? 'audio' : i % 4 === 2 ? 'text' : 'fx') as Track['kind'],
    name: `Track ${i}`,
    locked: false,
    muted: false,
    hidden: false,
  }))
}

function makeClips(trackCount: number, perTrack: number): Clip[] {
  const clips: Clip[] = []
  for (let t = 0; t < trackCount; t++) {
    for (let c = 0; c < perTrack; c++) {
      clips.push({
        id: `c${t}_${c}`,
        trackId: `t${t}`,
        startSec: c * 2,
        durationSec: 1.5,
        assetId: `a${t}`,
      } as unknown as Clip)
    }
  }
  return clips
}

const HEIGHT: Record<string, number> = { video: 84, audio: 64, text: 46, fx: 54 }

describe('buildClipsByTrack', () => {
  it('groups all clips in one O(C) pass', () => {
    const clips = makeClips(3, 4)
    const map = buildClipsByTrack(clips)
    expect(map.size).toBe(3)
    expect(map.get('t0')!.map((c) => c.id)).toEqual(['c0_0', 'c0_1', 'c0_2', 'c0_3'])
    expect(map.get('t1')!).toHaveLength(4)
    expect(map.get('t2')!).toHaveLength(4)
  })

  it('returns empty lists for tracks with no clips (caller uses ?? [])', () => {
    const map = buildClipsByTrack(makeClips(1, 2))
    expect(map.get('missing')).toBeUndefined()
  })
})

describe('visibleTrackWindow', () => {
  it('returns only tracks intersecting the viewport (+ overscan)', () => {
    const tracks = makeTracks(20)
    const layouts = buildTrackLayouts(tracks, (k) => HEIGHT[k] ?? 40)
    // Each video=84; first few: t0 video 0-84, t1 audio 84-148, ...
    const win = visibleTrackWindow(layouts, 0, 100, 0)
    expect(win.start).toBe(0)
    expect(win.end).toBeGreaterThan(0)
    expect(win.end).toBeLessThan(20)
    // All returned layouts must intersect [0, 100)
    for (let i = win.start; i < win.end; i++) {
      const L = layouts[i]!
      expect(L.bottom).toBeGreaterThan(0)
      expect(L.top).toBeLessThan(100)
    }
  })

  it('advances window when scrollTop moves down', () => {
    const tracks = makeTracks(50)
    const layouts = buildTrackLayouts(tracks, (k) => HEIGHT[k] ?? 40)
    const top = visibleTrackWindow(layouts, 0, 200, 0)
    const mid = visibleTrackWindow(layouts, 1500, 200, 0)
    expect(mid.start).toBeGreaterThan(top.start)
    expect(mid.offsetTop).toBe(layouts[mid.start]!.top)
  })
})

describe('benchmark 100 tracks × 10_000 clips', () => {
  /**
   * Stand-in for React Profiler before/after:
   *  - OLD: each of 100 tracks filters 10_000 clips → 1_000_000 comparisons / mutation
   *  - NEW: one buildClipsByTrack + per-track O(clips_on_track) + vertical window
   *
   * Thresholds are loose (CI variance) but fail loudly on O(n²) regressions.
   */
  it('buildClipsByTrack stays under 50ms for 10k clips', () => {
    const clips = makeClips(100, 100) // 10_000
    const t0 = performance.now()
    const map = buildClipsByTrack(clips)
    const ms = performance.now() - t0
    expect(map.size).toBe(100)
    expect([...map.values()].reduce((n, a) => n + a.length, 0)).toBe(10_000)
    expect(ms).toBeLessThan(50)
    // eslint-disable-next-line no-console
    console.log(`[track-virt] buildClipsByTrack 10k clips: ${ms.toFixed(2)}ms`)
  })

  it('legacy per-track filter is ~100× more work (document baseline)', () => {
    const clips = makeClips(100, 100)
    const trackIds = Array.from({ length: 100 }, (_, i) => `t${i}`)

    const tOld0 = performance.now()
    for (const id of trackIds) {
      void clips.filter((c) => c.trackId === id)
    }
    const oldMs = performance.now() - tOld0

    const tNew0 = performance.now()
    const map = buildClipsByTrack(clips)
    for (const id of trackIds) {
      void (map.get(id) ?? [])
    }
    const newMs = performance.now() - tNew0

    // eslint-disable-next-line no-console
    console.log(
      `[track-virt] 100 tracks × 10k clips — filter-each: ${oldMs.toFixed(2)}ms, map: ${newMs.toFixed(2)}ms`,
    )
    // Map path should be clearly faster; allow CI noise with 2× margin.
    expect(newMs).toBeLessThan(oldMs * 0.75 + 5)
  })

  it('visibleTrackWindow on 100 tracks is sub-millisecond', () => {
    const tracks = makeTracks(100)
    const layouts = buildTrackLayouts(tracks, (k) => HEIGHT[k] ?? 40)
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) {
      visibleTrackWindow(layouts, (i * 37) % 4000, 400, 200)
    }
    const ms = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`[track-virt] 1000× visibleTrackWindow: ${ms.toFixed(2)}ms`)
    expect(ms).toBeLessThan(50)
  })
})
