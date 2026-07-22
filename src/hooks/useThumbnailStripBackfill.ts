import { useEffect, useRef, useState } from 'react'

import { getCapabilities, thumbnailsViaBackend } from '@engine/backend'
import {
  beginBackfill,
  endBackfill,
  isBackfillInFlight,
} from '@engine/media/backfill-inflight'
import { captureVideoThumbnailStrip, mediaManager } from '@engine/media'
import { db } from '@lib/dexie-db'
import { useProjectStore } from '@store/project-store'

const thumbnailRetryCount = new Map<string, number>()
const thumbnailRetryAt = new Map<string, number>()
const MAX_THUMBNAIL_RETRIES = 5

/**
 * Generates the per-frame timeline thumbnail strip for video assets in the
 * background (one asset at a time), so importing media stays fast. The strip
 * uses sequential video seeks which are slow; deferring them here keeps the
 * import call returning almost immediately.
 *
 * In-flight work is tracked at module scope (`assetId:thumbnails`) so asset
 * store updates cannot stack multiple FFmpeg jobs for the same clip. Abort
 * cancels the backend fetch when the asset is removed or no longer needs a strip.
 */
export function useThumbnailStripBackfill(): void {
  const [retryTick, setRetryTick] = useState(0)
  const mountedRef = useRef(true)
  const activeControllerRef = useRef<AbortController | null>(null)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const assets = useProjectStore((s) => s.assets)
  const updateAsset = useProjectStore((s) => s.updateAsset)

  useEffect(() => () => {
    mountedRef.current = false
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
    if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
  }, [])

  useEffect(() => {
    const now = Date.now()
    const target = assets.find(
      (a) => a.kind === 'video' &&
        (!a.thumbnailStrip || a.thumbnailStrip.length === 0) &&
        (thumbnailRetryAt.get(a.id) ?? 0) <= now,
    )
    if (!target) {
      const nextRetry = Math.min(
        ...assets.map((asset) => thumbnailRetryAt.get(asset.id) ?? Infinity),
      )
      if (Number.isFinite(nextRetry) && nextRetry > now && !wakeTimerRef.current) {
        wakeTimerRef.current = setTimeout(() => {
          wakeTimerRef.current = null
          if (mountedRef.current) setRetryTick((value) => value + 1)
        }, nextRetry - now)
      }
      return
    }
    if (isBackfillInFlight(target.id, 'thumbnails')) return

    const ac = beginBackfill(target.id, 'thumbnails')
    if (!ac) return
    activeControllerRef.current = ac

    let url: string | null = null
    let completed = false
    ;(async () => {
      const count = Math.min(20, Math.max(3, Math.ceil((target.durationSec || 1) / 4)))
      try {
        let strip: string[] = []

        const caps = await getCapabilities()
        if (ac.signal.aborted) return
        if (caps?.media) {
          try {
            if (target.sourcePath) {
              strip = await thumbnailsViaBackend(
                { sourcePath: target.sourcePath, filename: target.name },
                count,
                160,
                ac.signal,
              )
            } else {
              const blob = await mediaManager.getBlob(target.id)
              if (blob && !ac.signal.aborted) {
                strip = await thumbnailsViaBackend(blob, count, 160, ac.signal)
              }
            }
          } catch {
            if (ac.signal.aborted) return
            strip = []
          }
        }
        if (!ac.signal.aborted && strip.length === 0) {
          url = await mediaManager.getObjectUrl(target.id)
          if (url && !ac.signal.aborted) {
            strip = await captureVideoThumbnailStrip(url, count, ac.signal)
          }
        }
        if (ac.signal.aborted) return
        // Asset may have been filled by another path; skip write if already set.
        const live = useProjectStore.getState().assets.find((a) => a.id === target.id)
        if (!live || (live.thumbnailStrip && live.thumbnailStrip.length > 0)) return
        if (strip.length === 0) return
        updateAsset(target.id, { thumbnailStrip: strip })
        await db.assets.update(target.id, { thumbnailStrip: strip })
        completed = true
        thumbnailRetryCount.delete(target.id)
        thumbnailRetryAt.delete(target.id)
      } catch (e) {
        if (ac.signal.aborted) return
        console.warn('[thumbnails] strip generation failed for asset', target.id, e)
      } finally {
        if (url) URL.revokeObjectURL(url)
        if (activeControllerRef.current === ac) activeControllerRef.current = null
        endBackfill(target.id, 'thumbnails', ac)
        if (!completed && !ac.signal.aborted) {
          const attempt = (thumbnailRetryCount.get(target.id) ?? 0) + 1
          thumbnailRetryCount.set(target.id, attempt)
          thumbnailRetryAt.set(
            target.id,
            attempt >= MAX_THUMBNAIL_RETRIES
              ? Infinity
              : Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5)),
          )
          if (mountedRef.current) setRetryTick((value) => value + 1)
        }
      }
    })()

    return () => {
      // Abort only when the asset is gone or no longer needs a strip — not on
      // every assets[] identity change (that used to cancel + re-spawn FFmpeg).
      const stillNeeds = useProjectStore.getState().assets.some(
        (a) =>
          a.id === target.id &&
          a.kind === 'video' &&
          (!a.thumbnailStrip || a.thumbnailStrip.length === 0),
      )
      if (!stillNeeds) ac.abort()
    }
  }, [assets, retryTick, updateAsset])
}
