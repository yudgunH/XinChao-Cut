import { MousePointer2, Scissors, ZoomIn, Magnet } from 'lucide-react'

export function TimelineToolbar() {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-bg-1 px-2">
      <button className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1" aria-label="Select">
        <MousePointer2 size={14} />
      </button>
      <button className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1" aria-label="Split">
        <Scissors size={14} />
      </button>
      <div className="mx-1 h-4 w-px bg-border" />
      <button className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1" aria-label="Zoom">
        <ZoomIn size={14} />
      </button>
      <button className="rounded p-1 text-accent hover:bg-bg-3" aria-label="Snap toggle">
        <Magnet size={14} />
      </button>
    </div>
  )
}
