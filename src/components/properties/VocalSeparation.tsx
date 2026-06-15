import { AudioLines, Loader2, AlertCircle, Mic2, Music } from 'lucide-react'

import { cancelVocalSeparation, runVocalSeparation } from '@engine/audio/separation-runner'
import { useSeparationStore } from '@store/separation-store'

/**
 * "Separate vocals & music" control for an audio-bearing clip. Delegates to the
 * shared separation runner (also used by the clip context menu).
 *
 * Only rendered when the backend reports the `separate` capability.
 */
export function VocalSeparation({ clipId, assetName }: { clipId: string; assetName: string }) {
  const { busy, clipId: activeClip, pct, error, note } = useSeparationStore()

  // Progress belongs to this clip only when it's the one being processed.
  const isThis = busy && activeClip === clipId
  const busyElsewhere = busy && activeClip !== clipId

  const run = () => void runVocalSeparation(clipId, assetName)

  return (
    <div className="mt-3 rounded border border-border bg-bg-1 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded bg-accent/15 text-accent">
          <AudioLines size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-1">Tách giọng &amp; nhạc</p>
          <p className="flex items-center gap-1 text-2xs text-text-3">
            <Mic2 size={10} /> Vocals
            <span className="mx-0.5">+</span>
            <Music size={10} /> Music
          </p>
        </div>
      </div>

      <button
        onClick={isThis ? cancelVocalSeparation : run}
        disabled={busyElsewhere}
        className={`flex w-full items-center justify-center gap-2 rounded py-1.5 text-xs font-medium text-white disabled:opacity-40 ${
          isThis ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent-hover'
        }`}
      >
        {isThis ? <Loader2 size={14} className="animate-spin" /> : <AudioLines size={14} />}
        {isThis ? 'Hủy' : busyElsewhere ? 'Đang xử lý clip khác…' : 'Tách audio'}
      </button>

      {isThis && (
        <div className="mt-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-300"
              style={{ width: `${Math.max(3, Math.round(pct))}%` }}
            />
          </div>
          <p className="mt-1 text-right text-2xs tabular-nums text-text-3">{Math.round(pct)}%</p>
        </div>
      )}

      {error && activeClip === clipId && (
        <div className="mt-2 flex items-start gap-1.5 text-2xs text-danger">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {note && activeClip === clipId && !busy && (
        <p className="mt-2 text-2xs text-success">{note}</p>
      )}
      <p className="mt-1.5 text-2xs text-text-3">Xử lý trên backend (Demucs) · có thể mất một lúc</p>
    </div>
  )
}
