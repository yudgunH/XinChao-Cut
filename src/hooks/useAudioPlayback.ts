import { useEffect } from 'react'

import { audioEngine } from '@engine/audio'
import { mediaManager } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'

/**
 * Drives audio playback via the Web Audio engine. Mount once at app root.
 *
 * - Decodes audio buffers for video/audio assets when the asset list changes.
 * - Starts/stops scheduled audio when playback toggles.
 * - Re-schedules from the new position when the user seeks while playing.
 * - Keeps master volume in sync with the playback store.
 */
export function useAudioPlayback(): void {
  const assets = useProjectStore((s) => s.assets)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const seekNonce = usePlaybackStore((s) => s.seekNonce)
  const volume = usePlaybackStore((s) => s.volume)

  // Pre-decode audio buffers — but ONLY for assets actually placed on the
  // timeline, not every imported library asset. Eagerly decoding everything
  // pulled each file fully into RAM as PCM (a 1h stereo clip ≈ 1.4 GB), which
  // an unused multi-GB import would needlessly OOM. Clips on the timeline are
  // what playback needs ready; anything else is decoded lazily on first play.
  useEffect(() => {
    let cancelled = false
    const onTimeline = new Set(
      clips.map((c) => c.assetId).filter((id): id is string => !!id),
    )
    for (const asset of assets) {
      if (asset.kind !== 'audio' && asset.kind !== 'video') continue
      if (!onTimeline.has(asset.id)) continue
      if (audioEngine.hasBuffer(asset.id)) continue
      mediaManager.getBlob(asset.id).then((blob) => {
        if (cancelled || !blob) return
        void audioEngine.ensureDecoded(asset.id, blob)
      })
    }
    return () => {
      cancelled = true
    }
  }, [assets, clips])

  // Keep master volume in sync
  useEffect(() => {
    audioEngine.setMasterVolume(volume)
  }, [volume])

  // Start/stop on play toggle; reschedule from new position on user seek.
  // Buffers may not be decoded yet right after a page reload (they're read back
  // from OPFS and decoded asynchronously). Decode whatever the timeline needs
  // BEFORE scheduling, otherwise play() silently skips not-yet-decoded clips —
  // which showed up as "video plays but no audio after reload".
  useEffect(() => {
    if (!isPlaying) {
      audioEngine.stop()
      return
    }

    let cancelled = false
    const { timeline } = useTimelineStore.getState()

    ;(async () => {
      const ids = [
        ...new Set(
          timeline.clips
            .filter((c) => !c.muted)
            .map((c) => c.assetId)
            .filter((id): id is string => !!id),
        ),
      ]
      await Promise.all(
        ids.map(async (id) => {
          if (audioEngine.hasBuffer(id)) return
          const blob = await mediaManager.getBlob(id)
          if (blob) await audioEngine.ensureDecoded(id, blob)
        }),
      )
      if (cancelled) return
      // Re-check the live play state — the user may have paused while decoding.
      if (!usePlaybackStore.getState().isPlaying) return
      const { timeline: tl } = useTimelineStore.getState()
      audioEngine.play(usePlaybackStore.getState().currentSec, tl.clips, tl.tracks)
    })()

    return () => {
      cancelled = true
      audioEngine.stop()
    }
  }, [isPlaying, seekNonce])
}
