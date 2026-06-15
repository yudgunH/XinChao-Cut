import { detectKind } from '@engine/media'
import type { Track } from '@engine/timeline'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useContextMenuStore } from '@store/context-menu-store'
import { useMediaImport } from '@hooks/useMediaImport'

import { TimelineClip } from './TimelineClip'

interface TimelineTrackProps {
  track: Track
  zoom: number
  heightPx: number
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

export function TimelineTrack({
  track,
  zoom,
  heightPx,
  isGroupStart = false,
  isGroupEnd = false,
  isSelected = false,
}: TimelineTrackProps) {
  const assets = useProjectStore((s) => s.assets)
  const clips = useTimelineStore((s) => s.timeline.clips.filter((c) => c.trackId === track.id))
  const insertClip = useTimelineStore((s) => s.insertClip)
  const selectClips = useTimelineStore((s) => s.selectClips)
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

    // 2. Asset dragged from the media library
    const assetId = e.dataTransfer.getData('application/x-xinchao-asset-id')
    if (!assetId) return
    const asset = assets.find((a) => a.id === assetId)
    if (!asset || !accepted.includes(asset.kind)) return
    insertClip({
      trackId: track.id,
      assetId,
      startSec: startSecFromEvent(e),
      durationSec: asset.durationSec,
    })
  }

  function onClickTrack(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    selectClips([])
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
      onClick={onClickTrack}
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
      {clips.map((clip) => (
        <TimelineClip key={clip.id} clip={clip} zoom={zoom} heightPx={heightPx} />
      ))}
    </div>
  )
}
