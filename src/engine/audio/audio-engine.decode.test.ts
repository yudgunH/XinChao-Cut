/**
 * ensureDecoded memory discipline (P1):
 *  - refuses oversized sources BEFORE arrayBuffer()/decodeAudioData;
 *  - decodes one asset at a time (parallel decodes multiply peak RAM);
 *  - records WHY an asset produced no buffer instead of silently skipping it.
 *  - hard-evicts non-playing buffers under MAX_TOTAL_PCM_BYTES (keepIds no longer
 *    freezes multi-hour working sets in RAM forever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip, Track } from '@engine/timeline'

import {
  audibleAssetIdsInHorizon,
  createAudioEngine,
  MAX_TOTAL_PCM_BYTES,
  SCHEDULE_HORIZON_SEC,
  type AudioEngineInternals,
} from './audio-engine'
import { MAX_DECODE_INPUT_BYTES } from './decode-guard'

/** Blob stand-in: only `size` and `arrayBuffer` are touched. */
function fakeBlob(size: number, onRead?: () => void): Blob {
  return {
    size,
    arrayBuffer: async () => {
      onRead?.()
      return new ArrayBuffer(8)
    },
  } as unknown as Blob
}

let inFlight: number
let maxInFlight: number

beforeEach(() => {
  inFlight = 0
  maxInFlight = 0
  // No metadata probe in this environment → assertDecodable falls back to the
  // size gate alone, which is what we want to exercise here.
  vi.stubGlobal('document', undefined)
  vi.stubGlobal(
    'AudioContext',
    class {
      audioWorklet = { addModule: async () => {} }
      createGain() {
        return { gain: { value: 1 }, connect() {} }
      }
      get destination() {
        return {}
      }
      async decodeAudioData() {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return { duration: 1, numberOfChannels: 2, sampleRate: 48000, length: 48000 }
      }
      close() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ensureDecoded', () => {
  it('abort rejects the caller but does not overlap the next native decode', async () => {
    let calls = 0
    let finishFirst!: (buffer: AudioBuffer) => void
    const firstDecode = new Promise<AudioBuffer>((resolve) => { finishFirst = resolve })
    vi.stubGlobal(
      'AudioContext',
      class {
        audioWorklet = { addModule: async () => {} }
        createGain() { return { gain: { value: 1 }, connect() {} } }
        get destination() { return {} }
        decodeAudioData() {
          calls++
          if (calls === 1) return firstDecode
          return Promise.resolve({
            duration: 1,
            numberOfChannels: 2,
            sampleRate: 48_000,
            length: 48_000,
          } as AudioBuffer)
        }
        close() {}
      },
    )
    const engine = createAudioEngine()
    const ac = new AbortController()
    const stalled = engine.ensureDecoded('stalled', fakeBlob(1024), ac.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    ac.abort()

    await expect(stalled).rejects.toMatchObject({ name: 'AbortError' })
    const next = engine.ensureDecoded('next', fakeBlob(1024))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    finishFirst({
      duration: 1,
      numberOfChannels: 2,
      sampleRate: 48_000,
      length: 48_000,
    } as AudioBuffer)
    await next
    expect(calls).toBe(2)
    expect(engine.hasBuffer('stalled')).toBe(true)
    expect(engine.hasBuffer('next')).toBe(true)
  })

  it('refuses an oversized container without ever reading it', async () => {
    const engine = createAudioEngine()
    let wasRead = false
    const huge = fakeBlob(MAX_DECODE_INPUT_BYTES + 1, () => {
      wasRead = true
    })

    await engine.ensureDecoded('big', huge)

    expect(wasRead).toBe(false) // never called arrayBuffer()
    expect(engine.hasBuffer('big')).toBe(false)
    expect(engine.getDecodeError('big')).toMatch(/too large/i)
  })

  it('does not retry an asset it already refused', async () => {
    const engine = createAudioEngine()
    let reads = 0
    const huge = fakeBlob(MAX_DECODE_INPUT_BYTES + 1, () => {
      reads++
    })
    await engine.ensureDecoded('big', huge)
    await engine.ensureDecoded('big', huge)
    expect(reads).toBe(0)
  })

  it('decodes assets one at a time, never in parallel', async () => {
    const engine = createAudioEngine()
    const blobs = ['a', 'b', 'c', 'd'].map((id) => [id, fakeBlob(1024)] as const)

    // Fire them all at once, exactly like useAudioPlayback's pre-decode effect.
    await Promise.all(blobs.map(([id, b]) => engine.ensureDecoded(id, b)))

    expect(maxInFlight).toBe(1)
    for (const [id] of blobs) expect(engine.hasBuffer(id)).toBe(true)
  })

  it('records a decode failure and reports it, rather than failing silently', async () => {
    const engine = createAudioEngine()
    vi.stubGlobal(
      'AudioContext',
      class {
        audioWorklet = { addModule: async () => {} }
        createGain() {
          return { gain: { value: 1 }, connect() {} }
        }
        get destination() {
          return {}
        }
        async decodeAudioData(): Promise<never> {
          throw new Error('no audio track')
        }
        close() {}
      },
    )

    await engine.ensureDecoded('mute-video', fakeBlob(1024))

    expect(engine.hasBuffer('mute-video')).toBe(false)
    expect(engine.getDecodeError('mute-video')).toMatch(/no audio track/)
  })

  it('a late decode does not repopulate the cache after evictExcept', async () => {
    const engine = createAudioEngine()
    const pending = engine.ensureDecoded('old', fakeBlob(1024))
    // Project switch mid-decode: 'old' is no longer wanted.
    engine.evictExcept(new Set(['new']))
    await pending
    expect(engine.hasBuffer('old')).toBe(false)
  })

  it('an asset imported AFTER project load still decodes and commits', async () => {
    const engine = createAudioEngine()
    // Project opened: keep-set contains only the assets present at load time.
    engine.evictExcept(new Set(['loaded-asset']))

    // User imports new media into the open project and export/preview decodes it.
    await engine.ensureDecoded('imported-later', fakeBlob(1024))

    // The decoded buffer must commit (previously the load-time keep-set guard
    // silently discarded it: no buffer, no decodeError → export reported
    // "media data is missing" for a file that was right there).
    expect(engine.hasBuffer('imported-later')).toBe(true)
    expect(engine.getDecodeError('imported-later')).toBeNull()
  })
})

describe('path-backed stream registration', () => {
  it('plays a desktop URL without creating or revoking it as a Blob URL', () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { revokeObjectURL: revoke })
    const engine = createAudioEngine()

    engine.ensureStreamSource('desktop', 'http://asset.localhost/video.mp4')
    expect(engine.hasPlaybackSource('desktop')).toBe(true)
    expect(engine.hasBuffer('desktop')).toBe(false)

    engine.evictExcept(new Set())
    expect(engine.hasPlaybackSource('desktop')).toBe(false)
    expect(revoke).not.toHaveBeenCalled()
  })
})

describe('late "too large" completion after project switch (#2)', () => {
  /** A metadata probe we resolve by hand, so we can switch project mid-await. */
  function deferredProbe(): { fireDuration: (sec: number) => void } {
    let el: Record<string, unknown> | null = null
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:stream'),
      revokeObjectURL: vi.fn(),
    })
    vi.stubGlobal('document', {
      createElement: () => {
        el = { removeAttribute: () => {}, load: () => {}, duration: 0 }
        Object.defineProperty(el, 'src', { set() {} })
        return el
      },
    })
    return {
      fireDuration: (sec: number) => {
        if (!el) throw new Error('probe element not created yet')
        ;(el as { duration: number }).duration = sec
        ;(el.onloadedmetadata as (() => void) | undefined)?.()
      },
    }
  }

  /** Let the serialized decode task run up to the (pending) metadata probe. */
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('does not publish a stream URL for an asset evicted mid-probe', async () => {
    const probe = deferredProbe()
    const engine = createAudioEngine()
    // Small file (passes the size gate) → assertDecodable awaits the duration probe.
    const pending = engine.ensureDecoded('A', fakeBlob(20 * 1024 * 1024))
    await tick() // decodeOne now parked inside the pending probe
    // Project switch while the probe is still pending: A is no longer wanted.
    engine.evictExcept(new Set(['B']))
    // Probe resolves to a 3-hour duration → decoded PCM > budget → "too large".
    probe.fireDuration(3 * 60 * 60)
    await pending

    // No streaming source published for the abandoned asset, and the tell-tale
    // "bounded streaming" diagnostic (set right after streamUrls.set) never ran.
    expect(engine.hasPlaybackSource('A')).toBe(false)
    expect(engine.getDecodeError('A') ?? '').not.toMatch(/bounded streaming/)
  })

  it('does publish a stream URL when the asset is still wanted', async () => {
    const probe = deferredProbe()
    const engine = createAudioEngine()
    const pending = engine.ensureDecoded('A', fakeBlob(20 * 1024 * 1024))
    await tick()
    probe.fireDuration(3 * 60 * 60)
    await pending

    expect(engine.hasPlaybackSource('A')).toBe(true) // stream URL published
    expect(engine.getDecodeError('A') ?? '').toMatch(/bounded streaming/)
  })
})

