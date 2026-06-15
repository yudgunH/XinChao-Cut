import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore } from '@store/ui-store'
import { formatTimecode } from '@engine/core/time'

import { collectTimelineSnapTargets, snapTimelineSec } from './timeline-snap'

interface TimelineRulerProps {
  zoom: number
  scrollLeft: number
  containerWidth: number
  heightPx: number
}

// "Nice" major-label intervals (seconds). The ruler keeps labels ~TARGET_PX
// apart and snaps to the next nice value, so subdivisions stay even at any zoom.
const NICE_MAJOR_SEC = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
const TARGET_MAJOR_PX = 120
const MIN_MINOR_PX = 7

function getTickConfig(zoom: number) {
  const rawMajor = TARGET_MAJOR_PX / zoom
  let majorSec = NICE_MAJOR_SEC[NICE_MAJOR_SEC.length - 1]!
  for (const s of NICE_MAJOR_SEC) {
    if (s >= rawMajor) {
      majorSec = s
      break
    }
  }
  // Subdivide the major into 5 / 4 / 2 ticks, picking the densest that still
  // leaves minor ticks comfortably apart; otherwise no minor ticks.
  let minorSec = majorSec
  for (const div of [5, 4, 2]) {
    const candidate = majorSec / div
    if (candidate * zoom >= MIN_MINOR_PX) {
      minorSec = candidate
      break
    }
  }
  return { minorSec, majorSec }
}

export function TimelineRuler({ zoom, scrollLeft, containerWidth, heightPx }: TimelineRulerProps) {
  const seek = usePlaybackStore((s) => s.seek)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const setSnapGuide = useUIStore((s) => s.setTimelineSnapGuideSec)
  const { minorSec, majorSec } = getTickConfig(zoom)

  const startSec = Math.floor(scrollLeft / zoom / minorSec) * minorSec
  const endSec = startSec + containerWidth / zoom + minorSec * 2

  const ticks: { sec: number; major: boolean }[] = []
  for (let sec = Math.max(0, startSec); sec <= endSec; sec = +(sec + minorSec).toFixed(6)) {
    // Float-safe "is this a major tick?" check (sec is an exact multiple of major).
    const ratio = sec / majorSec
    const major = Math.abs(ratio - Math.round(ratio)) < 1e-6
    ticks.push({ sec, major })
  }

  // Click + drag anywhere on the ruler to scrub; keeps following the cursor
  // even when it leaves the ruler (document-level listeners).
  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()

    // Scrub, snapping the playhead to clip edges / 0 (and showing the guide).
    function scrub(clientX: number) {
      const raw = Math.max(0, (clientX - rect.left) / zoom)
      if (!snapEnabled) {
        seek(raw)
        return
      }
      const targets = collectTimelineSnapTargets(useTimelineStore.getState().timeline.clips)
      const snap = snapTimelineSec(raw, targets, zoom)
      seek(snap.sec)
      setSnapGuide(snap.guideSec)
    }
    scrub(e.clientX)

    function onMove(me: MouseEvent) {
      scrub(me.clientX)
    }
    function onUp() {
      setSnapGuide(null)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className="relative shrink-0 cursor-pointer border-b border-border/70 bg-tl-sidebar"
      style={{ minWidth: '100%', height: heightPx }}
    >
      {ticks.map(({ sec, major }) => {
        const x = sec * zoom
        return (
          <div key={sec} className="absolute top-0" style={{ left: x }}>
            <div
              className={`absolute top-0 w-px ${major ? 'bg-border-strong/80' : 'bg-border/70'}`}
              style={{ height: major ? '100%' : '30%' }}
            />
            {major && (
              <span
                className="absolute left-1 top-0.5 font-mono text-text-3/80 select-none whitespace-nowrap"
                style={{ fontSize: '10px', letterSpacing: '0.02em' }}
              >
                {formatTimecode(sec, 30)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
