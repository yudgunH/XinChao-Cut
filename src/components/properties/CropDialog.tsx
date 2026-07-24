import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RotateCw, X } from 'lucide-react'

import { mediaManager, type MediaAsset } from '@engine/media'
import { clipSourceSec, type Clip } from '@engine/timeline'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'

/** Kept region of the SOURCE frame in normalised coords (0..1). Mirrors how
 *  ClipTransform.crop is stored: l/t/r/b are the fractions trimmed off each side,
 *  so x0=l, y0=t, x1=1-r, y1=1-b. */
interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

const MIN = 0.05 // smallest crop fraction, so a region never collapses to a line

const ASPECTS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
  { label: '16:9', value: 16 / 9 },
  { label: '4:5', value: 4 / 5 },
  { label: '4:3', value: 4 / 3 },
  { label: '21:9', value: 21 / 9 },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function cropToRect(crop?: { l: number; r: number; t: number; b: number }): Rect {
  const c = crop ?? { l: 0, r: 0, t: 0, b: 0 }
  return { x0: c.l, y0: c.t, x1: 1 - c.r, y1: 1 - c.b }
}

interface Source {
  url: string
  w: number
  h: number
  kind: 'video' | 'image'
}

/**
 * CapCut-style visual crop: drag the 8 handles (or the body) over the source
 * frame, lock to an aspect ratio, and rotate. Crop is applied to the UNROTATED
 * source (matching the render order crop→rotate), so the frame + crop rect are
 * rotated together for preview while the rect math stays in source space.
 * Commits crop + rotation on Confirm as a single undo step.
 */
