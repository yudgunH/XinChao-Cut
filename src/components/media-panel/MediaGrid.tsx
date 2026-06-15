import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'

import { mediaManager } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'

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

export function MediaGrid() {
  const projectId = useProjectStore((s) => s.id)
  const assets = useProjectStore((s) => s.assets)
  const setAssets = useProjectStore((s) => s.setAssets)
  const selectedAssetIds = useProjectStore((s) => s.selectedAssetIds)
  const setSelectedAssetIds = useProjectStore((s) => s.setSelectedAssetIds)
  const removeAsset = useProjectStore((s) => s.removeAsset)
  const selectClips = useTimelineStore((s) => s.selectClips)
  const rootRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<MarqueeDrag | null>(null)
  const lastSelectedRef = useRef<string | null>(null)
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null)
  const assetIds = useMemo(() => assets.map((asset) => asset.id), [assets])

  useEffect(() => {
    if (!projectId) return undefined
    let cancelled = false
    mediaManager.list(projectId).then((stored) => {
      if (!cancelled) setAssets(stored)
    })
    return () => {
      cancelled = true
    }
  }, [projectId, setAssets])

  async function handleRemove(id: string) {
    await mediaManager.remove(id)
    removeAsset(id)
  }

  const selectMediaAssets = useCallback(
    (ids: string[]) => {
      setSelectedAssetIds(ids)
      selectClips([])
    },
    [selectClips, setSelectedAssetIds],
  )

  useEffect(() => {
    if (selectedAssetIds.length === 0) return undefined

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return

      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      const ids = [...selectedAssetIds]
      void Promise.all(
        ids.map(async (id) => {
          await mediaManager.remove(id)
          removeAsset(id)
        }),
      )
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [removeAsset, selectedAssetIds])

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
      if ((e.target as HTMLElement).closest('[data-media-asset-id]')) return

      e.preventDefault()
      const selectionRoot: HTMLDivElement = root
      const rootRect = selectionRoot.getBoundingClientRect()
      const additive = e.ctrlKey || e.metaKey || e.shiftKey
      const drag: MarqueeDrag = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startLocalX: e.clientX - rootRect.left,
        startLocalY: e.clientY - rootRect.top,
        initialIds: selectedAssetIds,
        additive,
        didMove: false,
      }
      marqueeRef.current = drag

      function onMove(me: MouseEvent) {
        const active = marqueeRef.current
        if (!active) return
        const dx = me.clientX - active.startClientX
        const dy = me.clientY - active.startClientY
        if (!active.didMove && Math.hypot(dx, dy) < MARQUEE_THRESHOLD_PX) return
        active.didMove = true

        const nextRootRect = selectionRoot.getBoundingClientRect()
        const currentLocalX = me.clientX - nextRootRect.left
        const currentLocalY = me.clientY - nextRootRect.top
        const left = Math.min(active.startLocalX, currentLocalX)
        const top = Math.min(active.startLocalY, currentLocalY)
        const width = Math.abs(currentLocalX - active.startLocalX)
        const height = Math.abs(currentLocalY - active.startLocalY)
        setMarquee({ left, top, width, height })

        const viewportRect = {
          left: Math.min(active.startClientX, me.clientX),
          right: Math.max(active.startClientX, me.clientX),
          top: Math.min(active.startClientY, me.clientY),
          bottom: Math.max(active.startClientY, me.clientY),
        }
        selectedFromViewportRect(viewportRect, active.initialIds, active.additive)
      }

      function onUp() {
        const active = marqueeRef.current
        marqueeRef.current = null
        setMarquee(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (active && !active.didMove && !active.additive) setSelectedAssetIds([])
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [selectedAssetIds, selectedFromViewportRect, setSelectedAssetIds],
  )

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

  if (assets.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-2">
        <div className="grid aspect-video place-items-center rounded bg-bg-2 text-2xs text-text-3">
          No media yet
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
        {assets.map((asset) => (
          <MediaCard
            key={asset.id}
            asset={asset}
            selected={selectedAssetIds.includes(asset.id)}
            onSelect={handleSelectAsset}
            onRemove={handleRemove}
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
