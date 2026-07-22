import { useEffect, useRef, useState } from 'react'

import { getCapabilities } from '@engine/backend'
import { isProxyRunning, runProxyGeneration } from '@engine/media/proxy-runner'
import { isAudioCapableProxyKey } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { useUIStore } from '@store/ui-store'
import { useProxyStore } from '@store/proxy-store'

// In 'smart' mode, only auto-proxy sources TALLER than 1080p (1440p / 4K). A
// 1080p source is kept as-is so the preview stays crisp — proxying it to 1080p
// would gain nothing, and downscaling further would look soft.
const PROXY_ABOVE_HEIGHT = 1080
const MAX_PROXY_RETRIES = 5
const proxyRetries = new Map<string, { attempt: number; retryAt: number }>()

/**
 * Auto-generates a low-res preview proxy for video assets (one at a time, in
 * the background) when the backend is available — so scrubbing stays smooth
 * without the user manually requesting it. The original is always used for
 * export. The auto-proxy policy is controlled by the `proxyMode` setting
 * (off / smart / always); 'off' leaves it to the per-clip context menu.
 */
export function useProxyBackfill(): void {
  const [retryTick, setRetryTick] = useState(0)
  const mountedRef = useRef(true)
  const activeControllerRef = useRef<AbortController | null>(null)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const assets = useProjectStore((s) => s.assets)
  const proxyMode = useUIStore((s) => s.proxyMode)

  useEffect(() => () => {
    mountedRef.current = false
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
    if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
  }, [])

  useEffect(() => {
    if (proxyMode === 'off') {
      activeControllerRef.current?.abort()
      activeControllerRef.current = null
      return
    }
    if (activeControllerRef.current) return
    let disposed = false
    ;(async () => {
      const caps = await getCapabilities()
      if (!caps?.export || disposed || activeControllerRef.current) return

      const minHeight = proxyMode === 'always' ? 0 : PROXY_ABOVE_HEIGHT
      const now = Date.now()
      const target = assets.find(
        (a) =>
          a.kind === 'video' &&
          !isAudioCapableProxyKey(a.proxyStorageKey) &&
          (a.height ?? 0) > minHeight &&
          (proxyRetries.get(a.id)?.retryAt ?? 0) <= now &&
          !isProxyRunning(a.id),
      )
      if (!target || disposed || activeControllerRef.current) {
        const nextRetry = Math.min(
          ...assets.map((a) => proxyRetries.get(a.id)?.retryAt ?? Infinity),
        )
        if (Number.isFinite(nextRetry) && nextRetry > now && !wakeTimerRef.current) {
          wakeTimerRef.current = setTimeout(() => {
            wakeTimerRef.current = null
            if (mountedRef.current) setRetryTick((value) => value + 1)
          }, nextRetry - now)
        }
        return
      }

      const ac = new AbortController()
      activeControllerRef.current = ac
      try {
        await runProxyGeneration(target.id, 1080, ac.signal)
      } finally {
        if (activeControllerRef.current === ac) activeControllerRef.current = null
        const result = useProxyStore.getState().status[target.id]
        if (!ac.signal.aborted && result?.state === 'error') {
          const attempt = (proxyRetries.get(target.id)?.attempt ?? 0) + 1
          proxyRetries.set(target.id, {
            attempt,
            retryAt: attempt >= MAX_PROXY_RETRIES
              ? Infinity
              : Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5)),
          })
        } else if (!ac.signal.aborted) {
          proxyRetries.delete(target.id)
        }
        // Asset updates can re-run this effect before the runner releases its
        // slot. This explicit tick starts the next eligible asset afterwards.
        if (mountedRef.current) setRetryTick((value) => value + 1)
      }
    })()

    return () => {
      disposed = true
    }
  }, [assets, proxyMode, retryTick])
}
