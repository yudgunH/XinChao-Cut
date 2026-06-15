import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useContextMenuStore } from '@store/context-menu-store'

const MENU_WIDTH = 200

export function ContextMenu() {
  const open = useContextMenuStore((s) => s.open)
  const x = useContextMenuStore((s) => s.x)
  const y = useContextMenuStore((s) => s.y)
  const items = useContextMenuStore((s) => s.items)
  const closeMenu = useContextMenuStore((s) => s.closeMenu)

  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Flip away from viewport edges after measuring height
  useLayoutEffect(() => {
    if (!open) return
    const el = ref.current
    const h = el?.offsetHeight ?? 0
    const nx = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
    const ny = Math.min(y, window.innerHeight - h - 8)
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) })
  }, [open, x, y])

  // Close on outside interaction
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('resize', closeMenu)
    }
  }, [open, closeMenu])

  if (!open) return null

  // Portal to <body> so the menu escapes any timeline/panel stacking context
  // (e.g. the toolbar's z-[70]) and always renders on top.
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[100] overflow-hidden rounded-md border border-border bg-bg-2 py-1 shadow-e2"
      style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.label}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.()
              closeMenu()
            }}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors ${
              item.disabled
                ? 'cursor-not-allowed text-text-3'
                : item.danger
                  ? 'text-danger hover:bg-danger/15'
                  : 'text-text-1 hover:bg-bg-3'
            }`}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="ml-4 font-mono text-2xs text-text-3">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
