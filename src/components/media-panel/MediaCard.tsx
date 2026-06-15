import { Film, Music, Image as ImageIcon, X, Zap } from 'lucide-react'
import type { MouseEvent } from 'react'

import type { MediaAsset } from '@engine/media'
import { formatTimecode } from '@engine/core/time'
import { useProxyStore } from '@store/proxy-store'

interface MediaCardProps {
  asset: MediaAsset
  selected?: boolean
  onSelect?: (id: string, e: MouseEvent<HTMLDivElement>) => void
  onRemove?: (id: string) => void
}

const KIND_ICON = {
  video: Film,
  audio: Music,
  image: ImageIcon,
}

export function MediaCard({ asset, selected = false, onSelect, onRemove }: MediaCardProps) {
  const Icon = KIND_ICON[asset.kind]
  const duration = asset.durationSec > 0 ? formatTimecode(asset.durationSec, 30) : '--'
  const isPortrait = !!asset.width && !!asset.height && asset.height > asset.width

  const proxy = useProxyStore((s) => s.status[asset.id])
  const proxyRunning = proxy?.state === 'running'
  const hasProxy = !!asset.proxyStorageKey || proxy?.state === 'done'

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
      draggable
      onDragStart={(e) => e.dataTransfer.setData('application/x-xinchao-asset-id', asset.id)}
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

      {/* Proxy badge (top-left) */}
      {proxyRunning ? (
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
    </div>
  )
}
