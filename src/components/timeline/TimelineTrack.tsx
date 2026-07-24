import { memo, useMemo } from 'react'

import { detectKind } from '@engine/media'
import { clipEffectiveDuration, type Clip, type Track } from '@engine/timeline'
import { useProjectStore } from '@store/project-store'
import { useReplaceStore } from '@store/replace-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'
import { useContextMenuStore } from '@store/context-menu-store'
import { useMediaImport } from '@hooks/useMediaImport'

import { TimelineClip } from './TimelineClip'

interface TimelineTrackProps {
  track: Track
  zoom: number
  heightPx: number
  /** Pre-grouped clips for this track (parent builds Map once O(C)). */
  clips: Clip[]
  /** Horizontal scroll offset (px) of the timeline viewport — for clip culling. */
  scrollLeft?: number
  /** Visible width (px) of the timeline viewport — for clip culling. */
  viewportWidth?: number
  isGroupStart?: boolean
  isGroupEnd?: boolean
  isSelected?: boolean
}

const KIND_BG: Record<Track['kind'], string> = {
  video: 'bg-track-video/[0.025]',
  audio: 'bg-track-audio/[0.025]',
  text: 'bg-track-text/[0.03]',
  fx: 'bg-track-fx/[0.025]',
}

const ACCEPT_KIND: Record<Track['kind'], string[]> = {
  video: ['video', 'image'],
  audio: ['audio'],
  text: ['text'],
  fx: [],
}

/** Memo: during play without scroll, props stay stable so tracks skip re-render
 *  when a parent (toolbar) re-renders. scrollLeft/viewportWidth still update on scroll.
 *  Clips are passed from the parent (single Map build O(C)), not filtered from the
 *  full store list here (was O(tracks·clips) every mutation). */
