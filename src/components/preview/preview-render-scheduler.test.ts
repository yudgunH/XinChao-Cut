import { describe, expect, it, vi } from 'vitest'

import { createPreviewRenderScheduler } from './preview-render-scheduler'

describe('createPreviewRenderScheduler', () => {
  it('coalesces media and playback invalidations into one render per frame', () => {
    const callbacks: Array<(time: number) => void> = []
    const request = vi.fn((callback: (time: number) => void) => {
      callbacks.push(callback)
      return callbacks.length
    })
    const render = vi.fn()
    const scheduler = createPreviewRenderScheduler(render, request, vi.fn())

    for (let i = 0; i < 12; i++) scheduler.schedule()
    scheduler.schedule()

    expect(request).toHaveBeenCalledTimes(1)
    callbacks.shift()!(0)
    expect(render).toHaveBeenCalledTimes(1)

    scheduler.schedule()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending frame on dispose', () => {
    const cancel = vi.fn()
    const scheduler = createPreviewRenderScheduler(vi.fn(), () => 42, cancel)
    scheduler.schedule()
    scheduler.dispose()
    expect(cancel).toHaveBeenCalledWith(42)
  })
})
