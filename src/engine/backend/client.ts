/**
 * Client for the optional XinChao-Cut backend (FastAPI + FFmpeg + WhisperX).
 *
 * The whole app works without it: every call here is guarded by `getCapabilities()`
 * which returns null when no `VITE_BACKEND_URL` is set or `/health` is unreachable,
 * letting callers fall back to the in-browser path.
 */
import type { SubtitleCue } from '@engine/subtitle/srt'

const BASE = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/+$/, '')

function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export interface BackendRuntime {
  /** The default H.264 encoder used for proxies/exports. Per-job diagnostics
   * may report HEVC/AV1 encoders selected by the export request. null until the
   * server's background probe finishes (a few seconds after start). */
  videoEncoder: string | null
  /** Working encoder selected per requested family; null means that family
   * would fall back to H.264. Absent while probing or on older backends. */
  videoEncoders?: Partial<Record<'h264' | 'hevc' | 'av1', string | null>> | null
  hdr10VideoEncoders?: Partial<Record<'hevc' | 'av1', string | null>> | null
  /** Resolved packaged/PATH FFmpeg identity for reproducible diagnostics. */
  ffmpeg?: {
    available: boolean
    path: string | null
    probePath: string | null
    version: string | null
  } | null
  /** NVIDIA display driver when nvidia-smi is available. */
  gpuDriver?: string | null
  cuda: { available: boolean; device: string | null; loaded?: boolean; probing?: boolean }
}

export interface BackendCapabilities {
  media: boolean
  transcribe: boolean
  /** Optional Chinese-focused FunASR runtime. */
  funasr?: boolean
  export: boolean
  separate: boolean
  sceneSplit: boolean
  translate: boolean
  /** Optional OmniVoice text-to-speech (/tts). Absent on older backends. */
  tts: boolean
  /** GPU / encoder diagnostics; absent on older backends. */
  runtime?: BackendRuntime
}

export function backendConfigured(): boolean {
  return BASE.length > 0
}

/**
 * Turn a thrown error into a user-facing message. A bare `fetch` network failure
 * (the backend isn't running / unreachable) surfaces as "Failed to fetch", which
 * is opaque — map it to a clear "backend offline, start it" hint.
 */
export function describeBackendError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (!BASE) return 'The backend is not configured (VITE_BACKEND_URL).'
  if (/failed to fetch|networkerror|load failed|err_connection/i.test(msg)) {
    return 'The backend is offline — run start-backend.bat and try again.'
  }
  return msg
}

let healthCache: { at: number; caps: BackendCapabilities; probing: boolean } | null = null
const HEALTH_TTL_MS = 30_000  // serve a fresh success without refetching
const PROBING_HEALTH_TTL_MS = 1_000 // incomplete hardware probe must refresh quickly
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
  if (
    healthCache &&
    now - healthCache.at < (healthCache.probing ? PROBING_HEALTH_TTL_MS : HEALTH_TTL_MS)
  ) return healthCache.caps
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
      tts: !!data?.capabilities?.tts,
      runtime: rt
        ? {
            videoEncoder: typeof rt.videoEncoder === 'string' ? rt.videoEncoder : null,
            videoEncoders: parseEncoderMap(rt.videoEncoders, ['h264', 'hevc', 'av1']),
            hdr10VideoEncoders: parseEncoderMap(rt.hdr10VideoEncoders, ['hevc', 'av1']),
            ffmpeg: parseFfmpegRuntime(rt.ffmpeg),
            gpuDriver: typeof rt.gpuDriver === 'string' ? rt.gpuDriver : null,
            cuda: {
              available: !!rt?.cuda?.available,
              device: typeof rt?.cuda?.device === 'string' ? rt.cuda.device : null,
              loaded: typeof rt?.cuda?.loaded === 'boolean' ? rt.cuda.loaded : undefined,
              probing: rt?.cuda?.probing === true,
            },
          }
        : undefined,
    }
    const probing = !!(
      rt && (
        rt.videoEncoder == null ||
        rt.ffmpeg == null ||
        rt.cuda?.probing === true
      )
    )
    healthCache = { at: now, caps, probing }
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

/** A live snapshot of backend job queues + GPU/VRAM usage (GET /metrics). Shape
 * is intentionally loose — it's diagnostics, polled and rendered as-is. */
export interface BackendMetrics {
  vram: {
    available: boolean
    reason?: string
    devices?: Array<{
      index: number
      name: string
      totalMB: number
      freeMB: number
      usedMB: number
      allocatedMB: number
      reservedMB: number
      utilizationPct: number | null
    }>
  }
  gpuGuard: {
    enabled: boolean
    freeMB: number | null
    minFreeMB: number
    waiting: Array<{ kind: string; waitingSec: number; freeMB: number; needMB: number }>
    error?: string
  }
  activeTasks: Array<{
    kind: string
    id: string
    label: string
    pct: number
    etaSec: number | null
    step: string | null
  }>
  jobs: Record<string, { total?: number; byStatus?: Record<string, number>; queueDepth?: number; error?: string }>
  models: Record<string, unknown>
}

