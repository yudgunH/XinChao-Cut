import { useCallback, useMemo, useState } from 'react'

import {
  captionClipIdsOnTrack,
  clipEffectiveDuration,
  isCaptionClip,
  type Clip,
  type Track,
  type TrackKind,
} from '@engine/timeline'
import { getCachedCapabilities } from '@engine/backend'
import { runVocalSeparation } from '@engine/audio/separation-runner'
import { isProxyRunning, removeProxy, runProxyGeneration } from '@engine/media/proxy-runner'
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
} from './timeline-snap'

interface TimelineClipProps {
  clip: Clip
  zoom: number
  heightPx: number
}

/**
 * Linkage: when dragging video clip(s), also carry every audio/text clip that
 * overlaps their time span (CapCut "link") — so a video's captions and audio
 * move with it. Returns the original ids unchanged when nothing is a video clip
 * (dragging audio/captions alone doesn't pull the video).
 */
function withLinkedClips(baseIds: string[], clips: Clip[], tracks: Track[]): string[] {
  const kindOf = (trackId: string) => tracks.find((t) => t.id === trackId)?.kind
  const videoRanges = baseIds
    .map((id) => clips.find((c) => c.id === id))
    .filter((c): c is Clip => !!c && kindOf(c.trackId) === 'video')
    .map((c) => [c.startSec, c.startSec + clipEffectiveDuration(c)] as const)
  if (videoRanges.length === 0) return baseIds

  const linked = new Set(baseIds)
  for (const c of clips) {
    const k = kindOf(c.trackId)
    if (k !== 'audio' && k !== 'text') continue
    const cs = c.startSec
    const ce = c.startSec + clipEffectiveDuration(c)
    if (videoRanges.some(([vs, ve]) => cs < ve && ce > vs)) linked.add(c.id)
  }
  return [...linked]
}

const KIND_BG: Record<string, string> = {
  video: 'bg-[#111827]',
  // CapCut-style: dark green background for audio
  audio: 'bg-[#0c2318]',
  text: 'bg-[#2a2a31] hover:bg-[#34343d]',
  fx: 'bg-gradient-to-b from-[#3b1d57] to-[#2d1a45]',
}

