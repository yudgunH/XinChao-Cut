import { useEffect, useMemo, useRef, useState } from 'react'

import {
  probeBrowserVideoCodecs,
  type ExportSettings,
  type ExportProgress,
  type ExportVideoCodec,
  type ExportDynamicRange,
} from '@engine/export/exporter'
import { isExportAudibleClip } from '@engine/export/audio-memory'
import { ExportOperationOwner } from '@engine/export/export-operation'
import {
  estimateBrowserOutputBytes,
  getBrowserStorageSnapshot,
  measureBrowserVideoLoad,
  type BrowserStorageSnapshot,
} from '@engine/export/browser-admission'
import { getExportDir, setExportDir, pickExportFolder, canPickFolder, defaultExportName } from '@engine/export/output-dir'
import { suggestExportName, type ServerExportDiag } from '@engine/backend'
import { deleteBlob } from '@engine/persistence/opfs'
import { summarizeCaptionTimingQa } from '@engine/timeline/caption-timing'
import { serverExportGaps, serverExportStrictGaps } from '@engine/export/spec'
import { recommendedVideoBitrateKbps } from '@engine/export/bitrate'
import {
  adviseExportEngine,
  shouldApplyEngineRecommendation,
  type ExportEngine,
} from '@engine/export/engine-advisor'
import {
  classifyExportWorkload,
  loadExportThroughputProfile,
  recordExportThroughput,
  type ExportPerformanceContext,
} from '@engine/export/performance-profile'
import { exportQualityDefinition, type ExportQualityProfile } from '@engine/export/quality'
import type { AudioMasteringPreset } from '@engine/export/audio-mastering'
import {
  buildSubtitleCues,
  countAudibleClips,
  newBrowserExportScratchKey,
  preflightBrowserAudio,
  runExport,
  validateRunExport,
} from '@engine/export/run-export'
import {
  hasZeroCopyCoverage,
  loadValidatedZeroCopyReport,
  zeroCopyCompatibility,
  type ZeroCopyMatrixReport,
} from '@engine/export/zero-copy-self-test'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { createExportCompletionSound } from './export-completion-sound'
import { ExportDialogView } from './ExportDialogView'

interface ExportDialogProps {
  onClose: () => void
}

const evenRound = (n: number) => Math.round(n / 2) * 2

