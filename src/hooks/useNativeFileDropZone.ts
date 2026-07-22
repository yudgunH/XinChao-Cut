import { useEffect, useRef, useState, type RefObject } from 'react'

import {
  NATIVE_FILE_DRAG_EVENT,
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDragDetail,
  type NativeFileDropDetail,
} from '@engine/media/native-drop'

/** Consume native Tauri paths at a specialized drop-zone before the event can
 * bubble to Editor's general-purpose media importer. */
export function useNativeFileDropZone<T extends HTMLElement>(
  ref: RefObject<T>,
  onDrop: (detail: NativeFileDropDetail) => void,
  enabled = true,
): boolean {
  const handlerRef = useRef(onDrop)
  handlerRef.current = onDrop
  const [isOver, setIsOver] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setIsOver(false)
      return undefined
    }
    const element = ref.current
    if (!element) return undefined
    element.dataset.nativeFileDropZone = 'true'

    const onNativeDrop = (raw: unknown) => {
      const event = raw as {
        detail: NativeFileDropDetail
        preventDefault: () => void
        stopPropagation: () => void
      }
      event.preventDefault()
      event.stopPropagation()
      setIsOver(false)
      handlerRef.current(event.detail)
    }
    const onNativeDrag = (raw: unknown) => {
      const detail = (raw as { detail: NativeFileDragDetail }).detail
      if (detail.type === 'leave' || detail.type === 'drop') {
        setIsOver(false)
        return
      }
      if (detail.clientX == null || detail.clientY == null) return
      const hit = document.elementFromPoint(detail.clientX, detail.clientY)
      setIsOver(!!hit && element.contains(hit))
    }
    element.addEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop)
    window.addEventListener(NATIVE_FILE_DRAG_EVENT, onNativeDrag)
    return () => {
      delete element.dataset.nativeFileDropZone
      element.removeEventListener(NATIVE_FILE_DROP_EVENT, onNativeDrop)
      window.removeEventListener(NATIVE_FILE_DRAG_EVENT, onNativeDrag)
    }
  }, [enabled, ref])

  return isOver
}
