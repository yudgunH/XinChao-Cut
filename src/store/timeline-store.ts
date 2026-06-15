import { create } from 'zustand'

import { createId } from '@engine/core/id'
import { dedupeSubtitleCues } from '@engine/subtitle/srt'
import {
  clipEffectiveDuration,
  makeClipEffect,
  makeDefaultTextData,
  makeDefaultTimeline,
  makeSubtitleTextData,
  makeDefaultAdjust,
  makeDefaultTransform,
  type Clip,
  type ClipEffectType,
  type ColorAdjust,
  type ClipTransform,
  type DenoiseLevel,
  type BlurStickerData,
  type TextClipData,
  type Track,
  type TrackKind,
  type TimelineState,
} from '@engine/timeline'

import { useUIStore } from './ui-store'

const TRACK_STACK_ORDER: Record<TrackKind, number> = {
  text: 0,
  fx: 1,
  video: 2,
  audio: 3,
}

const TRACK_LABEL: Record<TrackKind, string> = {
  text: 'Text',
  video: 'Video',
  fx: 'FX',
  audio: 'Audio',
}

function sortTracksForStack(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => TRACK_STACK_ORDER[a.kind] - TRACK_STACK_ORDER[b.kind])
}

function insertTrackIntoStack(tracks: Track[], track: Track): Track[] {
  const next = [...tracks]
  const firstSameKindIndex = next.findIndex((candidate) => candidate.kind === track.kind)
  if (firstSameKindIndex >= 0) next.splice(firstSameKindIndex, 0, track)
  else next.push(track)
  return sortTracksForStack(next)
}

function makeTrack(kind: TrackKind, existingTracks: Track[]): Track {
  const nextIndex = existingTracks.filter((track) => track.kind === kind).length + 1
  return {
    id: createId(`track-${kind}`),
    kind,
    name: `${TRACK_LABEL[kind]} ${nextIndex}`,
    muted: false,
    locked: false,
  }
}

function makeBlurStickerData(): BlurStickerData {
  return {
    type: 'blur-sticker',
    x: 0.5,
    y: 0.5,
    w: 0.28,
    h: 0.18,
    blurPx: 18,
    radius: 10,
  }
}

function makeClip(
  partial: Partial<Clip> & Pick<Clip, 'id' | 'trackId' | 'startSec' | 'outPointSec'>,
): Clip {
  return {
    assetId: null,
    inPointSec: 0,
    speed: 1,
    opacity: 1,
    volume: 1,
    adjust: makeDefaultAdjust(),
    transform: makeDefaultTransform(),
    effects: [],
    ...partial,
  }
}

function recalcDuration(clips: Clip[]): number {
  return clips.reduce((acc, c) => Math.max(acc, c.startSec + clipEffectiveDuration(c)), 0)
}

/** True if [startSec, startSec+dur) is free on the track (ignoring excludeIds). */
function trackHasSpace(
  clips: Clip[],
  trackId: string,
  startSec: number,
  dur: number,
  excludeIds: string[],
): boolean {
  const end = startSec + dur
  return !clips.some(
    (c) =>
      c.trackId === trackId &&
      !excludeIds.includes(c.id) &&
      startSec < c.startSec + clipEffectiveDuration(c) &&
      c.startSec < end,
  )
}

/** The "main" video track — the LAST (bottom-most) video-kind track in stack
 *  order, where primary footage sits CapCut-style; overlay video goes above it.
 *  Used by the magnetic-track feature. */
function mainVideoTrackId(tracks: Track[]): string | null {
  // Tracks render top-to-bottom in array order, so the bottom video track is
  // the last video entry in the current stack.
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i]
    if (track?.kind === 'video') return track.id
  }
  return null
}

/**
 * Magnetic main track (CapCut-style): pack the main track's clips left-to-right
 * so each abuts the previous (no gaps), sorted by start — which both closes the
 * gap a deletion/move leaves AND, when a clip is dropped overlapping the
 * sequence, ripples the later clips right to insert it.
 *
 * Crucially, every main-track clip that shifts carries its linked captions/audio
 * with it (when `linkEnabled`): each caption/audio clip rides the main clip it
 * most overlaps, shifted by that clip's delta — so rippled (auto-pushed) clips
 * keep their subtitles in sync, not just the one being dragged.
 *
 * Returns the SAME array reference when nothing moves (cheap no-op detection).
 */
function rippleMainTrack(
  clips: Clip[],
  tracks: Track[],
  mainId: string,
  linkEnabled: boolean,
): Clip[] {
  const main = clips
    .filter((c) => c.trackId === mainId)
    .sort((a, b) => a.startSec - b.startSec)
  if (main.length === 0) return clips

  // Anchor at 0 — the magnetic main track is glued to the start with no leading
  // gap (CapCut behaviour), so deleting the first clip pulls the rest to 0 too.
  let cursor = 0
  const newStart = new Map<string, number>()
  const delta = new Map<string, number>()
  for (const c of main) {
    if (Math.abs(c.startSec - cursor) > 1e-4) {
      newStart.set(c.id, cursor)
      delta.set(c.id, cursor - c.startSec)
    }
    cursor += clipEffectiveDuration(c)
  }
  if (newStart.size === 0) return clips

  // Each caption/audio clip rides the main clip it overlaps most (pre-ripple).
  const linkShift = new Map<string, number>()
  if (linkEnabled) {
    const kindOf = (id: string) => tracks.find((t) => t.id === id)?.kind
    for (const c of clips) {
      const k = kindOf(c.trackId)
      if (k !== 'text' && k !== 'audio') continue
      const cs = c.startSec
      const ce = c.startSec + clipEffectiveDuration(c)
      let bestId: string | null = null
      let bestOverlap = 1e-4
      for (const m of main) {
        const ms = m.startSec
        const me = ms + clipEffectiveDuration(m)
        const overlap = Math.min(ce, me) - Math.max(cs, ms)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          bestId = m.id
        }
      }
      if (bestId && delta.has(bestId)) linkShift.set(c.id, delta.get(bestId)!)
    }
  }

  return clips.map((c) => {
    if (newStart.has(c.id)) return { ...c, startSec: newStart.get(c.id)! }
    if (linkShift.has(c.id)) return { ...c, startSec: Math.max(0, c.startSec + linkShift.get(c.id)!) }
    return c
  })
}

