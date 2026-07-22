import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react'

import { MediaPanel } from '@components/media-panel/MediaPanel'
import { Preview } from '@components/preview/Preview'
import { Timeline } from '@components/timeline/Timeline'
import { ReplaceDialog } from '@components/timeline/ReplaceDialog'
import { PropertiesPanel } from '@components/properties/PropertiesPanel'
import { CropDialog } from '@components/properties/CropDialog'
import { TopBar } from '@components/top-bar/TopBar'
import { ResizeHandle } from '@components/shared/ResizeHandle'
import { ContextMenu } from '@components/shared/ContextMenu'
import { BackgroundTasks } from '@components/shared/BackgroundTasks'
import { ShortcutsOverlay } from '@components/shortcuts/ShortcutsOverlay'
import { useUIStore } from '@store/ui-store'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { usePlaybackStore } from '@store/playback-store'
import { usePlayback } from '@hooks/usePlayback'
import { useAutoSave } from '@hooks/useAutoSave'
import { useAudioPlayback } from '@hooks/useAudioPlayback'
import { useDesktopPathMediaImport, useMediaImport } from '@hooks/useMediaImport'
import { useWaveformBackfill } from '@hooks/useWaveformBackfill'
import { useThumbnailStripBackfill } from '@hooks/useThumbnailStripBackfill'
import { useProxyBackfill } from '@hooks/useProxyBackfill'
import { clipEffectiveDuration } from '@engine/timeline'
import {
  placeAssetIdsOnTimeline,
  resolveTimelineAssetDropTarget,
} from '@engine/timeline/asset-drop'
import {
  NATIVE_FILE_DRAG_EVENT,
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDragDetail,
  type NativeFileDropDetail,
} from '@engine/media/native-drop'
import { shortcutMatchesEvent, useShortcutStore } from '@store/shortcut-store'

