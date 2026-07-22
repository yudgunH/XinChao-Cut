/**
 * Headless server (FFmpeg) export — the asset-hash → upload → spec → poll flow,
 * extracted from ExportDialog so other editor flows can drive
 * a backend render without a live editor UI. Returns the job's download URL.
 */
import {
  checkAssets,
  hashBlob,
  uploadAsset,
  startServerExport,
  getExportStatus,
  isRetryableBackendPollError,
  cancelServerExport,
  exportDownloadUrl,
} from '@engine/backend'
import type { ServerExportDiag } from '@engine/backend'
import { mediaManager, type MediaAsset } from '@engine/media'
import {
  bundledFontsForFamilies,
  fallbackCaptionFamiliesForText,
} from '@engine/text/font-catalog'
import { TEXT_MAX_WIDTH_RATIO } from '@engine/timeline/draw-caption'
import { setTextSpacing, wrapText } from '@engine/timeline/text-layout'
import { resolvedTextWordSpacing, type Clip, type Track } from '@engine/timeline'

import { isExportAudibleClip } from './audio-memory'
import { buildExportSpec, usedAssetIds } from './spec'
import type { ExportSettings } from './exporter'

export interface ServerExportParams {
  settings: ExportSettings
  durationSec: number
  clips: Clip[]
  tracks: Track[]
  assets: MediaAsset[]
  signal: AbortSignal
  /** 0..100 render progress + a coarse stage label. */
  onProgress?: (pct: number, stage: string) => void
  /** Persist a freshly computed content hash back to the asset store. */
  onAssetHash?: (assetId: string, hash: string) => void
  /** Absolute folder the backend should write the mp4 into (no download). */
  outputDir?: string
  /** Base filename (without extension) for the written mp4. */
  outputName?: string
}

export interface ServerExportResult {
  /** Download URL for the finished job (always usable as a fallback). */
  downloadUrl: string
  /** Absolute path the file was written to, when an export folder was used. */
  savedPath?: string
  /** How the render was wired (encoder / decode / CPU compositor). */
  diag?: ServerExportDiag
}

