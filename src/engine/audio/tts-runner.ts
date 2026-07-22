import { startTts, getTtsStatus, ttsDownload, cancelTts } from '@engine/backend'
import { mediaManager } from '@engine/media'
import { clipEffectiveDuration, type Clip } from '@engine/timeline'
import {
  captureProjectOwnership,
  stillOwnsProject,
  type ProjectOwnership,
} from '@lib/project-session'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A caption gap longer than this (seconds) starts a new seamless cluster in
 *  'sequential' mode — i.e. a real pause/scene break is preserved, shorter
 *  inter-sentence gaps are absorbed so speech flows continuously. */
const SEQUENTIAL_GAP_SPLIT_SEC = 2

/** How caption voiceover clips are placed on the timeline:
 *  - timeline   → each clip at its caption's start (matches video timing, but
 *    can overlap when speech is longer than the caption's slot)
 *  - sequential → "liền mạch": clips flow back-to-back WITHIN a run of captions,
 *    but a long caption gap (> SEQUENTIAL_GAP_SPLIT_SEC) starts a new cluster
 *    re-anchored at that caption's real time — so pauses are kept, never overlap */
export type CaptionVoiceMode = 'timeline' | 'sequential'

interface CaptionVoiceItem {
  /** Caption clip start on the timeline (seconds). */
  captionStartSec: number
  /** Caption clip end on the timeline (seconds). */
  captionEndSec: number
  /** Length of the synthesized voice clip (seconds). */
  voiceDurationSec: number
}

/**
 * Compute the timeline start position of each caption voice clip.
 *  - timeline: each clip sits at its caption's start (may overlap if speech runs long).
 *  - sequential: clips flow back-to-back; a caption gap > `gapSplitSec` re-anchors
 *    the next clip at its real caption time (capped to never overlap prior voice),
 *    so continuous speech is seamless but real pauses are preserved.
 * Pure (no I/O) so it can be unit-tested.
 */
export function planCaptionVoice(
  items: CaptionVoiceItem[],
  mode: CaptionVoiceMode,
  gapSplitSec = SEQUENTIAL_GAP_SPLIT_SEC,
): number[] {
  const starts: number[] = []
  let cursor = items[0]?.captionStartSec ?? 0
  let prevCaptionEnd: number | null = null

  for (const it of items) {
    let startSec: number
    if (mode === 'sequential') {
      if (prevCaptionEnd != null && it.captionStartSec - prevCaptionEnd > gapSplitSec) {
        cursor = Math.max(it.captionStartSec, cursor) // new cluster, no overlap
      }
      startSec = cursor
    } else {
      startSec = it.captionStartSec
    }
    starts.push(startSec)
    cursor = startSec + it.voiceDurationSec
    prevCaptionEnd = it.captionEndSec
  }
  return starts
}

export interface TtsOptions {
  /** Owning project for the generated audio asset(s). */
  projectId: string
  /** A voice id: a preset, a saved cloned voice, or "" for auto. */
  voice?: string
  /** Speed multiplier (>1 faster). */
  speed?: number
  /** Placement mode for speakCaptions (default 'timeline'). */
  captionMode?: CaptionVoiceMode
}

