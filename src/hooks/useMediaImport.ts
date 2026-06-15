import { useCallback } from 'react'

import { detectKind, isTauri, mediaManager, openMediaDialog, type MediaAsset } from '@engine/media'
import { useProjectStore } from '@store/project-store'

/**
 * Returns a callback that imports OS files into the media library
 * (OPFS + IndexedDB) and adds them to the project store.
 * Non-media files are skipped. Returns the successfully imported assets.
 */
export function useMediaImport(): (files: File[]) => Promise<MediaAsset[]> {
  const addAsset = useProjectStore((s) => s.addAsset)

  return useCallback(
    async (files: File[]) => {
      const projectId = useProjectStore.getState().id
      if (!projectId) return []
      const imported: MediaAsset[] = []
      for (const file of files) {
        if (!detectKind(file)) continue
        try {
          const asset = await mediaManager.import(file, projectId)
          addAsset(asset)
          imported.push(asset)
        } catch {
          // skip files that fail to import
        }
      }
      return imported
    },
    [addAsset],
  )
}

/**
 * Desktop (Tauri) import: native file picker → path-backed assets that stream
 * straight from disk (no OPFS copy, instant for multi-GB files). Returns null
 * outside the desktop shell so callers fall back to the <input> picker.
 */
export function useDesktopMediaImport(): (() => Promise<MediaAsset[]>) | null {
  const addAsset = useProjectStore((s) => s.addAsset)

  const importFromDialog = useCallback(async () => {
    const projectId = useProjectStore.getState().id
    if (!projectId) return []
    const picked = await openMediaDialog()
    const imported: MediaAsset[] = []
    for (const { path, name } of picked ?? []) {
      try {
        const asset = await mediaManager.importPath(path, name, projectId)
        addAsset(asset)
        imported.push(asset)
      } catch {
        // skip files that fail to import (unsupported/missing)
      }
    }
    return imported
  }, [addAsset])

  return isTauri() ? importFromDialog : null
}
