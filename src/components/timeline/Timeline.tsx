import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  Clapperboard,
  CopyPlus,
  Crop,
  ArrowLeftToLine,
  Link2,
  Link2Off,
  Magnet,
  MousePointer2,
  RotateCw,
  Plus,
  Redo2,
  RefreshCw,
  Scissors,
  Shield,
  ShieldOff,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
  Type as TypeIcon,
  Undo2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'

import { getCachedCapabilities } from '@engine/backend'
import { runSceneSplit } from '@engine/media/scene-split-runner'
import { clipEffectiveDuration, type Clip, type Track } from '@engine/timeline'
import {
  clampTimelineZoom,
  fitTimelineZoom,
  maxSafeTimelineZoom,
  sliderMinTimelineZoom,
} from '@engine/timeline/zoom'
import { useDesktopMediaImport, useMediaImport } from '@hooks/useMediaImport'
import { useContextMenuStore, type MenuItem } from '@store/context-menu-store'
import { usePlaybackStore } from '@store/playback-store'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'

import { TimelineRuler } from './TimelineRuler'
import { TimelineTrack } from './TimelineTrack'
import { TrackHeader } from './TrackHeader'
import { Playhead } from './Playhead'
import {
  buildClipsByTrack,
  buildTrackLayouts,
  visibleTrackWindow,
} from './track-virtualization'

export const TRACK_HEIGHT: Record<string, number> = {
  text: 46,
  video: 84,
  fx: 54,
  audio: 64,
}

const RULER_H = 26
const HEADER_W = 104
const MARQUEE_HOLD_MS = 160
const MARQUEE_DRAG_THRESHOLD_PX = 4
/** Stable empty list so tracks with no clips keep memo identity. */
const EMPTY_CLIPS: Clip[] = []

interface MarqueeBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface ToolbarButtonProps {
  active?: boolean
  disabled?: boolean
  icon: LucideIcon
  label: string
  onClick?: () => void
}

