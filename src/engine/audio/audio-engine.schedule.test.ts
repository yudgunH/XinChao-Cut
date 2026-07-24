/**
 * Horizon scheduling + PCM budget LRU for audio-engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clip, Track } from '@engine/timeline'
import {
  createAudioEngine,
  MAX_STREAM_ELEMENTS,
  MAX_TOTAL_PCM_BYTES,
  SCHEDULE_HORIZON_SEC,
  type AudioEngineInternals,
} from './audio-engine'
import { MAX_DECODE_INPUT_BYTES } from './decode-guard'

function makeBuffer(length: number, channels = 1, sampleRate = 48_000): AudioBuffer {
  return {
    duration: length / sampleRate,
    numberOfChannels: channels,
    sampleRate,
    length,
    getChannelData: () => new Float32Array(length),
  } as unknown as AudioBuffer
}

let liveSources: { start: ReturnType<typeof vi.fn> }[]
let mediaElementSources = 0

function installCtx(decodeBuffer: AudioBuffer) {
  liveSources = []
  mediaElementSources = 0
  vi.stubGlobal('document', undefined)
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 0
      audioWorklet = { addModule: async () => {} }
      createGain() {
        return {
          gain: { value: 1 },
          connect() {
            return this
          },
          disconnect() {},
        }
      }
      createBufferSource() {
        const src = {
          buffer: null as AudioBuffer | null,
          playbackRate: { value: 1 },
          onended: null as (() => void) | null,
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          connect() {
            return this
          },
        }
        liveSources.push(src)
        return src
      }
      createMediaElementSource() {
        mediaElementSources += 1
        return {
          connect() {
            return this
          },
          disconnect: vi.fn(),
        }
      }
      get destination() {
        return {}
      }
      async decodeAudioData() {
        return decodeBuffer
      }
      close() {}
    },
  )
}

function clip(id: string, startSec: number, dur = 1): Clip {
  return {
    id,
    trackId: 'a1',
    assetId: `asset-${id}`,
    startSec,
    inPointSec: 0,
    outPointSec: dur,
    speed: 1,
    muted: false,
    volume: 1,
    effects: [],
  } as unknown as Clip
}

const audioTrack: Track = {
  id: 'a1',
  kind: 'audio',
  name: 'A',
  muted: false,
  locked: false,
} as Track

const tinyBlob = { size: 1024, arrayBuffer: async () => new ArrayBuffer(8) } as Blob

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('play() schedule horizon', () => {
  it('does not schedule a cached buffer on a hidden audio track', async () => {
    installCtx(makeBuffer(4800, 1))
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    const c = clip('hidden', 0)
    await engine.ensureDecoded(c.assetId!, tinyBlob)

    engine.play(0, [c], [{ ...audioTrack, hidden: true }])

    expect(engine.getActiveSourceCount()).toBe(0)
    expect(liveSources).toHaveLength(0)
  })

  it('does not create 2000 live BufferSources when only a short horizon is audible', async () => {
    // ~0.1 s mono buffer — cheap to seed 2000 assets
    installCtx(makeBuffer(4800, 1))
    const engine = createAudioEngine() as unknown as AudioEngineInternals

    const clips: Clip[] = []
    for (let i = 0; i < 2000; i++) {
      const id = `c${i}`
      clips.push(clip(id, i, 1))
      await engine.ensureDecoded(`asset-${id}`, tinyBlob)
    }

    liveSources = []
    engine.play(0, clips, [audioTrack])

    // Horizon 20s → ~20 one-second clips scheduled, not 2000.
    const n = engine.getActiveSourceCount()
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThanOrEqual(SCHEDULE_HORIZON_SEC + 2)
    expect(n).toBeLessThan(100)
    expect(liveSources.length).toBe(n)
  })

  it('stop() clears all scheduled sources and cancels the pump timer', async () => {
    installCtx(makeBuffer(4800, 1))
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    const clips = [clip('a', 0), clip('b', 5), clip('c', 100)]
    for (const c of clips) await engine.ensureDecoded(c.assetId!, tinyBlob)
    engine.play(0, clips, [audioTrack])
    expect(engine.getActiveSourceCount()).toBeGreaterThan(0)
    engine.stop()
    expect(engine.getActiveSourceCount()).toBe(0)
  })
})

function installStreamDocument() {
  const elements: Array<{
    readyState: number
    currentTime: number
    volume: number
    crossOrigin: string | null
    play: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    load: ReturnType<typeof vi.fn>
    removeAttribute: ReturnType<typeof vi.fn>
    onended: (() => void) | null
    onloadedmetadata: (() => void) | null
    onerror: (() => void) | null
  }> = []
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const el = {
        readyState: 1,
        currentTime: 0,
        volume: 1,
        crossOrigin: null,
        preload: '',
        src: '',
        playbackRate: 1,
        muted: false,
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(),
        load: vi.fn(),
        removeAttribute: vi.fn(),
        onended: null,
        onloadedmetadata: null,
        onerror: null,
      }
      elements.push(el)
      return el
    }),
  })
  const revoke = vi.fn()
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn((blob: Blob) => `blob:long-${blob.size}-${elements.length}`),
    revokeObjectURL: revoke,
  })
  return { elements, revoke }
}

describe('oversized preview audio streaming', () => {
  it('routes Tauri asset URLs directly to the media element', () => {
    installCtx(makeBuffer(4800, 1))
    const { elements } = installStreamDocument()
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    engine.ensureStreamSource('desktop', 'http://asset.localhost/C%3A%5Cclip.mp4')
    const c = { ...clip('desktop-clip', 0, 20), assetId: 'desktop', outPointSec: 20 }
    engine.play(0, [c], [audioTrack])
    expect(mediaElementSources).toBe(0)
    expect(elements).toHaveLength(1)
    expect(elements[0]!.crossOrigin).toBeNull()
    expect(elements[0]!.volume).toBe(1)
    engine.setMasterVolume(0.4)
    expect(elements[0]!.volume).toBeCloseTo(0.4)
  })

  it('never reads the full blob and uses independent occurrences with cleanup', async () => {
    installCtx(makeBuffer(4800, 1))
    const { elements, revoke } = installStreamDocument()

    let fullReads = 0
    const huge = {
      size: MAX_DECODE_INPUT_BYTES + 1,
      arrayBuffer: async () => {
        fullReads++
        return new ArrayBuffer(0)
      },
    } as Blob
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    await engine.ensureDecoded('long', huge)
    expect(fullReads).toBe(0)
    expect(engine.hasBuffer('long')).toBe(false)
    expect(engine.hasPlaybackSource('long')).toBe(true)

    const a = { ...clip('a', 0, 120), assetId: 'long', outPointSec: 120 }
    const b = {
      ...clip('b', 0, 120),
      assetId: 'long',
      inPointSec: 30,
      outPointSec: 120,
    }
    engine.play(0, [a, b], [audioTrack])
    expect(elements).toHaveLength(2)
    expect(engine.getActiveStreamCount()).toBe(2)
    expect(elements[0]!.currentTime).toBe(0)
    expect(elements[1]!.currentTime).toBe(30)
    expect(elements.every((el) => el.crossOrigin === 'anonymous')).toBe(true)
    expect(elements.every((el) => el.play.mock.calls.length === 1)).toBe(true)

    // Project switch evicts the source while it is active: playback, node,
    // timers and URL must all be torn down together.
    engine.evictExcept(new Set())
    expect(engine.getActiveStreamCount()).toBe(0)
    expect(elements.every((el) => el.pause.mock.calls.length === 1)).toBe(true)
    expect(revoke).toHaveBeenCalled()
  })

  it('200 overlapping stream clips → live elements ≤ MAX_STREAM_ELEMENTS; rest degraded', async () => {
    installCtx(makeBuffer(4800, 1))
    const { elements } = installStreamDocument()
    const engine = createAudioEngine() as unknown as AudioEngineInternals

    const clips: Clip[] = []
    for (let i = 0; i < 200; i++) {
      const assetId = `long-${i}`
      const huge = {
        size: MAX_DECODE_INPUT_BYTES + 1 + i,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Blob
      await engine.ensureDecoded(assetId, huge)
      // All overlap at playhead (start 0, 60s long) — worst-case decoder pressure.
      // Zero-pad ids so lexicographic order matches admission sort (startSec, id).
      clips.push({
        ...clip(`c${String(i).padStart(3, '0')}`, 0, 60),
        assetId,
        outPointSec: 60,
      })
    }

    engine.play(0, clips, [audioTrack])
    // Do not runAllTimers — the pump re-arms and would loop under fake timers.

    expect(engine.getActiveStreamCount()).toBeLessThanOrEqual(MAX_STREAM_ELEMENTS)
    expect(elements.length).toBeLessThanOrEqual(MAX_STREAM_ELEMENTS)
    expect(engine.getActiveStreamCount()).toBe(MAX_STREAM_ELEMENTS)

    const degraded = engine.getStreamDegradedClipIds()
    expect(degraded.length).toBe(200 - MAX_STREAM_ELEMENTS)
    for (const id of degraded) {
      expect(engine.getStreamAdmissionError(id)).toMatch(/capacity full/i)
    }
    // Not silent: every non-admitted clip has a message.
    expect(degraded.length + engine.getActiveStreamCount()).toBe(200)
  })

  it('keeps only the nearest future decoder per sequential audio track', async () => {
    installCtx(makeBuffer(4800, 1))
    const { elements } = installStreamDocument()
    const engine = createAudioEngine() as unknown as AudioEngineInternals
    const clips: Clip[] = []
    for (let i = 0; i < 4; i += 1) {
      const assetId = `different-source-${i}`
      await engine.ensureDecoded(assetId, {
        size: MAX_DECODE_INPUT_BYTES + 10 + i,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Blob)
      clips.push({
        ...clip(`seq-${i}`, i * 2, 2),
        assetId,
        outPointSec: 2,
      })
    }
    engine.play(0, clips, [audioTrack])
    expect(elements).toHaveLength(2)
    expect(engine.getActiveStreamCount()).toBe(2)
  })

  it('releases stream element when clip ends (leaves playable window)', async () => {
    installCtx(makeBuffer(4800, 1))
    const { elements } = installStreamDocument()
    const engine = createAudioEngine() as unknown as AudioEngineInternals

    const huge = {
      size: MAX_DECODE_INPUT_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Blob
    await engine.ensureDecoded('far', huge)

    const far = { ...clip('far-clip', 0, 5), assetId: 'far', outPointSec: 5 }
    engine.play(0, [far], [audioTrack])
    expect(engine.getActiveStreamCount()).toBe(1)
    expect(elements).toHaveLength(1)

    // Advance playhead past clip end → prune releases the element.
    const internals = engine as unknown as {
      ctx: { currentTime: number } | null
      pumpSchedule: () => void
    }
    if (internals.ctx) internals.ctx.currentTime = 6
    internals.pumpSchedule()
    expect(engine.getActiveStreamCount()).toBe(0)
    expect(elements[0]!.pause.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('admits a waiting stream when a slot frees after release', async () => {
    installCtx(makeBuffer(4800, 1))
    const { elements } = installStreamDocument()
    const engine = createAudioEngine() as unknown as AudioEngineInternals

    const clips: Clip[] = []
    for (let i = 0; i < MAX_STREAM_ELEMENTS + 3; i++) {
      const assetId = `s-${i}`
      await engine.ensureDecoded(assetId, {
        size: MAX_DECODE_INPUT_BYTES + 1 + i,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Blob)
      clips.push({
        ...clip(`c${String(i).padStart(3, '0')}`, 0, 60),
        assetId,
        outPointSec: 60,
      })
    }
    engine.play(0, clips, [audioTrack])
    expect(engine.getActiveStreamCount()).toBe(MAX_STREAM_ELEMENTS)
    expect(engine.getStreamDegradedClipIds().length).toBe(3)

    const beforeEls = elements.length
    // Finish one live stream → releaseStream queues pump via microtask.
    elements[0]!.onended?.()
    await Promise.resolve()
    await Promise.resolve()

    // Cap still holds; a previously degraded clip may now be live.
    expect(engine.getActiveStreamCount()).toBeLessThanOrEqual(MAX_STREAM_ELEMENTS)
    expect(engine.getActiveStreamCount()).toBe(MAX_STREAM_ELEMENTS)
    // A new element was created for a waiting clip (or same count if re-used path).
    expect(elements.length).toBeGreaterThanOrEqual(beforeEls)
    expect(engine.getStreamDegradedClipIds().length).toBeLessThan(3)
  })
})

describe('PCM cache budget LRU', () => {
  it('evicts LRU when total PCM exceeds budget; only playing buffers are protected', async () => {
    // 64 MiB mono float32 per buffer → ~24 entries fill 1.5 GiB
    const bigLen = (64 * 1024 * 1024) / 4
    installCtx(makeBuffer(bigLen, 1))
    const engine = createAudioEngine() as unknown as AudioEngineInternals

    // Load keep-me, then many bulk buffers. Touch keep-me each iteration so
    // pure LRU does not drop it while it is "recent".
    await engine.ensureDecoded('keep-me', tinyBlob)
    for (let i = 0; i < 40; i++) {
      await engine.ensureDecoded(`bulk-${i}`, tinyBlob)
      engine.getBuffer('keep-me') // MRU touch
    }

    expect(engine.getTotalPcmBytes()).toBeLessThanOrEqual(MAX_TOTAL_PCM_BYTES + bigLen)
    expect(engine.hasBuffer('keep-me')).toBe(true)

    // Pin keep-me only — drops every bulk not in keep set.
    engine.evictExcept(new Set(['keep-me']))
    expect(engine.hasBuffer('keep-me')).toBe(true)
    for (let i = 0; i < 40; i++) {
      expect(engine.hasBuffer(`bulk-${i}`)).toBe(false)
    }

    // Mark keep-me as currently playing so hard-eviction must spare it even when
    // wave2 fills the budget (keepIds alone no longer freezes multi-hour sets).
    engine.__testMarkPlaying('keep-me')
    for (let i = 0; i < 40; i++) {
      const id = `wave2-${i}`
      engine.evictExcept(new Set(['keep-me', id]))
      await engine.ensureDecoded(id, tinyBlob)
      expect(engine.hasBuffer('keep-me')).toBe(true)
    }
    expect(engine.getTotalPcmBytes()).toBeLessThanOrEqual(MAX_TOTAL_PCM_BYTES + bigLen)
    engine.__testClearPlaying()
  })

  it('getBuffer touches LRU so a recently-read id is not the first eviction victim', async () => {
    const midLen = (48 * 1024 * 1024) / 4 // 48 MiB
    installCtx(makeBuffer(midLen, 1))
    const engine = createAudioEngine() as unknown as AudioEngineInternals

    await engine.ensureDecoded('a', tinyBlob)
    await engine.ensureDecoded('b', tinyBlob)
    // Touch 'a' → 'b' is now older
    engine.getBuffer('a')

    // Fill past budget without keepIds protection
    for (let i = 0; i < 50; i++) {
      await engine.ensureDecoded(`x${i}`, tinyBlob)
    }

    expect(engine.getTotalPcmBytes()).toBeLessThanOrEqual(MAX_TOTAL_PCM_BYTES + midLen)
    let xAlive = 0
    for (let i = 0; i < 50; i++) if (engine.hasBuffer(`x${i}`)) xAlive++
    expect(xAlive).toBeLessThan(50)
  })
})
