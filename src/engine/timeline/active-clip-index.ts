/**
 * Temporal active-clip index (S6 / F06).
 *
 * Baseline problem: PreviewCanvas + export frame loop each did
 *   clips.filter(clipIsActiveAt).sort(trackOrder)
 * per frame → O(N) per frame (and O(N log N) with sort), linear in total
 * clips including 10k captions.
 *
 * Invariants (must match `clipIsActiveAt` + existing paint order):
 *
 * 1. **Boundary**: half-open interval
 *      active ⇔ startSec ≤ t < startSec + clipEffectiveDuration(clip)
 *    So t === end is inactive; t === start is active.
 * 2. **Hidden tracks**: excluded from the index (same as Preview/export).
 * 3. **Muted**: does NOT affect active membership (only volume / audio path).
 * 4. **Paint / z-order**: among active clips of a kind, sort by track index
 *    descending (later track in the non-hidden kind list paints first in the
 *    comparator `order(b) - order(a)` — higher index first), then by original
 *    clip-array index ascending for stability when two clips share a track.
 * 5. **Compound**: callers pass **already flattened** clips (flatTimeline() /
 *    export flatten). The index does not expand compounds.
 * 6. **Zero duration**: end ≤ start → never active; not inserted.
 *
 * Structures:
 * - **Augmented interval tree** (random access / preview seek): balanced by
 *   start with subtree maxEnd pruning; memory stays O(number of clips).
 * - **Sweep cursor** (export monotonic t): start/end events, O(N + F·A).
 */

import { clipEffectiveDuration, type Clip, type Track } from './types'

/** Visual kinds that Preview/export composite (not pure audio tracks). */
export type VisualKind = 'video' | 'fx' | 'text'

export interface IndexedInterval {
  clip: Clip
  /** Inclusive start (timeline sec). */
  start: number
  /** Exclusive end (timeline sec). */
  end: number
  /** Index among non-hidden tracks of this kind (0 = first). Higher paints first. */
  trackOrder: number
  /** Index in the source clips array (stable tie-break). */
  clipIndex: number
}

function paintCompare(a: IndexedInterval, b: IndexedInterval): number {
  // Higher trackOrder first (matches sort: order(b) - order(a)).
  if (a.trackOrder !== b.trackOrder) return b.trackOrder - a.trackOrder
  return a.clipIndex - b.clipIndex
}

function isActiveInterval(iv: IndexedInterval, t: number): boolean {
  return t >= iv.start && t < iv.end
}

/** Build trackId → order for one kind, skipping hidden tracks. */
export function buildTrackOrder(tracks: Track[], kind: VisualKind): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tracks) {
    if (t.hidden) continue
    if (t.kind === kind) m.set(t.id, m.size)
  }
  return m
}

export interface ActiveClipIndexOptions {
  /** Extra predicate after time/track membership (e.g. require textData). */
  filter?: (clip: Clip) => boolean
}

interface IntervalTreeNode {
  iv: IndexedInterval
  maxEnd: number
  left: IntervalTreeNode | null
  right: IntervalTreeNode | null
}

/** Balanced start-ordered tree augmented with the latest end in each subtree. */
function buildIntervalTree(intervals: readonly IndexedInterval[]): IntervalTreeNode | null {
  if (intervals.length === 0) return null
  const sorted = [...intervals].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    if (a.end !== b.end) return a.end - b.end
    return a.clipIndex - b.clipIndex
  })
  const build = (lo: number, hi: number): IntervalTreeNode | null => {
    if (lo >= hi) return null
    const mid = lo + Math.floor((hi - lo) / 2)
    const left = build(lo, mid)
    const right = build(mid + 1, hi)
    const iv = sorted[mid]!
    return {
      iv,
      left,
      right,
      maxEnd: Math.max(iv.end, left?.maxEnd ?? -Infinity, right?.maxEnd ?? -Infinity),
    }
  }
  return build(0, sorted.length)
}

function queryIntervalTree(
  node: IntervalTreeNode | null,
  t: number,
  active: IndexedInterval[],
): void {
  if (!node || node.maxEnd <= t) return
  if (node.left && node.left.maxEnd > t) queryIntervalTree(node.left, t, active)
  if (isActiveInterval(node.iv, t)) active.push(node.iv)
  // Starts are ordered: when this node starts after t, its right subtree does too.
  if (node.iv.start <= t) queryIntervalTree(node.right, t, active)
}

/**
 * Immutable index for a given (clips, tracks) revision.
 * Rebuild when clips or tracks array references change.
 */
export class ActiveClipIndex {
  readonly clipsRef: readonly Clip[]
  readonly tracksRef: readonly Track[]
  private readonly byKind = new Map<VisualKind, {
    intervals: IndexedInterval[]
    /** Same intervals ordered by start time for bounded look-ahead queries. */
    byStart: IndexedInterval[]
    /** Balanced interval tree: one node per clip, independent of duration. */
    tree: IntervalTreeNode | null
    trackOrder: Map<string, number>
  }>()

  private constructor(clips: readonly Clip[], tracks: readonly Track[]) {
    this.clipsRef = clips
    this.tracksRef = tracks
  }