/** Fetch a live metrics snapshot, or null if unconfigured/unreachable. Useful for
 * a GPU Diagnostics panel and for debugging the VRAM-thrash hangs. */
export async function getBackendMetrics(signal?: AbortSignal): Promise<BackendMetrics | null> {
  if (!BASE) return null
  try {
    const res = await fetch(`${BASE}/metrics`, { signal: signal ?? AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as BackendMetrics
  } catch {
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

function parseEncoderMap<K extends string>(
  value: unknown,
  keys: readonly K[],
): Partial<Record<K, string | null>> | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const parsed: Partial<Record<K, string | null>> = {}
  for (const key of keys) {
    const encoder = source[key]
    if (typeof encoder === 'string' || encoder === null) parsed[key] = encoder
  }
  return parsed
}

function parseFfmpegRuntime(value: unknown): BackendRuntime['ffmpeg'] {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const optionalString = (entry: unknown): string | null =>
    typeof entry === 'string' ? entry : null
  return {
    available: source.available === true,
    path: optionalString(source.path),
    probePath: optionalString(source.probePath),
    version: optionalString(source.version),
  }
}

/** Ask the backend to clear transient encoder probe failures and refresh its
 * runtime diagnostics. The request returns immediately; normal health polling
 * picks up the refreshed values once the bounded background probe completes. */
export async function reprobeBackendRuntime(): Promise<boolean> {
  if (!BASE) return false
  try {
    const res = await fetch(`${BASE}/runtime/reprobe`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** HTTP failure that preserves status so lifecycle code can distinguish a
 * temporary outage from a permanent protocol/job error. */
export class BackendHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'BackendHttpError'
    this.status = status
  }
}

async function httpError(res: Response): Promise<BackendHttpError> {
  return new BackendHttpError(res.status, await readError(res))
}

/** Polling may outlive brief backend/HDD stalls, but must not loop forever on
 * a missing job, invalid request, or incompatible endpoint. */
export function isRetryableBackendPollError(error: unknown): boolean {
  if (error instanceof BackendHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  if (error instanceof DOMException) return error.name === 'TimeoutError'
  // Browser fetch rejects network/DNS/connection failures as TypeError.
  return error instanceof TypeError
}

export type BackendMediaSource = Blob | { sourcePath: string; filename?: string }

export interface BackendTranscribeProgress {
  stage: string
  pct: number
  status?: string
  estimated?: boolean
}

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
  opts: {
    language?: string
    model?: string
    provider?: 'auto' | 'whisperx' | 'funasr'
    signal?: AbortSignal
    onProgress?: (progress: BackendTranscribeProgress) => void
  } = {},
): Promise<SubtitleCue[]> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, source instanceof Blob ? 'audio' : (source.filename ?? 'audio'))
  fd.append('language', opts.language ?? 'auto')
  if (opts.model) fd.append('model', opts.model)
  fd.append('provider', opts.provider ?? 'auto')
  const progressToken = crypto.randomUUID().replaceAll('-', '')
  fd.append('progressToken', progressToken)
  opts.onProgress?.({ stage: source instanceof Blob ? 'uploading' : 'queued', pct: 0 })

  let polling = false
  const poll = async () => {
    if (polling || opts.signal?.aborted) return
    polling = true
    try {
      const status = await fetch(`${BASE}/transcribe/progress/${progressToken}`, {
        signal: opts.signal,
      })
      if (status.ok) {
        opts.onProgress?.(await status.json() as BackendTranscribeProgress)
      }
    } catch {
      if (opts.signal?.aborted) return
      // The progress file does not exist until FastAPI has received a Blob in
      // full. Network hiccups here must not cancel the actual transcription.
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => { void poll() }, 750)
  try {
    const res = await fetch(`${BASE}/transcribe`, { method: 'POST', body: fd, signal: opts.signal })
    if (!res.ok) throw new Error(await readError(res))
    const data = await res.json()
    opts.onProgress?.({ stage: 'done', pct: 100, status: 'done' })
    return (data?.cues ?? []) as SubtitleCue[]
  } finally {
    clearInterval(timer)
  }
}

/** Generate a thumbnail strip (JPEG data URLs) server-side. */
export async function thumbnailsViaBackend(
  source: BackendMediaSource,
  count: number,
  width = 160,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, source instanceof Blob ? 'video' : (source.filename ?? 'video'))
  fd.append('count', String(count))
  fd.append('width', String(width))
  const res = await fetch(`${BASE}/media/thumbnails`, { method: 'POST', body: fd, signal })
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
  opts: {
    threshold?: number
    minGapSec?: number
    maxScenes?: number
    filename?: string
    signal?: AbortSignal
  } = {},
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
  const res = await fetch(`${BASE}/media/scenes`, {
    method: 'POST',
    body: fd,
    signal: withRequestTimeout(opts.signal, 30 * 60_000),
  })
  if (res.status === 404) {
    throw new Error('Split scenes endpoint not found. Restart the backend server.')
  }
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export async function getSceneDetectStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<SceneDetectStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/scenes/${jobId}`, {
    signal: withRequestTimeout(signal, 15_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as SceneDetectStatus
  data.scenes = (data.scenes ?? []).filter((sec) => Number.isFinite(sec))
  return data
}

export async function cancelSceneDetect(jobId: string): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/media/scenes/${jobId}/cancel`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}

export interface TranslateConnectionResult {
  ok: boolean
  provider?: string | null
  model?: string
  sample?: string
  error?: string
}

export interface AiTaskConnectionResult extends TranslateConnectionResult {
  task: string
}

export interface CaptionCorrectionCue {
  id: string
  content: string
}

export interface CorrectCaptionCuesResult {
  corrections: Record<string, string>
  provider: string
  model: string
}

/** Proofread one bounded cue batch. Callers intentionally batch client-side so
 * they can show real progress and only commit after every batch succeeds. */
export async function correctCaptionCues(
  input: {
    cues: CaptionCorrectionCue[]
    language?: string
    instructions?: string
    context_before?: string[]
    context_after?: string[]
  },
  signal?: AbortSignal,
): Promise<CorrectCaptionCuesResult> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/captions/correct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: withRequestTimeout(signal, 360_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as CorrectCaptionCuesResult
}

/** Verify one configured AI task can reach its provider/key/model. */
export async function testAiTaskConnection(task: string): Promise<AiTaskConnectionResult> {
  if (!BASE) return { ok: false, task, error: 'Backend not configured' }
  try {
    const res = await fetch(`${BASE}/ai-config/test/${encodeURIComponent(task)}`, { method: 'POST' })
    if (!res.ok) return { ok: false, task, error: await readError(res) }
    return (await res.json()) as AiTaskConnectionResult
  } catch (e) {
    return { ok: false, task, error: e instanceof Error ? e.message : 'Request failed' }
  }
}

// ── AI provider config: one INDEPENDENT connection per task ────────────────
// Each task has its own provider, base URL, API key, and model.

export type AiTaskSource = 'config' | 'env' | 'none'

export interface AiTaskStatus {
  provider: string
  baseUrl: string
  model: string
  /** Whether an API key is set for this task (the key itself is never returned). */
  hasKey: boolean
  /** Where this task's active connection comes from. */
  source: AiTaskSource
}

export interface AiConfig {
  providers: string[]
  /** Task ids, each with its own connection. */
  tasks: string[]
  defaultModels: Record<string, string>
  defaultBase: Record<string, string>
  /** Effective status per task — never leaks key material. */
  taskConfigs: Record<string, AiTaskStatus>
}

export interface AiTaskInput {
  /** Empty provider clears this task's override (falls back to env). */
  provider: string
  baseUrl?: string
  /** Blank = keep the previously saved key for this task (same provider only). */
  apiKey?: string
  model?: string
}

export async function getAiConfig(): Promise<AiConfig> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/ai-config`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AiConfig
}

/** Save one or more task connections in a single call (only send what changed). */
export async function saveAiConfig(tasks: Record<string, AiTaskInput>): Promise<AiConfig> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/ai-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AiConfig
}

/** Clear one task's connection (falls back to env for that task only). */
export async function deleteAiTaskConfig(task: string): Promise<AiConfig> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/ai-config/${encodeURIComponent(task)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AiConfig
}

/** Clear every task's connection. */
export async function deleteAiConfig(): Promise<AiConfig> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/ai-config`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as AiConfig
}

// ── Text-to-speech (OmniVoice, offline, job-based) ─────────────────────────

export interface TtsVoice {
  id: string
  name: string
  /** "preset" = built-in voice design; "clone" = a saved cloned voice. */
  type?: 'preset' | 'clone'
  /** Voice gender bucket used for grouping in the picker. */
  gender?: 'male' | 'female' | 'unknown'
  /** Best-effort source/accent language bucket for grouping in voice pickers. */
  language?: string
  /** True when the canonical cached preview file already exists. */
  hasPreview?: boolean
  /** mtime-based cache key for the canonical preview file. */
  previewVersion?: number
}

const KNOWN_VOICE_GENDERS: Record<string, NonNullable<TtsVoice['gender']>> = {
  'narrator-m': 'male',
  'energetic-m': 'male',
  'british-m': 'male',
  'narrator-f': 'female',
  'energetic-f': 'female',
  'us-f': 'female',
  voice_cc706bf16e: 'male',
  voice_a671d47c68: 'male',
  voice_26d04c9109: 'male',
  voice_c9230ca89f: 'male',
  voice_6a96f62e8b: 'male',
  voice_842a742632: 'female',
  voice_a80428ae68: 'female',
  voice_b51302abf1: 'female',
  voice_edd82ab435: 'female',
  voice_e2a2173669: 'female',
}

const KNOWN_VOICE_LANGUAGES: Record<string, string> = {
  'narrator-m': 'multi',
  'energetic-m': 'multi',
  'narrator-f': 'multi',
  'energetic-f': 'multi',
  'british-m': 'en',
  'us-f': 'en',
  voice_cc706bf16e: 'en',
  voice_842a742632: 'vi',
  voice_a80428ae68: 'ja',
  voice_b51302abf1: 'ko',
  voice_a671d47c68: 'de',
  voice_26d04c9109: 'ko',
  voice_c9230ca89f: 'en',
  voice_edd82ab435: 'ko',
  voice_e2a2173669: 'en',
}

function normalizeVoiceGender(voice: TtsVoice): NonNullable<TtsVoice['gender']> {
  if (voice.gender === 'male' || voice.gender === 'female' || voice.gender === 'unknown') return voice.gender
  const known = KNOWN_VOICE_GENDERS[voice.id]
  if (known) return known
  const name = voice.name.toLowerCase()
  if (/\bnam\b|\bmale\b|brian|adam|theo|tim|yohan/.test(name)) return 'male'
  if (/\bn\u1eef\b|\bfemale\b|ng\u1ecdc|huy\u1ec1n|kano|annie|yooni|kristen/.test(name)) return 'female'
  return 'unknown'
}

function normalizeVoiceLanguage(voice: TtsVoice): string {
  const raw = (voice.language ?? '').trim().toLowerCase()
  const aliases: Record<string, string> = {
    vn: 'vi',
    vie: 'vi',
    vietnamese: 'vi',
    eng: 'en',
    english: 'en',
    jp: 'ja',
    jpn: 'ja',
    japanese: 'ja',
    kr: 'ko',
    kor: 'ko',
    korean: 'ko',
    ger: 'de',
    deu: 'de',
    german: 'de',
    cn: 'zh',
    chi: 'zh',
    chinese: 'zh',
  }
  if (raw) return aliases[raw] ?? raw
  const known = KNOWN_VOICE_LANGUAGES[voice.id]
  if (known) return known
  const name = voice.name.toLowerCase()
  if (/\(en\)|english|brian|adam|kristen|us|british/.test(name)) return 'en'
  if (/\(kr\)|\(ko\)|korean|yooni|annie|theo/.test(name)) return 'ko'
  if (/\(jp\)|\(ja\)|japanese|kano/.test(name)) return 'ja'
  if (/\(ger\)|\(de\)|german|turbo tim/.test(name)) return 'de'
  if (/ng\u1ecdc|huy\u1ec1n|\(vi\)|vietnam/.test(name)) return 'vi'
  return 'unknown'
}

export interface TtsJobStatus {
  id: string
  status: 'queued' | 'loading' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled'
  pct: number
  done: number
  total: number
  error?: string | null
}

/** List the voice-design presets (plus the "clone" pseudo-voice). */
export async function listTtsVoices(): Promise<TtsVoice[]> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/tts/voices`)
  if (!res.ok) throw new Error(await readError(res))
  const voices = ((await res.json())?.voices ?? []) as TtsVoice[]
  return voices.map((voice) => ({
    ...voice,
    gender: normalizeVoiceGender(voice),
    language: normalizeVoiceLanguage(voice),
  }))
}

export interface StartTtsParams {
  /** One or more lines to synthesize (each becomes its own output clip). */
  texts: string[]
  /** A voice id: a preset, a saved cloned voice, or "" for auto. */
  voice?: string
  /** Speed multiplier (>1 faster). 0/undefined = model default. */
  speed?: number
  /** Target language code (vi/en/…). Empty = OmniVoice auto-detect. */
  language?: string
}

/** Start an async TTS job. Returns the job id; poll {@link getTtsStatus}. */
export async function startTts(params: StartTtsParams): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  fd.append('texts', JSON.stringify(params.texts))
  if (params.voice) fd.append('voice', params.voice)
  if (params.speed) fd.append('speed', String(params.speed))
  if (params.language) fd.append('language', params.language)
  const res = await fetch(`${BASE}/tts`, { method: 'POST', body: fd })
  if (res.status === 404) throw new Error('TTS endpoint not found. Restart the backend server.')
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

/** Auto-transcribe a clone sample (WhisperX) so the user can review/correct the
 *  ref-text before saving the voice. Returns "" when WhisperX is unavailable. */
export async function transcribeVoiceSample(file: Blob): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  fd.append('ref', file, 'sample')
  const res = await fetch(`${BASE}/tts/voices/transcribe-sample`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json())?.text ?? '') as string
}

/** Create a reusable cloned voice from an uploaded audio sample. */
export async function createVoice(params: {
  name: string
  gender?: TtsVoice['gender']
  language?: string
  ref: Blob
  refText?: string
}): Promise<TtsVoice> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  fd.append('name', params.name)
  fd.append('gender', params.gender ?? 'unknown')
  if (params.language) fd.append('language', params.language)
  if (params.refText) fd.append('refText', params.refText)
  fd.append('ref', params.ref, 'sample')
  const res = await fetch(`${BASE}/tts/voices`, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TtsVoice
}

/**
 * URL of a saved clone's pre-rendered "preview" sample. The server stores a
 * sample WAV at voice-creation time (and lazily synthesizes + caches one for
 * older voices), so playing a preview is just streaming a file — no re-synth.
 */
export function voicePreviewUrl(id: string, version?: number): string {
  const qs = version ? `?v=${encodeURIComponent(String(version))}` : ''
  return `${BASE}/tts/voices/${id}/preview${qs}`
}

export async function deleteVoice(id: string): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/tts/voices/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

/** Rename a saved (cloned) voice. */
export async function renameVoice(
  id: string,
  name: string,
  gender?: TtsVoice['gender'],
  language?: string,
): Promise<TtsVoice> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  fd.append('name', name)
  if (gender) fd.append('gender', gender)
  if (language) fd.append('language', language)
  const res = await fetch(`${BASE}/tts/voices/${id}`, { method: 'PATCH', body: fd })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TtsVoice
}

export async function getTtsStatus(jobId: string): Promise<TtsJobStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/tts/${jobId}`)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as TtsJobStatus
}

