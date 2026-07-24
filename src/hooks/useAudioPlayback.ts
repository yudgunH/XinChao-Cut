import { useEffect } from 'react'

import {
  audioEngine,
  audibleAssetIdsInHorizon,
  MAX_STREAM_ELEMENTS,
  SCHEDULE_HORIZON_SEC,
} from '@engine/audio'
import {
  isAudioCapableProxyKey,
  mediaManager,
  pathToMediaUrl,
  type MediaAsset,
} from '@engine/media'
import type { TimelineState } from '@engine/timeline'
import { useProjectStore } from '@store/project-store'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'

let warnedDecoderStall = false
let warnedStreamCapacity = false
const CRITICAL_AUDIO_HORIZON_SEC = 0.5
/**
 * Short standalone audio files are much cheaper to play as WebAudio PCM than
 * as one HTMLMediaElement per cut. Keep long/heavy audio on bounded streaming
 * so preview never pulls a multi-hundred-megabyte recording into the renderer.
 */
const MAX_DETACHED_INPUT_BYTES = 192 * 1024 * 1024
const MAX_DETACHED_PCM_BYTES = 384 * 1024 * 1024
const PCM_BYTES_PER_SEC_STEREO = 48_000 * 2 * 4
let pcmDecodeTail: Promise<void> = Promise.resolve()
const pcmDecodeInFlight = new Map<string, Promise<void>>()

function shouldDecodeStandaloneAudio(
  asset: MediaAsset | undefined,
  forceDetached = false,
): boolean {
  if (!asset || (asset.kind !== 'audio' && !forceDetached)) return false
  if (isAudioCapableProxyKey(asset.proxyStorageKey)) return true
  if (asset.sizeBytes > MAX_DETACHED_INPUT_BYTES) return false
  const duration = Number.isFinite(asset.durationSec) ? Math.max(0, asset.durationSec) : 0
  if (duration <= 0) return false
  const channels = Math.max(1, Math.min(2, asset.channels ?? 2))
  const estimatedPcm = duration * (PCM_BYTES_PER_SEC_STEREO / 2) * channels
  return estimatedPcm <= MAX_DETACHED_PCM_BYTES
}

/** Keep detached-source fetch/decode strictly serial so several source videos
 * are not materialized in RAM before decodeAudioData can release the previous
 * one. */
function queuePcmDecode(assetId: string, task: () => Promise<void>): Promise<void> {
  const existing = pcmDecodeInFlight.get(assetId)
  if (existing) return existing
  const queued = pcmDecodeTail.then(task, task)
  pcmDecodeTail = queued.catch(() => {})
  pcmDecodeInFlight.set(assetId, queued)
  void queued.finally(() => {
    if (pcmDecodeInFlight.get(assetId) === queued) pcmDecodeInFlight.delete(assetId)
  }).catch(() => {})
  return queued
}

async function getPcmBlob(assetId: string, asset: MediaAsset | undefined): Promise<Blob | null> {
  if (isAudioCapableProxyKey(asset?.proxyStorageKey)) {
    const url = await mediaManager.getPreviewObjectUrl(assetId)
    if (url) {
      try {
        const response = await fetch(url)
        if (response.ok) return await response.blob()
      } catch {
        // Fall back to the authoritative source.
      }
    }
  }
  return mediaManager.getBlob(assetId)
}

function collectDetachedAudioAssetIds(timeline: TimelineState): Set<string> {
  const trackKinds = new Map(timeline.tracks.map((track) => [track.id, track.kind]))
  const mutedVideoKeys = new Set(
    timeline.clips
      .filter((clip) => trackKinds.get(clip.trackId) === 'video' && clip.muted && !!clip.assetId)
      .map((clip) => `${clip.assetId}|${clip.startSec}|${clip.inPointSec}|${clip.outPointSec}`),
  )
  return new Set(
    timeline.clips
      .filter((clip) => {
        if (!clip.assetId || trackKinds.get(clip.trackId) !== 'audio') return false
        return !!clip.detachedFromClipId || mutedVideoKeys.has(
          `${clip.assetId}|${clip.startSec}|${clip.inPointSec}|${clip.outPointSec}`,
        )
      })
      .map((clip) => clip.assetId!),
  )
}

