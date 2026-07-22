/**
 * Sequential-track boundary normalization for dense editor timelines.
 *
 * Both build tracks that are sequential by construction, but independently-
 * rounded positions/durations (and min-duration floors like the editor's
 * 0.01s clip floor or the 0.1s caption floor) can leave neighbouring clips
 * overlapping by a few milliseconds. Left in place, every such boundary keeps
 * TWO same-asset clips active at once, so the preview must open a second
 * decoder at each cut — the visible freeze/stutter at clip edges — and the
 * editor's collision resolver bumps the clip to a new row when first clicked.
 *
 * Only the previous clip's source out-point changes. textData (and its shared
 * style/animation settings), effects, ids, and track membership remain
 * untouched.
 */
import { clipEffectiveDuration, type Clip } from './types'

const MIN_TRIMMED_CLIP_SEC = 0.01

export function closeSequentialTrackOverlaps(
  clips: readonly Clip[],
  sequentialTrackIds: readonly string[],
): Clip[] {
  const replacements = new Map<string, Clip>()

  for (const trackId of sequentialTrackIds) {
    const ordered = clips
      .filter((clip) => clip.trackId === trackId)
      .slice()
      .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))

    for (let index = 0; index < ordered.length - 1; index++) {
      const current = replacements.get(ordered[index]!.id) ?? ordered[index]!
      const following = ordered[index + 1]!
      const availableDuration = following.startSec - current.startSec
      if (!Number.isFinite(availableDuration) || availableDuration < MIN_TRIMMED_CLIP_SEC) {
        continue
      }
      if (clipEffectiveDuration(current) <= availableDuration + 1e-7) continue

      const speed = Number.isFinite(current.speed) && current.speed > 0 ? current.speed : 1
      replacements.set(current.id, {
        ...current,
        outPointSec: current.inPointSec + availableDuration * speed,
      })
    }
  }

  if (replacements.size === 0) return clips.slice()
  return clips.map((clip) => replacements.get(clip.id) ?? clip)
}