const abortErr = () => new DOMException('Export cancelled', 'AbortError')
export const MAX_BACKEND_RECONNECT_MS = 5 * 60_000
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: DOMException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(abortErr())
    const timer = setTimeout(() => finish(), ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

// Content hash per bundled-font URL, computed once per session — fonts are
// immutable build artefacts, so re-hashing them on every export is wasted work.
const fontHashCache = new Map<string, string>()

/**
 * Upload the bundled caption fonts used by `clips` to the backend's asset store
 * and return the `captionFonts` spec entries. Without this, libass burns the
 * captions with a system-fallback face and the render doesn't match the preview
 * (the template fonts only exist inside the frontend bundle).
 */
type CaptionFontEntry = { hash: string; name: string; family: string; assFamily: string; sizeScale: number }

/** Minimal clip shape syncCaptionFonts actually reads. The editor passes full
 *  Clips; callers may also pass plain spec clips,
 *  which only carry textData — both satisfy this. */
type CaptionFontClip = { textData?: Clip['textData'] | null }

/**
 * Public entry for callers that build their ExportSpec elsewhere (notably the
 * A server-generated export spec therefore never
 * ran the editor's font-upload step — its captions burned with libass fallback
 * faces, not the template fonts). Upload the bundled fonts the given clips use
 * and return the `captionFonts` spec entries to attach to the spec.
 */
export async function captionFontsForClips(
  clips: CaptionFontClip[],
  signal?: AbortSignal,
): Promise<CaptionFontEntry[]> {
  return syncCaptionFonts(clips, signal ?? new AbortController().signal)
}

async function syncCaptionFonts(
  clips: CaptionFontClip[],
  signal: AbortSignal,
): Promise<CaptionFontEntry[]> {
  const families = new Set<string>()
  for (const c of clips) {
    if (c.textData?.fontFamily) families.add(c.textData.fontFamily)
    for (const fallback of fallbackCaptionFamiliesForText(c.textData?.content ?? '')) {
      families.add(fallback)
    }
  }
  if (families.size === 0) return []

  const fonts = await bundledFontsForFamilies(families)
  const entries: (CaptionFontEntry & { blob: Blob })[] = []
  for (const font of fonts) {
    if (signal.aborted) throw abortErr()
    try {
      const res = await fetch(font.url, { signal })
      if (!res.ok) continue
      const blob = await res.blob()
      let hash = fontHashCache.get(font.url)
      if (!hash) {
        hash = await hashBlob(blob)
        fontHashCache.set(font.url, hash)
      }
      entries.push({
        hash, name: font.file, blob,
        family: font.family, assFamily: font.assFamily, sizeScale: font.sizeScale,
      })
    } catch (e) {
      if (signal.aborted) throw abortErr()
      // A missing font file shouldn't kill the export — libass falls back for
      // that face only (same as today's behaviour for every face).
      console.warn('Caption font sync failed:', font.file, e)
    }
  }
  if (entries.length === 0) return []

  const missing = new Set(await checkAssets(entries.map((e) => e.hash), signal))
  for (const e of entries) {
    if (signal.aborted) throw abortErr()
    if (missing.has(e.hash)) await uploadAsset(e.blob, e.hash, e.name, signal)
  }
  return entries.map(({ hash, name, family, assFamily, sizeScale }) => ({ hash, name, family, assFamily, sizeScale }))
}


/**
 * Pre-compute the exact line breaks of every PLAIN caption at export resolution
 * using the browser's own text metrics, so the libass burn breaks lines exactly
 * where the preview does (`\N` + `\q2` on the backend) instead of re-wrapping
 * with its own shaping. Reveal/karaoke captions burn short word-windows and
 * don't need it. Returns clipId → lines.
 */
async function precomputeWrappedLines(
  clips: Clip[],
  width: number,
  height: number,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const textClips = clips.filter(
    (c) => c.textData && (!c.textData.anim || c.textData.anim.kind === 'none') && c.textData.content.trim(),
  )
  if (textClips.length === 0 || typeof document === 'undefined') return out

  // Make sure the faces are loaded so measureText uses real metrics.
  const loads = new Set<string>()
  for (const c of textClips) loads.add(`${c.textData!.fontWeight} 64px ${c.textData!.fontFamily}`)
  await Promise.all([...loads].map((f) => document.fonts.load(f).catch(() => [])))

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return out
  for (const c of textClips) {
    const td = c.textData!
    const fontSize = Math.round((td.fontSize / 1080) * height)
    ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
    setTextSpacing(
      ctx,
      ((td.letterSpacing ?? 0) / 1080) * height,
      (resolvedTextWordSpacing(td) / 1080) * height,
    )
    // Server export requires a neutral text transform (serverExportGaps routes
    // scaled/keyframed text to the browser), so no sx division here.
    const lines = wrapText(ctx, td.content, width * TEXT_MAX_WIDTH_RATIO)
    if (lines.length > 0) out.set(c.id, lines)
  }
  return out
}

export interface SyncServerMediaParams {
  clips: Clip[]
  assets: MediaAsset[]
  signal: AbortSignal
  assetIds?: Iterable<string>
  onAssetHash?: (assetId: string, hash: string) => void
  onProgress?: (pct: number, stage: string) => void
}

/** Content-address and upload media without starting a server visual render. */
export async function syncServerMediaAssets(
  params: SyncServerMediaParams,
): Promise<Map<string, string>> {
  const { clips, assets, signal, onAssetHash, onProgress } = params
  const ids = params.assetIds
    ? Array.from(new Set(params.assetIds))
    : usedAssetIds(clips)
  const hashByAssetId = new Map<string, string>()
  const assetIdByHash = new Map<string, string>()
  let prepared = 0
  onProgress?.(0, 'Preparing server media')
  for (const id of ids) {
    const asset = assets.find((candidate) => candidate.id === id)
    if (asset?.sourcePath) {
      hashByAssetId.set(id, `local-${id}`)
    } else if (asset?.contentHash) {
      hashByAssetId.set(id, asset.contentHash)
      assetIdByHash.set(asset.contentHash, id)
    } else {
      const blob = await mediaManager.getBlob(id)
      if (!blob) {
        const label = asset?.name ?? id
        throw new Error(`Không tìm thấy dữ liệu media cho "${label}" — không thể export. Hãy import lại file này.`)
      }
      if (signal.aborted) throw abortErr()
      const hash = await hashBlob(blob, signal)
      hashByAssetId.set(id, hash)
      assetIdByHash.set(hash, id)
      await mediaManager.setContentHash(id, hash)
      onAssetHash?.(id, hash)
    }
    prepared++
    onProgress?.(ids.length ? prepared / ids.length * 40 : 40, 'Preparing server media')
  }

  const missing = await checkAssets([...assetIdByHash.keys()], signal)
  let cursor = 0
  let uploaded = 0
  const uploadWorker = async () => {
    while (cursor < missing.length) {
      const hash = missing[cursor++]
      if (hash === undefined) break
      if (signal.aborted) throw abortErr()
      const id = assetIdByHash.get(hash)
      const blob = id ? await mediaManager.getBlob(id) : null
      if (!id || !blob) {
        throw new Error(`Không tìm thấy media cần upload (${hash.slice(0, 12)})`)
      }
      await uploadAsset(blob, hash, assets.find((a) => a.id === id)?.name ?? 'media', signal)
      uploaded++
      onProgress?.(
        40 + (missing.length ? uploaded / missing.length * 60 : 60),
        'Uploading server media',
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, missing.length) }, uploadWorker))
  onProgress?.(100, 'Server media ready')
  return hashByAssetId
}

