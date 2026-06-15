import { useEffect } from 'react'

import { extractWaveformPeaks, mediaManager } from '@engine/media'
import { getCapabilities, waveformViaBackend } from '@engine/backend'
import { db } from '@lib/dexie-db'
import { useProjectStore } from '@store/project-store'

/**
 * Backfills audio waveforms for assets imported before waveform extraction
 * covered video (or that simply lack peaks). Decodes one asset at a time and
 * persists the result so detached-audio / audio clips can render their wave.
 */
export function useWaveformBackfill(): void {
  const assets = useProjectStore((s) => s.assets)
  const updateAsset = useProjectStore((s) => s.updateAsset)

  useEffect(() => {
    const target = assets.find(
      (a) =>
        (a.kind === 'audio' || a.kind === 'video') &&
        (!a.waveformPeaks || a.waveformPeaks.length === 0),
    )
    if (!target) return

    let cancelled = false
    ;(async () => {
      try {
        // Prefer the backend (server-side ffmpeg); fall back to in-browser decode.
        let peaks: number[] = []
        const caps = await getCapabilities()
        if (caps?.media) {
          try {
            if (target.sourcePath) {
              peaks = await waveformViaBackend({
                sourcePath: target.sourcePath,
                filename: target.name,
              })
            } else {
              const blob = await mediaManager.getBlob(target.id)
              if (blob && !cancelled) peaks = await waveformViaBackend(blob)
            }
          } catch {
            peaks = []
          }
        }
        if (!cancelled && peaks.length === 0 && !target.sourcePath) {
          const blob = await mediaManager.getBlob(target.id)
          if (blob) peaks = await extractWaveformPeaks(blob)
        }
        if (cancelled || peaks.length === 0) {
          // Mark with a single zero so we don't retry an audio-less video forever.
          if (!cancelled) {
            updateAsset(target.id, { waveformPeaks: [0] })
            await db.assets.update(target.id, { waveformPeaks: [0] })
          }
          return
        }
        updateAsset(target.id, { waveformPeaks: peaks })
        await db.assets.update(target.id, { waveformPeaks: peaks })
      } catch {
        if (!cancelled) updateAsset(target.id, { waveformPeaks: [0] })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [assets, updateAsset])
}