/** Download the synthesized WAV for line `index` of a finished job. */
export async function ttsDownload(jobId: string, index: number): Promise<Blob> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/tts/${jobId}/download/${index}`)
  if (!res.ok) throw new Error(await readError(res))
  return res.blob()
}

export async function cancelTts(jobId: string): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/tts/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
}

/** Extract normalised waveform peaks server-side. */
export async function waveformViaBackend(
  source: BackendMediaSource,
  maxPeaks = 4000,
  signal?: AbortSignal,
): Promise<number[]> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, source instanceof Blob ? 'audio' : (source.filename ?? 'audio'))
  fd.append('maxPeaks', String(maxPeaks))
  const res = await fetch(`${BASE}/media/waveform`, { method: 'POST', body: fd, signal })
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
export async function hashBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  }
  throwIfAborted()
  // Fast path: small files fit in one digest with no extra hashing pass, and
  // peak RAM is just the file size (≤ 64 MB).
  if (blob.size <= HASH_CHUNK) {
    return toHex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
  }
  const chunks = Math.ceil(blob.size / HASH_CHUNK)
  const combined = new Uint8Array(chunks * 32) // SHA-256 = 32 bytes per chunk
  for (let i = 0; i < chunks; i++) {
    // Multi-GB hash used to ignore cancel — export cancel sat spinning through
    // every 64 MB slice. Check between chunks so AbortSignal stops promptly.
    throwIfAborted()
    const start = i * HASH_CHUNK
    const slice = blob.slice(start, Math.min(start + HASH_CHUNK, blob.size))
    const digest = await crypto.subtle.digest('SHA-256', await slice.arrayBuffer())
    combined.set(new Uint8Array(digest), i * 32)
    // slice + its ArrayBuffer fall out of scope here → only one slice stays live.
  }
  throwIfAborted()
  return toHex(await crypto.subtle.digest('SHA-256', combined))
}

/** Ask the server which content hashes it's missing. */
export async function checkAssets(hashes: string[], signal?: AbortSignal): Promise<string[]> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/assets/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes }),
    signal: withRequestTimeout(signal, 15_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  return ((await res.json())?.missing ?? []) as string[]
}

/** Download a stored asset's bytes by content hash. Recovery path for when the
 *  LOCAL media row is gone (cleared storage / moved machine / restored project)
 *  but the server still holds the file by hash — e.g. a restored project needs the
 *  source video locally to build the editor project. Streams the whole blob into
 *  memory, so it's an on-demand recovery, not a hot path. */
export async function fetchAssetByHash(
  hash: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; contentType: string }> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/assets/${hash}`, { signal })
  if (!res.ok) throw new Error(await readError(res))
  const blob = await res.blob()
  const contentType = res.headers.get('Content-Type') || blob.type || 'application/octet-stream'
  return { blob, contentType }
}