export interface PrepareHybridExportSpecParams {
  settings: ExportSettings
  durationSec: number
  clips: Clip[]
  tracks: Track[]
  assets: MediaAsset[]
  signal: AbortSignal
  onAssetHash?: (assetId: string, hash: string) => void
  onProgress?: (pct: number, stage: string) => void
}

/** Build the portable audio contract consumed after Browser video rendering. */
export async function prepareHybridExportSpec(
  params: PrepareHybridExportSpecParams,
) {
  const { settings, durationSec, clips, tracks, assets, signal } = params
  const trackById = new Map(tracks.map((track) => [track.id, track]))
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const audioAssetIds = new Set<string>()
  const mediaClips: Clip[] = []
  for (const clip of clips) {
    const track = trackById.get(clip.trackId)
    const kind = assetById.get(clip.assetId!)?.kind ?? track?.kind
    if (kind === 'video' || kind === 'audio') {
      mediaClips.push(clip)
      if (isExportAudibleClip(clip, tracks)) audioAssetIds.add(clip.assetId!)
    }
  }
  const hashes = await syncServerMediaAssets({
    clips,
    assets,
    signal,
    assetIds: audioAssetIds,
    onAssetHash: params.onAssetHash,
    onProgress: params.onProgress,
  })
  // Keep muted media in the contract too. The backend still filters it from the
  // mix, but retaining the whole split family makes detach/separation coverage
  // auditable instead of erasing every clue before Hybrid finalization.
  const spec = buildExportSpec(settings, durationSec, mediaClips, tracks, assets, hashes)
  // Hybrid never renders visuals on the backend. Keep the worker/start payload
  // and durable sidecar proportional to audible media, not to caption/keyframe
  // count. These are the only fields consumed by the FFmpeg audio builder.
  spec.clips = spec.clips.map((clip) => ({
    id: clip.id,
    assetId: clip.assetId,
    sourcePath: clip.sourcePath,
    trackId: clip.trackId,
    trackKind: trackById.get(String(clip.trackId))?.kind,
    kind: clip.kind,
    startSec: clip.startSec,
    inPointSec: clip.inPointSec,
    outPointSec: clip.outPointSec,
    speed: clip.speed,
    volume: clip.volume,
    muted: clip.muted,
    detachedFromClipId: clip.detachedFromClipId,
    denoise: clip.denoise,
    hasAudio: clip.hasAudio,
  }))
  return spec
}

/**
 * Render `clips`/`tracks` on the backend and resolve to the download URL of the
 * finished MP4. Mirrors ExportDialog.runServerExport.
 */
