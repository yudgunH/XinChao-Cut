/**
 * Shared vocal/music separation flow, callable from anywhere (the Audio-tab
 * panel and the clip context menu). Drives the global separation-store so
 * progress shows wherever it's surfaced.
 */
import { mediaManager } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { useSeparationStore } from '@store/separation-store'
import { useTimelineStore } from '@store/timeline-store'
import { useToastStore } from '@store/toast-store'

let _abort: AbortController | null = null

/** Cancel the in-flight separation, if any. */
export function cancelVocalSeparation(): void {
  _abort?.abort()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

  sep.start(clipId)
  _abort = new AbortController()
  const signal = _abort.signal

  try {
    const { startSeparation, getSeparationStatus, downloadStem, cancelSeparation } = await import(
      '@engine/backend'
    )

    const source = asset?.sourcePath
      ? { sourcePath: asset.sourcePath, filename: asset.name }
      : await mediaManager.getBlob(assetId)
    if (!source) throw new Error('Media not found')

    const jobId = await startSeparation(source, assetName || 'audio')

    for (;;) {
      if (signal.aborted) {
        await cancelSeparation(jobId)
        throw new DOMException('Cancelled', 'AbortError')
      }
      const st = await getSeparationStatus(jobId)
      useSeparationStore.getState().setPct(st.pct)
      if (st.status === 'done') break
      if (st.status === 'error') throw new Error(st.error || 'Separation failed')
      if (st.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError')
      await sleep(700)
    }

    const [vBlob, mBlob] = await Promise.all([
      downloadStem(jobId, 'vocals'),
      downloadStem(jobId, 'music'),
    ])
    const base = (assetName || 'audio').replace(/\.[^.]+$/, '')
    const projectId = useProjectStore.getState().id
    const vAsset = await mediaManager.import(
      new File([vBlob], `${base} - Vocals.wav`, { type: 'audio/wav' }),
      projectId,
    )
    const mAsset = await mediaManager.import(
      new File([mBlob], `${base} - Music.wav`, { type: 'audio/wav' }),
      projectId,
    )
    useProjectStore.getState().addAsset(vAsset)
    useProjectStore.getState().addAsset(mAsset)

    useTimelineStore.getState().addSeparatedStems(clipId, {
      vocalsAssetId: vAsset.id,
      musicAssetId: mAsset.id,
    })
    useSeparationStore.getState().setNote('Tách giọng & nhạc thành công')
    useToastStore.getState().push('Đã tách giọng & nhạc', 'success')
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      const msg = e instanceof Error ? e.message : 'Separation failed'
      useSeparationStore.getState().setError(msg)
      useToastStore.getState().push(`Tách giọng lỗi: ${msg}`, 'error')
    }
  } finally {
    useSeparationStore.getState().finish()
    _abort = null
  }
}