describe('evictToBudget — hard-evict non-playing keepIds', () => {
  const halfGig = Math.floor(MAX_TOTAL_PCM_BYTES / 3) // ~0.5 GB each

  it('4× ~500MB buffers none playing → total returns under budget', () => {
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    // All in keepIds (open project working set) — old code refused to evict any.
    engine.evictExcept(new Set(['a', 'b', 'c', 'd']))
    engine.__testInjectBuffer('a', halfGig)
    engine.__testInjectBuffer('b', halfGig)
    engine.__testInjectBuffer('c', halfGig)
    engine.__testInjectBuffer('d', halfGig)
    expect(engine.getTotalPcmBytes()).toBeLessThanOrEqual(MAX_TOTAL_PCM_BYTES)
    // At least one victim dropped (4 × 0.5G would be ~2G > 1.5G).
    const live = ['a', 'b', 'c', 'd'].filter((id) => engine.hasBuffer(id))
    expect(live.length).toBeLessThan(4)
    expect(live.length).toBeGreaterThan(0)
  })

  it('currently playing buffer is never hard-evicted', () => {
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    engine.evictExcept(new Set(['play', 'cold1', 'cold2', 'cold3']))
    engine.__testInjectBuffer('play', halfGig)
    engine.__testMarkPlaying('play')
    engine.__testInjectBuffer('cold1', halfGig)
    engine.__testInjectBuffer('cold2', halfGig)
    engine.__testInjectBuffer('cold3', halfGig)
    expect(engine.hasBuffer('play')).toBe(true)
    expect(engine.getTotalPcmBytes()).toBeLessThanOrEqual(MAX_TOTAL_PCM_BYTES)
    engine.__testClearPlaying()
  })

  it('reserves PCM budget before decode instead of evicting only after commit', () => {
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    const quarter = Math.floor(MAX_TOTAL_PCM_BYTES / 4)
    engine.__testInjectBuffer('a', quarter)
    engine.__testInjectBuffer('b', quarter)
    engine.__testInjectBuffer('c', quarter)

    expect(engine.__testReserveForDecode(MAX_TOTAL_PCM_BYTES / 2)).toBe(true)

    expect(engine.getTotalPcmBytes()).toBeLessThanOrEqual(MAX_TOTAL_PCM_BYTES / 2)
  })

  it('defers a decode when live sources make the reservation impossible', () => {
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    const half = Math.floor(MAX_TOTAL_PCM_BYTES / 2)
    engine.__testInjectBuffer('playing', half)
    engine.__testMarkPlaying('playing')

    expect(engine.__testReserveForDecode(MAX_TOTAL_PCM_BYTES)).toBe(false)
    expect(engine.hasBuffer('playing')).toBe(true)
  })
})

