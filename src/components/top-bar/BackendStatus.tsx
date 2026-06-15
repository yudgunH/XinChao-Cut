import { Server, RefreshCw, Cpu, Zap, Check, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useUIStore, type ProxyMode } from '@store/ui-store'
import type { BackendRuntime } from '@engine/backend'

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
  const wrapRef = useRef<HTMLDivElement>(null)

  const online = caps !== null

  // Close the panel on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
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

  async function handleRecheck() {
    if (pinging) return
    setPinging(true)
    recheck()
    await new Promise((r) => setTimeout(r, 600)) // show the spinner briefly
    setPinging(false)
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

      {open && (
        <div className="absolute right-0 top-full z-[80] mt-1 w-64 rounded-md border border-border-strong bg-bg-1 p-3 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
          {/* Header */}
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-medium text-text-1">
              <Server size={13} /> System
            </span>
            <span className={`flex items-center gap-1 ${online ? 'text-success' : 'text-text-3'}`}>
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

              {/* GPU / CUDA */}
              <div className="mb-2 rounded bg-bg-2 p-2">
                <div className="mb-1 flex items-center gap-1.5 text-text-3">
                  <Cpu size={12} />
                  <span>GPU compute (CUDA)</span>
                </div>
                <div className={`font-mono ${cuda?.available ? 'text-success' : 'text-text-2'}`}>
                  {cuda === undefined
                    ? 'n/a'
                    : cuda.available
                      ? (cuda.device ?? 'available')
                      : 'CPU only'}
                </div>
              </div>

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
            <p className="mb-2 text-text-2">
              No backend connected. Transcription, vocal separation and server-side
              export run on the optional local backend.
            </p>
          )}

          <button
            onClick={handleRecheck}
            disabled={pinging}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-border-strong bg-bg-2 py-1.5 text-text-1 hover:bg-bg-3 disabled:opacity-50"
          >
            <RefreshCw size={12} className={pinging ? 'animate-spin' : ''} />
            {pinging ? 'Checking…' : 'Recheck'}
          </button>
        </div>
      )}
    </div>
  )
}
