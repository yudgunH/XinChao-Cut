import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, Loader2, AlertCircle, Server, Cpu, Film, CheckCircle2, Check } from 'lucide-react'

import { exportVideo, renderAudioMix, type ExportSettings, type ExportProgress } from '@engine/export/exporter'
import { encodeWav, encodeMp3 } from '@engine/export/audio-file'
import { buildSrt, type SubtitleCue } from '@engine/subtitle/srt'
import { clipEffectiveDuration } from '@engine/timeline'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import type { BackendRuntime } from '@engine/backend'

type ExportEngine = 'browser' | 'server'

interface ExportDialogProps {
  onClose: () => void
}

const evenRound = (n: number) => Math.round(n / 2) * 2

const HW_ENCODER_LABELS: Record<string, string> = {
  h264_nvenc: 'NVENC (GPU)',
  h264_qsv: 'QuickSync (GPU)',
  h264_amf: 'AMF (GPU)',
  h264_videotoolbox: 'VideoToolbox (GPU)',
}

/** Human label for the server's chosen encoder — turns the silent CPU fallback
 * into something visible. null encoder = probe still running on the backend. */
function serverEncoderLabel(runtime: BackendRuntime | undefined): string {
  const enc = runtime?.videoEncoder
  if (!enc) return 'detecting encoder…'
  return HW_ENCODER_LABELS[enc] ?? 'libx264 (CPU — no hardware encoder detected)'
}

const RESOLUTIONS = [
  { height: 720,  label: '720P' },
  { height: 1080, label: '1080P' },
  { height: 2160, label: '4K' },
]
const FRAME_RATES = [24, 30, 60]
const BITRATE_QUALITIES = [
  { id: 'low',  label: 'Lower',       mult: 0.6 },
  { id: 'rec',  label: 'Recommended', mult: 1.0 },
  { id: 'high', label: 'Higher',      mult: 1.6 },
] as const
type BitrateQuality = (typeof BITRATE_QUALITIES)[number]['id']

