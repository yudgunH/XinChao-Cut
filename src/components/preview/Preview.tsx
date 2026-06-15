import { ASPECT_RATIOS, useProjectStore } from '@store/project-store'

import { PreviewCanvas } from './PreviewCanvas'
import { PlaybackControls } from './PlaybackControls'

export function Preview() {
  const aspect = useProjectStore((s) => s.aspect)
  const setAspect = useProjectStore((s) => s.setAspect)

  return (
    <div className="flex h-full flex-col">
      {/* Top bar: aspect ratio selector */}
      <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-b border-border bg-bg-1 px-3">
        <span className="text-2xs text-text-3">Aspect</span>
        <select
          value={aspect.label}
          onChange={(e) => {
            const next = ASPECT_RATIOS.find((a) => a.label === e.target.value)
            if (next) setAspect(next)
          }}
          className="rounded bg-bg-2 px-2 py-1 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent"
        >
          {ASPECT_RATIOS.map((a) => (
            <option key={a.label} value={a.label}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      {/* Stage: distinct grey so the (black) video frame stands out */}
      <div className="flex flex-1 items-center justify-center bg-[#242426] p-4 min-h-0">
        <PreviewCanvas />
      </div>
      <PlaybackControls />
    </div>
  )
}