  static build(
    clips: readonly Clip[],
    tracks: readonly Track[],
    opts?: ActiveClipIndexOptions,
  ): ActiveClipIndex {
    const idx = new ActiveClipIndex(clips, tracks)
    const kinds: VisualKind[] = ['video', 'fx', 'text']
    for (const kind of kinds) {
      const trackOrder = buildTrackOrder(tracks as Track[], kind)
      const intervals: IndexedInterval[] = []
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i]!
        const order = trackOrder.get(clip.trackId)
        if (order === undefined) continue
        if (opts?.filter && !opts.filter(clip)) continue
        // Kind-specific presence checks matching export/preview filters.
        if (kind === 'fx' && !clip.fxData) continue
        if (kind === 'text' && !clip.textData) continue
        // Only index clips on tracks of this kind (trackOrder already kind-filtered).
        const start = clip.startSec
        const end = start + clipEffectiveDuration(clip)
        if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue
        intervals.push({ clip, start, end, trackOrder: order, clipIndex: i })
      }
      const byStart = [...intervals].sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start
        return paintCompare(a, b)
      })
      idx.byKind.set(kind, { intervals, byStart, tree: buildIntervalTree(intervals), trackOrder })
    }
    return idx
  }

  /** True if this index still matches the live clip/track arrays. */
  matches(clips: readonly Clip[], tracks: readonly Track[]): boolean {
    return this.clipsRef === clips && this.tracksRef === tracks
  }

  /**
   * Active clips of `kind` at time `t`, in paint order.
   * Random-access (preview scrub / seek).
   */
  queryAt(kind: VisualKind, t: number): Clip[] {
    const pack = this.byKind.get(kind)
    if (!pack) return []
    const active: IndexedInterval[] = []
    queryIntervalTree(pack.tree, t, active)
    active.sort(paintCompare)
    return active.map((iv) => iv.clip)
  }

  /**
   * Clips whose start lies in `(after, through]`, ordered by start time.
   * Used by preview to pre-seek the next decoder without scanning all clips on
   * every animation frame.
   */
  queryStartingBetween(
    kind: VisualKind,
    after: number,
    through: number,
    limit = Number.POSITIVE_INFINITY,
  ): Clip[] {
    const sorted = this.byKind.get(kind)?.byStart
    if (!sorted || through <= after || limit <= 0) return []
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (sorted[mid]!.start <= after) lo = mid + 1
      else hi = mid
    }
    const out: Clip[] = []
    for (let i = lo; i < sorted.length && out.length < limit; i++) {
      const iv = sorted[i]!
      if (iv.start > through) break
      out.push(iv.clip)
    }
    return out
  }

  /** Monotonic forward cursor for export frame loops. */
  createSweep(kind: VisualKind): ActiveClipSweep {
    const pack = this.byKind.get(kind)
    return new ActiveClipSweep(pack?.intervals ?? [])
  }

  /** Test/benchmark: total indexed intervals for a kind. */
  intervalCount(kind: VisualKind): number {
    return this.byKind.get(kind)?.intervals.length ?? 0
  }
}

interface SweepEvent {
  t: number
  /** -1 = end (remove), +1 = start (add). Ends sorted before starts at equal t. */
  delta: -1 | 1
  iv: IndexedInterval
}

/**
 * Sweep-line cursor: advanceTo(t) only moves forward (or restarts if t jumps back).
 * Export uses increasing frame times so restart is rare.
 */
export class ActiveClipSweep {
  private readonly events: SweepEvent[]
  private eventPos = 0
  private currentT = -Infinity
  private readonly active = new Map<string, IndexedInterval>() // clip.id → iv

  constructor(intervals: IndexedInterval[]) {
    const events: SweepEvent[] = []
    for (const iv of intervals) {
      events.push({ t: iv.start, delta: 1, iv })
      events.push({ t: iv.end, delta: -1, iv })
    }
    // At the same t: process ends before starts so half-open [s,e) is correct
    // when one clip ends exactly where another begins.
    events.sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t
      if (a.delta !== b.delta) return a.delta - b.delta // -1 before +1
      return a.iv.clipIndex - b.iv.clipIndex
    })
    this.events = events
  }

  /** Active clips at t in paint order. Supports backward seek via restart. */
  advanceTo(t: number): Clip[] {
    if (t < this.currentT) {
      this.eventPos = 0
      this.active.clear()
      this.currentT = -Infinity
    }
    // Apply all events with time ≤ t.
    // For ends at t: remove (t < end is false at t === end).
    // For starts at t: add (t >= start).
    const evs = this.events
    let i = this.eventPos
    while (i < evs.length && evs[i]!.t <= t) {
      const e = evs[i]!
      if (e.delta === 1) this.active.set(e.iv.clip.id, e.iv)
      else this.active.delete(e.iv.clip.id)
      i++
    }
    this.eventPos = i
    this.currentT = t
    const list = [...this.active.values()]
    list.sort(paintCompare)
    return list.map((iv) => iv.clip)
  }
}

/** Linear baseline used for parity tests / pre-S6 benchmark. */
export function activeClipsLinear(
  clips: readonly Clip[],
  tracks: readonly Track[],
  kind: VisualKind,
  t: number,
): Clip[] {
  const trackOrder = buildTrackOrder(tracks as Track[], kind)
  const active: IndexedInterval[] = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    const order = trackOrder.get(clip.trackId)
    if (order === undefined) continue
    if (kind === 'fx' && !clip.fxData) continue
    if (kind === 'text' && !clip.textData) continue
    const start = clip.startSec
    const end = start + clipEffectiveDuration(clip)
    if (t >= start && t < end) {
      active.push({ clip, start, end, trackOrder: order, clipIndex: i })
    }
  }
  active.sort(paintCompare)
  return active.map((iv) => iv.clip)
}

/** Count how many clipIsActiveAt-style checks a linear scan would perform. */
export function linearScanCheckCount(clips: readonly Clip[]): number {
  return clips.length
}
