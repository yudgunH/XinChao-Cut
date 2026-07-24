import { Film, Music, Image as ImageIcon, Plus, X, Zap } from 'lucide-react'
import type { DragEvent, MouseEvent, PointerEvent } from 'react'

import { isAudioCapableProxyKey, type MediaAsset } from '@engine/media'
import { formatTimecode } from '@engine/core/time'
import { useProxyStore } from '@store/proxy-store'

interface MediaCardProps {
  asset: MediaAsset
  selected?: boolean
  onSelect?: (id: string, e: MouseEvent<HTMLDivElement>) => void
  onRemove?: (id: string) => void
  onAddToTimeline?: (id: string) => void
  onDragStart?: (asset: MediaAsset, e: DragEvent<HTMLDivElement>) => void
  onPointerDragStart?: (asset: MediaAsset, e: PointerEvent<HTMLDivElement>) => void
  desktopPointerDrag?: boolean
}

const KIND_ICON = {
  video: Film,
  audio: Music,
  image: ImageIcon,
}

export function MediaCard({
  asset,
  selected = false,
  onSelect,
  onRemove,
  onAddToTimeline,
  onDragStart,
  onPointerDragStart,
  desktopPointerDrag = false,
}: MediaCardProps) {
  const Icon = KIND_ICON[asset.kind]
  const duration = asset.durationSec > 0 ? formatTimecode(asset.durationSec, 30) : '--'
  const isPortrait = !!asset.width && !!asset.height && asset.height > asset.width

  const proxy = useProxyStore((s) => s.status[asset.id])
  const proxyRunning = proxy?.state === 'running'
  const hasProxy = isAudioCapableProxyKey(asset.proxyStorageKey) || proxy?.state === 'done'
  const normalizing =
    asset.normalizationStatus === 'queued' || asset.normalizationStatus === 'running'

  return (
    <div
      data-media-asset-id={asset.id}
      role="option"
      aria-selected={selected}
      className={`group relative aspect-video overflow-hidden rounded bg-bg-2 ${
        selected
          ? 'ring-2 ring-tl-accent shadow-[0_0_0_1px_rgba(0,216,214,0.25)]'
          : 'ring-1 ring-border hover:ring-border-strong'
      }`}
      // Only a SELECTED card starts a native drag-to-timeline; an unselected
      // card lets a marquee (rubber-band) begin on top of it so multi-select is
      // easy. Click once to select, then drag — or use the "+" button.
      draggable={selected && !desktopPointerDrag}
      onDragStart={(e) => onDragStart?.(asset, e)}
      onPointerDown={(e) => {
        if (selected && desktopPointerDrag) onPointerDragStart?.(asset, e)
      }}
      onClick={(e) => onSelect?.(asset.id, e)}
      title={asset.name}
    >
      {selected && <div className="pointer-events-none absolute inset-0 z-10 bg-tl-accent/10" />}

      {asset.thumbnailDataUrl ? (
        <img
          src={asset.thumbnailDataUrl}
          alt={asset.name}
          // Portrait media: contain so you see pillarbox bars on both sides
          className={
            isPortrait ? 'h-full w-full bg-black object-contain' : 'h-full w-full object-cover'
          }
          draggable={false}
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <Icon size={24} className="text-text-3" />
        </div>
      )}

      {/* Browser-safe normalization badge (top-left) */}
      {normalizing ? (
        <span
          className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-accent"
          title="Backend is preparing a browser-safe H.264 source"
        >
          <Zap size={10} className="animate-pulse" />
          Normalizing… {Math.round(asset.normalizationProgress ?? 0)}%
        </span>
      ) : proxyRunning ? (
        <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-accent">
          <Zap size={10} className="animate-pulse" />
          Proxy {Math.round(proxy.pct)}%
        </span>
      ) : hasProxy ? (
        <span
          className="absolute left-1 top-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-success"
          title="Preview proxy ready"
        >
          <Zap size={10} />
          Proxy
        </span>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1">
        <span className="truncate text-2xs text-text-1">{asset.name}</span>
        <span className="ml-1 shrink-0 font-mono text-2xs text-text-2">{duration}</span>
      </div>

      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove(asset.id)
          }}
          className="absolute right-1 top-1 hidden rounded bg-black/60 p-0.5 text-text-1 hover:bg-danger group-hover:block"
          aria-label="Remove"
        >
          <X size={12} />
        </button>
      )}

      {/* Add-to-timeline (CapCut-style "+") — appends the asset to the timeline */}
      {onAddToTimeline && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onAddToTimeline(asset.id)
          }}
          className="absolute bottom-1 right-1 z-20 hidden h-5 w-5 place-items-center rounded-full bg-tl-accent text-black shadow-md hover:brightness-110 group-hover:grid"
          title="Add to timeline"
          aria-label="Add to timeline"
        >
          <Plus size={13} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