function warnIfDecoderStalled(assetId: string): void {
  if (warnedDecoderStall) return
  const reason = audioEngine.getDecodeError(assetId) ?? ''
  if (!/timed out|still recovering from a stalled decode/i.test(reason)) return
  warnedDecoderStall = true
  useToastStore.getState().push(
    'The browser audio decoder stalled. Audio preview was paused to protect memory; try again or use Server Export.',
    'error',
  )
}

/** Kick ensureDecoded for asset ids that still lack a buffer. */
function predecodeIds(
  ids: Iterable<string>,
  assetById: ReadonlyMap<string, MediaAsset>,
  cancelled: () => boolean,
  detachedIds: ReadonlySet<string> = new Set(),
): void {
  for (const id of ids) {
    if (audioEngine.hasPlaybackSource(id)) continue
    const asset = assetById.get(id)
    if (shouldDecodeStandaloneAudio(asset, detachedIds.has(id))) {
      void queuePcmDecode(id, async () => {
        if (cancelled()) return
        const blob = await getPcmBlob(id, asset)
        if (cancelled() || !blob) return
        await audioEngine.ensureDecoded(id, blob)
        warnIfDecoderStalled(id)
      }).catch(() => {})
      continue
    }
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
  detached = false,
): Promise<void> {
  if (audioEngine.hasPlaybackSource(assetId)) return
  const asset = assetById.get(assetId)
  if (shouldDecodeStandaloneAudio(asset, detached)) {
    await queuePcmDecode(assetId, async () => {
      const blob = await getPcmBlob(assetId, asset)
      if (!blob) return
      await audioEngine.ensureDecoded(assetId, blob)
      warnIfDecoderStalled(assetId)
    })
    return
  }
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
    if (isPlaying) return
    let cancelled = false
    const flat = useTimelineStore.getState().flatTimeline()
    const at = usePlaybackStore.getState().currentSec
    const need = audibleAssetIdsInHorizon(flat.clips, flat.tracks, at, SCHEDULE_HORIZON_SEC)
    const detachedIds = collectDetachedAudioAssetIds(flat)
    const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
    predecodeIds(need, assetById, () => cancelled, detachedIds)
    return () => {
      cancelled = true
    }
  }, [assets, clips, compounds, isPlaying, seekNonce])

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
      const detachedIds = collectDetachedAudioAssetIds(flat)
      const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
      predecodeIds(need, assetById, () => cancelled, detachedIds)
      const degraded = audioEngine.getStreamDegradedClipIds()
      if (!warnedStreamCap && degraded.length > 0) {
        warnedStreamCap = true
        useToastStore.getState().push(
          `Audio preview is limiting ${degraded.length} long layers to prevent overload. ` +
            'The export will still include all audio.',
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
      const detachedIds = collectDetachedAudioAssetIds(flat)
      const assetById = new Map(useProjectStore.getState().assets.map((asset) => [asset.id, asset]))
      const criticalTasks = [...critical]
        .filter((id) => !audioEngine.hasPlaybackSource(id))
        .map((id) => ensurePlaybackSource(id, assetById, detachedIds.has(id)))

      if (criticalTasks.length > 0) {
        usePlaybackStore.getState().setBuffering(true)
        await Promise.allSettled(criticalTasks)
      }
      if (cancelled) return
      const backgroundIds = [...need].filter((id) => !critical.has(id))
      predecodeIds(backgroundIds, assetById, () => cancelled, detachedIds)
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
            `Preview has ${activeStreams} long audio layers at the playhead, above the ` +
              `${MAX_STREAM_ELEMENTS}-decoder limit. Flatten, nest, or create proxies for stable playback.`,
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