/** Stream a recovered content-addressed asset directly to durable storage. */
export async function downloadAssetByHashTo(
  hash: string,
  write: DownloadChunkWriter,
  signal?: AbortSignal,
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/assets/${hash}`, {
    signal: withRequestTimeout(signal, 30 * 60_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  const contentType = res.headers.get('Content-Type') || 'application/octet-stream'
  await streamDownloadResponse(res, write)
  return contentType
}

/** Resolve the colocated backend asset to a desktop path for zero-copy Editor
 * recovery. Browser builds use fetchAssetByHash instead. */
export async function getAssetInfoByHash(
  hash: string,
  signal?: AbortSignal,
): Promise<{ path: string; name: string; sizeBytes: number }> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/assets/${hash}/info`, { signal })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json() as { path?: unknown; name?: unknown; sizeBytes?: unknown }
  if (typeof data.path !== 'string' || !data.path) {
    throw new Error('Backend did not return the stored asset path')
  }
  return {
    path: data.path,
    name: typeof data.name === 'string' && data.name ? data.name : hash,
    sizeBytes: Math.max(0, Number(data.sizeBytes) || 0),
  }
}

/** Let the colocated desktop backend stream/hash a local path directly. This
 * avoids `fetch(asset://...).blob()` materialising a multi-GB source in JS. */
