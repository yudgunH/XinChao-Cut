import { useCallback, useEffect, useRef, type RefObject } from 'react'

import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'
import { ABSOLUTE_MIN_TIMELINE_ZOOM } from '@engine/timeline/zoom'

import { collectTimelineSnapTargets, snapTimelineSec } from './timeline-snap'

interface PlayheadProps {
  heightPx: number
  durationSec: number
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

export function playheadDragSec(
  startSec: number,
  startClientX: number,
  clientX: number,
  startScrollLeft: number,
  scrollLeft: number,
  zoom: number,
  durationSec: number,
): number {
  const scrollDelta = scrollLeft - startScrollLeft
  const raw =
    startSec +
    (clientX - startClientX + scrollDelta) / Math.max(zoom, ABSOLUTE_MIN_TIMELINE_ZOOM)
  return Math.max(0, Math.min(Math.max(0, durationSec), raw))
}

export function playheadEdgeScrollSpeed(
  clientX: number,
  viewportLeft: number,
  viewportRight: number,
  edgePx = 80,
  maxSpeedPx = 40,
): number {
  if (clientX <= viewportLeft + edgePx) {
    const pressure = Math.min(1, Math.max(0, (viewportLeft + edgePx - clientX) / edgePx))
    return -pressure * maxSpeedPx
  }
  if (clientX >= viewportRight - edgePx) {
    const pressure = Math.min(1, Math.max(0, (clientX - (viewportRight - edgePx)) / edgePx))
    return pressure * maxSpeedPx
  }
  return 0
}

export function Playhead({ heightPx, durationSec, scrollContainerRef }: PlayheadProps) {
  const zoom = useTimelineStore((s) => s.zoom)
  const currentSec = usePlaybackStore((s) => s.currentSec)
  const seek = usePlaybackStore((s) => s.seek)

  const left = currentSec * zoom
  const cleanupDragRef = useRef<(() => void) | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      cleanupDragRef.current?.()

      const container = scrollContainerRef.current
      const startClientX = e.clientX
      const startTime = currentSec
      const startScrollLeft = container?.scrollLeft ?? 0
      const snapEnabled = useUIStore.getState().snapEnabled
      const snapTargets = snapEnabled
        ? collectTimelineSnapTargets(useTimelineStore.getState().timeline.clips)
        : []
      let lastClientX = e.clientX
      let rafId = 0
      let finished = false

      const applyDrag = (clientX: number) => {
        const raw = playheadDragSec(
          startTime,
          startClientX,
          clientX,
          startScrollLeft,
          container?.scrollLeft ?? startScrollLeft,
          zoom,
          durationSec,
        )
        const ui = useUIStore.getState()
        if (snapEnabled) {
          const snap = snapTimelineSec(raw, snapTargets, zoom)
          seek(Math.max(0, Math.min(durationSec, snap.sec)))
          ui.setTimelineSnapGuideSec(snap.guideSec)
        } else {
          seek(raw)
        }
      }

      const onMove = (event: MouseEvent) => {
        lastClientX = event.clientX
        applyDrag(lastClientX)
      }

      const autoScrollFrame = () => {
        if (container) {
          const rect = container.getBoundingClientRect()
          const speed = playheadEdgeScrollSpeed(lastClientX, rect.left, rect.right)
          if (speed !== 0) {
            const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth)
            const before = container.scrollLeft
            container.scrollLeft = Math.max(0, Math.min(maxScroll, before + speed))
            if (container.scrollLeft !== before) applyDrag(lastClientX)
          }
        }
        rafId = requestAnimationFrame(autoScrollFrame)
      }

      const cleanup = () => {
        if (finished) return
        finished = true
        cancelAnimationFrame(rafId)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', cleanup)
        useUIStore.getState().setTimelineSnapGuideSec(null)
        if (cleanupDragRef.current === cleanup) cleanupDragRef.current = null
      }

      cleanupDragRef.current = cleanup
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', cleanup)
      rafId = requestAnimationFrame(autoScrollFrame)
    },
    [currentSec, durationSec, scrollContainerRef, seek, zoom],
  )

  useEffect(() => {
    return () => cleanupDragRef.current?.()
  }, [])

  return (
    <div className="pointer-events-none absolute top-0 z-40" style={{ left, height: heightPx }}>
      <div
        onMouseDown={onMouseDown}
        className="pointer-events-auto absolute top-0 z-0 -translate-x-1/2 cursor-ew-resize"
        style={{ width: 12, height: heightPx }}
        title="Drag playhead"
      />
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="pointer-events-auto absolute z-20 -translate-x-1/2 cursor-ew-resize"
        style={{ top: 0 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <polygon
            points="0,0 12,0 6,10"
            fill="var(--timeline-accent)"
            style={{ filter: 'drop-shadow(0 0 3px var(--timeline-accent))' }}
          />
        </svg>
      </div>
      {/* Vertical line */}
      <div
        className="absolute z-10 -translate-x-1/2"
        style={{
          width: 1,
          top: 12,
          height: heightPx - 12,
          background: 'var(--timeline-accent)',
          boxShadow: '0 0 4px var(--timeline-accent)',
        }}
      />
    </div>
  )
}
