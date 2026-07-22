import { useEffect, useMemo, useRef, useState } from 'react'

import { getCapabilities, waveformViaBackend } from '@engine/backend'
import {
  beginBackfill,
  endBackfill,
  isBackfillInFlight,
} from '@engine/media/backfill-inflight'
import { extractWaveformPeaks, mediaManager } from '@engine/media'
import { db } from '@lib/dexie-db'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import type { MediaAsset } from '@engine/media'

const waveformRetryCount = new Map<string, number>()
const waveformRetryAt = new Map<string, number>()
const MAX_WAVEFORM_RETRIES = 5
export const WAVEFORM_BACKFILL_CONCURRENCY = 4

export function assetNeedsWaveform(asset: MediaAsset, referencedAssetIds: ReadonlySet<string>): boolean {
  if (asset.kind !== 'audio' && asset.kind !== 'video') return false
  if (asset.waveformPeaks && asset.waveformPeaks.length > 0) return false
  // Timeline-only narration/music is hidden from the media grid, but users
  // still need its waveform on clips. Ignore only detached/orphan rows.
  return !asset.timelineOnly || referencedAssetIds.has(asset.id)
}

/** Pick a bounded batch while keeping short timeline narration ahead of the
 * potentially long original video/audio source. */
export function pickWaveformBackfillBatch(
  assets: readonly MediaAsset[],
  referencedAssetIds: ReadonlySet<string>,
  isInFlight: (assetId: string) => boolean,
  capacity = WAVEFORM_BACKFILL_CONCURRENCY,
  isRetryReady: (assetId: string) => boolean = () => true,
): MediaAsset[] {
  if (capacity <= 0) return []
  const eligible = assets.filter(
    (asset) => assetNeedsWaveform(asset, referencedAssetIds) &&
      !isInFlight(asset.id) && isRetryReady(asset.id),
  )
  const timelineOnly = eligible.filter((asset) => asset.timelineOnly)
  const regular = eligible.filter((asset) => !asset.timelineOnly)
  return [...timelineOnly, ...regular].slice(0, capacity)
}

/**
 * Backfills audio waveforms for assets imported before waveform extraction
 * covered video (or that simply lack peaks). Uses a small bounded batch and
 * persists results so detached-audio / audio clips can render their wave.
 *
 * Module-scoped in-flight keys prevent stacked backend FFmpeg jobs when the
 * assets array churns; AbortSignal cancels the fetch when the asset no longer
 * needs peaks (removed or filled).
 */