const CODEC_BITRATE_MULTIPLIER: Record<ExportVideoCodec, number> = {
  h264: 1,
  hevc: 0.72,
  av1: 0.58,
}
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ExportDialog({ onClose }: ExportDialogProps) {
  // Output settings — default name is today's date (DDMM); backend auto-increments
  // (1)/(2)/… so same-day re-exports don't overwrite.
  const [name, setName] = useState(defaultExportName)
  const [height, setHeight] = useState(1080)
  const [fps, setFps] = useState(30)
  const [qualityProfile, setQualityProfile] = useState<ExportQualityProfile>('balanced')
  const [audioMastering, setAudioMastering] = useState<AudioMasteringPreset>('off')
  const [videoCodec, setVideoCodec] = useState<ExportVideoCodec>('h264')
  const [dynamicRange, setDynamicRange] = useState<ExportDynamicRange>('sdr')
  const [browserZeroCopy, setBrowserZeroCopy] = useState(false)
  const [browserCodecSupport, setBrowserCodecSupport] = useState<Record<ExportVideoCodec, boolean> | null>(null)


  // What to export — video (mp4), audio (mp3/wav) and/or captions (srt).
  const [videoOn, setVideoOn] = useState(true)
  const [audioOn, setAudioOn] = useState(false)
  const [audioFormat, setAudioFormat] = useState<'mp3' | 'wav'>('mp3')
  const [subsOn, setSubsOn] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  // Export state — progress is informational; lock uses busy/cancelling (S4 / F05).
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  // Folder the finished mp4 is written into (no download click). '' = ask/download.
  const [exportDir, setExportDirState] = useState(getExportDir)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  // How the last server render was wired (encoder / CPU compositor) — shown so
  // high CPU during a GPU-encoded export is explained rather than mysterious.
  const [serverDiag, setServerDiag] = useState<ServerExportDiag | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [cover, setCover] = useState<string | null>(null)
  /** True from tryBegin until settle — disables Export immediately on first click. */
  const [busy, setBusy] = useState(false)
  /** True after Cancel until the live operation promise settles. */
  const [cancelling, setCancelling] = useState(false)
  const ownerRef = useRef(new ExportOperationOwner())
  const mountedRef = useRef(true)
  const startTimeRef = useRef(0)
  const encodingStartTimeRef = useRef(0)
  const lastProgressTs = useRef(0)
  const activeEngineRef = useRef<ExportEngine>('browser')
  const activePerformanceContextRef = useRef<ExportPerformanceContext | undefined>(undefined)
  const recordedPerformanceOpRef = useRef<string | null>(null)
  const completionSoundOpRef = useRef<string | null>(null)
  const completionSoundRef = useRef<ReturnType<typeof createExportCompletionSound> | null>(null)
  if (!completionSoundRef.current) {
    completionSoundRef.current = createExportCompletionSound()
  }
  const scratchKeyRef = useRef(newBrowserExportScratchKey())
  // Once an anchor download starts Chromium may still be streaming the OPFS
  // Blob after this dialog closes. Retain that immutable key for stale cleanup
  // instead of deleting the file underneath the download.
  const browserDownloadStartedRef = useRef(false)

  // Throttle progress updates so a 30–60 fps render firehose doesn't re-render
  // the whole dialog every frame (which caused visible flicker).
  function pushProgress(opId: string, p: ExportProgress) {
    if (!mountedRef.current || !ownerRef.current.isCurrent(opId)) return
    if (p.seekFallbackAsset) {
      setNote(
        `"${p.seekFallbackAsset}" is using the exact-preview seek fallback because WebCodecs ` +
          'does not support its codec/container. Remux/transcode it to MP4 H.264 to restore full speed.',
      )
    }
    if (p.phase === 'encoding' && encodingStartTimeRef.current === 0) {
      encodingStartTimeRef.current = Date.now()
    }
    const now = performance.now()
    if (p.phase === 'done' || now - lastProgressTs.current >= 120) {
      lastProgressTs.current = now
      setProgress({ ...p })
    }
    if (p.phase === 'done' && completionSoundOpRef.current !== opId) {
      completionSoundOpRef.current = opId
      void completionSoundRef.current?.play()
    }
    if (
      p.phase === 'done' &&
      recordedPerformanceOpRef.current !== opId &&
      startTimeRef.current > 0
    ) {
      recordedPerformanceOpRef.current = opId
      recordExportThroughput(
        activeEngineRef.current,
        height,
        fps,
        timeline.durationSec,
        (Date.now() - startTimeRef.current) / 1000,
        undefined,
        activePerformanceContextRef.current,
      )
    }
  }

  function applyIfCurrent(opId: string, fn: () => void) {
    if (!mountedRef.current || !ownerRef.current.isCurrent(opId)) return
    fn()
  }

  /** Publish download URL only for the live op; revokes previous blob once (F18). */
  function publishOutputUrl(opId: string, url: string | null) {
    ownerRef.current.setOutputUrl(opId, url)
    if (mountedRef.current && ownerRef.current.isCurrent(opId)) {
      setDownloadUrl(ownerRef.current.getOutputUrl())
    }
  }

  // Backend (FFmpeg) export availability + chosen engine.
  const [backendCaps] = useBackendCapabilities()
  const serverAvailable = !!backendCaps?.export
  const selectedServerEncoder = backendCaps?.runtime?.videoEncoders?.[videoCodec]
  const selectedHdrEncoder = videoCodec === 'h264'
    ? null
    : backendCaps?.runtime?.hdr10VideoEncoders?.[videoCodec]
  const [engine, setEngine] = useState<ExportEngine>('browser')
  useEffect(() => {
    // Canvas2D/WebGPU export is currently an 8-bit compositor. Never preserve a
    // stale HDR selection while switching from Server to Browser: that would
    // create an SDR file carrying an HDR-looking UI choice.
    if (engine === 'browser' && dynamicRange !== 'sdr') setDynamicRange('sdr')
  }, [dynamicRange, engine])
  const userPickedEngineRef = useRef(false)
  const [serverLabel, setServerLabel] = useState<string | null>(null)
  const [browserStorage, setBrowserStorage] = useState<BrowserStorageSnapshot | null>(null)

  // S4: lock is independent of progress % so double-click / cancel races cannot
  // re-enter startExport while the previous promise is still settling.
  const isLocked = busy || cancelling
  const isExporting = isLocked
  const isDone = !isLocked && progress?.phase === 'done'

  // When an export folder is set, pre-fill the name with the next free number
  // for today's date (e.g. "2406(1)" if "2406.mp4" already exists there) so the
  // shown default matches what will actually be written. Runs on open and when
  // the folder changes; skipped mid-export so it can't clobber a running name.
  useEffect(() => {
    if (!exportDir || isExporting || isDone) return
    let cancelled = false
    suggestExportName(exportDir, defaultExportName()).then((n) => {
      if (!cancelled) setName(n)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDir])

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
  // Flattened: compound clips are expanded so their contents export too.
  const timeline = useTimelineStore((s) => s.flatTimeline())
  const urlCache = useRef(new Map<string, string>())
  const urlSourceKeys = useRef(new Map<string, string>())

  // On unmount: abort live operation (stops worker/server poll), settle ownership,
  // revoke blob output once, then revoke media urlCache. Abort first so a stale
  // continuation cannot start a worker after close (S4).
  useEffect(() => {
    mountedRef.current = true
    // Capture refs for cleanup — eslint warns if we read .current only in the
    // teardown path (ref identity is stable for the dialog's lifetime).
    const owner = ownerRef.current
    const mediaUrls = urlCache.current
    const mediaSourceKeys = urlSourceKeys.current
    const completionSound = completionSoundRef.current
    return () => {
      mountedRef.current = false
      owner.dispose()
      // Once the output URL is revoked no UI consumer needs the OPFS-backed
      // Blob. A running worker also deletes this key after its abort teardown.
      if (!browserDownloadStartedRef.current) void deleteBlob(scratchKeyRef.current)
      for (const url of mediaUrls.values()) URL.revokeObjectURL(url)
      mediaUrls.clear()
      mediaSourceKeys.clear()
      completionSound?.dispose()
    }
  }, [])

  // Parity gating. Default (strict): the server renders only timelines with
  // NOTHING drawn on top (pure trim/concat/transcode) — everything else goes
  // through the browser renderer, which IS the preview, so what you exported is
  // literally what you previewed. The speed toggle relaxes this to the old
  // "close approximation" gaps (ffmpeg/libass mirror) for long timelines where
  // throughput matters more than pixel-exact captions.
  const [approxServer, setApproxServer] = useState<boolean>(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('xinchao-approx-server') === '1',
  )
  const toggleApproxServer = (v: boolean) => {
    setApproxServer(v)
    try {
      localStorage.setItem('xinchao-approx-server', v ? '1' : '0')
    } catch { /* private mode */ }
  }
  const serverGaps = useMemo(
    () => approxServer
      ? serverExportGaps(timeline.clips)
      : serverExportStrictGaps(timeline.clips),
    [approxServer, timeline.clips],
  )
  const mustUseBrowser = serverGaps.length > 0

  // Derive concrete export settings from the dropdown choices.
  const outputWidth = evenRound((height * aspect.w) / aspect.h)
  const recommendedKbps = useMemo(
    () => recommendedVideoBitrateKbps({
      width: outputWidth,
      height,
      fps,
      assets,
      clips: timeline.clips,
      tracks: timeline.tracks,
    }),
    [assets, fps, height, outputWidth, timeline.clips, timeline.tracks],
  )
  const quality = exportQualityDefinition(qualityProfile)
  const videoBitrateKbps = Math.round(
    recommendedKbps * quality.videoBitrateMultiplier * CODEC_BITRATE_MULTIPLIER[videoCodec],
  )
  const settings: ExportSettings = {
    width: outputWidth,
    height,
    fps,
    videoBitrateKbps,
    qualityProfile,
    audioBitrateKbps: quality.audioBitrateKbps,
    audioMastering,
    videoCodec,
    dynamicRange,
    browserZeroCopy: browserZeroCopy ? 'auto' : 'off',
  }
  const [cachedZeroCopy, setCachedZeroCopy] = useState<ZeroCopyMatrixReport | null>(null)
  useEffect(() => {
    let current = true
    setCachedZeroCopy(null)
    void loadValidatedZeroCopyReport({
      gpuDriver: backendCaps?.runtime?.gpuDriver,
      backendGpu: backendCaps?.runtime?.cuda.device,
    }).then((report) => {
      if (current) setCachedZeroCopy(report)
    })
    return () => { current = false }
  }, [backendCaps?.runtime?.cuda.device, backendCaps?.runtime?.gpuDriver])
  const cachedZeroCopyStatus = zeroCopyCompatibility(
    cachedZeroCopy,
    videoCodec,
    settings.width,
    settings.height,
    settings.fps,
  )
  // A covering verified matrix admits the option. exportVideoCore still runs
  // exact-config sacrificial + first-real-frame probes, so a driver/config that
  // cannot consume this surface falls back before the first committed frame.
  const zeroCopySelectable = hasZeroCopyCoverage(
    cachedZeroCopy,
    videoCodec,
    settings.width,
    settings.height,
    settings.fps,
  )

  useEffect(() => {
    // Once the workload is covered by a verified diagnostic, prefer the
    // faster path. The user can still turn it off afterwards; this only reruns
    // when admission changes.
    setBrowserZeroCopy(zeroCopySelectable)
  }, [zeroCopySelectable])

  useEffect(() => {
    if (engine !== 'browser' || typeof VideoEncoder === 'undefined') return
    let cancelled = false
    void probeBrowserVideoCodecs({
      width: settings.width,
      height: settings.height,
      bitrate: settings.videoBitrateKbps * 1_000,
      framerate: settings.fps,
      latencyMode: 'quality',
    }).then((support) => {
      if (!cancelled) setBrowserCodecSupport(support)
    })
    return () => { cancelled = true }
  }, [engine, settings.fps, settings.height, settings.videoBitrateKbps, settings.width])

  useEffect(() => {
    const unavailable = engine === 'browser'
      ? browserCodecSupport?.[videoCodec] === false
      : backendCaps?.runtime?.videoEncoders?.[videoCodec] === null
    if (unavailable && videoCodec !== 'h264') {
      setVideoCodec('h264')
      setDynamicRange('sdr')
    }
  }, [backendCaps?.runtime?.videoEncoders, browserCodecSupport, engine, videoCodec])

  const estSizeMb = (
    (videoBitrateKbps + quality.audioBitrateKbps) * timeline.durationSec
  ) / 8000

  useEffect(() => {
    if (exportDir) {
      setBrowserStorage(null)
      return
    }
    let cancelled = false
    getBrowserStorageSnapshot()
      .then((snapshot) => {
        if (!cancelled) setBrowserStorage(snapshot)
      })
      .catch(() => {
        if (!cancelled) setBrowserStorage(null)
      })
    return () => { cancelled = true }
  }, [exportDir, estSizeMb])

  const browserVideoLoad = useMemo(
    () => measureBrowserVideoLoad(timeline.clips, timeline.tracks, assets),
    [assets, timeline.clips, timeline.tracks],
  )
  const browserAudioRoute = useMemo(
    () => preflightBrowserAudio(
      { timeline, assets, serverAvailable, mustUseBrowser },
      'video',
      'none',
    ),
    // preflight reads these immutable timeline/asset snapshots and capability gates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assets, timeline.clips, timeline.tracks, timeline.durationSec, serverAvailable, mustUseBrowser],
  )
  const estimatedOutputBytes = useMemo(
    () => estimateBrowserOutputBytes(
      timeline.durationSec,
      settings.videoBitrateKbps,
      timeline.clips.some((clip) => isExportAudibleClip(clip, timeline.tracks)),
      quality.audioBitrateKbps,
    ),
    [
      quality.audioBitrateKbps,
      settings.videoBitrateKbps,
      timeline.clips,
      timeline.durationSec,
      timeline.tracks,
    ],
  )
  const hybridAudioAvailable =
    !!exportDir && serverAvailable && timeline.clips.some(
      (clip) => isExportAudibleClip(clip, timeline.tracks),
    )
  const exportWorkload = useMemo(
    () => classifyExportWorkload(timeline.clips, timeline.tracks),
    [timeline.clips, timeline.tracks],
  )
  const performanceContext = useMemo<ExportPerformanceContext>(() => ({
    workload: exportWorkload,
    qualityProfile,
    serverEncoder: backendCaps?.runtime?.videoEncoders?.[videoCodec] ?? backendCaps?.runtime?.videoEncoder,
    videoCodec,
    dynamicRange,
  }), [backendCaps?.runtime?.videoEncoder, backendCaps?.runtime?.videoEncoders, dynamicRange, exportWorkload, qualityProfile, videoCodec])
  const throughputProfile = useMemo(
    () => loadExportThroughputProfile(
      settings.height,
      settings.fps,
      undefined,
      performanceContext,
    ),
    [performanceContext, settings.height, settings.fps],
  )
  const engineAdvice = useMemo(
    () => adviseExportEngine({
      durationSec: timeline.durationSec,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      estimatedOutputBytes,
      videoLoad: browserVideoLoad,
      audioRoute: browserAudioRoute,
      browserStorage,
      directOutput: !!exportDir,
      hybridAudioAvailable,
      serverAvailable,
      serverParityGaps: serverGaps,
      exactParity: !approxServer,
      serverEncoder: backendCaps?.runtime?.videoEncoders?.[videoCodec] ?? backendCaps?.runtime?.videoEncoder,
      throughput: throughputProfile,
    }),
    [
      approxServer,
      backendCaps?.runtime?.videoEncoder,
      backendCaps?.runtime?.videoEncoders,
      browserAudioRoute,
      browserStorage,
      browserVideoLoad,
      estimatedOutputBytes,
      exportDir,
      hybridAudioAvailable,
      serverAvailable,
      serverGaps,
      settings.fps,
      settings.height,
      settings.width,
      throughputProfile,
      timeline.durationSec,
      videoCodec,
    ],
  )

  // Re-evaluate only when workload/capabilities change. A manual engine click
  // remains respected until one of these recommendation inputs changes.
  useEffect(() => {
    if (isExporting || isDone) return
    if (!shouldApplyEngineRecommendation(userPickedEngineRef.current, engine, engineAdvice)) return
    setEngine(engineAdvice.recommended)
  }, [
    engine,
    engineAdvice,
    isDone,
    isExporting,
  ])

  // Collect subtitle cues from text clips on text tracks. A clip counts as a
  // subtitle when it carries an outline/stroke or word timings (auto-captions
  // and imported SRTs both do) — this excludes plain title text clips.
  const subCount = buildSubtitleCues(timeline).length
  const captionTimingQa = useMemo(
    () => summarizeCaptionTimingQa(timeline.clips),
    [timeline.clips],
  )

  // Count clips that contribute audio (used to enable the Audio option).
  const audioClipCount = countAudibleClips(timeline, assets)
  const hybridAudioReady =
    engine === 'browser' && hybridAudioAvailable && audioClipCount > 0 &&
    browserAudioRoute.action !== 'browser'

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

  async function startExport() {
    const validationError = validateRunExport({
      settings,
      timeline,
      assets,
      engine,
      exportWorkload,
      engineBlockedReason: engineAdvice.blockedReason,
      serverAvailable,
      mustUseBrowser,
      exportDir,
      videoOn,
      audioClipCount,
    })
    if (validationError) {
      setError(validationError)
      return
    }

    // S4: create operationId + AbortController *before* SRT/audio/preprocess.
    // Second click while busy/cancelling is a no-op (single operation).
    const op = ownerRef.current.tryBegin()
    if (!op) return
    const { id: opId, abort: ac } = op

    // Runs synchronously inside the button gesture. Completion happens much
    // later, so priming now prevents WebView autoplay policy from muting it.
    completionSoundRef.current?.prime()

    setBusy(true)
    setCancelling(false)
    setError(null)
    setNote(null)
    setSavedPath(null)
    setServerDiag(null)
    setElapsedMs(0)
    recordedPerformanceOpRef.current = null
    setServerLabel(null)
    setProgress(null)
    ownerRef.current.clearOutputUrl()
    setDownloadUrl(null)

    try {
      // Reclaim the previous successful browser output even when this run uses
      // server/audio-only export. Browser export also performs its own preflight
      // delete immediately before creating the writer.
      const previousScratch = scratchKeyRef.current
      if (!browserDownloadStartedRef.current) await deleteBlob(previousScratch)
      scratchKeyRef.current = newBrowserExportScratchKey()
      browserDownloadStartedRef.current = false
      if (!ownerRef.current.isCurrent(opId) || ac.signal.aborted) {
        throw new DOMException('Export cancelled', 'AbortError')
      }

      // The validated GPU report loads asynchronously when the dialog opens.
      // A fast click could previously capture browserZeroCopy=false before that
      // effect completed, even though a verified report was already cached.
      // Revalidate at the operation boundary and derive the immutable
      // settings snapshot that is actually sent to the worker.
      let runSettings = settings
      if (engine === 'browser' && videoOn) {
        const validatedZeroCopy = cachedZeroCopy ?? await loadValidatedZeroCopyReport({
          gpuDriver: backendCaps?.runtime?.gpuDriver,
          backendGpu: backendCaps?.runtime?.cuda.device,
          signal: ac.signal,
        })
        const admitZeroCopy = hasZeroCopyCoverage(
          validatedZeroCopy,
          settings.videoCodec ?? 'h264',
          settings.width,
          settings.height,
          settings.fps,
        )
        runSettings = {
          ...settings,
          browserZeroCopy: admitZeroCopy ? 'auto' : 'off',
        }
        if (admitZeroCopy && mountedRef.current) setBrowserZeroCopy(true)
        // eslint-disable-next-line no-console
        console.info(
          `[export] zero-copy admission: ${admitZeroCopy ? 'auto' : 'off'} ` +
          `(verifiedCoverage=${admitZeroCopy}, ${settings.width}x${settings.height}@${settings.fps})`,
        )
      }

      await runExport({
        opId,
        settings: runSettings,
        timeline,
        assets,
        engine,
        exportWorkload,
        engineBlockedReason: engineAdvice.blockedReason,
        serverAvailable,
        mustUseBrowser,
        exportDir,
        name,
        videoOn,
        audioOn,
        audioFormat,
        subsOn,
        audioClipCount,
        quality,
        urlCache: urlCache.current,
        urlSourceKeys: urlSourceKeys.current,
        scratchKey: scratchKeyRef.current,
      }, {
        signal: ac.signal,
        isCurrent: (id) => ownerRef.current.isCurrent(id),
        onProgress: (nextProgress) => pushProgress(opId, nextProgress),
        onNote: (nextNote) => applyIfCurrent(opId, () => setNote(nextNote)),
        onServerLabel: (label) => applyIfCurrent(opId, () => setServerLabel(label)),
        onSavedPath: (path) => applyIfCurrent(opId, () => setSavedPath(path)),
        onOutputUrl: (url) => publishOutputUrl(opId, url),
        onServerDiag: (diag) => applyIfCurrent(opId, () => setServerDiag(diag)),
        onEngineChange: (nextEngine) => applyIfCurrent(opId, () => setEngine(nextEngine)),
        onAssetHash: (assetId, hash) => {
          if (ownerRef.current.isCurrent(opId)) updateAsset(assetId, { contentHash: hash })
        },
        onDownload: triggerDownload,
        onRenderStart: (useEngine) => {
          startTimeRef.current = Date.now()
          encodingStartTimeRef.current = 0
          activeEngineRef.current = useEngine
          activePerformanceContextRef.current = performanceContext
        },
      })
    } catch (e) {
      if (!mountedRef.current || !ownerRef.current.isCurrent(opId)) return
      if (e instanceof DOMException && e.name === 'AbortError') {
        setProgress(null)
        setNote(null)
      } else {
        setError(e instanceof Error ? e.message : 'Export failed')
        setProgress(null)
      }
    } finally {
      // Only the live operation may release the lock (stale A cannot unlock B).
      if (ownerRef.current.isCurrent(opId)) {
        ownerRef.current.settle(opId)
        if (mountedRef.current) {
          setBusy(false)
          setCancelling(false)
        }
      }
    }
  }

  // Pick a folder via the native dialog (desktop app); persist the choice.
  async function chooseFolder() {
    const dir = await pickExportFolder()
    if (dir) {
      setExportDirState(dir)
      setExportDir(dir)
    }
  }

  function updateExportDir(dir: string) {
    setExportDirState(dir)
    setExportDir(dir)
  }

  function cancel() {
    // S4: enter cancelling; keep lock until the live promise settles.
    // Do not clear progress immediately — UI shows "Cancelling…".
    if (!ownerRef.current.requestCancel()) return
    setCancelling(true)
  }

  /** Close dialog: abort in-flight work so preprocessing cannot start a worker. */
  function handleClose() {
    // Unmount cleanup owns disposal/revocation. Keep the click handler minimal:
    // cleanup APIs or synchronous abort listeners must never prevent the parent
    // from actually removing the dialog.
    try {
      ownerRef.current.requestCancel()
    } finally {
      onClose()
    }
  }

  async function download() {
    if (!downloadUrl) return
    // Browser export: downloadUrl is a same-origin blob: URL (often OPFS-backed
    // after stream-to-OPFS). Anchor `download` is honoured — do NOT fetch()+blob()
    // that would re-materialise the whole MP4 in RAM and undo the long-export OOM fix.
    // Do not revoke here: downloadUrl stays until replace/unmount (F18).
    if (downloadUrl.startsWith('blob:')) {
      browserDownloadStartedRef.current = true
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = `${(name || 'export').trim()}.mp4`
      a.click()
      return
    }
    // Server export: stream straight from the backend via a direct anchor. The
    // download endpoint sends Content-Disposition: attachment (with our chosen
    // filename via the query), so the browser downloads to disk WITHOUT
    // materialising the whole MP4 into a renderer Blob — the old fetch()+blob()
    // here OOM'd on multi-GB server exports (P0).
    const fname = encodeURIComponent(`${(name || 'export').trim()}.mp4`)
    const sep = downloadUrl.includes('?') ? '&' : '?'
    const a = document.createElement('a')
    a.href = `${downloadUrl}${sep}filename=${fname}`
    a.download = `${(name || 'export').trim()}.mp4`
    a.rel = 'noopener'
    a.click()
  }

  const pct = progress
    ? Math.round((progress.frame / Math.max(progress.total, 1)) * 100)
    : 0

  const etaText = (() => {
    if (isDone) return `Done in ${formatDuration(elapsedMs)}`
    if (engine === 'browser' && progress?.phase === 'encoding') {
      const sec = encodingStartTimeRef.current > 0
        ? (Date.now() - encodingStartTimeRef.current) / 1000
        : elapsedMs / 1000
      const renderedFrame = progress.renderedFrame ?? progress.frame
      const renderedTotal = progress.renderedTotal ?? progress.total
      if (sec >= 1 && renderedFrame >= 2 && renderedTotal > 0) {
        const f = renderedFrame / sec
        const eta = Math.max(0, renderedTotal - renderedFrame) / f
        return `${formatDuration(elapsedMs)} elapsed · ${f.toFixed(1)} fps · ~${formatDuration(eta * 1000)} left`
      }
    }
    if (engine === 'server' && pct > 2) {
      const eta = (elapsedMs / pct) * (100 - pct)
      return `${formatDuration(elapsedMs)} elapsed · ~${formatDuration(eta)} left`
    }
    return `${formatDuration(elapsedMs)} elapsed`
  })()
  const browserPredicted = formatDuration(engineAdvice.browserEstimateSec * 1000)
  const serverPredicted = engineAdvice.serverEstimateSec == null
    ? null
    : formatDuration(engineAdvice.serverEstimateSec * 1000)

  return (
    <ExportDialogView
      handleClose={handleClose}
      isExporting={isExporting}
      isDone={isDone}
      cover={cover}
      aspect={aspect}
      pct={pct}
      cancelling={cancelling}
      engine={engine}
      serverLabel={serverLabel}
      progress={progress}
      etaText={etaText}
      settings={settings}
      fps={fps}
      name={name}
      setName={setName}
      videoOn={videoOn}
      audioOn={audioOn}
      audioFormat={audioFormat}
      subsOn={subsOn}
      serverAvailable={serverAvailable}
      engineAdvice={engineAdvice}
      userPickedEngineRef={userPickedEngineRef}
      setEngine={setEngine}
      exportDir={exportDir}
      browserPredicted={browserPredicted}
      serverPredicted={serverPredicted}
      hybridAudioReady={hybridAudioReady}
      approxServer={approxServer}
      toggleApproxServer={toggleApproxServer}
      mustUseBrowser={mustUseBrowser}
      browserAudioRoute={browserAudioRoute}
      setError={setError}
      height={height}
      setHeight={setHeight}
      setFps={setFps}
      qualityProfile={qualityProfile}
      setQualityProfile={setQualityProfile}
      recommendedKbps={recommendedKbps}
      codecBitrateMultiplier={CODEC_BITRATE_MULTIPLIER}
      videoCodec={videoCodec}
      setVideoCodec={setVideoCodec}
      dynamicRange={dynamicRange}
      setDynamicRange={setDynamicRange}
      backendCaps={backendCaps}
      browserCodecSupport={browserCodecSupport}
      selectedServerEncoder={selectedServerEncoder}
      selectedHdrEncoder={selectedHdrEncoder}
      browserZeroCopy={browserZeroCopy}
      setBrowserZeroCopy={setBrowserZeroCopy}
      zeroCopySelectable={zeroCopySelectable}
      cachedZeroCopyStatus={cachedZeroCopyStatus}
      audioMastering={audioMastering}
      setAudioMastering={setAudioMastering}
      audioClipCount={audioClipCount}
      updateExportDir={updateExportDir}
      chooseFolder={chooseFolder}
      folderPickerAvailable={canPickFolder()}
      browserStorage={browserStorage}
      setVideoOn={setVideoOn}
      setAudioOn={setAudioOn}
      setAudioFormat={setAudioFormat}
      subCount={subCount}
      setSubsOn={setSubsOn}
      captionTimingQa={captionTimingQa}
      error={error}
      note={note}
      serverDiag={serverDiag}
      savedPath={savedPath}
      durationSec={timeline.durationSec}
      durationText={formatDuration(timeline.durationSec * 1000)}
      estSizeMb={estSizeMb}
      isLocked={isLocked}
      downloadUrl={downloadUrl}
      cancel={cancel}
      download={download}
      startExport={startExport}
    />
  )
}
