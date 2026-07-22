import { useEffect } from 'react'

import {
  audioEngine,
  audibleAssetIdsInHorizon,
  MAX_STREAM_ELEMENTS,
  SCHEDULE_HORIZON_SEC,
} from '@engine/audio'
import { mediaManager, pathToMediaUrl, type MediaAsset } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'

let warnedDecoderStall = false
let warnedStreamCapacity = false
const CRITICAL_AUDIO_HORIZON_SEC = 0.5

function warnIfDecoderStalled(assetId: string): void {
  if (warnedDecoderStall) return
  const reason = audioEngine.getDecodeError(assetId) ?? ''
  if (!/timed out|still recovering from a stalled decode/i.test(reason)) return
  warnedDecoderStall = true
  useToastStore.getState().push(
    'Bộ giải mã audio của trình duyệt bị treo. Preview audio tạm dừng để tránh đầy RAM; hãy thử lại hoặc dùng Server Export.',
    'error',
  )
}

/** Kick ensureDecoded for asset ids that still lack a buffer. */
function predecodeIds(
  ids: Iterable<string>,
  assetById: ReadonlyMap<string, MediaAsset>,
  cancelled: () => boolean,
): void {
  for (const id of ids) {
    if (audioEngine.hasPlaybackSource(id)) continue
    const asset = assetById.get(id)
    const streamUrl = asset?.playbackUrl || (asset?.sourcePath ? pathToMediaUrl(asset.sourcePath) : '')
    if (streamUrl) {
      audioEngine.ensureStreamSource(id, streamUrl)
      continue
    }
    void mediaManager.getBlob(id).then((blob) => {
      if (cancelled() || !blob) return
      void audioEngine.ensureDecoded(id, blob).then(() => warnIfDecoderStalled(id))
    })
  }
}

async function ensurePlaybackSource(
  assetId: string,
  assetById: ReadonlyMap<string, MediaAsset>,
): Promise<void> {
  if (audioEngine.hasPlaybackSource(assetId)) return
  const asset = assetById.get(assetId)
  const streamUrl = asset?.playbackUrl || (asset?.sourcePath ? pathToMediaUrl(asset.sourcePath) : '')
  if (streamUrl) {
    audioEngine.ensureStreamSource(assetId, streamUrl)
    return
  }
  const blob = await mediaManager.getBlob(assetId)
  if (!blob) return
  await audioEngine.ensureDecoded(assetId, blob)
  warnIfDecoderStalled(assetId)
}

/**
 * Drives audio playback via the Web Audio engine. Mount once at app root.
 *
 * - Pre-decodes ONLY assets with clips in the playback horizon (not the full
 *   project working set — multi-hour tracks would otherwise all land in RAM).
 * - Starts/stops scheduled audio when playback toggles.
 * - Re-schedules from the new position when the user seeks while playing.
 * - Keeps master volume in sync with the playback store.
 */
