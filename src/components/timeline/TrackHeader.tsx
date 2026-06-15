import {
  Film,
  Music,
  Sparkles,
  Type,
  Volume2,
  VolumeX,
  Lock,
  Unlock,
  type LucideIcon,
} from 'lucide-react'
import type { MouseEvent } from 'react'

import type { Track } from '@engine/timeline'
import { useTimelineStore } from '@store/timeline-store'

interface TrackHeaderProps {
  track: Track
  heightPx: number
  isGroupStart?: boolean
  isSelected?: boolean
  hasSelectedClip?: boolean
  onSelectTrack?: (trackId: string, additive: boolean) => void
}

const KIND_META: Record<
  Track['kind'],
  { color: string; bg: string; label: string; icon: LucideIcon }
> = {
  video: { color: 'text-track-video', bg: 'bg-track-video/20', label: 'Video', icon: Film },
  audio: { color: 'text-track-audio', bg: 'bg-track-audio/20', label: 'Audio', icon: Music },
  text: { color: 'text-track-text', bg: 'bg-track-text/20', label: 'Text', icon: Type },
  fx: { color: 'text-track-fx', bg: 'bg-track-fx/20', label: 'FX', icon: Sparkles },
}

export function TrackHeader({
  track,
  heightPx,
  isGroupStart = false,
  isSelected = false,
  hasSelectedClip = false,
  onSelectTrack,
}: TrackHeaderProps) {
  const toggleMuted = useTimelineStore((s) => s.toggleTrackMuted)
  const toggleLocked = useTimelineStore((s) => s.toggleTrackLocked)
  const meta = KIND_META[track.kind]
  const Icon = meta.icon

  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    onSelectTrack?.(track.id, e.ctrlKey || e.metaKey || e.shiftKey)
  }

  return (
    <div
      onMouseDown={onMouseDown}
      title={`${track.name} · ${meta.label}\nClick to select. Ctrl/Shift-click to toggle.`}
      className={`group flex cursor-pointer items-center justify-between border-b border-border/60 px-2 transition-colors ${
        isSelected
          ? 'bg-black/60 text-white'
          : hasSelectedClip
            ? 'bg-bg-2'
            : 'bg-tl-sidebar hover:bg-bg-2'
      } ${
        isGroupStart ? 'border-t border-t-border-strong/80' : ''
      }`}
      style={{
        height: heightPx,
        boxShadow: isSelected ? 'inset 3px 0 0 var(--timeline-accent)' : undefined,
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded ${meta.bg} ${meta.color}`}
        >
          <Icon size={11} />
        </span>
        <p className="truncate text-2xs font-medium tracking-wide text-text-1">{track.name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => toggleMuted(track.id)}
          title={track.muted ? 'Unmute' : 'Mute'}
          className={`rounded p-0.5 hover:bg-bg-3 hover:text-text-1 ${track.muted ? 'text-danger' : 'text-text-3'}`}
          aria-label="Mute track"
        >
          {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => toggleLocked(track.id)}
          title={track.locked ? 'Unlock' : 'Lock'}
          className={`rounded p-0.5 hover:bg-bg-3 hover:text-text-1 ${track.locked ? 'text-warning' : 'text-text-3'}`}
          aria-label="Lock track"
        >
          {track.locked ? <Lock size={11} /> : <Unlock size={11} />}
        </button>
      </div>
    </div>
  )
}
