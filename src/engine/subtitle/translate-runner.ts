import { clipEffectiveDuration } from '@engine/timeline'
import { useTimelineStore } from '@store/timeline-store'

/**
 * Translate the original caption track into `target` and drop the result onto a
 * NEW caption track (same timing), keeping the original. Source is the captions'
 * language ('auto' → the server defaults to English; NLLB is robust to a
 * slightly-off source tag). Returns the number of lines translated.
 *
 * "Original" = the first text track in stack order; previously-translated tracks
 * (added below it) are left alone, so translating again re-translates the source
 * rather than the translations.
 */
export async function translateCaptions(target: string, source = 'english'): Promise<number> {
  const { timeline } = useTimelineStore.getState()
  const firstTextTrack = timeline.tracks.find((t) => t.kind === 'text')
  if (!firstTextTrack) return 0

  const clips = timeline.clips
    .filter((c) => c.trackId === firstTextTrack.id && !!c.textData?.content?.trim())
    .sort((a, b) => a.startSec - b.startSec)
  if (clips.length === 0) return 0

  const { translateViaBackend } = await import('@engine/backend')
  const translations = await translateViaBackend(
    clips.map((c) => c.textData!.content),
    target,
    source,
  )

  const cues = clips.map((c, i) => {
    const translated = translations[i]?.trim()
    if (!translated) {
      throw new Error(`Translation missing caption ${i + 1}/${clips.length}`)
    }
    return {
      content: translated,
      startSec: c.startSec,
      durationSec: clipEffectiveDuration(c),
    }
  })
  // Always land on a fresh dedicated track so the translation sits cleanly
  // beside the original captions instead of interleaving with them.
  useTimelineStore.getState().insertSubtitles(cues, {
    newTrack: true,
    trackName: `Captions (${target})`,
  })
  return cues.length
}