export function useAudioPlayback(): void {
  const assets = useProjectStore((s) => s.assets)
  const clips = useTimelineStore((s) => s.timeline.clips)
  // Compound contents contribute audio too — re-decode when the registry changes.
  const compounds = useTimelineStore((s) => s.compounds)
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const seekNonce = usePlaybackStore((s) => s.seekNonce)
  const volume = usePlaybackStore((s) => s.volume)

  // Pre-decode only assets whose clips fall inside the schedule horizon of the
  // current playhead. Far-timeline multi-hour audio is decoded lazily when the
  // playhead approaches (play interval + seek).
  useEffect(() => {
    let cancelled = false
    const flat = useTimelineStore.getState().flatTimeline()
    const at = usePlaybackStore.getState().currentSec
    const need = audibleAssetIdsInHorizon(flat.clips, flat.tracks, at, SCHEDULE_HORIZON_SEC)
    const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
    predecodeIds(need, assetById, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [assets, clips, compounds, seekNonce])

  // While playing, keep the moving horizon warm so upcoming clips re-decode
  // after hard-eviction (budget) without waiting for the next seek.
  useEffect(() => {
    if (!isPlaying) return
    let cancelled = false
    let warnedStreamCap = false
    const tick = () => {
      const flat = useTimelineStore.getState().flatTimeline()
      const at = usePlaybackStore.getState().currentSec
      const need = audibleAssetIdsInHorizon(flat.clips, flat.tracks, at, SCHEDULE_HORIZON_SEC)
      const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
      predecodeIds(need, assetById, () => cancelled)
      const degraded = audioEngine.getStreamDegradedClipIds()
      if (!warnedStreamCap && degraded.length > 0) {
        warnedStreamCap = true
        useToastStore.getState().push(
          `Preview audio đang giới hạn ${degraded.length} layer dài để tránh quá tải. ` +
            'Export vẫn giữ đầy đủ audio.',
          'info',
        )
      }
    }
    tick()
    // Slightly under PUMP_LEAD so decode has a head start before schedule pump.
    const timer = window.setInterval(tick, 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isPlaying, seekNonce, clips, compounds])

  // Keep master volume in sync
  useEffect(() => {
    audioEngine.setMasterVolume(volume)
  }, [volume])

  // Start/stop on play toggle; reschedule from new position on user seek.
  // Only decode the horizon before arming BufferSources — full-timeline decode
  // of every audible asset was the path that OOM'd multi-hour projects.
  useEffect(() => {
    if (!isPlaying) {
      usePlaybackStore.getState().setBuffering(false)
      audioEngine.stop()
      return
    }

    let cancelled = false
    const flat = useTimelineStore.getState().flatTimeline()

    ;(async () => {
      const at = usePlaybackStore.getState().currentSec
      const need = audibleAssetIdsInHorizon(flat.clips, flat.tracks, at, SCHEDULE_HORIZON_SEC)
      const critical = audibleAssetIdsInHorizon(
        flat.clips,
        flat.tracks,
        at,
        CRITICAL_AUDIO_HORIZON_SEC,
      )
      const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
      const tasks = new Map(
        [...need].map((id) => [id, ensurePlaybackSource(id, assetById)] as const),
      )
      const criticalTasks = [...critical]
        .filter((id) => !audioEngine.hasPlaybackSource(id))
        .map((id) => tasks.get(id) ?? ensurePlaybackSource(id, assetById))
      const backgroundTasks = [...tasks.entries()]
        .filter(([id]) => !critical.has(id))
        .map(([, task]) => task)

      // Warm future clips without blocking transport. Only audio intersecting
      // the playhead may put playback into an explicit buffering state.
      void Promise.allSettled(backgroundTasks)
      if (criticalTasks.length > 0) {
        usePlaybackStore.getState().setBuffering(true)
        await Promise.allSettled(criticalTasks)
      }
      if (cancelled) return
      // Re-check the live play state — the user may have paused while decoding.
      if (!usePlaybackStore.getState().isPlaying) return
      usePlaybackStore.getState().setBuffering(false)
      const tl = useTimelineStore.getState().flatTimeline()
      const currentSec = usePlaybackStore.getState().currentSec
      if (!warnedStreamCapacity) {
        const trackById = new Map(tl.tracks.map((track) => [track.id, track]))
        const activeStreams = tl.clips.filter((clip) => {
          if (!clip.assetId || !audioEngine.isStreamSource(clip.assetId)) return false
          const track = trackById.get(clip.trackId)
          if (!track || track.kind !== 'audio' || track.muted || track.hidden || clip.muted) return false
          const end = clip.startSec + (clip.outPointSec - clip.inPointSec) / Math.max(clip.speed, 0.01)
          return clip.startSec <= currentSec && end > currentSec
        }).length
        if (activeStreams > MAX_STREAM_ELEMENTS) {
          warnedStreamCapacity = true
          useToastStore.getState().push(
            `Preview có ${activeStreams} layer audio dài tại playhead, vượt giới hạn ` +
              `${MAX_STREAM_ELEMENTS} decoder. Hãy flatten/nest hoặc tạo proxy để nghe ổn định.`,
            'info',
          )
        }
      }
      audioEngine.play(currentSec, tl.clips, tl.tracks)
    })()

    return () => {
      cancelled = true
      audioEngine.stop()
    }
  }, [isPlaying, seekNonce])
}
