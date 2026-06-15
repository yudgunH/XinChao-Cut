import { useCallback, useRef, useState } from 'react'
import {
  ChevronDown,
  Clapperboard,
  CopyPlus,
  Crop,
  ArrowLeftToLine,
  FlipHorizontal2,
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
import { clipEffectiveDuration, type Track } from '@engine/timeline'
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

// Zoom slider maps 0..1000 ↔ MIN_ZOOM..MAX_ZOOM on a logarithmic scale so
// each step feels even (matches setZoom's clamp range).
// MIN_ZOOM = 1 px/s lets long videos (10+ min) fit the screen at full zoom-out.
const MIN_ZOOM = 1
const MAX_ZOOM = 400
const zoomToSlider = (z: number) =>
  Math.round((Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 1000)
const sliderToZoom = (v: number) => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 1000)

export function Timeline() {
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const markedTrackIds = useTimelineStore((s) => s.selectedTrackIds)
  const durationSec = useTimelineStore((s) => s.timeline.durationSec)
  const zoom = useTimelineStore((s) => s.zoom)
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
  const splitClip = useTimelineStore((s) => s.splitClip)
  const trimClipsLeftTo = useTimelineStore((s) => s.trimClipsLeftTo)
  const trimClipsRightTo = useTimelineStore((s) => s.trimClipsRightTo)
  const setClipsMuted = useTimelineStore((s) => s.setClipsMuted)
  const setTracksLocked = useTimelineStore((s) => s.setTracksLocked)
  const resetClipTransforms = useTimelineStore((s) => s.resetClipTransforms)
  const rotateClips = useTimelineStore((s) => s.rotateClips)
  const flipClips = useTimelineStore((s) => s.flipClips)
  const openMenu = useContextMenuStore((s) => s.openMenu)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)
  const detachAudio = useTimelineStore((s) => s.detachAudio)
  const undo = useTimelineStore((s) => s.undo)
  const redo = useTimelineStore((s) => s.redo)
  const canUndo = useTimelineStore((s) => s.canUndo)
  const canRedo = useTimelineStore((s) => s.canRedo)
  const assets = useProjectStore((s) => s.assets)
  const seek = usePlaybackStore((s) => s.seek)
  const currentSec = usePlaybackStore((s) => s.currentSec)
  const importFiles = useMediaImport()
  const desktopImport = useDesktopMediaImport()

  const scrollRef = useRef<HTMLDivElement>(null)
  const tracksRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerWidth, setContainerWidth] = useState(800)
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)

  const selectedClips = clips.filter((clip) => selectedClipIds.includes(clip.id))
  const hasSelection = selectedClipIds.length > 0
  const activeClipIdsAtPlayhead = clips
    .filter((clip) => {
      const endSec = clip.startSec + clipEffectiveDuration(clip)
      return currentSec > clip.startSec && currentSec < endSec
    })
    .map((clip) => clip.id)
  const splitTargetIds = hasSelection ? selectedClipIds : activeClipIdsAtPlayhead
  const clipSelectedTrackIds = Array.from(new Set(selectedClips.map((clip) => clip.trackId)))
  const selectedTrackIds = Array.from(new Set([...markedTrackIds, ...clipSelectedTrackIds]))
  const selectedTracks = selectedTrackIds
    .map((trackId) => tracks.find((track) => track.id === trackId))
    .filter((track): track is Track => !!track)
  const selectedTracksLocked =
    selectedTracks.length > 0 && selectedTracks.every((track) => track.locked)
  const selectedAudibleClipIds = selectedClips
    .filter((clip) => {
      const track = tracks.find((candidate) => candidate.id === clip.trackId)
      return track?.kind === 'video' || track?.kind === 'audio'
    })
    .map((clip) => clip.id)
  const selectedClipsMuted =
    selectedAudibleClipIds.length > 0 &&
    selectedClips
      .filter((clip) => selectedAudibleClipIds.includes(clip.id))
      .every((clip) => clip.muted)
  const detachableClip = selectedClips.find((clip) => {
    const track = tracks.find((candidate) => candidate.id === clip.trackId)
    const asset = assets.find((candidate) => candidate.id === clip.assetId)
    return track?.kind === 'video' && asset?.kind === 'video' && !clip.muted
  })
  // Scene-split: enabled for a single selected video clip when the backend
  // exposes the capability.
  const sceneSplitClip =
    selectedClips.length === 1
      ? selectedClips.find((clip) => {
          const track = tracks.find((t) => t.id === clip.trackId)
          const asset = assets.find((a) => a.id === clip.assetId)
          return track?.kind === 'video' && asset?.kind === 'video'
        })
      : undefined
  const canSplitScenes = !!sceneSplitClip && !!getCachedCapabilities()?.sceneSplit

  const totalTrackHeight = tracks.reduce((acc, t) => acc + (TRACK_HEIGHT[t.kind] ?? 40), 0)
  const playheadHeight = RULER_H + totalTrackHeight

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollLeft(e.currentTarget.scrollLeft)
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setZoom(zoom * (e.deltaY < 0 ? 1.15 : 0.87))
      }
    },
    [zoom, setZoom],
  )

  const refCallback = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    ;(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el
    setContainerWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
  }, [])

  const contentDurationSec = Math.max(60, Math.ceil(durationSec + 10))
  const contentWidth = Math.max(containerWidth, contentDurationSec * zoom)

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
            const band = bands.find((b) => b.id === c.trackId)
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

      function startMarquee(clientX: number, clientY: number) {
        if (mode !== 'pending') return
        mode = 'marquee'
        marqueeSession = beginMarqueeSelection(startX, startY)
        marqueeSession?.update(clientX, clientY)
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
        marqueeSession?.update(me.clientX, me.clientY)
      }

      function onUp() {
        window.clearTimeout(holdTimer)
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
    for (const id of splitTargetIds) splitClip(id, currentSec)
  }, [splitTargetIds, splitClip, currentSec])

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
    insertTextClip(currentSec, 5)
  }, [insertTextClip, currentSec])

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

  return (
    <div className="flex h-full flex-col overflow-hidden">
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
            icon={SquareSplitVertical}
            label="Trim start to playhead"
            onClick={() => trimClipsLeftTo(selectedClipIds, currentSec)}
            disabled={!hasSelection}
          />
          <ToolbarButton
            icon={Scissors}
            label="Split at playhead"
            onClick={splitAtPlayhead}
            disabled={splitTargetIds.length === 0}
          />
          <ToolbarButton
            icon={Clapperboard}
            label="Split scenes"
            onClick={splitSelectedScenes}
            disabled={!canSplitScenes}
          />
          <ToolbarButton
            icon={SquareSplitHorizontal}
            label="Trim end to playhead"
            onClick={() => trimClipsRightTo(selectedClipIds, currentSec)}
            disabled={!hasSelection}
          />
          <ToolbarButton
            icon={Trash2}
            label="Delete selected"
            onClick={() => removeClips(selectedClipIds)}
            disabled={!hasSelection}
          />
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
            disabled={selectedAudibleClipIds.length === 0}
            active={selectedClipsMuted}
          />
          <ToolbarButton
            icon={Volume2}
            label="Detach audio"
            onClick={() => detachableClip && detachAudio(detachableClip.id)}
            disabled={!detachableClip}
          />
          <ToolbarButton
            icon={selectedTracksLocked ? ShieldOff : Shield}
            label={selectedTracksLocked ? 'Unlock selected tracks' : 'Lock selected tracks'}
            onClick={toggleSelectedTrackLock}
            disabled={selectedTrackIds.length === 0}
            active={selectedTracksLocked}
          />
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
                { label: 'Rotate 90°', onClick: () => rotateClips(selectedClipIds, 90) },
                { label: 'Mirror horizontal', onClick: () => flipClips(selectedClipIds, 'h') },
                { label: 'Mirror vertical', onClick: () => flipClips(selectedClipIds, 'v') },
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
          <ToolbarButton
            icon={FlipHorizontal2}
            label="Mirror horizontal"
            onClick={() => flipClips(selectedClipIds, 'h')}
            disabled={!hasSelection}
          />
          <ToolbarButton
            icon={Crop}
            label="Crop selected clip"
            onClick={() => {
              const target = selectedClips.find((c) => !c.textData && c.assetId)
              if (target) {
                selectClips([target.id])
                setActiveRightTab('video')
              }
            }}
            disabled={!selectedClips.some((c) => !c.textData && c.assetId)}
          />
          <ToolbarButton icon={TypeIcon} label="Add text at playhead" onClick={addTextAtPlayhead} />
        </div>

        {/* ── RIGHT: zoom + snap ────────────────────────────────── */}
        <div className="flex items-center justify-end gap-1 px-2">
          <ToolbarButton
            icon={RefreshCw}
            label="Fit timeline zoom"
            onClick={() => setZoom(containerWidth / contentDurationSec)}
            disabled={durationSec <= 0}
          />
          <ToolbarDivider />
          <ToolbarButton icon={ZoomOut} label="Zoom out" onClick={() => setZoom(zoom * 0.77)} />
          <input
            type="range"
            min={0}
            max={1000}
            value={zoomToSlider(zoom)}
            onChange={(e) => setZoom(sliderToZoom(Number(e.target.value)))}
            onMouseUp={(e) => (e.currentTarget as HTMLInputElement).blur()}
            onKeyUp={(e) => (e.currentTarget as HTMLInputElement).blur()}
            className="w-20 shrink-0 cursor-pointer accent-[#71717a]"
            aria-label="Zoom level"
          />
          <ToolbarButton icon={ZoomIn} label="Zoom in" onClick={() => setZoom(zoom * 1.3)} />
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
          <span className="ml-1 shrink-0 font-mono text-2xs text-text-3">{zoom.toFixed(0)}px/s</span>
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
              {tracks.map((track, index) => (
                <TrackHeader
                  key={track.id}
                  track={track}
                  heightPx={TRACK_HEIGHT[track.kind] ?? 40}
                  isGroupStart={index > 0 && tracks[index - 1]?.kind !== track.kind}
                  isSelected={markedTrackIds.includes(track.id)}
                  hasSelectedClip={clipSelectedTrackIds.includes(track.id)}
                  onSelectTrack={handleTrackSelect}
                />
              ))}
            </div>
          </div>
        </div>

        <div
          ref={refCallback}
          onScroll={handleScroll}
          onWheel={handleWheel}
          className="relative flex-1 overflow-auto"
        >
          <div
            className="relative"
            style={{ width: contentWidth, height: RULER_H + totalTrackHeight }}
          >
            <div
              className="sticky top-0 z-30"
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
              {tracks.map((track, index) => (
                <TimelineTrack
                  key={track.id}
                  track={track}
                  zoom={zoom}
                  heightPx={TRACK_HEIGHT[track.kind] ?? 40}
                  isGroupStart={index > 0 && tracks[index - 1]?.kind !== track.kind}
                  isGroupEnd={index === tracks.length - 1 || tracks[index + 1]?.kind !== track.kind}
                  isSelected={markedTrackIds.includes(track.id)}
                />
              ))}

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

            <Playhead heightPx={playheadHeight} />
          </div>
        </div>
      </div>
    </div>
  )
}
