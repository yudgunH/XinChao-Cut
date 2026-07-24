import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { isTauri, mediaManager, type MediaAsset, type MediaKind } from '@engine/media'
import { clipEffectiveDuration } from '@engine/timeline'
import { beginDesktopAssetPointerDrag } from '@engine/timeline/desktop-asset-drag'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'
import {
  countTimelineAssetReferences,
  countTimelineAssetReferencesMany,
} from '@lib/timeline-asset-references'

import { MediaCard } from './MediaCard'

interface MarqueeBox {
  left: number
  top: number
  width: number
  height: number
}

interface MarqueeDrag {
  startClientX: number
  startClientY: number
  startLocalX: number
  startLocalY: number
  initialIds: string[]
  additive: boolean
  didMove: boolean
  /** Pressed on a card (vs empty space): a no-move press must NOT clear the
   *  selection — the card's own onClick handles select. */
  startedOnCard: boolean
}

interface RectBounds {
  left: number
  right: number
  top: number
  bottom: number
}

const MARQUEE_THRESHOLD_PX = 4

function rectsIntersect(a: RectBounds, b: RectBounds): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function mergeIds(a: string[], b: string[]): string[] {
  return Array.from(new Set([...a, ...b]))
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

interface MediaGridProps {
  kind?: MediaKind
  emptyLabel?: string
  source?: 'project' | 'audio-library'
  libraryAssets?: MediaAsset[]
  onRemoveLibraryAsset?: (id: string) => Promise<void> | void
}

export function MediaGrid({
  kind,
  emptyLabel = 'No media yet',
  source = 'project',
  libraryAssets = [],
  onRemoveLibraryAsset,
}: MediaGridProps) {
  const projectId = useProjectStore((s) => s.id)
  const assets = useProjectStore((s) => s.assets)
  const setAssets = useProjectStore((s) => s.setAssets)
  const addAsset = useProjectStore((s) => s.addAsset)
  const selectedAssetIds = useProjectStore((s) => s.selectedAssetIds)
  const setSelectedAssetIds = useProjectStore((s) => s.setSelectedAssetIds)
  const removeAsset = useProjectStore((s) => s.removeAsset)
  const selectClips = useTimelineStore((s) => s.selectClips)
  const insertClip = useTimelineStore((s) => s.insertClip)
  const insertAudioClips = useTimelineStore((s) => s.insertAudioClips)
  const rootRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<MarqueeDrag | null>(null)
  const marqueeFrameRef = useRef<number | null>(null)
  const marqueeCleanupRef = useRef<(() => void) | null>(null)
  const lastSelectedRef = useRef<string | null>(null)
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)
  // Timeline-only assets (e.g. generated narration/music) back clips but
  // are NOT shown in the library grid — they'd clutter and lag a complex draft.
  const baseAssets = source === 'audio-library' ? libraryAssets : assets
  const visibleAssets = useMemo(() => {
    return baseAssets.filter(
      (a) =>
        !a.timelineOnly &&
        (!kind || a.kind === kind) &&
        (source === 'audio-library' || !projectId || a.projectId === projectId),
    )
  }, [baseAssets, kind, projectId, source])
  const assetIds = useMemo(() => visibleAssets.map((asset) => asset.id), [visibleAssets])
  const visibleAssetIdSet = useMemo(() => new Set(assetIds), [assetIds])
  const visibleSelectedAssetIds = useMemo(
    () => selectedAssetIds.filter((id) => visibleAssetIdSet.has(id)),
    [selectedAssetIds, visibleAssetIdSet],
  )

  useEffect(() => {
    if (!projectId) return undefined
    let cancelled = false
    if (source !== 'project') return undefined
    mediaManager.list(projectId).then((stored) => {
      if (cancelled) return
      const current = useProjectStore.getState().assets
      const referenced = current.filter((asset) => asset.projectId !== projectId)
      const merged = new Map<string, MediaAsset>()
      for (const asset of [...stored, ...referenced]) merged.set(asset.id, asset)
      setAssets(Array.from(merged.values()))
    })
    return () => {
      cancelled = true
    }
  }, [projectId, setAssets, source])

  const handleRemove = useCallback(
    async (id: string, knownReferences?: number) => {
      // While a compound is open, timelineState.timeline is only the live child
      // and the root lives in compoundStack. rootSnapshot walks that breadcrumb
      // back to the real root and flushes every in-progress child exactly once.
      let references = knownReferences
      if (references === undefined) {
        const { timeline, compounds } = useTimelineStore.getState().rootSnapshot()
        references = countTimelineAssetReferences(timeline, compounds, id)
      }
      if (references > 0) {
        useToastStore.getState().push(
          `Unable to delete this media because ${references} clips use it. ` +
            'Delete or replace those clips first.',
          'error',
        )
        return
      }
      if (source === 'audio-library') {
        try {
          await onRemoveLibraryAsset?.(id)
        } catch (error) {
          useToastStore.getState().push(
            error instanceof Error ? error.message : 'Unable to delete the asset from the library',
            'error',
          )
        }
        return
      }
      // Remove from the picker before the async OPFS delete so a second UI event
      // cannot insert a new clip in the check→delete gap. Roll back the card if
      // persistence fails.
      const removed = assets.find((asset) => asset.id === id)
      removeAsset(id)
      try {
        await mediaManager.remove(id)
      } catch (error) {
        if (removed) addAsset(removed)
        useToastStore.getState().push(
          error instanceof Error ? error.message : 'Unable to delete media',
          'error',
        )
      }
    },
    [addAsset, assets, onRemoveLibraryAsset, removeAsset, source],
  )

  const ensureProjectCanUseAsset = useCallback(
    (asset: MediaAsset) => {
      if (!assets.some((candidate) => candidate.id === asset.id)) addAsset(asset)
    },
    [addAsset, assets],
  )

  // Drag from the grid → carry the WHOLE selection when the grabbed card is part
  // of a multi-select (so dropping adds every selected media, not just one). The
  // single id stays for the drop-onto-clip "Replace" path.
  const handleCardDragStart = useCallback(
    (asset: MediaAsset, e: React.DragEvent) => {
      const ids =
        selectedAssetIds.includes(asset.id) && selectedAssetIds.length > 1
          ? selectedAssetIds
          : [asset.id]
      for (const id of ids) {
        const a = visibleAssets.find((x) => x.id === id) ?? assets.find((x) => x.id === id)
        if (a) ensureProjectCanUseAsset(a)
      }
      e.dataTransfer.setData('application/x-xinchao-asset-id', asset.id)
      e.dataTransfer.setData('application/x-xinchao-asset-ids', JSON.stringify(ids))
    },
    [assets, ensureProjectCanUseAsset, selectedAssetIds, visibleAssets],
  )

  const handleCardPointerDragStart = useCallback(
    (asset: MediaAsset, e: ReactPointerEvent<HTMLDivElement>) => {
      const ids =
        selectedAssetIds.includes(asset.id) && selectedAssetIds.length > 1
          ? selectedAssetIds
          : [asset.id]
      for (const id of ids) {
        const candidate = visibleAssets.find((item) => item.id === id)
          ?? assets.find((item) => item.id === id)
        if (candidate) ensureProjectCanUseAsset(candidate)
      }
      beginDesktopAssetPointerDrag(e.nativeEvent, ids)
    },
    [assets, ensureProjectCanUseAsset, selectedAssetIds, visibleAssets],
  )

  const selectMediaAssets = useCallback(
    (ids: string[]) => {
      if (!sameIds(useProjectStore.getState().selectedAssetIds, ids)) {
        setSelectedAssetIds(ids)
      }
      if (useTimelineStore.getState().selectedClipIds.length > 0) selectClips([])
    },
    [selectClips, setSelectedAssetIds],
  )

  // "+" on a card: append the asset to the end of its kind's content so each
  // click builds a sequence (audio → audio track, everything else → video).
  const handleAddToTimeline = useCallback(
    (id: string) => {
      const asset = assets.find((a) => a.id === id)
        ?? visibleAssets.find((a) => a.id === id)
      if (!asset) return
      ensureProjectCanUseAsset(asset)
      const { timeline } = useTimelineStore.getState()
      const dur = Math.max(0.1, asset.durationSec || 5)
      const kindOf = (trackId: string) =>
        timeline.tracks.find((t) => t.id === trackId)?.kind
      const endOf = (kind: string) =>
        timeline.clips
          .filter((c) => kindOf(c.trackId) === kind)
          .reduce((m, c) => Math.max(m, c.startSec + clipEffectiveDuration(c)), 0)

      if (asset.kind === 'audio') {
        insertAudioClips([{ assetId: id, startSec: endOf('audio'), durationSec: dur }])
      } else {
        const videoTrack = timeline.tracks.find((t) => t.kind === 'video')
        insertClip({
          trackId: videoTrack?.id ?? '',
          assetId: id,
          startSec: endOf('video'),
          durationSec: dur,
        })
      }
    },
    [assets, ensureProjectCanUseAsset, insertClip, insertAudioClips, visibleAssets],
  )

  useEffect(() => {
    if (visibleSelectedAssetIds.length === 0) return undefined

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return

      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      // A timeline clip is selected → Delete means "delete the clip"; leave the
      // media library alone (otherwise a stale media selection got wiped too,
      // deleting source media when the user only meant to delete a clip).
      if (useTimelineStore.getState().selectedClipIds.length > 0) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      const ids = [...visibleSelectedAssetIds]
      const { timeline, compounds } = useTimelineStore.getState().rootSnapshot()
      const references = countTimelineAssetReferencesMany(timeline, compounds, ids)
      // Bound concurrent OPFS/IndexedDB deletes. Hundreds of simultaneous
      // transactions can starve preview/autosave even though each delete is async.
      let cursor = 0
      const worker = async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++]
          if (id) await handleRemove(id, references.get(id) ?? 0)
        }
      }
      void Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [handleRemove, visibleSelectedAssetIds])

  const selectedFromViewportRect = useCallback(
    (selectionRect: RectBounds, initialIds: string[], additive: boolean) => {
      const root = rootRef.current
      if (!root) return
      const hitIds = Array.from(root.querySelectorAll<HTMLElement>('[data-media-asset-id]'))
        .filter((el) => rectsIntersect(selectionRect, el.getBoundingClientRect()))
        .map((el) => el.dataset.mediaAssetId)
        .filter((id): id is string => !!id)
      selectMediaAssets(additive ? mergeIds(initialIds, hitIds) : hitIds)
    },
    [selectMediaAssets],
  )

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const root = rootRef.current
      if (!root) return
      const cardEl = (e.target as HTMLElement).closest<HTMLElement>('[data-media-asset-id]')
      const cardId = cardEl?.dataset.mediaAssetId
      // Pressing an already-selected card → let the native drag-to-timeline run
      // (the card is draggable only when selected). Empty space or an UNselected
      // card → begin a marquee so rubber-band selection is easy.
      if (cardId && selectedAssetIds.includes(cardId)) return

      e.preventDefault()
      const selectionRoot: HTMLDivElement = root
      const rootRect = selectionRoot.getBoundingClientRect()
      const additive = e.ctrlKey || e.metaKey || e.shiftKey
      const drag: MarqueeDrag = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startLocalX: e.clientX - rootRect.left,
        startLocalY: e.clientY - rootRect.top,
        initialIds: visibleSelectedAssetIds,
        additive,
        didMove: false,
        startedOnCard: !!cardEl,
      }
      marqueeRef.current = drag

      // A tab switch during an earlier drag can otherwise leave document
      // listeners alive. Tear down the previous gesture before starting.
      marqueeCleanupRef.current?.()

      let pendingClientX = e.clientX
      let pendingClientY = e.clientY

      function applyPendingMove() {
        marqueeFrameRef.current = null
        const active = marqueeRef.current
        if (!active) return
        const nextRootRect = selectionRoot.getBoundingClientRect()
        const currentLocalX = pendingClientX - nextRootRect.left
        const currentLocalY = pendingClientY - nextRootRect.top
        const left = Math.min(active.startLocalX, currentLocalX)
        const top = Math.min(active.startLocalY, currentLocalY)
        const width = Math.abs(currentLocalX - active.startLocalX)
        const height = Math.abs(currentLocalY - active.startLocalY)
        setMarquee((current) =>
          current &&
          current.left === left &&
          current.top === top &&
          current.width === width &&
          current.height === height
            ? current
            : { left, top, width, height },
        )

        const viewportRect = {
          left: Math.min(active.startClientX, pendingClientX),
          right: Math.max(active.startClientX, pendingClientX),
          top: Math.min(active.startClientY, pendingClientY),
          bottom: Math.max(active.startClientY, pendingClientY),
        }
        selectedFromViewportRect(viewportRect, active.initialIds, active.additive)
      }

      function onMove(me: MouseEvent) {
        const active = marqueeRef.current
        if (!active) return
        const dx = me.clientX - active.startClientX
        const dy = me.clientY - active.startClientY
        if (!active.didMove && Math.hypot(dx, dy) < MARQUEE_THRESHOLD_PX) return
        active.didMove = true
        pendingClientX = me.clientX
        pendingClientY = me.clientY
        if (marqueeFrameRef.current === null) {
          marqueeFrameRef.current = window.requestAnimationFrame(applyPendingMove)
        }
      }

      function cleanupGesture() {
        if (marqueeFrameRef.current !== null) {
          window.cancelAnimationFrame(marqueeFrameRef.current)
          marqueeFrameRef.current = null
        }
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (marqueeCleanupRef.current === cleanupGesture) marqueeCleanupRef.current = null
      }

      function onUp() {
        const active = marqueeRef.current
        marqueeRef.current = null
        setMarquee(null)
        cleanupGesture()
        // Plain click on EMPTY space clears the selection; a click on a card is
        // left to the card's onClick (so it selects instead of clearing).
        if (active && !active.didMove && !active.additive && !active.startedOnCard) {
          setSelectedAssetIds([])
        }
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      marqueeCleanupRef.current = cleanupGesture
    },
    [selectedAssetIds, selectedFromViewportRect, setSelectedAssetIds, visibleSelectedAssetIds],
  )

  useEffect(() => () => {
    marqueeRef.current = null
    marqueeCleanupRef.current?.()
  }, [])

  function handleSelectAsset(id: string, e: ReactMouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    if (e.shiftKey && lastSelectedRef.current) {
      const from = assetIds.indexOf(lastSelectedRef.current)
      const to = assetIds.indexOf(id)
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from]
        const range = assetIds.slice(start, end + 1)
        selectMediaAssets(e.ctrlKey || e.metaKey ? mergeIds(selectedAssetIds, range) : range)
        return
      }
    }

    if (e.ctrlKey || e.metaKey) {
      selectMediaAssets(
        selectedAssetIds.includes(id)
          ? selectedAssetIds.filter((assetId) => assetId !== id)
          : [...selectedAssetIds, id],
      )
    } else {
      selectMediaAssets([id])
    }
    lastSelectedRef.current = id
  }

  if (visibleAssets.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <div className="grid aspect-video place-items-center rounded bg-bg-2 text-2xs text-text-3">
          {emptyLabel}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      role="listbox"
      aria-multiselectable="true"
      className="relative min-h-40 flex-1"
      onMouseDown={handleMouseDown}
    >
      <div className="grid grid-cols-2 gap-2">
        {visibleAssets.map((asset) => (
          <MediaCard
            key={asset.id}
            asset={asset}
            selected={selectedAssetIds.includes(asset.id)}
            onSelect={handleSelectAsset}
            onRemove={handleRemove}
            onAddToTimeline={handleAddToTimeline}
            onDragStart={handleCardDragStart}
            onPointerDragStart={handleCardPointerDragStart}
            desktopPointerDrag={isTauri()}
          />
        ))}
      </div>
      {marquee && (
        <div
          className="pointer-events-none absolute z-20 border border-tl-accent bg-tl-accent/15"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}
    </div>
  )
}