function ToolbarButton({
  active = false,
  disabled = false,
  icon: Icon,
  label,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded border border-transparent ${
        active
          ? 'border-accent/35 bg-accent/15 text-accent'
          : 'text-text-1/80 hover:border-border-strong hover:bg-bg-3 hover:text-text-1'
      } disabled:cursor-not-allowed disabled:text-text-3/45 disabled:opacity-100 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-text-3/45`}
    >
      <Icon size={14} />
    </button>
  )
}

function ToolbarDivider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border-strong/80" />
}

// Slider range is duration-aware: its left edge always includes "fit all" and
// its right edge never creates a CSS box wider than the WebView-safe ceiling.
const zoomToSlider = (z: number, minZoom: number, maxZoom: number) => {
  if (maxZoom <= minZoom) return 0
  const raw = (Math.log(z / minZoom) / Math.log(maxZoom / minZoom)) * 1000
  return Math.round(Math.max(0, Math.min(1000, raw)))
}
const sliderToZoom = (v: number, minZoom: number, maxZoom: number) =>
  minZoom * Math.pow(maxZoom / minZoom, v / 1000)

export function Timeline() {
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const clipEndSec = useMemo(
    () => clips.reduce(
      (max, clip) => Math.max(max, clip.startSec + clipEffectiveDuration(clip)),
      0,
    ),
    [clips],
  )
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const markedTrackIds = useTimelineStore((s) => s.selectedTrackIds)
  const durationSec = useTimelineStore((s) => s.timeline.durationSec)
  const requestedZoom = useTimelineStore((s) => s.zoom)
  const zoom = clampTimelineZoom(requestedZoom, clipEndSec)
  const setZoom = useTimelineStore((s) => s.setZoom)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const snapGuideSec = useUIStore((s) => s.timelineSnapGuideSec)
  const toggleSnap = useUIStore((s) => s.toggleSnap)
  const linkEnabled = useUIStore((s) => s.linkEnabled)
  const toggleLink = useUIStore((s) => s.toggleLink)
  const magneticMainTrack = useUIStore((s) => s.magneticMainTrack)
  const toggleMagneticMainTrack = useUIStore((s) => s.toggleMagneticMainTrack)
  const collapseMainVideoTrack = useTimelineStore((s) => s.collapseMainVideoTrack)
  const selectClips = useTimelineStore((s) => s.selectClips)
  const selectTracks = useTimelineStore((s) => s.selectTracks)
  const toggleSelectTrack = useTimelineStore((s) => s.toggleSelectTrack)
  const insertTextClip = useTimelineStore((s) => s.insertTextClip)
  const removeClips = useTimelineStore((s) => s.removeClips)
  const duplicateClips = useTimelineStore((s) => s.duplicateClips)
  const splitClips = useTimelineStore((s) => s.splitClips)
  const trimClipsLeftTo = useTimelineStore((s) => s.trimClipsLeftTo)
  const trimClipsRightTo = useTimelineStore((s) => s.trimClipsRightTo)
  const setClipsMuted = useTimelineStore((s) => s.setClipsMuted)
  const setTracksLocked = useTimelineStore((s) => s.setTracksLocked)
  const resetClipTransforms = useTimelineStore((s) => s.resetClipTransforms)
  const rotateClips = useTimelineStore((s) => s.rotateClips)
  const flipClips = useTimelineStore((s) => s.flipClips)
  const openMenu = useContextMenuStore((s) => s.openMenu)
  const openCrop = useUIStore((s) => s.openCrop)
  const compoundStack = useTimelineStore((s) => s.compoundStack)
  const exitCompound = useTimelineStore((s) => s.exitCompound)
  const detachAudios = useTimelineStore((s) => s.detachAudios)
  const undo = useTimelineStore((s) => s.undo)
  const redo = useTimelineStore((s) => s.redo)
  const canUndo = useTimelineStore((s) => s.canUndo)
  const canRedo = useTimelineStore((s) => s.canRedo)
  const assets = useProjectStore((s) => s.assets)
  const seek = usePlaybackStore((s) => s.seek)
  // Do NOT subscribe to currentSec — that re-renders this whole tree ~60fps while
  // playing. Handlers that need the playhead read getState().currentSec at click time.
  const importFiles = useMediaImport()
  const desktopImport = useDesktopMediaImport()

  const scrollRef = useRef<HTMLDivElement>(null)
  const tracksRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const prevDurationRef = useRef(durationSec)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerWidth, setContainerWidth] = useState(800)
  const [containerHeight, setContainerHeight] = useState(400)
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)
  const maxZoom = maxSafeTimelineZoom(clipEndSec)
  const minZoom = sliderMinTimelineZoom(clipEndSec, containerWidth)
  // Coalesce high-frequency scrollLeft into one React state update per frame so
  // every track does not re-render multiple times per wheel/trackpad tick.
  const pendingScrollLeft = useRef(0)
  const scrollLeftRaf = useRef(0)

  useEffect(() => {
    if (Math.abs(requestedZoom - zoom) > 1e-12) setZoom(zoom)
  }, [requestedZoom, setZoom, zoom])

  // When the timeline shrinks (e.g. deleting the tail clips) the view can be
  // left scrolled into the now-empty region past the last clip — a black void.
  // The browser only auto-clamps when the content box itself shrinks, so snap
  // the scroll back to the content end here. Guarded to fire ONLY on a shrink so
  // it never fights the zoom-anchored scroll (zoom doesn't change durationSec).
  useEffect(() => {
    const el = scrollRef.current
    const prev = prevDurationRef.current
    prevDurationRef.current = durationSec
    if (!el || durationSec >= prev) return
    const contentEndPx = Math.max(0, durationSec * zoom)
    if (el.scrollLeft > contentEndPx) {
      el.scrollLeft = Math.max(0, contentEndPx - el.clientWidth + 80)
      setScrollLeft(el.scrollLeft)
    }
  }, [durationSec, zoom])

  // O(1) lookups — selectedClipIds.includes over thousands of caption clips
  // was O(n·m) per render and stalled the timeline when mass-selecting.
  const selectedIdSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds])
  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  // Single O(C) group — pass the right list to each track (was O(T·C) filter).
  const clipsByTrack = useMemo(() => buildClipsByTrack(clips), [clips])
  const trackLayouts = useMemo(
    () => buildTrackLayouts(tracks, (kind) => TRACK_HEIGHT[kind] ?? 40),
    [tracks],
  )
  // Vertical viewport for track virtualization (ruler sits above the scroll body).
  const trackViewportH = Math.max(0, containerHeight - RULER_H)
  const trackWindow = useMemo(
    () => visibleTrackWindow(trackLayouts, scrollTop, trackViewportH, 200),
    [trackLayouts, scrollTop, trackViewportH],
  )
  const visibleTracks = useMemo(
    () => tracks.slice(trackWindow.start, trackWindow.end),
    [tracks, trackWindow.start, trackWindow.end],
  )

  const selectedClips = useMemo(
    () => clips.filter((clip) => selectedIdSet.has(clip.id)),
    [clips, selectedIdSet],
  )
  const hasSelection = selectedClipIds.length > 0
  const clipSelectedTrackIds = Array.from(new Set(selectedClips.map((clip) => clip.trackId)))
  const selectedTrackIds = Array.from(new Set([...markedTrackIds, ...clipSelectedTrackIds]))
  const selectedTracks = selectedTrackIds
    .map((trackId) => trackById.get(trackId))
    .filter((track): track is Track => !!track)
  const selectedTracksLocked =
    selectedTracks.length > 0 && selectedTracks.every((track) => track.locked)
  const selectedAudibleIdSet = useMemo(() => {
    const s = new Set<string>()
    for (const clip of selectedClips) {
      const track = trackById.get(clip.trackId)
      if (track?.kind === 'video' || track?.kind === 'audio') s.add(clip.id)
    }
    return s
  }, [selectedClips, trackById])
  const selectedAudibleClipIds = Array.from(selectedAudibleIdSet)
  const selectedClipsMuted =
    selectedAudibleClipIds.length > 0 &&
    selectedClips
      .filter((clip) => selectedAudibleIdSet.has(clip.id))
      .every((clip) => clip.muted)
  const detachableClipIds = selectedClips
    .filter((clip) => {
      const track = trackById.get(clip.trackId)
      const asset = assetById.get(clip.assetId ?? '')
      return track?.kind === 'video' && asset?.kind === 'video' && !clip.muted
    })
    .map((clip) => clip.id)
  // Scene-split: enabled for a single selected video clip when the backend
  // exposes the capability.
  const sceneSplitClip =
    selectedClips.length === 1
      ? selectedClips.find((clip) => {
          const track = trackById.get(clip.trackId)
          const asset = assetById.get(clip.assetId ?? '')
          return track?.kind === 'video' && asset?.kind === 'video'
        })
      : undefined
  const canSplitScenes = !!sceneSplitClip && !!getCachedCapabilities()?.sceneSplit

  const totalTrackHeight = trackWindow.totalHeight
  const playheadHeight = RULER_H + totalTrackHeight

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    // scrollTop drives vertical virtualization — update immediately.
    setScrollTop(el.scrollTop)
    // scrollLeft is broadcast to every mounted track; coalesce via rAF.
    pendingScrollLeft.current = el.scrollLeft
    if (scrollLeftRaf.current) return
    scrollLeftRaf.current = requestAnimationFrame(() => {
      scrollLeftRaf.current = 0
      setScrollLeft(pendingScrollLeft.current)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (scrollLeftRaf.current) cancelAnimationFrame(scrollLeftRaf.current)
    }
  }, [])

  // Scroll so that `targetSec` lands at `screenX` (px from the viewport's left),
  // clamped to the content so we never reveal empty space past the timeline end.
  const scrollToAnchor = useCallback(
    (newZoom: number, targetSec: number, screenX: number) => {
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (!el) return
        const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth)
        el.scrollLeft = Math.max(0, Math.min(maxScroll, targetSec * newZoom - screenX))
      })
    },
    [],
  )

  // Button / slider zoom keeps the playhead pinned to the middle of the viewport.
  const zoomAnchored = useCallback(
    (newZoom: number, anchorSec?: number) => {
      const safeZoom = clampTimelineZoom(newZoom, clipEndSec)
      const anchor = anchorSec ?? usePlaybackStore.getState().currentSec
      setZoom(safeZoom)
      const el = scrollRef.current
      if (el) scrollToAnchor(safeZoom, anchor, el.clientWidth / 2)
    },
    [clipEndSec, setZoom, scrollToAnchor],
  )

  // Ctrl+wheel zoom keeps the time under the cursor fixed under the cursor.
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const newZoom = clampTimelineZoom(zoom * (e.deltaY < 0 ? 1.15 : 0.87), clipEndSec)
        const container = scrollRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          const mouseXInViewport = e.clientX - rect.left
          const anchorSec = (mouseXInViewport + container.scrollLeft) / zoom
          setZoom(newZoom)
          scrollToAnchor(newZoom, anchorSec, mouseXInViewport)
        } else {
          setZoom(newZoom)
        }
      }
    },
    [clipEndSec, zoom, setZoom, scrollToAnchor],
  )

  // Held so the observer created for a previous element is disconnected before
  // we observe a new one, and on unmount (ref callback fires with null). Without
  // this every editor open/remount leaked an observer + its DOM closure.
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const refCallback = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    ;(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el
    if (!el) return
    setContainerWidth(el.clientWidth)
    setContainerHeight(el.clientHeight)
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth)
      setContainerHeight(el.clientHeight)
    })
    ro.observe(el)
    resizeObserverRef.current = ro
  }, [])

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
    },
    [],
  )

  const contentWidth = Math.max(containerWidth, Math.ceil(clipEndSec * zoom))

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const maxScroll = Math.max(0, contentWidth - el.clientWidth)
    const nextScrollLeft = Math.min(el.scrollLeft, maxScroll)
    if (Math.abs(el.scrollLeft - nextScrollLeft) > 0.5) el.scrollLeft = nextScrollLeft
    if (Math.abs(scrollLeft - nextScrollLeft) > 0.5) setScrollLeft(nextScrollLeft)
  }, [contentWidth, containerWidth, scrollLeft, zoom])

  // Vertical band (top/bottom px) for each track within the tracks container
  const trackBands = useCallback(() => {
    let acc = 0
    return tracks.map((t) => {
      const h = TRACK_HEIGHT[t.kind] ?? 40
      const band = { id: t.id, top: acc, bottom: acc + h }
      acc += h
      return band
    })
  }, [tracks])

  const secFromClientX = useCallback(
    (clientX: number) => {
      const container = tracksRef.current
      if (!container) return 0
      const rect = container.getBoundingClientRect()
      return Math.max(0, (clientX - rect.left) / zoom)
    },
    [zoom],
  )

  const beginMarqueeSelection = useCallback(
    (startClientX: number, startClientY: number) => {
      const container = tracksRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      const sx = startClientX - rect.left
      const sy = startClientY - rect.top
      selectClips([])

      const bands = trackBands()
      const bandByTrack = new Map(bands.map((band) => [band.id, band]))

      function update(clientX: number, clientY: number) {
        const cx = clientX - rect.left
        const cy = clientY - rect.top
        const box = {
          x1: Math.min(sx, cx),
          y1: Math.min(sy, cy),
          x2: Math.max(sx, cx),
          y2: Math.max(sy, cy),
        }
        setMarquee(box)
        const { timeline } = useTimelineStore.getState()
        const ids = timeline.clips
          .filter((c) => {
            const band = bandByTrack.get(c.trackId)
            if (!band) return false
            const cx1 = c.startSec * zoom
            const cx2 = (c.startSec + clipEffectiveDuration(c)) * zoom
            const hOverlap = cx1 < box.x2 && cx2 > box.x1
            const vOverlap = band.top < box.y2 && band.bottom > box.y1
            return hOverlap && vOverlap
          })
          .map((c) => c.id)
        selectClips(ids)
      }

      update(startClientX, startClientY)
      return {
        update,
        finish: () => setMarquee(null),
      }
    },
    [zoom, selectClips, trackBands],
  )

  const handleRulerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      let moved = false

      function onMove(me: MouseEvent) {
        if (Math.hypot(me.clientX - startX, me.clientY - startY) >= MARQUEE_DRAG_THRESHOLD_PX) {
          moved = true
        }
      }
      function onUp() {
        if (!moved) {
          selectClips([])
          seek(secFromClientX(startX))
        }
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [seek, secFromClientX, selectClips],
  )

  const onTracksMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      if (e.ctrlKey || e.metaKey || e.shiftKey) return
      e.preventDefault()

      const startX = e.clientX
      const startY = e.clientY
      let mode: 'pending' | 'marquee' = 'pending'
      let marqueeSession: ReturnType<typeof beginMarqueeSelection> = null
      let pendingPoint: { x: number; y: number } | null = null
      let frameId: number | null = null

      function queueMarqueeUpdate(clientX: number, clientY: number) {
        pendingPoint = { x: clientX, y: clientY }
        if (frameId !== null) return
        frameId = window.requestAnimationFrame(() => {
          frameId = null
          const point = pendingPoint
          pendingPoint = null
          if (point) marqueeSession?.update(point.x, point.y)
        })
      }

      function startMarquee(clientX: number, clientY: number) {
        if (mode !== 'pending') return
        mode = 'marquee'
        marqueeSession = beginMarqueeSelection(startX, startY)
        queueMarqueeUpdate(clientX, clientY)
      }

      const holdTimer = window.setTimeout(() => {
        startMarquee(startX, startY)
      }, MARQUEE_HOLD_MS)

      function onMove(me: MouseEvent) {
        if (mode === 'pending') {
          const distance = Math.hypot(me.clientX - startX, me.clientY - startY)
          if (distance >= MARQUEE_DRAG_THRESHOLD_PX) {
            startMarquee(me.clientX, me.clientY)
          }
          return
        }
        queueMarqueeUpdate(me.clientX, me.clientY)
      }

      function onUp() {
        window.clearTimeout(holdTimer)
        if (frameId !== null) window.cancelAnimationFrame(frameId)
        if (pendingPoint) marqueeSession?.update(pendingPoint.x, pendingPoint.y)
        if (mode === 'pending') {
          selectClips([])
          seek(secFromClientX(startX))
        } else {
          marqueeSession?.finish()
        }
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [beginMarqueeSelection, seek, secFromClientX, selectClips],
  )

  const splitAtPlayhead = useCallback(() => {
    const sec = usePlaybackStore.getState().currentSec
    // Inline the same target set as splitTargetIds() so the callback deps are
    // exhaustive without referring to a non-memoized helper (S6 lint).
    const ids = hasSelection
      ? selectedClipIds
      : clips
          .filter((clip) => {
            const endSec = clip.startSec + clipEffectiveDuration(clip)
            return sec > clip.startSec && sec < endSec
          })
          .map((clip) => clip.id)
    splitClips(ids, sec)
  }, [hasSelection, selectedClipIds, clips, splitClips])

  const splitSelectedScenes = useCallback(() => {
    if (!sceneSplitClip) return
    void runSceneSplit(sceneSplitClip.id)
  }, [sceneSplitClip])

  const toggleSelectedMute = useCallback(() => {
    if (selectedAudibleClipIds.length === 0) return
    setClipsMuted(selectedAudibleClipIds, !selectedClipsMuted)
  }, [selectedAudibleClipIds, selectedClipsMuted, setClipsMuted])

  const toggleSelectedTrackLock = useCallback(() => {
    if (selectedTrackIds.length === 0) return
    setTracksLocked(selectedTrackIds, !selectedTracksLocked)
  }, [selectedTrackIds, selectedTracksLocked, setTracksLocked])

  const addTextAtPlayhead = useCallback(() => {
    insertTextClip(usePlaybackStore.getState().currentSec, 5)
  }, [insertTextClip])

  const handleTrackSelect = useCallback(
    (trackId: string, additive: boolean) => {
      if (additive) toggleSelectTrack(trackId)
      else selectTracks([trackId])
    },
    [selectTracks, toggleSelectTrack],
  )

  const handleImportFiles = useCallback(
    (files: File[]) => {
      if (files.length) void importFiles(files)
    },
    [importFiles],
  )

  // Enable split when something is selected, or any clip exists (handler no-ops if
  // playhead is between clips). Avoids reading currentSec every render.
  const canSplitAtPlayhead = hasSelection ? selectedClipIds.length > 0 : clips.length > 0
  const canMuteSelection = selectedAudibleClipIds.length > 0
  const canDetachAudio = detachableClipIds.length > 0
  const canLockTracks = selectedTrackIds.length > 0
  const canCropSelection = selectedClips.some((c) => !c.textData && c.assetId)
  const canFitTimeline = durationSec > 0
  const showClipTools = hasSelection || canMuteSelection || canDetachAudio || canLockTracks
  const showTransformTools = hasSelection

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Compound breadcrumb — a real bar above the toolbar (CapCut "‹ back"),
          shown only while editing inside a compound. */}
      {compoundStack.length > 0 && (
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border-strong bg-bg-2 px-2 text-xs">
          <button
            onClick={exitCompound}
            title="Quay lại timeline cha"
            className="flex items-center gap-1 rounded px-2 py-0.5 font-medium text-accent hover:bg-bg-3"
          >
            <ChevronLeft size={14} /> Quay lại
          </button>
          <span className="text-text-3">·</span>
          <span className="truncate font-medium text-text-1">
            {compoundStack[compoundStack.length - 1]!.name}
          </span>
        </div>
      )}
      {/* Toolbar — left edit tools | right zoom */}
      <div className="relative z-[70] flex h-10 shrink-0 items-center justify-between border-y border-border-strong bg-[#111113] shadow-[0_2px_8px_rgba(0,0,0,0.35)]">
        <input
          ref={importInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          onChange={(e) => {
            handleImportFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />

        {/* ── LEFT: edit tools ─────────────────────────────────── */}
        <div className="flex items-center gap-1 overflow-x-auto px-2">
          <ToolbarButton
            icon={Plus}
            label="Import media"
            onClick={() =>
              desktopImport ? void desktopImport() : importInputRef.current?.click()
            }
          />
          <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-1 rounded border border-border-strong bg-bg-2 px-1.5 text-text-1 hover:bg-bg-3"
            title="Select tool"
            aria-label="Select tool"
          >
            <MousePointer2 size={14} />
            <ChevronDown size={11} className="text-text-3" />
          </button>
          <ToolbarDivider />
          <ToolbarButton icon={Undo2} label="Undo" onClick={undo} disabled={!canUndo} />
          <ToolbarButton icon={Redo2} label="Redo" onClick={redo} disabled={!canRedo} />
          <ToolbarDivider />
          <ToolbarButton
            icon={Scissors}
            label="Split at playhead"
            onClick={splitAtPlayhead}
            disabled={!canSplitAtPlayhead}
          />
          <ToolbarButton
            icon={SquareSplitVertical}
            label="Trim start to playhead"
            onClick={() =>
              trimClipsLeftTo(selectedClipIds, usePlaybackStore.getState().currentSec)
            }
            disabled={!hasSelection}
          />
          <ToolbarButton
            icon={SquareSplitHorizontal}
            label="Trim end to playhead"
            onClick={() =>
              trimClipsRightTo(selectedClipIds, usePlaybackStore.getState().currentSec)
            }
            disabled={!hasSelection}
          />
          <ToolbarButton
            icon={Trash2}
            label="Delete selected"
            onClick={() => removeClips(selectedClipIds)}
            disabled={!hasSelection}
          />
          {canCropSelection && (
            <ToolbarButton
              icon={Crop}
              label="Crop & rotate selected clip"
              onClick={() => {
                const target = selectedClips.find((c) => !c.textData && c.assetId)
                if (target) {
                  selectClips([target.id])
                  openCrop(target.id)
                }
              }}
            />
          )}
          {showTransformTools && (
            <>
          <ToolbarDivider />
          {/* Transform menu (CapCut-style dropdown): rotate / mirror / reset. */}
          <button
            type="button"
            title="Transform — rotate / mirror / reset"
            aria-label="Transform"
            disabled={!hasSelection}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              const items: MenuItem[] = [
                { label: 'Freeze', disabled: true },
                { label: 'Reverse', disabled: true },
                { label: 'Mirror', onClick: () => flipClips(selectedClipIds, 'h') },
                { label: 'Rotate', onClick: () => rotateClips(selectedClipIds, 90) },
                { separator: true, label: 'sepT' },
                { label: 'Reset transform', onClick: () => resetClipTransforms(selectedClipIds) },
              ]
              openMenu(r.left, r.bottom + 4, items)
            }}
            className="flex h-7 shrink-0 items-center gap-0.5 rounded px-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCw size={14} />
            <ChevronDown size={11} className="text-text-3" />
          </button>
            </>
          )}
          {sceneSplitClip && (
            <ToolbarButton
              icon={Clapperboard}
              label="Split scenes"
              onClick={splitSelectedScenes}
              disabled={!canSplitScenes}
            />
          )}
          {showClipTools && (
            <>
              <ToolbarDivider />
              <ToolbarButton
                icon={CopyPlus}
                label="Duplicate selected"
                onClick={() => duplicateClips(selectedClipIds)}
                disabled={!hasSelection}
              />
              <ToolbarButton
                icon={VolumeX}
                label={selectedClipsMuted ? 'Unmute selected clips' : 'Mute selected clips'}
                onClick={toggleSelectedMute}
                disabled={!canMuteSelection}
                active={selectedClipsMuted}
              />
              <ToolbarButton
                icon={Volume2}
                label="Detach audio"
                onClick={() => detachAudios(detachableClipIds)}
                disabled={!canDetachAudio}
              />
              <ToolbarButton
                icon={selectedTracksLocked ? ShieldOff : Shield}
                label={selectedTracksLocked ? 'Unlock selected tracks' : 'Lock selected tracks'}
                onClick={toggleSelectedTrackLock}
                disabled={!canLockTracks}
                active={selectedTracksLocked}
              />
            </>
          )}
          <ToolbarButton icon={TypeIcon} label="Add text at playhead" onClick={addTextAtPlayhead} />
        </div>

        {/* ── RIGHT: zoom + snap ────────────────────────────────── */}
        <div className="flex items-center justify-end gap-1 px-2">
          {canFitTimeline && (
            <>
              <ToolbarButton
                icon={RefreshCw}
                label="Fit timeline zoom"
                onClick={() =>
                  zoomAnchored(
                    fitTimelineZoom(clipEndSec, containerWidth),
                    usePlaybackStore.getState().currentSec,
                  )
                }
              />
              <ToolbarDivider />
            </>
          )}
          <ToolbarButton icon={ZoomOut} label="Zoom out" onClick={() => zoomAnchored(zoom * 0.77)} />
          <input
            type="range"
            min={0}
            max={1000}
            value={zoomToSlider(zoom, minZoom, maxZoom)}
            onChange={(e) =>
              zoomAnchored(sliderToZoom(Number(e.target.value), minZoom, maxZoom))
            }
            onMouseUp={(e) => (e.currentTarget as HTMLInputElement).blur()}
            onKeyUp={(e) => (e.currentTarget as HTMLInputElement).blur()}
            className="w-20 shrink-0 cursor-pointer accent-[#71717a]"
            aria-label="Zoom level"
          />
          <ToolbarButton icon={ZoomIn} label="Zoom in" onClick={() => zoomAnchored(zoom * 1.3)} />
          <ToolbarDivider />
          {/* Order matches CapCut: main-track magnet → auto snapping → linkage. */}
          <ToolbarButton
            icon={ArrowLeftToLine}
            label={
              magneticMainTrack
                ? 'Magnetic main track on — clips auto-close gaps (click to turn off)'
                : 'Magnetic main track off (click to pack the main video track)'
            }
            active={magneticMainTrack}
            onClick={() => {
              if (!magneticMainTrack) collapseMainVideoTrack() // pack now when turning on
              toggleMagneticMainTrack()
            }}
          />
          <ToolbarButton
            icon={Magnet}
            label={snapEnabled ? 'Snapping on (click to turn off)' : 'Snapping off'}
            active={snapEnabled}
            onClick={toggleSnap}
          />
          <ToolbarButton
            icon={linkEnabled ? Link2 : Link2Off}
            label={
              linkEnabled
                ? 'Linkage on — moving/deleting a video carries its captions/audio (click to turn off)'
                : 'Linkage off'
            }
            active={linkEnabled}
            onClick={toggleLink}
          />
          <span className="ml-1 shrink-0 font-mono text-2xs text-text-3">
            {zoom >= 10 ? zoom.toFixed(0) : zoom >= 1 ? zoom.toFixed(1) : zoom.toPrecision(2)}px/s
          </span>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 bg-tl-bg">
        <div
          className="flex shrink-0 flex-col border-r border-border/70 bg-tl-sidebar"
          style={{ width: HEADER_W }}
        >
          <div className="shrink-0 border-b border-border/70 bg-tl-sidebar" style={{ height: RULER_H }} />
          <div className="relative flex-1 overflow-hidden">
            <div
              className="absolute left-0 right-0"
              style={{ height: totalTrackHeight, transform: `translateY(${-scrollTop}px)` }}
            >
              {/* Spacer keeps headers aligned when only a vertical window is mounted. */}
              {trackWindow.offsetTop > 0 && <div style={{ height: trackWindow.offsetTop }} />}
              {visibleTracks.map((track, i) => {
                const index = trackWindow.start + i
                return (
                  <TrackHeader
                    key={track.id}
                    track={track}
                    heightPx={TRACK_HEIGHT[track.kind] ?? 40}
                    isGroupStart={index > 0 && tracks[index - 1]?.kind !== track.kind}
                    isSelected={markedTrackIds.includes(track.id)}
                    hasSelectedClip={clipSelectedTrackIds.includes(track.id)}
                    onSelectTrack={handleTrackSelect}
                  />
                )
              })}
            </div>
          </div>
        </div>

        <div
          ref={refCallback}
          onScroll={handleScroll}
          onWheel={handleWheel}
          data-timeline-scroll
          className="relative flex-1 overflow-auto"
        >
          <div
            className="relative overflow-clip"
            style={{ width: contentWidth, height: RULER_H + totalTrackHeight }}
          >
            <div
              className="sticky top-0 z-40 isolate shadow-[0_1px_0_rgba(255,255,255,0.12)]"
              style={{ width: contentWidth }}
              onMouseDown={handleRulerMouseDown}
            >
              <TimelineRuler
                zoom={zoom}
                scrollLeft={scrollLeft}
                containerWidth={containerWidth}
                heightPx={RULER_H}
              />
            </div>

            <div
              ref={tracksRef}
              className="relative"
              style={{ height: totalTrackHeight }}
              onMouseDown={onTracksMouseDown}
            >
              {trackWindow.offsetTop > 0 && <div style={{ height: trackWindow.offsetTop }} />}
              {visibleTracks.map((track, i) => {
                const index = trackWindow.start + i
                return (
                  <TimelineTrack
                    key={track.id}
                    track={track}
                    zoom={zoom}
                    heightPx={TRACK_HEIGHT[track.kind] ?? 40}
                    clips={clipsByTrack.get(track.id) ?? EMPTY_CLIPS}
                    scrollLeft={scrollLeft}
                    viewportWidth={containerWidth}
                    isGroupStart={index > 0 && tracks[index - 1]?.kind !== track.kind}
                    isGroupEnd={
                      index === tracks.length - 1 || tracks[index + 1]?.kind !== track.kind
                    }
                    isSelected={markedTrackIds.includes(track.id)}
                  />
                )
              })}

              {/* Marquee selection box */}
              {marquee && (
                <div
                  className="pointer-events-none absolute z-10 border border-tl-accent bg-tl-accent/15"
                  style={{
                    left: marquee.x1,
                    top: marquee.y1,
                    width: marquee.x2 - marquee.x1,
                    height: marquee.y2 - marquee.y1,
                  }}
                />
              )}
            </div>

            {/* Snap guide: a bright vertical line at the edge a clip / the
                playhead is snapping to (CapCut-style comparison line). */}
            {snapGuideSec != null && (
              <div
                className="pointer-events-none absolute top-0 z-40 w-px bg-warning"
                style={{
                  left: snapGuideSec * zoom,
                  height: RULER_H + totalTrackHeight,
                  boxShadow: '0 0 4px 0 var(--warning)',
                }}
              />
            )}

            <Playhead
              heightPx={playheadHeight}
              durationSec={durationSec}
              scrollContainerRef={scrollRef}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
