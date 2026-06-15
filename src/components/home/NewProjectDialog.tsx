import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import { ASPECT_RATIOS, type AspectRatio } from '@store/project-store'

interface NewProjectDialogProps {
  onCancel: () => void
  onCreate: (name: string, aspect: AspectRatio) => void
}

export function NewProjectDialog({ onCancel, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('Untitled Project')
  const [aspect, setAspect] = useState<AspectRatio>(ASPECT_RATIOS[0]!)

  function submit() {
    onCreate(name.trim() || 'Untitled Project', aspect)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80"
      onClick={onCancel}
    >
      <div
        className="w-[440px] overflow-hidden rounded-xl bg-bg-1 shadow-e3 ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-text-1">New Project</h2>
          <button
            onClick={onCancel}
            className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-2xs text-text-3">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onCancel()
              }}
              autoFocus
              className="rounded-md bg-bg-2 px-3 py-2 text-sm text-text-1 outline-none ring-1 ring-border focus:ring-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-2xs text-text-3">Aspect ratio</label>
            <div className="grid grid-cols-3 gap-2">
              {ASPECT_RATIOS.map((a) => {
                const active = a.label === aspect.label
                return (
                  <button
                    key={a.label}
                    onClick={() => setAspect(a)}
                    className={`rounded-md px-2 py-2 text-xs ring-1 transition-colors ${
                      active
                        ? 'bg-accent/15 text-text-1 ring-accent'
                        : 'bg-bg-2 text-text-2 ring-border hover:text-text-1'
                    }`}
                  >
                    {a.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent-hover"
          >
            Create
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