/** Best-effort delete of assets imported under a lost ownership session. */
async function rollbackImportedAssets(assetIds: string[]): Promise<void> {
  for (const id of assetIds) {
    try {
      await mediaManager.remove(id)
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Run one TTS job for `texts`, polling to completion and returning the
 * synthesized WAV blobs (one per input line, in order). Reports coarse progress
 * via `onProgress(done, total)`. Aborts the server job if `signal` fires.
 *
 * When `ownership` is set, each download is gated — project switch cancels the
 * job and throws AbortError so callers roll back without mutating the new project.
 */
async function runTtsJob(
  texts: string[],
  opts: { voice?: string; speed?: number },
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  ownership?: ProjectOwnership,
): Promise<Blob[]> {
  const jobId = await startTts({ texts, voice: opts.voice, speed: opts.speed })

  for (;;) {
    if (signal?.aborted) {
      await cancelTts(jobId)
      throw new DOMException('Cancelled', 'AbortError')
    }
    if (ownership && !stillOwnsProject(ownership)) {
      await cancelTts(jobId)
      throw new DOMException('Cancelled', 'AbortError')
    }
    const st = await getTtsStatus(jobId)
    onProgress?.(st.done, st.total)
    if (st.status === 'done') break
    if (st.status === 'error') throw new Error(st.error || 'Synthesis failed')
    if (st.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError')
    await sleep(600)
  }

  const blobs: Blob[] = []
  for (let i = 0; i < texts.length; i++) {
    if (signal?.aborted) {
      await cancelTts(jobId)
      throw new DOMException('Cancelled', 'AbortError')
    }
    if (ownership && !stillOwnsProject(ownership)) {
      await cancelTts(jobId)
      throw new DOMException('Cancelled', 'AbortError')
    }
    blobs.push(await ttsDownload(jobId, i))
  }
  return blobs
}

/** Import WAV under `projectId` only — does NOT touch the live store. */
async function importWavOnly(blob: Blob, projectId: string, name: string) {
  return mediaManager.import(new File([blob], name, { type: 'audio/wav' }), projectId)
}

/**
 * Synthesize a single block of text and drop the generated clip onto an audio
 * track at `atSec`. Returns the new clip id.
 *
 * Captures project ownership at start; if the user opens another project mid-
 * flight, imported assets are rolled back and nothing is written to the new
 * timeline.
 */
export async function speakText(
  text: string,
  atSec: number,
  opts: TtsOptions,
  signal?: AbortSignal,
): Promise<string | null> {
  const ownership = captureProjectOwnership()
  if (!stillOwnsProject(ownership) || ownership.projectId !== opts.projectId) return null

  const trimmed = text.trim()
  if (!trimmed) return null

  let importedId: string | undefined
  try {
    const [blob] = await runTtsJob([trimmed], opts, undefined, signal, ownership)
    if (!blob) return null
    if (!stillOwnsProject(ownership)) return null

    const asset = await importWavOnly(blob, opts.projectId, 'Voice.wav')
    importedId = asset.id
    if (!stillOwnsProject(ownership)) {
      await rollbackImportedAssets([asset.id])
      return null
    }
    useProjectStore.getState().addAsset(asset)
    if (!stillOwnsProject(ownership)) {
      await rollbackImportedAssets([asset.id])
      return null
    }
    const [id] = useTimelineStore.getState().insertAudioClips([
      { assetId: asset.id, startSec: Math.max(0, atSec), durationSec: asset.durationSec },
    ])
    return id ?? null
  } catch (e) {
    if (importedId) await rollbackImportedAssets([importedId])
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

/**
 * Read the original caption track aloud — one clip per line, placed at each
 * caption's start on a dedicated audio track. "Original" = the first text track
 * in stack order (same as translate-runner). Returns the number of lines spoken.
 *
 * Ownership-gated: switch/close mid-run aborts, rolls back any assets already
 * imported for this job, and never mutates the newly opened project.
 */
export async function speakCaptions(
  opts: TtsOptions,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  const ownership = captureProjectOwnership()
  if (!stillOwnsProject(ownership) || ownership.projectId !== opts.projectId) return 0

  const { timeline } = useTimelineStore.getState()
  const firstTextTrack = timeline.tracks.find((t) => t.kind === 'text')
  if (!firstTextTrack) return 0

  const clips = timeline.clips
    .filter((c) => c.trackId === firstTextTrack.id && !!c.textData?.content?.trim())
    .sort((a, b) => a.startSec - b.startSec)
  if (clips.length === 0) return 0

  const importedIds: string[] = []
  try {
    if (!stillOwnsProject(ownership)) return 0

    const blobs = await runTtsJob(
      clips.map((c) => c.textData!.content),
      opts,
      onProgress,
      signal,
      ownership,
    )

    if (!stillOwnsProject(ownership)) return 0

    // Import the produced wavs (skipping any blank line), keeping caption timing.
    const imported: { caption: Clip; assetId: string; durationSec: number }[] = []
    for (let i = 0; i < clips.length; i++) {
      const blob = blobs[i]
      if (!blob) continue
      if (!stillOwnsProject(ownership)) {
        await rollbackImportedAssets(importedIds)
        return 0
      }
      const asset = await importWavOnly(blob, opts.projectId, `Voice ${i + 1}.wav`)
      importedIds.push(asset.id)
      if (!stillOwnsProject(ownership)) {
        await rollbackImportedAssets(importedIds)
        return 0
      }
      useProjectStore.getState().addAsset(asset)
      imported.push({ caption: clips[i]!, assetId: asset.id, durationSec: asset.durationSec })
    }

    if (!stillOwnsProject(ownership)) {
      await rollbackImportedAssets(importedIds)
      return 0
    }

    const starts = planCaptionVoice(
      imported.map((x) => ({
        captionStartSec: x.caption.startSec,
        captionEndSec: x.caption.startSec + clipEffectiveDuration(x.caption),
        voiceDurationSec: x.durationSec,
      })),
      opts.captionMode ?? 'timeline',
    )
    const seeds = imported.map((x, i) => ({
      assetId: x.assetId,
      startSec: starts[i]!,
      durationSec: x.durationSec,
      // Keep the generated voice attached to the caption that produced it.
      // Timeline speed edits can then remap both instead of leaving this audio
      // clip at a stale absolute timestamp.
      syncToClipId: x.caption.id,
    }))
    if (!stillOwnsProject(ownership)) {
      await rollbackImportedAssets(importedIds)
      return 0
    }
    useTimelineStore.getState().insertAudioClips(seeds, { trackName: 'Voiceover' })
    return seeds.length
  } catch (e) {
    await rollbackImportedAssets(importedIds)
    if (e instanceof DOMException && e.name === 'AbortError') return 0
    throw e
  }
}

/**
 * Synthesize a short sample with `voiceId` and return the WAV blob WITHOUT
 * touching the timeline — used by the Voice Studio "preview" button.
 */
export async function previewVoice(
  voiceId: string,
  sampleText = 'Hello, this is a voice preview.',
): Promise<Blob> {
  const [blob] = await runTtsJob([sampleText], { voice: voiceId })
  if (!blob) throw new Error('No audio produced')
  return blob
}
