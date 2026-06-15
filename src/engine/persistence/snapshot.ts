import {
  makeDefaultAdjust,
  makeDefaultTransform,
  type Clip,
  type Track,
} from '@engine/timeline'

import type { ProjectSnapshot } from './types'

/** Fill in fields that may be missing from older saved snapshots. */
export function normalizeClip(raw: unknown): Clip {
  const c = raw as Clip
  return {
    ...c,
    speed: c.speed ?? 1,
    opacity: c.opacity ?? 1,
    volume: c.volume ?? 1,
    adjust: c.adjust ?? makeDefaultAdjust(),
    transform: { ...makeDefaultTransform(), ...c.transform },
    effects: c.effects ?? [],
  }
}

export interface DeserializedTimeline {
  clips: Clip[]
  tracks: Track[]
  fps: number
  durationSec: number
}

/** Turn a stored snapshot into timeline state ready for `replaceTimeline`. */
export function snapshotToTimeline(snap: ProjectSnapshot): DeserializedTimeline {
  const clips = (snap.clips as unknown[]).map(normalizeClip)
  const tracks = snap.tracks as unknown as Track[]
  const durationSec = clips.reduce(
    (acc, c) =>
      Math.max(acc, c.startSec + (c.outPointSec - c.inPointSec) / Math.max(c.speed, 0.01)),
    0,
  )
  return { clips, tracks, fps: snap.fps ?? 30, durationSec }
}