describe('audibleAssetIdsInHorizon', () => {
  const tracks: Track[] = [
    { id: 'a1', kind: 'audio', name: 'A', muted: false, locked: false },
    { id: 'v1', kind: 'video', name: 'V', muted: false, locked: false },
  ]

  function clip(
    id: string,
    trackId: string,
    assetId: string,
    startSec: number,
    durationSec: number,
  ): Clip {
    return {
      id,
      trackId,
      assetId,
      startSec,
      durationSec,
      inPointSec: 0,
      outPointSec: durationSec,
      speed: 1,
      volume: 1,
      muted: false,
      effects: [],
    } as unknown as Clip
  }

  it('includes only assets with clips intersecting the horizon', () => {
    const clips = [
      clip('c-near', 'a1', 'near', 0, 5),
      clip('c-mid', 'a1', 'mid', 10, 5), // within 20s horizon from t=0
      clip('c-far', 'a1', 'far', 100, 5), // outside horizon
    ]
    const need = audibleAssetIdsInHorizon(clips, tracks, 0, SCHEDULE_HORIZON_SEC)
    expect(need.has('near')).toBe(true)
    expect(need.has('mid')).toBe(true)
    expect(need.has('far')).toBe(false)
  })

  it('excludes video-track assets (played via <video>, not WebAudio PCM)', () => {
    const clips = [clip('cv', 'v1', 'vid', 0, 10)]
    const need = audibleAssetIdsInHorizon(clips, tracks, 0)
    expect(need.size).toBe(0)
  })

  it('excludes clips that already ended before the playhead', () => {
    const clips = [clip('past', 'a1', 'old', 0, 5)]
    const need = audibleAssetIdsInHorizon(clips, tracks, 10)
    expect(need.has('old')).toBe(false)
  })
})
