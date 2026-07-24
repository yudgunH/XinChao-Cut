import { memo, useCallback, useMemo, useState } from 'react'

import {
  captionClipIdsOnTrack,
  clipEffectiveDuration,
  compoundWindowPeaks,
  flattenCompounds,
  isCaptionClip,
  type Clip,
  type Track,
  type TrackKind,
} from '@engine/timeline'
import { getCachedCapabilities } from '@engine/backend'
import { runVocalSeparation } from '@engine/audio/separation-runner'
import {
  dbToVolume,
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  NORMAL_VOLUME_DB,
  volumeToDb,
} from '@engine/audio/volume'
import { isProxyRunning, removeProxy, runProxyGeneration } from '@engine/media/proxy-runner'
import { isAudioCapableProxyKey } from '@engine/media'
import { runSceneSplit } from '@engine/media/scene-split-runner'
import { runClipTranscription } from '@engine/subtitle/transcribe-runner'
import { useProjectStore } from '@store/project-store'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'
import { useToastStore } from '@store/toast-store'
import { useContextMenuStore, type MenuItem } from '@store/context-menu-store'

import {
  collectTimelineSnapTargets,
  snapTimelineRangeStart,
  snapTimelineSec,
  snapTimelineSecWithinLimits,
} from './timeline-snap'
import { planThumbnailSlots } from './thumbnail-virtualization'

interface TimelineClipProps {
  clip: Clip
  zoom: number
  heightPx: number
  /** Horizontal scroll of the timeline viewport (px) — thumbnail virtualization. */
  scrollLeft?: number
  /** Visible width of the timeline viewport (px). */
  viewportWidth?: number
}

/**
 * Linkage: when dragging video clip(s), also carry every text/caption clip that
 * overlaps their time span (CapCut "link") — so a video's captions and audio
 * move with it. Returns the original ids unchanged when nothing is a video clip
 * (dragging audio/captions alone doesn't pull the video).
 */
function withLinkedClips(baseIds: string[], clips: Clip[], tracks: Track[]): string[] {
  const trackKinds = new Map(tracks.map((track) => [track.id, track.kind]))
  const clipById = new Map(clips.map((clip) => [clip.id, clip]))
  const kindOf = (trackId: string) => trackKinds.get(trackId)
  const videoRanges = baseIds
    .map((id) => clipById.get(id))
    .filter((c): c is Clip => !!c && kindOf(c.trackId) === 'video')
    .map((c) => [c.startSec, c.startSec + clipEffectiveDuration(c)] as const)
  if (videoRanges.length === 0) return baseIds

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

  const linked = new Set(baseIds)
  for (const c of clips) {
    const k = kindOf(c.trackId)
    if (k !== 'text') continue
    const cs = c.startSec
    const ce = c.startSec + clipEffectiveDuration(c)
    if (overlapsVideo(cs, ce)) linked.add(c.id)
  }
  return [...linked]
}

const KIND_BG: Record<string, string> = {
  video: 'bg-[#111827]',
  // CapCut-style: dark blue background for audio.
  audio: 'bg-[#071a2b]',
  text: 'bg-[#2a2a31] hover:bg-[#34343d]',
  fx: 'bg-gradient-to-b from-[#3b1d57] to-[#2d1a45]',
}

// Per-frame thumbnail strip — only viewport-visible slots (+ overscan, hard cap).
function VideoThumbnailStrip({
  strip,
  assetWidth,
  assetHeight,
  assetDurationSec,
  inPointSec,
  clipDurationSec,
  clipWidthPx,
  clipHeightPx,
  clipLeftPx,
  scrollLeft,
  viewportWidth,
}: {
  strip: string[]
  assetWidth: number
  assetHeight: number
  assetDurationSec: number
  inPointSec: number
  clipDurationSec: number
  clipWidthPx: number
  clipHeightPx: number
  clipLeftPx: number
  scrollLeft: number
  viewportWidth: number
}) {
  const slots = useMemo(
    () =>
      planThumbnailSlots({
        stripLength: strip.length,
        assetWidth,
        assetHeight,
        assetDurationSec,
        inPointSec,
        clipDurationSec,
        clipWidthPx,
        clipHeightPx,
        clipLeftPx,
        scrollLeft,
        viewportWidth,
      }),
    [
      strip,
      assetWidth,
      assetHeight,
      assetDurationSec,
      inPointSec,
      clipDurationSec,
      clipWidthPx,
      clipHeightPx,
      clipLeftPx,
      scrollLeft,
      viewportWidth,
    ],
  )
  if (slots.length === 0) return null

  return (
    <>
      {slots.map((slot) => {
        const src = strip[slot.stripIdx]
        if (!src) return null
        return (
          <div
            key={slot.slotIndex}
            className="absolute top-0 overflow-hidden"
            style={{ left: slot.leftPx, width: slot.frameW + 1, height: clipHeightPx }}
          >
            <img src={src} className="h-full w-full object-cover" draggable={false} alt="" />
          </div>
        )
      })}
    </>
  )
}

const MIN_TRIM_SEC = 0.1 // shortest a clip can be trimmed to

function clampSec(sec: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, sec))
}

const NEW_TRACK_ZONE_PX = 10 // how far past the group edge spawns a new track

interface DropTarget {
  trackId: string | null
  createKind: TrackKind | null
}

