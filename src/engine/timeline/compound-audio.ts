import type { MediaAsset } from '@engine/media'

import { clipEffectiveDuration, type Clip, type TimelineState } from './types'

/** A small asset view that keeps the waveform compositor independent of the
 * project store and easy to test. */
export type WaveformAsset = Pick<MediaAsset, 'waveformPeaks' | 'durationSec'>

function trackIsAudible(timeline: TimelineState, clip: Clip): boolean {
  const track = timeline.tracks.find((candidate) => candidate.id === clip.trackId)
  return (
    !!track &&
    !track.muted &&
    !track.hidden &&
    (track.kind === 'audio' || track.kind === 'video')
  )
}

/** Compose child waveforms visible through a compound clip window. Samples use
 * a max envelope in timeline space, which preserves overlaps and speed changes. */
export function compoundWindowPeaks(
  timeline: TimelineState,
  windowStartSec: number,
  windowEndSec: number,
  assets: ReadonlyMap<string, WaveformAsset>,
  buckets = 512,
): number[] {
  const start = Math.min(windowStartSec, windowEndSec)
  const end = Math.max(windowStartSec, windowEndSec)
  const count = Math.max(2, Math.min(2048, Math.floor(buckets)))
  const out = new Array<number>(count).fill(0)
  const span = Math.max(end - start, 1e-6)
  const bucketWidth = span / count

  for (const clip of timeline.clips) {
    if (!clip.assetId || clip.muted || clip.volume <= 0 || !trackIsAudible(timeline, clip)) {
      continue
    }
    const asset = assets.get(clip.assetId)
    const peaks = asset?.waveformPeaks
    if (!peaks || peaks.length < 2) continue
    const speed = Number.isFinite(clip.speed) ? Math.max(clip.speed, 0.01) : 1
    const clipStart = clip.startSec
    const clipEnd = clipStart + clipEffectiveDuration(clip)
    const visibleStart = Math.max(start, clipStart)
    const visibleEnd = Math.min(end, clipEnd)
    if (visibleEnd <= visibleStart) continue

    const sourceDuration = Math.max(clip.outPointSec - clip.inPointSec, 0)
    if (sourceDuration <= 0) continue
    const assetDuration = Math.max(asset.durationSec || clip.outPointSec, 1e-6)
    const sampleSource = (timelineSec: number): number => {
      const sourceSec = clip.inPointSec + (timelineSec - clipStart) * speed
      const normalized = Math.max(0, Math.min(0.999999, sourceSec / assetDuration))
      const index = normalized * (peaks.length - 1)
      const left = Math.floor(index)
      const right = Math.min(peaks.length - 1, left + 1)
      const mix = index - left
      return ((peaks[left] ?? 0) * (1 - mix) + (peaks[right] ?? 0) * mix) * clip.volume
    }

    const first = Math.max(0, Math.floor((visibleStart - start) / bucketWidth))
    const last = Math.min(count - 1, Math.ceil((visibleEnd - start) / bucketWidth) - 1)
    for (let i = first; i <= last; i += 1) {
      const bucketStart = start + i * bucketWidth
      const bucketEnd = bucketStart + bucketWidth
      const overlapStart = Math.max(bucketStart, visibleStart)
      const overlapEnd = Math.min(bucketEnd, visibleEnd)
      if (overlapEnd <= overlapStart) continue
      const mid = (overlapStart + overlapEnd) / 2
      out[i] = Math.max(
        out[i]!,
        sampleSource(overlapStart),
        sampleSource(mid),
        sampleSource(overlapEnd),
      )
    }
  }
  return out
}