/** Recommended video bitrate (kbps) for a given resolution + frame rate. */
function recommendedKbps(height: number, fps: number): number {
  const base = height <= 720 ? 5000 : height <= 1080 ? 8000 : 35000
  return fps >= 60 ? Math.round(base * 1.5) : base
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${Math.max(1, Math.round(mb))} MB`
}

export function ExportDialog({ onClose }: ExportDialogProps) {
  // Output settings
  const [name, setName] = useState('export')
  const [height, setHeight] = useState(1080)
  const [fps, setFps] = useState(30)
  const [bitrateQuality, setBitrateQuality] = useState<BitrateQuality>('rec')

  // What to export — video (mp4), audio (mp3/wav) and/or captions (srt).
  const [videoOn, setVideoOn] = useState(true)
  const [audioOn, setAudioOn] = useState(false)
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav'>('mp3')
  const [subsOn, setSubsOn] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Export state
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [cover, setCover] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const startTimeRef = useRef(0)
  const lastProgressTs = useRef(0)

  // Throttle progress updates so a 30–60 fps render firehose doesn't re-render
  // the whole dialog every frame (which caused visible flicker).
  function pushProgress(p: ExportProgress) {
    const now = performance.now()
    if (p.phase === 'done' || now - lastProgressTs.current >= 120) {
      lastProgressTs.current = now
      setProgress({ ...p })
    }
  }

  // Backend (FFmpeg) export availability + chosen engine.
  const [backendCaps] = useBackendCapabilities()
  const serverAvailable = !!backendCaps?.export
  const [engine, setEngine] = useState<ExportEngine>('browser')
  const [serverLabel, setServerLabel] = useState<string | null>(null)

  const isExporting = progress !== null && progress.phase !== 'done'
  const isDone = progress?.phase === 'done'

  // Auto-switch to server engine when backend comes online — but never mid-export
  // (a transient health blip must not change the engine while rendering).
  useEffect(() => {
    if (serverAvailable && !isExporting && !isDone) setEngine('server')
  }, [serverAvailable, isExporting, isDone])

  // Snapshot the live preview canvas once as the export cover thumbnail.
  useEffect(() => {
    try {
      const c = document.querySelector('canvas[data-preview-canvas]') as HTMLCanvasElement | null
      if (c && c.width > 0 && c.height > 0) setCover(c.toDataURL('image/jpeg', 0.75))
    } catch {
      /* tainted canvas — fall back to placeholder */
    }
  }, [])

  const assets = useProjectStore((s) => s.assets)
  const aspect = useProjectStore((s) => s.aspect)
  const updateAsset = useProjectStore((s) => s.updateAsset)
  const { timeline } = useTimelineStore()
  const urlCache = useRef(new Map<string, string>())

  // Derive concrete export settings from the dropdown choices.
  const mult = BITRATE_QUALITIES.find((b) => b.id === bitrateQuality)!.mult
  const videoBitrateKbps = Math.round(recommendedKbps(height, fps) * mult)
  const settings: ExportSettings = {
    width: evenRound((height * aspect.w) / aspect.h),
    height,
    fps,
    videoBitrateKbps,
  }

  const estSizeMb = ((videoBitrateKbps + 128) * timeline.durationSec) / 8000

  // Collect subtitle cues from text clips on text tracks. A clip counts as a
  // subtitle when it carries an outline/stroke or word timings (auto-captions
  // and imported SRTs both do) — this excludes plain title text clips.
  function subtitleCues(): SubtitleCue[] {
    const textTrackIds = new Set(
      timeline.tracks.filter((t) => t.kind === 'text').map((t) => t.id),
    )
    return timeline.clips
      .filter((c) => {
        if (!textTrackIds.has(c.trackId)) return false
        const td = c.textData
        return !!td?.content?.trim() && !!(td.stroke || td.wordTimestamps)
      })
      .map((c) => ({
        startSec: c.startSec,
        endSec: c.startSec + clipEffectiveDuration(c),
        content: c.textData!.content,
      }))
      .sort((a, b) => a.startSec - b.startSec)
  }
  const subCount = subtitleCues().length

  // Count clips that contribute audio (used to enable the Audio option).
  const audioClipCount = timeline.clips.filter((c) => {
    if (!c.assetId || c.muted) return false
    const tr = timeline.tracks.find((t) => t.id === c.trackId)
    if (!tr || tr.muted || (tr.kind !== 'audio' && tr.kind !== 'video')) return false
    const a = assets.find((x) => x.id === c.assetId)
    return !!a && (a.kind === 'audio' || a.kind === 'video')
  }).length

  // Live elapsed-time ticker while exporting
  useEffect(() => {
    if (!isExporting) return
    const id = setInterval(() => setElapsedMs(Date.now() - startTimeRef.current), 200)
    return () => clearInterval(id)
  }, [isExporting])

  function triggerDownload(blob: Blob, ext: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(name || 'export').trim()}.${ext}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function downloadSrt(): boolean {
    const cues = subtitleCues()
    if (cues.length === 0) return false
    triggerDownload(new Blob([buildSrt(cues)], { type: 'text/plain;charset=utf-8' }), 'srt')
    return true
  }

  // Decode + collect the AudioBuffers for every audio/video asset.
  async function prepareAudioBuffers(): Promise<Map<string, AudioBuffer>> {
    const { mediaManager } = await import('@engine/media')
    const { audioEngine } = await import('@engine/audio')
    const map = new Map<string, AudioBuffer>()
    for (const asset of assets) {
      if (asset.kind !== 'audio' && asset.kind !== 'video') continue
      if (!audioEngine.hasBuffer(asset.id)) {
        const blob = await mediaManager.getBlob(asset.id)
        if (blob) await audioEngine.ensureDecoded(asset.id, blob)
      }
      const buf = audioEngine.getBuffer(asset.id)
      if (buf) map.set(asset.id, buf)
    }
    return map
  }

  // Mix the timeline audio and encode it to MP3/WAV.
  async function downloadAudio(): Promise<boolean> {
    const buffers = await prepareAudioBuffers()
    const mix = await renderAudioMix(timeline.durationSec, timeline.clips, timeline.tracks, buffers)
    if (!mix) return false
    const blob = audioFormat === 'wav' ? encodeWav(mix) : encodeMp3(mix)
    triggerDownload(blob, audioFormat)
    return true
  }

  async function startExport() {
    setError(null)
    setNote(null)
    setDownloadUrl(null)
    setElapsedMs(0)
    setServerLabel(null)

    const done: string[] = []

    // Captions (.srt) — instant, independent of the video render.
    if (subsOn && downloadSrt()) done.push('captions (.srt)')

    // Audio (.mp3/.wav) — offline mix + encode, usually quick.
    if (audioOn) {
      setNote('Mixing audio…')
      if (await downloadAudio()) done.push(`audio (.${audioFormat})`)
    }

    // Video render — skip if disabled or the timeline is empty.
    if (!videoOn || timeline.durationSec === 0) {
      setNote(done.length ? `Exported ${done.join(' + ')}` : 'Nothing to export')
      return
    }
    setNote(null)

    startTimeRef.current = Date.now()
    const ac = new AbortController()
    abortRef.current = ac

    try {
      if (engine === 'server') await runServerExport(ac)
      else await runBrowserExport(ac)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setProgress(null)
      else {
        setError(e instanceof Error ? e.message : 'Export failed')
        setProgress(null)
      }
    }
  }

  // ── In-browser export (WebCodecs) ──────────────────────────
  async function runBrowserExport(ac: AbortController) {
    const { mediaManager } = await import('@engine/media')
    const { audioEngine } = await import('@engine/audio')
    const audioBuffers = new Map<string, AudioBuffer>()
    for (const asset of assets) {
      if (!urlCache.current.has(asset.id)) {
        const url = await mediaManager.getObjectUrl(asset.id)
        if (url) urlCache.current.set(asset.id, url)
      }
      if (asset.kind === 'audio' || asset.kind === 'video') {
        if (!audioEngine.hasBuffer(asset.id)) {
          const blob = await mediaManager.getBlob(asset.id)
          if (blob) await audioEngine.ensureDecoded(asset.id, blob)
        }
        const buf = audioEngine.getBuffer(asset.id)
        if (buf) audioBuffers.set(asset.id, buf)
      }
    }

    const blob = await exportVideo(
      settings,
      timeline.durationSec,
      timeline.clips,
      timeline.tracks,
      assets,
      urlCache.current,
      audioBuffers,
      ac.signal,
      (p) => pushProgress(p),
    )
    setDownloadUrl(URL.createObjectURL(blob))
  }

  // ── Server export (FFmpeg) ─────────────────────────────────
  async function runServerExport(ac: AbortController) {
    const { mediaManager } = await import('@engine/media')
    const {
      hashBlob, checkAssets, uploadAsset, startServerExport,
      getExportStatus, cancelServerExport, exportDownloadUrl,
    } = await import('@engine/backend')
    const { buildExportSpec, usedAssetIds } = await import('@engine/export/spec')

    const abortErr = () => new DOMException('Export cancelled', 'AbortError')
    setServerLabel('Uploading media')
    setProgress({ frame: 0, total: 100, phase: 'encoding' } as ExportProgress)

    // 1. Content-hash, then upload the assets the server is missing.
    const ids = usedAssetIds(timeline.clips)
    const hashByAssetId = new Map<string, string>()
    const assetIdByHash = new Map<string, string>()
    for (const id of ids) {
      const asset = assets.find((candidate) => candidate.id === id)
      if (asset?.sourcePath) {
        hashByAssetId.set(id, `local-${id}`)
        continue
      }
      // Reuse a previously computed hash so we don't re-read and re-hash a
      // multi-GB file on every export.
      const cached = asset?.contentHash
      if (cached) {
        hashByAssetId.set(id, cached)
        assetIdByHash.set(cached, id)
        continue
      }
      const blob = await mediaManager.getBlob(id)
      if (!blob) continue
      const h = await hashBlob(blob)
      hashByAssetId.set(id, h)
      assetIdByHash.set(h, id)
      // Persist (db + store) so the next export takes the cached path above.
      await mediaManager.setContentHash(id, h)
      updateAsset(id, { contentHash: h })
    }
    const missing = await checkAssets([...assetIdByHash.keys()])
    // Upload missing assets with bounded concurrency — two in flight keeps the
    // backend's disk/CPU busy without flooding it or spiking client memory.
    let cursor = 0
    const uploadWorker = async () => {
      while (cursor < missing.length) {
        const h = missing[cursor++]
        if (h === undefined) break // unreachable (cursor < length) — narrows the type
        if (ac.signal.aborted) throw abortErr()
        const id = assetIdByHash.get(h)
        const blob = id ? await mediaManager.getBlob(id) : null
        if (blob) {
          await uploadAsset(blob, h, assets.find((a) => a.id === id)?.name ?? 'media', ac.signal)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(2, missing.length) }, uploadWorker),
    )

    // 2. Build spec + start the job.
    setServerLabel('Rendering')
    const spec = buildExportSpec(
      settings, timeline.durationSec, timeline.clips, timeline.tracks, assets, hashByAssetId,
    )
    const jobId = await startServerExport(spec)

    // 3. Poll until done.
    for (;;) {
      if (ac.signal.aborted) {
        await cancelServerExport(jobId)
        throw abortErr()
      }
      const st = await getExportStatus(jobId)
      setProgress({ frame: Math.round(st.pct), total: 100, phase: 'encoding' } as ExportProgress)
      if (st.status === 'done') break
      if (st.status === 'error') throw new Error(st.error || 'Server export failed')
      if (st.status === 'cancelled') throw abortErr()
      await new Promise((r) => setTimeout(r, 500))
    }

    setServerLabel('Done')
    setProgress({ frame: 100, total: 100, phase: 'done' } as ExportProgress)
    setDownloadUrl(exportDownloadUrl(jobId))
  }

  function cancel() {
    abortRef.current?.abort()
    setProgress(null)
  }

  async function download() {
    if (!downloadUrl) return
    // The server download URL is cross-origin (:8000), where the anchor
    // `download` attribute is ignored — the browser would keep the server's
    // "export.mp4" filename. Fetch it into a same-origin blob first so the
    // user's chosen name is honoured. (Browser-export URLs are already blobs.)
    try {
      const res = await fetch(downloadUrl)
      triggerDownload(await res.blob(), 'mp4')
    } catch {
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = `${(name || 'export').trim()}.mp4`
      a.click()
    }
  }

  const pct = progress
    ? Math.round((progress.frame / Math.max(progress.total, 1)) * 100)
    : 0

  const selectCls =
    'w-44 shrink-0 rounded-md bg-bg-2 px-2.5 py-1.5 text-xs text-text-1 outline-none ' +
    'ring-1 ring-border focus:ring-accent disabled:opacity-50 cursor-pointer'

  const etaText = (() => {
    if (isDone) return `Done in ${formatDuration(elapsedMs)}`
    if (engine === 'browser' && progress && progress.total > 0) {
      const sec = elapsedMs / 1000
      if (sec >= 1 && progress.frame >= 2) {
        const f = progress.frame / sec
        const eta = Math.max(0, progress.total - progress.frame) / f
        return `${formatDuration(elapsedMs)} elapsed · ${f.toFixed(1)} fps · ~${formatDuration(eta * 1000)} left`
      }
    }
    if (engine === 'server' && pct > 2) {
      const eta = (elapsedMs / pct) * (100 - pct)
      return `${formatDuration(elapsedMs)} elapsed · ~${formatDuration(eta)} left`
    }
    return `${formatDuration(elapsedMs)} elapsed`
  })()

  return createPortal(
    // Portal to <body> + high z so the modal sits above all app chrome
    // (timeline toolbar z-70, drag overlay z-80) instead of letting them bleed
    // through. z-[90] keeps it under the context menu (z-100).
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80">
      <div className="w-[720px] overflow-hidden rounded-xl bg-bg-1 shadow-e3 ring-1 ring-border">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-text-1">Export</h2>
          <button
            onClick={onClose}
            disabled={isExporting}
            className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — two columns */}
        <div className="flex gap-5 p-5">
          {/* Left: cover preview */}
          <div className="flex w-[300px] shrink-0 flex-col gap-3">
            <div
              className="relative flex items-center justify-center overflow-hidden rounded-lg bg-black ring-1 ring-border"
              style={{ aspectRatio: `${aspect.w} / ${aspect.h}` }}
            >
              {cover ? (
                <img src={cover} alt="cover" className="h-full w-full object-contain" />
              ) : (
                <Film size={40} className="text-text-3" />
              )}

              {/* Progress overlay while exporting */}
              {(isExporting || isDone) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70">
                  {isDone ? (
                    <CheckCircle2 size={34} className="text-success" />
                  ) : (
                    <Loader2 size={34} className="animate-spin text-accent" />
                  )}
                  <span className="text-lg font-semibold text-white tabular-nums">{pct}%</span>
                  {!isDone && (
                    <span className="text-2xs font-medium text-white/90">
                      {engine === 'server'
                        ? (serverLabel ?? 'Rendering')
                        : progress?.phase === 'audio'
                          ? 'Mixing audio'
                          : progress?.phase === 'muxing'
                            ? 'Finalizing'
                            : 'Encoding'}
                    </span>
                  )}
                  <span className="px-3 text-center text-2xs text-white/70">{etaText}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between rounded-md bg-bg-2 px-3 py-2 text-2xs text-text-3">
              <span>{settings.width} × {settings.height} · {fps}fps</span>
              <span className="text-text-2">H.264 · MP4</span>
            </div>
          </div>

          {/* Right: settings or progress detail */}
          <div className="min-w-0 flex-1">
            {/* Name + Engine (always visible) */}
            <Row label="Name">
              <div className="flex w-44 items-center rounded-md bg-bg-2 ring-1 ring-border focus-within:ring-accent">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isExporting}
                  className="w-full bg-transparent px-2.5 py-1.5 text-xs text-text-1 outline-none disabled:opacity-50"
                  placeholder="export"
                />
                <span className="pr-2.5 text-2xs text-text-3">
                  {videoOn ? '.mp4' : audioOn ? `.${audioFormat}` : subsOn ? '.srt' : '.mp4'}
                </span>
              </div>
            </Row>

            {(serverAvailable || isExporting || isDone) && (
              <Row label="Engine">
                <div className="flex w-44 gap-1.5">
                  <EnginePill
                    active={engine === 'server'} disabled={isExporting}
                    onClick={() => setEngine('server')} icon={<Server size={12} />} label="Server"
                  />
                  <EnginePill
                    active={engine === 'browser'} disabled={isExporting}
                    onClick={() => setEngine('browser')} icon={<Cpu size={12} />} label="Browser"
                  />
                </div>
              </Row>
            )}

            {/* Video (mp4) */}
            <SectionToggle
              label="Video" checked={videoOn} disabled={isExporting}
              onChange={() => setVideoOn((v) => !v)}
            />
            <div className={!videoOn ? 'pointer-events-none opacity-40' : ''}>
              <Row label="Resolution">
                <select
                  value={height} onChange={(e) => setHeight(Number(e.target.value))}
                  disabled={isExporting || !videoOn} className={selectCls}
                >
                  {RESOLUTIONS.map((r) => (
                    <option key={r.height} value={r.height}>{r.label}</option>
                  ))}
                </select>
              </Row>

              <Row label="Frame rate">
                <select
                  value={fps} onChange={(e) => setFps(Number(e.target.value))}
                  disabled={isExporting || !videoOn} className={selectCls}
                >
                  {FRAME_RATES.map((f) => (
                    <option key={f} value={f}>{f} fps</option>
                  ))}
                </select>
              </Row>

              <Row label="Bit rate">
                <select
                  value={bitrateQuality} onChange={(e) => setBitrateQuality(e.target.value as BitrateQuality)}
                  disabled={isExporting || !videoOn} className={selectCls}
                >
                  {BITRATE_QUALITIES.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} · {(Math.round(recommendedKbps(height, fps) * b.mult) / 1000).toFixed(1)} Mbps
                    </option>
                  ))}
                </select>
              </Row>

              <Row label="Codec">
                <div className={`${selectCls} flex items-center text-text-2`}>H.264</div>
              </Row>

              <Row label="Format">
                <div className={`${selectCls} flex items-center text-text-2`}>MP4</div>
              </Row>
            </div>

            {/* Audio (mp3 / wav) */}
            <SectionToggle
              label="Audio" checked={audioOn} disabled={isExporting || audioClipCount === 0}
              onChange={() => setAudioOn((v) => !v)}
              hint={audioClipCount === 0 ? 'no audio on timeline' : undefined}
            />
            <div className={!audioOn ? 'pointer-events-none opacity-40' : ''}>
              <Row label="Format">
                <select
                  value={audioFormat} onChange={(e) => setAudioFormat(e.target.value as 'mp3' | 'wav')}
                  disabled={isExporting || !audioOn} className={selectCls}
                >
                  <option value="mp3">MP3</option>
                  <option value="wav">WAV</option>
                </select>
              </Row>
            </div>

            {/* Captions (srt) */}
            <SectionToggle
              label="Captions" checked={subsOn} disabled={isExporting || subCount === 0}
              onChange={() => setSubsOn((v) => !v)}
              hint={subCount === 0 ? 'none on timeline' : `${subCount} cues`}
            />
            <div className={!subsOn ? 'pointer-events-none opacity-40' : ''}>
              <Row label="Format">
                <div className={`${selectCls} flex items-center text-text-2`}>SRT</div>
              </Row>
            </div>

            {/* Error */}
            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-danger/10 p-2.5 text-2xs text-danger ring-1 ring-danger/30">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <p className="break-words">{error}</p>
              </div>
            )}

            {/* Success note (captions export) */}
            {note && !error && <p className="mt-3 text-2xs text-success">{note}</p>}

            {/* Engine note */}
            {!isExporting && !isDone && !error && !note && (
              <p className="mt-3 text-2xs text-text-3">
                {engine === 'server'
                  ? `Rendered on the backend with FFmpeg · ${serverEncoderLabel(backendCaps?.runtime)}. Captions/effects may differ slightly from the preview.`
                  : 'Rendered in-browser with WebCodecs. Requires Chrome 94+ / Edge.'}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <div className="flex items-center gap-2 text-2xs text-text-3">
            <span>Duration: <span className="text-text-2">{formatDuration(timeline.durationSec * 1000)}</span></span>
            <span className="text-border">|</span>
            <span>Size: <span className="text-text-2">about {formatSize(estSizeMb)}</span></span>
          </div>

          <div className="flex gap-2">
            {isExporting ? (
              <button
                onClick={cancel}
                className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
              >
                Cancel
              </button>
            ) : isDone ? (
              <>
                <button
                  onClick={onClose}
                  className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
                >
                  Close
                </button>
                <button
                  onClick={download}
                  className="flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-xs font-medium text-white hover:bg-success/90"
                >
                  <Download size={13} />
                  Download
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onClose}
                  className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
                >
                  Cancel
                </button>
                <button
                  onClick={startExport}
                  disabled={
                    !(
                      (videoOn && timeline.durationSec > 0) ||
                      (audioOn && audioClipCount > 0) ||
                      (subsOn && subCount > 0)
                    )
                  }
                  className="rounded-md bg-accent px-5 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  Export
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** A section header with a checkbox toggle (e.g. "Video", "Captions"). */
function SectionToggle({
  label, checked, disabled, onChange, hint,
}: {
  label: string; checked: boolean; disabled?: boolean
  onChange: () => void; hint?: string
}) {
  return (
    <div className="mb-2 mt-4 flex items-center gap-2">
      <button
        onClick={onChange}
        disabled={disabled}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ring-1 transition-colors disabled:opacity-40 ${
          checked ? 'bg-accent ring-accent' : 'bg-bg-2 ring-border hover:ring-text-3'
        }`}
      >
        {checked && <Check size={11} className="text-white" strokeWidth={3} />}
      </button>
      <span className="text-xs font-medium text-text-1">{label}</span>
      {hint && <span className="text-2xs text-text-3">({hint})</span>}
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

/** A label-on-the-left, control-on-the-right settings row. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-text-2">{label}</span>
      {children}
    </div>
  )
}

function EnginePill({
  active, disabled, onClick, icon, label,
}: {
  active: boolean; disabled: boolean; onClick: () => void
  icon: ReactNode; label: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-2xs disabled:opacity-40 ${
        active ? 'bg-accent text-white' : 'bg-bg-2 text-text-2 ring-1 ring-border hover:bg-bg-3'
      }`}
    >
      {icon} {label}
    </button>
  )
}
