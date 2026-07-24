import {
  Server,
  RefreshCw,
  Cpu,
  Zap,
  Check,
  X,
  MemoryStick,
  AlertTriangle,
  Sparkles,
  Power,
  Gauge,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useUIStore, type ProxyMode } from '@store/ui-store'
import {
  getBackendMetrics,
  isDesktopShell,
  startBackend,
  getCapabilities,
  clearCapabilitiesCache,
  reprobeBackendRuntime,
  type BackendRuntime,
  type BackendMetrics,
} from '@engine/backend'
import { superviseBackendRestart } from '@engine/backend/restart-supervisor'
import { AiSetupWizard } from '@components/settings/AiSetupWizard'
import { webViewRuntimeVersion } from '@engine/preview/gpu-adapter'
import type * as ZeroCopyDiagnosticsModule from '@components/settings/ZeroCopyDiagnostics'

type ZeroCopyDiagnosticsComponent = typeof ZeroCopyDiagnosticsModule.ZeroCopyDiagnostics

const PROXY_MODES: { id: ProxyMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Never auto-generate preview proxies' },
  { id: 'smart', label: 'Smart', hint: 'Auto-proxy sources taller than 1080p' },
  { id: 'always', label: 'Always', hint: 'Auto-proxy every video' },
]

// Friendly names for the H.264 encoder the backend reports (see TASK-03 runtime).
const ENCODER_LABEL: Record<string, string> = {
  h264_nvenc: 'NVENC (NVIDIA GPU)',
  h264_qsv: 'Intel QuickSync (GPU)',
  h264_amf: 'AMD AMF (GPU)',
  h264_videotoolbox: 'Apple VideoToolbox (GPU)',
  libx264: 'libx264 (CPU)',
}

function encoderInfo(rt: BackendRuntime | undefined): { text: string; gpu: boolean } {
  if (!rt) return { text: 'n/a (older backend)', gpu: false }
  const enc = rt.videoEncoder
  if (enc === null) return { text: 'detecting…', gpu: false }
  return { text: ENCODER_LABEL[enc] ?? enc, gpu: enc !== 'libx264' }
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-danger'
  if (pct >= 70) return 'bg-warning'
  return 'bg-success'
}

function fmtEta(sec: number | null): string {
  if (sec === null || sec < 0) return 'estimating…'
  if (sec < 60) return `~${sec}s remaining`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `~${m}m${s ? ` ${s}s` : ''} remaining`
  const h = Math.floor(m / 60)
  return `~${h}h ${m % 60}m remaining`
}

/** Live VRAM + job-queue panel — polls /metrics while the dropdown is open so the
 * user can see when other processes are eating the GPU (the "treo do VRAM" case)
 * and whether any backend task is waiting on VRAM. */
