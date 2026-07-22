import { clipEffectiveDuration, type Clip } from '@engine/timeline'
import { ABSOLUTE_MIN_TIMELINE_ZOOM } from '@engine/timeline/zoom'

export const TIMELINE_SNAP_PX = 8

export interface TimelineSnapResult {
  sec: number
  guideSec: number | null
}

export interface TimelineRangeSnapResult {
  startSec: number
  guideSec: number | null
}

export function collectTimelineSnapTargets(
  clips: Clip[],
  opts: { excludeIds?: string[]; playheadSec?: number } = {},
): number[] {
  const excluded = new Set(opts.excludeIds ?? [])
  const targets = new Set<number>([0])
  if (opts.playheadSec != null && Number.isFinite(opts.playheadSec)) {
    targets.add(Math.max(0, opts.playheadSec))
  }
  for (const clip of clips) {
    if (excluded.has(clip.id)) continue
    targets.add(clip.startSec)
    targets.add(clip.startSec + clipEffectiveDuration(clip))
  }
  return [...targets].sort((a, b) => a - b)
}

export function snapTimelineSec(sec: number, targets: number[], zoom: number): TimelineSnapResult {
  const threshold = TIMELINE_SNAP_PX / Math.max(zoom, ABSOLUTE_MIN_TIMELINE_ZOOM)
  let guideSec: number | null = null
  let bestDist = threshold
  for (const target of targets) {
    const dist = Math.abs(sec - target)
    if (dist < bestDist) {
      guideSec = target
      bestDist = dist
    }
  }
  return guideSec == null ? { sec, guideSec: null } : { sec: guideSec, guideSec }
}

/** Snap an edge while respecting the operation's hard limits. The guide is only
 *  returned when the snapped target survives clamping, so the UI never shows a
 *  guide for a position the clip cannot actually reach. */
export function snapTimelineSecWithinLimits(
  sec: number,
  targets: number[],
  zoom: number,
  minSec: number,
  maxSec: number,
): TimelineSnapResult {
  const clamped = Math.max(minSec, Math.min(maxSec, sec))
  const snapped = snapTimelineSec(clamped, targets, zoom)
  const limited = Math.max(minSec, Math.min(maxSec, snapped.sec))
  const guideSec =
    snapped.guideSec != null && Math.abs(limited - snapped.sec) < 1e-3
      ? snapped.guideSec
      : null
  return { sec: limited, guideSec }
}

export function snapTimelineRangeStart(
  rawStartSec: number,
  durationSec: number,
  targets: number[],
  zoom: number,
  limits: { minStartSec?: number; maxStartSec?: number } = {},
): TimelineRangeSnapResult {
  const minStart = limits.minStartSec ?? 0
  const maxStart = limits.maxStartSec ?? Infinity
  const threshold = TIMELINE_SNAP_PX / Math.max(zoom, ABSOLUTE_MIN_TIMELINE_ZOOM)
  const rawEndSec = rawStartSec + durationSec
  let best: { startSec: number; guideSec: number; dist: number } | null = null

  for (const target of targets) {
    const startDist = Math.abs(rawStartSec - target)
    if (startDist <= threshold && target >= minStart && target <= maxStart) {
      best = chooseCloser(best, { startSec: target, guideSec: target, dist: startDist })
    }

    const endStart = target - durationSec
    const endDist = Math.abs(rawEndSec - target)
    if (endDist <= threshold && endStart >= minStart && endStart <= maxStart) {
      best = chooseCloser(best, { startSec: endStart, guideSec: target, dist: endDist })
    }
  }

  return best ? { startSec: best.startSec, guideSec: best.guideSec } : { startSec: rawStartSec, guideSec: null }
}

function chooseCloser<T extends { dist: number }>(current: T | null, candidate: T): T {
  return !current || candidate.dist < current.dist ? candidate : current
}
