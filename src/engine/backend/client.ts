/**
 * Client for the optional XinChao-Cut backend (FastAPI + FFmpeg + WhisperX).
 *
 * The whole app works without it: every call here is guarded by `getCapabilities()`
 * which returns null when no `VITE_BACKEND_URL` is set or `/health` is unreachable,
 * letting callers fall back to the in-browser path.
 */
import type { SubtitleCue } from '@engine/subtitle/srt'

const BASE = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/+$/, '')

export interface BackendRuntime {
  /** The H.264 encoder the server export/proxy will use ("h264_nvenc",
   * "h264_qsv", "h264_amf", "h264_videotoolbox" or "libx264"). null until the
   * server's background probe finishes (a few seconds after start). */
  videoEncoder: string | null
  cuda: { available: boolean; device: string | null }
}

export interface BackendCapabilities {
  media: boolean
  transcribe: boolean
  export: boolean
  separate: boolean
  sceneSplit: boolean
  translate: boolean
  /** GPU / encoder diagnostics; absent on older backends. */
  runtime?: BackendRuntime
}

export function backendConfigured(): boolean {
  return BASE.length > 0
}

let healthCache: { at: number; caps: BackendCapabilities } | null = null
const HEALTH_TTL_MS = 30_000  // serve a fresh success without refetching
// Tolerate transient poll failures: keep serving the last known-good result for
// this long after the last success. A single slow/timed-out /health poll (common
// when an export pegs the CPU or the browser main thread) then no longer flips
// the UI between online/offline — which used to make the export dialog flicker.
const STALE_GRACE_MS = 60_000

/** Clear the cached health result so the next call hits the network. */
export function clearCapabilitiesCache(): void {
  healthCache = null
}

/**
 * Last-known capabilities, read synchronously with NO network call. Returns
 * null if nothing has been polled yet. Use this on hot paths (e.g. opening a
 * context menu) where awaiting getCapabilities() would add latency — the app's
 * background pollers keep this fresh.
 */
export function getCachedCapabilities(): BackendCapabilities | null {
  return healthCache?.caps ?? null
}

/** Returns backend capabilities, or null if unconfigured/unreachable. */
export async function getCapabilities(): Promise<BackendCapabilities | null> {
  if (!BASE) return null
  const now = Date.now()
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) return healthCache.caps
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) throw new Error(`health ${res.status}`)
    const data = await res.json()
    const rt = data?.runtime
    const caps: BackendCapabilities = {
      media: !!data?.capabilities?.media,
      transcribe: !!data?.capabilities?.transcribe,
      export: !!data?.capabilities?.export,
      separate: !!data?.capabilities?.separate,
      sceneSplit: !!data?.capabilities?.sceneSplit,
      translate: !!data?.capabilities?.translate,
      runtime: rt
        ? {
            videoEncoder: typeof rt.videoEncoder === 'string' ? rt.videoEncoder : null,
            cuda: {
              available: !!rt?.cuda?.available,
              device: typeof rt?.cuda?.device === 'string' ? rt.cuda.device : null,
            },
          }
        : undefined,
    }
    healthCache = { at: now, caps }
    return caps
  } catch {
    // Transient failure — keep the last known-good for a grace period instead of
    // immediately reporting "offline" (avoids UI flapping). Only give up once
    // there's been no success for STALE_GRACE_MS.
    if (healthCache && now - healthCache.at < STALE_GRACE_MS) return healthCache.caps
    healthCache = null
    return null
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    if (typeof data?.detail === 'string') return data.detail
  } catch {
    /* ignore */
  }
  return `Backend error ${res.status}`
}

export type BackendMediaSource = Blob | { sourcePath: string; filename?: string }

function appendMediaSource(fd: FormData, source: BackendMediaSource, fallbackFilename: string): void {
  if (source instanceof Blob) {
    fd.append('file', source, fallbackFilename)
    return
  }
  fd.append('sourcePath', source.sourcePath)
}

/** Transcribe a media blob via WhisperX. Throws on failure. */
export async function transcribeViaBackend(
  source: BackendMediaSource,
  opts: { language?: string; model?: string; signal?: AbortSignal } = {},
): Promise<SubtitleCue[]> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, source instanceof Blob ? 'audio' : (source.filename ?? 'audio'))
  fd.append('language', opts.language ?? 'auto')
  if (opts.model) fd.append('model', opts.model)
  const res = await fetch(`${BASE}/transcribe`, { method: 'POST', body: fd, signal: opts.signal })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data?.cues ?? []) as SubtitleCue[]
}

