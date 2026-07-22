import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { formatTimecode } from '@engine/core/time'
import { useProjectStore } from '@store/project-store'
import { useReplaceStore } from '@store/replace-store'
import { useTimelineStore } from '@store/timeline-store'

/** CapCut-style "Replace": drop a (longer) asset onto a clip to swap its source.
 *  A filmstrip lets the user choose where in the new source to start; the clip
 *  keeps its timeline position and duration. */
export function ReplaceDialog() {
  const request = useReplaceStore((s) => s.request)
  // Remount per request so all local in-point state resets cleanly.
  return request ? <ReplaceDialogInner key={request.clipId + request.assetId} /> : null
}

function ReplaceDialogInner() {
  const request = useReplaceStore((s) => s.request)!
  const close = useReplaceStore((s) => s.closeReplace)
  const asset = useProjectStore((s) => s.assets.find((a) => a.id === request.assetId))
  const clip = useTimelineStore((s) => s.timeline.clips.find((c) => c.id === request.clipId))
  const replaceClipSource = useTimelineStore((s) => s.replaceClipSource)

  const span = clip ? clip.outPointSec - clip.inPointSec : 0
  const assetDur = asset?.durationSec ?? 0
  const maxIn = Math.max(0, assetDur - span)
  const [inPoint, setInPoint] = useState(() => Math.min(clip?.inPointSec ?? 0, maxIn))
  const [keepEffects, setKeepEffects] = useState(true)
  const stripRef = useRef<HTMLDivElement>(null)

  if (!asset || !clip) return null

  const strip = asset.thumbnailStrip?.filter(Boolean) ?? []
  const isPortrait = !!asset.width && !!asset.height && asset.height > asset.width

  const frameAt = (sec: number): string | undefined => {
    if (strip.length === 0) return asset.thumbnailDataUrl
    const t = assetDur > 0 ? Math.max(0, Math.min(1, sec / assetDur)) : 0
    return strip[Math.round(t * (strip.length - 1))]
  }
  const previewSrc = frameAt(inPoint + span / 2)

  function pointerToIn(clientX: number): number {
    const el = stripRef.current
    if (!el) return inPoint
    const rect = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    // Centre the selection window on the cursor.
    return Math.max(0, Math.min(maxIn, frac * assetDur - span / 2))
  }

  function onStripPointerDown(e: React.PointerEvent) {
    e.preventDefault()
    setInPoint(pointerToIn(e.clientX))
    const move = (me: PointerEvent) => setInPoint(pointerToIn(me.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const winLeftPct = assetDur > 0 ? (inPoint / assetDur) * 100 : 0
  const winWidthPct = assetDur > 0 ? Math.min(100, (span / assetDur) * 100) : 100
  const thumbs = strip.length ? strip : [asset.thumbnailDataUrl]

  function onReplace() {
    replaceClipSource(clip!.id, asset!.id, inPoint, keepEffects)
    close()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60"
      onMouseDown={close}
    >
      <div
        className="w-[380px] rounded-lg border border-border-strong bg-bg-1 p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-text-1">Replace</h2>
          <button
            onClick={close}
            className="rounded p-1 text-text-3 hover:bg-bg-3 hover:text-text-1"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Preview frame at the chosen in-point */}
        <div className="mb-3 grid aspect-video place-items-center overflow-hidden rounded bg-black">
          {previewSrc ? (
            <img
              src={previewSrc}
              alt=""
              className={isPortrait ? 'h-full w-auto object-contain' : 'h-full w-full object-contain'}
              draggable={false}
            />
          ) : (
            <span className="px-2 text-center text-xs text-text-3">{asset.name}</span>
          )}
        </div>

        {/* Filmstrip scrubber — drag to choose where the new source starts */}
        <div
          ref={stripRef}
          onPointerDown={onStripPointerDown}
          className="relative mb-1 flex h-12 cursor-ew-resize overflow-hidden rounded bg-bg-2 select-none"
        >
          <div className="pointer-events-none absolute inset-0 flex">
            {thumbs.map((src, i) =>
              src ? (
                <img
                  key={i}
                  src={src}
                  className="h-full object-cover"
                  style={{ width: `${100 / thumbs.length}%` }}
                  draggable={false}
                  alt=""
                />
              ) : (
                <div key={i} style={{ width: `${100 / thumbs.length}%` }} />
              ),
            )}
          </div>
          {/* Dim the parts outside the selection window */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 bg-black/60"
            style={{ width: `${winLeftPct}%` }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-black/60"
            style={{ left: `${winLeftPct + winWidthPct}%` }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 rounded-sm border-2 border-tl-accent"
            style={{ left: `${winLeftPct}%`, width: `${winWidthPct}%` }}
          />
        </div>
        <div className="mb-3 text-center font-mono text-2xs text-text-2">
          {formatTimecode(inPoint, 30)} · {formatTimecode(span, 30)}
        </div>

        {/* Options + actions */}
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-text-2">
            <input
              type="checkbox"
              checked={keepEffects}
              onChange={(e) => setKeepEffects(e.target.checked)}
              className="accent-tl-accent"
            />
            Use the original video effect
          </label>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={onReplace}
              className="rounded bg-tl-accent px-3 py-1.5 text-xs font-medium text-black hover:brightness-110"
            >
              Replace clip
            </button>
            <button
              onClick={close}
              className="rounded bg-bg-3 px-3 py-1.5 text-xs text-text-1 hover:bg-bg-2"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
