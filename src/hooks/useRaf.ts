import { useEffect, useRef } from 'react'

export function useRaf(callback: (dtMs: number) => void, enabled = true): void {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    if (!enabled) return
    let raf = 0
    let prev = performance.now()
    function tick(now: number) {
      cbRef.current(now - prev)
      prev = now
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])
}
