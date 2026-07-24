import { create } from 'zustand'

import { clampVolumeLinear } from '@engine/audio/volume'
import { createId } from '@engine/core/id'
import { flattenCompounds } from '@engine/timeline'
import {
  clipEffectiveDuration,
  makeClipEffect,
  makeDefaultTextData,
  makeDefaultTimeline,
  makeSubtitleTextData,
  makeDefaultAdjust,
  makeDefaultTransform,
  makeFilterFxData,
  currentKeyframeValue,
  type Clip,
  type FilterKind,
  type ClipCanvasFill,
  type ClipEffectType,
  type ColorAdjust,
  type ClipTransform,
  type Keyframe,
  type KeyframeProp,
  type DenoiseLevel,
  type BlurStickerData,
  type FilterFxData,
  type FxData,
  type TextClipData,
  type Track,
  type TrackKind,
  type TimelineState,
} from '@engine/timeline'
import { normalizeCaptionWordTimestamps } from '@engine/timeline/caption-timing'
import { closeSequentialTrackOverlaps } from '@engine/timeline/close-overlaps'
import {
  computeRipplePreview,
  prepareRipplePreview,
  type RipplePreviewContext,
} from '@engine/timeline/ripple-preview'

import { patchClipById, patchClipsById } from './clip-patch'
import { trimHistoryHead, trimHistoryTail } from './history-budget'

import { usePlaybackStore } from './playback-store'
import { useToastStore } from './toast-store'
import { useUIStore } from './ui-store'

export const MAX_COMPOUND_DEPTH = 6

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
  const clip: Clip = {
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
  // Callers commonly spread optional seeds (`volume: seed.volume`) where the
  // value is undefined — the spread above then OVERRIDES the default with
  // undefined. A non-finite volume/speed later throws inside WebAudio
  // (`AudioParam.value = NaN`), which killed scheduling for the WHOLE
  // timeline, not just the bad clip. Coerce back to safe defaults here.
  if (!Number.isFinite(clip.volume)) clip.volume = 1
  if (!Number.isFinite(clip.speed) || clip.speed <= 0) clip.speed = 1
  if (!Number.isFinite(clip.opacity)) clip.opacity = 1
  return clip
}

function recalcDuration(clips: Clip[]): number {
  return clips.reduce((acc, c) => Math.max(acc, c.startSec + clipEffectiveDuration(c)), 0)
}

/** The portion of clip `c` overlapping the timeline window [a, b], with keyframes
 *  re-based to the kept span. startSec is NOT shifted. Returns the same clip when
 *  it's wholly inside, or null when there's no overlap. Used to window a compound's
 *  sub-timeline into the detail editor and to rebuild the full timeline on exit. */
function clipPortion(c: Clip, a: number, b: number): Clip | null {
  const speed = Math.max(c.speed, 0.01)
  const cs = c.startSec
  const ce = cs + clipEffectiveDuration(c)
  const vs = Math.max(cs, a)
  const ve = Math.min(ce, b)
  if (ve - vs <= 1e-4) return null
  if (vs <= cs + 1e-4 && ve >= ce - 1e-4) return c
  const leftTrim = vs - cs
  const keptDur = ve - vs
  let keyframes = c.keyframes
  if (keyframes) {
    const next: Record<string, { t: number; v: number; ease?: unknown }[]> = {}
    for (const [prop, arr] of Object.entries(keyframes)) {
      if (!arr) continue
      const shifted = (arr as { t: number; v: number; ease?: unknown }[])
        .map((k) => ({ ...k, t: k.t - leftTrim }))
        .filter((k) => k.t >= -1e-4 && k.t <= keptDur + 1e-4)
        .map((k) => ({ ...k, t: Math.max(0, Math.min(keptDur, k.t)) }))
      if (shifted.length) next[prop] = shifted
    }
    keyframes = next as typeof c.keyframes
  }
  return {
    ...c,
    startSec: vs,
    inPointSec: c.inPointSec + leftTrim * speed,
    outPointSec: c.inPointSec + (ve - cs) * speed,
    keyframes,
  }
}

/** Clamp every compound clip's window to its sub-timeline's actual length, so a
 *  window that runs past the content (from an old over-trim, or sub-timeline edits
 *  that shortened it) doesn't leave a BLACK tail in the preview. Returns the same
 *  array when nothing needed clamping. */
function clampCompoundClips(
  clips: Clip[],
  compounds: Record<string, { name: string; timeline: TimelineState }>,
): Clip[] {
  let changed = false
  const out = clips.map((c) => {
    if (!c.compoundId) return c
    const subDur = compounds[c.compoundId]?.timeline.durationSec
    if (subDur == null) return c
    const outP = Math.min(c.outPointSec, subDur)
    const inP = Math.min(c.inPointSec, Math.max(0, outP - 0.01))
    if (Math.abs(outP - c.outPointSec) < 1e-6 && Math.abs(inP - c.inPointSec) < 1e-6) return c
    changed = true
    return { ...c, inPointSec: inP, outPointSec: outP }
  })
  return changed ? out : clips
}

/** Deep-clone a compound under a fresh id so a split (or duplicated) compound clip
 *  becomes an INDEPENDENT compound — editing or windowing one no longer affects the
 *  other (fixes split halves showing identical content / clobbering each other). */
function cloneCompound(
  compounds: Record<string, { name: string; timeline: TimelineState }>,
  srcId: string,
): { id: string; compounds: Record<string, { name: string; timeline: TimelineState }> } {
  const src = compounds[srcId]
  if (!src) return { id: srcId, compounds }
  const id = createId('compound')
  return {
    id,
    compounds: { ...compounds, [id]: { name: src.name, timeline: structuredClone(src.timeline) } },
  }
}

/** True if [startSec, startSec+dur) is free on the track (ignoring excludeIds). */
function trackHasSpace(
  clips: Clip[],
  trackId: string,
  startSec: number,
  dur: number,
  excludeIds: ReadonlySet<string>,
): boolean {
  const end = startSec + dur
  return !clips.some(
    (c) =>
      c.trackId === trackId &&
      !excludeIds.has(c.id) &&
      startSec < c.startSec + clipEffectiveDuration(c) &&
      c.startSec < end,
  )
}

