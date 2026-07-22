/**
 * Generate a low-res preview proxy for a video asset via the backend FFmpeg
 * job, store it in OPFS, and point the asset at it. The preview then plays the
 * proxy (smooth scrubbing for 4K/large sources); export keeps using the
 * original. Drives the proxy-store for per-asset progress.
 */
import {
  cancelProxy,
  downloadProxyTo,
  getProxyStatus,
  isRetryableBackendPollError,
  startProxy,
} from '@engine/backend'
import { db } from '@lib/dexie-db'
import { captureProjectOwnership, stillOwnsProject } from '@lib/project-session'
import { deleteBlob, writeStreamAtomic } from '@engine/persistence/opfs'
import { useProjectStore } from '@store/project-store'
import { useProxyStore } from '@store/proxy-store'

import { mediaManager } from './media-manager'
import { AUDIO_PROXY_SUFFIX } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && /abort/i.test(error.name)
}

/** True when a proxy job for this asset is already running. */
export function isProxyRunning(assetId: string): boolean {
  return useProxyStore.getState().status[assetId]?.state === 'running'
}

// 1080p proxy: crisp at any reasonable preview size, while still far lighter
// than a 4K source to seek/scrub. Only sources taller than 1080p are proxied
// (see useProxyBackfill), so a 1080p original is never needlessly downscaled.
export async function runProxyGeneration(
  assetId: string,
  height = 1080,
  signal?: AbortSignal,
): Promise<void> {
  const ownership = captureProjectOwnership()
  if (!ownership.projectId) return
  const proxy = useProxyStore.getState()
  // Proxying is a background convenience, not a batch queue. A single global
  // job prevents many 4K imports from filling the backend heavy-job queue while
  // export/ASR/TTS are waiting for the same CPU/GPU resources.
  if (Object.values(proxy.status).some((entry) => entry.state === 'running')) return

  const asset = useProjectStore.getState().assets.find((a) => a.id === assetId)
  if (!asset || asset.kind !== 'video') return

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (signal?.aborted) controller.abort()
  const requestSignal = controller.signal
  const ownershipWatch = setInterval(() => {
    if (!stillOwnsProject(ownership)) controller.abort()
  }, 100)

  proxy.set(assetId, { pct: 0, state: 'running' })

  let jobId: string | null = null
  let uncommittedProxyKey: string | null = null
  const noLongerOwned = () =>
    requestSignal.aborted ||
    !stillOwnsProject(ownership) ||
    !useProjectStore.getState().assets.some((candidate) => candidate.id === assetId)
  const cancelRemote = async () => {
    const current = jobId
    jobId = null
    if (current) await cancelProxy(current).catch(() => undefined)
  }

  try {
    for (;;) {
      if (noLongerOwned()) {
        await cancelRemote()
        useProxyStore.getState().clear(assetId)
        return
      }
      const source = asset.sourcePath
        ? { sourcePath: asset.sourcePath, filename: asset.name }
        : await mediaManager.getBlob(assetId)
      if (!source) throw new Error('Media not found')
      if (noLongerOwned()) continue

      const currentJobId = await startProxy(source, height, asset.name || 'video', requestSignal)
      jobId = currentJobId

      let preempted = false
      let consecutivePollFailures = 0
      for (;;) {
        if (noLongerOwned()) {
          await cancelRemote()
          useProxyStore.getState().clear(assetId)
          return
        }
        let st: Awaited<ReturnType<typeof getProxyStatus>>
        try {
          st = await getProxyStatus(currentJobId, requestSignal)
          consecutivePollFailures = 0
        } catch (error) {
          if (
            !noLongerOwned() &&
            isRetryableBackendPollError(error) &&
            consecutivePollFailures < 10
          ) {
            consecutivePollFailures += 1
            await sleep(Math.min(10_000, 750 * 2 ** Math.min(consecutivePollFailures, 4)))
            continue
          }
          throw error
        }
        useProxyStore.getState().set(assetId, { pct: st.pct, state: 'running' })
        if (st.status === 'done') break
        if (st.status === 'error') throw new Error(st.error || 'Proxy failed')
        if (st.status === 'cancelled') {
          jobId = null
          preempted = true
          break
        }
        await sleep(600)
      }
      if (preempted) {
        // Export intentionally preempts background proxies. Keep this runner's
        // single-flight ownership and retry without leaving a setTimeout that
        // can revive a project after the user has closed it.
        useProxyStore.getState().set(assetId, { pct: 0, state: 'running' })
        await sleep(3000)
        continue
      }

      const finalKey = `${assetId}${AUDIO_PROXY_SUFFIX}`
      const tempKey = `${finalKey}.download-${crypto.randomUUID()}`
      await writeStreamAtomic(tempKey, finalKey, (write) =>
        downloadProxyTo(currentJobId, write, requestSignal),
      )
      uncommittedProxyKey = finalKey
      jobId = null
      if (noLongerOwned()) {
        await deleteBlob(finalKey).catch(() => undefined)
        uncommittedProxyKey = null
        useProxyStore.getState().clear(assetId)
        return
      }
      if (!noLongerOwned()) {
        const legacyKey = asset.proxyStorageKey
        if (legacyKey && legacyKey !== finalKey) {
          await deleteBlob(legacyKey).catch(() => undefined)
        }
        await db.assets.update(assetId, { proxyStorageKey: finalKey })
        useProjectStore.getState().updateAsset(assetId, { proxyStorageKey: finalKey })
        uncommittedProxyKey = null
      }
      if (!noLongerOwned()) {
        useProxyStore.getState().set(assetId, { pct: 100, state: 'done' })
      }
      return
    }
  } catch (error) {
    await cancelRemote()
    if (uncommittedProxyKey) {
      await deleteBlob(uncommittedProxyKey).catch(() => undefined)
      uncommittedProxyKey = null
    }
    if (noLongerOwned() || isAbort(error)) {
      useProxyStore.getState().clear(assetId)
      return
    }
    const message = error instanceof Error ? error.message : 'Proxy failed'
    useProxyStore.getState().set(assetId, { pct: 0, state: 'error', error: message })
  } finally {
    clearInterval(ownershipWatch)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

/** Remove a previously generated proxy (preview reverts to the original). */
export async function removeProxy(assetId: string): Promise<void> {
  await mediaManager.removeProxy(assetId)
  useProjectStore.getState().updateAsset(assetId, { proxyStorageKey: undefined })
  await db.assets.update(assetId, { proxyStorageKey: undefined })
  useProxyStore.getState().clear(assetId)
}
