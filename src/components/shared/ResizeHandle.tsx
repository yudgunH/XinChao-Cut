import { useCallback, useEffect, useRef } from 'react'

interface ResizeHandleProps {
  direction: 'vertical' | 'horizontal'
  onDrag: (delta: number) => void
  className?: string
}

export function ResizeHandle({ direction, onDrag, className = '' }: ResizeHandleProps) {
  const dragging = useRef(false)
  const last = useRef(0)
  const onDragRef = useRef(onDrag)
  onDragRef.current = onDrag

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      last.current = direction === 'vertical' ? e.clientX : e.clientY
    },
    [direction],
  )

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return
      const cur = direction === 'vertical' ? e.clientX : e.clientY
      onDragRef.current(cur - last.current)
      last.current = cur
    }
    function onUp() {
      dragging.current = false
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [direction])

  const base =
    direction === 'vertical'
      ? 'w-1 cursor-col-resize hover:w-1.5'
      : 'h-1 cursor-row-resize hover:h-1.5'

  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 bg-border transition-all duration-100 hover:bg-accent/60 active:bg-accent ${base} ${className}`}
    />
  )
}