export async function adoptLocalAssetPath(
  sourcePath: string,
  filename?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/assets/adopt-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath, filename }),
    signal,
  })
  if (!res.ok) throw new Error(await readError(res))
  const payload = await res.json() as { hash?: string; assetId?: string }
  const hash = payload.hash || payload.assetId
  if (!hash) throw new Error('Backend did not return an adopted asset hash')
  return hash
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

export async function startServerExport(
  spec: unknown,
  signal?: AbortSignal,
  stableRequestId?: string,
): Promise<{ jobId: string; outputPath: string | null }> {
  if (!BASE) throw new Error('Backend not configured')
  const requestId = stableRequestId ?? crypto.randomUUID().replaceAll('-', '')
  const body = JSON.stringify({ ...(spec as Record<string, unknown>), requestId })
  const res = await directStreamRequestWithRetry(() => fetch(`${BASE}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: withRequestTimeout(signal, 30_000),
    }), 3, signal)
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return { jobId: data.jobId as string, outputPath: (data.outputPath ?? null) as string | null }
}

export interface ServerExportDiag {
  encoder: string
  encodeOnGpu: boolean
  decode: 'none' | 'per-chunk' | 'cuvid' | 'hwaccel' | 'cpu'
  path: 'copy' | 'fast' | 'general' | 'chunked' | 'hybrid' | 'hybrid-chunked'
  cpuCompositor: boolean
  videoCodec?: 'h264' | 'hevc' | 'av1'
  requestedVideoCodec?: 'h264' | 'hevc' | 'av1'
  dynamicRange?: 'sdr' | 'hdr10'
  clips?: number
  filtergraphChars?: number
  /** Wall-clock seconds the ffmpeg render took. */
  renderSec?: number
  /** Render speed as a multiple of realtime (duration / renderSec). */
  speedX?: number
  /** False when the source H.264 packets were copied without quality loss. */
  videoReencoded?: boolean
}

export interface ServerExportStatus {
  id: string
  status: 'setup' | 'running' | 'done' | 'error' | 'cancelled'
  pct: number
  error?: string | null
  diag?: ServerExportDiag
}

export async function getExportStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<ServerExportStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/export/${jobId}`, {
    signal: withRequestTimeout(signal, 10_000),
  })
  if (!res.ok) throw await httpError(res)
  return (await res.json()) as ServerExportStatus
}

export async function cancelServerExport(jobId: string, signal?: AbortSignal): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/export/${jobId}/cancel`, {
    method: 'POST',
    signal: withRequestTimeout(signal, 10_000),
  }).catch(() => {})
}

export function exportDownloadUrl(jobId: string): string {
  return `${BASE}/export/${jobId}/download`
}

/** Ask the backend for the next non-colliding export name (no extension) in a
 * folder — e.g. "2406(1)" when "2406.mp4" already exists. Falls back to `name`. */
export async function suggestExportName(dir: string, name: string): Promise<string> {
  if (!BASE || !dir) return name
  try {
    const q = `dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`
    const res = await fetch(`${BASE}/export/suggest-name?${q}`)
    if (!res.ok) return name
    return ((await res.json()).name as string) || name
  } catch {
    return name
  }
}

/** Write an already-rendered blob (browser export) straight into the user's
 * chosen folder via the backend. Returns the absolute path it was saved to. */
export async function saveLocalExport(
  blob: Blob,
  outputDir: string,
  outputName: string,
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const form = new FormData()
  form.append('file', blob, `${outputName || 'export'}.mp4`)
  form.append('outputDir', outputDir)
  form.append('outputName', outputName)
  // Deadline: a half-dead backend (port open, app hung) used to hang this fetch
  // forever AFTER a successful render — the dialog then sat at "100%" with the
  // finished mp4 stranded in memory. 5 min covers multi-GB writes to slow disks.
  const res = await fetch(`${BASE}/export/save-local`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(300_000),
  }).catch((e) => {
    throw new Error(
      `Unable to write the file to the export folder because the backend did not respond: ${String(e)}. ` +
      'The video finished rendering — try Export again, or clear "Save to" for a direct download.',
    )
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).path as string
}

export interface BrowserExportStreamSession {
  streamId: string
  path: string
}

export async function directStreamRequestWithRetry(
  makeRequest: () => Promise<Response>,
  attempts = 3,
  abortSignal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      const res = await makeRequest()
      if (res.ok) return res
      if (res.status < 500 || attempt === attempts - 1) return res
      lastError = new Error(`Browser export stream HTTP ${res.status}`)
      await res.body?.cancel().catch(() => {})
    } catch (e) {
      lastError = e
      if (abortSignal?.aborted) throw e
      if (attempt === attempts - 1) break
    }
    const delayMs = Math.min(5_000, 250 * 2 ** attempt)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        abortSignal?.removeEventListener('abort', onAbort)
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      const timer = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort)
        resolve()
      }, delayMs)
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      // Close the tiny race between the loop's pre-check and listener setup.
      if (abortSignal?.aborted) onAbort()
    })
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Browser export stream request failed: ${String(lastError)}`)
}

