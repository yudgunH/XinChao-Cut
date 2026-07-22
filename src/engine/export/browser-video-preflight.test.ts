import { describe, expect, it, vi } from 'vitest'

import type { MediaAsset } from '@engine/media'

import {
  browserVideoSlowWarning,
  browserVideoNormalizingWarning,
  findSlowBrowserVideoAssets,
  hasPathBackedVideoAssets,
  shouldUseMainThreadBrowserExport,
} from './browser-video-preflight'
import type { VideoSampleIndex } from './frame-reader'

function videoAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'video-1',
    kind: 'video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1_000,
    durationSec: 1,
    width: 16,
    height: 16,
    fps: 30,
    storageKey: 'video-1__clip.mp4',
    createdAt: 1,
    ...overrides,
  }
}

function sampleIndex(): VideoSampleIndex {
  return {
    codec: 'avc1.64001f',
    codedWidth: 16,
    codedHeight: 16,
    description: Uint8Array.of(1, 2, 3),
    offsets: Float64Array.of(128),
    sizes: Uint32Array.of(4),
    keyFlags: Uint8Array.of(1),
    tsUs: Float64Array.of(0),
    durUs: Float64Array.of(33_333),
    keyIndices: Uint32Array.of(0),
  }
}

describe('browser video WebCodecs preflight', () => {
  it('keeps sourcePath video on the worker path; only stream-encode forces main thread', () => {
    const pathAsset = videoAsset({ sourcePath: 'C:\\clip.mp4' })
    const blobAsset = videoAsset()
    expect(hasPathBackedVideoAssets([pathAsset])).toBe(true)
    expect(hasPathBackedVideoAssets([blobAsset])).toBe(false)
    // Path-backed video rides the worker's desktop-source proxy — it must NOT
    // fall back to the main thread, where the encode loop competes with the UI.
    expect(shouldUseMainThreadBrowserExport(false)).toBe(false)
    expect(shouldUseMainThreadBrowserExport(true)).toBe(true)
  })

  it('marks sourcePath slow when the desktop range bridge is unavailable', async () => {
    await expect(findSlowBrowserVideoAssets({
      assets: [videoAsset({ sourcePath: 'C:\\clip.mp4' })],
      getBlob: async () => null,
      createSampleIndex: async () => sampleIndex(),
      isConfigSupported: async () => ({ supported: true }),
    })).resolves.toEqual(['clip.mp4'])
  })

  it('passes a bounded desktop VideoByteSource into the parser and decoder probe', async () => {
    const read = vi.fn(async (_start: number, _end: number) =>
      Uint8Array.of(1, 2, 3, 4).buffer)
    const createSampleIndex = vi.fn(async (source) => {
      expect(source).not.toBeInstanceOf(Blob)
      if (source instanceof Blob) throw new Error('expected VideoByteSource')
      expect(source.size).toBe(10_000)
      await source.read(4_096, 8_192)
      return sampleIndex()
    })
    const isConfigSupported = vi.fn(async (config: VideoDecoderConfig) => {
      expect(config.codec).toBe('avc1.64001f')
      expect(config.description).toEqual(Uint8Array.of(1, 2, 3))
      return { supported: true, config }
    })
    await expect(findSlowBrowserVideoAssets({
      assets: [videoAsset({ sourcePath: 'C:\\clip.mp4' })],
      desktopVideoSource: {
        size: async () => 10_000,
        read: async (sourcePath, start, end) => {
          expect(sourcePath).toBe('C:\\clip.mp4')
          return read(start, end)
        },
      },
      getBlob: async () => null,
      createSampleIndex,
      isConfigSupported,
    })).resolves.toEqual([])
    expect(read).toHaveBeenCalledWith(4_096, 8_192)
  })

  it('warns when demux fails or VideoDecoder rejects the parsed config', async () => {
    const demuxSlow = videoAsset({ id: 'webm', name: 'clip.webm', mimeType: 'video/webm' })
    const codecSlow = videoAsset({ id: 'hevc', name: 'clip-hevc.mp4' })
    await expect(findSlowBrowserVideoAssets({
      assets: [demuxSlow, codecSlow],
      getBlob: async (assetId) => new Blob(
        [Uint8Array.of(1)],
        { type: assetId === 'webm' ? 'video/webm' : 'video/mp4' },
      ),
      createSampleIndex: async (source) => {
        if (source instanceof Blob && source.type === 'video/webm') {
          throw new Error('mp4box unsupported')
        }
        return sampleIndex()
      },
      isConfigSupported: async () => ({ supported: false }),
    })).resolves.toEqual(['clip.webm', 'clip-hevc.mp4'])
  })

  it('ignores incidental probe errors but preserves cancellation', async () => {
    await expect(findSlowBrowserVideoAssets({
      assets: [videoAsset()],
      getBlob: async () => {
        throw new Error('OPFS probe unavailable')
      },
      createSampleIndex: async () => sampleIndex(),
      isConfigSupported: async () => {
        throw new Error('capability probe failed')
      },
    })).resolves.toEqual([])

    await expect(findSlowBrowserVideoAssets({
      assets: [videoAsset()],
      getBlob: async () => new Blob([Uint8Array.of(1)]),
      createSampleIndex: async () => sampleIndex(),
      isConfigSupported: async () => {
        throw new Error('capability probe failed')
      },
    })).resolves.toEqual([])

    const abort = new AbortController()
    abort.abort()
    await expect(findSlowBrowserVideoAssets({
      assets: [videoAsset()],
      getBlob: async () => null,
      signal: abort.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('formats the server-online and backend-offline guidance', () => {
    expect(browserVideoSlowWarning(['clip.webm'], true)).toBe(
      '"clip.webm" cannot use the fast WebCodecs decoder — browser export will run at ~20fps. ' +
      'Switch to Server export for full speed on this file.',
    )
    expect(browserVideoSlowWarning(['clip.webm'], false)).toContain('Start the backend')
  })

  it('suggests waiting while backend normalization is still running', () => {
    expect(browserVideoNormalizingWarning([
      videoAsset({ normalizationStatus: 'running', normalizationProgress: 42 }),
    ], true)).toContain('Wait for normalization to finish')
  })
})