/**
 * Live preview of where NON-dragged main-track clips (and their linked
 * captions/audio) slide to while a magnetic drag is in progress — so the lift
 * gap closes and an insertion gap opens in real time (the CapCut feel).
 *
 * The dragged clip itself keeps following the cursor (rendered via dragDeltaSec);
 * this only repositions the siblings it ripples past. Returns clip id → preview
 * startSec, or null when nothing should move.
 */
function computeRipplePreview(
  clips: Clip[],
  tracks: Track[],
  mainId: string,
  draggedIds: string[],
  delta: number,
  linkEnabled: boolean,
): Record<string, number> | null {
  const dragged = new Set(draggedIds)
  const draggedMain = clips
    .filter((c) => dragged.has(c.id) && c.trackId === mainId)
    .sort((a, b) => a.startSec - b.startSec)
  if (draggedMain.length === 0) return null

  const others = clips
    .filter((c) => c.trackId === mainId && !dragged.has(c.id))
    .sort((a, b) => a.startSec - b.startSec)

  const dragStart = Math.max(0, draggedMain[0]!.startSec + delta)
  const dragDur = draggedMain.reduce((sum, c) => sum + clipEffectiveDuration(c), 0)
  // Insert index = siblings starting before the dragged clip. Uses startSec to
  // match exactly how commitClipDrag → rippleMainTrack sorts on drop, so the
  // live preview and the committed result never disagree.
  let insertIdx = 0
  for (const c of others) {
    if (c.startSec < dragStart) insertIdx++
    else break
  }

  const preview: Record<string, number> = {}
  const movedDelta = new Map<string, number>()
  let cursor = 0
  for (let i = 0; i < others.length; i++) {
    if (i === insertIdx) cursor += dragDur // reserve the slot for the dragged clip
    const c = others[i]!
    if (Math.abs(c.startSec - cursor) > 1e-4) {
      preview[c.id] = cursor
      movedDelta.set(c.id, cursor - c.startSec)
    }
    cursor += clipEffectiveDuration(c)
  }

  if (linkEnabled) {
    const kindOf = (id: string) => tracks.find((t) => t.id === id)?.kind
    for (const c of clips) {
      if (dragged.has(c.id)) continue
      const k = kindOf(c.trackId)
      if (k !== 'text' && k !== 'audio') continue
      const cs = c.startSec
      const ce = c.startSec + clipEffectiveDuration(c)
      let bestId: string | null = null
      let bestOverlap = 1e-4
      for (const m of others) {
        const ms = m.startSec
        const me = ms + clipEffectiveDuration(m)
        const overlap = Math.min(ce, me) - Math.max(cs, ms)
        if (overlap > bestOverlap) {
          bestOverlap = overlap
          bestId = m.id
        }
      }
      if (bestId && movedDelta.has(bestId)) preview[c.id] = Math.max(0, cs + movedDelta.get(bestId)!)
    }
  }

  return Object.keys(preview).length > 0 ? preview : null
}

/**
 * Find a same-kind track where the clip fits without overlapping. Tries the
 * preferred track first, then other same-kind tracks (stack order), and finally
 * creates a brand-new track. Returns the (possibly grown) tracks array.
 */
function placeOnFreeTrack(
  tracks: Track[],
  clips: Clip[],
  kind: TrackKind,
  startSec: number,
  dur: number,
  excludeIds: string[],
  preferredTrackId?: string,
): { trackId: string; tracks: Track[] } {
  const candidates: Track[] = []
  const preferred = preferredTrackId ? tracks.find((t) => t.id === preferredTrackId) : undefined
  if (preferred && preferred.kind === kind && !preferred.locked) candidates.push(preferred)
  for (const t of tracks) {
    if (t.kind === kind && !t.locked && t.id !== preferred?.id) candidates.push(t)
  }
  for (const t of candidates) {
    if (trackHasSpace(clips, t.id, startSec, dur, excludeIds)) return { trackId: t.id, tracks }
  }
  const nt = makeTrack(kind, tracks)
  return { trackId: nt.id, tracks: insertTrackIntoStack(tracks, nt) }
}

/** Add new clips, bumping each to a free/new track of its own kind so none overlap. */
function addClipsWithoutOverlap(
  tracks: Track[],
  existing: Clip[],
  seeds: Clip[],
): { tracks: Track[]; clips: Clip[]; added: Clip[] } {
  let workTracks = tracks
  const workClips = [...existing]
  const added: Clip[] = []
  for (const seed of seeds) {
    const kind = tracks.find((t) => t.id === seed.trackId)?.kind ?? 'video'
    const dur = clipEffectiveDuration(seed)
    const placement = placeOnFreeTrack(
      workTracks,
      workClips,
      kind,
      seed.startSec,
      dur,
      [],
      seed.trackId,
    )
    workTracks = placement.tracks
    const clip = { ...seed, trackId: placement.trackId }
    workClips.push(clip)
    added.push(clip)
  }
  return { tracks: workTracks, clips: workClips, added }
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids))
}

function clipIdsOnTracks(clips: Clip[], trackIds: string[]): string[] {
  const selectedTracks = new Set(trackIds)
  return clips.filter((clip) => selectedTracks.has(clip.trackId)).map((clip) => clip.id)
}

interface HistorySnapshot {
  clips: Clip[]
  tracks: Track[]
  durationSec: number
}

const MAX_HISTORY = 60

interface InsertClipParams {
  trackId: string
  assetId: string
  startSec: number
  durationSec: number
}

interface TimelineStoreState {
  timeline: TimelineState
  selectedClipIds: string[]
  selectedTrackIds: string[]
  clipboard: Clip[]
  zoom: number
  // Transient multi-clip drag (not persisted / not in history)
  draggingIds: string[]
  dragDeltaSec: number
  dragDeltaYPx: number
  /** Live magnetic-ripple preview during a drag: clip id → previewed startSec
   *  for NON-dragged clips that reflow (main-track siblings + their captions),
   *  so they slide in real time as CapCut does. null when not rippling. */
  dragRipplePreview: Record<string, number> | null
  dragTargetTrackId: string | null
  /** When set, dropping the drag creates a NEW track of this kind (CapCut-style
   *  "drag a clip past the edge to spawn a track"). */
  dragCreateKind: TrackKind | null
  past: HistorySnapshot[]
  future: HistorySnapshot[]
  canUndo: boolean
  canRedo: boolean

