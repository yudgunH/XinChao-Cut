import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

import {
  DEFAULT_BROWSER_AUDIO_PEAK_BUDGET_BYTES,
  EXPORT_AUDIO_CHANNELS,
  EXPORT_AUDIO_SAMPLE_RATE,
  F32_BYTES,
  MIX_LIVE_COPIES,
  assertBrowserAudioWithinBudget,
  collectAudibleSourceEstimates,
  decideBrowserAudioRoute,
  estimateBrowserAudioPeakBytes,
  estimateEncodeBytes,
  mixBufferBytes,
  mixFrameCount,
  setBrowserAudioPeakBudgetBytes,
  BrowserAudioMemoryError,
} from './audio-memory'
import { renderAudioMix } from './exporter'

afterEach(() => {
  setBrowserAudioPeakBudgetBytes(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mixFrameCount / mixBufferBytes (formula primitives)', () => {
  it('frames = ceil(duration × sampleRate)', () => {
    expect(mixFrameCount(1, 48_000)).toBe(48_000)
    expect(mixFrameCount(1.5, 48_000)).toBe(72_000)
    expect(mixFrameCount(0, 48_000)).toBe(0)
    expect(mixFrameCount(-1, 48_000)).toBe(0)
  })

  it('one mix buffer = frames × channels × 4 (planar f32 stereo)', () => {
    // 1 s @ 48 kHz stereo f32 = 48000 * 2 * 4 = 384_000 B
    expect(mixBufferBytes(1)).toBe(48_000 * EXPORT_AUDIO_CHANNELS * F32_BYTES)
    expect(mixBufferBytes(1)).toBe(384_000)
  })
})

describe('estimateBrowserAudioPeakBytes', () => {
  it('peak = sources + mix×MIX_LIVE_COPIES + encode', () => {
    const durationSec = 10
    const oneMix = mixBufferBytes(durationSec)
    const sources = [
      { durationSec: 5, sampleRate: 48_000, channels: 2, knownBytes: 1000 },
    ]
    const est = estimateBrowserAudioPeakBytes({
      durationSec,
      sources,
      encode: 'none',
      budgetBytes: 10 * 1024 * 1024 * 1024,
    })
    expect(est.mixBufferBytes).toBe(oneMix)
    expect(est.mixLiveBytes).toBe(oneMix * MIX_LIVE_COPIES)
    expect(est.sourceBytes).toBe(1000)
    expect(est.encodeBytes).toBe(0)
    expect(est.peakBytes).toBe(1000 + oneMix * MIX_LIVE_COPIES)
    expect(est.formula).toContain(`×${MIX_LIVE_COPIES}`)
  })

  it('WAV encode adds int16 interleaved file buffer', () => {
    const durationSec = 2
    const frames = mixFrameCount(durationSec)
    expect(estimateEncodeBytes(durationSec, 'wav')).toBe(44 + frames * 2 * 2)
    const est = estimateBrowserAudioPeakBytes({
      durationSec,
      encode: 'wav',
      budgetBytes: Number.MAX_SAFE_INTEGER,
    })
    expect(est.encodeBytes).toBe(44 + frames * 2 * 2)
  })

  it('MP3 encode adds int16 L/R intermediate', () => {
    const durationSec = 2
    const frames = mixFrameCount(durationSec)
    expect(estimateEncodeBytes(durationSec, 'mp3')).toBe(frames * 2 * 2)
  })

  it('boundary: just under budget → overBudget false', () => {
    // Solve duration so peak (no sources) == budget - 1 is awkward; use fixed budget.
    const durationSec = 1
    const peak = mixBufferBytes(durationSec) * MIX_LIVE_COPIES
    const est = estimateBrowserAudioPeakBytes({
      durationSec,
      budgetBytes: peak, // peak == budget → not over (strict >)
    })
    expect(est.peakBytes).toBe(peak)
    expect(est.overBudget).toBe(false)
  })

  it('boundary: peak === budget is under (strict >); peak budget+1 is over', () => {
    const durationSec = 1
    const peak = mixBufferBytes(durationSec) * MIX_LIVE_COPIES
    expect(
      estimateBrowserAudioPeakBytes({ durationSec, budgetBytes: peak }).overBudget,
    ).toBe(false)
    expect(
      estimateBrowserAudioPeakBytes({ durationSec, budgetBytes: peak - 1 }).overBudget,
    ).toBe(true)
  })

  it('1 hour stereo mix alone exceeds default 512 MiB budget (explains long-form gate)', () => {
    // 3600 * 48000 * 2 * 4 = 1_382_400_000 ≈ 1.29 GiB per buffer × 3 copies
    const est = estimateBrowserAudioPeakBytes({ durationSec: 3600 })
    expect(est.mixBufferBytes).toBe(3600 * EXPORT_AUDIO_SAMPLE_RATE * EXPORT_AUDIO_CHANNELS * F32_BYTES)
    expect(est.peakBytes).toBeGreaterThan(DEFAULT_BROWSER_AUDIO_PEAK_BUDGET_BYTES)
    expect(est.overBudget).toBe(true)
  })

  it('short 30s timeline stays under default budget with no heavy sources', () => {
    const est = estimateBrowserAudioPeakBytes({ durationSec: 30 })
    expect(est.overBudget).toBe(false)
    expect(est.peakBytes).toBeLessThan(DEFAULT_BROWSER_AUDIO_PEAK_BUDGET_BYTES)
  })
})

describe('decideBrowserAudioRoute', () => {
  const over = estimateBrowserAudioPeakBytes({ durationSec: 3600 })
  const under = estimateBrowserAudioPeakBytes({ durationSec: 30 })

  it('over budget + streamingAvailable unlocks browser for video only', () => {
    const estimate = estimateBrowserAudioPeakBytes({
      durationSec: 2 * 3600,
      sources: [],
      encode: 'none',
    })
    expect(estimate.overBudget).toBe(true)
    const video = decideBrowserAudioRoute({
      estimate,
      serverAvailable: false,
      serverParityOk: true,
      purpose: 'video',
      streamingAvailable: true,
    })
    expect(video.action).toBe('browser')
    const audioFile = decideBrowserAudioRoute({
      estimate,
      serverAvailable: false,
      serverParityOk: true,
      purpose: 'audio-file',
      streamingAvailable: true,
    })
    expect(audioFile.action).toBe('block')
  })

  it('streaming does NOT unlock browser when source decode alone exceeds budget (#2)', () => {
    // Big source buffers (fully decoded up front) but a short mix — streaming
    // bounds the mix, not the source decode, so this must route away from browser.
    const estimate = estimateBrowserAudioPeakBytes({
      durationSec: 60,
      sources: [{ durationSec: 2 * 3600, sampleRate: 48_000, channels: 2 }],
      encode: 'none',
    })
    expect(estimate.overBudget).toBe(true)
    expect(estimate.sourceBytes).toBeGreaterThan(estimate.budgetBytes)
    // Server available → route to server rather than the OOM-prone browser path.
    const toServer = decideBrowserAudioRoute({
      estimate,
      serverAvailable: true,
      serverParityOk: true,
      purpose: 'video',
      streamingAvailable: true,
    })
    expect(toServer.action).toBe('server')
    // No server → block, never browser.
    const blocked = decideBrowserAudioRoute({
      estimate,
      serverAvailable: false,
      serverParityOk: true,
      purpose: 'video',
      streamingAvailable: true,
    })
    expect(blocked.action).toBe('block')
  })

  it('gates on the encoded container transient — big video + light audio blocks (#1 P0)', () => {
    // 3h video, tiny decoded audio, but a 6 GB container ensureDecoded reads whole.
    const estimate = estimateBrowserAudioPeakBytes({
      durationSec: 30,
      sources: [
        {
          durationSec: 30,
          sampleRate: 48_000,
          channels: 2,
          encodedBytes: 6 * 1024 * 1024 * 1024,
        },
      ],
      encode: 'none',
    })
    // Decoded PCM alone is tiny (~11 MB) but the container transient dominates.
    expect(estimate.decodeTransientBytes).toBe(6 * 1024 * 1024 * 1024)
    expect(estimate.overBudget).toBe(true)
    // Even with streaming, the container read alone busts the budget → not browser.
    const r = decideBrowserAudioRoute({
      estimate,
      serverAvailable: false,
      serverParityOk: true,
      purpose: 'video',
      streamingAvailable: true,
    })
    expect(r.action).toBe('block')
  })

  it('streaming still unlocks browser when only the mix (not sources) is over budget', () => {
    // Long timeline, small/no sources → mixLiveBytes dominates; streaming bounds it.
    const estimate = estimateBrowserAudioPeakBytes({
      durationSec: 2 * 3600,
      sources: [{ durationSec: 5, sampleRate: 48_000, channels: 2 }],
      encode: 'none',
    })
    expect(estimate.overBudget).toBe(true)
    expect(estimate.sourceBytes).toBeLessThan(estimate.budgetBytes)
    const r = decideBrowserAudioRoute({
      estimate,
      serverAvailable: true,
      serverParityOk: true,
      purpose: 'video',
      streamingAvailable: true,
    })
    expect(r.action).toBe('browser')
  })

  it('under budget always uses browser (video and audio-file)', () => {
    expect(
      decideBrowserAudioRoute({
        estimate: under,
        serverAvailable: false,
        serverParityOk: false,
        purpose: 'video',
      }).action,
    ).toBe('browser')
    expect(
      decideBrowserAudioRoute({
        estimate: under,
        serverAvailable: true,
        serverParityOk: true,
        purpose: 'audio-file',
      }).action,
    ).toBe('browser')
  })

  it('video + over budget + server available + parity → server', () => {
    const r = decideBrowserAudioRoute({
      estimate: over,
      serverAvailable: true,
      serverParityOk: true,
      purpose: 'video',
    })
    expect(r.action).toBe('server')
    if (r.action === 'server') {
      expect(r.reason.toLowerCase()).toMatch(/server|ffmpeg|offlineaudiocontext/)
    }
  })

  it('video + over budget + server unavailable → block with actionable message', () => {
    const r = decideBrowserAudioRoute({
      estimate: over,
      serverAvailable: false,
      serverParityOk: true,
      purpose: 'video',
    })
    expect(r.action).toBe('block')
    if (r.action === 'block') {
      expect(r.message).toMatch(/backend|offline|shorten/i)
      expect(r.message).not.toMatch(/silently|dropping audio|lower quality/i)
    }
  })

  it('video + over budget + server online but parity gap → block (no silent parity break)', () => {
    const r = decideBrowserAudioRoute({
      estimate: over,
      serverAvailable: true,
      serverParityOk: false,
      purpose: 'video',
    })
    expect(r.action).toBe('block')
    if (r.action === 'block') {
      expect(r.message).toMatch(/cannot match|approximate|effects/i)
    }
  })

  it('audio-file + over budget never routes to server (server is MP4-only)', () => {
    const r = decideBrowserAudioRoute({
      estimate: over,
      serverAvailable: true,
      serverParityOk: true,
      purpose: 'audio-file',
    })
    expect(r.action).toBe('block')
    if (r.action === 'block') {
      expect(r.message).toMatch(/MP3\/WAV|standalone/i)
    }
  })
})

describe('collectAudibleSourceEstimates (video+audio / audio-only)', () => {
  const tracks: Track[] = [
    { id: 'v1', kind: 'video', name: 'V', muted: false, locked: false },
    { id: 'a1', kind: 'audio', name: 'A', muted: false, locked: false },
    { id: 'a2', kind: 'audio', name: 'Muted', muted: true, locked: false },
  ]
  const assets: MediaAsset[] = [
    {
      id: 'vid', kind: 'video', name: 'v.mp4', mimeType: 'video/mp4',
      sizeBytes: 1, durationSec: 10, storageKey: 'k1', createdAt: 0, channels: 2,
    },
    {
      id: 'aud', kind: 'audio', name: 'a.wav', mimeType: 'audio/wav',
      sizeBytes: 1, durationSec: 8, storageKey: 'k2', createdAt: 0, sampleRate: 44100, channels: 1,
    },
    {
      id: 'silent', kind: 'audio', name: 's.wav', mimeType: 'audio/wav',
      sizeBytes: 1, durationSec: 8, storageKey: 'k3', createdAt: 0,
    },
  ]
  const clips: Clip[] = [
    {
      id: 'c1', trackId: 'v1', assetId: 'vid', kind: 'video',
      startSec: 0, inPointSec: 0, outPointSec: 10, speed: 1,
      opacity: 1, volume: 1,
    } as unknown as Clip,
    {
      id: 'c2', trackId: 'a1', assetId: 'aud', kind: 'audio',
      startSec: 0, inPointSec: 0, outPointSec: 8, speed: 1,
      opacity: 1, volume: 1,
    } as unknown as Clip,
    {
      id: 'c3', trackId: 'a2', assetId: 'silent', kind: 'audio',
      startSec: 0, inPointSec: 0, outPointSec: 8, speed: 1,
      opacity: 1, volume: 1,
    } as unknown as Clip,
  ]

  it('includes video-track + audio-track sources; skips muted tracks', () => {
    const src = collectAudibleSourceEstimates(clips, tracks, assets)
    const ids = src.map((s) => s.assetId).sort()
    expect(ids).toEqual(['aud', 'vid'])
    const aud = src.find((s) => s.assetId === 'aud')!
    expect(aud.sampleRate).toBe(44100)
    expect(aud.channels).toBe(1)
  })

  it('audio-only timeline still estimates sources', () => {
    const onlyAudio = clips.filter((c) => c.trackId === 'a1')
    const src = collectAudibleSourceEstimates(onlyAudio, tracks, assets)
    expect(src).toHaveLength(1)
    expect(src[0]!.assetId).toBe('aud')
  })
})

describe('assertBrowserAudioWithinBudget / renderAudioMix hard gate', () => {
  it('throws BrowserAudioMemoryError above budget without needing real audio', () => {
    expect(() => assertBrowserAudioWithinBudget(12 * 3600, [])).toThrow(BrowserAudioMemoryError)
  })

  it('12 hour timeline never constructs OfflineAudioContext', async () => {
    const ctor = vi.fn(function OfflineAudioContext() {
      throw new Error('OfflineAudioContext must not be constructed for 12h mix')
    })
    vi.stubGlobal('OfflineAudioContext', ctor)

    const tracks: Track[] = [
      { id: 'a1', kind: 'audio', name: 'A', muted: false, locked: false },
    ]
    const clips: Clip[] = [
      {
        id: 'c', trackId: 'a1', assetId: 'x', kind: 'audio',
        startSec: 0, inPointSec: 0, outPointSec: 1, speed: 1,
        opacity: 1, volume: 1,
      } as unknown as Clip,
    ]
    // Fake a tiny source buffer so audible filter passes, but duration is 12h.
    const fakeBuf = {
      duration: 1,
      length: 48_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array(48_000),
    } as unknown as AudioBuffer
    const buffers = new Map<string, AudioBuffer>([['x', fakeBuf]])

    await expect(
      renderAudioMix(12 * 3600, clips, tracks, buffers),
    ).rejects.toBeInstanceOf(BrowserAudioMemoryError)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('short timeline under budget reaches OfflineAudioContext constructor', async () => {
    let constructed = 0
    class FakeOAC {
      constructor(
        public channels: number,
        public length: number,
        public sampleRate: number,
      ) {
        constructed++
      }
      createBufferSource() {
        return {
          buffer: null as AudioBuffer | null,
          playbackRate: { value: 1 },
          connect() { return this },
          start() {},
        }
      }
      createGain() {
        return { gain: { value: 1 }, connect() { return this } }
      }
      get destination() { return {} }
      async startRendering() {
        return {
          duration: this.length / this.sampleRate,
          length: this.length,
          numberOfChannels: this.channels,
          sampleRate: this.sampleRate,
          getChannelData: () => new Float32Array(this.length),
        } as unknown as AudioBuffer
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOAC)

    const tracks: Track[] = [
      { id: 'a1', kind: 'audio', name: 'A', muted: false, locked: false },
    ]
    const clips: Clip[] = [
      {
        id: 'c', trackId: 'a1', assetId: 'x', kind: 'audio',
        startSec: 0, inPointSec: 0, outPointSec: 0.5, speed: 1,
        opacity: 1, volume: 1,
      } as unknown as Clip,
    ]
    const fakeBuf = {
      duration: 0.5,
      length: 24_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array(24_000),
    } as unknown as AudioBuffer

    const mix = await renderAudioMix(1, clips, tracks, new Map([['x', fakeBuf]]))
    expect(constructed).toBe(1)
    expect(mix).not.toBeNull()
    expect(mix!.length).toBe(48_000)
  })

  it('cancel escapes a stalled OfflineAudioContext render', async () => {
    class StalledOAC {
      createBufferSource() {
        return {
          buffer: null as AudioBuffer | null,
          playbackRate: { value: 1 },
          connect() { return this },
          start() {},
        }
      }
      createGain() {
        return { gain: { value: 1 }, connect() { return this } }
      }
      get destination() { return {} }
      startRendering(): Promise<AudioBuffer> {
        return new Promise(() => {})
      }
    }
    vi.stubGlobal('OfflineAudioContext', StalledOAC)
    const tracks: Track[] = [
      { id: 'a1', kind: 'audio', name: 'A', muted: false, locked: false },
    ]
    const clips: Clip[] = [{
      id: 'c', trackId: 'a1', assetId: 'x', kind: 'audio',
      startSec: 0, inPointSec: 0, outPointSec: 0.5, speed: 1,
      opacity: 1, volume: 1,
    } as unknown as Clip]
    const fakeBuf = {
      duration: 0.5,
      length: 24_000,
      numberOfChannels: 2,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array(24_000),
    } as unknown as AudioBuffer
    const ac = new AbortController()
    const render = renderAudioMix(1, clips, tracks, new Map([['x', fakeBuf]]), ac.signal)
    ac.abort()

    await expect(render).rejects.toMatchObject({ name: 'AbortError' })
  })
})