export async function preflightBrowserExportStream(
  outputDir: string,
  outputName: string,
  estimatedBytes: number,
): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await directStreamRequestWithRetry(() => fetch(`${BASE}/export/browser-stream/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputDir, outputName, estimatedBytes }),
    signal: AbortSignal.timeout(15_000),
  }))
  if (!res.ok) throw await httpError(res)
}

/** Reserve a final file and open a random-access browser mux stream. */
export async function startBrowserExportStream(
  outputDir: string,
  outputName: string,
  estimatedBytes: number,
  stableRequestId?: string,
  hybridSpec?: unknown,
): Promise<BrowserExportStreamSession> {
  if (!BASE) throw new Error('Backend not configured')
  // Stable across retries: the backend uses this as the stream id, so a lost
  // response cannot create another reservation/temp file on the next attempt.
  const requestId = stableRequestId ?? (typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0')).join(''))
  const body = JSON.stringify({
    outputDir,
    outputName,
    estimatedBytes,
    requestId,
    ...(hybridSpec ? { hybridSpec } : {}),
  })
  const res = await directStreamRequestWithRetry(() => fetch(
    `${BASE}/export/browser-stream/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    },
  ))
  if (!res.ok) throw new Error(await readError(res))
  return res.json() as Promise<BrowserExportStreamSession>
}

