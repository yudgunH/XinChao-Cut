import { afterEach, describe, expect, it, vi } from 'vitest'

import { GpuCompositor } from './gpu-compositor'

afterEach(() => vi.unstubAllGlobals())

describe('GpuCompositor resource lifecycle', () => {
  it('destroys a device when canvas-context initialization fails', async () => {
    const destroy = vi.fn()
    const adapter = {
      info: { isFallbackAdapter: false },
      requestDevice: vi.fn(async () => ({ destroy })),
    }
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: vi.fn(async () => adapter) },
    })
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ getContext: () => null })),
    })

    await expect(GpuCompositor.create(1920, 1080)).resolves.toBeNull()
    expect(destroy).toHaveBeenCalledOnce()
  })
})
