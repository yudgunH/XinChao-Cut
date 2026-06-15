/**
 * Polls /health every `pollMs` ms and exposes a manual recheck function.
 *
 * Returns a [caps, recheck] tuple:
 *   - caps  — current capabilities, or null when the backend is unreachable.
 *             Resets to null automatically when the backend goes offline.
 *   - recheck — call this to force an immediate re-check (clears the cache).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearCapabilitiesCache,
  getCapabilities,
  type BackendCapabilities,
} from '@engine/backend'

export function useBackendCapabilities(
  pollMs = 3_000,
): [BackendCapabilities | null, () => void] {
  const [caps, setCaps] = useState<BackendCapabilities | null>(null)
  // Stable ref so recheck() can call the latest check() without re-running the effect.
  const checkRef = useRef<() => Promise<void>>()

  useEffect(() => {
    let alive = true

    async function check() {
      const result = await getCapabilities()
      if (!alive) return
      setCaps(result)   // null → backend offline; value → online
    }

    checkRef.current = check
    void check()

    const id = setInterval(() => { if (alive) void check() }, pollMs)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const recheck = useCallback(() => {
    clearCapabilitiesCache()
    void checkRef.current?.()
  }, [])

  return [caps, recheck]
}
