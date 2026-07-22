import type { Clip, TimelineState, Track } from '@engine/timeline'

export const MAX_HISTORY_ENTRIES = 60
export const MAX_HISTORY_ESTIMATED_BYTES = 128 * 1024 * 1024

export interface HistoryBudgetSnapshot {
  clips: Clip[]
  tracks: Track[]
  compounds: Record<string, { name: string; timeline: TimelineState }>
}

const snapshotSizeCache = new WeakMap<object, number>()

function stringBytes(value: string | undefined): number {
  return (value?.length ?? 0) * 2
}

function estimateClip(clip: Clip): number {
  let bytes = 320 + stringBytes(clip.id) + stringBytes(clip.assetId ?? undefined)
  bytes += stringBytes(clip.trackId) + stringBytes(clip.groupId) + stringBytes(clip.compoundId)
  bytes += (clip.effects?.length ?? 0) * 112
  if (clip.textData) {
    const text = clip.textData
    bytes += 320 + stringBytes(text.content) + stringBytes(text.fontFamily)
    bytes += stringBytes(text.color) + stringBytes(text.backgroundColor)
    bytes += stringBytes(text.highlightColor) + stringBytes(text.stroke?.color)
    for (const word of text.wordTimestamps ?? []) bytes += 40 + stringBytes(word.word)
  }
  for (const keyframes of Object.values(clip.keyframes ?? {})) {
    bytes += (keyframes?.length ?? 0) * 32
  }
  return bytes
}

function estimateTimeline(timeline: Pick<TimelineState, 'clips' | 'tracks'>): number {
  let bytes = 128 + timeline.clips.length * 8 + timeline.tracks.length * 8
  for (const clip of timeline.clips) bytes += estimateClip(clip)
  for (const track of timeline.tracks) {
    bytes += 160 + stringBytes(track.id) + stringBytes(track.name)
  }
  return bytes
}

export function estimateHistorySnapshotBytes(snapshot: HistoryBudgetSnapshot): number {
  const cached = snapshotSizeCache.get(snapshot as object)
  if (cached !== undefined) return cached
  let bytes = estimateTimeline(snapshot)
  for (const [id, compound] of Object.entries(snapshot.compounds)) {
    bytes += 96 + stringBytes(id) + stringBytes(compound.name)
    bytes += estimateTimeline(compound.timeline)
  }
  snapshotSizeCache.set(snapshot as object, bytes)
  return bytes
}

/** Keep newest entries when newest is at the end (the `past` stack). */
export function trimHistoryTail<T extends HistoryBudgetSnapshot>(entries: T[]): T[] {
  let bytes = 0
  let first = entries.length
  const min = Math.max(0, entries.length - MAX_HISTORY_ENTRIES)
  for (let index = entries.length - 1; index >= min; index -= 1) {
    const weight = estimateHistorySnapshotBytes(entries[index]!)
    if (first < entries.length && bytes + weight > MAX_HISTORY_ESTIMATED_BYTES) break
    bytes += weight
    first = index
  }
  return entries.slice(first)
}

/** Keep newest entries when newest is at the beginning (the `future` stack). */
export function trimHistoryHead<T extends HistoryBudgetSnapshot>(entries: T[]): T[] {
  let bytes = 0
  let count = 0
  const max = Math.min(entries.length, MAX_HISTORY_ENTRIES)
  while (count < max) {
    const weight = estimateHistorySnapshotBytes(entries[count]!)
    if (count > 0 && bytes + weight > MAX_HISTORY_ESTIMATED_BYTES) break
    bytes += weight
    count += 1
  }
  return entries.slice(0, count)
}
