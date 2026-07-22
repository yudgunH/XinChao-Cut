import { describe, expect, it, vi } from 'vitest'

import type { MediaAsset } from './types'
import { createMediaManager, isOrphanedEditorMedia, withPathProbeSlot } from './media-manager'

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    projectId: 'project-1',
    kind: 'video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1,
    durationSec: 1,
    storageKey: 'clip.mp4',
    createdAt: 1,
    ...overrides,
  }
}

describe('media lifecycle ownership', () => {
  it('still detects genuinely orphaned editor media', () => {
    expect(isOrphanedEditorMedia(asset(), new Set(), new Set())).toBe(true)
    expect(isOrphanedEditorMedia(asset({ timelineOnly: true }), new Set(), new Set())).toBe(true)
    expect(isOrphanedEditorMedia(asset(), new Set(['project-1']), new Set())).toBe(false)
    expect(isOrphanedEditorMedia(asset(), new Set(), new Set(['asset-1']))).toBe(false)
  })
})

describe('native path probe queue cancellation', () => {
  it('removes an aborted waiter without consuming a future probe slot', async () => {
    let release!: () => void
    const blocker = new Promise<void>((resolve) => { release = resolve })
    const active = Array.from({ length: 3 }, () => withPathProbeSlot(() => blocker))
    const controller = new AbortController()
    const work = vi.fn(async () => undefined)
    const cancelled = withPathProbeSlot(work, controller.signal)

    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(work).not.toHaveBeenCalled()

    release()
    await Promise.all(active)
    await expect(withPathProbeSlot(work)).resolves.toBeUndefined()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('rolls back the optimistic DB row when deferred probing is cancelled', async () => {
    const rows = new Map<string, MediaAsset>()
    const manager = createMediaManager({} as never, {
      putAsset: async (asset) => { rows.set(asset.id, asset) },
      deleteAsset: async (id) => { rows.delete(id) },
      listReferencedKeys: async () => new Set(),
    })
    const controller = new AbortController()
    controller.abort()

    const { asset, ready } = await manager.importPathDeferred(
      'C:\\media\\clip.mp4',
      'clip.mp4',
      'project-1',
      { signal: controller.signal },
    )
    expect(rows.has(asset.id)).toBe(true)
    await expect(ready).rejects.toMatchObject({ name: 'AbortError' })
    expect(rows.has(asset.id)).toBe(false)
  })
})
