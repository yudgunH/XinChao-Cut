import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ZERO_COPY_REPORT_SCHEMA,
  ZERO_COPY_REPORT_STORAGE_KEY,
  buildZeroCopyEnvironment,
  compareDecodedPixelSamples,
  hasZeroCopyCoverage,
  hasSustainedZeroCopyCoverage,
  loadZeroCopyReport,
  matrixVerdict,
  runZeroCopyMatrix,
  saveZeroCopyReport,
  zeroCopyCompatibility,
  type CapturedPixelSample,
  type ZeroCopyCaseResult,
  type ZeroCopyMatrixReport,
} from './zero-copy-self-test'

function result(status: ZeroCopyCaseResult['status'], safe = true): ZeroCopyCaseResult {
  return {
    id: 'h264-1080p30',
    codec: 'h264',
    actualCodec: 'h264',
    encoderCodec: 'avc1.640034',
    width: 1920,
    height: 1080,
    fps: 30,
    frames: 45,
    status,
    safe: {
      ok: safe,
      elapsedMs: 1000,
      encodedChunks: safe ? 45 : 0,
      maxQueue: 3,
      fps: safe ? 45 : 0,
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('zero-copy compatibility report', () => {
  it('requires the core H.264 1080p30 direct path for a verified verdict', () => {
    expect(matrixVerdict([result('active')])).toBe('verified')
    expect(matrixVerdict([result('fallback')])).toBe('fallback')
    expect(matrixVerdict([result('failed', false)])).toBe('failed')
  })

  it('keys the report by WebView, driver and adapter identity', () => {
    const a = buildZeroCopyEnvironment(
      'Mozilla/5.0 Edg/150.0.4078.65',
      '591.86',
      { vendor: 'nvidia', architecture: 'ampere', device: '2482', description: 'RTX', isFallbackAdapter: false },
    )
    const b = buildZeroCopyEnvironment(
      'Mozilla/5.0 Edg/150.0.4078.65',
      '592.00',
      { vendor: 'nvidia', architecture: 'ampere', device: '2482', description: 'RTX', isFallbackAdapter: false },
    )
    expect(a.webViewVersion).toBe('150.0.4078.65')
    expect(a.runtimeKey).not.toBe(b.runtimeKey)
  })

  it('invalidates cached results when WebView or driver changes', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    const report: ZeroCopyMatrixReport = {
      schemaVersion: ZERO_COPY_REPORT_SCHEMA,
      // This case tests runtime identity, not expiry. Keep it current so the
      // seven-day cache TTL cannot turn the assertion into a calendar failure.
      createdAt: new Date().toISOString(),
      environment: buildZeroCopyEnvironment('Edg/150.0.4078.65', '591.86', null),
      verdict: 'verified',
      cases: [result('active')],
    }
    saveZeroCopyReport(report)
    expect(values.has(ZERO_COPY_REPORT_STORAGE_KEY)).toBe(true)
    expect(loadZeroCopyReport({ userAgent: 'Edg/150.0.4078.65', gpuDriver: '591.86' })).toEqual(report)
    expect(loadZeroCopyReport({
      userAgent: 'Edg/150.0.4078.65',
      gpuDriver: '591.86',
      adapter: null,
    })).toEqual(report)
    expect(loadZeroCopyReport({
      userAgent: 'Edg/150.0.4078.65',
      gpuDriver: '591.86',
      adapter: {
        vendor: 'nvidia',
        architecture: 'ada',
        device: '2860',
        description: 'RTX 4070',
        isFallbackAdapter: false,
      },
    })).toBeNull()
    expect(loadZeroCopyReport({ userAgent: 'Edg/151.0.0.0', gpuDriver: '591.86' })).toBeNull()
    expect(loadZeroCopyReport({ userAgent: 'Edg/150.0.4078.65', gpuDriver: '592.00' })).toBeNull()
  })

  it('matches compatibility by codec, exact output size and frame rate', () => {
    const report: ZeroCopyMatrixReport = {
      schemaVersion: ZERO_COPY_REPORT_SCHEMA,
      createdAt: '2026-07-13T00:00:00.000Z',
      environment: buildZeroCopyEnvironment('Edg/150.0.4078.65', null, null),
      verdict: 'verified',
      cases: [result('active')],
    }
    expect(zeroCopyCompatibility(report, 'h264', 1920, 1080, 30)).toBe('active')
    expect(zeroCopyCompatibility(report, 'h264', 2520, 1080, 30)).toBe('untested')
    expect(zeroCopyCompatibility(report, 'hevc', 1920, 1080, 30)).toBe('untested')
    expect(zeroCopyCompatibility(report, 'h264', 3840, 2160, 30)).toBe('untested')
  })

  it('requires a sustained covering case before admitting zero-copy export', () => {
    const shortCase = result('active')
    const report: ZeroCopyMatrixReport = {
      schemaVersion: ZERO_COPY_REPORT_SCHEMA,
      createdAt: '2026-07-13T00:00:00.000Z',
      environment: buildZeroCopyEnvironment('Edg/150.0.4078.65', null, null),
      verdict: 'verified',
      cases: [shortCase],
    }
    expect(hasZeroCopyCoverage(report, 'h264', 608, 1080, 30)).toBe(true)
    expect(hasSustainedZeroCopyCoverage(report, 'h264', 608, 1080, 30)).toBe(false)

    report.cases = [{ ...shortCase, frames: 450 }]
    expect(hasSustainedZeroCopyCoverage(report, 'h264', 608, 1080, 30)).toBe(true)
    expect(hasSustainedZeroCopyCoverage(report, 'h264', 1080, 1920, 30)).toBe(true)
    expect(hasSustainedZeroCopyCoverage(report, 'h264', 2160, 3840, 30)).toBe(false)
    expect(hasSustainedZeroCopyCoverage(report, 'h264', 1080, 1920, 60)).toBe(false)
    expect(hasSustainedZeroCopyCoverage(report, 'av1', 608, 1080, 30)).toBe(false)
  })

  it('rejects stale and visibly different decoded direct frames', () => {
    const sample = (
      timestamp: number,
      value: number,
      meanLuma: number,
    ): CapturedPixelSample => ({
      timestamp,
      meanLuma,
      variance: 100,
      hash: String(value),
      pixels: new Uint8ClampedArray([value, value, value, 255, value, value, value, 255]),
    })
    const safe = [sample(0, 40, 40), sample(1_000, 120, 120)]
    expect(compareDecodedPixelSamples(safe, [sample(0, 40, 40), sample(1_000, 120, 120)]).ok).toBe(true)
    expect(compareDecodedPixelSamples(safe, [sample(0, 40, 40), sample(1_000, 40, 40)])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('stale'),
    })
    expect(compareDecodedPixelSamples(safe, [sample(0, 90, 90), sample(1_000, 180, 180)]).ok).toBe(false)
  })

  it('expires old reports even when the runtime identity still matches', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    saveZeroCopyReport({
      schemaVersion: ZERO_COPY_REPORT_SCHEMA,
      createdAt: '2020-01-01T00:00:00.000Z',
      environment: buildZeroCopyEnvironment('Edg/150.0.4078.65', '591.86', null),
      verdict: 'verified',
      cases: [result('active')],
    })
    expect(loadZeroCopyReport({ userAgent: 'Edg/150.0.4078.65', gpuDriver: '591.86' })).toBeNull()
  })

  it('supports an empty custom matrix without emitting invalid progress', async () => {
    const onProgress = vi.fn()
    const report = await runZeroCopyMatrix({ cases: [], onProgress })
    expect(report.cases).toEqual([])
    expect(report.verdict).toBe('failed')
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('honours cancellation before a matrix case starts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runZeroCopyMatrix({
      cases: [{ id: 'cancelled', codec: 'h264', width: 16, height: 16, fps: 1, frames: 1 }],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('honours cancellation while adapter discovery is still pending', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Chrome/149.0.0.0 Edg/150.0.0.0',
      gpu: { requestAdapter: () => new Promise(() => {}) },
    })
    const controller = new AbortController()
    const pending = runZeroCopyMatrix({ cases: [], signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
