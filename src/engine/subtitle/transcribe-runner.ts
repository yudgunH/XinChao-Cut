/**
 * Single-clip transcription flow, callable from the clip context menu.
 * Mirrors CaptionsPanel.autoGenerate but scoped to one clip's asset, driving
 * the global transcription-store so progress shows in the Captions panel.
 */
import { mediaManager } from '@engine/media'
import type { Clip, Track } from '@engine/timeline'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useTranscriptionStore } from '@store/transcription-store'

import {
  extractClipAudio,
  mapCuesToTimeline,
  mapSegmentedCuesToTimeline,
  transcribeBlob,
  transcribeMediaSource,
  type MappedCue,
} from './transcribe'

let _abort: AbortController | null = null

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
 */
export async function runClipTranscription(clipId: string): Promise<void> {
  const t = useTranscriptionStore.getState()
  if (t.busy) return

  const tl = useTimelineStore.getState()
  const clip = tl.timeline.clips.find((c) => c.id === clipId)
  if (!clip?.assetId) {
    t.setError('Clip has no media')
    return
  }
  if (!isAudibleMediaClip(clip, tl.timeline.tracks)) {
    t.setError('Clip audio is muted')
    return
  }
  const asset = useProjectStore.getState().assets.find((a) => a.id === clip.assetId)
  if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) {
    t.setError('Clip has no audio')
    return
  }

  t.start()
  _abort = new AbortController()
  const { model, language } = useTranscriptionStore.getState()

  try {
    const assetClips = tl.timeline.clips.filter(
      (c) => c.assetId === clip.assetId && isAudibleMediaClip(c, tl.timeline.tracks),
    )
    let mapped: MappedCue[]
    if (asset.sourcePath) {
      const cues = await transcribeMediaSource(
        { sourcePath: asset.sourcePath, filename: asset.name },
        {
          model,
          language: language === 'auto' ? undefined : language,
          onProgress: (p) => useTranscriptionStore.getState().setProgress({ ...p }),
          signal: _abort.signal,
        },
      )
      mapped = mapCuesToTimeline(cues, assetClips, asset.id)
    } else {
      const blob = await mediaManager.getBlob(clip.assetId)
      if (!blob) throw new Error('Media not found')

      useTranscriptionStore.getState().setProgress({ stage: 'decoding' })
      const { wav, segments } = await extractClipAudio(blob, assetClips)
      if (segments.length === 0) {
        useTranscriptionStore.getState().setError('No audible audio found')
        return
      }
      if (_abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')

      const cues = await transcribeBlob(wav, {
        model,
        language: language === 'auto' ? undefined : language,
        onProgress: (p) => useTranscriptionStore.getState().setProgress({ ...p }),
        signal: _abort.signal,
      })

      mapped = mapSegmentedCuesToTimeline(cues, segments)
    }
    if (mapped.length === 0) {
      useTranscriptionStore.getState().setError('No speech detected')
      return
    }
    mapped.sort((a, b) => a.startSec - b.startSec)
    useTimelineStore.getState().insertSubtitles(mapped)
    useTranscriptionStore.getState().setNote(`Generated ${mapped.length} captions`)
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      useTranscriptionStore.getState().setError(e instanceof Error ? e.message : 'Transcription failed')
    }
  } finally {
    useTranscriptionStore.getState().finish()
    _abort = null
  }
}