export function Editor() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [fileDragOver, setFileDragOver] = useState(false)
  const editorRootRef = useRef<ComponentRef<'div'>>(null)
  const importFiles = useMediaImport()
  const importDesktopPaths = useDesktopPathMediaImport()
  // Mount RAF playback loop + auto-save + audio engine + waveform backfill
  usePlayback()
  useAutoSave()
  useAudioPlayback()
  useWaveformBackfill()
  useThumbnailStripBackfill()
  useProxyBackfill()

  // The app-level Tauri bridge emits real absolute paths. This default handler
  // runs only when a specialized modal did not stop propagation.
  useEffect(() => {
    let disposed = false
    const onNativeDrag = (raw: unknown) => {
      const detail = (raw as { detail: NativeFileDragDetail }).detail
      if (detail.type === 'leave' || detail.type === 'drop') {
        setFileDragOver(false)
        return
      }
      // A specialized modal drop-zone owns its own hover UI.
      const hit = detail.clientX == null || detail.clientY == null
        ? null
        : document.elementFromPoint(detail.clientX, detail.clientY)
      const insideEditor = !!hit && !!editorRootRef.current?.contains(hit)
      setFileDragOver(insideEditor && !hit.closest('[data-native-file-drop-zone]'))
    }
    const onNativeDrop = (raw: unknown) => {
      const event = raw as { detail: NativeFileDropDetail; target?: unknown }
      const detail = event.detail
      setFileDragOver(false)
      if (
        !(event.target instanceof window.Node) ||
        !editorRootRef.current?.contains(event.target)
      ) return
      const target = resolveTimelineAssetDropTarget(detail.clientX, detail.clientY)
      void importDesktopPaths(detail.files).then((assets) => {
        if (disposed) return
        placeAssetIdsOnTimeline(assets.map((asset) => asset.id), target)
      })
    }
    window.addEventListener(NATIVE_FILE_DRAG_EVENT, onNativeDrag)
    window.addEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop)
    return () => {
      disposed = true
      window.removeEventListener(NATIVE_FILE_DRAG_EVENT, onNativeDrag)
      window.removeEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop)
    }
  }, [importDesktopPaths])

  const leftPanelWidth = useUIStore((s) => s.leftPanelWidth)
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth)
  const timelineHeight = useUIStore((s) => s.timelineHeight)
  const setLeftWidth = useUIStore((s) => s.setLeftWidth)
  const setRightWidth = useUIStore((s) => s.setRightWidth)
  const setTimelineHeight = useUIStore((s) => s.setTimelineHeight)

  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const durationSec = useTimelineStore((s) => s.timeline.durationSec)
  const fps = useTimelineStore((s) => s.timeline.fps)
  const removeClips = useTimelineStore((s) => s.removeClips)
  const selectClips = useTimelineStore((s) => s.selectClips)
  const splitClip = useTimelineStore((s) => s.splitClip)
  const trimClipsLeftTo = useTimelineStore((s) => s.trimClipsLeftTo)
  const trimClipsRightTo = useTimelineStore((s) => s.trimClipsRightTo)
  const copyClips = useTimelineStore((s) => s.copyClips)
  const cutClips = useTimelineStore((s) => s.cutClips)
  const pasteClips = useTimelineStore((s) => s.pasteClips)
  const duplicateClips = useTimelineStore((s) => s.duplicateClips)
  const undo = useTimelineStore((s) => s.undo)
  const redo = useTimelineStore((s) => s.redo)
  const toggle = usePlaybackStore((s) => s.toggle)
  const seek = usePlaybackStore((s) => s.seek)
  const shortcuts = useShortcutStore((s) => s.shortcuts)

  // Global hotkeys
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const currentSec = usePlaybackStore.getState().currentSec
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      // Don't block shortcuts for range/checkbox inputs — only for text entry
      const inputType = tag === 'INPUT' ? (target as HTMLInputElement).type : ''
      const isEditing =
        (tag === 'INPUT' && inputType !== 'range' && inputType !== 'checkbox' && inputType !== 'color') ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable
      const pressed = (id: keyof typeof shortcuts) =>
        !!shortcuts[id] && shortcutMatchesEvent(shortcuts[id], e)

      if (pressed('toggleShortcuts')) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }

      if (shortcutsOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setShortcutsOpen(false)
        }
        return
      }

      if (isEditing) return

      if (pressed('undo')) {
        e.preventDefault()
        undo()
        return
      }
      if (pressed('redo')) {
        e.preventDefault()
        redo()
        return
      }
      if (pressed('copy') && selectedClipIds.length > 0) {
        e.preventDefault()
        copyClips(selectedClipIds)
        return
      }
      if (pressed('cut') && selectedClipIds.length > 0) {
        e.preventDefault()
        cutClips(selectedClipIds)
        return
      }
      if (pressed('paste')) {
        e.preventDefault()
        pasteClips(currentSec)
        return
      }
      if (pressed('duplicate') && selectedClipIds.length > 0) {
        e.preventDefault()
        duplicateClips(selectedClipIds)
        return
      }
      if (pressed('playPause')) {
        e.preventDefault()
        toggle()
        return
      }
      if (pressed('stepBackFrame')) {
        e.preventDefault()
        seek(Math.max(0, currentSec - 1 / Math.max(1, fps)))
        return
      }
      if (pressed('stepForwardFrame')) {
        e.preventDefault()
        seek(Math.min(Math.max(durationSec, 0), currentSec + 1 / Math.max(1, fps)))
        return
      }
      if (pressed('jumpStart')) {
        e.preventDefault()
        seek(0)
        return
      }
      if (pressed('jumpEnd')) {
        e.preventDefault()
        seek(Math.max(0, durationSec))
        return
      }
      if (pressed('delete') && selectedClipIds.length > 0) {
        e.preventDefault()
        removeClips(selectedClipIds)
        return
      }
      if (pressed('split')) {
        e.preventDefault()
        for (const id of selectedClipIds) splitClip(id, currentSec)
        if (selectedClipIds.length === 0) {
          const active = clips.filter((c) => {
            const dur = clipEffectiveDuration(c)
            return currentSec > c.startSec && currentSec < c.startSec + dur
          })
          for (const c of active) splitClip(c.id, currentSec)
        }
        return
      }
      if (pressed('trimStartToPlayhead') && selectedClipIds.length > 0) {
        e.preventDefault()
        trimClipsLeftTo(selectedClipIds, currentSec)
        return
      }
      if (pressed('trimEndToPlayhead') && selectedClipIds.length > 0) {
        e.preventDefault()
        trimClipsRightTo(selectedClipIds, currentSec)
        return
      }
      if (pressed('crop')) {
        const target = clips.find(
          (c) => selectedClipIds.includes(c.id) && c.assetId && !c.textData,
        )
        if (target) {
          e.preventDefault()
          useUIStore.getState().openCrop(target.id)
        }
        return
      }
      if (pressed('group') && selectedClipIds.length >= 2) {
        e.preventDefault()
        useTimelineStore.getState().groupClips(selectedClipIds)
        return
      }
      if (pressed('ungroup') && selectedClipIds.length > 0) {
        e.preventDefault()
        useTimelineStore.getState().ungroupClips(selectedClipIds)
        return
      }
      if (pressed('compound') && selectedClipIds.length > 0) {
        e.preventDefault()
        useTimelineStore.getState().createCompound(selectedClipIds)
        return
      }
      if (pressed('breakCompound') && selectedClipIds.length > 0) {
        e.preventDefault()
        useTimelineStore.getState().breakCompound(selectedClipIds)
        return
      }
      if (pressed('deselect')) {
        e.preventDefault()
        selectClips([])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selectedClipIds,
    clips,
    durationSec,
    fps,
    removeClips,
    selectClips,
    splitClip,
    trimClipsLeftTo,
    trimClipsRightTo,
    copyClips,
    cutClips,
    pasteClips,
    duplicateClips,
    toggle,
    seek,
    undo,
    redo,
    shortcuts,
    shortcutsOpen,
  ])

  const handleLeftDrag = useCallback(
    (delta: number) => setLeftWidth(leftPanelWidth + delta),
    [leftPanelWidth, setLeftWidth],
  )
  const handleRightDrag = useCallback(
    (delta: number) => setRightWidth(rightPanelWidth - delta),
    [rightPanelWidth, setRightWidth],
  )
  const handleTimelineDrag = useCallback(
    (delta: number) => setTimelineHeight(timelineHeight - delta),
    [timelineHeight, setTimelineHeight],
  )

  // Global file drop — import media dropped anywhere not handled by a
  // more specific target (media panel drop zone, timeline track).
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')

  const onRootDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setFileDragOver(true)
  }, [])

  const onRootDragLeave = useCallback((e: React.DragEvent) => {
    if (e.relatedTarget === null) setFileDragOver(false)
  }, [])

  const onRootDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setFileDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length) void importFiles(files)
    },
    [importFiles],
  )

  // Safety net: child drop targets (timeline tracks, media panel) call
  // stopPropagation, so the root onDrop above never runs when you drop there —
  // which left the "Drop to import media" overlay stuck. A capture-phase window
  // listener fires before any child's stopPropagation, so the overlay always
  // clears no matter where the drop (or a cancelled drag) ends.
  useEffect(() => {
    const clear = () => setFileDragOver(false)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    return () => {
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
    }
  }, [])

  return (
    <div
      ref={editorRootRef}
      className="relative flex h-full flex-col overflow-hidden bg-bg-0 text-text-1 select-none"
      onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave}
      onDrop={onRootDrop}
    >
      <TopBar onOpenShortcuts={() => setShortcutsOpen(true)} />

      <div className="flex flex-1 min-h-0 flex-col">
        <div className="flex flex-1 min-h-0">
          <aside
            style={{ width: leftPanelWidth }}
            className="shrink-0 flex flex-col border-r border-border bg-bg-1"
          >
            <MediaPanel />
          </aside>

          <ResizeHandle direction="vertical" onDrag={handleLeftDrag} />

          <section className="flex-1 min-w-0 flex flex-col bg-black">
            <Preview />
          </section>

          <ResizeHandle direction="vertical" onDrag={handleRightDrag} />

          <aside
            style={{ width: rightPanelWidth }}
            className="shrink-0 border-l border-border bg-bg-1"
          >
            <PropertiesPanel />
          </aside>
        </div>

        <ResizeHandle direction="horizontal" onDrag={handleTimelineDrag} />

        <section
          style={{ height: timelineHeight }}
          className="shrink-0 border-t border-border bg-bg-1"
        >
          <Timeline />
        </section>
      </div>

      {/* Global overlays */}
      <ContextMenu />
      <BackgroundTasks />
      <ReplaceDialog />
      <CropDialogHost />
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {/* Drag-to-import overlay */}
      {fileDragOver && (
        <div className="pointer-events-none absolute inset-0 z-[80] flex items-center justify-center bg-accent/10 backdrop-blur-[2px]">
          <div className="rounded-lg border-2 border-dashed border-accent bg-bg-1/90 px-8 py-6 text-center">
            <p className="text-sm font-medium text-text-1">Drop to import media</p>
            <p className="mt-1 text-xs text-text-3">Drop on a timeline track to add it directly</p>
          </div>
        </div>
      )}
    </div>
  )
}

/** Renders the visual crop/rotate dialog when a clip's crop is opened (from the
 *  timeline toolbar or the clip right-click menu). Resolves the clip + its asset
 *  from the stores so the trigger only needs to set a clip id. */
function CropDialogHost() {
  const cropClipId = useUIStore((s) => s.cropClipId)
  const closeCrop = useUIStore((s) => s.closeCrop)
  const clip = useTimelineStore((s) =>
    cropClipId ? s.timeline.clips.find((c) => c.id === cropClipId) : undefined,
  )
  const asset = useProjectStore((s) =>
    clip?.assetId ? s.assets.find((a) => a.id === clip.assetId) : undefined,
  )
  if (!clip || !asset || (asset.kind !== 'video' && asset.kind !== 'image')) return null
  return <CropDialog clip={clip} asset={asset} onClose={closeCrop} />
}
