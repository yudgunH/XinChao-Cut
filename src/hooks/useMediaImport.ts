import { useCallback } from 'react'

import {
  detectKind,
  formatImportErrorForUi,
  isTauri,
  kindFromName,
  mediaManager,
  openMediaDialog,
  type MediaAsset,
  type MediaKind,
} from '@engine/media'
import { captureProjectOwnership, stillOwnsProject } from '@lib/project-session'
import { useProjectStore } from '@store/project-store'
import { useToastStore } from '@store/toast-store'

export interface DesktopMediaPath {
  path: string
  name: string
}

/**
 * Returns a callback that imports OS files into the media library
 * (OPFS + IndexedDB) and adds them to the project store.
 * Non-media files are skipped. Returns the successfully imported assets.
 *
 * S9A / F10: captures project ownership (id + generation) at start. After each
 * async import/probe, only mutates the store if the same project session is
 * still live — switching/closing discards the add without injecting old-project
 * assets into the new editor state. (Persisted OPFS/DB rows for the old project
 * are left in place; S9B handles transactional rollback/orphan sweep.)
 */
export function useMediaImport(): (files: File[]) => Promise<MediaAsset[]> {
  const addAsset = useProjectStore((s) => s.addAsset)

  return useCallback(
    async (files: File[]) => {
      const ownership = captureProjectOwnership()
      if (!ownership.projectId) return []
      const controller = new AbortController()
      const ownershipWatch = setInterval(() => {
        if (!stillOwnsProject(ownership)) controller.abort()
      }, 100)
      const imported: MediaAsset[] = []
      try {
        for (const file of files) {
          if (!detectKind(file)) continue
          try {
            const asset = await mediaManager.import(file, ownership.projectId, {
              signal: controller.signal,
            })
            if (!stillOwnsProject(ownership)) break
            if (asset.projectId && asset.projectId !== ownership.projectId) continue
            addAsset(asset)
            imported.push(asset)
          } catch (e) {
            if (controller.signal.aborted) break
            useToastStore.getState().push(formatImportErrorForUi(e, file.name), 'error')
          }
        }
      } finally {
        clearInterval(ownershipWatch)
      }
      return imported
    },
    [addAsset],
  )
}

/** Import audio into the persistent app-wide music library. */
export function useAudioLibraryImport(): (files: File[]) => Promise<MediaAsset[]> {
  return useCallback(async (files: File[]) => {
    const imported: MediaAsset[] = []
    for (const file of files) {
      if (detectKind(file) !== 'audio') continue
      try {
        const asset = await mediaManager.importAudioLibrary(file)
        imported.push(asset)
      } catch (e) {
        useToastStore.getState().push(formatImportErrorForUi(e, file.name), 'error')
      }
    }
    return imported
  }, [])
}

/**
 * Desktop (Tauri) import: native file picker → path-backed assets that stream
 * straight from disk (no OPFS copy, instant for multi-GB files). Returns null
 * outside the desktop shell so callers fall back to the <input> picker.
 */
export function useDesktopMediaImport(kind?: MediaKind): (() => Promise<MediaAsset[]>) | null {
  const addAsset = useProjectStore((s) => s.addAsset)
  const updateAsset = useProjectStore((s) => s.updateAsset)
  const removeAsset = useProjectStore((s) => s.removeAsset)

  const importFromDialog = useCallback(async () => {
    const ownership = captureProjectOwnership()
    if (!ownership.projectId) return []
    const picked = await openMediaDialog(kind)
    // Dialog itself is async — session may have switched while open.
    if (!stillOwnsProject(ownership)) return []
    const controller = new AbortController()
    const ownershipWatch = setInterval(() => {
      if (!stillOwnsProject(ownership)) controller.abort()
    }, 100)
    const imported: MediaAsset[] = []
    const readyAssets: Array<Promise<MediaAsset | null>> = []
    try {
      for (const { path, name } of picked ?? []) {
        try {
          const { asset, ready } = await mediaManager.importPathDeferred(path, name, ownership.projectId, {
            signal: controller.signal,
          })
          if (!stillOwnsProject(ownership)) break
          if (asset.projectId && asset.projectId !== ownership.projectId) continue
          addAsset(asset)
          imported.push(asset)
          readyAssets.push(ready.then((enriched) => {
            if (!stillOwnsProject(ownership)) return null
            updateAsset(asset.id, enriched)
            return enriched
          }).catch((error) => {
            if (!controller.signal.aborted && stillOwnsProject(ownership)) {
              removeAsset(asset.id)
              void mediaManager.remove(asset.id).catch(() => undefined)
              useToastStore.getState().push(formatImportErrorForUi(error, name), 'error')
            }
            return null
          }))
        } catch (e) {
          if (controller.signal.aborted) break
          // Basename only — never absolute desktop path in the toast.
          useToastStore.getState().push(formatImportErrorForUi(e, name), 'error')
        }
      }
      if (readyAssets.length > 0) {
        const ready = await Promise.allSettled(readyAssets)
        return ready
          .filter((result): result is PromiseFulfilledResult<MediaAsset | null> => result.status === 'fulfilled')
          .map((result) => result.value)
          .filter((asset): asset is MediaAsset => asset !== null)
      }
    } finally {
      clearInterval(ownershipWatch)
    }
    return imported
  }, [addAsset, kind, removeAsset, updateAsset])

  return isTauri() ? importFromDialog : null
}

/** Register absolute desktop paths without copying their contents into OPFS. */
export function useDesktopPathMediaImport(): (paths: DesktopMediaPath[]) => Promise<MediaAsset[]> {
  const addAsset = useProjectStore((s) => s.addAsset)
  const updateAsset = useProjectStore((s) => s.updateAsset)
  const removeAsset = useProjectStore((s) => s.removeAsset)

  return useCallback(
    async (paths: DesktopMediaPath[]) => {
      const ownership = captureProjectOwnership()
      if (!ownership.projectId) return []
      const controller = new AbortController()
      const ownershipWatch = setInterval(() => {
        if (!stillOwnsProject(ownership)) controller.abort()
      }, 100)
      const imported: MediaAsset[] = []
      const readyAssets: Array<Promise<MediaAsset | null>> = []
      try {
        for (const { path, name } of paths) {
          // Native drop events may include directories and non-media files.
          if (!kindFromName(name)) continue
          try {
            const { asset, ready } = await mediaManager.importPathDeferred(path, name, ownership.projectId, {
              signal: controller.signal,
            })
            if (!stillOwnsProject(ownership)) break
            if (asset.projectId && asset.projectId !== ownership.projectId) continue
            addAsset(asset)
            imported.push(asset)
            readyAssets.push(ready.then((enriched) => {
              if (!stillOwnsProject(ownership)) return null
              updateAsset(asset.id, enriched)
              return enriched
            }).catch(async (error) => {
              if (!controller.signal.aborted && stillOwnsProject(ownership)) {
                removeAsset(asset.id)
                await mediaManager.remove(asset.id).catch(() => undefined)
                useToastStore.getState().push(formatImportErrorForUi(error, name), 'error')
              }
              return null
            }))
          } catch (e) {
            if (controller.signal.aborted) break
            // Basename only: never expose an absolute desktop path in a toast.
            useToastStore.getState().push(formatImportErrorForUi(e, name), 'error')
          }
        }
        if (readyAssets.length > 0) {
          const ready = await Promise.all(readyAssets)
          return ready.filter((asset): asset is MediaAsset => asset !== null)
        }
      } finally {
        clearInterval(ownershipWatch)
      }
      return imported
    },
    [addAsset, removeAsset, updateAsset],
  )
}