function resolveDropTarget(clientX: number, clientY: number, sourceTrackId: string): DropTarget {
  const { timeline } = useTimelineStore.getState()
  const sourceTrack = timeline.tracks.find((t) => t.id === sourceTrackId)
  if (!sourceTrack) return { trackId: null, createKind: null }

  // 1. An existing compatible track directly under the cursor.
  const trackEl = document
    .elementsFromPoint(clientX, clientY)
    .find((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.timelineTrackId)
  const targetId = trackEl?.dataset.timelineTrackId
  const targetTrack = targetId ? timeline.tracks.find((t) => t.id === targetId) : undefined
  if (targetTrack && !targetTrack.locked && targetTrack.kind === sourceTrack.kind) {
    return { trackId: targetId!, createKind: null }
  }

  // 2. Dragged past the top/bottom edge of its own kind group → spawn a track.
  const sameKindEls = Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-timeline-track-kind="${sourceTrack.kind}"]`,
    ),
  )
  if (sameKindEls.length > 0) {
    const rects = sameKindEls.map((el) => el.getBoundingClientRect())
    const groupTop = Math.min(...rects.map((r) => r.top))
    const groupBottom = Math.max(...rects.map((r) => r.bottom))
    if (clientY < groupTop + NEW_TRACK_ZONE_PX || clientY > groupBottom - NEW_TRACK_ZONE_PX) {
      return { trackId: null, createKind: sourceTrack.kind }
    }
  }

  return { trackId: null, createKind: null }
}

/** Memo: parent tracks re-render on scroll/selection; clip props are
 *  reference-stable when the store updates immutably and only other clips change. */
export const TimelineClip = memo(function TimelineClip({
  clip,
  zoom,
  heightPx,
  scrollLeft = 0,
  viewportWidth = 0,
}: TimelineClipProps) {
  const assets = useProjectStore((s) => s.assets)
  const isSelected = useTimelineStore((s) => s.selectedClipIds.includes(clip.id))
  const selectClips = useTimelineStore((s) => s.selectClips)
  const toggleSelectClip = useTimelineStore((s) => s.toggleSelectClip)
  const setTimelineSnapGuideSec = useUIStore((s) => s.setTimelineSnapGuideSec)
  const trimClipLeft = useTimelineStore((s) => s.trimClipLeft)
  const trimClipLeftText = useTimelineStore((s) => s.trimClipLeftText)
  const trimClipRight = useTimelineStore((s) => s.trimClipRight)
  const setClipSpeedDuration = useTimelineStore((s) => s.setClipSpeedDuration)
  const setClipVolume = useTimelineStore((s) => s.setClipVolume)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)
  const beginClipDrag = useTimelineStore((s) => s.beginClipDrag)
  const setClipDragDelta = useTimelineStore((s) => s.setClipDragDelta)
  const setClipDragTargetTrack = useTimelineStore((s) => s.setClipDragTargetTrack)
  const setClipDragCreateKind = useTimelineStore((s) => s.setClipDragCreateKind)
  const commitClipDrag = useTimelineStore((s) => s.commitClipDrag)
  const openMenu = useContextMenuStore((s) => s.openMenu)
  const track = useTimelineStore((s) => s.timeline.tracks.find((t) => t.id === clip.trackId))
  const asset = assets.find((a) => a.id === clip.assetId)
  const activeRightTab = useUIStore((s) => s.activeRightTab)

  // Shared drag offset (so all selected clips move together)
  const isDragging = useTimelineStore((s) => s.draggingIds.includes(clip.id))
  const dragDeltaSec = useTimelineStore((s) => (isDragging ? s.dragDeltaSec : 0))
  const dragDeltaYPx = useTimelineStore((s) => (isDragging ? s.dragDeltaYPx : 0))
  // Live magnetic ripple: a non-dragged clip slides to its previewed slot while
  // another clip is dragged over the main track (CapCut-style real-time reflow).
  const previewStart = useTimelineStore((s) =>
    isDragging ? undefined : s.dragRipplePreview?.[clip.id],
  )

  const isLocked = track?.locked ?? false
  const durationSec = clipEffectiveDuration(clip)
  const rippleShiftPx = previewStart != null ? (previewStart - clip.startSec) * zoom : 0
  const left = (clip.startSec + dragDeltaSec) * zoom
  const width = Math.max(durationSec * zoom, 6)
  // Trim handles shrink on narrow clips so a central body region always stays
  // grabbable for *moving* (otherwise two 12px handles cover the whole clip and
  // a short clip can only be trimmed, never dragged). Too thin → drop entirely.
  const MIN_BODY_GRAB = 10
  const handleW = Math.max(0, Math.min(12, (width - MIN_BODY_GRAB) / 2))
  const showHandles = !isLocked && handleW >= 3
  const showSpeedHandles = showHandles && isSelected && activeRightTab === 'speed'
  const kind = track?.kind ?? 'video'
  const bgCls = KIND_BG[kind] ?? KIND_BG['video']!
  const compoundName = useTimelineStore((s) =>
    clip.compoundId ? s.compounds[clip.compoundId]?.name : undefined,
  )
  const clipLabel = clip.fxData?.type === 'filter'
    ? `Filter ${clip.fxData.filter.toUpperCase()}`
    : clip.fxData?.type === 'blur-sticker'
    ? 'Blur sticker'
    : clip.compoundId
      ? (compoundName ?? 'Compound clip')
      : clip.textData
        ? clip.textData.content.slice(0, 28)
        : (asset?.name ?? 'Clip')
  const audioClipHeight = heightPx - 8
  const canAdjustClipVolume =
    !clip.muted &&
    (kind === 'audio' || kind === 'video') &&
    ((asset?.waveformPeaks?.length ?? 0) >= 2 || !!clip.compoundId)
  const volumeDb = volumeToDb(clip.volume)
  const volumeBoosted = volumeDb > NORMAL_VOLUME_DB + 0.05
  const videoWaveHeight = Math.min(34, Math.max(24, audioClipHeight * 0.34))
  const videoWaveTop = Math.max(18, audioClipHeight - videoWaveHeight - 2)
  const volumeLineTop = kind === 'video' ? Math.max(16, videoWaveTop - 10) : 4
  const volumeNormalY =
    kind === 'video'
      ? Math.min(audioClipHeight - 4, videoWaveTop + 1)
      : Math.min(audioClipHeight - 8, Math.max(18, audioClipHeight * 0.36))
  const volumeLineBottom =
    kind === 'video' ? audioClipHeight - 2 : Math.max(volumeNormalY + 6, audioClipHeight - 4)
  const volumeLineY =
    volumeDb <= NORMAL_VOLUME_DB
      ? volumeNormalY +
        ((NORMAL_VOLUME_DB - volumeDb) / (NORMAL_VOLUME_DB - MIN_VOLUME_DB)) *
          (volumeLineBottom - volumeNormalY)
      : volumeNormalY -
        ((volumeDb - NORMAL_VOLUME_DB) / (MAX_VOLUME_DB - NORMAL_VOLUME_DB)) *
          (volumeNormalY - volumeLineTop)

  const volumeDbFromY = useCallback(
    (clientY: number, root: HTMLElement) => {
      const rect = root.getBoundingClientRect()
      const y = Math.max(volumeLineTop, Math.min(volumeLineBottom, clientY - rect.top))
      if (y <= volumeNormalY) {
        const t = (volumeNormalY - y) / Math.max(1, volumeNormalY - volumeLineTop)
        return NORMAL_VOLUME_DB + t * (MAX_VOLUME_DB - NORMAL_VOLUME_DB)
      }
      const t = (y - volumeNormalY) / Math.max(1, volumeLineBottom - volumeNormalY)
      return NORMAL_VOLUME_DB - t * (NORMAL_VOLUME_DB - MIN_VOLUME_DB)
    },
    [volumeLineBottom, volumeLineTop, volumeNormalY],
  )

  const onVolumeLineMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isLocked || !canAdjustClipVolume) return
      e.preventDefault()
      e.stopPropagation()
      const root = e.currentTarget.parentElement
      if (!root) return
      beginHistoryStep()

      const apply = (clientY: number) => {
        setClipVolume(clip.id, dbToVolume(volumeDbFromY(clientY, root)))
      }
      apply(e.clientY)

      function onMove(me: MouseEvent) {
        me.preventDefault()
        apply(me.clientY)
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [beginHistoryStep, canAdjustClipVolume, clip.id, isLocked, setClipVolume, volumeDbFromY],
  )

  // A strip is valid only if it has a real (non-empty) first frame. A `['']`
  // sentinel means strip generation failed → fall back to the single thumbnail.
  const hasStrip = (asset?.thumbnailStrip?.length ?? 0) > 0 && !!asset?.thumbnailStrip?.[0]
  const hasThumb = hasStrip || !!asset?.thumbnailDataUrl

  // A compound clip has no asset of its own, so it would render as a blank block —
  // making split halves look like duplicates instead of two windows of one video.
  // Derive a windowed filmstrip from the compound's primary video child so each
  // half shows its own slice of footage, exactly like splitting a normal clip.
  const compoundTimeline = useTimelineStore((s) =>
    clip.compoundId ? s.compounds[clip.compoundId]?.timeline : undefined,
  )
  const compoundRegistry = useTimelineStore((s) => s.compounds)
  const compoundWaveformPeaks = useMemo(() => {
    if (!clip.compoundId || !compoundTimeline) return null
    let flat = compoundTimeline
    try {
      flat = flattenCompounds(compoundTimeline, compoundRegistry)
    } catch {
      return null
    }
    const byId = new Map(assets.map((candidate) => [candidate.id, candidate]))
    return compoundWindowPeaks(flat, clip.inPointSec, clip.outPointSec, byId)
  }, [
    assets,
    clip.compoundId,
    clip.inPointSec,
    clip.outPointSec,
    compoundRegistry,
    compoundTimeline,
  ])
  const compoundStrip = useMemo(() => {
    if (!clip.compoundId || !compoundTimeline) return null
    const videoTrackIds = new Set(
      compoundTimeline.tracks.filter((t) => t.kind === 'video').map((t) => t.id),
    )
    const children = compoundTimeline.clips
      .filter((c) => videoTrackIds.has(c.trackId) && c.assetId)
      .sort((a, b) => a.startSec - b.startSec)
    for (const child of children) {
      const a = assets.find((x) => x.id === child.assetId)
      const strip = a?.thumbnailStrip
      if (!a || !strip || strip.length === 0 || !strip[0]) continue
      // The compound clip's window [inPoint,outPoint] is in sub-timeline seconds;
      // map it through the child's placement → the child's source seconds.
      const cs = Math.max(0.01, child.speed)
      return {
        strip,
        assetWidth: a.width ?? 1920,
        assetHeight: a.height ?? 1080,
        assetDurationSec: a.durationSec || 1,
        inPointSec: child.inPointSec + (clip.inPointSec - child.startSec) * cs,
        clipDurationSec: (clip.outPointSec - clip.inPointSec) * cs,
      }
    }
    return null
  }, [clip.compoundId, clip.inPointSec, clip.outPointSec, compoundTimeline, assets])

  const [snapping, setSnapping] = useState(false)

  // ── select + drag-to-move (all selected together) ──────────
  const onBodyMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (e.button !== 0) return

      // Modifier click → additive toggle, no drag
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        toggleSelectClip(clip.id)
        return
      }

      // Select this clip (keep multi-selection if already part of it)
      const store = useTimelineStore.getState()
      let ids = store.selectedClipIds

      // Captions move as a linked group (CapCut-style): dragging one caption
      // shifts that caption track, preserving relative timing — unless the user
      // has an explicit multi-selection they're dragging instead. Translated
      // captions live on their own track and stay independent from originals.
      if (isCaptionClip(clip) && ids.length <= 1) {
        const captionIds = captionClipIdsOnTrack(store.timeline.clips, clip.trackId)
        ids = captionIds.length > 1 ? captionIds : [clip.id]
        selectClips(ids)
      } else if (!ids.includes(clip.id)) {
        selectClips([clip.id])
        ids = [clip.id]
      }

      // selectClips expands to whole groups; pick that up so a grouped clip drags
      // with its group (the drag moves every selected clip).
      const expanded = useTimelineStore.getState().selectedClipIds
      if (expanded.length > ids.length) ids = expanded

      if (isLocked) return // locked track → no move

      // Linkage extends the dragged set (without changing the selection) so a
      // video carries only its overlapping text/captions; audio stays independent.
      const { linkEnabled, snapEnabled } = useUIStore.getState()
      const dragIds = linkEnabled
        ? withLinkedClips(ids, store.timeline.clips, store.timeline.tracks)
        : ids
      // Pass the grabbed clip's track as the drag anchor so a multi-track
      // selection keeps its row spacing (offset applied relative to it).
      beginClipDrag(dragIds, clip.trackId)
      const startX = e.clientX
      const startY = e.clientY
      let scrollCompX = 0
      let lastX = e.clientX
      let lastY = e.clientY
      const snapTargets = snapEnabled
        ? collectTimelineSnapTargets(store.timeline.clips, {
            excludeIds: dragIds,
            playheadSec: usePlaybackStore.getState().currentSec,
          })
        : []

      function applyDrag(clientX: number, clientY: number) {
        const rawDelta = (clientX - startX + scrollCompX) / zoom
        const rawDeltaY = clientY - startY
        const snap = snapEnabled
          ? snapTimelineRangeStart(clip.startSec + rawDelta, durationSec, snapTargets, zoom)
          : { startSec: clip.startSec + rawDelta, guideSec: null }
        const snappedDelta = snap.startSec - clip.startSec
        setSnapping(snap.guideSec != null)
        setTimelineSnapGuideSec(snap.guideSec)
        setClipDragDelta(snappedDelta, rawDeltaY)
        const drop = resolveDropTarget(clientX, clientY, clip.trackId)
        setClipDragTargetTrack(drop.trackId)
        setClipDragCreateKind(drop.createKind)
      }

      function onMove(me: MouseEvent) {
        lastX = me.clientX
        lastY = me.clientY
        pendingMove = true
        if (pointerRaf === 0) {
          pointerRaf = requestAnimationFrame(() => {
            pointerRaf = 0
            if (!pendingMove) return
            pendingMove = false
            applyDrag(lastX, lastY)
          })
        }
      }

      let pointerRaf = 0
      let pendingMove = false
      let rafId: number
      function autoScrollFrame() {
        const el = document.querySelector<HTMLElement>('[data-timeline-scroll]')
        if (el) {
          const rect = el.getBoundingClientRect()
          const EDGE = 80, MAX_SPEED = 15
          const distL = lastX - rect.left
          const distR = rect.right - lastX
          let speed = 0
          if (distL < EDGE && distL >= 0) speed = -(1 - distL / EDGE) * MAX_SPEED
          else if (distR < EDGE && distR >= 0) speed = (1 - distR / EDGE) * MAX_SPEED
          if (speed !== 0) {
            const maxScroll = el.scrollWidth - el.clientWidth
            const before = el.scrollLeft
            el.scrollLeft = Math.max(0, Math.min(maxScroll, before + speed))
            const actual = el.scrollLeft - before
            if (actual !== 0) {
              scrollCompX += actual
              applyDrag(lastX, lastY)
            }
          }
        }
        rafId = requestAnimationFrame(autoScrollFrame)
      }
      rafId = requestAnimationFrame(autoScrollFrame)

      function onUp() {
        cancelAnimationFrame(rafId)
        if (pointerRaf !== 0) cancelAnimationFrame(pointerRaf)
        if (pendingMove) applyDrag(lastX, lastY)
        commitClipDrag()
        setSnapping(false)
        setTimelineSnapGuideSec(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [
      clip,
      zoom,
      isLocked,
      selectClips,
      toggleSelectClip,
      beginClipDrag,
      setClipDragDelta,
      setClipDragTargetTrack,
      setClipDragCreateKind,
      commitClipDrag,
      durationSec,
      setTimelineSnapGuideSec,
    ],
  )

  // ── left trim (drag the left edge) ─────────────────────────
  const onLeftMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isLocked) return
      selectClips([clip.id])
      beginHistoryStep()

      // Capture originals once → every move computes an absolute target.
      const startX = e.clientX
      const origStart = clip.startSec
      const origIn = clip.inPointSec
      const origOut = clip.outPointSec
      const speed = Math.max(clip.speed, 0.01)
      const origEnd = origStart + (origOut - origIn) / speed
      // Earliest the left edge may go = end of the nearest clip to the left on
      // the same track (so the trim can't overlap a sibling).
      let leftLimit = 0
      for (const c of useTimelineStore.getState().timeline.clips) {
        if (c.id === clip.id || c.trackId !== clip.trackId) continue
        const cEnd = c.startSec + clipEffectiveDuration(c)
        if (cEnd <= origStart + 1e-3) leftLimit = Math.max(leftLimit, cEnd)
      }
      const noSourceDuration = kind === 'text' || !!clip.fxData
      const snapEnabled = useUIStore.getState().snapEnabled
      const snapTargets = snapEnabled
        ? collectTimelineSnapTargets(useTimelineStore.getState().timeline.clips, {
            excludeIds: [clip.id],
            playheadSec: usePlaybackStore.getState().currentSec,
          })
        : []
      // Snap a raw edge to the nearest target (within range), surfacing the
      // guide line + the warning border while a snap is active.
      const snapClamp = (raw: number, lo: number, hi: number): number => {
        if (!snapEnabled) return clampSec(raw, lo, hi)
        const snap = snapTimelineSec(raw, snapTargets, zoom)
        const v = clampSec(snap.sec, lo, hi)
        const guide = snap.guideSec != null && Math.abs(v - snap.sec) < 1e-3 ? snap.guideSec : null
        setSnapping(guide != null)
        setTimelineSnapGuideSec(guide)
        return v
      }

      let scrollCompX = 0
      let lastTrimX = startX

      function applyTrimLeft(clientX: number) {
        const dSec = (clientX - startX + scrollCompX) / zoom
        if (noSourceDuration) {
          const newStart = snapClamp(origStart + dSec, leftLimit, origEnd - MIN_TRIM_SEC)
          const newOut = origIn + (origEnd - newStart) * speed
          trimClipLeftText(clip.id, newStart, newOut)
          return
        }
        const maxIn = origOut - MIN_TRIM_SEC * speed
        const minStart = Math.max(0, leftLimit, origStart - origIn / speed)
        const maxStart = origStart + (maxIn - origIn) / speed
        const newStart = snapClamp(origStart + dSec, minStart, maxStart)
        const newIn = origIn + (newStart - origStart) * speed
        trimClipLeft(clip.id, newStart, newIn)
      }

      function onMove(me: MouseEvent) {
        lastTrimX = me.clientX
        applyTrimLeft(me.clientX)
      }

      let rafId: number
      function autoScrollFrame() {
        const el = document.querySelector<HTMLElement>('[data-timeline-scroll]')
        if (el) {
          const rect = el.getBoundingClientRect()
          const EDGE = 80, MAX_SPEED = 15
          const distL = lastTrimX - rect.left
          const distR = rect.right - lastTrimX
          let speed = 0
          if (distL < EDGE && distL >= 0) speed = -(1 - distL / EDGE) * MAX_SPEED
          else if (distR < EDGE && distR >= 0) speed = (1 - distR / EDGE) * MAX_SPEED
          if (speed !== 0) {
            const maxScroll = el.scrollWidth - el.clientWidth
            const before = el.scrollLeft
            el.scrollLeft = Math.max(0, Math.min(maxScroll, before + speed))
            const actual = el.scrollLeft - before
            if (actual !== 0) {
              scrollCompX += actual
              applyTrimLeft(lastTrimX)
            }
          }
        }
        rafId = requestAnimationFrame(autoScrollFrame)
      }
      rafId = requestAnimationFrame(autoScrollFrame)

      function onUp() {
        cancelAnimationFrame(rafId)
        setSnapping(false)
        setTimelineSnapGuideSec(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [clip.id, clip.trackId, clip.startSec, clip.inPointSec, clip.outPointSec, clip.speed, clip.fxData, kind, zoom, isLocked, selectClips, beginHistoryStep, trimClipLeft, trimClipLeftText, setTimelineSnapGuideSec],
  )

  // ── right trim (drag the right edge) ───────────────────────
  const onRightMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isLocked) return
      selectClips([clip.id])
      beginHistoryStep()

      const startX = e.clientX
      const origStart = clip.startSec
      const origOut = clip.outPointSec
      const origIn = clip.inPointSec
      const speed = Math.max(clip.speed, 0.01)
      const origEnd = origStart + (origOut - origIn) / speed
      // Source length that caps how far the right edge may extend. A compound clip
      // has no asset — its "source" is its sub-timeline, so use that duration;
      // otherwise the trim would be unbounded and dragging past the content makes
      // the compound's filmstrip repeat (looked like the clip got duplicated).
      // Text has no source media → only the neighbour caps how far it extends.
      const maxDur =
        (clip.compoundId ? compoundTimeline?.durationSec : undefined) ??
        asset?.durationSec ??
        Infinity
      // Furthest the right edge may go = start of the nearest clip to the right.
      let rightLimit = Infinity
      for (const c of useTimelineStore.getState().timeline.clips) {
        if (c.id === clip.id || c.trackId !== clip.trackId) continue
        if (c.startSec >= origEnd - 1e-3) rightLimit = Math.min(rightLimit, c.startSec)
      }
      // The clip end (startSec + dur) must not pass the next clip on the track.
      const minEnd = origStart + MIN_TRIM_SEC
      const maxEnd = Math.min(rightLimit, origStart + (maxDur - origIn) / speed)
      const snapEnabled = useUIStore.getState().snapEnabled
      const snapTargets = snapEnabled
        ? collectTimelineSnapTargets(useTimelineStore.getState().timeline.clips, {
            excludeIds: [clip.id],
            playheadSec: usePlaybackStore.getState().currentSec,
          })
        : []

      let scrollCompX = 0
      let lastTrimX = startX

      function applyTrimRight(clientX: number) {
        const dSec = (clientX - startX + scrollCompX) / zoom
        const raw = clampSec(origEnd + dSec, minEnd, maxEnd)
        let newEnd = raw
        if (snapEnabled) {
          const snap = snapTimelineSec(raw, snapTargets, zoom)
          newEnd = clampSec(snap.sec, minEnd, maxEnd)
          const guide = snap.guideSec != null && Math.abs(newEnd - snap.sec) < 1e-3 ? snap.guideSec : null
          setSnapping(guide != null)
          setTimelineSnapGuideSec(guide)
        }
        const newOut = origIn + (newEnd - origStart) * speed
        trimClipRight(clip.id, newOut)
      }

      function onMove(me: MouseEvent) {
        lastTrimX = me.clientX
        applyTrimRight(me.clientX)
      }

      let rafId: number
      function autoScrollFrame() {
        const el = document.querySelector<HTMLElement>('[data-timeline-scroll]')
        if (el) {
          const rect = el.getBoundingClientRect()
          const EDGE = 80, MAX_SPEED = 15
          const distL = lastTrimX - rect.left
          const distR = rect.right - lastTrimX
          let speed = 0
          if (distL < EDGE && distL >= 0) speed = -(1 - distL / EDGE) * MAX_SPEED
          else if (distR < EDGE && distR >= 0) speed = (1 - distR / EDGE) * MAX_SPEED
          if (speed !== 0) {
            const maxScroll = el.scrollWidth - el.clientWidth
            const before = el.scrollLeft
            el.scrollLeft = Math.max(0, Math.min(maxScroll, before + speed))
            const actual = el.scrollLeft - before
            if (actual !== 0) {
              scrollCompX += actual
              applyTrimRight(lastTrimX)
            }
          }
        }
        rafId = requestAnimationFrame(autoScrollFrame)
      }
      rafId = requestAnimationFrame(autoScrollFrame)

      function onUp() {
        cancelAnimationFrame(rafId)
        setSnapping(false)
        setTimelineSnapGuideSec(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [clip.id, clip.compoundId, clip.trackId, clip.startSec, clip.outPointSec, clip.inPointSec, clip.speed, zoom, isLocked, asset?.durationSec, compoundTimeline?.durationSec, selectClips, beginHistoryStep, trimClipRight, setTimelineSnapGuideSec],
  )

  // ── right-click context menu ───────────────────────────────
  const onSpeedHandleMouseDown = useCallback(
    (edge: 'left' | 'right') => (e: React.MouseEvent) => {
      e.stopPropagation()
      if (isLocked) return
      selectClips([clip.id])
      beginHistoryStep()

      const startX = e.clientX
      const origStart = clip.startSec
      const sourceSpan = Math.max(MIN_TRIM_SEC, clip.outPointSec - clip.inPointSec)
      const origDuration = sourceSpan / Math.max(clip.speed, 0.01)
      const origEnd = origStart + origDuration
      const minDuration = sourceSpan / 4
      const maxDuration = sourceSpan / 0.1

      let leftLimit = 0
      let rightLimit = Infinity
      for (const c of useTimelineStore.getState().timeline.clips) {
        if (c.id === clip.id || c.trackId !== clip.trackId) continue
        const cEnd = c.startSec + clipEffectiveDuration(c)
        if (cEnd <= origStart + 1e-3) leftLimit = Math.max(leftLimit, cEnd)
        if (c.startSec >= origEnd - 1e-3) rightLimit = Math.min(rightLimit, c.startSec)
      }

      const snapEnabled = useUIStore.getState().snapEnabled
      const snapTargets = snapEnabled
        ? collectTimelineSnapTargets(useTimelineStore.getState().timeline.clips, {
            excludeIds: [clip.id],
            playheadSec: usePlaybackStore.getState().currentSec,
          })
        : []

      let scrollCompX = 0
      let lastX = startX

      function applySpeedStretch(clientX: number) {
        const dSec = (clientX - startX + scrollCompX) / zoom
        if (edge === 'right') {
          const minEnd = origStart + minDuration
          const maxEnd = Math.min(rightLimit, origStart + maxDuration)
          const result = snapEnabled
            ? snapTimelineSecWithinLimits(origEnd + dSec, snapTargets, zoom, minEnd, maxEnd)
            : { sec: clampSec(origEnd + dSec, minEnd, maxEnd), guideSec: null }
          const newEnd = result.sec
          setSnapping(result.guideSec != null)
          setTimelineSnapGuideSec(result.guideSec)
          setClipSpeedDuration(clip.id, origStart, newEnd - origStart)
          return
        }
        const minStart = Math.max(0, leftLimit, origEnd - maxDuration)
        const maxStart = origEnd - minDuration
        const result = snapEnabled
          ? snapTimelineSecWithinLimits(origStart + dSec, snapTargets, zoom, minStart, maxStart)
          : { sec: clampSec(origStart + dSec, minStart, maxStart), guideSec: null }
        const newStart = result.sec
        setSnapping(result.guideSec != null)
        setTimelineSnapGuideSec(result.guideSec)
        setClipSpeedDuration(clip.id, newStart, origEnd - newStart)
      }

      function onMove(me: MouseEvent) {
        lastX = me.clientX
        applySpeedStretch(me.clientX)
      }

      let rafId: number
      function autoScrollFrame() {
        const el = document.querySelector<HTMLElement>('[data-timeline-scroll]')
        if (el) {
          const rect = el.getBoundingClientRect()
          const EDGE = 80, MAX_SPEED = 15
          const distL = lastX - rect.left
          const distR = rect.right - lastX
          let scrollSpeed = 0
          if (distL < EDGE && distL >= 0) scrollSpeed = -(1 - distL / EDGE) * MAX_SPEED
          else if (distR < EDGE && distR >= 0) scrollSpeed = (1 - distR / EDGE) * MAX_SPEED
          if (scrollSpeed !== 0) {
            const maxScroll = el.scrollWidth - el.clientWidth
            const before = el.scrollLeft
            el.scrollLeft = Math.max(0, Math.min(maxScroll, before + scrollSpeed))
            const actual = el.scrollLeft - before
            if (actual !== 0) {
              scrollCompX += actual
              applySpeedStretch(lastX)
            }
          }
        }
        rafId = requestAnimationFrame(autoScrollFrame)
      }
      rafId = requestAnimationFrame(autoScrollFrame)

      function onUp() {
        cancelAnimationFrame(rafId)
        setSnapping(false)
        setTimelineSnapGuideSec(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [
      clip.id,
      clip.trackId,
      clip.startSec,
      clip.inPointSec,
      clip.outPointSec,
      clip.speed,
      zoom,
      isLocked,
      selectClips,
      beginHistoryStep,
      setClipSpeedDuration,
      setTimelineSnapGuideSec,
    ],
  )

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const mx = e.clientX
      const my = e.clientY

      const store = useTimelineStore.getState()
      // Ensure the right-clicked clip is part of the selection
      const ids = store.selectedClipIds.includes(clip.id) ? store.selectedClipIds : [clip.id]
      if (!store.selectedClipIds.includes(clip.id)) selectClips([clip.id])
      const playhead = usePlaybackStore.getState().currentSec

      const isVideoClip = kind === 'video' && asset?.kind === 'video'
      const isAudioClip = kind === 'audio' || asset?.kind === 'audio'
      const hasAudio = isVideoClip || isAudioClip
      // A scene/fixed-interval split can leave every new segment selected. A
      // context-menu command belongs to the clip that was right-clicked; applying
      // Detach audio to that stale multi-selection silently detached/muted all
      // later siblings although the user asked to detach only part 1. The toolbar
      // remains the explicit multi-selection action.
      const detachableVideoIds = isVideoClip && !clip.muted ? [clip.id] : []
      const restorableVideoIds = isVideoClip && clip.muted ? [clip.id] : []

      // Read the LAST-KNOWN capabilities synchronously — no network round-trip,
      // so the menu opens instantly. Background pollers keep this fresh.
      const caps = getCachedCapabilities()
      const canSeparate = !!caps?.separate

      const items: MenuItem[] = [
        { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => useTimelineStore.getState().cutClips(ids) },
        { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => useTimelineStore.getState().copyClips(ids) },
        {
          label: 'Paste',
          shortcut: 'Ctrl+V',
          disabled: store.clipboard.length === 0,
          onClick: () => useTimelineStore.getState().pasteClips(playhead),
        },
        {
          label: 'Duplicate',
          shortcut: 'Ctrl+D',
          onClick: () => useTimelineStore.getState().duplicateClips(ids),
        },
        { separator: true, label: 'sep1' },
        {
          label: 'Split at playhead',
          shortcut: 'S',
          onClick: () => useTimelineStore.getState().splitClip(clip.id, playhead),
        },
        {
          label: 'Split every N seconds…',
          onClick: () => {
            const input = window.prompt('Split the clip every how many seconds?', '5')
            if (input == null) return
            const n = Number(input.replace(',', '.').trim())
            if (!Number.isFinite(n) || n <= 0) {
              useToastStore.getState().push('Invalid number of seconds', 'error')
              return
            }
            const count = useTimelineStore.getState().splitClipEveryNSeconds(clip.id, n)
            if (count > 0) {
              useToastStore.getState().push(`Split into ${count + 1} clips`, 'success')
            } else if (count < 0) {
              useToastStore
                .getState()
                .push('Clip count exceeds the 2,000 limit — use a longer interval', 'error')
            } else {
              useToastStore.getState().push('The clip is too short to split', 'error')
            }
          },
        },
      ]
      if (isVideoClip) {
        items.push({
          label: 'Split scenes',
          disabled: !caps?.sceneSplit,
          onClick: () => void runSceneSplit(clip.id),
        })
      }

      if (!clip.textData && clip.assetId && (asset?.kind === 'video' || asset?.kind === 'image')) {
        items.push({ separator: true, label: 'sepCrop' })
        items.push({
          label: 'Crop & rotate',
          onClick: () => useUIStore.getState().openCrop(clip.id),
        })
      }

      if (hasAudio) {
        items.push(
          { separator: true, label: 'sepAudio' },
          {
            label: 'Generate captions',
            onClick: () => void runClipTranscription(clip.id),
          },
          {
            label: 'Separate vocals & music',
            disabled: !canSeparate,
            onClick: () => void runVocalSeparation(clip.id, asset?.name ?? 'audio'),
          },
          {
            label: clip.denoise ? 'Disable noise reduction' : 'Reduce noise',
            onClick: () => {
              const turnOn = !clip.denoise
              useTimelineStore.getState().setClipDenoise(clip.id, turnOn ? 'medium' : undefined)
              useToastStore
                .getState()
                .push(turnOn ? 'Noise reduction enabled (Medium)' : 'Noise reduction disabled', 'success')
            },
          },
        )
        if (isVideoClip && restorableVideoIds.length > 0) {
          items.push({
            label: 'Restore audio',
            onClick: () => useTimelineStore.getState().restoreAudios(restorableVideoIds),
          })
        }
        if (isVideoClip && detachableVideoIds.length > 0) {
          items.push({
            label: 'Detach audio',
            onClick: () => useTimelineStore.getState().detachAudios(detachableVideoIds),
          })
        }
      }

      // Preview proxy (video only) — needs server FFmpeg.
      if (isVideoClip && clip.assetId) {
        const aid = clip.assetId
        const hasProxy = isAudioCapableProxyKey(asset?.proxyStorageKey)
        items.push({ separator: true, label: 'sepProxy' })
        if (hasProxy) {
          items.push({ label: 'Delete proxy', onClick: () => void removeProxy(aid) })
        } else {
          const running = isProxyRunning(aid)
          items.push({
            label: running ? 'Creating proxy…' : 'Create proxy (lighter preview)',
            disabled: running || !caps?.export,
            onClick: () => void runProxyGeneration(aid),
          })
        }
      }

      items.push({ separator: true, label: 'sepCompound' })
      if (clip.compoundId) {
        items.push({
          label: 'Open compound',
          onClick: () =>
            useTimelineStore.getState().enterCompound(clip.compoundId!, {
              inPointSec: clip.inPointSec,
              outPointSec: clip.outPointSec,
            }),
        })
        items.push({
          label: 'Unpack compound',
          shortcut: 'Alt+Shift+G',
          onClick: () => useTimelineStore.getState().breakCompound(ids),
        })
      } else {
        items.push({
          label: 'Create compound clip',
          shortcut: 'Alt+G',
          onClick: () => useTimelineStore.getState().createCompound(ids),
        })
      }

      const anyGrouped = ids.some((id) => store.timeline.clips.find((c) => c.id === id)?.groupId)
      if (ids.length >= 2 || anyGrouped) {
        items.push({ separator: true, label: 'sepGroup' })
        if (ids.length >= 2) {
          items.push({
            label: 'Group',
            shortcut: 'Ctrl+G',
            onClick: () => useTimelineStore.getState().groupClips(ids),
          })
        }
        if (anyGrouped) {
          items.push({
            label: 'Ungroup',
            shortcut: 'Ctrl+Shift+G',
            onClick: () => useTimelineStore.getState().ungroupClips(ids),
          })
        }
      }

      items.push(
        { separator: true, label: 'sep2' },
        {
          label: 'Delete',
          shortcut: 'Del',
          danger: true,
          onClick: () => useTimelineStore.getState().removeClips(ids),
        },
      )

      openMenu(mx, my, items)
    },
    [
      clip.id,
      clip.inPointSec,
      clip.outPointSec,
      clip.denoise,
      clip.muted,
      clip.assetId,
      clip.textData,
      clip.compoundId,
      kind,
      asset?.kind,
      asset?.name,
      asset?.proxyStorageKey,
      selectClips,
      openMenu,
    ],
  )

  // ── waveform (CapCut style: filled polygon, mirrored) ──────
  const waveformSvg = useMemo(() => {
    const compoundWindowed = !!clip.compoundId
    const full = compoundWindowed ? compoundWaveformPeaks : asset?.waveformPeaks
    if (clip.muted) return null
    if (!full || full.length < 2 || (kind !== 'audio' && kind !== 'video')) return null

    const assetDur = asset?.durationSec || 1
    const i0 = compoundWindowed
      ? 0
      : Math.max(0, Math.floor((clip.inPointSec / assetDur) * full.length))
    const i1 = compoundWindowed
      ? full.length
      : Math.min(full.length, Math.ceil((clip.outPointSec / assetDur) * full.length))
    const peaks = i1 - i0 >= 2 ? full.slice(i0, i1) : full
    const sortedPeaks = [...peaks].sort((a, b) => a - b)
    const normalizeAt = kind === 'video' ? 0.82 : 0.96
    const maxPeak =
      sortedPeaks[Math.max(0, Math.floor(sortedPeaks.length * normalizeAt) - 1)] ||
      peaks.reduce((m, p) => Math.max(m, p), 0) ||
      1

    const h = heightPx - 8
    const w = Math.max(width, 4)
    const labelH = Math.min(18, Math.max(12, h * 0.34))
    const videoWaveH = Math.min(34, Math.max(24, h * 0.34))
    const waveTop = kind === 'video' ? Math.max(18, h - videoWaveH - 2) : labelH + 1
    const waveBottom = kind === 'video' ? h - 1 : h - 3
    const waveH = Math.max(6, waveBottom - waveTop)
    const stepPx = kind === 'video' ? 2.4 : 2.5
    const n = Math.min(1800, Math.max(4, Math.ceil(w / stepPx)))
    const gap = w / n
    const barW = Math.max(1, Math.min(kind === 'video' ? 1.35 : 1.25, gap * 0.56))

    // Sample evenly — ~1 point per 1.5 px looks smooth
    const sampled: number[] = Array.from({ length: n }, (_, i) => {
      if (kind === 'video') {
        const pos = n <= 1 ? 0 : (i / (n - 1)) * (peaks.length - 1)
        const leftIdx = Math.max(0, Math.min(peaks.length - 1, Math.floor(pos)))
        const rightIdx = Math.max(0, Math.min(peaks.length - 1, leftIdx + 1))
        const t = pos - leftIdx
        const leftPeak = peaks[leftIdx] ?? 0
        const rightPeak = peaks[rightIdx] ?? leftPeak
        const interpolated = leftPeak + (rightPeak - leftPeak) * t
        const localEnvelope = Math.max(leftPeak, rightPeak) * 0.62
        return Math.max(interpolated, localEnvelope)
      }

      const start = Math.floor((i / n) * peaks.length)
      const end = Math.max(start + 1, Math.ceil(((i + 1) / n) * peaks.length))
      let peak = 0
      for (let j = start; j < Math.min(end, peaks.length); j++) {
        peak = Math.max(peak, peaks[j] ?? 0)
      }
      return peak
    })

    const blueBars: string[] = []
    const boostBars: string[] = []
    sampled.forEach((p, i) => {
      const prev = sampled[Math.max(0, i - 1)] ?? p
      const next = sampled[Math.min(sampled.length - 1, i + 1)] ?? p
      const smoothed = p * 0.6 + prev * 0.2 + next * 0.2
      const amp = Math.min(1, smoothed / maxPeak)
      const shapedAmp = Math.pow(amp, kind === 'video' ? 0.38 : 0.72)
      const minAmp = kind === 'video' ? (amp > 0.01 ? 0.34 : 0.12) : 0.06
      const visibleAmp = clip.volume > 0 ? Math.max(minAmp, shapedAmp) : 0
      const scaledH = Math.min(waveH, visibleAmp * clip.volume * waveH)
      const normalH = Math.min(scaledH, visibleAmp * waveH)
      const boostedH = Math.max(0, scaledH - normalH)
      const x = Math.min(w - barW, i * gap)
      const blueY = waveBottom - normalH
      const orangeY = blueY - boostedH
      if (normalH > 0) {
        blueBars.push(
          `<rect x="${x.toFixed(1)}" y="${blueY.toFixed(1)}" width="${barW.toFixed(1)}" height="${normalH.toFixed(1)}" rx="0.5"/>`,
        )
      }
      if (boostedH > 0.4) {
        boostBars.push(
          `<rect x="${x.toFixed(1)}" y="${orangeY.toFixed(1)}" width="${barW.toFixed(1)}" height="${boostedH.toFixed(1)}" rx="0.5"/>`,
        )
      }
    })

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<rect x="0" y="${waveTop}" width="${w}" height="${waveH}" fill="#06213a" opacity="0.75"/>` +
      (kind === 'video'
        ? `<rect x="0" y="${(waveTop + waveH * 0.42).toFixed(1)}" width="${w}" height="${(waveH * 0.58).toFixed(1)}" fill="#00a8ff" opacity="0.12"/>`
        : '') +
      `<g fill="#00a8ff" opacity="0.95">${blueBars.join('')}</g>` +
      `<g fill="#ff7a1a" opacity="0.95">${boostBars.join('')}</g>` +
      `</svg>`
    )
  }, [
    asset?.durationSec,
    asset?.waveformPeaks,
    clip.compoundId,
    clip.inPointSec,
    clip.muted,
    clip.outPointSec,
    clip.volume,
    compoundWaveformPeaks,
    kind,
    heightPx,
    width,
  ])

  // Outer ring lives on the container (never covered by thumbnails): a dark
  // outline separates adjacent clips; selection adds a cyan outline + glow.
  const outerRing = isSelected
    ? '0 0 0 1.5px var(--timeline-accent), 0 0 9px 1px rgba(0,216,214,0.6)'
    : snapping
      ? '0 0 0 1.5px var(--warning), 0 0 0 1px rgba(0,0,0,0.65)'
      : '0 0 0 1px rgba(0,0,0,0.65)'

  // Inner ring is drawn by a top overlay div so it sits ABOVE the thumbnail
  // strip (an inset box-shadow on the container would be hidden behind it).
  // Normal clips keep only a very faint edge — the dark outer outline does the
  // real separating, so the inner line stays soft and easy on the eyes.
  const innerRing = isSelected
    ? 'inset 0 0 0 2px var(--timeline-accent)'
    : snapping
      ? 'inset 0 0 0 2px var(--warning)'
      : 'inset 0 0 0 1px rgba(255,255,255,0.07)'

  return (
    <div
      onMouseDown={onBodyMouseDown}
      onDoubleClick={() => {
        if (clip.compoundId)
          useTimelineStore.getState().enterCompound(clip.compoundId, {
            inPointSec: clip.inPointSec,
            outPointSec: clip.outPointSec,
          })
      }}
      onContextMenu={onContextMenu}
      className={`group absolute top-1 overflow-hidden rounded-md select-none ${
        isLocked ? 'cursor-default opacity-80' : 'cursor-grab active:cursor-grabbing'
      } ${bgCls}`}
      style={{
        left,
        width,
        height: heightPx - 8,
        transform:
          rippleShiftPx || dragDeltaYPx
            ? `translate(${rippleShiftPx}px, ${dragDeltaYPx}px)`
            : undefined,
        // Glide non-dragged clips to their rippled slot in real time (compositor
        // transform → cheap even with many scene-split segments).
        transition: rippleShiftPx ? 'transform 0.12s ease-out' : undefined,
        zIndex: isDragging ? 30 : undefined,
        boxShadow: outerRing,
      }}
      title={asset?.name ?? clip.textData?.content ?? clipLabel}
    >
      {/* Compound: windowed filmstrip from its primary video child, so split
          halves show different footage instead of looking duplicated. */}
      {clip.compoundId && compoundStrip && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <VideoThumbnailStrip
            strip={compoundStrip.strip}
            assetWidth={compoundStrip.assetWidth}
            assetHeight={compoundStrip.assetHeight}
            assetDurationSec={compoundStrip.assetDurationSec}
            inPointSec={compoundStrip.inPointSec}
            clipDurationSec={compoundStrip.clipDurationSec}
            clipWidthPx={width}
            clipHeightPx={heightPx - 8}
            clipLeftPx={left}
            scrollLeft={scrollLeft}
            viewportWidth={viewportWidth}
          />
        </div>
      )}

      {/* Video: per-frame strip using thumbnailStrip array (viewport-virtualized). */}
      {kind === 'video' && hasStrip && asset?.thumbnailStrip && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <VideoThumbnailStrip
            strip={asset.thumbnailStrip}
            assetWidth={asset.width ?? 1920}
            assetHeight={asset.height ?? 1080}
            assetDurationSec={asset.durationSec || 1}
            inPointSec={clip.inPointSec}
            clipDurationSec={durationSec}
            clipWidthPx={width}
            clipHeightPx={heightPx - 8}
            clipLeftPx={left}
            scrollLeft={scrollLeft}
            viewportWidth={viewportWidth}
          />
        </div>
      )}

      {/* Video fallback: single thumbnail tiled while the strip is generating */}
      {kind === 'video' && !hasStrip && asset?.thumbnailDataUrl && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: `url(${asset.thumbnailDataUrl})`,
            backgroundRepeat: 'repeat-x',
            backgroundSize: 'auto 100%',
            opacity: 0.85,
          }}
        />
      )}

      {/* Dark scrim at top so the file-name label reads over thumbnails */}
      {kind === 'video' && hasThumb && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7"
          style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, transparent 100%)' }}
        />
      )}

      {/* Frame separator lines */}
      {kind === 'video' && hasThumb && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: 'linear-gradient(to right, rgba(0,0,0,0.25) 1px, transparent 1px)',
            backgroundSize: `${Math.round((heightPx - 8) * ((asset?.width ?? 16) / (asset?.height ?? 9)))}px 100%`,
          }}
        />
      )}

      {/* Audio waveform — CapCut style filled polygon */}
      {waveformSvg && (
        <div
          className="pointer-events-none absolute inset-0"
          dangerouslySetInnerHTML={{ __html: waveformSvg }}
        />
      )}

      {canAdjustClipVolume && (
        <div
          className="absolute inset-x-0 z-30 -translate-y-1/2 cursor-ns-resize px-1"
          style={{ top: volumeLineY }}
          onMouseDown={onVolumeLineMouseDown}
          title={`Volume ${volumeDb.toFixed(1)}dB`}
        >
          <div
            className="h-3"
            style={{
              background:
                'linear-gradient(to bottom, transparent 0, transparent 5px, currentColor 5px, currentColor 6px, transparent 6px)',
              color: volumeBoosted ? '#ff7a1a' : '#e5e7eb',
            }}
          />
          <span
            className="absolute right-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ring-1 ring-black/70"
            style={{ background: volumeBoosted ? '#ff7a1a' : '#e5e7eb' }}
          />
        </div>
      )}

      {/* Text clip — amber left stripe */}
      {kind === 'text' && (
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-track-text" />
      )}

      {/* Compound clip — distinct accent fill so it reads as one nested unit */}
      {clip.compoundId && (
        <>
          <div className="pointer-events-none absolute inset-0 bg-accent/15" />
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-accent" />
        </>
      )}

      {/* Keyframe markers — one ◇ per distinct keyframe time (across all props),
          so adding a keyframe shows up on the clip (CapCut-style). */}
      {clip.keyframes &&
        [...new Set(Object.values(clip.keyframes).flat().map((k) => k.t))].map((t) => (
          <span
            key={t}
            className="pointer-events-none absolute bottom-0.5 z-20 h-2 w-2 -translate-x-1/2 rotate-45 border border-black/60 bg-white"
            style={{ left: Math.max(0, Math.min(width, t * zoom)) }}
          />
        ))}

      {/* Label + speed badge */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-1 px-1.5 py-0.5">
        <span
          className="truncate text-2xs font-medium text-white/95"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
        >
          {clipLabel}
        </span>
        {clip.muted && (
          <span className="ml-1 shrink-0 rounded bg-black/40 px-0.5 text-2xs text-text-2">muted</span>
        )}
        {clip.speed !== 1 && (
          <span className="ml-auto shrink-0 rounded bg-black/50 px-0.5 text-2xs text-white">
            {clip.speed}x
          </span>
        )}
        {(clip.effects?.length ?? 0) > 0 && (
          <span
            className={`shrink-0 rounded px-0.5 text-2xs font-bold text-black ${
              clip.speed === 1 ? 'ml-auto' : 'ml-1'
            }`}
            style={{ background: 'var(--timeline-accent)' }}
          >
            FX
          </span>
        )}
        {clip.fxData && (
          <span
            className={`shrink-0 rounded px-0.5 text-2xs font-bold text-black ${
              clip.speed === 1 && (clip.effects?.length ?? 0) === 0 ? 'ml-auto' : 'ml-1'
            }`}
            style={{ background: 'var(--timeline-accent)' }}
          >
            FX
          </span>
        )}
      </div>

      {/* Inner border overlay — sits above thumbnails so the edge stays visible */}
      <div
        className="pointer-events-none absolute inset-0 z-30 rounded-md"
        style={{ boxShadow: innerRing }}
      />

      {/* Grouped marker: a small dot so it's clear the clip belongs to a group. */}
      {clip.groupId && (
        <span
          className="pointer-events-none absolute right-1 top-1 z-30 h-2 w-2 rounded-full bg-accent ring-1 ring-black/50"
          title="Grouped clip"
        />
      )}

      {/* Trim handles — hidden on clips too narrow to leave a body grab zone, so
          a short clip stays fully draggable for moving (zoom in to trim it). */}
      {showSpeedHandles && (
        <>
          <div
            onMouseDown={onSpeedHandleMouseDown('left')}
            className="absolute -left-1 top-1/2 z-50 grid h-7 w-4 -translate-y-1/2 cursor-ew-resize place-items-center"
            onClick={(e) => e.stopPropagation()}
            title="Speed stretch start"
          >
            <span className="h-0 w-0 border-y-[6px] border-r-[8px] border-y-transparent border-r-white drop-shadow" />
          </div>
          <div
            onMouseDown={onSpeedHandleMouseDown('right')}
            className="absolute -right-1 top-1/2 z-50 grid h-7 w-4 -translate-y-1/2 cursor-ew-resize place-items-center"
            onClick={(e) => e.stopPropagation()}
            title="Speed stretch end"
          >
            <span className="h-0 w-0 border-y-[6px] border-l-[8px] border-y-transparent border-l-white drop-shadow" />
          </div>
        </>
      )}

      {showHandles && !showSpeedHandles && (
        <>
          {/* Left trim handle */}
          <div
            onMouseDown={onLeftMouseDown}
            style={{ width: handleW }}
            className="absolute left-0 top-0 z-40 flex h-full cursor-ew-resize justify-start bg-transparent hover:bg-white/10"
            onClick={(e) => e.stopPropagation()}
            title="Trim start"
          >
            <span
              className={`h-full w-1 rounded-l-md bg-white/80 transition-opacity ${
                isSelected ? 'opacity-80' : 'opacity-0 group-hover:opacity-60'
              }`}
            />
          </div>
          {/* Right trim handle */}
          <div
            onMouseDown={onRightMouseDown}
            style={{ width: handleW }}
            className="absolute right-0 top-0 z-40 flex h-full cursor-ew-resize justify-end bg-transparent hover:bg-white/10"
            onClick={(e) => e.stopPropagation()}
            title="Trim end"
          >
            <span
              className={`h-full w-1 rounded-r-md bg-white/80 transition-opacity ${
                isSelected ? 'opacity-80' : 'opacity-0 group-hover:opacity-60'
              }`}
            />
          </div>
        </>
      )}
    </div>
  )
})
