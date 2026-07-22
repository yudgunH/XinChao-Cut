import { SkipBack, Play, Pause, SkipForward, Volume2, VolumeX, Maximize, LoaderCircle } from 'lucide-react'

import { formatTimecode } from '@engine/core/time'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'

export function PlaybackControls() {
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const isBuffering = usePlaybackStore((s) => s.isBuffering)
  const currentSec = usePlaybackStore((s) => s.currentSec)
  const volume = usePlaybackStore((s) => s.volume)
  const toggle = usePlaybackStore((s) => s.toggle)
  const seek = usePlaybackStore((s) => s.seek)
  const setVolume = usePlaybackStore((s) => s.setVolume)
  const fps = useTimelineStore((s) => s.timeline.fps)
  const durationSec = useTimelineStore((s) => s.timeline.durationSec)

  return (
    <div className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-border bg-bg-1 px-3">
      {/* Timecode (left) */}
      <span className="justify-self-start font-mono text-xs tabular-nums text-text-2">
        {formatTimecode(currentSec, fps)}{' '}
        <span className="text-text-3">/ {formatTimecode(durationSec, fps)}</span>
      </span>

      {/* Transport (center) */}
      <div className="flex items-center gap-0.5 justify-self-center">
        <button
          onClick={() => seek(0)}
          className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
          aria-label="Go to start"
        >
          <SkipBack size={15} />
        </button>
        <button
          onClick={toggle}
          className="rounded p-1.5 text-text-1 hover:bg-bg-3"
          aria-label={isBuffering ? 'Buffering (click to cancel)' : isPlaying ? 'Pause' : 'Play'}
        >
          {isBuffering ? (
            <LoaderCircle size={18} className="animate-spin" />
          ) : isPlaying ? (
            <Pause size={18} />
          ) : (
            <Play size={18} />
          )}
        </button>
        <button
          onClick={() => seek(durationSec)}
          className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
          aria-label="Go to end"
        >
          <SkipForward size={15} />
        </button>
      </div>

      {/* Volume (right) */}
      <div className="flex items-center gap-2 justify-self-end">
        <button
          onClick={() => setVolume(volume > 0 ? 0 : 1)}
          className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
          aria-label="Volume"
        >
          {volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          onMouseUp={(e) => (e.currentTarget as HTMLInputElement).blur()}
          onKeyUp={(e) => (e.currentTarget as HTMLInputElement).blur()}
          className="w-20 accent-[#71717a]"
          aria-label="Volume slider"
        />
        <button
          className="rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
          aria-label="Fullscreen"
        >
          <Maximize size={15} />
        </button>
      </div>
    </div>
  )
}