  insertClip: (p: InsertClipParams) => string
  insertTextClip: (startSec: number, durationSec: number) => string
  insertBlurSticker: (startSec: number, durationSec: number) => string
  insertSubtitles: (
    cues: { content: string; startSec: number; durationSec: number; words?: { word: string; startSec: number; endSec: number }[] }[],
    opts?: { newTrack?: boolean; trackName?: string },
  ) => void
  removeClips: (ids: string[]) => void
  moveClip: (id: string, newStartSec: number) => void
  trimClipLeft: (id: string, newStartSec: number, newInPointSec: number) => void
  /** Left-trim a text clip: it has no source media, so the left edge moves the
   *  start while growing the duration (outPoint), keeping the right edge put. */
  trimClipLeftText: (id: string, newStartSec: number, newOutPointSec: number) => void
  trimClipRight: (id: string, newOutPointSec: number) => void
  /** Pack the main video track so its clips abut with no gaps (magnetic). */
  collapseMainVideoTrack: () => void
  trimClipsLeftTo: (ids: string[], atTimelineSec: number) => void
  trimClipsRightTo: (ids: string[], atTimelineSec: number) => void
  beginHistoryStep: () => void
  splitClip: (clipId: string, atTimelineSec: number) => void
  splitClipAtSourceTimes: (clipId: string, sourceTimes: number[]) => number
  setClipSpeed: (id: string, speed: number) => void
  setClipOpacity: (id: string, opacity: number) => void
  setClipVolume: (id: string, volume: number) => void
  setClipsMuted: (ids: string[], muted: boolean) => void
  applyClipEffect: (ids: string[], type: ClipEffectType) => void
  updateClipEffect: (clipId: string, effectId: string, params: Record<string, number | string | boolean>) => void
  removeClipEffect: (clipId: string, effectId: string) => void
  removeClipEffects: (ids: string[], type: ClipEffectType) => void
  setClipDenoise: (id: string, value: DenoiseLevel | undefined) => void
  setClipText: (id: string, text: Partial<TextClipData>) => void
  /** Set the same text patch on many clips without a history step (for live drag). */
  setClipsText: (ids: string[], text: Partial<TextClipData>) => void
  applyTextStyle: (ids: string[], style: Partial<TextClipData>) => void
  setClipFxData: (id: string, fxData: Partial<BlurStickerData>) => void
  setClipTransform: (id: string, transform: Partial<ClipTransform>) => void
  resetClipTransforms: (ids: string[]) => void
  /** Rotate clips by `deg` (added to current rotation, wrapped to 0..359). */
  rotateClips: (ids: string[], deg: number) => void
  /** Toggle horizontal/vertical mirror on clips. */
  flipClips: (ids: string[], axis: 'h' | 'v') => void
  /** Set the crop rectangle (fractions trimmed per side) on a clip. */
  setClipCrop: (id: string, crop: { l: number; r: number; t: number; b: number }) => void
  setClipAdjust: (id: string, adjust: Partial<ColorAdjust>) => void
  selectClips: (ids: string[]) => void
  toggleSelectClip: (id: string) => void
  selectTracks: (ids: string[], includeClips?: boolean) => void
  toggleSelectTrack: (id: string) => void
  copyClips: (ids: string[]) => void
  cutClips: (ids: string[]) => void
  pasteClips: (atSec: number) => void
  duplicateClips: (ids: string[]) => void
  beginClipDrag: (ids: string[]) => void
  setClipDragDelta: (deltaSec: number, deltaYPx?: number) => void
  setClipDragTargetTrack: (trackId: string | null) => void
  setClipDragCreateKind: (kind: TrackKind | null) => void
  commitClipDrag: () => void
  cancelClipDrag: () => void
  addTrack: (kind: TrackKind) => string
  detachAudio: (clipId: string) => void
  addSeparatedStems: (
    sourceClipId: string,
    stems: { vocalsAssetId?: string; musicAssetId?: string },
  ) => void
  setTracksLocked: (trackIds: string[], locked: boolean) => void
  toggleTrackMuted: (trackId: string) => void
  toggleTrackLocked: (trackId: string) => void
  setZoom: (z: number) => void
  undo: () => void
  redo: () => void
  replaceTimeline: (clips: Clip[], tracks: Track[], fps: number, durationSec: number) => void
}

// ── History helpers ─────────────────────────────────────────

function snap(s: TimelineStoreState): HistorySnapshot {
  return {
    clips: s.timeline.clips,
    tracks: s.timeline.tracks,
    durationSec: s.timeline.durationSec,
  }
}

/**
 * Remove empty tracks (CapCut-style), but keep one empty drop-target per kind
 * that has no clips, and always keep at least one video track.
 */
function pruneEmptyTracks(tracks: Track[], clips: Clip[]): Track[] {
  const used = new Set(clips.map((c) => c.trackId))
  const usedKinds = new Set(tracks.filter((t) => used.has(t.id)).map((t) => t.kind))
  const keptEmptyKind = new Set<TrackKind>()

  const result = tracks.filter((t) => {
    if (used.has(t.id)) return true
    // empty track: keep only one drop-target for kinds that have no clips
    if (!usedKinds.has(t.kind) && !keptEmptyKind.has(t.kind)) {
      keptEmptyKind.add(t.kind)
      return true
    }
    return false
  })

  if (!result.some((t) => t.kind === 'video')) {
    const v = tracks.find((t) => t.kind === 'video') ?? makeTrack('video', result)
    result.push(v)
  }
  return sortTracksForStack(result)
}

function pushPast(
  s: TimelineStoreState,
): Pick<TimelineStoreState, 'past' | 'future' | 'canUndo' | 'canRedo'> {
  return {
    past: [...s.past, snap(s)].slice(-MAX_HISTORY),
    future: [],
    canUndo: true,
    canRedo: false,
  }
}

// ── Store ────────────────────────────────────────────────────