// Per-frame thumbnail strip rendered as individual positioned slots
function VideoThumbnailStrip({
  strip,
  assetWidth,
  assetHeight,
  assetDurationSec,
  inPointSec,
  clipDurationSec,
  clipWidthPx,
  clipHeightPx,
}: {
  strip: string[]
  assetWidth: number
  assetHeight: number
  assetDurationSec: number
  inPointSec: number
  clipDurationSec: number
  clipWidthPx: number
  clipHeightPx: number
}) {
  const aspect = assetWidth && assetHeight ? assetWidth / assetHeight : 16 / 9
  const frameW = Math.round(clipHeightPx * aspect)
  // Guard: frameW=0 (clipHeightPx=0) would give Infinity slots → RangeError crash
  if (frameW <= 0) return null
  const numSlots = Math.ceil(clipWidthPx / frameW) + 1

  return (
    <>
      {Array.from({ length: numSlots }).map((_, i) => {
        // Source time at the left edge of this slot
        const slotX = i * frameW
        const srcSec = inPointSec + (slotX / clipWidthPx) * clipDurationSec
        const t = Math.max(0, Math.min(srcSec / assetDurationSec, 1))
        const stripIdx = Math.round(t * (strip.length - 1))
        const src = strip[Math.max(0, Math.min(strip.length - 1, stripIdx))]
        if (!src) return null
        return (
          <div
            key={i}
            className="absolute top-0 overflow-hidden"
            style={{ left: slotX, width: frameW + 1, height: clipHeightPx }}
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

export function TimelineClip({ clip, zoom, heightPx }: TimelineClipProps) {
  const assets = useProjectStore((s) => s.assets)
  const isSelected = useTimelineStore((s) => s.selectedClipIds.includes(clip.id))
  const selectClips = useTimelineStore((s) => s.selectClips)
  const toggleSelectClip = useTimelineStore((s) => s.toggleSelectClip)
  const setTimelineSnapGuideSec = useUIStore((s) => s.setTimelineSnapGuideSec)
  const trimClipLeft = useTimelineStore((s) => s.trimClipLeft)
  const trimClipLeftText = useTimelineStore((s) => s.trimClipLeftText)
  const trimClipRight = useTimelineStore((s) => s.trimClipRight)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)
  const beginClipDrag = useTimelineStore((s) => s.beginClipDrag)
  const setClipDragDelta = useTimelineStore((s) => s.setClipDragDelta)
  const setClipDragTargetTrack = useTimelineStore((s) => s.setClipDragTargetTrack)
  const setClipDragCreateKind = useTimelineStore((s) => s.setClipDragCreateKind)
  const commitClipDrag = useTimelineStore((s) => s.commitClipDrag)
  const openMenu = useContextMenuStore((s) => s.openMenu)
  const track = useTimelineStore((s) => s.timeline.tracks.find((t) => t.id === clip.trackId))
  const asset = assets.find((a) => a.id === clip.assetId)

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
  const width = Math.max(durationSec * zoom, 4)
  const kind = track?.kind ?? 'video'
  const bgCls = KIND_BG[kind] ?? KIND_BG['video']!
  const clipLabel = clip.fxData?.type === 'blur-sticker'
    ? 'Blur sticker'
    : clip.textData
      ? clip.textData.content.slice(0, 28)
      : (asset?.name ?? 'Clip')

  // A strip is valid only if it has a real (non-empty) first frame. A `['']`
  // sentinel means strip generation failed → fall back to the single thumbnail.
  const hasStrip = (asset?.thumbnailStrip?.length ?? 0) > 0 && !!asset?.thumbnailStrip?.[0]
  const hasThumb = hasStrip || !!asset?.thumbnailDataUrl

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

      if (isLocked) return // locked track → no move

      // Linkage extends the dragged set (without changing the selection) so a
      // video carries its overlapping captions/audio.
      const { linkEnabled, snapEnabled } = useUIStore.getState()
      const dragIds = linkEnabled
        ? withLinkedClips(ids, store.timeline.clips, store.timeline.tracks)
        : ids
      beginClipDrag(dragIds)
      const startX = e.clientX
      const startY = e.clientY
      const snapTargets = snapEnabled
        ? collectTimelineSnapTargets(store.timeline.clips, {
            excludeIds: dragIds,
            playheadSec: usePlaybackStore.getState().currentSec,
          })
        : []

      function onMove(me: MouseEvent) {
        const rawDelta = (me.clientX - startX) / zoom
        const rawDeltaY = me.clientY - startY
        const snap = snapEnabled
          ? snapTimelineRangeStart(clip.startSec + rawDelta, durationSec, snapTargets, zoom)
          : { startSec: clip.startSec + rawDelta, guideSec: null }
        const snappedStart = snap.startSec
        const snappedDelta = snappedStart - clip.startSec
        setSnapping(snap.guideSec != null)
        setTimelineSnapGuideSec(snap.guideSec)
        setClipDragDelta(snappedDelta, rawDeltaY)
        const drop = resolveDropTarget(me.clientX, me.clientY, clip.trackId)
        setClipDragTargetTrack(drop.trackId)
        setClipDragCreateKind(drop.createKind)
      }
      function onUp() {
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

      function onMove(me: MouseEvent) {
        const dSec = (me.clientX - startX) / zoom // timeline seconds dragged
        if (noSourceDuration) {
          // Text/FX have no source: the left edge keeps the right edge fixed and
          // grows/shrinks the duration. Clamp to the neighbour and min length.
          const newStart = snapClamp(origStart + dSec, leftLimit, origEnd - MIN_TRIM_SEC)
          const newOut = origIn + (origEnd - newStart) * speed // grow duration
          trimClipLeftText(clip.id, newStart, newOut)
          return
        }
        // Video/audio: shift the source in-point; right edge (outPoint) stays.
        const maxIn = origOut - MIN_TRIM_SEC * speed
        const minStart = Math.max(0, leftLimit, origStart - origIn / speed)
        const maxStart = origStart + (maxIn - origIn) / speed
        const newStart = snapClamp(origStart + dSec, minStart, maxStart)
        const newIn = origIn + (newStart - origStart) * speed
        trimClipLeft(clip.id, newStart, newIn)
      }
      function onUp() {
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
      // Text has no source media → only the neighbour caps how far it extends.
      const maxDur = asset?.durationSec ?? Infinity
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

      function onMove(me: MouseEvent) {
        const dSec = (me.clientX - startX) / zoom
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
      function onUp() {
        setSnapping(false)
        setTimelineSnapGuideSec(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [clip.id, clip.trackId, clip.startSec, clip.outPointSec, clip.inPointSec, clip.speed, zoom, isLocked, asset?.durationSec, selectClips, beginHistoryStep, trimClipRight, setTimelineSnapGuideSec],
  )

  // ── right-click context menu ───────────────────────────────
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
      ]
      if (isVideoClip) {
        items.push({
          label: 'Split scenes',
          disabled: !caps?.sceneSplit,
          onClick: () => void runSceneSplit(clip.id),
        })
      }

      if (hasAudio) {
        items.push(
          { separator: true, label: 'sepAudio' },
          {
            label: 'Tạo phụ đề',
            onClick: () => void runClipTranscription(clip.id),
          },
          {
            label: 'Tách giọng & nhạc',
            disabled: !canSeparate,
            onClick: () => void runVocalSeparation(clip.id, asset?.name ?? 'audio'),
          },
          {
            label: clip.denoise ? 'Tắt giảm noise' : 'Giảm noise',
            onClick: () => {
              const turnOn = !clip.denoise
              useTimelineStore.getState().setClipDenoise(clip.id, turnOn ? 'medium' : undefined)
              useToastStore
                .getState()
                .push(turnOn ? 'Đã bật giảm noise (Medium)' : 'Đã tắt giảm noise', 'success')
            },
          },
        )
        if (isVideoClip && !clip.muted) {
          items.push({
            label: 'Tách audio',
            onClick: () => useTimelineStore.getState().detachAudio(clip.id),
          })
        }
      }

      // Preview proxy (video only) — needs server FFmpeg.
      if (isVideoClip && clip.assetId) {
        const aid = clip.assetId
        const hasProxy = !!asset?.proxyStorageKey
        items.push({ separator: true, label: 'sepProxy' })
        if (hasProxy) {
          items.push({ label: 'Xóa proxy', onClick: () => void removeProxy(aid) })
        } else {
          const running = isProxyRunning(aid)
          items.push({
            label: running ? 'Đang tạo proxy…' : 'Tạo proxy (preview nhẹ)',
            disabled: running || !caps?.export,
            onClick: () => void runProxyGeneration(aid),
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
      clip.muted,
      clip.denoise,
      clip.assetId,
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
    const full = asset?.waveformPeaks
    if (!full || full.length < 2 || kind !== 'audio') return null

    const assetDur = asset?.durationSec || 1
    const i0 = Math.max(0, Math.floor((clip.inPointSec / assetDur) * full.length))
    const i1 = Math.min(full.length, Math.ceil((clip.outPointSec / assetDur) * full.length))
    const peaks = i1 - i0 >= 2 ? full.slice(i0, i1) : full
    const maxPeak = peaks.reduce((m, p) => Math.max(m, p), 0) || 1

    const h = heightPx - 8
    const w = Math.max(width, 4)
    const mid = h / 2
    const maxHalf = mid - 1.5

    // Sample evenly — ~1 point per 1.5 px looks smooth
    const n = Math.min(peaks.length, Math.max(4, Math.floor(w / 1.5)))
    const sampled: number[] = Array.from({ length: n }, (_, i) => {
      const idx = Math.round((i / (n - 1)) * (peaks.length - 1))
      return peaks[Math.max(0, Math.min(peaks.length - 1, idx))]!
    })

    // Light smoothing pass (3-point average) so the polygon looks polished
    const smoothed = sampled.map((p, i) => {
      const a = sampled[i - 1] ?? p
      const b = sampled[i + 1] ?? p
      return (a + p * 2 + b) / 4
    })

    // Build top polygon points (peaks go up from mid)
    const topPts = smoothed.map((p, i) => {
      const x = (i / (n - 1)) * w
      const y = mid - Math.max(0.5, (p / maxPeak) * maxHalf)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    // Build bottom points (mirror, reversed)
    const botPts = [...smoothed].reverse().map((p, i) => {
      const x = ((n - 1 - i) / (n - 1)) * w
      const y = mid + Math.max(0.5, (p / maxPeak) * maxHalf)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })

    const points = `0,${mid} ${topPts.join(' ')} ${w},${mid} ${botPts.join(' ')}`

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
      `<polygon points="${points}" fill="#4ade80" opacity="0.90"/>` +
      `</svg>`
    )
  }, [asset?.waveformPeaks, asset?.durationSec, clip.inPointSec, clip.outPointSec, kind, heightPx, width])

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
      {/* Video: per-frame strip using thumbnailStrip array */}
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
        <>
          {/* Subtle centre line */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" />
          <div
            className="pointer-events-none absolute inset-0"
            dangerouslySetInnerHTML={{ __html: waveformSvg }}
          />
        </>
      )}

      {/* Text clip — amber left stripe */}
      {kind === 'text' && (
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-track-text" />
      )}

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

      {/* Left trim handle */}
      <div
        onMouseDown={onLeftMouseDown}
        className="absolute left-0 top-0 z-40 flex h-full w-3 cursor-ew-resize justify-start bg-transparent hover:bg-white/10"
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
        className="absolute right-0 top-0 z-40 flex h-full w-3 cursor-ew-resize justify-end bg-transparent hover:bg-white/10"
        onClick={(e) => e.stopPropagation()}
        title="Trim end"
      >
        <span
          className={`h-full w-1 rounded-r-md bg-white/80 transition-opacity ${
            isSelected ? 'opacity-80' : 'opacity-0 group-hover:opacity-60'
          }`}
        />
      </div>
    </div>
  )
}
