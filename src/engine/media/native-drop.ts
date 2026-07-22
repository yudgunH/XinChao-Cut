export const NATIVE_FILE_DROP_EVENT = 'xinchao:native-file-drop'
export const NATIVE_FILE_DRAG_EVENT = 'xinchao:native-file-drag'

export interface NativeDroppedPath {
  path: string
  name: string
}

export interface NativeFileDropDetail {
  files: NativeDroppedPath[]
  clientX: number
  clientY: number
}

export interface NativeFileDragDetail {
  type: 'enter' | 'over' | 'leave' | 'drop'
  clientX?: number
  clientY?: number
}

export function pathBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** Dispatch at the actual DOM hit target so a specialized drop-zone can consume
 * the event before it bubbles to Editor's default media importer. */
export function dispatchNativeFileDrop(detail: NativeFileDropDetail): void {
  const event = new window.CustomEvent<NativeFileDropDetail>(NATIVE_FILE_DROP_EVENT, {
    detail,
    bubbles: true,
    cancelable: true,
  })
  const target = document.elementFromPoint(detail.clientX, detail.clientY)
  ;(target ?? window).dispatchEvent(event)
}

export function dispatchNativeFileDrag(detail: NativeFileDragDetail): void {
  window.dispatchEvent(new window.CustomEvent<NativeFileDragDetail>(NATIVE_FILE_DRAG_EVENT, { detail }))
}
