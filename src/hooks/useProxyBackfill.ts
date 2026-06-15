import { useEffect } from 'react'

import { getCapabilities } from '@engine/backend'
import { isProxyRunning, runProxyGeneration } from '@engine/media/proxy-runner'
import { useProjectStore } from '@store/project-store'
import { useUIStore } from '@store/ui-store'

// In 'smart' mode, only auto-proxy sources TALLER than 1080p (1440p / 4K). A
// 1080p source is kept as-is so the preview stays crisp — proxying it to 1080p
// would gain nothing, and downscaling further would look soft.
const PROXY_ABOVE_HEIGHT = 1080

/**
 * Auto-generates a low-res preview proxy for video assets (one at a time, in
 * the background) when the backend is available — so scrubbing stays smooth
 * without the user manually requesting it. The original is always used for
 * export. The auto-proxy policy is controlled by the `proxyMode` setting
 * (off / smart / always); 'off' leaves it to the per-clip context menu.
 */
export function useProxyBackfill(): void {
  const assets = useProjectStore((s) => s.assets)
  const proxyMode = useUIStore((s) => s.proxyMode)

  useEffect(() => {
    if (proxyMode === 'off') return
    let cancelled = false
    ;(async () => {
      const caps = await getCapabilities()
      if (!caps?.export || cancelled) return // proxy needs server FFmpeg

      const minHeight = proxyMode === 'always' ? 0 : PROXY_ABOVE_HEIGHT
      const target = assets.find(
        (a) =>
          a.kind === 'video' &&
          !a.proxyStorageKey &&
          (a.height ?? 0) > minHeight &&
          !isProxyRunning(a.id),
      )
      if (!target || cancelled) return

      await runProxyGeneration(target.id)
      // When it finishes, the asset gains proxyStorageKey → assets change →
      // this effect re-runs and picks up the next eligible video.
    })()

    return () => {
      cancelled = true
    }
  }, [assets, proxyMode])
}
