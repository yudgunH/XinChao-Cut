import { useEffect } from 'react'

import { isTauri } from '@engine/media'
import {
  dispatchNativeFileDrag,
  dispatchNativeFileDrop,
  pathBaseName,
} from '@engine/media/native-drop'

/** Owns the one Tauri file-drop listener for the whole app. Keeping it above
 * Home/Editor and modal workspaces prevents duplicate imports after navigation. */
export function DesktopNativeDropBridge() {
  useEffect(() => {
    if (!isTauri()) return undefined
    let disposed = false
    let unlisten: (() => void) | undefined
    let scaleFactor = Math.max(1, window.devicePixelRatio || 1)

    void Promise.all([
      import('@tauri-apps/api/webview'),
      import('@tauri-apps/api/window'),
    ]).then(async ([{ getCurrentWebview }, { getCurrentWindow }]) => {
      try {
        scaleFactor = Math.max(1, await getCurrentWindow().scaleFactor())
      } catch {
        // devicePixelRatio is a valid fallback when the native query is denied.
      }
      if (disposed) return
      const nextUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (disposed) return
        const payload = event.payload
        if (payload.type === 'leave') {
          dispatchNativeFileDrag({ type: 'leave' })
          return
        }
        const logical = payload.position.toLogical(scaleFactor)
        if (payload.type === 'drop') {
          dispatchNativeFileDrag({ type: 'drop', clientX: logical.x, clientY: logical.y })
          dispatchNativeFileDrop({
            files: payload.paths.map((path) => ({ path, name: pathBaseName(path) })),
            clientX: logical.x,
            clientY: logical.y,
          })
          return
        }
        dispatchNativeFileDrag({
          type: payload.type,
          clientX: logical.x,
          clientY: logical.y,
        })
      })
      if (disposed) nextUnlisten()
      else unlisten = nextUnlisten
    }).catch((error) => {
      console.warn('[desktop-drop] Native file drop listener unavailable:', error)
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return null
}