export async function runServerExport(params: ServerExportParams): Promise<ServerExportResult> {
  const { settings, durationSec, clips, tracks, assets, signal, onProgress, onAssetHash,
          outputDir, outputName } = params
  onProgress?.(0, 'Uploading media')

  // 1. Content-hash, then upload the assets the server is missing.
  const hashByAssetId = await syncServerMediaAssets({
    clips,
    assets,
    signal,
    onAssetHash,
    onProgress: (_pct, stage) => onProgress?.(0, stage),
  })

  // 1b. Ship the bundled caption fonts used on the timeline so libass renders
  // the same faces as the preview (they only exist in the frontend bundle), and
  // pre-wrap plain captions with the browser's own metrics so libass breaks
  // lines exactly where the preview does.
  const captionFonts = await syncCaptionFonts(clips, signal)
  const wrappedById = await precomputeWrappedLines(clips, settings.width, settings.height)

  // 2. Build spec + start the job. outputDir/outputName ride along on the spec
  // (the backend's ExportSpec allows extra fields) so the server writes the mp4
  // straight into the user's folder instead of keeping it for download.
  onProgress?.(0, 'Rendering')
  const spec = {
    ...buildExportSpec(settings, durationSec, clips, tracks, assets, hashByAssetId),
    ...(captionFonts.length > 0 ? { captionFonts } : {}),
  }
  if (wrappedById.size > 0) {
    for (const clip of spec.clips) {
      const lines = wrappedById.get(clip.id as string)
      const td = clip.textData as Record<string, unknown> | null
      if (lines && td) clip.textData = { ...td, wrappedLines: lines }
    }
  }
  const requestId = crypto.randomUUID().replaceAll('-', '')
  let started: Awaited<ReturnType<typeof startServerExport>>
  try {
    started = await startServerExport(
      outputDir ? { ...spec, outputDir, outputName: outputName ?? 'export' } : spec,
      signal,
      requestId,
    )
  } catch (e) {
    // requestId is also the backend job id. If cancellation raced a committed
    // start whose response was lost, this still reaches and kills that job.
    // Cancelling is harmless when validation failed before job creation, and
    // essential when every response was lost after the backend committed it.
    await cancelServerExport(requestId)
    throw e
  }
  const { jobId, outputPath } = started

  // 3. Poll until done.
  let diag: ServerExportDiag | undefined
  let lastPct = 0
  let consecutiveStatusFailures = 0
  let reconnectStartedAt = 0
  try {
    for (;;) {
      if (signal.aborted) throw abortErr()
      let st: Awaited<ReturnType<typeof getExportStatus>>
      try {
        st = await getExportStatus(jobId, signal)
        consecutiveStatusFailures = 0
        reconnectStartedAt = 0
      } catch (e) {
        if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e
        if (!isRetryableBackendPollError(e)) throw e
        consecutiveStatusFailures++
        reconnectStartedAt ||= Date.now()
        if (Date.now() - reconnectStartedAt >= MAX_BACKEND_RECONNECT_MS) {
          await cancelServerExport(jobId)
          throw new Error(
            'Backend remained unreachable for 5 minutes; export monitoring stopped. ' +
            'Restart the backend and retry this item.',
          )
        }
        // A long render must survive temporary backend/HDD saturation, while a
        // bounded outage window prevents an abandoned request polling forever.
        onProgress?.(lastPct, 'Reconnecting to backend')
        await abortableDelay(
          Math.min(10_000, 500 * 2 ** Math.min(5, consecutiveStatusFailures - 1)),
          signal,
        )
        continue
      }
      if (st.diag) diag = st.diag
      lastPct = Math.round(st.pct)
      // The backend is in 'setup' (materializing inputs + probing the encoder,
      // ~20s at pct 0) before ffmpeg starts, and still muxes + copies the output
      // into the target folder at pct 100 before flipping to 'done'. Label both
      // so the progress bar isn't stuck on "Rendering" while apparently frozen.
      const stage =
        st.status === 'setup' || lastPct <= 0
          ? 'Preparing inputs'
          : lastPct >= 99
            ? 'Writing output file'
            : 'Rendering'
      onProgress?.(lastPct, stage)
      if (st.status === 'done') break
      if (st.status === 'error') throw new Error(st.error || 'Server export failed')
      if (st.status === 'cancelled') throw abortErr()
      await abortableDelay(500, signal)
    }
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      await cancelServerExport(jobId)
      throw abortErr()
    }
    throw e
  }

  onProgress?.(100, 'Done')
  return {
    downloadUrl: exportDownloadUrl(jobId),
    savedPath: outputPath ?? undefined,
    diag,
  }
}