export function useWaveformBackfill(): void {
  const [retryTick, setRetryTick] = useState(0)
  const mountedRef = useRef(true)
  const activeControllersRef = useRef(new Map<string, AbortController>())
  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const assets = useProjectStore((s) => s.assets)
  const updateAsset = useProjectStore((s) => s.updateAsset)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const referencedAssetIds = useMemo(
    () => new Set(clips.map((clip) => clip.assetId).filter((id): id is string => !!id)),
    [clips],
  )

  useEffect(() => {
    mountedRef.current = true
    const activeControllers = activeControllersRef.current
    const retryTimers = retryTimersRef.current
    return () => {
      mountedRef.current = false
      for (const ac of activeControllers.values()) ac.abort()
      activeControllers.clear()
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
    }
  }, [])

  useEffect(() => {
    const active = activeControllersRef.current
    const targets = pickWaveformBackfillBatch(
      assets,
      referencedAssetIds,
      (assetId) => isBackfillInFlight(assetId, 'waveform'),
      WAVEFORM_BACKFILL_CONCURRENCY - active.size,
      (assetId) => (waveformRetryAt.get(assetId) ?? 0) <= Date.now(),
    )
    if (targets.length === 0) return

    for (const target of targets) {
      const ac = beginBackfill(target.id, 'waveform')
      if (!ac) continue
      active.set(target.id, ac)
      const priorTimer = retryTimersRef.current.get(target.id)
      if (priorTimer) clearTimeout(priorTimer)
      retryTimersRef.current.delete(target.id)
      let completed = false

      ;(async () => {
        try {
          let peaks: number[] = []
          let definitiveAttempt = false
          const caps = await getCapabilities()
          if (ac.signal.aborted) return
          if (caps?.media) {
            try {
              if (target.sourcePath) {
                peaks = await waveformViaBackend(
                  { sourcePath: target.sourcePath, filename: target.name },
                  target.timelineOnly ? 800 : 4000,
                  ac.signal,
                )
                definitiveAttempt = true
              } else {
                const blob = await mediaManager.getBlob(target.id)
                if (blob && !ac.signal.aborted) {
                  peaks = await waveformViaBackend(blob, target.timelineOnly ? 800 : 4000, ac.signal)
                  definitiveAttempt = true
                }
              }
            } catch {
              if (ac.signal.aborted) return
              // Network/timeout/backend failure is transient. Keep peaks empty so
              // a later mount can retry; never persist the permanent no-audio sentinel.
              peaks = []
            }
          }
          if (!ac.signal.aborted && !definitiveAttempt && peaks.length === 0 && (!target.sourcePath || !!target.playbackUrl)) {
            const blob = await mediaManager.getBlob(target.id)
            if (blob && !ac.signal.aborted) {
              try {
                peaks = await extractWaveformPeaks(blob)
                definitiveAttempt = true
              } catch {
                if (ac.signal.aborted) return
                // Too large, corrupt, or temporarily undecodable: do not poison
                // project persistence with [0]. Backend/proxy may become available.
                return
              }
            }
          }
          if (ac.signal.aborted) return
          const live = useProjectStore.getState().assets.find((a) => a.id === target.id)
          if (!live || (live.waveformPeaks && live.waveformPeaks.length > 0)) return
          if (peaks.length === 0) {
            if (!definitiveAttempt) return
            updateAsset(target.id, { waveformPeaks: [0] })
            await db.assets.update(target.id, { waveformPeaks: [0] })
            completed = true
            waveformRetryCount.delete(target.id)
            waveformRetryAt.delete(target.id)
            return
          }
          updateAsset(target.id, { waveformPeaks: peaks })
          await db.assets.update(target.id, { waveformPeaks: peaks })
          completed = true
          waveformRetryCount.delete(target.id)
          waveformRetryAt.delete(target.id)
        } catch {
          // Capability/network/DB errors are retryable; leave the asset unset.
        } finally {
          if (active.get(target.id) === ac) active.delete(target.id)
          endBackfill(target.id, 'waveform', ac)
          if (!completed && !ac.signal.aborted) {
            const attempt = (waveformRetryCount.get(target.id) ?? 0) + 1
            waveformRetryCount.set(target.id, attempt)
            if (attempt >= MAX_WAVEFORM_RETRIES) {
              waveformRetryAt.set(target.id, Infinity)
            } else {
              const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5))
              waveformRetryAt.set(target.id, Date.now() + delay)
              const timer = setTimeout(() => {
                retryTimersRef.current.delete(target.id)
                if (mountedRef.current) setRetryTick((value) => value + 1)
              }, delay)
              retryTimersRef.current.set(target.id, timer)
            }
          }
          if (mountedRef.current) setRetryTick((value) => value + 1)
        }
      })()
    }

    return () => {
      const liveReferenced = new Set(
        useTimelineStore.getState().timeline.clips
          .map((clip) => clip.assetId)
          .filter((id): id is string => !!id),
      )
      for (const target of targets) {
        const ac = active.get(target.id)
        if (!ac) continue
        const stillNeeds = useProjectStore.getState().assets.some(
          (asset) => asset.id === target.id && assetNeedsWaveform(asset, liveReferenced),
        )
        if (!stillNeeds) ac.abort()
      }
    }
  }, [assets, referencedAssetIds, retryTick, updateAsset])
}