export function CropDialog({
  clip,
  asset,
  onClose,
}: {
  clip: Clip
  asset: MediaAsset
  onClose: () => void
}) {
  const setClipCrop = useTimelineStore((s) => s.setClipCrop)
  const setClipTransform = useTimelineStore((s) => s.setClipTransform)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)

  const [rect, setRect] = useState<Rect>(() => cropToRect(clip.transform.crop))
  const [rotation, setRotation] = useState(clip.transform.rotation ?? 0)
  const [aspect, setAspect] = useState<number | null>(null)
  const [src, setSrc] = useState<Source | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ handle: Handle; start: Rect; px: number; py: number } | null>(null)

  // Load the original (not the proxy — crop is on the full frame) and, for video,
  // seek to the frame under the playhead so you crop what you actually see.
  useEffect(() => {
    let revoked: string | null = null
    let alive = true
    void mediaManager.getObjectUrl(asset.id).then((url) => {
      if (!url || !alive) {
        if (url) URL.revokeObjectURL(url)
        return
      }
      revoked = url
      if (asset.kind === 'image') {
        const img = new Image()
        img.onload = () => {
          if (alive) setSrc({ url, w: img.naturalWidth || 1, h: img.naturalHeight || 1, kind: 'image' })
        }
        img.src = url
      } else {
        const v = document.createElement('video')
        v.muted = true
        v.preload = 'metadata'
        v.onloadeddata = () => {
          if (alive) setSrc({ url, w: v.videoWidth || 1, h: v.videoHeight || 1, kind: 'video' })
        }
        v.src = url
        const at = usePlaybackStore.getState().currentSec
        v.currentTime = Math.max(0, clipSourceSec(clip, at))
      }
    })
    return () => {
      alive = false
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [asset.id, asset.kind, clip])

  // Aspect of the source pixels — needed to convert an output (cropped) aspect
  // ratio into the normalised width/height ratio of the rect in source space.
  const srcAspect = src ? src.w / src.h : 16 / 9

  function applyAspect(r: Rect, handle: Handle): Rect {
    if (aspect == null || handle === 'move') return r
    // desired (x-span)/(y-span) in source-normalised coords
    const k = aspect / srcAspect
    const cx = (r.x0 + r.x1) / 2
    const cy = (r.y0 + r.y1) / 2
    const horizontal = handle.includes('e') || handle.includes('w')
    let w = r.x1 - r.x0
    let h = r.y1 - r.y0
    if (horizontal) {
      h = w / k
    } else {
      w = h * k
    }
    // Anchor: opposite corner for corners, the moved edge for edges (grow inward
    // from the fixed side; centre the perpendicular axis).
    let x0 = r.x0
    let y0 = r.y0
    if (handle === 'nw' || handle === 'sw' || handle === 'w') x0 = r.x1 - w
    else if (handle === 'ne' || handle === 'se' || handle === 'e') x0 = r.x0
    else x0 = cx - w / 2
    if (handle === 'nw' || handle === 'ne' || handle === 'n') y0 = r.y1 - h
    else if (handle === 'sw' || handle === 'se' || handle === 's') y0 = r.y0
    else y0 = cy - h / 2
    return { x0, y0, x1: x0 + w, y1: y0 + h }
  }

  function onPointerDown(e: React.PointerEvent, handle: Handle) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { handle, start: rect, px: e.clientX, py: e.clientY }
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    const box = boxRef.current
    if (!drag || !box) return
    const bw = box.clientWidth || 1
    const bh = box.clientHeight || 1
    // The box is CSS-rotated, so a screen-space drag must be rotated back into the
    // box's local axes before it maps to crop edges (identity at rotation 0).
    const rawX = (e.clientX - drag.px) / bw
    const rawY = (e.clientY - drag.py) / bh
    const rad = (-rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = rawX * cos - rawY * sin
    const dy = rawX * sin + rawY * cos
    const s = drag.start
    let next: Rect = { ...s }

    if (drag.handle === 'move') {
      const w = s.x1 - s.x0
      const h = s.y1 - s.y0
      const nx = clamp(s.x0 + dx, 0, 1 - w)
      const ny = clamp(s.y0 + dy, 0, 1 - h)
      next = { x0: nx, y0: ny, x1: nx + w, y1: ny + h }
    } else {
      if (drag.handle.includes('w')) next.x0 = clamp(s.x0 + dx, 0, s.x1 - MIN)
      if (drag.handle.includes('e')) next.x1 = clamp(s.x1 + dx, s.x0 + MIN, 1)
      if (drag.handle.includes('n')) next.y0 = clamp(s.y0 + dy, 0, s.y1 - MIN)
      if (drag.handle.includes('s')) next.y1 = clamp(s.y1 + dy, s.y0 + MIN, 1)
      next = applyAspect(next, drag.handle)
      // Keep the ratio-corrected rect inside the frame.
      next = {
        x0: clamp(next.x0, 0, 1 - MIN),
        y0: clamp(next.y0, 0, 1 - MIN),
        x1: clamp(next.x1, MIN, 1),
        y1: clamp(next.y1, MIN, 1),
      }
    }
    setRect(next)
  }

  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
      dragRef.current = null
    }
  }

  function confirm() {
    beginHistoryStep()
    setClipCrop(clip.id, {
      l: clamp(rect.x0, 0, 0.95),
      t: clamp(rect.y0, 0, 0.95),
      r: clamp(1 - rect.x1, 0, 0.95),
      b: clamp(1 - rect.y1, 0, 0.95),
    })
    setClipTransform(clip.id, { rotation })
    onClose()
  }

  function reset() {
    setRect({ x0: 0, y0: 0, x1: 1, y1: 1 })
    setRotation(0)
    setAspect(null)
  }

  // Percent geometry for the overlay rect.
  const pct = {
    left: `${rect.x0 * 100}%`,
    top: `${rect.y0 * 100}%`,
    width: `${(rect.x1 - rect.x0) * 100}%`,
    height: `${(rect.y1 - rect.y0) * 100}%`,
  }
  const HANDLES: { h: Handle; style: React.CSSProperties; cursor: string }[] = [
    { h: 'nw', style: { left: 0, top: 0 }, cursor: 'nwse-resize' },
    { h: 'n', style: { left: '50%', top: 0 }, cursor: 'ns-resize' },
    { h: 'ne', style: { left: '100%', top: 0 }, cursor: 'nesw-resize' },
    { h: 'e', style: { left: '100%', top: '50%' }, cursor: 'ew-resize' },
    { h: 'se', style: { left: '100%', top: '100%' }, cursor: 'nwse-resize' },
    { h: 's', style: { left: '50%', top: '100%' }, cursor: 'ns-resize' },
    { h: 'sw', style: { left: 0, top: '100%' }, cursor: 'nesw-resize' },
    { h: 'w', style: { left: 0, top: '50%' }, cursor: 'ew-resize' },
  ]

  return createPortal(
    <div
      className="fixed inset-0 z-[92] flex items-center justify-center bg-black/80"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[92vh] w-[min(900px,92vw)] flex-col rounded-lg border border-border-strong bg-bg-1 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-medium text-text-1">Crop</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stage */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-6">
          {src ? (
            <div
              ref={boxRef}
              className="relative select-none"
              style={{
                aspectRatio: `${src.w} / ${src.h}`,
                width: `min(100%, calc(62vh * ${src.w / src.h}))`,
                transform: `rotate(${rotation}deg)`,
              }}
            >
              {src.kind === 'image' ? (
                <img
                  src={src.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none h-full w-full object-fill"
                />
              ) : (
                <video
                  src={src.url}
                  muted
                  className="pointer-events-none h-full w-full object-fill"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = Math.max(
                      0,
                      clipSourceSec(clip, usePlaybackStore.getState().currentSec),
                    )
                  }}
                />
              )}
              {/* Kept region: a single box whose huge spread shadow dims everything
                  outside it (no second media element needed; works for video too). */}
              <div
                className="absolute cursor-move border border-white/90"
                style={{ ...pct, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
                onPointerDown={(e) => onPointerDown(e, 'move')}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {/* Rule-of-thirds guides */}
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
                  <div className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
                  <div className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
                  <div className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
                </div>
                {HANDLES.map(({ h, style, cursor }) => (
                  <span
                    key={h}
                    onPointerDown={(e) => onPointerDown(e, h)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    className="absolute h-3 w-3 rounded-full border border-black/50 bg-white"
                    style={{ ...style, cursor, transform: 'translate(-50%, -50%)' }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-text-3">Loading frame…</div>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <RotateCw size={14} className="text-text-2" />
            <input
              type="range"
              min={-180}
              max={180}
              value={rotation}
              onChange={(e) => setRotation(Number(e.target.value))}
              className="w-40 accent-accent"
            />
            <input
              type="number"
              min={-180}
              max={180}
              value={Math.round(rotation)}
              onChange={(e) => setRotation(clamp(Number(e.target.value) || 0, -180, 180))}
              className="w-14 rounded bg-bg-2 px-1.5 py-0.5 text-xs text-text-1 outline-none"
            />
            <span className="text-xs text-text-3">°</span>
          </div>

          <label className="flex items-center gap-2 text-xs text-text-2">
            Aspect
            <select
              value={aspect == null ? 'free' : String(aspect)}
              onChange={(e) => setAspect(e.target.value === 'free' ? null : Number(e.target.value))}
              className="rounded border border-border-strong bg-bg-2 px-2 py-1 text-text-1 outline-none"
            >
              {ASPECTS.map((a) => (
                <option key={a.label} value={a.value == null ? 'free' : String(a.value)}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={reset}
              className="rounded border border-border-strong bg-bg-2 px-3 py-1.5 text-xs text-text-2 hover:bg-bg-3 hover:text-text-1"
            >
              Reset
            </button>
            <button
              onClick={confirm}
              className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