function GpuMetricsSection() {
  const [m, setM] = useState<BackendMetrics | null>(null)
  useEffect(() => {
    let alive = true
    const ac = new AbortController()
    const tick = async () => {
      const res = await getBackendMetrics(ac.signal)
      if (alive) setM(res)
    }
    void tick()
    const id = setInterval(tick, 2000)
    return () => {
      alive = false
      ac.abort()
      clearInterval(id)
    }
  }, [])

  if (!m) return null
  const dev = m.vram.devices?.[0]
  const waiting = m.gpuGuard?.waiting ?? []
  const active = m.activeTasks ?? []

  return (
    <div className="mb-2 rounded bg-bg-2 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-text-3">
        <MemoryStick size={12} />
        <span>GPU memory & jobs</span>
      </div>

      {dev ? (
        <>
          <div className="mb-1 flex items-center justify-between font-mono text-[11px] text-text-2">
            <span className="truncate" title={dev.name}>
              {dev.usedMB} / {dev.totalMB} MB
            </span>
            <span className="text-text-3">{Math.round(dev.utilizationPct ?? 0)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-bg-3">
            <div
              className={`h-full ${barColor(dev.utilizationPct ?? 0)}`}
              style={{ width: `${Math.min(100, Math.max(0, dev.utilizationPct ?? 0))}%` }}
            />
          </div>
          <div className="mt-1 font-mono text-[11px] text-text-3">{dev.freeMB} MB free</div>
        </>
      ) : (
        <div className="font-mono text-[11px] text-text-3">
          {m.vram.available === false ? (m.vram.reason ?? 'CPU only') : 'n/a'}
        </div>
      )}

      {waiting.length > 0 && (
        <div className="mt-1.5 flex items-start gap-1 rounded bg-warning/10 p-1.5 text-[11px] text-warning">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          <span>
            GPU busy — {waiting.length} task{waiting.length === 1 ? '' : 's'} waiting for VRAM:{' '}
            {waiting.map((w) => `${w.kind} (${Math.round(w.waitingSec)}s)`).join(', ')}
          </span>
        </div>
      )}

      {active.length === 0 ? (
        <div className="mt-1.5 font-mono text-[11px] text-text-3">No active tasks</div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {active.map((t) => (
            <div key={`${t.kind}:${t.id}`}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="truncate text-text-2">
                  {t.label}
                  {t.step ? <span className="text-text-3"> · {t.step}</span> : null}
                </span>
                <span className="ml-2 shrink-0 font-mono text-text-3">{Math.round(t.pct)}%</span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-bg-3">
                <div
                  className="h-full bg-accent transition-[width] duration-500"
                  style={{ width: `${Math.min(100, Math.max(0, t.pct))}%` }}
                />
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-text-3">{fmtEta(t.etaSec)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CapRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-text-2">{label}</span>
      <span className={`flex items-center gap-1 ${ok ? 'text-success' : 'text-text-3'}`}>
        {ok ? <Check size={12} /> : <X size={12} />}
        {ok ? 'available' : 'off'}
      </span>
    </div>
  )
}

export function BackendStatus() {
  const [caps, recheck] = useBackendCapabilities()
  const proxyMode = useUIStore((s) => s.proxyMode)
  const setProxyMode = useUIStore((s) => s.setProxyMode)
  const [pinging, setPinging] = useState(false)
  const [open, setOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [zeroCopyOpen, setZeroCopyOpen] = useState(false)
  const [zeroCopyDiagnostics, setZeroCopyDiagnostics] =
    useState<ZeroCopyDiagnosticsComponent | null>(null)
  const [zeroCopyLoadError, setZeroCopyLoadError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const everOnlineRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Fixed-position anchor for the portalled panel (the top bar is overflow-hidden,
  // so an in-flow dropdown would be clipped at the header's bottom edge).
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  const online = caps !== null

  async function openZeroCopyDiagnostics(): Promise<void> {
    setOpen(false)
    setZeroCopyOpen(true)
    setZeroCopyLoadError(null)
    if (zeroCopyDiagnostics) return
    try {
      const module = await import('@components/settings/ZeroCopyDiagnostics')
      // A React component is itself a function, so wrap it to prevent the state
      // setter from treating it as an updater and invoking it outside React.
      setZeroCopyDiagnostics(() => module.ZeroCopyDiagnostics)
    } catch (reason) {
      setZeroCopyLoadError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => {
    if (online) everOnlineRef.current = true
  }, [online])

  // A direct browser stream can resume from its durable byte-range manifest,
  // but only if the local backend actually comes back. Once this session has
  // observed a healthy backend, supervise later offline transitions with an
  // abortable capped backoff. Initial setup/offline installs still use the
  // existing one-shot nudge and explicit setup UI below.
  useEffect(() => {
    if (!isDesktopShell() || online || !everOnlineRef.current) return
    const ac = new AbortController()
    void superviseBackendRestart({
      signal: ac.signal,
      start: startBackend,
      probe: async () => {
        clearCapabilitiesCache()
        return (await getCapabilities()) !== null
      },
      onRecovered: recheck,
    }).catch(() => {})
    return () => ac.abort()
  }, [online, recheck])

  // Anchor the portal panel just below the button, right-aligned to it.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Close the panel on outside click / Escape (the panel is portalled, so check
  // both the trigger and the panel).
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Keep the lazily-loaded diagnostics modal escapable even while its chunk is
  // still loading or has failed. A broken/slow local asset must not trap the UI.
  useEffect(() => {
    if (!zeroCopyOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setZeroCopyOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [zeroCopyOpen])

  async function handleRecheck() {
    if (pinging) return
    setPinging(true)
    await reprobeBackendRuntime()
    recheck()
    await new Promise((r) => setTimeout(r, 600)) // show the spinner briefly
    setPinging(false)
  }

  // Belt-and-suspenders auto-start: the native shell already spawns the backend
  // at launch, but if that ever didn't take (e.g. it ran once before the venv
  // existed), nudge it once a few seconds in so the user never has to start it by
  // hand. Idempotent on the Rust side — a no-op when one is already running.
  useEffect(() => {
    if (!isDesktopShell()) return
    const id = setTimeout(() => {
      if (!online) void handleStartBackend()
    }, 3500)
    return () => clearTimeout(id)
    // run once on mount; `online` read at fire time is fine for a one-shot nudge
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One-click start for the bundled backend (desktop) — no hand-running a .bat.
  // The backend takes ~10-30s to answer /health, so poll a few times.
  async function handleStartBackend() {
    if (starting) return
    setStarting(true)
    const ok = await startBackend()
    if (ok) {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2500))
        clearCapabilitiesCache()
        const caps = await getCapabilities()
        if (caps) {
          recheck() // sync the hook's state for the panel
          break
        }
      }
    }
    setStarting(false)
  }

  const enc = encoderInfo(caps?.runtime)
  const cuda = caps?.runtime?.cuda
  const statusLabel = online ? 'Backend online — click for system info' : 'Backend offline'

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={statusLabel}
        aria-label={statusLabel}
        aria-expanded={open}
        className="relative rounded p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
      >
        {pinging ? <RefreshCw size={15} className="animate-spin" /> : <Server size={15} />}
        <span
          className={`absolute right-0.5 top-0.5 h-2 w-2 rounded-full border-2 border-bg-1 transition-colors ${
            online ? 'bg-success' : 'bg-text-3'
          }`}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="z-[95] max-h-[calc(100vh-3.5rem)] w-64 overflow-auto rounded-md border border-border-strong bg-bg-1 p-3 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
          >
            {/* Header */}
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-medium text-text-1">
                <Server size={13} /> System
              </span>
              <span
                className={`flex items-center gap-1 ${online ? 'text-success' : 'text-text-3'}`}
              >
                <span className={`h-2 w-2 rounded-full ${online ? 'bg-success' : 'bg-text-3'}`} />
                {online ? 'online' : 'offline'}
              </span>
            </div>

            {online ? (
              <>
                {/* Video encoder */}
                <div className="mb-2 rounded bg-bg-2 p-2">
                  <div className="mb-1 flex items-center gap-1.5 text-text-3">
                    {enc.gpu ? <Zap size={12} /> : <Cpu size={12} />}
                    <span>Video encoder</span>
                  </div>
                  <div className={`font-mono ${enc.gpu ? 'text-success' : 'text-text-1'}`}>
                    {enc.text}
                  </div>
                </div>

                <div className="mb-2 rounded bg-bg-2 p-2">
                  <div className="mb-1 text-text-3">Runtime identity</div>
                  <div className="space-y-0.5 font-mono text-[10px] text-text-2">
                    <div>WebView {webViewRuntimeVersion(navigator.userAgent)}</div>
                    <div>Driver {caps?.runtime?.gpuDriver ?? 'unknown'}</div>
                    <div className="truncate" title={caps?.runtime?.ffmpeg?.version ?? undefined}>
                      {caps?.runtime?.ffmpeg?.version ?? 'FFmpeg detecting…'}
                    </div>
                  </div>
                </div>

                {/* GPU / CUDA */}
                <div className="mb-2 rounded bg-bg-2 p-2">
                  <div className="mb-1 flex items-center gap-1.5 text-text-3">
                    <Cpu size={12} />
                    <span>GPU compute (CUDA)</span>
                  </div>
                  <div className={`font-mono ${cuda?.available ? 'text-success' : 'text-text-2'}`}>
                    {cuda === undefined
                      ? 'n/a'
                      : cuda.probing
                        ? 'detecting…'
                        : cuda.available
                          ? `${cuda.device ?? 'available'}${cuda.loaded === false ? ' · idle' : ''}`
                          : 'CPU only'}
                  </div>
                </div>

                {/* Live VRAM + job queues (polls /metrics while open) */}
                <GpuMetricsSection />

                {/* Capabilities */}
                <div className="mb-2">
                  <div className="mb-1 text-text-3">Capabilities</div>
                  <CapRow label="Transcription (WhisperX)" ok={!!caps?.transcribe} />
                  <CapRow label="Vocal separation (Demucs)" ok={!!caps?.separate} />
                  <CapRow label="Server export (FFmpeg)" ok={!!caps?.export} />
                  <CapRow label="Media tools (FFmpeg)" ok={!!caps?.media} />
                </div>

                {/* Auto-proxy preference (preview proxies need server FFmpeg) */}
                <div className="mb-2">
                  <div className="mb-1 text-text-3">Auto preview proxy</div>
                  <div className="flex gap-1">
                    {PROXY_MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setProxyMode(m.id)}
                        title={m.hint}
                        className={`flex-1 rounded border py-1 ${
                          proxyMode === m.id
                            ? 'border-accent/40 bg-accent/15 text-accent'
                            : 'border-border-strong bg-bg-2 text-text-2 hover:bg-bg-3 hover:text-text-1'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="mb-2 text-text-2">
                  No backend connected. Transcription, vocal separation and server-side export run
                  on the optional local backend.
                </p>
                {isDesktopShell() && (
                  <div className="mb-2 flex flex-col gap-1.5">
                    <button
                      onClick={() => void handleStartBackend()}
                      disabled={starting}
                      className="flex w-full items-center justify-center gap-1.5 rounded border border-success/40 bg-success/15 py-1.5 text-success hover:bg-success/25 disabled:opacity-60"
                    >
                      {starting ? (
                        <>
                          <RefreshCw size={12} className="animate-spin" /> Starting…
                        </>
                      ) : (
                        <>
                          <Power size={12} /> Start backend
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => {
                        setOpen(false)
                        setSetupOpen(true)
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded border border-accent/40 bg-accent/15 py-1.5 text-accent hover:bg-accent/25"
                    >
                      <Sparkles size={12} /> Manage models
                    </button>
                  </div>
                )}
              </>
            )}

            {online && isDesktopShell() && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setSetupOpen(true)
                }}
                className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded border border-accent/40 bg-accent/15 py-1.5 text-accent hover:bg-accent/25"
              >
                <Sparkles size={12} /> Manage models
              </button>
            )}

            <button
              type="button"
              onClick={() => void openZeroCopyDiagnostics()}
              className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded border border-accent/30 bg-accent/10 py-1.5 text-accent hover:bg-accent/20"
            >
              <Gauge size={12} /> GPU zero-copy test
            </button>

            <button
              onClick={handleRecheck}
              disabled={pinging}
              className="flex w-full items-center justify-center gap-1.5 rounded border border-border-strong bg-bg-2 py-1.5 text-text-1 hover:bg-bg-3 disabled:opacity-50"
            >
              <RefreshCw size={12} className={pinging ? 'animate-spin' : ''} />
              {pinging ? 'Checking…' : 'Recheck'}
            </button>
          </div>,
          document.body,
        )}

      {setupOpen && <AiSetupWizard onClose={() => setSetupOpen(false)} onComplete={recheck} />}
      {zeroCopyOpen &&
        zeroCopyDiagnostics &&
        (() => {
          const Diagnostics = zeroCopyDiagnostics
          return (
            <Diagnostics
              gpuDriver={caps?.runtime?.gpuDriver}
              backendGpu={caps?.runtime?.cuda.device}
              onClose={() => setZeroCopyOpen(false)}
            />
          )
        })()}
      {zeroCopyOpen &&
        !zeroCopyDiagnostics &&
        createPortal(
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-6">
            <div className="relative w-full max-w-md rounded-lg border border-border-strong bg-bg-1 p-5 shadow-2xl">
              <button
                type="button"
                onClick={() => setZeroCopyOpen(false)}
                className="absolute right-3 top-3 rounded p-1 text-text-3 hover:bg-bg-3 hover:text-text-1"
                title="Close"
                aria-label="Close GPU diagnostics"
              >
                <X size={15} />
              </button>
              {zeroCopyLoadError ? (
                <>
                  <div className="flex items-start gap-2 text-danger">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <div>
                      <div className="font-medium">Unable to load GPU diagnostics</div>
                      <div className="mt-1 break-words text-xs text-text-3">
                        {zeroCopyLoadError}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setZeroCopyOpen(false)}
                      className="rounded border border-border px-3 py-1.5 text-xs text-text-2 hover:bg-bg-2"
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      onClick={() => void openZeroCopyDiagnostics()}
                      className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
                    >
                      Try again
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-text-2">
                  <RefreshCw size={15} className="animate-spin" />
                  Loading GPU diagnostics…
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
