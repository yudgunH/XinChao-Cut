import { useCallback, useState } from 'react'

interface UseDropFileOptions {
  accept?: (file: File) => boolean
  onFiles: (files: File[]) => void
}

interface UseDropFileResult {
  isDragOver: boolean
  bind: {
    onDragOver: (e: React.DragEvent) => void
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

export function useDropFile({ accept, onFiles }: UseDropFileOptions): UseDropFileResult {
  const [isDragOver, setDragOver] = useState(false)

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragOver(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const files = Array.from(e.dataTransfer.files).filter((f) => !accept || accept(f))
      if (files.length > 0) onFiles(files)
    },
    [accept, onFiles],
  )

  return { isDragOver, bind: { onDragOver, onDragEnter, onDragLeave, onDrop } }
}