export const TimelineTrack = memo(function TimelineTrack({
  track,
  zoom,
  heightPx,
  clips,
  scrollLeft = 0,
  viewportWidth = 0,
  isGroupStart = false,
  isGroupEnd = false,
  isSelected = false,
}: TimelineTrackProps) {
  const assets = useProjectStore((s) => s.assets)

  // Virtualize: only render clips intersecting the viewport (+ 1 screen buffer each
  // side for smooth scroll). A dense project can have hundreds of clips per track —
  // mounting them all froze the editor for seconds on open. O(n) filter is cheap;
  // rendering only ~visible clips is the win.
  const visibleClips = useMemo(() => {
    const vw = viewportWidth || 1200
    const minX = scrollLeft - vw
    const maxX = scrollLeft + vw * 2
    return clips.filter((c) => {
      const left = c.startSec * zoom
      const right = (c.startSec + clipEffectiveDuration(c)) * zoom
      return right >= minX && left <= maxX
    })
  }, [clips, zoom, scrollLeft, viewportWidth])
  const insertClip = useTimelineStore((s) => s.insertClip)
  const selectTracks = useTimelineStore((s) => s.selectTracks)
  const toggleSelectTrack = useTimelineStore((s) => s.toggleSelectTrack)
  const dragTargetTrackId = useTimelineStore((s) => s.dragTargetTrackId)
  const dragCreateKind = useTimelineStore((s) => s.dragCreateKind)
  const openMenu = useContextMenuStore((s) => s.openMenu)
  const importFiles = useMediaImport()

  const accepted = ACCEPT_KIND[track.kind] ?? []
  const isDragTarget = dragTargetTrackId === track.id
  // Show a "new track will be created" guide at the group edges of this kind.
  const showCreateTop = dragCreateKind === track.kind && isGroupStart
  const showCreateBottom = dragCreateKind === track.kind && isGroupEnd

  function onDragOver(e: React.DragEvent) {
    const isAsset = e.dataTransfer.types.includes('application/x-xinchao-asset-id')
    const isFile = e.dataTransfer.types.includes('Files')
    if (isAsset || isFile) e.preventDefault()
  }

  function startSecFromEvent(e: React.DragEvent) {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.max(0, (e.clientX - rect.left) / zoom)
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    if (track.locked) return

    // 1. OS files dropped directly onto a track → import + insert here
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) {
      e.stopPropagation() // prevent the global drop handler double-importing
      const startSec = startSecFromEvent(e)
      const compatible = files.filter((f) => {
        const kind = detectKind(f)
        return kind !== null && accepted.includes(kind)
      })
      const imported = await importFiles(compatible)
      let cursor = startSec
      for (const asset of imported) {
        insertClip({
          trackId: track.id,
          assetId: asset.id,
          startSec: cursor,
          durationSec: asset.durationSec,
        })
        cursor += asset.durationSec
      }
      return
    }

    // 2. Asset(s) dragged from the media library. A multi-select drag carries the
    // whole set under x-xinchao-asset-ids; older single drags carry x-xinchao-asset-id.
    let ids: string[] = []
    const multi = e.dataTransfer.getData('application/x-xinchao-asset-ids')
    if (multi) {
      try {
        const parsed = JSON.parse(multi)
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        /* fall through to the single id */
      }
    }
    const singleId = e.dataTransfer.getData('application/x-xinchao-asset-id')
    if (ids.length === 0 && singleId) ids = [singleId]
    if (ids.length === 0) return

    const dropSec = startSecFromEvent(e)

    // A SINGLE drop onto an existing clip → CapCut-style "Replace": swap that
    // clip's source (only when the new source is long enough). Replace is a
    // single-source action, so it's skipped for a multi-drag.
    if (ids.length === 1) {
      const assetId = ids[0]!
      const asset = assets.find((a) => a.id === assetId)
      if (!asset || !accepted.includes(asset.kind)) return
      const targetClip = clips.find(
        (c) => dropSec >= c.startSec && dropSec < c.startSec + clipEffectiveDuration(c),
      )
      if (targetClip) {
        const targetDur = clipEffectiveDuration(targetClip)
        if ((asset.durationSec || 0) + 1e-3 >= targetDur) {
          useReplaceStore.getState().openReplace(targetClip.id, assetId)
        } else {
          useToastStore
            .getState()
            .push('The source clip is shorter than the target clip and cannot replace it', 'error')
        }
        return
      }
      insertClip({ trackId: track.id, assetId, startSec: dropSec, durationSec: asset.durationSec })
      return
    }

    // Multiple → lay them end-to-end from the drop point on this track.
    let cursor = dropSec
    for (const id of ids) {
      const asset = assets.find((a) => a.id === id)
      if (!asset || !accepted.includes(asset.kind)) continue
      insertClip({ trackId: track.id, assetId: id, startSec: cursor, durationSec: asset.durationSec })
      cursor += asset.durationSec || 0
    }
  }

  function onMouseDownTrack(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      toggleSelectTrack(track.id)
    }
  }

  function onDoubleClickTrack(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    e.stopPropagation()
    selectTracks([track.id])
  }

  function onContextMenu(e: React.MouseEvent) {
    // Empty-track right-click → paste at the drop position
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const atSec = Math.max(0, (e.clientX - rect.left) / zoom)
    const store = useTimelineStore.getState()
    openMenu(e.clientX, e.clientY, [
      {
        label: 'Paste',
        shortcut: 'Ctrl+V',
        disabled: store.clipboard.length === 0,
        onClick: () => useTimelineStore.getState().pasteClips(atSec),
      },
    ])
  }

  return (
    <div
      data-timeline-track-id={track.id}
      data-timeline-track-kind={track.kind}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseDown={onMouseDownTrack}
      onDoubleClick={onDoubleClickTrack}
      onContextMenu={onContextMenu}
      className={`relative border-b border-border/50 ${KIND_BG[track.kind]} ${
        isGroupStart ? 'border-t border-t-border-strong/70' : ''
      } ${track.locked ? 'opacity-70' : ''} ${
        isDragTarget ? 'ring-1 ring-inset ring-tl-accent/80' : ''
      } ${
        isSelected ? 'bg-black/40 shadow-[inset_0_0_0_1px_rgba(0,216,214,0.35)]' : ''
      }`}
      style={{ height: heightPx, minWidth: '100%' }}
    >
      {isSelected && (
        <div className="pointer-events-none absolute inset-0 bg-black/35 shadow-[inset_3px_0_0_var(--timeline-accent)]" />
      )}
      {/* New-track guide lines (CapCut-style drag past the edge) */}
      {showCreateTop && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 bg-tl-accent shadow-[0_0_6px_var(--timeline-accent)]" />
      )}
      {showCreateBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 bg-tl-accent shadow-[0_0_6px_var(--timeline-accent)]" />
      )}
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage: 'linear-gradient(to right, var(--border) 1px, transparent 1px)',
          backgroundSize: `${Math.max(zoom, 24)}px 100%`,
        }}
      />
      {visibleClips.map((clip) => (
        <TimelineClip
          key={clip.id}
          clip={clip}
          zoom={zoom}
          heightPx={heightPx}
          scrollLeft={scrollLeft}
          viewportWidth={viewportWidth}
        />
      ))}
    </div>
  )
})
