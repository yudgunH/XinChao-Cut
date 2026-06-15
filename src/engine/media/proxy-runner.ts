/**
 * Generate a low-res preview proxy for a video asset via the backend FFmpeg
 * job, store it in OPFS, and point the asset at it. The preview then plays the
 * proxy (smooth scrubbing for 4K/large sources); export keeps using the
 * original. Drives the proxy-store for per-asset progress.
 */
import { db } from '@lib/dexie-db'
import { useProjectStore } from '@store/project-store'
import { useProxyStore } from '@store/proxy-store'

import { mediaManager } from './media-manager'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** True when a proxy job for this asset is already running. */
export function isProxyRunning(assetId: string): boolean {
  return useProxyStore.getState().status[assetId]?.state === 'running'
}

// 1080p proxy: crisp at any reasonable preview size, while still far lighter
// than a 4K source to seek/scrub. Only sources taller than 1080p are proxied
// (see useProxyBackfill), so a 1080p original is never needlessly downscaled.
export async function runProxyGeneration(assetId: string, height = 1080): Promise<void> {
  const proxy = useProxyStore.getState()
  if (proxy.status[assetId]?.state === 'running') return

  const asset = useProjectStore.getState().assets.find((a) => a.id === assetId)
  if (!asset || asset.kind !== 'video') return

  proxy.set(assetId, { pct: 0, state: 'running' })

  try {
    const { startProxy, getProxyStatus, downloadProxy } = await import('@engine/backend')

    const source = asset.sourcePath
      ? { sourcePath: asset.sourcePath, filename: asset.name }
      : await mediaManager.getBlob(assetId)
    if (!source) throw new Error('Media not found')

    const jobId = await startProxy(source, height, asset.name || 'video')

    for (;;) {
      const st = await getProxyStatus(jobId)
      useProxyStore.getState().set(assetId, { pct: st.pct, state: 'running' })
      if (st.status === 'done') break
      if (st.status === 'error') throw new Error(st.error || 'Proxy failed')
      if (st.status === 'cancelled') throw new Error('Proxy cancelled')
      await sleep(600)
    }

    const proxyBlob = await downloadProxy(jobId)
    const key = await mediaManager.setProxy(assetId, proxyBlob)
    if (key) {
      useProjectStore.getState().updateAsset(assetId, { proxyStorageKey: key })
      await db.assets.update(assetId, { proxyStorageKey: key })
    }
    useProxyStore.getState().set(assetId, { pct: 100, state: 'done' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Proxy failed'
    if (msg === 'Proxy cancelled') {
      // Preempted by a user-initiated export (the backend yields the heavy-job
      // slot to it). Not an error — clear the badge and retry shortly; the new
      // job simply waits its turn behind the export.
      useProxyStore.getState().clear(assetId)
      setTimeout(() => void runProxyGeneration(assetId, height), 3000)
      return
    }
    useProxyStore.getState().set(assetId, { pct: 0, state: 'error', error: msg })
  }
}

/** Remove a previously generated proxy (preview reverts to the original). */
export async function removeProxy(assetId: string): Promise<void> {
  await mediaManager.removeProxy(assetId)
  useProjectStore.getState().updateAsset(assetId, { proxyStorageKey: undefined })
  await db.assets.update(assetId, { proxyStorageKey: undefined })
  useProxyStore.getState().clear(assetId)
}
