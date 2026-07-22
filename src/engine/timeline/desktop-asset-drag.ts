import { isTauri } from '@engine/media'

import { placeAssetIdsOnTimeline, resolveTimelineAssetDropTarget } from './asset-drop'

const START_THRESHOLD_PX = 5

/** Pointer-based Media -> Timeline drag for Tauri on Windows. Native OS file
 * drop and Chromium HTML5 drag/drop cannot be enabled together there. */
export function beginDesktopAssetPointerDrag(
  event: PointerEvent,
  assetIds: readonly string[],
): boolean {
  if (!isTauri() || event.button !== 0 || assetIds.length === 0) return false
  const startX = event.clientX
  const startY = event.clientY
  let active = false
  let highlighted: HTMLElement | null = null
  let badge: HTMLDivElement | null = null

  const setHighlight = (next: HTMLElement | null) => {
    if (highlighted === next) return
    highlighted?.removeAttribute('data-asset-drop-active')
    highlighted = next
    highlighted?.setAttribute('data-asset-drop-active', 'true')
  }

  const activate = () => {
    if (active) return
    active = true
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    badge = document.createElement('div')
    badge.textContent = assetIds.length === 1 ? '1 media' : `${assetIds.length} media`
    Object.assign(badge.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'none',
      padding: '5px 9px',
      borderRadius: '6px',
      color: '#001414',
      background: '#00d8d6',
      font: '600 12px system-ui',
      boxShadow: '0 4px 18px #0008',
    })
    document.body.appendChild(badge)
  }

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onCancel, true)
    window.removeEventListener('blur', onCancel)
    document.removeEventListener('keydown', onKey, true)
    setHighlight(null)
    badge?.remove()
    badge = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  const onMove = (move: PointerEvent) => {
    if (
      !active &&
      Math.hypot(move.clientX - startX, move.clientY - startY) < START_THRESHOLD_PX
    ) return
    activate()
    move.preventDefault()
    if (badge) {
      badge.style.left = `${move.clientX + 14}px`
      badge.style.top = `${move.clientY + 14}px`
    }
    const hit = document.elementFromPoint(move.clientX, move.clientY) as HTMLElement | null
    setHighlight(hit?.closest<HTMLElement>('[data-timeline-track-id]') ?? null)
  }
  const suppressDragClick = (click: MouseEvent) => {
    click.preventDefault()
    click.stopPropagation()
  }
  const onUp = (up: PointerEvent) => {
    const shouldDrop = active
    cleanup()
    if (!shouldDrop) return
    up.preventDefault()
    placeAssetIdsOnTimeline(assetIds, resolveTimelineAssetDropTarget(up.clientX, up.clientY))
    // A click is synthesized after pointerup; do not collapse a multi-selection.
    window.addEventListener('click', suppressDragClick, { capture: true, once: true })
    globalThis.setTimeout(
      () => window.removeEventListener('click', suppressDragClick, true),
      350,
    )
  }
  const onCancel = () => cleanup()
  const onKey = (key: KeyboardEvent) => {
    if (key.key === 'Escape') cleanup()
  }

  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onCancel, true)
  window.addEventListener('blur', onCancel)
  document.addEventListener('keydown', onKey, true)
  return true
}
