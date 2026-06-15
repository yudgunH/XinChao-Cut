import { lazy, Suspense, useState } from 'react'
import { Download } from 'lucide-react'

// Lazily loaded: ExportDialog pulls in the whole in-browser export stack
// (exporter → frame-reader → mp4box / mp4-muxer / lamejs, several MB). Importing
// it statically dragged that chain into the initial module graph and added 10s+
// to a cold dev startup. Loading it only when the dialog opens keeps app boot fast.
const ExportDialog = lazy(() =>
  import('@components/export/ExportDialog').then((m) => ({ default: m.ExportDialog })),
)

export function ExportButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
      >
        <Download size={13} />
        Export
      </button>

      {open && (
        <Suspense fallback={null}>
          <ExportDialog onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