const EMPTY_CLIP_IDS: ReadonlySet<string> = new Set()

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
 * Crucially, every main-track clip that shifts carries its linked captions
 * with it (when `linkEnabled`): each caption clip rides the main clip it
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

  // Each caption clip rides the main clip it overlaps most (pre-ripple).
  const linkShift = new Map<string, number>()
  if (linkEnabled) {
    const kindOf = (id: string) => tracks.find((t) => t.id === id)?.kind
    for (const c of clips) {
      const k = kindOf(c.trackId)
      if (k !== 'text') continue
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
 * Keep caption clips glued to the same SOURCE moments when a media clip's
 * playback speed (and optionally its start) changes.
 *
 * A caption marks a spoken phrase at a fixed point in the SOURCE media; when
 * the clip is sped up/slowed down, that phrase now plays at a different
 * timeline position and for a different duration. Without this, captions kept
 * their old timeline placement and drifted out of sync the moment the user
 * touched the speed slider. For every caption whose center rides `target`
 * (same rule family as rippleMainTrack's overlap linkage, `linkEnabled` only):
 *   newStart = newClipStart + (capStart - oldClipStart) × oldSpeed/newSpeed
 *   duration and word timestamps scale by the same oldSpeed/newSpeed factor.
 */
function rescaleLinkedCaptions(
  clips: Clip[],
  tracks: Track[],
  target: Clip,
  newClipStartSec: number,
  newSpeed: number,
): Clip[] {
  if (!useUIStore.getState().linkEnabled) return clips
  const oldSpeed = Math.max(target.speed, 0.01)
  const factor = oldSpeed / Math.max(newSpeed, 0.01)
  const oldStart = target.startSec
  const oldDur = clipEffectiveDuration(target)
  if (Math.abs(factor - 1) < 1e-9 && Math.abs(newClipStartSec - oldStart) < 1e-9) {
    return clips
  }
  const textTrackIds = new Set(
    tracks.filter((t) => t.kind === 'text').map((t) => t.id),
  )
  return clips.map((c) => {
    if (c.id === target.id) return c
    if (!textTrackIds.has(c.trackId) || !c.textData) return c
    const dur = clipEffectiveDuration(c)
    const center = c.startSec + dur / 2
    if (center < oldStart - 1e-4 || center > oldStart + oldDur + 1e-4) return c
    const capSpeed = Math.max(c.speed, 0.01)
    const newDur = Math.max(0.05, dur * factor)
    const words = c.textData.wordTimestamps?.map((w) => ({
      ...w,
      startSec: w.startSec * factor,
      endSec: w.endSec * factor,
    }))
    return {
      ...c,
      startSec: Math.max(0, newClipStartSec + (c.startSec - oldStart) * factor),
      outPointSec: c.inPointSec + newDur * capSpeed,
      textData: words ? { ...c.textData, wordTimestamps: words } : c.textData,
    }
  })
}

/**
 * After a speed change altered a main-track clip's on-track duration, re-pack
 * the magnetic main track (carrying linked captions, same as drag/delete)
 * so the change never leaves a gap or an overlap behind. No-op when magnetic
 * is off or the clip is not on the main track.
 */
function rippleAfterSpeedChange(clips: Clip[], tracks: Track[], target: Clip): Clip[] {
  const { magneticMainTrack, linkEnabled } = useUIStore.getState()
  if (!magneticMainTrack) return clips
  const mainId = mainVideoTrackId(tracks)
  if (!mainId || target.trackId !== mainId) return clips
  return rippleMainTrack(clips, tracks, mainId, linkEnabled)
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
  excludeIds: ReadonlySet<string>,
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
      EMPTY_CLIP_IDS,
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
  /**
   * The compound registry as of this snapshot. Required: `breakCompound` deletes
   * the entry while undo restores the compound CLIP, so without this the clip
   * returns with a `compoundId` pointing at a registry entry that no longer
   * exists — preview/export flatten nothing and the project saves corrupt.
   * Held by reference: every mutation replaces the registry object, so an old
   * ref stays valid (structural sharing, no deep copy).
   */
  compounds: Record<string, Compound>
}

/** One sub-timeline gathered into a single compound clip (CapCut "compound clip
 *  / subproject"). Lives in the store's `compounds` registry; the parent clip
 *  references it by id. */
export interface Compound {
  name: string
  timeline: TimelineState
}

/** Saved parent context while editing a compound, so exiting restores it. */
interface CompoundFrame {
  id: string
  name: string
  parentTimeline: TimelineState
  parentSelectedClipIds: string[]
  /** Sub-timeline length when we entered — lets exit tell a full-window clip
   *  (auto-track length edits) from a trimmed one (preserve its window). */
  subDurationAtEnter: number
  /** Set when we entered a TRIMMED single-reference compound: the editor shows
   *  only the window [in, in+oldLen] of `fullSub`; exit splices edits back in. */
  window?: { in: number; oldLen: number; fullSub: TimelineState; clipId: string }
  /** Playhead on the parent timeline, restored on exit (entering resets it to 0
   *  so the sub-timeline preview isn't black when the parent playhead sat past
   *  the compound's window). */
  parentCurrentSec: number
}

interface InsertClipParams {
  trackId: string
  assetId: string
  startSec: number
  durationSec: number
}

interface TimelineStoreState {
  timeline: TimelineState
  /** Compound sub-timelines, keyed by compoundId. The one currently being edited
   *  is held live in `timeline` (and flushed back here on exit). */
  compounds: Record<string, Compound>
  /** Breadcrumb of compounds currently open (deepest last). Empty = root timeline. */
  compoundStack: CompoundFrame[]
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
  /** Track the grabbed (anchor) clip started on. The vertical row offset
   *  target − anchor is applied to every dragged clip relative to its OWN
   *  source track, so a multi-track selection keeps its row spacing instead of
   *  collapsing onto one track. */
  dragAnchorTrackId: string | null
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
  /** Drop a full-frame look filter (CapCut-style) onto an fx track at `startSec`. */
  insertFilter: (filter: FilterKind, startSec: number, durationSec: number) => string
  insertSubtitles: (
    cues: { content: string; startSec: number; durationSec: number; words?: { word: string; startSec: number; endSec: number }[] }[],
    opts?: { newTrack?: boolean; trackName?: string },
  ) => string[]
  /** Drop one or more audio assets onto audio track(s) in a single history step,
   *  bumping overlaps to free/new audio tracks. Returns the new clip ids. */
  insertAudioClips: (
    seeds: {
      assetId: string
      startSec: number
      durationSec: number
      volume?: number
      /** Caption/scene clip whose timing owns this generated audio. */
      syncToClipId?: string
    }[],
    opts?: { trackName?: string },
  ) => string[]
  /** Place one already-separated background stem through the same source
   * windows/speeds as split video so music/SFX stays synchronized
   * while the original video's vocal-bearing audio is muted. */
  insertAudioSpanClips: (
    seeds: {
      assetId: string
      startSec: number
      inPointSec: number
      outPointSec: number
      speed: number
      volume?: number
    }[],
    opts?: { trackName?: string },
  ) => string[]
  /** Drop pre-positioned, pre-windowed VIDEO clips (each with an explicit source
   *  window + speed) onto a single video track in one history step. Used by the
   *  segmented edits to lay the source video as per-segment pieces, some slowed
   *  to fit replacement audio. Seeds must be non-overlapping and in
   *  order. Returns the new clip ids. */
  insertVideoClips: (
    seeds: {
      assetId: string
      startSec: number
      inPointSec: number
      outPointSec: number
      speed: number
      /** Per-span audio policy. Falls back to opts.muted when omitted. */
      muted?: boolean
    }[],
    opts?: { trackName?: string; muted?: boolean },
  ) => string[]
  /** Close ms-level overlaps between sequential clips on the given tracks by
   *  trimming the earlier clip's out-point (see closeSequentialTrackOverlaps).
   *  Silent normalization for programmatic pushes — no history entry. */
  normalizeTrackOverlaps: (trackIds: string[]) => void
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
  splitClips: (clipIds: string[], atTimelineSec: number) => void
  splitClipAtSourceTimes: (clipId: string, sourceTimes: number[]) => number
  splitClipEveryNSeconds: (clipId: string, intervalSec: number) => number
  setClipSpeed: (id: string, speed: number) => void
  setClipSpeedDuration: (id: string, startSec: number, durationSec: number) => void
  setClipOpacity: (id: string, opacity: number) => void
  setClipVolume: (id: string, volume: number) => void
  /** Live plural setters (no history; caller wraps the interaction in
   *  beginHistoryStep) — apply the SAME value to every selected clip so the
   *  inspector edits many clips at once. */
  setClipsOpacity: (ids: string[], opacity: number) => void
  setClipsVolume: (ids: string[], volume: number) => void
  setClipsAdjust: (ids: string[], adjust: Partial<ColorAdjust>) => void
  /** Keyframe-aware transform write (live; caller wraps in beginHistoryStep): for
   *  each prop, upsert a keyframe at the playhead if that prop is animated, else
   *  set the static field. Used by the preview drag so dragging an animated clip
   *  records a keyframe instead of clobbering the animation. */
  setClipTransformKeyed: (id: string, transform: Partial<ClipTransform>, atSec: number) => void
  setClipOpacityKeyed: (id: string, opacity: number, atSec: number) => void
  /** Toggle a keyframe at the playhead for each given prop as a group: if any is
   *  keyed there, remove from all; else add to all (capturing current values). */
  toggleKeyframes: (id: string, props: KeyframeProp[], atSec: number) => void
  /** Remove all keyframes for the given props (back to a static value). */
  clearClipKeyframes: (id: string, props: KeyframeProp[]) => void
  setClipsMuted: (ids: string[], muted: boolean) => void
  applyClipEffect: (ids: string[], type: ClipEffectType) => void
  updateClipEffect: (clipId: string, effectId: string, params: Record<string, number | string | boolean>) => void
  removeClipEffect: (clipId: string, effectId: string) => void
  removeClipEffects: (ids: string[], type: ClipEffectType) => void
  setClipDenoise: (id: string, value: DenoiseLevel | undefined) => void
  setClipText: (id: string, text: Partial<TextClipData>) => void
  /** Set the same text patch on many clips without a history step (for live drag). */
  setClipsText: (ids: string[], text: Partial<TextClipData>) => void
  /** Atomically apply distinct AI-proofread content to caption clips in one
   * undo step. Word timing is reconciled with the corrected token sequence. */
  applyCaptionCorrections: (corrections: Record<string, string>) => number
  applyTextStyle: (ids: string[], style: Partial<TextClipData>) => void
  setClipFxData: (id: string, fxData: Partial<BlurStickerData> | Partial<FilterFxData>) => void
  setClipsCanvasFill: (ids: string[], canvasFill: ClipCanvasFill | undefined) => void
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
  /** Group the given clips (CapCut-style) so they select / move / delete as one. */
  groupClips: (ids: string[]) => void
  /** Break the group(s) that the given clips belong to. */
  ungroupClips: (ids: string[]) => void
  selectTracks: (ids: string[], includeClips?: boolean) => void
  toggleSelectTrack: (id: string) => void
  copyClips: (ids: string[]) => void
  cutClips: (ids: string[]) => void
  pasteClips: (atSec: number) => void
  duplicateClips: (ids: string[]) => void
  /** Swap a clip's source media for another asset, keeping its timeline position
   *  and duration (CapCut "Replace"). `inPointSec` picks where in the new source
   *  to start; `keepEffects` keeps the clip's effects/transform/adjust. */
  replaceClipSource: (
    clipId: string,
    assetId: string,
    inPointSec: number,
    keepEffects: boolean,
  ) => void
  beginClipDrag: (ids: string[], anchorTrackId?: string) => void
  setClipDragDelta: (deltaSec: number, deltaYPx?: number) => void
  setClipDragTargetTrack: (trackId: string | null) => void
  setClipDragCreateKind: (kind: TrackKind | null) => void
  commitClipDrag: () => void
  cancelClipDrag: () => void
  addTrack: (kind: TrackKind) => string
  detachAudio: (clipId: string) => void
  detachAudios: (clipIds: string[]) => void
  restoreAudio: (clipId: string) => void
  restoreAudios: (clipIds: string[]) => void
  addSeparatedStems: (
    sourceClipId: string,
    stems: { vocalsAssetId?: string; musicAssetId?: string },
  ) => void
  setTracksLocked: (trackIds: string[], locked: boolean) => void
  toggleTrackMuted: (trackId: string) => void
  toggleTrackLocked: (trackId: string) => void
  /** Hide/show a track — hidden tracks are excluded from preview AND export. */
  toggleTrackHidden: (trackId: string) => void
  setZoom: (z: number) => void
  undo: () => void
  redo: () => void
  replaceTimeline: (clips: Clip[], tracks: Track[], fps: number, durationSec: number) => void
  /** Load the compound registry (on project open). */
  setCompounds: (compounds: Record<string, Compound>) => void
  /** Gather the given clips into a new compound clip on the current timeline. */
  createCompound: (ids: string[]) => void
  /** Replace compound clips with their rendered child clips on the current timeline. */
  breakCompound: (ids: string[]) => void
  /** Open a compound for editing (its sub-timeline becomes the live timeline). */
  enterCompound: (
    compoundId: string,
    window?: { inPointSec: number; outPointSec: number },
  ) => void
  /** Leave the current compound, writing edits back + restoring the parent. */
  exitCompound: () => void
  /** The ROOT timeline + the full compound registry with any in-progress compound
   *  edits flushed in — what persistence must save (never the live sub-timeline). */
  rootSnapshot: () => { timeline: TimelineState; compounds: Record<string, Compound> }
  /** The live timeline with every compound clip expanded into its contents — what
   *  the preview / audio / export consume so compounds render. Memoized on the
   *  timeline + registry refs (cheap no-op when there are no compounds). */
  flatTimeline: () => TimelineState
}

// ── History helpers ─────────────────────────────────────────

function snap(s: TimelineStoreState): HistorySnapshot {
  return {
    clips: s.timeline.clips,
    tracks: s.timeline.tracks,
    durationSec: s.timeline.durationSec,
    compounds: s.compounds,
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

/** Expand a set of clip ids to include every clip sharing a group with them, so
 *  a grouped clip always selects/moves/deletes with its whole group. */
function expandToGroups(clips: Clip[], ids: string[]): string[] {
  const idSet = new Set(ids)
  const groupIds = new Set<string>()
  for (const c of clips) if (c.groupId && idSet.has(c.id)) groupIds.add(c.groupId)
  if (groupIds.size === 0) return ids
  const out = new Set(ids)
  for (const c of clips) if (c.groupId && groupIds.has(c.groupId)) out.add(c.id)
  return [...out]
}

/** Resolve the ROOT timeline + the compound registry with in-progress edits
 *  flushed in. While editing a compound the live `timeline` is the sub-timeline,
 *  so persistence must NOT save it as the project timeline — it walks the stack
 *  back up to the root, recording each level's edits into the registry. */
function rootContext(s: TimelineStoreState): {
  timeline: TimelineState
  compounds: Record<string, Compound>
} {
  if (s.compoundStack.length === 0) return { timeline: s.timeline, compounds: s.compounds }
  const compounds = { ...s.compounds }
  let live = s.timeline
  for (let i = s.compoundStack.length - 1; i >= 0; i--) {
    const f = s.compoundStack[i]!
    compounds[f.id] = { name: f.name, timeline: live }
    live = f.parentTimeline
  }
  return { timeline: live, compounds }
}

const KF_EPS = 1e-3
const TRANSFORM_KF_PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation'] as const

/** Insert/replace a keyframe at time `t` in a sorted track. */
function upsertKeyframe(track: Keyframe[] | undefined, t: number, v: number): Keyframe[] {
  const out = (track ?? []).filter((k) => Math.abs(k.t - t) > KF_EPS)
  out.push({ t, v })
  out.sort((a, b) => a.t - b.t)
  return out
}

// Memo for flatTimeline(): recompute only when the timeline or compound registry
// reference changes (both are replaced immutably on every edit).
let _flatCache: {
  timeline: TimelineState | null
  compounds: Record<string, Compound> | null
  result: TimelineState
} = { timeline: null, compounds: null, result: makeDefaultTimeline() }
/** Toast at most once per session when compound data is corrupt (cycle/too deep). */
let _flattenErrorWarned = false
let dragRippleContext: RipplePreviewContext | null = null

function pushPast(
  s: TimelineStoreState,
): Pick<TimelineStoreState, 'past' | 'future' | 'canUndo' | 'canRedo'> {
  // A data-changing edit while the preview is playing → stop playback so the user
  // isn't editing against a moving playhead. Every forward edit funnels through
  // here (continuous drags via beginHistoryStep, discrete actions inline); undo/
  // redo and pure selection do NOT call pushPast, so they keep playing.
  if (usePlaybackStore.getState().isPlaying) usePlaybackStore.getState().pause()
  return {
    past: trimHistoryTail([...s.past, snap(s)]),
    future: [],
    canUndo: true,
    canRedo: false,
  }
}

// ── Store ────────────────────────────────────────────────────

const MIN_DUR = 0.1
// Hard cap on how many segments a single "split every N seconds" may produce,
// so a tiny N on a long clip can't explode the clip count (and with it the
// autosave snapshot + undo history). Over this → reject, don't cut.
const MAX_SPLIT_SEGMENTS = 2000

export const useTimelineStore = create<TimelineStoreState>((set, get) => ({
  timeline: makeDefaultTimeline(),
  compounds: {},
  compoundStack: [],
  selectedClipIds: [],
  selectedTrackIds: [],
  clipboard: [],
  zoom: 80,
  draggingIds: [],
  dragDeltaSec: 0,
  dragDeltaYPx: 0,
  dragRipplePreview: null,
  dragTargetTrackId: null,
  dragAnchorTrackId: null,
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
        EMPTY_CLIP_IDS,
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
        EMPTY_CLIP_IDS,
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
      const placement = placeOnFreeTrack(s.timeline.tracks, s.timeline.clips, 'fx', start, dur, EMPTY_CLIP_IDS)
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

  insertFilter: (filter, startSec, durationSec) => {
    const id = createId('clip')
    const start = Math.max(0, startSec)
    set((s) => {
      const dur = Math.max(MIN_DUR, durationSec)
      const placement = placeOnFreeTrack(s.timeline.tracks, s.timeline.clips, 'fx', start, dur, EMPTY_CLIP_IDS)
      const clip = makeClip({
        id,
        assetId: null,
        trackId: placement.trackId,
        startSec: start,
        outPointSec: dur,
        fxData: makeFilterFxData(filter),
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

  insertSubtitles: (cues, opts) => {
    if (cues.length === 0) return []
    const ids = cues.map(() => createId('clip'))
    let insertedIds: string[] = []
    set((s) => {
      // NOTE: deliberately no dedupeSubtitleCues() here. Callers that produce
      // cues which can genuinely contain ASR-repeat artifacts (auto-transcribe)
      // already dedupe upstream (backend word/phrase pass + mapCuesToTimeline/
      // mapSegmentedCuesToTimeline's dedupeMappedCues); re-running the same
      // fuzzy repeat-heuristic here was redundant for them AND actively wrong
      // for translateCaptions, whose cues are a verified 1:1 mapping of
      // already-placed caption clips — re-checking translated text for
      // "repeated phrases" could wrongly merge two distinct captions whose
      // translations happen to share a few common words. Callers that need
      // dedup on genuinely never-deduped input (e.g. an imported .srt file)
      // call dedupeSubtitleCues() themselves before insertSubtitles. Only basic
      // sanity filtering happens here.
      const cleanCues = cues
        .map((cue) => ({
          content: cue.content.trim(),
          startSec: cue.startSec,
          endSec: cue.startSec + cue.durationSec,
          words: cue.words,
        }))
        .filter((cue) => cue.content && cue.endSec > cue.startSec)
        .sort((a, b) => a.startSec - b.startSec)
      if (cleanCues.length === 0) return s

      // Captions are sequential by nature, but ASR cues can overlap slightly
      // (min-duration padding in mapCuesToTimeline, boundary jitter between
      // sentences). Left un-clamped, addClipsWithoutOverlap bumped the
      // overlapping ones onto a SECOND text track, scattering one generation
      // run across tracks. Trim the earlier cue's end to the next cue's start
      // instead; only genuinely co-starting duplicates still get bumped.
      for (let i = 0; i < cleanCues.length - 1; i++) {
        const cur = cleanCues[i]!
        const next = cleanCues[i + 1]!
        if (cur.endSec > next.startSec) {
          // Floor matches the seed's outPointSec floor (0.1) below, so a
          // clamped cue is never re-expanded back into an overlap.
          cur.endSec = Math.max(next.startSec, cur.startSec + 0.1)
        }
      }

      let tracks = s.timeline.tracks
      // newTrack: always put these on a fresh dedicated text track (e.g. a
      // translated caption set) so they never interleave with existing captions.
      let textTrack = opts?.newTrack ? undefined : tracks.find((t) => t.kind === 'text')
      if (!textTrack) {
        textTrack = makeTrack('text', tracks)
        if (opts?.trackName) textTrack = { ...textTrack, name: opts.trackName }
        tracks = sortTracksForStack([...tracks, textTrack])
      }
      const seeds = cleanCues.map((cue, index) =>
        makeClip({
          id: ids[index] ?? createId('clip'),
          trackId: textTrack!.id,
          startSec: Math.max(0, cue.startSec),
          outPointSec: Math.max(0.1, cue.endSec - cue.startSec),
          textData: makeSubtitleTextData(
            cue.content,
            cue.words?.length
              ? normalizeCaptionWordTimestamps(cue.content, cue.words, cue.endSec - cue.startSec).words
              : cue.words,
          ),
        }),
      )

      // On a brand-new track the cues (non-overlapping among themselves) drop
      // straight in — no overlap-bumping that could scatter or merge them with
      // the originals. Otherwise keep the existing free-placement behaviour.
      if (opts?.newTrack) {
        const clips = [...s.timeline.clips, ...seeds]
        insertedIds = seeds.map((c) => c.id)
        return {
          ...pushPast(s),
          selectedClipIds: seeds.map((c) => c.id),
          selectedTrackIds: [],
          timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
        }
      }

      const placed = addClipsWithoutOverlap(tracks, s.timeline.clips, seeds)
      insertedIds = placed.added.map((c) => c.id)
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
    })
    return insertedIds
  },

  insertAudioClips: (seeds, opts) => {
    if (seeds.length === 0) return []
    const ids = seeds.map(() => createId('clip'))
    set((s) => {
      let tracks = s.timeline.tracks
      // Ensure at least one audio track exists so kind inference + placement
      // land on audio (a project may have pruned its default audio track).
      let audioTrack = tracks.find((t) => t.kind === 'audio')
      if (!audioTrack) {
        audioTrack = makeTrack('audio', tracks)
        if (opts?.trackName) audioTrack = { ...audioTrack, name: opts.trackName }
        tracks = sortTracksForStack([...tracks, audioTrack])
      }
      const clipSeeds = seeds.map((seed, i) =>
        makeClip({
          id: ids[i]!,
          assetId: seed.assetId,
          trackId: audioTrack!.id,
          startSec: Math.max(0, Number.isFinite(seed.startSec) ? seed.startSec : 0),
          // A caller can pass durationSec: undefined/NaN (asset metadata not
          // probed yet) — Math.max(0.1, NaN) is NaN, which poisons every
          // downstream duration/schedule computation. Coerce to the minimum.
          outPointSec: Number.isFinite(seed.durationSec)
            ? Math.max(0.1, seed.durationSec)
            : 0.1,
          volume: seed.volume,
          syncToClipId: seed.syncToClipId,
        }),
      )
      const placed = addClipsWithoutOverlap(tracks, s.timeline.clips, clipSeeds)
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
    })
    return ids
  },

  insertAudioSpanClips: (seeds, opts) => {
    if (seeds.length === 0) return []
    const ids = seeds.map(() => createId('clip'))
    set((s) => {
      // Always use a dedicated track: these pieces are consecutive windows of
      // one stem and must not be scattered by generic overlap placement.
      let audioTrack = makeTrack('audio', s.timeline.tracks)
      if (opts?.trackName) audioTrack = { ...audioTrack, name: opts.trackName }
      const tracks = sortTracksForStack([...s.timeline.tracks, audioTrack])
      const clipSeeds = seeds.map((seed, i) =>
        makeClip({
          id: ids[i]!,
          assetId: seed.assetId,
          trackId: audioTrack.id,
          startSec: Math.max(0, Number.isFinite(seed.startSec) ? seed.startSec : 0),
          inPointSec: Math.max(0, Number.isFinite(seed.inPointSec) ? seed.inPointSec : 0),
          outPointSec: Math.max(
            (Number.isFinite(seed.inPointSec) ? seed.inPointSec : 0) + 0.01,
            Number.isFinite(seed.outPointSec) ? seed.outPointSec : 0.01,
          ),
          speed: Math.max(0.01, Number.isFinite(seed.speed) ? seed.speed : 1),
          volume: seed.volume,
        }),
      )
      const clips = [...s.timeline.clips, ...clipSeeds]
      return {
        ...pushPast(s),
        selectedClipIds: ids,
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    })
    return ids
  },

  insertVideoClips: (seeds, opts) => {
    if (seeds.length === 0) return []
    const ids = seeds.map(() => createId('clip'))
    set((s) => {
      let tracks = s.timeline.tracks
      let videoTrack = tracks.find((t) => t.kind === 'video')
      if (!videoTrack) {
        videoTrack = makeTrack('video', tracks)
        if (opts?.trackName) videoTrack = { ...videoTrack, name: opts.trackName }
        tracks = sortTracksForStack([...tracks, videoTrack])
      }
      // Seeds are contiguous + non-overlapping by construction (a per-span split
      // of one source), so they drop straight onto the one video track — no
      // free-track bumping that would scatter the pieces across tracks.
      const clipSeeds = seeds.map((seed, i) =>
        makeClip({
          id: ids[i]!,
          assetId: seed.assetId,
          trackId: videoTrack!.id,
          startSec: Math.max(0, seed.startSec),
          inPointSec: Math.max(0, seed.inPointSec),
          outPointSec: Math.max(seed.inPointSec + 0.01, seed.outPointSec),
          speed: Math.max(0.01, seed.speed),
          muted: seed.muted ?? opts?.muted ?? false,
        }),
      )
      const clips = [...s.timeline.clips, ...clipSeeds]
      return {
        ...pushPast(s),
        selectedClipIds: ids,
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    })
    return ids
  },

  normalizeTrackOverlaps: (trackIds) =>
    set((s) => {
      if (trackIds.length === 0) return s
      const clips = closeSequentialTrackOverlaps(s.timeline.clips, trackIds)
      const unchanged =
        clips.length === s.timeline.clips.length &&
        clips.every((c, i) => c === s.timeline.clips[i])
      if (unchanged) return s
      return {
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  removeClips: (ids) =>
    set((s) => {
      const { linkEnabled, magneticMainTrack } = useUIStore.getState()
      const trackKinds = new Map(s.timeline.tracks.map((track) => [track.id, track.kind]))
      const clipById = new Map(s.timeline.clips.map((clip) => [clip.id, clip]))
      const kindOf = (trackId: string) => trackKinds.get(trackId)

      const toRemove = new Set(ids)
      // Linkage: deleting a video clip also removes the text/captions sitting
      // over it (the counterpart to dragging them together). Toggle: linkEnabled.
      if (linkEnabled) {
        const videoRanges = ids
          .map((id) => clipById.get(id))
          .filter((c): c is Clip => !!c && kindOf(c.trackId) === 'video')
          .map((c) => [c.startSec, c.startSec + clipEffectiveDuration(c)] as const)
        if (videoRanges.length > 0) {
          videoRanges.sort((a, b) => a[0] - b[0])
          const merged: Array<[number, number]> = []
          for (const [start, end] of videoRanges) {
            const last = merged[merged.length - 1]
            if (last && start <= last[1]) last[1] = Math.max(last[1], end)
            else merged.push([start, end])
          }
          const overlapsVideo = (start: number, end: number): boolean => {
            let low = 0
            let high = merged.length
            while (low < high) {
              const mid = (low + high) >>> 1
              if (merged[mid]![1] <= start) low = mid + 1
              else high = mid
            }
            return low < merged.length && merged[low]![0] < end
          }
          for (const c of s.timeline.clips) {
            const k = kindOf(c.trackId)
            if (k !== 'text') continue
            const cs = c.startSec
            const ce = c.startSec + clipEffectiveDuration(c)
            if (overlapsVideo(cs, ce)) toRemove.add(c.id)
          }
        }
      }

      let clips = s.timeline.clips.filter((c) => !toRemove.has(c.id))
      const tracks = pruneEmptyTracks(s.timeline.tracks, clips)
      // Magnetic main track: close the gap the deletion just opened (and carry
      // the surviving clips' captions along with them).
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
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== id) return c
        // A compound clip can't show more than its sub-timeline holds — clamp so
        // an over-extended window never renders a black tail.
        let out = newOutPointSec
        if (c.compoundId) {
          const subDur = s.compounds[c.compoundId]?.timeline.durationSec
          if (subDur != null) out = Math.min(out, subDur)
        }
        return { ...c, outPointSec: out }
      })
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
      let right: Clip = {
        ...clip,
        id: createId('clip'),
        startSec: atTimelineSec,
        inPointSec: sourceAtSplit,
      }
      // A split compound half becomes its OWN compound (independent sub-timeline)
      // so the two halves don't share/clobber content.
      let compounds = s.compounds
      if (clip.compoundId) {
        const cloned = cloneCompound(compounds, clip.compoundId)
        compounds = cloned.compounds
        right = { ...right, compoundId: cloned.id }
      }
      const clips = s.timeline.clips.map((c) => (c.id === clipId ? left : c)).concat(right)
      return {
        ...pushPast(s),
        compounds,
        selectedClipIds: [right.id],
        selectedTrackIds: [],
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  splitClips: (clipIds, atTimelineSec) =>
    set((s) => {
      const targets = new Set(clipIds)
      if (targets.size === 0) return s
      let compounds = s.compounds
      const selected: string[] = []
      let changed = false
      const clips = s.timeline.clips.flatMap((clip) => {
        if (!targets.has(clip.id)) return [clip]
        const sourceAtSplit = clip.inPointSec + (atTimelineSec - clip.startSec) * clip.speed
        if (
          sourceAtSplit <= clip.inPointSec + MIN_DUR ||
          sourceAtSplit >= clip.outPointSec - MIN_DUR
        ) return [clip]
        const left: Clip = { ...clip, outPointSec: sourceAtSplit }
        let right: Clip = {
          ...clip,
          id: createId('clip'),
          startSec: atTimelineSec,
          inPointSec: sourceAtSplit,
        }
        if (clip.compoundId) {
          const cloned = cloneCompound(compounds, clip.compoundId)
          compounds = cloned.compounds
          right = { ...right, compoundId: cloned.id }
        }
        changed = true
        selected.push(right.id)
        return [left, right]
      })
      if (!changed) return s
      return {
        ...pushPast(s),
        compounds,
        selectedClipIds: selected,
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

      let compounds = s.compounds
      const segments: Clip[] = []
      for (let i = 0; i < boundaries.length - 1; i++) {
        const inPointSec = boundaries[i]!
        const outPointSec = boundaries[i + 1]!
        if (outPointSec - inPointSec < minSourceDur) continue
        const seg: Clip = {
          ...clip,
          id: i === 0 ? clip.id : createId('clip'),
          startSec: clip.startSec + (inPointSec - clip.inPointSec) / speed,
          inPointSec,
          outPointSec,
        }
        // Every segment after the first gets its own independent compound clone.
        if (i > 0 && clip.compoundId) {
          const cloned = cloneCompound(compounds, clip.compoundId)
          compounds = cloned.compounds
          seg.compoundId = cloned.id
        }
        segments.push(seg)
      }
      if (segments.length < 2) return s
      splitCount = segments.length - 1
      const clips = s.timeline.clips.flatMap((c) => (c.id === clipId ? segments : [c]))
      return {
        ...pushPast(s),
        compounds,
        selectedClipIds: segments.map((segment) => segment.id),
        selectedTrackIds: [],
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    })
    return splitCount
  },

  // Split a clip into fixed-length chunks: a cut every `intervalSec` timeline
  // seconds. Delegates to splitClipAtSourceTimes, converting the timeline-time
  // interval into source-time cut points (so it stays even under speed changes).
  splitClipEveryNSeconds: (clipId, intervalSec) => {
    if (!(intervalSec > 0)) return 0
    const clip = get().timeline.clips.find((c) => c.id === clipId)
    if (!clip) return 0
    // Floor the interval at MIN_DUR so a tiny N can't blow up the loop below.
    const safeInterval = Math.max(intervalSec, MIN_DUR)
    // Estimate the segment count up front (no array built yet) and bail before
    // touching state if it would exceed the cap. Returns -1 so the caller can
    // tell "too many" apart from "clip too short" (0).
    const estSegments = Math.floor(clipEffectiveDuration(clip) / safeInterval)
    if (estSegments > MAX_SPLIT_SEGMENTS) return -1
    const speed = Math.max(clip.speed, 0.01)
    const sourceStep = safeInterval * speed
    const sourceTimes: number[] = []
    for (let t = clip.inPointSec + sourceStep; t < clip.outPointSec; t += sourceStep) {
      sourceTimes.push(t)
    }
    return get().splitClipAtSourceTimes(clipId, sourceTimes)
  },

  // Live setter (slider / preset): callers wrap the interaction in a single
  // beginHistoryStep() so a slider drag is one undo step, not dozens.
  // Linked captions rescale with the clip (see rescaleLinkedCaptions) and the
  // magnetic main track re-packs so the duration change never leaves a
  // gap/overlap — both recomputed per call, so live slider drags compose.
  setClipSpeed: (id, speed) =>
    set((s) => {
      const target = s.timeline.clips.find((c) => c.id === id)
      if (!target) return s
      const newSpeed = Math.max(0.1, Math.min(4, speed))
      let clips = rescaleLinkedCaptions(
        s.timeline.clips, s.timeline.tracks, target, target.startSec, newSpeed,
      )
      clips = clips.map((c) => (c.id === id ? { ...c, speed: newSpeed } : c))
      clips = rippleAfterSpeedChange(clips, s.timeline.tracks, target)
      return {
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  // Live setter — see setClipSpeed.
  setClipSpeedDuration: (id, startSec, durationSec) =>
    set((s) => {
      if (!Number.isFinite(startSec) || !Number.isFinite(durationSec)) return s
      const target = s.timeline.clips.find((c) => c.id === id)
      if (!target) return s
      const sourceSpan = Math.max(MIN_DUR, target.outPointSec - target.inPointSec)
      const newSpeed = Math.max(0.1, Math.min(4, sourceSpan / Math.max(MIN_DUR, durationSec)))
      const newStart = Math.max(0, startSec)
      let clips = rescaleLinkedCaptions(
        s.timeline.clips, s.timeline.tracks, target, newStart, newSpeed,
      )
      clips = clips.map((c) =>
        c.id === id ? { ...c, startSec: newStart, speed: newSpeed } : c,
      )
      clips = rippleAfterSpeedChange(clips, s.timeline.tracks, target)
      return {
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  setClipOpacity: (id, opacity) =>
    set((s) => {
      const value = Math.max(0, Math.min(1, opacity))
      const clips = patchClipById(s.timeline.clips, id, (clip) =>
        clip.opacity === value ? clip : { ...clip, opacity: value },
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

  // Live setter — see setClipSpeed.
  setClipVolume: (id, volume) =>
    set((s) => {
      const value = clampVolumeLinear(volume)
      const clips = patchClipById(s.timeline.clips, id, (clip) =>
        clip.volume === value ? clip : { ...clip, volume: value },
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

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
    set((s) => {
      const clips = patchClipsById(s.timeline.clips, ids, (clip) =>
        clip.textData ? { ...clip, textData: { ...clip.textData, ...text } } : clip,
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

  applyCaptionCorrections: (corrections) => {
    let changedCount = 0
    const requested = new Map(
      Object.entries(corrections)
        .map(([id, content]) => [id, content.trim()] as const)
        .filter(([, content]) => content.length > 0),
    )
    if (requested.size === 0) return 0
    set((s) => {
      const clips = s.timeline.clips.map((clip) => {
        const content = requested.get(clip.id)
        const td = clip.textData
        if (!content || !td || content === td.content) return clip
        changedCount++
        const duration = clipEffectiveDuration(clip)
        const wordTimestamps = td.wordTimestamps?.length
          ? normalizeCaptionWordTimestamps(content, td.wordTimestamps, duration).words
          : td.wordTimestamps
        return { ...clip, textData: { ...td, content, wordTimestamps } }
      })
      if (changedCount === 0) return s
      return {
        ...pushPast(s),
        timeline: { ...s.timeline, clips },
      }
    })
    return changedCount
  },

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
          c.id === id && c.fxData ? { ...c, fxData: { ...c.fxData, ...fxData } as FxData } : c,
        ),
      },
    })),

  setClipsCanvasFill: (ids, canvasFill) =>
    set((s) => {
      if (ids.length === 0) return s
      const idSet = new Set(ids)
      let changed = false
      const clips = s.timeline.clips.map((c) => {
        if (!idSet.has(c.id) || c.textData || c.fxData || !c.assetId) return c
        changed = true
        return { ...c, canvasFill: canvasFill ? { ...canvasFill } : undefined }
      })
      if (!changed) return s
      return {
        timeline: { ...s.timeline, clips },
      }
    }),

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
    set((s) => {
      const entries = Object.entries(adjust) as Array<[keyof ColorAdjust, number]>
      const clips = patchClipById(s.timeline.clips, id, (clip) =>
        entries.every(([key, value]) => clip.adjust[key] === value)
          ? clip
          : { ...clip, adjust: { ...clip.adjust, ...adjust } },
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

  setClipsOpacity: (ids, opacity) =>
    set((s) => {
      const v = Math.max(0, Math.min(1, opacity))
      const clips = patchClipsById(s.timeline.clips, ids, (clip) =>
        clip.opacity === v ? clip : { ...clip, opacity: v },
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

  setClipsVolume: (ids, volume) =>
    set((s) => {
      const v = clampVolumeLinear(volume)
      const clips = patchClipsById(s.timeline.clips, ids, (clip) =>
        clip.volume === v ? clip : { ...clip, volume: v },
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

  setClipsAdjust: (ids, adjust) =>
    set((s) => {
      const entries = Object.entries(adjust) as Array<[keyof ColorAdjust, number]>
      const clips = patchClipsById(s.timeline.clips, ids, (clip) =>
        entries.every(([key, value]) => clip.adjust[key] === value)
          ? clip
          : { ...clip, adjust: { ...clip.adjust, ...adjust } },
      ) as Clip[]
      return clips === s.timeline.clips ? s : { timeline: { ...s.timeline, clips } }
    }),

  setClipTransformKeyed: (id, transform, atSec) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) => {
          if (c.id !== id) return c
          const local = Math.max(0, atSec - c.startSec)
          const prev = { ...makeDefaultTransform(), ...c.transform }
          const base = { ...prev, ...transform }
          const kf = { ...c.keyframes }
          let changed = false
          for (const prop of TRANSFORM_KF_PROPS) {
            const value = (transform as Record<string, unknown>)[prop]
            if (typeof value !== 'number') continue
            if (kf[prop]?.length) {
              kf[prop] = upsertKeyframe(kf[prop], local, value)
              base[prop] = prev[prop] // animated prop: leave the static field alone
              changed = true
            }
          }
          return { ...c, transform: base, keyframes: changed ? kf : c.keyframes }
        }),
      },
    })),

  setClipOpacityKeyed: (id, opacity, atSec) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        clips: s.timeline.clips.map((c) => {
          if (c.id !== id) return c
          const v = Math.max(0, Math.min(1, opacity))
          if (c.keyframes?.opacity?.length) {
            const local = Math.max(0, atSec - c.startSec)
            return {
              ...c,
              keyframes: { ...c.keyframes, opacity: upsertKeyframe(c.keyframes.opacity, local, v) },
            }
          }
          return { ...c, opacity: v }
        }),
      },
    })),

  toggleKeyframes: (id, props, atSec) =>
    set((s) => {
      let touched = false
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== id) return c
        touched = true
        const local = Math.max(0, atSec - c.startSec)
        const kf = { ...c.keyframes }
        const anyAt = props.some((p) => (kf[p] ?? []).some((k) => Math.abs(k.t - local) <= KF_EPS))
        for (const p of props) {
          if (anyAt) {
            const track = (kf[p] ?? []).filter((k) => Math.abs(k.t - local) > KF_EPS)
            if (track.length) kf[p] = track
            else delete kf[p]
          } else {
            kf[p] = upsertKeyframe(kf[p], local, currentKeyframeValue(c, p, atSec))
          }
        }
        return { ...c, keyframes: Object.keys(kf).length ? kf : undefined }
      })
      if (!touched) return s
      return { ...pushPast(s), timeline: { ...s.timeline, clips } }
    }),

  clearClipKeyframes: (id, props) =>
    set((s) => {
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== id || !c.keyframes) return c
        const kf = { ...c.keyframes }
        for (const p of props) delete kf[p]
        return { ...c, keyframes: Object.keys(kf).length ? kf : undefined }
      })
      return { ...pushPast(s), timeline: { ...s.timeline, clips } }
    }),

  selectClips: (ids) =>
    set((s) => ({
      selectedClipIds: expandToGroups(s.timeline.clips, ids),
      selectedTrackIds: [],
    })),

  groupClips: (ids) =>
    set((s) => {
      const members = expandToGroups(s.timeline.clips, ids)
      if (members.length < 2) return s
      const gid = createId('group')
      const member = new Set(members)
      const clips = s.timeline.clips.map((c) => (member.has(c.id) ? { ...c, groupId: gid } : c))
      return { ...pushPast(s), timeline: { ...s.timeline, clips }, selectedClipIds: members }
    }),

  ungroupClips: (ids) =>
    set((s) => {
      const idSet = new Set(ids)
      const groupIds = new Set<string>()
      for (const c of s.timeline.clips) if (c.groupId && idSet.has(c.id)) groupIds.add(c.groupId)
      if (groupIds.size === 0) return s
      const clips = s.timeline.clips.map((c) =>
        c.groupId && groupIds.has(c.groupId) ? { ...c, groupId: undefined } : c,
      )
      return { ...pushPast(s), timeline: { ...s.timeline, clips } }
    }),

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

  beginClipDrag: (ids, anchorTrackId) =>
    set((s) => {
      const ui = useUIStore.getState()
      const mainId = ui.magneticMainTrack ? mainVideoTrackId(s.timeline.tracks) : null
      dragRippleContext = mainId
        ? prepareRipplePreview(
            s.timeline.clips,
            s.timeline.tracks,
            mainId,
            ids,
            ui.linkEnabled,
          )
        : null
      return {
        draggingIds: ids,
        dragDeltaSec: 0,
        dragDeltaYPx: 0,
        dragRipplePreview: null,
        dragTargetTrackId: null,
        dragAnchorTrackId:
          anchorTrackId ?? s.timeline.clips.find((c) => c.id === ids[0])?.trackId ?? null,
        dragCreateKind: null,
      }
    }),

  setClipDragDelta: (deltaSec, deltaYPx = 0) =>
    set((s) => {
      // Live magnetic ripple: reflow the non-dragged main-track clips (and their
      // captions) so they slide in real time as the dragged clip passes them.
      let dragRipplePreview = s.dragRipplePreview
      if (useUIStore.getState().magneticMainTrack) {
        const mainId = mainVideoTrackId(s.timeline.tracks)
        if (mainId && !dragRippleContext) {
          dragRippleContext = prepareRipplePreview(
            s.timeline.clips,
            s.timeline.tracks,
            mainId,
            s.draggingIds,
            useUIStore.getState().linkEnabled,
          )
        }
        dragRipplePreview = dragRippleContext
          ? computeRipplePreview(dragRippleContext, deltaSec)
          : null
      }
      return { dragDeltaSec: deltaSec, dragDeltaYPx: deltaYPx, dragRipplePreview }
    }),

  setClipDragTargetTrack: (trackId) =>
    set((s) => (s.dragTargetTrackId === trackId ? s : { dragTargetTrackId: trackId })),

  setClipDragCreateKind: (kind) =>
    set((s) => (s.dragCreateKind === kind ? s : { dragCreateKind: kind })),

  commitClipDrag: () => {
    dragRippleContext = null
    set((s) => {
      const reset = {
        draggingIds: [],
        dragDeltaSec: 0,
        dragDeltaYPx: 0,
        dragRipplePreview: null,
        dragTargetTrackId: null,
        dragAnchorTrackId: null,
        dragCreateKind: null,
      }
      if (s.draggingIds.length === 0) return reset
      const ids = s.draggingIds
      const delta = s.dragDeltaSec

      // TimelineClip begins a potential drag on pointer-down, including for a
      // plain click. Do not run collision placement on pointer-up unless the
      // user actually moved in time or targeted another row. Re-processing a
      // zero-delta click used to expose tiny imported boundary overlaps and
      // bump clips/captions onto newly-created tracks.
      const requestedTrackChange =
        s.dragCreateKind !== null ||
        (s.dragTargetTrackId !== null && s.dragTargetTrackId !== s.dragAnchorTrackId)
      if (Math.abs(delta) < 1e-7 && !requestedTrackChange) return reset

      let tracks = s.timeline.tracks
      let clips = s.timeline.clips.map((c) => ({ ...c }))
      const clipIndexById = new Map(clips.map((clip, index) => [clip.id, index]))
      const originalTrackById = new Map(s.timeline.tracks.map((track) => [track.id, track]))
      const remainingDragIds = new Set(ids)

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

      // Vertical row offset (target − anchor) within the anchor kind's stack.
      // Applied to every dragged clip relative to its OWN source track so a
      // multi-track selection keeps its row spacing instead of all collapsing
      // onto `targetTrack`. A pure horizontal drag has offset 0 → each clip
      // stays on its own row.
      const anchorTrack = s.dragAnchorTrackId
        ? tracks.find((t) => t.id === s.dragAnchorTrackId)
        : undefined
      const anchorKind = anchorTrack?.kind
      let rowOffset = 0
      if (anchorTrack && anchorKind) {
        const sameKind = tracks.filter((t) => t.kind === anchorKind)
        const anchorIdx = sameKind.findIndex((t) => t.id === anchorTrack.id)
        let targetIdx = anchorIdx
        if (spawnedTrackId && anchorKind === s.dragCreateKind) {
          targetIdx = sameKind.findIndex((t) => t.id === spawnedTrackId)
        } else if (targetTrack && targetTrack.kind === anchorKind && !targetTrack.locked) {
          targetIdx = sameKind.findIndex((t) => t.id === targetTrack.id)
        }
        if (anchorIdx >= 0 && targetIdx >= 0) rowOffset = targetIdx - anchorIdx
      }

      // Place each dragged clip, bumping to a free/new track so nothing overlaps.
      for (let k = 0; k < ids.length; k++) {
        const id = ids[k]!
        const idx = clipIndexById.get(id) ?? -1
        if (idx < 0) continue
        const c = clips[idx]!
        const srcTrack = originalTrackById.get(c.trackId)
        const kind = srcTrack?.kind ?? 'video'
        const startSec = Math.max(0, c.startSec + delta)
        const dur = clipEffectiveDuration(c)

        let preferred: string | undefined = c.trackId
        if (spawnedTrackId && kind === s.dragCreateKind) {
          preferred = spawnedTrackId
        } else if (kind === anchorKind && rowOffset !== 0) {
          // Shift this clip by the same number of rows the anchor moved.
          const sameKind = tracks.filter((t) => t.kind === kind)
          const srcIdx = sameKind.findIndex((t) => t.id === c.trackId)
          if (srcIdx >= 0) {
            const destIdx = Math.max(0, Math.min(sameKind.length - 1, srcIdx + rowOffset))
            preferred = sameKind[destIdx]!.id
          }
        }

        // Magnetic insert: a video clip landing on the main track drops straight
        // onto it (overlaps allowed) and the ripple below reorders + pushes the
        // following clips to make room — instead of bumping onto a new track.
        if (dragMainId && kind === 'video' && preferred === dragMainId) {
          if (startSec !== c.startSec || c.trackId !== dragMainId) changed = true
          clips[idx] = { ...c, startSec, trackId: dragMainId }
          remainingDragIds.delete(id)
          continue
        }

        // Exclude this clip + the dragged siblings NOT yet placed: their slots
        // are still at their OLD positions, so counting them would be a false
        // collision. Already-placed siblings keep their NEW positions in
        // `clips`, so a clip landing on a row one of them now occupies gets
        // bumped to a free/new row — enforcing "one clip per row per moment".
        const placement = placeOnFreeTrack(
          tracks, clips, kind, startSec, dur, remainingDragIds, preferred,
        )
        tracks = placement.tracks
        if (startSec !== c.startSec || placement.trackId !== c.trackId) changed = true
        clips[idx] = { ...c, startSec, trackId: placement.trackId }
        remainingDragIds.delete(id)
      }

      if (!changed) return reset
      // Moving clips off a track may leave it empty → clean up.
      tracks = pruneEmptyTracks(tracks, clips)
      // Magnetic main track: insert/close gaps + carry every shifted clip's
      // linked captions (not just the dragged one).
      const mainId = magneticMainTrack ? mainVideoTrackId(tracks) : null
      if (mainId) clips = rippleMainTrack(clips, tracks, mainId, linkEnabled)
      return {
        ...pushPast(s),
        ...reset,
        selectedTrackIds: [],
        timeline: { ...s.timeline, tracks, clips, durationSec: recalcDuration(clips) },
      }
    })
  },

  cancelClipDrag: () => {
    dragRippleContext = null
    set({
      draggingIds: [],
      dragDeltaSec: 0,
      dragDeltaYPx: 0,
      dragRipplePreview: null,
      dragTargetTrackId: null,
      dragAnchorTrackId: null,
      dragCreateKind: null,
    })
  },

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

  detachAudio: (clipId) => get().detachAudios([clipId]),

  // Split video clips' audio into their own clips on audio tracks and mute
  // the source clips' audio (CapCut "Detach audio").
  detachAudios: (clipIds) =>
    set((s) => {
      const requested = new Set(clipIds)
      if (requested.size === 0) return s

      let tracks = s.timeline.tracks
      let clips = s.timeline.clips
      const audioIds: string[] = []
      const targetClips = s.timeline.clips
        .filter((clip) => {
          if (!requested.has(clip.id) || !clip.assetId || clip.muted) return false
          const srcTrack = s.timeline.tracks.find((t) => t.id === clip.trackId)
          return srcTrack?.kind === 'video'
        })
        .sort((a, b) => a.startSec - b.startSec)

      if (targetClips.length === 0) return s

      for (const clip of targetClips) {
        const dur = clipEffectiveDuration(clip)
        const placement = placeOnFreeTrack(tracks, clips, 'audio', clip.startSec, dur, EMPTY_CLIP_IDS)
        tracks = placement.tracks
        const audioClip = makeClip({
          id: createId('clip'),
          assetId: clip.assetId,
          trackId: placement.trackId,
          startSec: clip.startSec,
          inPointSec: clip.inPointSec,
          outPointSec: clip.outPointSec,
          speed: clip.speed,
          volume: clip.volume,
          detachedFromClipId: clip.id,
        })
        audioIds.push(audioClip.id)
        clips = clips.map((c) => (c.id === clip.id ? { ...c, muted: true } : c)).concat(audioClip)
      }

      return {
        ...pushPast(s),
        selectedClipIds: audioIds,
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks,
          clips,
          durationSec: recalcDuration(clips),
        },
      }
    }),

  restoreAudio: (clipId) => get().restoreAudios([clipId]),

  // Restore a video's original audio. Detached audio clips are kept intact so
  // users can deliberately layer, compare, or delete them later.
  restoreAudios: (clipIds) =>
    set((s) => {
      const requested = new Set(clipIds)
      if (requested.size === 0) return s
      const restoreClips = s.timeline.clips.filter((clip) => {
        if (!requested.has(clip.id) || !clip.assetId || !clip.muted) return false
        const srcTrack = s.timeline.tracks.find((t) => t.id === clip.trackId)
        return srcTrack?.kind === 'video'
      })
      if (restoreClips.length === 0) return s
      const restoreIds = new Set(restoreClips.map((clip) => clip.id))

      const clips = s.timeline.clips.map((candidate) =>
        restoreIds.has(candidate.id) ? { ...candidate, muted: false } : candidate,
      )
      return {
        ...pushPast(s),
        selectedClipIds: Array.from(restoreIds),
        selectedTrackIds: [],
        timeline: {
          ...s.timeline,
          tracks: s.timeline.tracks,
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
        const placement = placeOnFreeTrack(tracks, clips, 'audio', src.startSec, dur, EMPTY_CLIP_IDS)
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

  toggleTrackHidden: (trackId) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        tracks: s.timeline.tracks.map((t) => (t.id === trackId ? { ...t, hidden: !t.hidden } : t)),
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

  replaceClipSource: (clipId, assetId, inPointSec, keepEffects) =>
    set((s) => {
      const target = s.timeline.clips.find((c) => c.id === clipId)
      if (!target) return s
      // Keep the same timeline footprint: same source span length (out − in) at
      // the same speed → same on-track duration. Only the in-point shifts.
      const span = target.outPointSec - target.inPointSec
      const newIn = Math.max(0, inPointSec)
      const clips = s.timeline.clips.map((c) => {
        if (c.id !== clipId) return c
        const base: Clip = {
          ...c,
          assetId,
          inPointSec: newIn,
          outPointSec: newIn + span,
          // Replacing with real media drops any text/sticker payload.
          textData: undefined,
          fxData: undefined,
        }
        if (keepEffects) return base
        return {
          ...base,
          effects: [],
          transform: makeDefaultTransform(),
          adjust: makeDefaultAdjust(),
        }
      })
      return {
        ...pushPast(s),
        selectedClipIds: [clipId],
        selectedTrackIds: [],
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  setZoom: (z) => set({ zoom: Math.max(0.000001, Math.min(400, z)) }),

  undo: () => {
    let changed = false
    set((s) => {
      const prev = s.past[s.past.length - 1]
      if (!prev) return s
      changed = true
      return {
        past: s.past.slice(0, -1),
        future: trimHistoryHead([snap(s), ...s.future]),
        canUndo: s.past.length > 1,
        canRedo: true,
        // Registry and timeline must move together: a compound clip restored by
        // undo is meaningless without its registry entry (break → undo).
        compounds: prev.compounds,
        timeline: {
          ...s.timeline,
          clips: prev.clips,
          tracks: prev.tracks,
          durationSec: prev.durationSec,
        },
        selectedClipIds: [],
        selectedTrackIds: [],
      }
    })
    const playback = usePlaybackStore.getState()
    if (changed && playback.isPlaying) playback.seekInternal(playback.currentSec)
  },

  redo: () => {
    let changed = false
    set((s) => {
      const next = s.future[0]
      if (!next) return s
      changed = true
      return {
        past: trimHistoryTail([...s.past, snap(s)]),
        future: s.future.slice(1),
        canUndo: true,
        canRedo: s.future.length > 1,
        compounds: next.compounds,
        timeline: {
          ...s.timeline,
          clips: next.clips,
          tracks: next.tracks,
          durationSec: next.durationSec,
        },
        selectedClipIds: [],
        selectedTrackIds: [],
      }
    })
    const playback = usePlaybackStore.getState()
    if (changed && playback.isPlaying) playback.seekInternal(playback.currentSec)
  },

  replaceTimeline: (clips, tracks, fps, durationSec) => {
    dragRippleContext = null
    set({
      timeline: { clips, tracks: sortTracksForStack(tracks), fps, durationSec },
      // Loading a project exits any open compound view; the registry is loaded
      // separately via setCompounds.
      compoundStack: [],
      selectedClipIds: [],
      selectedTrackIds: [],
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
    })
  },

  setCompounds: (compounds) =>
    set((s) => {
      // Clamp compound clip windows to the (just-loaded) sub-timeline lengths so
      // an over-extended window from an old project doesn't render a black tail.
      const clips = clampCompoundClips(s.timeline.clips, compounds)
      return {
        compounds,
        timeline:
          clips === s.timeline.clips
            ? s.timeline
            : { ...s.timeline, clips, durationSec: recalcDuration(clips) },
      }
    }),

  rootSnapshot: () => rootContext(get()),

  flatTimeline: () => {
    const { timeline, compounds } = get()
    if (_flatCache.timeline === timeline && _flatCache.compounds === compounds) {
      return _flatCache.result
    }
    // flattenCompounds throws on corrupt data (cycle / nesting too deep). This
    // runs on every render/export, so never let bad persisted data white-screen
    // the editor — degrade to the un-flattened timeline and warn once.
    let result: TimelineState
    try {
      result = flattenCompounds(timeline, compounds)
    } catch (error) {
      result = timeline
      if (!_flattenErrorWarned) {
        _flattenErrorWarned = true
        console.error('[timeline] flattenCompounds failed; showing un-flattened timeline', error)
        useToastStore.getState().push('Invalid nested compound — showing the unflattened timeline.', 'error')
      }
    }
    _flatCache = { timeline, compounds, result }
    return result
  },

  createCompound: (ids) => {
    if (get().compoundStack.length >= MAX_COMPOUND_DEPTH) {
      useToastStore.getState().push(
        `Compounds support up to ${MAX_COMPOUND_DEPTH} nested levels.`,
        'error',
      )
      return
    }
    set((s) => {
      const idSet = new Set(ids)
      const members = s.timeline.clips.filter((c) => idSet.has(c.id))
      if (members.length === 0) return s
      const base = Math.min(...members.map((c) => c.startSec))
      const usedTrackIds = new Set(members.map((c) => c.trackId))
      const subTracks = s.timeline.tracks
        .filter((t) => usedTrackIds.has(t.id))
        .map((t) => ({ ...t }))
      const subClips = members.map((c) => ({
        ...c,
        startSec: Math.max(0, c.startSec - base),
        groupId: undefined,
      }))
      const subDuration = subClips.reduce(
        (max, c) => Math.max(max, c.startSec + clipEffectiveDuration(c)),
        0,
      )
      // Host the compound clip on a video track: a video track among the members,
      // else the main video track.
      const hostTrackId =
        s.timeline.tracks.find((t) => usedTrackIds.has(t.id) && t.kind === 'video')?.id ??
        mainVideoTrackId(s.timeline.tracks) ??
        s.timeline.tracks.find((t) => t.kind === 'video')?.id
      if (!hostTrackId) return s

      const compoundId = createId('compound')
      const name = `Compound clip ${Object.keys(s.compounds).length + 1}`
      const compoundClip: Clip = {
        id: createId('clip'),
        assetId: null,
        compoundId,
        trackId: hostTrackId,
        startSec: base,
        inPointSec: 0,
        outPointSec: subDuration,
        speed: 1,
        opacity: 1,
        volume: 1,
        adjust: makeDefaultAdjust(),
        transform: makeDefaultTransform(),
        effects: [],
      }
      const clips = [...s.timeline.clips.filter((c) => !idSet.has(c.id)), compoundClip]
      return {
        ...pushPast(s),
        compounds: {
          ...s.compounds,
          [compoundId]: {
            name,
            timeline: { tracks: subTracks, clips: subClips, fps: s.timeline.fps, durationSec: subDuration },
          },
        },
        timeline: { ...s.timeline, clips, durationSec: recalcDuration(clips) },
        selectedClipIds: [compoundClip.id],
        selectedTrackIds: [],
      }
    })
  },

  breakCompound: (ids) =>
    set((s) => {
      const idSet = new Set(ids)
      const targets = s.timeline.clips.filter((c) => idSet.has(c.id) && c.compoundId)
      if (targets.length === 0) return s

      let tracks = s.timeline.tracks
      const targetIds = new Set(targets.map((c) => c.id))
      const brokenCompoundIds = new Set(targets.map((c) => c.compoundId!))
      const clips = s.timeline.clips.filter((c) => !targetIds.has(c.id))
      const addedIds: string[] = []

      for (const target of targets) {
        const source = s.compounds[target.compoundId!]
        if (!source) continue
        const flat = flattenCompounds(
          {
            tracks: [tracks.find((t) => t.id === target.trackId)].filter(Boolean) as Track[],
            clips: [target],
            fps: s.timeline.fps,
            durationSec: clipEffectiveDuration(target),
          },
          s.compounds,
        )
        const kindByFlatTrack = new Map(flat.tracks.map((track) => [track.id, track.kind]))
        const prefix = `${target.id}::`

        for (const seed of flat.clips) {
          const kind = kindByFlatTrack.get(seed.trackId) ?? 'video'
          const preferredTrackId = seed.trackId.startsWith(prefix)
            ? seed.trackId.slice(prefix.length)
            : seed.trackId
          const placement = placeOnFreeTrack(
            tracks,
            clips,
            kind,
            seed.startSec,
            clipEffectiveDuration(seed),
            EMPTY_CLIP_IDS,
            preferredTrackId,
          )
          tracks = placement.tracks
          const child = { ...seed, trackId: placement.trackId, groupId: undefined }
          clips.push(child)
          addedIds.push(child.id)
        }
      }

      if (addedIds.length === 0) return s
      const referencedCompoundIds = new Set(clips.map((c) => c.compoundId).filter(Boolean))
      const compounds = { ...s.compounds }
      for (const compoundId of brokenCompoundIds) {
        if (!referencedCompoundIds.has(compoundId)) delete compounds[compoundId]
      }

      return {
        ...pushPast(s),
        compounds,
        timeline: {
          ...s.timeline,
          tracks: pruneEmptyTracks(tracks, clips),
          clips,
          durationSec: recalcDuration(clips),
        },
        selectedClipIds: addedIds,
        selectedTrackIds: [],
      }
    }),

  enterCompound: (compoundId, win) => {
    if (!get().compounds[compoundId]) return
    const parentCurrentSec = usePlaybackStore.getState().currentSec
    set((s) => {
      const compound = s.compounds[compoundId]
      if (!compound) return s
      const sub = compound.timeline
      const refs = s.timeline.clips.filter((c) => c.compoundId === compoundId)
      // Show only the trimmed window — but ONLY for a single-reference compound
      // (a split compound has multiple windows → stay full-view, no ambiguity).
      const trimmed =
        !!win && (win.inPointSec > 1e-4 || win.outPointSec < sub.durationSec - 1e-4)
      let timeline = sub
      let window: CompoundFrame['window']
      if (win && refs.length === 1 && trimmed) {
        const a = Math.max(0, win.inPointSec)
        const b = Math.min(sub.durationSec, win.outPointSec)
        const clips = sub.clips
          .map((c) => clipPortion(c, a, b))
          .filter((c): c is Clip => !!c)
          .map((c) => ({ ...c, startSec: c.startSec - a }))
        timeline = { ...sub, clips, durationSec: b - a }
        window = { in: a, oldLen: b - a, fullSub: sub, clipId: refs[0]!.id }
      }
      const frame: CompoundFrame = {
        id: compoundId,
        name: compound.name,
        parentTimeline: s.timeline,
        parentSelectedClipIds: s.selectedClipIds,
        subDurationAtEnter: sub.durationSec,
        window,
        parentCurrentSec,
      }
      return {
        compoundStack: [...s.compoundStack, frame],
        timeline,
        selectedClipIds: [],
        selectedTrackIds: [],
        past: [],
        future: [],
        canUndo: false,
        canRedo: false,
      }
    })
    // Start the sub-timeline preview at its beginning (not wherever the parent
    // playhead happened to be — which could be past the window → black frame).
    usePlaybackStore.getState().seek(0)
  },

  exitCompound: () => {
    const stack = get().compoundStack
    if (stack.length === 0) return
    const restoreSec = stack[stack.length - 1]!.parentCurrentSec
    set((s) => {
      if (s.compoundStack.length === 0) return s
      const frame = s.compoundStack[s.compoundStack.length - 1]!
      const edited = s.timeline
      const EPS = 1e-4

      // Rebuild the compound's sub-timeline. For a WINDOWED edit, splice the edited
      // window back into the full sub-timeline: keep the trimmed-off parts before/
      // after the window and shift the tail by the window's length change.
      let newSub: TimelineState = edited
      if (frame.window) {
        const { in: a, oldLen, fullSub } = frame.window
        const b = a + oldLen
        const delta = edited.durationSec - oldLen
        const before = fullSub.clips
          .map((c) => clipPortion(c, -Infinity, a))
          .filter((c): c is Clip => !!c)
        const after = fullSub.clips
          .map((c) => clipPortion(c, b, Infinity))
          .filter((c): c is Clip => !!c)
          .map((c) => ({ ...c, startSec: c.startSec + delta }))
        const inside = edited.clips.map((c) => ({ ...c, startSec: c.startSec + a }))
        const clips = [...before, ...inside, ...after]
        newSub = { ...edited, clips, durationSec: recalcDuration(clips) }
      }
      const newDur = newSub.durationSec

      // Restore the parent. The clip we windowed-edited keeps its window start and
      // takes the edited window's new length. Others: a full-window clip tracks the
      // new length; a trimmed/split clip keeps its window (clamped) — so trims and
      // split halves survive instead of snapping to full length and overlapping.
      const parentClips = frame.parentTimeline.clips.map((c) => {
        if (c.compoundId !== frame.id) return c
        if (frame.window && c.id === frame.window.clipId) {
          return { ...c, inPointSec: frame.window.in, outPointSec: frame.window.in + edited.durationSec }
        }
        const wasFull = c.inPointSec <= EPS && c.outPointSec >= frame.subDurationAtEnter - EPS
        if (wasFull) return { ...c, inPointSec: 0, outPointSec: newDur }
        return {
          ...c,
          inPointSec: Math.min(c.inPointSec, Math.max(0, newDur - EPS)),
          outPointSec: Math.min(c.outPointSec, newDur),
        }
      })
      const validSel = frame.parentSelectedClipIds.filter((id) =>
        parentClips.some((c) => c.id === id),
      )
      return {
        compounds: { ...s.compounds, [frame.id]: { name: frame.name, timeline: newSub } },
        compoundStack: s.compoundStack.slice(0, -1),
        timeline: { ...frame.parentTimeline, clips: parentClips, durationSec: recalcDuration(parentClips) },
        selectedClipIds: validSel,
        selectedTrackIds: [],
        past: [],
        future: [],
        canUndo: false,
        canRedo: false,
      }
    })
    // Restore the parent playhead we saved on enter.
    usePlaybackStore.getState().seek(restoreSec)
  },
}))