export async function heartbeatBrowserExportStream(
  streamId: string,
): Promise<void> {
  if (!BASE || !streamId) return
  const res = await fetch(
    `${BASE}/export/browser-stream/${encodeURIComponent(streamId)}/heartbeat`,
    { method: 'POST', signal: AbortSignal.timeout(15_000) },
  )
  if (!res.ok && res.status !== 404) throw new Error(await readError(res))
}

export async function writeBrowserExportChunk(
  streamId: string,
  position: number,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await directStreamRequestWithRetry(() => fetch(
      `${BASE}/export/browser-stream/${encodeURIComponent(streamId)}/chunk?position=${position}`,
      {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data.buffer as ArrayBuffer,
      signal: withRequestTimeout(signal, 120_000),
      },
    ), 30, signal)
  if (!res.ok) throw new Error(await readError(res))
}

export async function finalizeBrowserExportStream(
  streamId: string,
  expectedSize: number,
  signal?: AbortSignal,
  onProgress?: (pct: number) => void,
  videoCodec?: 'h264' | 'hevc' | 'av1',
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await directStreamRequestWithRetry(() => fetch(
      `${BASE}/export/browser-stream/${encodeURIComponent(streamId)}/finalize`,
      {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedSize, ...(videoCodec ? { videoCodec } : {}) }),
      signal: withRequestTimeout(signal, 120_000),
      },
    ), 30, signal)
  if (!res.ok) throw new Error(await readError(res))
  const result = await res.json() as { path: string; jobId?: string }
  if (!result.jobId) return result.path

  // Hybrid finalize is asynchronous: keep the worker in its muxing phase while
  // polling the regular durable export Job. The browser stream DELETE endpoint
  // uses the same stable id and therefore cancels either upload or mux safely.
  let reconnectStartedAt = 0
  for (;;) {
    if (signal?.aborted) {
      await cancelServerExport(result.jobId)
      throw new DOMException('Cancelled', 'AbortError')
    }
    try {
      const status = await getExportStatus(result.jobId, signal)
      reconnectStartedAt = 0
      onProgress?.(Math.max(0, Math.min(100, status.pct)))
      if (status.status === 'done') return result.path
      if (status.status === 'error') {
        throw new Error(status.error || 'Hybrid audio mux failed')
      }
      if (status.status === 'cancelled') {
        throw new DOMException('Cancelled', 'AbortError')
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        await cancelServerExport(result.jobId)
        throw error
      }
      if (!isRetryableBackendPollError(error)) throw error
      reconnectStartedAt ||= Date.now()
      if (Date.now() - reconnectStartedAt >= 5 * 60_000) {
        await cancelServerExport(result.jobId)
        throw new Error('Backend remained unreachable while finalizing Hybrid Export')
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, 500)
      const onAbort = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }
}

