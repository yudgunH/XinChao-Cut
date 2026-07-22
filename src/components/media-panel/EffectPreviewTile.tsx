import { Check, X } from 'lucide-react'

import type { ClipEffectType } from '@engine/timeline'

// Full literal class strings so Tailwind's JIT keeps these animations.
const PREVIEW_ANIM: Record<ClipEffectType, string> = {
  'zoom-in': 'group-hover:animate-zoom-in-preview',
  'zoom-out': 'group-hover:animate-zoom-out-preview',
  'pan-left': 'group-hover:animate-pan-left-preview',
  'pan-right': 'group-hover:animate-pan-right-preview',
  pulse: 'group-hover:animate-pulse-preview',
  tilt: 'group-hover:animate-tilt-preview',
  'fade-in': 'group-hover:animate-fade-in-preview',
  'fade-out': 'group-hover:animate-fade-out-preview',
  'slide-in-left': 'group-hover:animate-slide-in-left-preview',
  'slide-out-right': 'group-hover:animate-slide-out-right-preview',
  'rise-in': 'group-hover:animate-rise-in-preview',
  'drop-out': 'group-hover:animate-drop-out-preview',
}

interface EffectPreviewTileProps {
  type: ClipEffectType
  label: string
  applied?: boolean
  appliedLabel?: string
  disabled?: boolean
  onApply: () => void
  onRemove?: () => void
}

/**
 * A react-video-editor-style preview tile: a small "scene" (a gradient card on
 * a black backdrop) that animates the effect when you hover the tile, with the
 * effect name below. Click to apply; an ✕ appears on hover when applied.
 */
export function EffectPreviewTile({
  type,
  label,
  applied = false,
  appliedLabel,
  disabled = false,
  onApply,
  onRemove,
}: EffectPreviewTileProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onApply}
        disabled={disabled}
        title={label}
        aria-label={`Apply ${label}`}
        className={`group relative aspect-square w-full overflow-hidden rounded-lg border transition-colors ${
          applied
            ? 'border-accent ring-1 ring-accent'
            : 'border-border hover:border-accent/70'
        } ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
      >
        {/* Preview scene — gradient card on black; animates on hover */}
        <div className="absolute inset-0 grid place-items-center bg-black">
          <div
            className={`h-3/5 w-3/5 rounded-md bg-gradient-to-br from-accent via-fuchsia-500 to-amber-400 ${PREVIEW_ANIM[type]}`}
          />
        </div>

        {/* Hover hint overlay */}
        <div className="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />

        {applied && (
          <span className="absolute left-1 top-1 z-10 grid h-4 w-4 place-items-center rounded-full bg-accent text-white shadow">
            <Check size={11} />
          </span>
        )}
        {applied && onRemove && (
          <span
            role="button"
            tabIndex={0}
            title="Remove effect"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onRemove()
              }
            }}
            className="absolute right-1 top-1 z-10 hidden h-4 w-4 place-items-center rounded-full bg-black/70 text-text-2 hover:text-danger group-hover:grid"
          >
            <X size={11} />
          </span>
        )}
      </button>

      <span className="truncate text-center text-2xs font-medium text-text-1">{label}</span>
      {applied && appliedLabel && (
        <span className="-mt-1 text-center text-[10px] text-accent">{appliedLabel}</span>
      )}
    </div>
  )
}
