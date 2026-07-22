import { lazy, Suspense, useState } from 'react'
import { Download } from 'lucide-react'

const ExportDialog = lazy(() =>
  import('@components/export/ExportDialog').then((module) => ({
    default: module.ExportDialog,
  })),
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
