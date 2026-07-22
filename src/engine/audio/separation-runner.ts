/**
 * Shared vocal/music separation flow, callable from anywhere (the Audio-tab
 * panel and the clip context menu). Drives the global separation-store so
 * progress shows wherever it's surfaced.
 */
import {
  startSeparation,
  getSeparationStatus,
  isRetryableBackendPollError,
  downloadStemTo,
  cancelSeparation,
} from '@engine/backend'
import { mediaManager } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { useSeparationStore } from '@store/separation-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'
import { captureProjectOwnership, stillOwnsProject } from '@lib/project-session'
import { deleteBlob, writeStreamAtomic } from '@engine/persistence/opfs'

let _abort: AbortController | null = null

/** Cancel the in-flight separation, if any. */
export function cancelVocalSeparation(): void {
  _abort?.abort()
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('Cancelled', 'AbortError'))
    return
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    reject(new DOMException('Cancelled', 'AbortError'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
})
/**
 * Separate a clip's source media into vocals + music stems via the backend
 * Demucs job, import both as audio assets, and drop them onto new audio tracks
 * (muting the source clip's audio). One job at a time.
 */
export async function runVocalSeparation(clipId: string, assetName: string): Promise<void> {
  const sep = useSeparationStore.getState()
  if (sep.busy) return

  const clip = useTimelineStore.getState().timeline.clips.find((c) => c.id === clipId)
  if (!clip?.assetId) {
    sep.setError('Clip has no media')
    return
  }
  const assetId = clip.assetId
  const asset = useProjectStore.getState().assets.find((candidate) => candidate.id === assetId)
  const ownership = captureProjectOwnership()
  if (!stillOwnsProject(ownership)) return

  sep.start(clipId)
  const controller = new AbortController()
  _abort = controller
  const signal = controller.signal
  // Project ownership is not an AbortSignal. Bridge it while a multi-GB upload
  // or stem download is pending so navigation stops network/FFmpeg promptly,
  // instead of noticing only after the request has fully completed.
  const ownershipWatch = setInterval(() => {
    if (!stillOwnsProject(ownership)) controller.abort()
  }, 100)
  const importedIds: string[] = []
  let committed = false
  const requestId = crypto.randomUUID().replaceAll('-', '')
  // The backend uses this stable request id as the job id, so cancellation can
  // reach a job even when the multipart start response was lost.
  let jobId: string | null = requestId
  let jobDone = false

  const assertOwnership = () => {
    if (signal.aborted || !stillOwnsProject(ownership)) {
      throw new DOMException('Cancelled', 'AbortError')
    }
  }

  try {
    const source = asset?.sourcePath
      ? { sourcePath: asset.sourcePath, filename: asset.name }
      : await mediaManager.getBlob(assetId)
    if (!source) throw new Error('Media not found')
    assertOwnership()

    jobId = await startSeparation(source, assetName || 'audio', signal, requestId)

    let consecutiveStatusFailures = 0
    for (;;) {
      if (signal.aborted || !stillOwnsProject(ownership)) {
        await cancelSeparation(jobId)
        throw new DOMException('Cancelled', 'AbortError')
      }
      let st: Awaited<ReturnType<typeof getSeparationStatus>>
      try {
        st = await getSeparationStatus(jobId, signal)
        consecutiveStatusFailures = 0
      } catch (e) {
        if (signal.aborted || !stillOwnsProject(ownership)) throw e
        if (!isRetryableBackendPollError(e)) throw e
        consecutiveStatusFailures++
        useSeparationStore.getState().setNote('Mất kết nối backend, đang thử lại…')
        await sleep(
          Math.min(10_000, 500 * 2 ** Math.min(5, consecutiveStatusFailures - 1)),
          signal,
        )
        continue
      }
      useSeparationStore.getState().setPct(st.pct)
      if (st.status === 'done') {
        jobDone = true
        break
      }
      if (st.status === 'error') throw new Error(st.error || 'Separation failed')
      if (st.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError')
      await sleep(700, signal)
    }

    assertOwnership()
    const base = (assetName || 'audio').replace(/\.[^.]+$/, '')
    const fetchStem = async (stem: 'vocals' | 'music', label: string) => {
      const key = `stem-${crypto.randomUUID()}.wav`
      const tempKey = `${key}.download`
      try {
        await writeStreamAtomic(tempKey, key, (write) =>
          downloadStemTo(jobId!, stem, write, signal),
        )
        assertOwnership()
        const imported = await mediaManager.adoptStored(
          key,
          `${base} - ${label}.wav`,
          ownership.projectId!,
          { signal },
        )
        importedIds.push(imported.id)
        return imported
      } catch (error) {
        await deleteBlob(key).catch(() => undefined)
        throw error
      }
    }
    // Sequential on purpose: never keep two multi-GB WAV downloads/imports in
    // flight at once on memory- and disk-constrained desktop systems.
    const vAsset = await fetchStem('vocals', 'Vocals')
    assertOwnership()
    const mAsset = await fetchStem('music', 'Music')
    assertOwnership()
    useProjectStore.getState().addAsset(vAsset)
    useProjectStore.getState().addAsset(mAsset)

    assertOwnership()
    useTimelineStore.getState().addSeparatedStems(clipId, {
      vocalsAssetId: vAsset.id,
      musicAssetId: mAsset.id,
    })
    committed = true
    useSeparationStore.getState().setNote('Tách giọng & nhạc thành công')
    useToastStore.getState().push('Đã tách giọng & nhạc', 'success')
  } catch (e) {
    if (jobId && !jobDone) await cancelSeparation(jobId)
    if (!committed && importedIds.length > 0) {
      for (const id of importedIds) {
        try { await mediaManager.remove(id) } catch { /* best effort rollback */ }
        if (stillOwnsProject(ownership)) useProjectStore.getState().removeAsset(id)
      }
    }
    if (
      stillOwnsProject(ownership) &&
      !(e instanceof DOMException && e.name === 'AbortError')
    ) {
      const msg = e instanceof Error ? e.message : 'Separation failed'
      useSeparationStore.getState().setError(msg)
      useToastStore.getState().push(`Tách giọng lỗi: ${msg}`, 'error')
    }
  } finally {
    clearInterval(ownershipWatch)
    useSeparationStore.getState().finish()
    if (_abort === controller) _abort = null
  }
}