export async function cancelBrowserExportStream(streamId: string): Promise<void> {
  if (!BASE || !streamId) return
  await fetch(`${BASE}/export/browser-stream/${encodeURIComponent(streamId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {})
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
export async function startSeparation(
  source: BackendMediaSource,
  filename = 'audio',
  signal?: AbortSignal,
  stableRequestId?: string,
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, filename)
  if (stableRequestId) fd.append('requestId', stableRequestId)
  const res = await directStreamRequestWithRetry(() => fetch(`${BASE}/separate`, {
    method: 'POST',
    body: fd,
    signal: withRequestTimeout(signal, 30 * 60_000),
  }), 3, signal)
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export async function getSeparationStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<SeparationStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/separate/${jobId}`, {
    signal: withRequestTimeout(signal, 10_000),
  })
  if (!res.ok) throw await httpError(res)
  return (await res.json()) as SeparationStatus
}

export async function cancelSeparation(jobId: string): Promise<void> {
  if (!BASE) return
  await fetch(`${BASE}/separate/${jobId}/cancel`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}


// ── Preview proxy generation (FFmpeg) ──────────────────────────────────────

/** Start a low-res preview proxy transcode for a video blob. Returns jobId. */
export async function startProxy(
  source: BackendMediaSource,
  height = 1080,
  filename = 'video',
  signal?: AbortSignal,
): Promise<string> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  appendMediaSource(fd, source, filename)
  fd.append('height', String(height))
  const res = await fetch(`${BASE}/media/proxy`, {
    method: 'POST',
    body: fd,
    signal: withRequestTimeout(signal, 30 * 60_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()).jobId as string
}

export async function getProxyStatus(jobId: string, signal?: AbortSignal): Promise<ServerExportStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/proxy/${jobId}`, {
    signal: withRequestTimeout(signal, 15_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ServerExportStatus
}


/** Stream a finished proxy without materialising the full MP4 in JS memory. */
export async function downloadProxyTo(
  jobId: string,
  write: DownloadChunkWriter,
  signal?: AbortSignal,
): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/proxy/${jobId}/download`, {
    signal: withRequestTimeout(signal, 30 * 60_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  await streamDownloadResponse(res, write)
}

export type DownloadChunkWriter = (chunk: Uint8Array) => Promise<void>

async function streamDownloadResponse(
  res: Response,
  write: DownloadChunkWriter,
): Promise<void> {
  if (!res.body) throw new Error('Streaming response body is unavailable')
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value?.byteLength) await write(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Stream a finished stem without materialising the full WAV in JS memory. */
export async function downloadStemTo(
  jobId: string,
  stem: StemKind,
  write: DownloadChunkWriter,
  signal?: AbortSignal,
): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/separate/${jobId}/download/${stem}`, {
    signal: withRequestTimeout(signal, 30 * 60_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  await streamDownloadResponse(res, write)
}

export async function cancelProxy(jobId: string): Promise<void> {
  if (!BASE) return
  const res = await fetch(`${BASE}/media/proxy/${jobId}/cancel`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    throw new Error(await readError(res))
  }
}

// ── Browser-safe video normalization (FFmpeg) ───────────────────────────────

export interface MediaNormalizationSource {
  blob?: Blob
  sourcePath?: string
  hash?: string
}

export interface MediaNormalizationStatus {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  pct: number
  phase?: 'queued' | 'remux' | 'transcode' | 'done'
  error?: string | null
  hash: string
  cached?: boolean
}

export async function startMediaNormalization(
  source: MediaNormalizationSource,
  filename = 'video',
  signal?: AbortSignal,
): Promise<MediaNormalizationStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const fd = new FormData()
  if (source.blob) fd.append('file', source.blob, filename)
  if (source.sourcePath) fd.append('sourcePath', source.sourcePath)
  if (source.hash) fd.append('hash', source.hash)
  const res = await fetch(`${BASE}/media/normalize`, {
    method: 'POST',
    body: fd,
    signal: withRequestTimeout(signal, 30 * 60_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as MediaNormalizationStatus
}

export async function getMediaNormalizationStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<MediaNormalizationStatus> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(`${BASE}/media/normalize/${encodeURIComponent(jobId)}`, {
    signal: withRequestTimeout(signal, 15_000),
  })
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as MediaNormalizationStatus
}

export async function downloadMediaNormalizationTo(
  jobId: string,
  write: DownloadChunkWriter,
  signal?: AbortSignal,
): Promise<void> {
  if (!BASE) throw new Error('Backend not configured')
  const res = await fetch(
    `${BASE}/media/normalize/${encodeURIComponent(jobId)}/download`,
    { signal: withRequestTimeout(signal, 30 * 60_000) },
  )
  if (!res.ok) throw new Error(await readError(res))
  await streamDownloadResponse(res, write)
}

export async function cancelMediaNormalization(jobId: string): Promise<void> {
  if (!BASE) return
  const res = await fetch(
    `${BASE}/media/normalize/${encodeURIComponent(jobId)}/cancel`,
    { method: 'POST', signal: AbortSignal.timeout(10_000) },
  )
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    throw new Error(await readError(res))
  }
}
