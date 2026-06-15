import { useEffect } from 'react'

import { captureVideoThumbnailStrip, mediaManager } from '@engine/media'
import { getCapabilities, thumbnailsViaBackend } from '@engine/backend'
import { db } from '@lib/dexie-db'
import { useProjectStore } from '@store/project-store'

/**
 * Generates the per-frame timeline thumbnail strip for video assets in the
 * background (one asset at a time), so importing media stays fast. The strip
 * uses sequential video seeks which are slow; deferring them here keeps the
 * import call returning almost immediately.
 */
export function useThumbnailStripBackfill(): void {
  const assets = useProjectStore((s) => s.assets)
  const updateAsset = useProjectStore((s) => s.updateAsset)

  useEffect(() => {
    const target = assets.find(
      (a) => a.kind === 'video' && (!a.thumbnailStrip || a.thumbnailStrip.length === 0),
    )
    if (!target) return

    let cancelled = false
    let url: string | null = null
    ;(async () => {
      // One frame every ~4 s, capped between 3 and 20 frames.
      const count = Math.min(20, Math.max(3, Math.ceil((target.durationSec || 1) / 4)))
      try {
        let strip: string[] = []

        // Prefer the backend (fast server-side ffmpeg); fall back to in-browser seeks.
        const caps = await getCapabilities()
        if (caps?.media) {
          try {
            if (target.sourcePath) {
              strip = await thumbnailsViaBackend({
                sourcePath: target.sourcePath,
                filename: target.name,
              }, count)
            } else {
              const blob = await mediaManager.getBlob(target.id)
              if (blob && !cancelled) strip = await thumbnailsViaBackend(blob, count)
            }
          } catch {
            strip = [] // fall through to in-browser
          }
        }
        if (!cancelled && strip.length === 0) {
          url = await mediaManager.getObjectUrl(target.id)
          if (url) strip = await captureVideoThumbnailStrip(url, count)
        }
        if (cancelled) return
        // Mark with at least one entry so we don't retry forever on failure.
        const value = strip.length > 0 ? strip : ['']
        updateAsset(target.id, { thumbnailStrip: value })
        await db.assets.update(target.id, { thumbnailStrip: value })
      } catch {
        if (!cancelled) {
          updateAsset(target.id, { thumbnailStrip: [''] })
          await db.assets.update(target.id, { thumbnailStrip: [''] })
        }
      } finally {
        if (url) URL.revokeObjectURL(url)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [assets, updateAsset])
}
