import { describe, expect, it, vi } from 'vitest'

import {
  AudioDecodeTooLargeError,
  MAX_DECODE_INPUT_BYTES,
  assertDecodable,
  assertDecodableSize,
} from './decode-guard'

/** A Blob stand-in — only `size` is read by the guard. */
function blobOfSize(size: number): Blob {
  return { size } as Blob
}

describe('assertDecodableSize (P0 #2 — gate before decodeAudioData)', () => {
  it('allows a source at or under the limit', () => {
    expect(() => assertDecodableSize(blobOfSize(MAX_DECODE_INPUT_BYTES))).not.toThrow()
    expect(() => assertDecodableSize(blobOfSize(10 * 1024 * 1024))).not.toThrow()
  })

  it('rejects a multi-GB container BEFORE any arrayBuffer/decode happens', () => {
    const size = 6 * 1024 * 1024 * 1024
    expect(() => assertDecodableSize(blobOfSize(size))).toThrow(AudioDecodeTooLargeError)
  })

  it('reports the actual size, the limit, and an actionable next step', () => {
    const size = 3 * 1024 * 1024 * 1024
    try {
      assertDecodableSize(blobOfSize(size), 'This video/audio')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AudioDecodeTooLargeError)
      const err = e as AudioDecodeTooLargeError
      expect(err.sizeBytes).toBe(size)
      expect(err.limitBytes).toBe(MAX_DECODE_INPUT_BYTES)
      expect(err.message).toMatch(/3\.00 GB/)
      expect(err.message).toMatch(/backend|trim|split/i)
    }
  })

  it('honours a caller-supplied limit', () => {
    expect(() => assertDecodableSize(blobOfSize(2048), 'x', 1024)).toThrow(
      AudioDecodeTooLargeError,
    )
    expect(() => assertDecodableSize(blobOfSize(512), 'x', 1024)).not.toThrow()
  })
})

describe('assertDecodable (size + probed decoded-PCM footprint)', () => {
  /** Fake the metadata probe: <video> resolves loadedmetadata with `duration`. */
  function stubProbe(duration: number | null) {
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:stub',
      revokeObjectURL: () => {},
    })
    vi.stubGlobal('document', {
      createElement: () => {
        const el: Record<string, unknown> = {
          removeAttribute: () => {},
          load: () => {},
          duration,
        }
        Object.defineProperty(el, 'src', {
          set() {
            queueMicrotask(() => {
              if (duration == null) (el.onerror as () => void)?.()
              else (el.onloadedmetadata as () => void)?.()
            })
          },
        })
        return el
      },
    })
  }

  it('blocks a SMALL file that decodes to a huge PCM buffer (60 min audio)', async () => {
    stubProbe(60 * 60) // 3600 s → 3600 × 48000 × 2 × 4 ≈ 1.29 GiB > 1.25 GiB
    // 55 MB on disk: the size gate alone would happily let this through.
    await expect(assertDecodable(blobOfSize(55 * 1024 * 1024))).rejects.toBeInstanceOf(
      AudioDecodeTooLargeError,
    )
    vi.unstubAllGlobals()
  })

  it('allows a short clip regardless of probe', async () => {
    stubProbe(120)
    await expect(assertDecodable(blobOfSize(20 * 1024 * 1024))).resolves.toEqual({
      inputBytes: 20 * 1024 * 1024,
      pcmBytes: 120 * 48_000 * 2 * 4,
    })
    vi.unstubAllGlobals()
  })

  it('honours a caller-specific decoded PCM budget', async () => {
    stubProbe(10 * 60) // ~220 MiB stereo PCM
    await expect(
      assertDecodable(blobOfSize(20 * 1024 * 1024), 'trim sample', {
        maxPcmBytes: 128 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(AudioDecodeTooLargeError)
    vi.unstubAllGlobals()
  })

  it('falls back to the size gate when duration cannot be probed', async () => {
    stubProbe(null)
    // Unprobeable but small → allowed (do not block a legitimate decode).
    await expect(assertDecodable(blobOfSize(10 * 1024 * 1024))).resolves.toEqual({
      inputBytes: 10 * 1024 * 1024,
      pcmBytes: null,
    })
    // Unprobeable but oversized container → still blocked by the size gate.
    await expect(
      assertDecodable(blobOfSize(6 * 1024 * 1024 * 1024)),
    ).rejects.toBeInstanceOf(AudioDecodeTooLargeError)
    vi.unstubAllGlobals()
  })
})
