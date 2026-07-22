import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Download,
  Film,
  FolderOpen,
  Loader2,
  Server,
  X,
} from 'lucide-react'

import type {
  BackendCapabilities,
  ServerExportDiag,
} from '@engine/backend'
import type { AudioMasteringPreset } from '@engine/export/audio-mastering'
import type { BrowserAudioRoute } from '@engine/export/audio-memory'
import type { BrowserStorageSnapshot } from '@engine/export/browser-admission'
import type { ExportEngine, ExportEngineAdvice } from '@engine/export/engine-advisor'
import type {
  ExportDynamicRange,
  ExportProgress,
  ExportSettings,
  ExportVideoCodec,
} from '@engine/export/exporter'
import {
  EXPORT_QUALITY_PROFILES,
  type ExportQualityProfile,
} from '@engine/export/quality'
import type { ZeroCopyCaseStatus } from '@engine/export/zero-copy-self-test'
import type { CaptionTimingQaSummary } from '@engine/timeline/caption-timing'

const RESOLUTIONS = [
  { height: 720, label: '720P' },
  { height: 1080, label: '1080P' },
  { height: 2160, label: '4K' },
]
const FRAME_RATES = [24, 30, 60]
const isSoftwareVideoEncoder = (encoder: string | null | undefined) =>
  !!encoder && encoder.startsWith('lib')

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${Math.max(1, Math.round(mb))} MB`
}

const selectCls =
  'w-44 shrink-0 rounded-md bg-bg-2 px-2.5 py-1.5 text-xs text-text-1 outline-none ' +
  'ring-1 ring-border focus:ring-accent disabled:opacity-50 cursor-pointer'

function createExportProgressBorder(aspect: { w: number; h: number }) {
  const width = 100
  const ratio = aspect.w > 0 && aspect.h > 0 ? aspect.h / aspect.w : 1
  const height = Math.max(12, width * ratio)
  const inset = 1
  const left = inset
  const top = inset
  const right = width - inset
  const bottom = height - inset
  const radius = Math.min(2.5, (right - left) / 2, (bottom - top) / 2)

  // Start at the upper-left tangent and travel clockwise. The viewBox has the
  // same aspect as the preview, so dash length cannot repeat when 9:16 video
  // stretches the SVG vertically.
  const path = [
    `M ${left + radius} ${top}`,
    `H ${right - radius}`,
    `A ${radius} ${radius} 0 0 1 ${right} ${top + radius}`,
    `V ${bottom - radius}`,
    `A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom}`,
    `H ${left + radius}`,
    `A ${radius} ${radius} 0 0 1 ${left} ${bottom - radius}`,
    `V ${top + radius}`,
    `A ${radius} ${radius} 0 0 1 ${left + radius} ${top}`,
    'Z',
  ].join(' ')
  const straightLength = 2 * ((right - left - 2 * radius) + (bottom - top - 2 * radius))
  const perimeter = straightLength + 2 * Math.PI * radius

  return { height, path, perimeter, width }
}

interface ExportDialogViewProps {
  handleClose: () => void
  isExporting: boolean
  isDone: boolean
  cover: string | null
  aspect: { w: number; h: number }
  pct: number
  cancelling: boolean
  engine: ExportEngine
  serverLabel: string | null
  progress: ExportProgress | null
  etaText: string
  settings: ExportSettings
  fps: number
  name: string
  setName: Dispatch<SetStateAction<string>>
  videoOn: boolean
  audioOn: boolean
  audioFormat: 'mp3' | 'wav'
  subsOn: boolean
  serverAvailable: boolean
  engineAdvice: ExportEngineAdvice
  userPickedEngineRef: { current: boolean }
  setEngine: Dispatch<SetStateAction<ExportEngine>>
  exportDir: string
  browserPredicted: string
  serverPredicted: string | null
  hybridAudioReady: boolean
  approxServer: boolean
  toggleApproxServer: (value: boolean) => void
  mustUseBrowser: boolean
  browserAudioRoute: BrowserAudioRoute
  setError: Dispatch<SetStateAction<string | null>>
  height: number
  setHeight: Dispatch<SetStateAction<number>>
  setFps: Dispatch<SetStateAction<number>>
  qualityProfile: ExportQualityProfile
  setQualityProfile: Dispatch<SetStateAction<ExportQualityProfile>>
  recommendedKbps: number
  codecBitrateMultiplier: Record<ExportVideoCodec, number>
  videoCodec: ExportVideoCodec
  setVideoCodec: Dispatch<SetStateAction<ExportVideoCodec>>
  dynamicRange: ExportDynamicRange
  setDynamicRange: Dispatch<SetStateAction<ExportDynamicRange>>
  backendCaps: BackendCapabilities | null
  browserCodecSupport: Record<ExportVideoCodec, boolean> | null
  selectedServerEncoder: string | null | undefined
  selectedHdrEncoder: string | null | undefined
  browserZeroCopy: boolean
  setBrowserZeroCopy: Dispatch<SetStateAction<boolean>>
  zeroCopySelectable: boolean
  cachedZeroCopyStatus: ZeroCopyCaseStatus | 'untested'
  audioMastering: AudioMasteringPreset
  setAudioMastering: Dispatch<SetStateAction<AudioMasteringPreset>>
  audioClipCount: number
  updateExportDir: (dir: string) => void
  chooseFolder: () => Promise<void>
  folderPickerAvailable: boolean
  browserStorage: BrowserStorageSnapshot | null
  setVideoOn: Dispatch<SetStateAction<boolean>>
  setAudioOn: Dispatch<SetStateAction<boolean>>
  setAudioFormat: Dispatch<SetStateAction<'mp3' | 'wav'>>
  subCount: number
  setSubsOn: Dispatch<SetStateAction<boolean>>
  captionTimingQa: CaptionTimingQaSummary
  error: string | null
  note: string | null
  serverDiag: ServerExportDiag | null
  savedPath: string | null
  durationSec: number
  durationText: string
  estSizeMb: number
  isLocked: boolean
  downloadUrl: string | null
  cancel: () => void
  download: () => Promise<void>
  startExport: () => Promise<void>
}

export function ExportDialogView(props: ExportDialogViewProps) {
  const {
    handleClose,
    isExporting,
    isDone,
    cover,
    aspect,
    pct,
    cancelling,
    engine,
    serverLabel,
    progress,
    etaText,
    settings,
    fps,
    name,
    setName,
    videoOn,
    audioOn,
    audioFormat,
    subsOn,
    serverAvailable,
    engineAdvice,
    userPickedEngineRef,
    setEngine,
    exportDir,
    browserPredicted,
    serverPredicted,
    hybridAudioReady,
    approxServer,
    toggleApproxServer,
    mustUseBrowser,
    browserAudioRoute,
    setError,
    height,
    setHeight,
    setFps,
    qualityProfile,
    setQualityProfile,
    recommendedKbps,
    codecBitrateMultiplier: CODEC_BITRATE_MULTIPLIER,
    videoCodec,
    setVideoCodec,
    dynamicRange,
    setDynamicRange,
    backendCaps,
    browserCodecSupport,
    selectedServerEncoder,
    selectedHdrEncoder,
    browserZeroCopy,
    setBrowserZeroCopy,
    zeroCopySelectable,
    cachedZeroCopyStatus,
    audioMastering,
    setAudioMastering,
    audioClipCount,
    updateExportDir,
    chooseFolder,
    folderPickerAvailable,
    browserStorage,
    setVideoOn,
    setAudioOn,
    setAudioFormat,
    subCount,
    setSubsOn,
    captionTimingQa,
    error,
    note,
    serverDiag,
    savedPath,
    durationSec,
    durationText,
    estSizeMb,
    isLocked,
    downloadUrl,
    cancel,
    download,
    startExport,
  } = props

  // Advanced controls (engine override, parity, codec, HDR, zero-copy) are
  // collapsed by default: the engine is auto-selected, so a normal export needs
  // none of them. Kept for power users / debugging behind one disclosure.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const autoEstimate = engine === 'server' ? (serverPredicted ?? browserPredicted) : browserPredicted
  const borderProgress = Math.max(0, Math.min(100, isDone ? 100 : pct))
  const progressBorder = createExportProgressBorder(aspect)

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
            type="button"
            onClick={handleClose}
            className="relative z-10 rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1"
            title={isExporting ? 'Close and cancel export' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — two columns */}
        <div className="flex gap-5 p-5">
          {/* Left: cover preview */}
          <div className="flex w-[300px] shrink-0 flex-col gap-3">
            <div
              className={`relative flex items-center justify-center overflow-hidden rounded-lg bg-black ring-1 ${
                isDone ? 'ring-success/70' : 'ring-border'
              }`}
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
                      {cancelling
                        ? 'Cancelling…'
                        : engine === 'server'
                          ? (serverLabel ?? 'Rendering')
                          : progress?.phase === 'audio'
                            ? (serverLabel ?? 'Mixing audio')
                            : progress?.phase === 'muxing'
                              ? 'Finalizing'
                              : 'Encoding'}
                    </span>
                  )}
                  <span className="px-3 text-center text-2xs text-white/70">{etaText}</span>
                </div>
              )}

              {/* Determinate perimeter progress: it grows clockwise from the
                  upper-left and closes the complete frame at 100%. */}
              {(isExporting || isDone) && (
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
                  viewBox={`0 0 ${progressBorder.width} ${progressBorder.height}`}
                >
                  <path
                    data-export-progress-border="true"
                    d={progressBorder.path}
                    fill="none"
                    stroke={isDone ? 'var(--success)' : 'var(--accent)'}
                    strokeWidth="0.85"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={`${progressBorder.perimeter} ${progressBorder.perimeter}`}
                    strokeDashoffset={progressBorder.perimeter * (1 - borderProgress / 100)}
                    style={{
                      filter: `drop-shadow(0 0 5px ${isDone ? 'var(--success)' : 'var(--accent)'})`,
                      opacity: borderProgress > 0 ? 1 : 0,
                    }}
                  />
                </svg>
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

            {/* Auto engine summary — the engine is chosen automatically; this is
                read-only status, not a control. Overrides live under Advanced. */}
            {!isExporting && !isDone && videoOn && (
              <div className={`mt-1 rounded-md p-2.5 text-2xs ring-1 ${
                engineAdvice.blockedReason && !hybridAudioReady
                  ? 'bg-danger/10 text-danger ring-danger/30'
                  : 'bg-bg-2 text-text-2 ring-border'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-1">
                    {engine === 'server' ? 'Xuất bằng Server' : 'Xuất bằng Browser'}
                    <span className="ml-1 font-normal text-text-3">
                      {userPickedEngineRef.current ? '(thủ công)' : '(tự động)'}
                    </span>
                  </span>
                  {autoEstimate && <span className="text-text-3">~{autoEstimate}</span>}
                </div>
                <div className="mt-1">
                  {engineAdvice.blockedReason && !hybridAudioReady
                    ? engineAdvice.blockedReason
                    : hybridAudioReady
                      ? 'Video khớp preview 100%; âm thanh được ghép trên Server nên không tốn bộ nhớ trình duyệt.'
                      : engine === 'server'
                        ? 'Nhanh hơn cho video dài. Caption/hiệu ứng có thể lệch nhẹ so với preview.'
                        : 'Khớp preview 100% — cùng bộ render với khung xem trước.'}
                </div>
                {engineAdvice.warnings.length > 0 && (
                  <div className="mt-1 text-warning">{engineAdvice.warnings.join(' ')}</div>
                )}
              </div>
            )}

            {/* Actionable escape hatch: a long timeline whose audio can't fit in
                browser memory AND whose visuals force Browser. Offer the Server
                fast path (accepts approximate captions) in one click. */}
            {mustUseBrowser && browserAudioRoute.action === 'block' && serverAvailable &&
              !isExporting && !isDone && (
              <div className="mt-1 flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-2xs text-warning ring-1 ring-warning/30">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <div>
                  Video này quá dài để ghép âm thanh trong trình duyệt.
                  <button
                    type="button"
                    className="mt-2 block rounded bg-warning/20 px-2 py-1 font-medium text-warning ring-1 ring-warning/40 hover:bg-warning/30"
                    onClick={() => {
                      userPickedEngineRef.current = true
                      toggleApproxServer(true)
                      setEngine('server')
                      setError(null)
                    }}
                  >
                    Dùng Server để xuất video dài này
                  </button>
                </div>
              </div>
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

              <Row label="Quality">
                <select
                  value={qualityProfile}
                  onChange={(e) => setQualityProfile(e.target.value as ExportQualityProfile)}
                  disabled={isExporting || !videoOn} className={selectCls}
                >
                  {EXPORT_QUALITY_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label} · {' '}
                      {(
                        Math.round(
                          recommendedKbps * profile.videoBitrateMultiplier *
                          CODEC_BITRATE_MULTIPLIER[videoCodec],
                        ) / 1000
                      ).toFixed(1)} Mbps
                    </option>
                  ))}
                </select>
              </Row>

              <Row label="Audio master">
                <select
                  value={audioMastering}
                  onChange={(event) => setAudioMastering(event.target.value as AudioMasteringPreset)}
                  disabled={isExporting || !videoOn || audioClipCount === 0}
                  className={selectCls}
                >
                  <option value="off">Off · original mix</option>
                  <option value="social">Social · -14 LUFS / -1 dBTP</option>
                  <option value="voice">Voice · -16 LUFS / -1 dBTP</option>
                </select>
              </Row>

              <Row label="Format">
                <div className={`${selectCls} flex items-center text-text-2`}>MP4</div>
              </Row>

              <Row label="Save to">
                <div className="flex w-44 items-center gap-1">
                  <input
                    value={exportDir}
                    onChange={(e) => updateExportDir(e.target.value)}
                    disabled={isExporting}
                    placeholder="Ask each time"
                    title={exportDir || 'No folder set — download / ask on export'}
                    className="min-w-0 flex-1 rounded-md bg-bg-2 px-2 py-1.5 text-2xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
                  />
                  {folderPickerAvailable && (
                    <button
                      type="button"
                      onClick={chooseFolder}
                      disabled={isExporting}
                      title="Choose folder"
                      className="shrink-0 rounded-md bg-bg-3 p-1.5 text-text-2 hover:bg-bg-4 hover:text-text-1 disabled:opacity-40"
                    >
                      <FolderOpen size={13} />
                    </button>
                  )}
                  {exportDir && (
                    <button
                      type="button"
                      onClick={() => updateExportDir('')}
                      disabled={isExporting}
                      title="Clear (download instead)"
                      className="shrink-0 rounded-md bg-bg-3 p-1.5 text-text-2 hover:bg-bg-4 hover:text-text-1 disabled:opacity-40"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </Row>
              {engine === 'browser' && (
                <div className="ml-auto w-44 text-2xs text-text-3">
                  {exportDir
                    ? 'Hybrid Browser Direct: Preview renderer + backend file sink. ' +
                      'Durable 16 MiB transport checkpoints; OPFS scratch is not used.'
                    : browserStorage?.quotaBytes
                      ? `Browser storage: ~${formatSize(browserStorage.availableBytes / 1024 / 1024)} free ` +
                        `of ${formatSize(browserStorage.quotaBytes / 1024 / 1024)} ` +
                        `${browserStorage.persisted ? '(persistent)' : ''}`
                      : 'Browser storage quota unavailable; export will verify OPFS before encoding.'}
                </div>
              )}
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
              {!videoOn && (
                <Row label="Audio master">
                  <select
                    value={audioMastering}
                    onChange={(event) => setAudioMastering(event.target.value as AudioMasteringPreset)}
                    disabled={isExporting || !audioOn || audioClipCount === 0}
                    className={selectCls}
                  >
                    <option value="off">Off · original mix</option>
                    <option value="social">Social · -14 LUFS / -1 dBTP</option>
                    <option value="voice">Voice · -16 LUFS / -1 dBTP</option>
                  </select>
                </Row>
              )}
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
            {captionTimingQa.repairedCount > 0 && (
              <div className="mt-2 flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-2xs text-warning ring-1 ring-warning/30">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <p>
                  Caption QA repaired timing for {captionTimingQa.repairedCount} cue(s)
                  {' '}before preview/export. Regenerate legacy captions if you also want the
                  improved short-phrase segmentation from the updated transcriber.
                </p>
              </div>
            )}
            {captionTimingQa.blockingCount > 0 && (
              <div className="mt-2 flex items-start gap-2 rounded-md bg-danger/10 p-2.5 text-2xs text-danger ring-1 ring-danger/30">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <p>
                  {captionTimingQa.blockingCount} caption cue(s) still have invalid timing.
                  Fix or remove them before exporting.
                </p>
              </div>
            )}

            {/* Advanced — collapsed by default. The engine is auto-selected, so
                everything here (manual engine, parity/speed, codec, HDR, GPU
                zero-copy) is opt-in for power users and debugging. */}
            {!isExporting && !isDone && (
              <div className="mt-4 border-t border-border pt-2">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-2xs font-medium text-text-2 hover:text-text-1"
                >
                  <ChevronRight
                    size={12}
                    className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
                  />
                  Nâng cao
                </button>

                {advancedOpen && (
                  <div className="mt-2">
                    {serverAvailable && (
                      <Row label="Engine">
                        <div className="flex w-44 gap-1.5">
                          <EnginePill
                            active={engine === 'server'} disabled={!engineAdvice.serverAllowed}
                            onClick={() => { userPickedEngineRef.current = true; setEngine('server') }}
                            icon={<Server size={12} />} label="Server"
                          />
                          <EnginePill
                            active={engine === 'browser'} disabled={!engineAdvice.browserAllowed}
                            onClick={() => { userPickedEngineRef.current = true; setEngine('browser') }}
                            icon={<Cpu size={12} />} label="Browser"
                          />
                        </div>
                      </Row>
                    )}

                    {serverAvailable && (
                      <label className="mt-1 flex cursor-pointer items-start gap-2 py-1.5 text-2xs text-text-3">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={approxServer}
                          onChange={(e) => toggleApproxServer(e.target.checked)}
                        />
                        <span>
                          Ưu tiên tốc độ Server cho timeline có caption/hiệu ứng
                          (ffmpeg tái hiện <i>gần đúng</i> — có thể lệch nhẹ so với preview)
                        </span>
                      </label>
                    )}

                    <Row label="Codec">
                      <select
                        value={videoCodec}
                        onChange={(event) => {
                          const next = event.target.value as ExportVideoCodec
                          setVideoCodec(next)
                          if (next === 'h264' && dynamicRange === 'hdr10') setDynamicRange('sdr')
                        }}
                        disabled={!videoOn}
                        className={selectCls}
                      >
                        <option value="h264">H.264 · compatible</option>
                        <option
                          value="hevc"
                          disabled={
                            (engine === 'server' && backendCaps?.runtime?.videoEncoders?.hevc === null) ||
                            (engine === 'browser' && browserCodecSupport?.hevc === false)
                          }
                        >
                          HEVC · smaller{
                            (engine === 'server' && backendCaps?.runtime?.videoEncoders?.hevc === null) ||
                            (engine === 'browser' && browserCodecSupport?.hevc === false)
                              ? ' · unavailable' : ''
                          }
                        </option>
                        <option
                          value="av1"
                          disabled={
                            (engine === 'server' && backendCaps?.runtime?.videoEncoders?.av1 === null) ||
                            (engine === 'browser' && browserCodecSupport?.av1 === false)
                          }
                        >
                          AV1 · smallest{
                            (engine === 'server' && backendCaps?.runtime?.videoEncoders?.av1 === null) ||
                            (engine === 'browser' && browserCodecSupport?.av1 === false)
                              ? ' · unavailable'
                              : engine === 'server' && isSoftwareVideoEncoder(
                                  backendCaps?.runtime?.videoEncoders?.av1,
                                )
                                ? ' · CPU very slow'
                                : ''
                          }
                        </option>
                      </select>
                    </Row>
                    {engine === 'server' && videoCodec === 'av1' &&
                      isSoftwareVideoEncoder(selectedServerEncoder) && (
                        <div className="ml-auto w-44 text-2xs text-warning">
                          AV1 is using {selectedServerEncoder} on CPU. Long-form export can be
                          many times slower than HEVC/H.264 hardware encoding.
                        </div>
                      )}

                    <Row label="Dynamic range">
                      <select
                        value={dynamicRange}
                        onChange={(event) => {
                          const next = event.target.value as ExportDynamicRange
                          setDynamicRange(next)
                          if (next === 'hdr10' && videoCodec === 'h264') setVideoCodec('hevc')
                        }}
                        disabled={!videoOn || engine === 'browser'}
                        className={selectCls}
                        title={engine === 'browser'
                          ? 'Browser compositor is 8-bit; use Server for truthful HDR10 output.'
                          : undefined}
                      >
                        <option value="sdr">SDR · Rec.709</option>
                        <option value="hdr10">HDR10 · 10-bit</option>
                      </select>
                    </Row>
                    {dynamicRange === 'hdr10' && (
                      <div className="ml-auto w-44 text-2xs text-warning">
                        HDR10 preserves a 10-bit BT.2020/PQ source on the Server fast path.
                        Timelines with captions/effects must use SDR for now.
                        {selectedHdrEncoder === null && backendCaps?.runtime?.hdr10VideoEncoders
                          ? ' No verified 10-bit encoder is available; only an exact same-codec stream copy can succeed.'
                          : ''}
                      </div>
                    )}

                    {engine === 'browser' && (
                      <Row label="GPU zero-copy">
                        <label className="flex w-44 items-center gap-2 text-2xs text-text-2">
                          <input
                            type="checkbox"
                            checked={browserZeroCopy}
                            onChange={(event) => setBrowserZeroCopy(event.target.checked)}
                            disabled={!videoOn || !zeroCopySelectable}
                          />
                          {!zeroCopySelectable
                            ? 'Run GPU diagnostics first'
                            : cachedZeroCopyStatus === 'untested'
                              ? 'Auto - covering case verified'
                              : `Auto · ${cachedZeroCopyStatus}`}
                        </label>
                      </Row>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-danger/10 p-2.5 text-2xs text-danger ring-1 ring-danger/30">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <p className="break-words">{error}</p>
              </div>
            )}

            {/* Success note (captions export) */}
            {note && !error && <p className="mt-3 text-2xs text-success">{note}</p>}

            {/* Render diagnostics — explains where the work ran (GPU encode vs
                CPU compositor) so high CPU during a GPU export isn't a mystery. */}
            {isDone && serverDiag && (
              <p className="mt-3 text-2xs text-text-3">
                Encode:{' '}
                <span className={serverDiag.encodeOnGpu || serverDiag.videoReencoded === false ? 'text-success' : 'text-text-2'}>
                  {serverDiag.videoReencoded === false
                    ? 'Stream copy (lossless)'
                    : serverDiag.encodeOnGpu
                      ? `${serverDiag.encoder} (GPU)`
                      : `${serverDiag.encoder} (CPU)`}
                </span>
                {' · '}Decode: {serverDiag.decode === 'none'
                  ? 'not required'
                  : serverDiag.decode === 'per-chunk' ? 'adaptive per chunk'
                  : serverDiag.decode === 'cpu' ? 'CPU' : `GPU (${serverDiag.decode})`}
                {serverDiag.cpuCompositor && ' · Compositing: CPU (overlay/blur/captions)'}
                {serverDiag.renderSec != null && (
                  <>
                    {' · '}Render: {serverDiag.renderSec}s
                    {serverDiag.speedX != null && ` (${serverDiag.speedX}× realtime)`}
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <div className="flex min-w-0 items-center gap-2 text-2xs text-text-3">
            {isDone && savedPath ? (
              <span className="flex min-w-0 items-center gap-1 text-success">
                <CheckCircle2 size={12} className="shrink-0" />
                <span className="truncate" title={savedPath}>Saved to {savedPath}</span>
              </span>
            ) : (
              <>
                <span>Duration: <span className="text-text-2">{durationText}</span></span>
                <span className="text-border">|</span>
                <span>Size: <span className="text-text-2">about {formatSize(estSizeMb)}</span></span>
              </>
            )}
          </div>

          <div className="flex shrink-0 gap-2">
            {cancelling ? (
              <button
                type="button"
                disabled
                className="flex items-center gap-1.5 rounded-md bg-bg-3 px-4 py-2 text-xs text-text-2 opacity-80"
              >
                <Loader2 size={13} className="animate-spin" />
                Cancelling…
              </button>
            ) : isExporting ? (
              <button
                type="button"
                onClick={cancel}
                className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
              >
                Cancel
              </button>
            ) : isDone ? (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
                >
                  Close
                </button>
                {/* When the file was written straight to the export folder there's
                    nothing to download — just confirm. Otherwise offer Download. */}
                {!savedPath && downloadUrl && (
                  <button
                    type="button"
                    onClick={download}
                    className="flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-xs font-medium text-white hover:bg-success/90"
                  >
                    <Download size={13} />
                    Download
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { void startExport() }}
                  disabled={
                    isLocked ||
                    (videoOn && captionTimingQa.blockingCount > 0) ||
                    (videoOn && !!engineAdvice.blockedReason && !hybridAudioReady) ||
                    !(
                      (videoOn && durationSec > 0) ||
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
