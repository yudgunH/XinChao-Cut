import { Upload, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'

import { detectKind } from '@engine/media'
import { useDropFile } from '@hooks/useDropFile'
import { useDesktopMediaImport, useMediaImport } from '@hooks/useMediaImport'

export function DropZone() {
  const importFiles = useMediaImport()
  const desktopImport = useDesktopMediaImport()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<string | null>(null)

  async function handleFiles(files: File[]) {
    setError(null)
    setBusy((n) => n + files.length)
    try {
      await importFiles(files)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy((n) => Math.max(0, n - files.length))
    }
  }

  const { isDragOver, bind } = useDropFile({
    accept: (f) => detectKind(f) !== null,
    onFiles: handleFiles,
  })

  return (
    <div
      {...bind}
      // Prevent the global app drop handler from double-importing
      onDrop={(e) => {
        e.stopPropagation()
        bind.onDrop(e)
      }}
      onClick={() => (desktopImport ? void desktopImport() : inputRef.current?.click())}
      className={`mb-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded border border-dashed px-4 py-6 text-center transition-colors ${
        isDragOver
          ? 'border-accent bg-accent/10'
          : 'border-border-strong bg-bg-2/40 hover:bg-bg-2'
      }`}
    >
      {busy > 0 ? (
        <>
          <Loader2 size={20} className="animate-spin text-accent" />
          <p className="text-xs text-text-2">Importing {busy} file(s)…</p>
        </>
      ) : (
        <>
          <Upload size={20} className="text-text-2" />
          <p className="text-xs text-text-2">Drop files here or click to import</p>
        </>
      )}
      {error && <p className="text-2xs text-danger">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) handleFiles(files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