const MIN_DUR = 0.1

export const useTimelineStore = create<TimelineStoreState>((set) => ({
  timeline: makeDefaultTimeline(),
  selectedClipIds: [],
  selectedTrackIds: [],
  clipboard: [],
  zoom: 80,
  draggingIds: [],
  dragDeltaSec: 0,
  dragDeltaYPx: 0,
  dragRipplePreview: null,
  dragTargetTrackId: null,
  dragCreateKind: null,
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  insertClip: ({ trackId, assetId, startSec, durationSec }) => {
    const id = createId('clip')
    const start = Math.max(0, startSec)
    set((s) => {
      const kind = s.timeline.tracks.find((t) => t.id === trackId)?.kind ?? 'video'
      // Bump to a free same-kind track (or a new one) so clips never overlap.
      const { trackId: finalTrack, tracks } = placeOnFreeTrack(
        s.timeline.tracks,
        s.timeline.clips,
        kind,
        start,
        durationSec,
        [],
        trackId,
      )
      const clip = makeClip({
        id,
        assetId,
        trackId: finalTrack,
        startSec: start,
        outPointSec: durationSec,
      })
      const clips = [...s.timeline.clips, clip]
      return {
        ...pushPast(s),
        selectedClipIds: [id],
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    })
    return id
  },

  insertTextClip: (startSec, durationSec) => {
    const id = createId('clip')
    const start = Math.max(0, startSec)
    set((s) => {
      let tracks = s.timeline.tracks
      if (!tracks.some((t) => t.kind === 'text')) {
        tracks = sortTracksForStack([...tracks, makeTrack('text', tracks)])
      }
      const { trackId, tracks: placedTracks } = placeOnFreeTrack(
        tracks,
        s.timeline.clips,
        'text',
        start,
        durationSec,
        [],
      )
      const clip = makeClip({
        id,
        trackId,
        startSec: start,
        outPointSec: durationSec,
        textData: makeDefaultTextData(),
      })
      const clips = [...s.timeline.clips, clip]
      return {
        ...pushPast(s),
        selectedClipIds: [id],
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: placedTracks,
          clips,
          durationSec: recalcDuration(clips),
        },
      }
    })
    return id
  },

  insertBlurSticker: (startSec, durationSec) => {
    const id = createId('clip')
    const start = Math.max(0, startSec)
    set((s) => {
      const dur = Math.max(MIN_DUR, durationSec)
      const placement = placeOnFreeTrack(s.timeline.tracks, s.timeline.clips, 'fx', start, dur, [])
      const clip = makeClip({
        id,
        assetId: null,
        trackId: placement.trackId,
        startSec: start,
        outPointSec: dur,
        fxData: makeBlurStickerData(),
      })
      const clips = [...s.timeline.clips, clip]
      return {
        ...pushPast(s),
        selectedClipIds: [id],
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: placement.tracks,
          clips,
          durationSec: recalcDuration(clips),
        },
      }
    })
    return id
  },

  insertSubtitles: (cues, opts) =>
    set((s) => {
      if (cues.length === 0) return s
      const cleanCues = dedupeSubtitleCues(
        cues.map((cue) => ({
          content: cue.content,
          startSec: cue.startSec,
          endSec: cue.startSec + cue.durationSec,
          words: cue.words,
        })),
      )
      if (cleanCues.length === 0) return s

      let tracks = s.timeline.tracks
      // newTrack: always put these on a fresh dedicated text track (e.g. a
      // translated caption set) so they never interleave with existing captions.
      let textTrack = opts?.newTrack ? undefined : tracks.find((t) => t.kind === 'text')
      if (!textTrack) {
        textTrack = makeTrack('text', tracks)
        if (opts?.trackName) textTrack = { ...textTrack, name: opts.trackName }
        tracks = sortTracksForStack([...tracks, textTrack])
      }
      const seeds = cleanCues.map((cue) =>
        makeClip({
          id: createId('clip'),
          trackId: textTrack!.id,
          startSec: Math.max(0, cue.startSec),
          outPointSec: Math.max(0.1, cue.endSec - cue.startSec),
          textData: makeSubtitleTextData(cue.content, cue.words),
        }),
      )

      // On a brand-new track the cues (non-overlapping among themselves) drop
      // straight in — no overlap-bumping that could scatter or merge them with
      // the originals. Otherwise keep the existing free-placement behaviour.
      if (opts?.newTrack) {
        const clips = [...s.timeline.clips, ...seeds]
        return {
          ...pushPast(s),
          selectedClipIds: seeds.map((c) => c.id),
          selectedTrackIds: [],
          timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
        }
      }

      const placed = addClipsWithoutOverlap(tracks, s.timeline.clips, seeds)
      return {
        ...pushPast(s),
        selectedClipIds: placed.added.map((c) => c.id),
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: placed.tracks,
          clips: placed.clips,
          durationSec: recalcDuration(placed.clips),
        },
      }
    }),

  removeClips: (ids) =>
    set((s) => {
      const { linkEnabled, magneticMainTrack } = useUIStore.getState()
      const kindOf = (trackId: string) => s.timeline.tracks.find((t) => t.id === trackId)?.kind

      const toRemove = new Set(ids)
      // Linkage: deleting a video clip also removes the captions/audio sitting
      // over it (the counterpart to dragging them together). Toggle: linkEnabled.
      if (linkEnabled) {
        const videoRanges = ids
          .map((id) => s.timeline.clips.find((c) => c.id === id))
          .filter((c): c is Clip => !!c && kindOf(c.trackId) === 'video')
          .map((c) => [c.startSec, c.startSec + clipEffectiveDuration(c)] as const)
        if (videoRanges.length > 0) {
          for (const c of s.timeline.clips) {
            const k = kindOf(c.trackId)
            if (k !== 'audio' && k !== 'text') continue
            const cs = c.startSec
            const ce = c.startSec + clipEffectiveDuration(c)
            if (videoRanges.some(([vs, ve]) => cs < ve && ce > vs)) toRemove.add(c.id)
          }
        }
      }

      let clips = s.timeline.clips.filter((c) => !toRemove.has(c.id))
      const tracks = pruneEmptyTracks(s.timeline.tracks, clips)
      // Magnetic main track: close the gap the deletion just opened (and carry
      // the surviving clips' captions/audio along with them).
      if (magneticMainTrack) {
        const mainId = mainVideoTrackId(tracks)
        if (mainId) clips = rippleMainTrack(clips, tracks, mainId, linkEnabled)
      }
      return {
        ...pushPast(s),
        selectedClipIds: s.selectedClipIds.filter((i) => !toRemove.has(i)),
        selectedTrackIds: s.selectedTrackIds.filter((trackId) =>
          tracks.some((track) => track.id === trackId),
        ),
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    }),

  moveClip: (id, newStartSec) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === id ? { ...c, startSec: Math.max(0, newStartSec) } : c,
      )
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  // Record one undo checkpoint at the start of an interaction (e.g. trim drag).
  beginHistoryStep: () => set((s) => ({ ...pushPast(s) })),

  // Absolute setters — the caller computes the target from the values captured
  // at drag start, so repeated mousemove updates never compound.
  trimClipLeft: (id, newStartSec, newInPointSec) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === id
          ? { ...c, startSec: Math.max(0, newStartSec), inPointSec: Math.max(0, newInPointSec) }
          : c,
      )
      return { timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) } }
    }),

  trimClipLeftText: (id, newStartSec, newOutPointSec) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === id
          ? { ...c, startSec: Math.max(0, newStartSec), outPointSec: newOutPointSec }
          : c,
      )
      return { timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) } }
    }),

  trimClipRight: (id, newOutPointSec) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === id ? { ...c, outPointSec: newOutPointSec } : c,
      )
      return { timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) } }
    }),

  collapseMainVideoTrack: () =>
    set((s) => {
      const mainId = mainVideoTrackId(s.timeline.tracks)
      if (!mainId) return s
      const clips = rippleMainTrack(
        s.timeline.clips,
        s.timeline.tracks,
        mainId,
        useUIStore.getState().linkEnabled,
      )
      if (clips === s.timeline.clips) return s // nothing to close
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  trimClipsLeftTo: (ids, atTimelineSec) =>
    set((s) => {
      if (ids.length === 0) return s
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (!ids.includes(c.id)) return c
        const speed = Math.max(c.speed, 0.01)
        const endSec = c.startSec + clipEffectiveDuration(c)
        if (atTimelineSec <= c.startSec || atTimelineSec >= endSec) return c
        const newIn = c.inPointSec + (atTimelineSec - c.startSec) * speed
        if (c.outPointSec - newIn < MIN_DUR * speed) return c
        changed = true
        return { ...c, startSec: atTimelineSec, inPointSec: Math.max(0, newIn) }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  trimClipsRightTo: (ids, atTimelineSec) =>
    set((s) => {
      if (ids.length === 0) return s
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (!ids.includes(c.id)) return c
        const speed = Math.max(c.speed, 0.01)
        const endSec = c.startSec + clipEffectiveDuration(c)
        if (atTimelineSec <= c.startSec || atTimelineSec >= endSec) return c
        const newOut = c.inPointSec + (atTimelineSec - c.startSec) * speed
        if (newOut - c.inPointSec < MIN_DUR * speed) return c
        changed = true
        return { ...c, outPointSec: newOut }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  splitClip: (clipId, atTimelineSec) =>
    set((s) => {
      const clip = s.timeline.clips.find((c) => c.id === clipId)
      if (!clip) return s
      const sourceAtSplit = clip.inPointSec + (atTimelineSec - clip.startSec) * clip.speed
      if (sourceAtSplit <= clip.inPointSec + MIN_DUR || sourceAtSplit >= clip.outPointSec - MIN_DUR)
        return s
      const left: Clip = { ...clip, outPointSec: sourceAtSplit }
      const right: Clip = {
        ...clip,
        id: createId('clip'),
        startSec: atTimelineSec,
        inPointSec: sourceAtSplit,
      }
      const clips = s.timeline.clips.map((c) => (c.id === clipId ? left : c)).concat(right)
      return {
        ...pushPast(s),
        selectedClipIds: [right.id],
        selectedTrackIds: [],
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  splitClipAtSourceTimes: (clipId, sourceTimes) => {
    let splitCount = 0
    set((s) => {
      const clip = s.timeline.clips.find((c) => c.id === clipId)
      if (!clip) return s
      const speed = Math.max(clip.speed, 0.01)
      const minSourceDur = MIN_DUR * speed
      const points = Array.from(new Set(sourceTimes.map((t) => Number(t))))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b)
        .filter((t) => t > clip.inPointSec + minSourceDur && t < clip.outPointSec - minSourceDur)

      const boundaries = [clip.inPointSec]
      for (const point of points) {
        if (point - boundaries[boundaries.length - 1]! >= minSourceDur) boundaries.push(point)
      }
      if (clip.outPointSec - boundaries[boundaries.length - 1]! < minSourceDur) boundaries.pop()
      boundaries.push(clip.outPointSec)
      if (boundaries.length < 3) return s

      const segments: Clip[] = []
      for (let i = 0; i < boundaries.length - 1; i++) {
        const inPointSec = boundaries[i]!
        const outPointSec = boundaries[i + 1]!
        if (outPointSec - inPointSec < minSourceDur) continue
        segments.push({
          ...clip,
          id: i === 0 ? clip.id : createId('clip'),
          startSec: clip.startSec + (inPointSec - clip.inPointSec) / speed,
          inPointSec,
          outPointSec,
        })
      }
      if (segments.length < 2) return s
      splitCount = segments.length - 1
      const clips = s.timeline.clips.flatMap((c) => (c.id === clipId ? segments : [c]))
      return {
        ...pushPast(s),
        selectedClipIds: segments.map((segment) => segment.id),
        selectedTrackIds: [],
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    })
    return splitCount
  },

  // Live setter (slider / preset): callers wrap the interaction in a single
  // beginHistoryStep() so a slider drag is one undo step, not dozens.
  setClipSpeed: (id, speed) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) =>
        c.id === id ? { ...c, speed: Math.max(0.1, Math.min(4, speed)) } : c,
      )
      return {
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  // Live setter — see setClipSpeed.
  setClipOpacity: (id, opacity) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id ? { ...c, opacity: Math.max(0, Math.min(1, opacity)) } : c,
        ),
      },
    })),

  // Live setter — see setClipSpeed.
  setClipVolume: (id, volume) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id ? { ...c, volume: Math.max(0, Math.min(1, volume)) } : c,
        ),
      },
    })),

  setClipsMuted: (ids, muted) =>
    set((s) => {
      if (ids.length === 0) return s
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (!ids.includes(c.id) || (c.muted ?? false) === muted) return c
        changed = true
        return { ...c, muted }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips },
      }
    }),

  setClipDenoise: (id, value) =>
    set((s) => ({
      ...pushPast(s),
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id ? { ...c, denoise: value } : c,
        ),
      },
    })),

  applyClipEffect: (ids, type) =>
    set((s) => {
      if (ids.length === 0) return s
      const selectedIds = new Set(ids)
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (!selectedIds.has(c.id)) return c
        const track = s.timeline.tracks.find((t) => t.id === c.trackId)
        if (track?.kind !== 'video' && track?.kind !== 'text') return c
        changed = true
        return {
          ...c,
          effects: (c.effects ?? [])
            .filter((effect) => effect.type !== type)
            .concat(makeClipEffect(type)),
        }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips },
      }
    }),

  // Live setter (effect-param slider) — caller wraps in beginHistoryStep.
  updateClipEffect: (clipId, effectId, params) =>
    set((s) => {
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId) return c
        const effects = (c.effects ?? []).map((effect) => {
          if (effect.id !== effectId) return effect
          changed = true
          return { ...effect, params: { ...effect.params, ...params } }
        })
        return changed ? { ...c, effects } : c
      })
      if (!changed) return s
      return {
        timeline: { ...s.timeline, clips },
      }
    }),

  removeClipEffect: (clipId, effectId) =>
    set((s) => {
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId || !(c.effects ?? []).some((effect) => effect.id === effectId)) return c
        changed = true
        return { ...c, effects: (c.effects ?? []).filter((effect) => effect.id !== effectId) }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips },
      }
    }),

  removeClipEffects: (ids, type) =>
    set((s) => {
      if (ids.length === 0) return s
      const selectedIds = new Set(ids)
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (!selectedIds.has(c.id) || !(c.effects ?? []).some((effect) => effect.type === type)) {
          return c
        }
        changed = true
        return { ...c, effects: (c.effects ?? []).filter((effect) => effect.type !== type) }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips },
      }
    }),

  setClipText: (id, text) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id && c.textData ? { ...c, textData: { ...c.textData, ...text } } : c,
        ),
      },
    })),

  setClipsText: (ids, text) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          ids.includes(c.id) && c.textData ? { ...c, textData: { ...c.textData, ...text } } : c,
        ),
      },
    })),

  applyTextStyle: (ids, style) =>
    set((s) => ({
      ...pushPast(s),
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          ids.includes(c.id) && c.textData ? { ...c, textData: { ...c.textData, ...style } } : c,
        ),
      },
    })),

  setClipFxData: (id, fxData) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id && c.fxData ? { ...c, fxData: { ...c.fxData, ...fxData } } : c,
        ),
      },
    })),

  setClipTransform: (id, transform) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id
            ? { ...c, transform: { ...makeDefaultTransform(), ...c.transform, ...transform } }
            : c,
        ),
      },
    })),

  resetClipTransforms: (ids) =>
    set((s) => {
      if (ids.length === 0) return s
      let changed = false
      const nextTransform = makeDefaultTransform()
      const clips = s.timeline.clips.map((c) => {
        if (!ids.includes(c.id)) return c
        changed = true
        return { ...c, transform: nextTransform }
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips },
      }
    }),

  rotateClips: (ids, deg) =>
    set((s) => {
      if (ids.length === 0) return s
      const clips = s.timeline.clips.map((c) => {
        if (!ids.includes(c.id)) return c
        const t = { ...makeDefaultTransform(), ...c.transform }
        const rotation = (((t.rotation + deg) % 360) + 360) % 360
        return { ...c, transform: { ...t, rotation } }
      })
      return { ...pushPast(s), timeline: { ...s.timeline, clips } }
    }),

  flipClips: (ids, axis) =>
    set((s) => {
      if (ids.length === 0) return s
      const clips = s.timeline.clips.map((c) => {
        if (!ids.includes(c.id)) return c
        const t = { ...makeDefaultTransform(), ...c.transform }
        return {
          ...c,
          transform: axis === 'h' ? { ...t, flipH: !t.flipH } : { ...t, flipV: !t.flipV },
        }
      })
      return { ...pushPast(s), timeline: { ...s.timeline, clips } }
    }),

  // Live setter (crop sliders) — caller wraps the interaction in beginHistoryStep.
  setClipCrop: (id, crop) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id
            ? { ...c, transform: { ...makeDefaultTransform(), ...c.transform, crop } }
            : c,
        ),
      },
    })),

  // Live setter (adjust slider / reset button) — caller wraps in beginHistoryStep.
  setClipAdjust: (id, adjust) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) =>
          c.id === id ? { ...c, adjust: { ...c.adjust, ...adjust } } : c,
        ),
      },
    })),

  selectClips: (ids) => set({ selectedClipIds: ids, selectedTrackIds: [] }),

  toggleSelectClip: (id) =>
    set((s) => ({
      selectedClipIds: s.selectedClipIds.includes(id)
        ? s.selectedClipIds.filter((i) => i !== id)
        : [...s.selectedClipIds, id],
      selectedTrackIds: [],
    })),

  selectTracks: (ids, includeClips = true) =>
    set((s) => {
      const validIds = uniqueIds(ids).filter((id) =>
        s.timeline.tracks.some((track) => track.id === id),
      )
      return {
        selectedTrackIds: validIds,
        selectedClipIds: includeClips ? clipIdsOnTracks(s.timeline.clips, validIds) : [],
      }
    }),

  toggleSelectTrack: (id) =>
    set((s) => {
      if (!s.timeline.tracks.some((track) => track.id === id)) return s
      const selectedTrackIds = s.selectedTrackIds.includes(id)
        ? s.selectedTrackIds.filter((trackId) => trackId !== id)
        : [...s.selectedTrackIds, id]
      return {
        selectedTrackIds,
        selectedClipIds: clipIdsOnTracks(s.timeline.clips, selectedTrackIds),
      }
    }),

  beginClipDrag: (ids) =>
    set({
      draggingIds: ids,
      dragDeltaSec: 0,
      dragDeltaYPx: 0,
      dragRipplePreview: null,
      dragTargetTrackId: null,
      dragCreateKind: null,
    }),

  setClipDragDelta: (deltaSec, deltaYPx = 0) =>
    set((s) => {
      // Live magnetic ripple: reflow the non-dragged main-track clips (and their
      // captions) so they slide in real time as the dragged clip passes them.
      let dragRipplePreview = s.dragRipplePreview
      if (useUIStore.getState().magneticMainTrack) {
        const mainId = mainVideoTrackId(s.timeline.tracks)
        dragRipplePreview = mainId
          ? computeRipplePreview(
              s.timeline.clips,
              s.timeline.tracks,
              mainId,
              s.draggingIds,
              deltaSec,
              useUIStore.getState().linkEnabled,
            )
          : null
      }
      return { dragDeltaSec: deltaSec, dragDeltaYPx: deltaYPx, dragRipplePreview }
    }),

  setClipDragTargetTrack: (trackId) =>
    set((s) => (s.dragTargetTrackId === trackId ? s : { dragTargetTrackId: trackId })),

  setClipDragCreateKind: (kind) =>
    set((s) => (s.dragCreateKind === kind ? s : { dragCreateKind: kind })),

  commitClipDrag: () =>
    set((s) => {
      const reset = {
        draggingIds: [],
        dragDeltaSec: 0,
        dragDeltaYPx: 0,
        dragRipplePreview: null,
        dragTargetTrackId: null,
        dragCreateKind: null,
      }
      if (s.draggingIds.length === 0) return reset
      const ids = s.draggingIds
      const delta = s.dragDeltaSec

      let tracks = s.timeline.tracks
      let clips = s.timeline.clips.map((c) => ({ ...c }))

      // Drag past a group edge → spawn a new track of that kind up front.
      let spawnedTrackId: string | null = null
      if (s.dragCreateKind) {
        const newTrack = makeTrack(s.dragCreateKind, tracks)
        tracks = insertTrackIntoStack(tracks, newTrack)
        spawnedTrackId = newTrack.id
      }

      const targetTrack = s.dragTargetTrackId
        ? tracks.find((t) => t.id === s.dragTargetTrackId)
        : undefined

      const { magneticMainTrack, linkEnabled } = useUIStore.getState()
      // Resolve the drag target against the pre-drag stack, then re-resolve the
      // main track after pruning below so it always follows the current bottom
      // video row.
      const dragMainId = magneticMainTrack ? mainVideoTrackId(s.timeline.tracks) : null

      let changed = !!spawnedTrackId

      // Place each dragged clip, bumping to a free/new track so nothing overlaps.
      for (const id of ids) {
        const idx = clips.findIndex((c) => c.id === id)
        if (idx < 0) continue
        const c = clips[idx]!
        const srcTrack = s.timeline.tracks.find((t) => t.id === c.trackId)
        const kind = srcTrack?.kind ?? 'video'
        const startSec = Math.max(0, c.startSec + delta)
        const dur = clipEffectiveDuration(c)

        let preferred: string | undefined = c.trackId
        if (spawnedTrackId && kind === s.dragCreateKind) preferred = spawnedTrackId
        else if (targetTrack && targetTrack.kind === kind && !targetTrack.locked)
          preferred = targetTrack.id

        // Magnetic insert: a video clip landing on the main track drops straight
        // onto it (overlaps allowed) and the ripple below reorders + pushes the
        // following clips to make room — instead of bumping onto a new track.
        if (dragMainId && kind === 'video' && preferred === dragMainId) {
          if (startSec !== c.startSec || c.trackId !== dragMainId) changed = true
          clips[idx] = { ...c, startSec, trackId: dragMainId }
          continue
        }

        // Exclude ALL dragged clips from the overlap test, not just this one.
        // They move by the same delta so they keep their relative spacing and
        // never collide with each other — but checking only [id] made adjacent
        // clips (e.g. back-to-back captions) think they overlapped a sibling's
        // *old* slot and scattered onto new tracks.
        const placement = placeOnFreeTrack(tracks, clips, kind, startSec, dur, ids, preferred)
        tracks = placement.tracks
        if (startSec !== c.startSec || placement.trackId !== c.trackId) changed = true
        clips[idx] = { ...c, startSec, trackId: placement.trackId }
      }

      if (!changed) return reset
      // Moving clips off a track may leave it empty → clean up.
      tracks = pruneEmptyTracks(tracks, clips)
      // Magnetic main track: insert/close gaps + carry every shifted clip's
      // linked captions/audio (not just the dragged one).
      const mainId = magneticMainTrack ? mainVideoTrackId(tracks) : null
      if (mainId) clips = rippleMainTrack(clips, tracks, mainId, linkEnabled)
      return {
        ...pushPast(s),
        ...reset,
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    }),

  cancelClipDrag: () =>
    set({
      draggingIds: [],
      dragDeltaSec: 0,
      dragDeltaYPx: 0,
      dragRipplePreview: null,
      dragTargetTrackId: null,
      dragCreateKind: null,
    }),

  addTrack: (kind) => {
    let id = ''
    set((s) => {
      const track = makeTrack(kind, s.timeline.tracks)
      id = track.id
      return {
        timeline: {
          ...s.timeline,
          tracks: insertTrackIntoStack(s.timeline.tracks, track),
        },
      }
    })
    return id
  },

  // Split a video clip's audio into its own clip on an audio track and mute
  // the source clip's audio (CapCut "Detach audio").
  detachAudio: (clipId) =>
    set((s) => {
      const clip = s.timeline.clips.find((c) => c.id === clipId)
      if (!clip || !clip.assetId || clip.muted) return s
      const srcTrack = s.timeline.tracks.find((t) => t.id === clip.trackId)
      if (!srcTrack || srcTrack.kind !== 'video') return s

      const dur = clipEffectiveDuration(clip)
      const placement = placeOnFreeTrack(
        s.timeline.tracks,
        s.timeline.clips,
        'audio',
        clip.startSec,
        dur,
        [],
      )
      const audioClip = makeClip({
        id: createId('clip'),
        assetId: clip.assetId,
        trackId: placement.trackId,
        startSec: clip.startSec,
        inPointSec: clip.inPointSec,
        outPointSec: clip.outPointSec,
        speed: clip.speed,
        volume: clip.volume,
      })
      const clips = s.timeline.clips
        .map((c) => (c.id === clipId ? { ...c, muted: true } : c))
        .concat(audioClip)
      return {
        ...pushPast(s),
        selectedClipIds: [audioClip.id],
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: placement.tracks,
          clips,
          durationSec: recalcDuration(clips),
        },
      }
    }),

  // Place demucs-separated stems (vocals / music) as new audio clips aligned to
  // the source clip, then mute the source clip's audio. The stem assets share
  // the source's duration, so its in/out/speed map 1:1.
  addSeparatedStems: (sourceClipId, stems) =>
    set((s) => {
      const src = s.timeline.clips.find((c) => c.id === sourceClipId)
      if (!src) return s

      let tracks = s.timeline.tracks
      let clips = [...s.timeline.clips]
      const newIds: string[] = []

      const addStem = (assetId: string | undefined) => {
        if (!assetId) return
        const dur = clipEffectiveDuration(src)
        const placement = placeOnFreeTrack(tracks, clips, 'audio', src.startSec, dur, [])
        tracks = placement.tracks
        const stemClip = makeClip({
          id: createId('clip'),
          assetId,
          trackId: placement.trackId,
          startSec: src.startSec,
          inPointSec: src.inPointSec,
          outPointSec: src.outPointSec,
          speed: src.speed,
          volume: src.volume,
        })
        clips.push(stemClip)
        newIds.push(stemClip.id)
      }

      addStem(stems.vocalsAssetId)
      addStem(stems.musicAssetId)
      if (newIds.length === 0) return s

      // Mute the original clip's audio (it's now represented by the stems).
      clips = clips.map((c) => (c.id === sourceClipId ? { ...c, muted: true } : c))

      return {
        ...pushPast(s),
        selectedClipIds: newIds,
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    }),

  setTracksLocked: (trackIds, locked) =>
    set((s) => {
      if (trackIds.length === 0) return s
      let changed = false
      const tracks = s.timeline.tracks.map((t) => {
        if (!trackIds.includes(t.id) || t.locked === locked) return t
        changed = true
        return { ...t, locked }
      })
      if (!changed) return s
      return { timeline: { ...s.timeline, tracks } }
    }),

  toggleTrackMuted: (trackId) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        tracks: s.timeline.tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t)),
      },
    })),

  toggleTrackLocked: (trackId) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        tracks: s.timeline.tracks.map((t) => (t.id === trackId ? { ...t, locked: !t.locked } : t)),
      },
    })),

  copyClips: (ids) =>
    set((s) => ({
      clipboard: s.timeline.clips.filter((c) => ids.includes(c.id)).map((c) => structuredClone(c)),
    })),

  cutClips: (ids) =>
    set((s) => {
      const toCopy = s.timeline.clips.filter((c) => ids.includes(c.id))
      if (toCopy.length === 0) return s
      const clips = s.timeline.clips.filter((c) => !ids.includes(c.id))
      const tracks = pruneEmptyTracks(s.timeline.tracks, clips)
      return {
        ...pushPast(s),
        clipboard: toCopy.map((c) => structuredClone(c)),
        selectedClipIds: [],
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    }),

  pasteClips: (atSec) =>
    set((s) => {
      if (s.clipboard.length === 0) return s
      const minStart = Math.min(...s.clipboard.map((c) => c.startSec))
      const seeds = s.clipboard.map((c) => ({
        ...structuredClone(c),
        id: createId('clip'),
        startSec: Math.max(0, atSec + (c.startSec - minStart)),
      }))
      const placed = addClipsWithoutOverlap(s.timeline.tracks, s.timeline.clips, seeds)
      return {
        ...pushPast(s),
        selectedClipIds: placed.added.map((c) => c.id),
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: placed.tracks,
          clips: placed.clips,
          durationSec: recalcDuration(placed.clips),
        },
      }
    }),

  duplicateClips: (ids) =>
    set((s) => {
      const originals = s.timeline.clips.filter((c) => ids.includes(c.id))
      if (originals.length === 0) return s
      const seeds = originals.map((c) => ({
        ...structuredClone(c),
        id: createId('clip'),
        startSec: c.startSec + clipEffectiveDuration(c),
      }))
      const placed = addClipsWithoutOverlap(s.timeline.tracks, s.timeline.clips, seeds)
      return {
        ...pushPast(s),
        selectedClipIds: placed.added.map((c) => c.id),
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: placed.tracks,
          clips: placed.clips,
          durationSec: recalcDuration(placed.clips),
        },
      }
    }),

  setZoom: (z) => set({ zoom: Math.max(1, Math.min(400, z)) }),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1]
      if (!prev) return s
      return {
        past: s.past.slice(0, -1),
        future: [snap(s), ...s.future].slice(0, MAX_HISTORY),
        canUndo: s.past.length > 1,
        canRedo: true,
        timeline: {
          ...s.timeline,
          clips: prev.clips,
          tracks: prev.tracks,
          durationSec: prev.durationSec,
        },
        selectedClipIds: [],
        selectedTrackIds: [],
      }
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0]
      if (!next) return s
      return {
        past: [...s.past, snap(s)].slice(-MAX_HISTORY),
        future: s.future.slice(1),
        canUndo: true,
        canRedo: s.future.length > 1,
        timeline: {
          ...s.timeline,
          clips: next.clips,
          tracks: next.tracks,
          durationSec: next.durationSec,
        },
        selectedClipIds: [],
        selectedTrackIds: [],
      }
    }),

  replaceTimeline: (clips, tracks, fps, durationSec) =>
    set({
      timeline: { clips, tracks: sortTracksForStack(tracks), fps, durationSec },
      selectedClipIds: [],
      selectedTrackIds: [],
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
    }),
}))
