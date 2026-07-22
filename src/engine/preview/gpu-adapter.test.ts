import { describe, expect, it, vi } from 'vitest'

import {
  HIGH_PERFORMANCE_GPU_OPTIONS,
  requestHighPerformanceGpuAdapter,
  summarizeGpuAdapter,
  webViewRuntimeVersion,
} from './gpu-adapter'

describe('GPU adapter selection', () => {
  it('requests the high-performance adapter and exposes fallback identity', async () => {
    const adapter = {
      info: {
        vendor: 'nvidia',
        architecture: 'ada',
        device: '2860',
        description: 'RTX 4070',
        isFallbackAdapter: false,
      },
    } as unknown as GPUAdapter
    const requestAdapter = vi.fn(async () => adapter)
    vi.stubGlobal('navigator', { gpu: { requestAdapter } })

    const result = await requestHighPerformanceGpuAdapter()

    expect(requestAdapter).toHaveBeenCalledWith(HIGH_PERFORMANCE_GPU_OPTIONS)
    expect(result?.info).toEqual({
      vendor: 'nvidia',
      architecture: 'ada',
      device: '2860',
      description: 'RTX 4070',
      isFallbackAdapter: false,
    })
    vi.unstubAllGlobals()
  })

  it('handles runtimes with redacted adapter info', () => {
    expect(summarizeGpuAdapter({ info: {} } as unknown as GPUAdapter)).toEqual({
      vendor: '',
      architecture: '',
      device: '',
      description: '',
      isFallbackAdapter: false,
    })
  })

  it('extracts WebView/Chromium versions for cache invalidation', () => {
    expect(webViewRuntimeVersion('Mozilla/5.0 Edg/150.0.4078.65')).toBe('150.0.4078.65')
    expect(webViewRuntimeVersion('Chrome/149.0.0.0 Safari/537.36')).toBe('149.0.0.0')
    expect(webViewRuntimeVersion('Chrome/149.0.0.0 Safari/537.36 Edg/150.0.4078.65')).toBe('150.0.4078.65')
  })
})
