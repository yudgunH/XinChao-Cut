import { afterEach, describe, it, expect, vi } from 'vitest'

import {
  BackendHttpError,
  adoptLocalAssetPath,
  clearCapabilitiesCache,
  getCapabilities,
  getExportStatus,
  hashBlob,
  isRetryableBackendPollError,
} from './client'

const CHUNK = 64 * 1024 * 1024

afterEach(() => {
  vi.useRealTimers()
  clearCapabilitiesCache()
  vi.unstubAllGlobals()
})

function blobOf(bytes: number, fill = 0): Blob {
  const u = new Uint8Array(bytes)
  u.fill(fill)
  return new Blob([u])
}

async function sha256Hex(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('hashBlob (fast path, <= 64MB)', () => {
  it('is deterministic for identical content', async () => {
    expect(await hashBlob(blobOf(1000, 7))).toBe(await hashBlob(blobOf(1000, 7)))
  })

  it('equals a plain SHA-256 of the file (back-compatible)', async () => {
    const b = blobOf(2048, 3)
    expect(await hashBlob(b)).toBe(await sha256Hex(b))
  })

  it('changes when content changes', async () => {
    expect(await hashBlob(blobOf(1000, 7))).not.toBe(await hashBlob(blobOf(1000, 8)))
  })

  it('returns 64 hex chars', async () => {
    expect(await hashBlob(blobOf(10))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('hashBlob (chunked path, > 64MB)', () => {
  it('is deterministic, valid hex, and differs from a plain SHA-256', async () => {
    const big = blobOf(CHUNK + 1024, 0) // 2 chunks → Merkle path
    const a = await hashBlob(big)
    const b = await hashBlob(blobOf(CHUNK + 1024, 0))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    // The 2-level hash is intentionally NOT the raw SHA-256 of the whole file.
    expect(a).not.toBe(await sha256Hex(big))
  })

  it('detects a change in the second chunk', async () => {
    const a = blobOf(CHUNK + 1024, 0)
    const u = new Uint8Array(CHUNK + 1024)
    u[CHUNK + 10] = 42 // marker in the 2nd chunk
    const b = new Blob([u])
    expect(await hashBlob(a)).not.toBe(await hashBlob(b))
  })

  it('honours AbortSignal between 64MB chunks (#19)', async () => {
    const big = blobOf(CHUNK * 2 + 100, 1)
    const ac = new AbortController()
    ac.abort()
    await expect(hashBlob(big, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('backend polling error policy', () => {
  it('retries transient HTTP, timeout and network failures', () => {
    expect(isRetryableBackendPollError(new BackendHttpError(503, 'busy'))).toBe(true)
    expect(isRetryableBackendPollError(new BackendHttpError(429, 'limited'))).toBe(true)
    expect(isRetryableBackendPollError(new DOMException('late', 'TimeoutError'))).toBe(true)
    expect(isRetryableBackendPollError(new TypeError('network down'))).toBe(true)
  })

  it('does not retry permanent HTTP or programming failures', () => {
    expect(isRetryableBackendPollError(new BackendHttpError(404, 'missing'))).toBe(false)
    expect(isRetryableBackendPollError(new BackendHttpError(422, 'invalid'))).toBe(false)
    expect(isRetryableBackendPollError(new Error('bad state'))).toBe(false)
  })

  it('export status preserves HTTP status for permanent-job detection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Job not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(getExportStatus('gone-job')).rejects.toMatchObject({
      name: 'BackendHttpError',
      status: 404,
      message: 'Job not found',
    })
  })
})

describe('desktop local-path asset adoption', () => {
  it('sends only the path metadata and returns the backend content hash', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        sourcePath: 'D:\\media\\long.mp4',
        filename: 'long.mp4',
      })
      return new Response(JSON.stringify({ hash: 'a'.repeat(64) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(adoptLocalAssetPath('D:\\media\\long.mp4', 'long.mp4')).resolves.toBe(
      'a'.repeat(64),
    )
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('backend runtime capability contract', () => {
  it('preserves encoder, FFmpeg, driver and CUDA diagnostics from /health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      capabilities: { media: true, export: true },
      runtime: {
        videoEncoder: 'h264_nvenc',
        videoEncoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: null },
        hdr10VideoEncoders: { hevc: 'hevc_nvenc', av1: null },
        ffmpeg: {
          available: true,
          path: 'C:/runtime/ffmpeg.exe',
          probePath: 'C:/runtime/ffprobe.exe',
          version: 'ffmpeg version 8.1.2',
        },
        gpuDriver: '591.86',
        cuda: { available: true, device: 'RTX 4070', loaded: false },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const caps = await getCapabilities()

    expect(caps?.runtime).toEqual({
      videoEncoder: 'h264_nvenc',
      videoEncoders: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', av1: null },
      hdr10VideoEncoders: { hevc: 'hevc_nvenc', av1: null },
      ffmpeg: {
        available: true,
        path: 'C:/runtime/ffmpeg.exe',
        probePath: 'C:/runtime/ffprobe.exe',
        version: 'ffmpeg version 8.1.2',
      },
      gpuDriver: '591.86',
      cuda: { available: true, device: 'RTX 4070', loaded: false, probing: false },
    })
  })

  it('refreshes an incomplete CUDA probe after one second instead of caching CPU-only', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-14T00:00:00Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: { media: true, export: true },
        runtime: {
          videoEncoder: null,
          ffmpeg: null,
          cuda: { available: false, device: null, loaded: false, probing: true },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: { media: true, export: true },
        runtime: {
          videoEncoder: 'h264_nvenc',
          ffmpeg: { available: true, path: 'ffmpeg', probePath: 'ffprobe', version: '8' },
          cuda: { available: true, device: 'RTX 3070 Ti', loaded: false, probing: false },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect((await getCapabilities())?.runtime?.cuda.probing).toBe(true)
    expect((await getCapabilities())?.runtime?.cuda.available).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1001)
    const completed = await getCapabilities()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(completed?.runtime?.cuda).toMatchObject({
      available: true,
      device: 'RTX 3070 Ti',
      probing: false,
    })
  })
})
