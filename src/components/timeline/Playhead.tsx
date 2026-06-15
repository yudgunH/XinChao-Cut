import { useCallback, useEffect, useRef } from 'react'

import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'

import { collectTimelineSnapTargets, snapTimelineSec } from './timeline-snap'

interface PlayheadProps {
  heightPx: number
}

export function Playhead({ heightPx }: PlayheadProps) {
  const zoom = useTimelineStore((s) => s.zoom)
  const currentSec = usePlaybackStore((s) => s.currentSec)
  const seek = usePlaybackStore((s) => s.seek)

  const left = currentSec * zoom
  const dragging = useRef(false)
  const startX = useRef(0)
  const startSec = useRef(0)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragging.current = true
      startX.current = e.clientX
      startSec.current = currentSec
    },
    [currentSec],
  )

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return
      const dx = e.clientX - startX.current
      const raw = Math.max(0, startSec.current + dx / zoom)
      const ui = useUIStore.getState()
      if (ui.snapEnabled) {
        // Snap the playhead to clip edges / 0 and show the guide line.
        const targets = collectTimelineSnapTargets(useTimelineStore.getState().timeline.clips)
        const snap = snapTimelineSec(raw, targets, zoom)
        seek(snap.sec)
        ui.setTimelineSnapGuideSec(snap.guideSec)
      } else {
        seek(raw)
      }
    }
    function onUp() {
      if (dragging.current) useUIStore.getState().setTimelineSnapGuideSec(null)
      dragging.current = false
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [zoom, seek])

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
