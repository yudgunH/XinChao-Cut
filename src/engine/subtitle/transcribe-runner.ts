/**
 * Single-clip transcription flow, callable from the clip context menu.
 * Mirrors CaptionsPanel.autoGenerate but scoped to one clip's asset, driving
 * the global transcription-store so progress shows in the Captions panel.
 *
 * Always returns a structured result — never silently swallows failures.
 * Callers that require captions must check status before exporting.
 */
import { mediaManager } from '@engine/media'
import type { Clip, Track } from '@engine/timeline'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useTranscriptionStore } from '@store/transcription-store'
import { captureProjectOwnership, stillOwnsProject } from '@lib/project-session'

import {
  extractClipAudio,
  backendAsrAvailable,
  mapCuesToTimeline,
  mapSegmentedCuesToTimeline,
  transcribeBlob,
  transcribeMediaSource,
  type MappedCue,
} from './transcribe'

let _abort: AbortController | null = null

export type ClipTranscriptionResult =
  | { status: 'ok'; captionCount: number }
  | { status: 'busy' }
  | { status: 'error'; error: string; captionCount?: number }

function isAudibleMediaClip(clip: Clip, tracks: Track[]): boolean {
  if (!clip.assetId || clip.muted) return false
  const track = tracks.find((candidate) => candidate.id === clip.trackId)
  return !!track && !track.muted && (track.kind === 'audio' || track.kind === 'video')
}

/** Cancel the in-flight transcription, if any. */
export function cancelClipTranscription(): void {
  _abort?.abort()
}

/**
 * Transcribe a single clip (and any siblings sharing its asset, so repeated
 * placements still map correctly) into timeline captions.
 *
 * - `ok`    — captions inserted; captionCount > 0
 * - `busy`  — another transcription is already running (no work started)
 * - `error` — validation / ASR / no-speech failure (store also gets setError)
 *
 * AbortError is rethrown so cancel flows can stop the operation.
 */
export async function runClipTranscription(clipId: string): Promise<ClipTranscriptionResult> {
  const t = useTranscriptionStore.getState()
  if (t.busy) return { status: 'busy' }

  const tl = useTimelineStore.getState()
  const clip = tl.timeline.clips.find((c) => c.id === clipId)
  if (!clip) {
    const error = 'Clip has no media'
    t.setError(error)
    return { status: 'error', error, captionCount: 0 }
  }
  if (!clip.assetId && !clip.compoundId) {
    const error = 'Clip has no media'
    t.setError(error)
    return { status: 'error', error, captionCount: 0 }
  }
  const timeline = clip.compoundId ? tl.flatTimeline() : tl.timeline
  const transcriptionClip = clip.compoundId
    ? timeline.clips.find(
        (candidate) =>
          candidate.id.startsWith(`${clip.id}::`) &&
          isAudibleMediaClip(candidate, timeline.tracks),
      )
    : clip
  if (!transcriptionClip || !isAudibleMediaClip(transcriptionClip, timeline.tracks)) {
    const error = 'Clip audio is muted'
    t.setError(error)
    return { status: 'error', error, captionCount: 0 }
  }
  const assets = useProjectStore.getState().assets
  const targetAssetIds = clip.compoundId
    ? [...new Set(
        timeline.clips
          .filter((candidate) => candidate.id.startsWith(`${clip.id}::`))
          .filter((candidate) => isAudibleMediaClip(candidate, timeline.tracks))
          .map((candidate) => candidate.assetId)
          .filter((id): id is string => !!id),
      )]
    : transcriptionClip.assetId
      ? [transcriptionClip.assetId]
      : []
  if (targetAssetIds.length === 0) {
    const error = 'Clip has no audio'
    t.setError(error)
    return { status: 'error', error, captionCount: 0 }
  }
  const ownership = captureProjectOwnership()
  if (!stillOwnsProject(ownership)) {
    return { status: 'error', error: 'Project changed', captionCount: 0 }
  }

  t.start()
  const controller = new AbortController()
  _abort = controller
  const { signal } = controller
  const ownershipWatch = setInterval(() => {
    if (!stillOwnsProject(ownership)) controller.abort()
  }, 100)
  const assertOwnership = () => {
    if (signal.aborted || !stillOwnsProject(ownership)) {
      throw new DOMException('Cancelled', 'AbortError')
    }
  }
  const { model, language, provider } = useTranscriptionStore.getState()

  try {
    const mapped: MappedCue[] = []
    const serverAvailable = await backendAsrAvailable()
    for (const assetId of targetAssetIds) {
      const asset = assets.find((candidate) => candidate.id === assetId)
      if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) continue
      const assetClips = timeline.clips.filter(
        (candidate) =>
          candidate.assetId === assetId &&
          isAudibleMediaClip(candidate, timeline.tracks),
      )
      const useBackend = !!asset.sourcePath || serverAvailable
      assertOwnership()
      if (useBackend) {
        const source = asset.sourcePath
          ? { sourcePath: asset.sourcePath, filename: asset.name }
          : await mediaManager.getBlob(assetId)
        if (!source) throw new Error('Media not found')
        const cues = await transcribeMediaSource(source, {
          model,
          language: language === 'auto' ? undefined : language,
          provider,
          onProgress: (p) => useTranscriptionStore.getState().setProgress({ ...p }),
          signal,
        })
        assertOwnership()
        mapped.push(...mapCuesToTimeline(cues, assetClips, asset.id))
      } else {
        const blob = await mediaManager.getBlob(assetId)
        if (!blob) throw new Error('Media not found')
        useTranscriptionStore.getState().setProgress({ stage: 'decoding' })
        const { wav, segments } = await extractClipAudio(blob, assetClips)
        assertOwnership()
        if (segments.length === 0) continue
        const cues = await transcribeBlob(wav, {
          model,
          language: language === 'auto' ? undefined : language,
          provider,
          onProgress: (p) => useTranscriptionStore.getState().setProgress({ ...p }),
          signal,
        })
        assertOwnership()
        mapped.push(...mapSegmentedCuesToTimeline(cues, segments))
      }
    }
    if (mapped.length === 0) {
      const error = 'No speech detected'
      useTranscriptionStore.getState().setError(error)
      return { status: 'error', error, captionCount: 0 }
    }
    mapped.sort((a, b) => a.startSec - b.startSec)
    assertOwnership()
    useTimelineStore.getState().insertSubtitles(mapped)
    useTranscriptionStore.getState().setNote(`Generated ${mapped.length} captions`)
    return { status: 'ok', captionCount: mapped.length }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    const error = e instanceof Error ? e.message : 'Transcription failed'
    useTranscriptionStore.getState().setError(error)
    return { status: 'error', error, captionCount: 0 }
  } finally {
    clearInterval(ownershipWatch)
    useTranscriptionStore.getState().finish()
    if (_abort === controller) _abort = null
  }
}
