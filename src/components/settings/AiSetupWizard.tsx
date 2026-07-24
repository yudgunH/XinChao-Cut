import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, Download, ExternalLink, HardDrive, Loader2, Sparkles, X } from 'lucide-react'

import {
  clearCapabilitiesCache,
  getAiSetupStatus,
  getDataDir,
  pickFolder,
  runAiSetup,
  setDataDir,
  startBackend,
  type AiSetupOptions,
  type AiSetupStatus,
  type WhisperModel,
} from '@engine/backend'

interface AiSetupWizardProps {
  onClose: () => void
  onComplete?: () => void
  initialSetup?: boolean
}

type Phase = 'idle' | 'running' | 'done' | 'failed'

const WHISPER_MODELS: Array<{ id: WhisperModel; label: string; detail: string }> = [
  { id: 'tiny', label: 'Tiny', detail: 'lightest and fastest' },
  { id: 'small', label: 'Small', detail: 'balanced and recommended' },
  { id: 'large-v3', label: 'Large v3', detail: 'more accurate, larger download and higher load' },
]

function pctFromLine(line: string): number | null {
  if (line.includes('=== Setup done ===')) return 100
  if (line.includes('[models]')) return 88
  if (line.includes('[ffmpeg]')) return 78
  if (line.includes('[tts]')) return 62
  if (line.includes('[audio]')) return 52
  if (line.includes('[funasr]')) return 44
  if (line.includes('[caption]')) return 34
  if (line.includes('[core]')) return 12
  return null
}