/** Generate a thumbnail strip (JPEG data URLs) server-side. */
export async function thumbnailsViaBackend(
  source: BackendMediaSource,
  count: number,
  width = 160,
): Promise<string[]> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, source instanceof Blob ? 'video' : (source.filename ?? 'video'))
  fd.append('count', String(count))
  fd.append('width', String(width))
  const res = await fetch(`${BASE}/media/thumbnails`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data?.frames ?? []) as string[]
}

/** Status of an async scene-detection job. */
export interface SceneDetectStatus {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  pct: number
  scenes: number[]
  error?: string | null
}

/** A video source for scene detection: a raw blob, an already-uploaded asset
 * referenced by content hash (no re-upload), or a desktop file path. */
export type SceneDetectSource =
  | Blob
  | { hash: string }
  | { sourcePath: string; filename?: string }

/**
 * Start an async scene-change detection job for a video source. Returns the job
 * id; poll {@link getSceneDetectStatus} for progress and the resulting cut
 * times. Decoding every frame is slow on HD/4K, so this runs server-side in the
 * background with a progress pipe rather than blocking on one request.
 *
 * Pass `{ hash }` or `{ sourcePath }` to reuse media the server already has,
 * skipping a (possibly multi-GB) re-upload.
 */
export async function startSceneDetect(
  source: SceneDetectSource,
  opts: { threshold?: number; minGapSec?: number; maxScenes?: number; filename?: string } = {},
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  if (source instanceof Blob) {
    fd.append('file', source, opts.filename ?? 'video')
  } else if ('hash' in source) {
    fd.append('hash', source.hash)
  } else {
    fd.append('sourcePath', source.sourcePath)
  }
  fd.append('threshold', String(opts.threshold ?? 0.35))
  fd.append('minGapSec', String(opts.minGapSec ?? 0.6))
  fd.append('maxScenes', String(opts.maxScenes ?? 300))
  const res = await fetch(`${BASE}/media/scenes`, { method: 'POST', body: fd })
  if (res.status === 404) {
    throw new Error('Split scenes endpoint not found. Restart the backend server.')
  }
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export async function getSceneDetectStatus(jobId: string): Promise<SceneDetectStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/scenes/${jobId}`)
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as SceneDetectStatus
  data.scenes = (data.scenes ?? []).filter((sec) => Number.isFinite(sec))
  return data
}

export async function cancelSceneDetect(jobId: string): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/media/scenes/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

/**
 * Translate caption lines into `target` (NLLB-200, server-side). `source` is the
 * captions' current language ('auto'/unknown → server defaults to English).
 * Returns one translated string per input, in order. Throws on failure.
 */
export async function translateViaBackend(
  texts: string[],
  target: string,
  source = 'english',
): Promise<string[]> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, target, source }),
  })
  if (res.status === 404) {
    throw new Error('Translate endpoint not found. Restart the backend server.')
  }
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json())?.translations ?? []) as string[]
}

export interface TranslateConnectionResult {
  ok: boolean
  provider?: string | null
  model?: string
  sample?: string
  error?: string
}

/** Verify the configured translation provider/key works (one tiny round-trip). */
export async function testTranslateConnection(): Promise<TranslateConnectionResult> {
  if (!BASE) return { ok: false, error: 'Backend not configured' }
  try {
    const res = await fetch(`${BASE}/translate/test`)
    if (!res.ok) return { ok: false, error: await readError(res) }
    return (await res.json()) as TranslateConnectionResult
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' }
  }
}

/** Extract normalised waveform peaks server-side. */
export async function waveformViaBackend(
  source: BackendMediaSource,
  maxPeaks = 4000,
): Promise<number[]> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, source instanceof Blob ? 'audio' : (source.filename ?? 'audio'))
  fd.append('maxPeaks', String(maxPeaks))
  const res = await fetch(`${BASE}/media/waveform`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return (data?.peaks ?? []) as number[]
}

// ── Server-side export (FFmpeg) ───────────────────────────────────────────

/** 64 MB — the slice size used when hashing large files. */
const HASH_CHUNK = 64 * 1024 * 1024

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Content hash of a blob — the server's content-addressed asset key.
 *
 * Computed over 64 MB slices so a multi-GB video never gets materialised in RAM
 * all at once: `blob.arrayBuffer()` on a 4 GB file would copy the whole thing
 * into the JS heap and can OOM the tab. Web Crypto has no incremental digest, so
 * for large files we hash each slice and then hash the concatenation of those
 * digests (a 2-level / Merkle-style hash). Peak memory stays ~one slice.
 *
 * The result is purely an opaque key — the server stores it as a filename and
 * never re-derives it — so this scheme can differ from a plain SHA-256 of the
 * file. It only needs to be deterministic, which it is: a file's size fixes
 * which branch runs, so identical content always yields the same hash.
 */
export async function hashBlob(blob: Blob): Promise<string> {
  // Fast path: small files fit in one digest with no extra hashing pass, and
  // peak RAM is just the file size (≤ 64 MB).
  if (blob.size <= HASH_CHUNK) {
    return toHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
  }
  const chunks = Math.ceil(blob.size / HASH_CHUNK)
  const combined = new Uint8Array(chunks * 32) // SHA-256 = 32 bytes per chunk
  for (let i = 0; i < chunks; i++) {
    const start = i * HASH_CHUNK
    const slice = blob.slice(start, Math.min(start + HASH_CHUNK, blob.size))
    const digest = await crypto.subtle.digest('SHA-256', await slice.arrayBuffer())
    combined.set(new Uint8Array(digest), i * 32)
    // slice + its ArrayBuffer fall out of scope here → only one slice stays live.
  }
  return toHex(await crypto.subtle.digest('SHA-256', combined))
}

/** Ask the server which content hashes it's missing. */
export async function checkAssets(hashes: string[]): Promise<string[]> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/assets/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json())?.missing ?? []) as string[]
}

export async function uploadAsset(
  blob: Blob,
  hash: string,
  filename: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  fd.append('file', blob, filename)
  fd.append('hash', hash)
  // Pass the signal so cancelling an export aborts an in-flight multi-GB upload
  // instead of letting it run to completion in the background.
  const res = await fetch(`${BASE}/assets/upload`, { method: 'POST', body: fd, signal })
  if (!res.ok) throw new Error(await readError(res))
}

export async function startServerExport(spec: unknown): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export interface ServerExportStatus {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  pct: number
  error?: string | null
}

export async function getExportStatus(jobId: string): Promise<ServerExportStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/export/${jobId}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ServerExportStatus
}

export async function cancelServerExport(jobId: string): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/export/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

export function exportDownloadUrl(jobId: string): string {
  return `${BASE}/export/${jobId}/download`
}

// ── Vocal / music separation (Demucs) ─────────────────────────────────────

export type StemKind = 'vocals' | 'music'

export interface SeparationStatus {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  pct: number
  error?: string | null
  stems: { vocals: boolean; music: boolean }
}

/** Start a vocal/music separation job for an audio/video blob. Returns jobId. */
export async function startSeparation(source: BackendMediaSource, filename = 'audio'): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, filename)
  const res = await fetch(`${BASE}/separate`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export async function getSeparationStatus(jobId: string): Promise<SeparationStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/separate/${jobId}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as SeparationStatus
}

export async function cancelSeparation(jobId: string): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/separate/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

/** Fetch a finished stem as a Blob (WAV). */
export async function downloadStem(jobId: string, stem: StemKind): Promise<Blob> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/separate/${jobId}/download/${stem}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.blob()
}

// ── Preview proxy generation (FFmpeg) ──────────────────────────────────────

/** Start a low-res preview proxy transcode for a video blob. Returns jobId. */
export async function startProxy(
  source: BackendMediaSource,
  height = 1080,
  filename = 'video',
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, filename)
  fd.append('height', String(height))
  const res = await fetch(`${BASE}/media/proxy`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export async function getProxyStatus(jobId: string): Promise<ServerExportStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/proxy/${jobId}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ServerExportStatus
}

/** Fetch the finished proxy as a Blob (MP4). */
export async function downloadProxy(jobId: string): Promise<Blob> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/proxy/${jobId}/download`)
  if (!res.ok) throw new Error(await readError(res))
  return res.blob()
}
