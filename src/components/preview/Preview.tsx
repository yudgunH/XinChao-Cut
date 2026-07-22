import { Instagram, Monitor, Music2, Smartphone, Youtube } from 'lucide-react'
import { useState } from 'react'

import { ASPECT_RATIOS, useProjectStore } from '@store/project-store'

import { PreviewCanvas, type PlatformFrame } from './PreviewCanvas'
import { PlaybackControls } from './PlaybackControls'

const PLATFORM_FRAMES: { id: PlatformFrame; label: string; icon: typeof Monitor }[] = [
  { id: 'none', label: 'Clean', icon: Monitor },
  { id: 'tiktok', label: 'TikTok', icon: Music2 },
  { id: 'shorts', label: 'Shorts', icon: Youtube },
  { id: 'reels', label: 'Reels', icon: Instagram },
]

export function Preview() {
  const aspect = useProjectStore((s) => s.aspect)
  const setAspect = useProjectStore((s) => s.setAspect)
  const [platformFrame, setPlatformFrame] = useState<PlatformFrame>('tiktok')
  const isVertical = aspect.label === '9:16'

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-3">
        <div className="flex items-center gap-2 text-2xs text-text-3">
          <span className="grid h-5 w-5 place-items-center rounded bg-bg-2 text-text-2 ring-1 ring-border">
            {isVertical ? <Smartphone size={12} /> : <Monitor size={12} />}
          </span>
          <span>Preview</span>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <div className="flex overflow-hidden rounded-md bg-[#151515] p-0.5 ring-1 ring-border">
            {ASPECT_RATIOS.map((a) => {
              const active = a.label === aspect.label
              return (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => setAspect(a)}
                  className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition ${
                    active ? 'bg-bg-4 text-white shadow-sm' : 'text-text-3 hover:bg-bg-3 hover:text-text-1'
                  }`}
                  title={`Canvas ${a.label}`}
                >
                  {a.label === '9:16' ? <Smartphone size={12} /> : <Monitor size={12} />}
                  {a.label}
                </button>
              )
            })}
          </div>

          <div
            className={`flex overflow-hidden rounded-md bg-[#151515] p-0.5 ring-1 ring-border transition ${
              isVertical ? 'opacity-100' : 'pointer-events-none opacity-45'
            }`}
            title={isVertical ? '9:16 platform preview frame' : 'Frame overlays are available for 9:16'}
          >
            {PLATFORM_FRAMES.map(({ id, label, icon: Icon }) => {
              const active = platformFrame === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPlatformFrame(id)}
                  className={`grid h-6 w-7 place-items-center rounded transition ${
                    active ? 'bg-accent/20 text-accent' : 'text-text-3 hover:bg-bg-3 hover:text-text-1'
                  }`}
                  title={label}
                >
                  <Icon size={12} />
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center bg-[#242426] p-4 min-h-0">
        <PreviewCanvas platformFrame={isVertical ? platformFrame : 'none'} />
      </div>
      <PlaybackControls />
    </div>
  )
}
