export interface PreviewRenderScheduler {
  schedule(): void
  dispose(): void
}

type FrameCallback = (time: number) => void

/** Coalesce every media/playback invalidation into at most one paint per RAF. */
export function createPreviewRenderScheduler(
  render: () => void,
  requestFrame: (callback: FrameCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
): PreviewRenderScheduler {
  let rafId: number | null = null
  let dirty = false
  let disposed = false

  return {
    schedule() {
      if (disposed) return
      dirty = true
      if (rafId !== null) return
      rafId = requestFrame(() => {
        rafId = null
        if (!dirty || disposed) return
        dirty = false
        render()
      })
    },
    dispose() {
      disposed = true
      dirty = false
      if (rafId !== null) cancelFrame(rafId)
      rafId = null
    },
  }
}