export function AiSetupWizard({ onClose, onComplete, initialSetup = false }: AiSetupWizardProps) {
  const [status, setStatus] = useState<AiSetupStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [pct, setPct] = useState(0)
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dataDir, setDataDirState] = useState<string | null>(null)
  const [dataNote, setDataNote] = useState<string | null>(null)
  const [options, setOptions] = useState<AiSetupOptions>({
    captions: false,
    funasr: false,
    audio: false,
    tts: false,
    whisperModel: 'small',
    downloadModels: false,
  })
  const initializedRef = useRef(false)
  const logRef = useRef<HTMLDivElement>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  async function refreshStatus() {
    const next = await getAiSetupStatus()
    setStatus(next)
    setDataDirState(await getDataDir())
    if (next && !initializedRef.current) {
      initializedRef.current = true
      setOptions({
        captions: next.captions,
        funasr: next.funasr,
        audio: next.audio,
        tts: next.tts,
        whisperModel: next.whisperModel ?? 'small',
        downloadModels: next.modelDownloadPolicy === 'download-now',
      })
    }
    return next
  }

  useEffect(() => {
    void refreshStatus().then((next) => {
      if (next?.running) void start(true)
    })
    return () => unsubRef.current?.()
    // Mount-only: re-running would attach duplicate Tauri listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [lines])

  async function changeDataDir() {
    try {
      const picked = await pickFolder(dataDir ?? undefined)
      if (!picked) return
      await setDataDir(picked)
      setDataDirState(await getDataDir())
      setDataNote('The model and data location was changed. Restart the backend to apply it.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change the data folder.')
    }
  }

  async function start(reattach = false) {
    if (unsubRef.current) return
    setPhase('running')
    setError(null)
    if (!reattach) setLines([])
    setPct((current) => Math.max(current, 2))
    try {
      unsubRef.current = await runAiSetup(
        options,
        (line) => {
          setLines((current) => [...current, line])
          const nextPct = pctFromLine(line)
          if (nextPct !== null) setPct((current) => Math.max(current, nextPct))
        },
        (code) => {
          unsubRef.current?.()
          unsubRef.current = null
          if (code === 0) {
            setPct(100)
            setPhase('done')
            void startBackend()
            clearCapabilitiesCache()
            void refreshStatus()
            onComplete?.()
          } else {
            setPhase('failed')
            setError(`Setup stopped with code ${code}. Check the log below for the failed step.`)
          }
        },
      )
    } catch (cause) {
      setPhase('failed')
      setError(cause instanceof Error ? cause.message : 'Unable to start the model installer.')
    }
  }

  const notDesktop = status === null
  const noPython = !!status && !status.python
  const canStart = !!status?.packaged && !!status.python && phase !== 'running'
  const coreOnly = !options.captions && !options.funasr && !options.audio && !options.tts
  const updateOption = <K extends keyof AiSetupOptions>(key: K, value: AiSetupOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }))
  }

  return createPortal(
    <div className="fixed inset-0 z-[93] flex items-center justify-center bg-black/80" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-[650px] flex-col overflow-hidden rounded-xl bg-bg-1 shadow-e3 ring-1 ring-border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-1">
              <Sparkles size={15} className="text-accent" />
              {initialSetup ? 'Set up XinChao-Cut' : 'Manage models and backend'}
            </h2>
            <p className="text-2xs text-text-3">
              {initialSetup
                ? 'Install Core + FFmpeg so the backend can start automatically. AI models can be added later.'
                : 'Install only the features you need. You can return and add more at any time.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-5">
          {notDesktop ? (
            <Warning>This feature is available only in the packaged desktop app.</Warning>
          ) : !status?.packaged ? (
            <Warning>This build does not include the backend runtime. Use the full desktop installer.</Warning>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <StatusItem ok={status.core && status.ffmpeg} label="Core + FFmpeg" />
                <StatusItem ok={status.captions} label="WhisperX" />
                <StatusItem ok={status.audio} label="Demucs" />
                <StatusItem ok={status.tts} label="OmniVoice" />
              </div>

              <div className="rounded-md bg-bg-2/50 p-3 ring-1 ring-border">
                <p className="mb-2 text-xs font-medium text-text-1">Choose packages to install</p>
                <PackageOption
                  checked
                  disabled
                  title="Core + FFmpeg"
                  detail="Required · media reading, proxies, and server export · no AI model download"
                />
                <PackageOption
                  checked={options.captions}
                  disabled={phase === 'running'}
                  onChange={(checked) => updateOption('captions', checked)}
                  title="WhisperX · captions"
                  detail="Install the speech-recognition runtime; choose a model below"
                />
                {options.captions && (
                  <div className="mb-2 ml-7 grid grid-cols-3 gap-1.5">
                    {WHISPER_MODELS.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        disabled={phase === 'running'}
                        onClick={() => updateOption('whisperModel', model.id)}
                        className={`rounded border px-2 py-1.5 text-left ${
                          options.whisperModel === model.id
                            ? 'border-accent/50 bg-accent/15 text-accent'
                            : 'border-border bg-bg-2 text-text-2 hover:bg-bg-3'
                        }`}
                      >
                        <span className="block text-2xs font-medium">{model.label}</span>
                        <span className="block text-[10px] text-text-3">{model.detail}</span>
                      </button>
                    ))}
                  </div>
                )}
                <PackageOption
                  checked={options.funasr}
                  disabled={phase === 'running'}
                  onChange={(checked) => updateOption('funasr', checked)}
                  title="FunASR · Chinese captions"
                  detail="Optional; Paraformer, VAD, and punctuation models have separate ModelScope licenses"
                />
                <PackageOption
                  checked={options.audio}
                  disabled={phase === 'running'}
                  onChange={(checked) => updateOption('audio', checked)}
                  title="Demucs · vocal separation"
                  detail="htdemucs model; shares the GPU runtime with WhisperX"
                />
                <PackageOption
                  checked={options.tts}
                  disabled={phase === 'running'}
                  onChange={(checked) => updateOption('tts', checked)}
                  title="OmniVoice · Voice Studio"
                  detail="Generate speech and clone voices in an isolated environment"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-2 rounded-md bg-bg-2/50 p-3 ring-1 ring-border">
                <input
                  type="checkbox"
                  checked={options.downloadModels}
                  disabled={phase === 'running'}
                  onChange={(event) => updateOption('downloadModels', event.target.checked)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="block text-xs text-text-1">Download models during setup</span>
                  <span className="block text-2xs text-text-3">
                    Turn this off for a faster, smaller setup. Models will download when each feature is first used.
                  </span>
                </span>
              </label>

              <div className="rounded-md bg-bg-2/50 p-3 ring-1 ring-border">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-text-2"><HardDrive size={13} /> Model and data location</span>
                  <button
                    onClick={() => void changeDataDir()}
                    disabled={phase === 'running'}
                    className="rounded bg-bg-3 px-2.5 py-1 text-2xs text-text-1 hover:bg-bg-4 disabled:opacity-40"
                  >
                    Change…
                  </button>
                </div>
                <p className="mt-1 break-all font-mono text-2xs text-text-3">{dataDir ?? '—'}</p>
                <p className="mt-1 text-2xs text-text-3">Choose a drive with plenty of free space before downloading models. Cloned voices are stored here too.</p>
                {dataNote && <p className="mt-1 text-2xs text-success">{dataNote}</p>}
              </div>

              {noPython && (
                <div className="rounded-md bg-warning/10 p-3 text-2xs text-warning ring-1 ring-warning/30">
                  <p className="mb-1 font-medium">Python 3.11 64-bit is required</p>
                  <p>Install Python, select “Add python.exe to PATH”, then click “Check again”.</p>
                  <a
                    href="https://www.python.org/downloads/release/python-3119/"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    Download Python 3.11 <ExternalLink size={11} />
                  </a>
                </div>
              )}

              {(phase === 'running' || phase === 'done' || pct > 0) && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-2xs text-text-3">
                    <span>{phase === 'running' ? 'Installing…' : phase === 'done' ? 'Complete' : phase === 'failed' ? 'Stopped' : ''}</span>
                    <span className="font-mono">{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded bg-bg-3">
                    <div
                      className={`h-full transition-[width] duration-500 ${phase === 'failed' ? 'bg-danger' : 'bg-accent'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )}

              {lines.length > 0 && (
                <div ref={logRef} className="max-h-48 overflow-auto rounded-md bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-text-2 ring-1 ring-border">
                  {lines.map((line, index) => <div key={index} className="whitespace-pre-wrap break-words">{line}</div>)}
                </div>
              )}
              {error && <p className="flex items-start gap-1.5 text-2xs text-danger"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</p>}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button onClick={() => void refreshStatus()} disabled={phase === 'running'} className="text-2xs text-text-3 hover:text-text-1 disabled:opacity-40">
            Check again
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md bg-bg-3 px-4 py-2 text-xs text-text-1 hover:bg-bg-4">
              {phase === 'done' ? 'Close' : 'Later'}
            </button>
            <button
              onClick={() => void start()}
              disabled={!canStart}
              className="flex items-center gap-1.5 rounded-md bg-accent px-5 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              {phase === 'running'
                ? <><Loader2 size={13} className="animate-spin" /> Installing…</>
                : <><Download size={13} /> {initialSetup && coreOnly ? 'Install Core + FFmpeg' : 'Install / update selected packages'}</>}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Warning({ children }: { children: ReactNode }) {
  return <p className="flex items-start gap-1.5 text-xs text-warning"><AlertCircle size={14} className="mt-0.5 shrink-0" />{children}</p>
}

function StatusItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between rounded bg-bg-2/50 px-2.5 py-2 text-2xs ring-1 ring-border">
      <span className="text-text-2">{label}</span>
      <span className={ok ? 'text-success' : 'text-text-3'}>{ok ? <Check size={13} /> : 'not installed'}</span>
    </div>
  )
}

function PackageOption({
  checked,
  disabled,
  onChange,
  title,
  detail,
}: {
  checked: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  title: string
  detail: string
}) {
  return (
    <label className="mb-2 flex cursor-pointer items-start gap-2 last:mb-0">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        className="mt-0.5 accent-[var(--accent)]"
      />
      <span>
        <span className="block text-xs text-text-1">{title}</span>
        <span className="block text-2xs text-text-3">{detail}</span>
      </span>
    </label>
  )
}
