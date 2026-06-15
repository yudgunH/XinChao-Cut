import { createPortal } from 'react-dom'
import { AudioLines, Scissors, Zap, Loader2, X, CheckCircle2, AlertCircle, Info } from 'lucide-react'

import { cancelVocalSeparation } from '@engine/audio/separation-runner'
import { cancelSceneSplit } from '@engine/media/scene-split-runner'
import { useProjectStore } from '@store/project-store'
import { useProxyStore } from '@store/proxy-store'
import { useSceneSplitStore } from '@store/scene-split-store'
import { useSeparationStore } from '@store/separation-store'
import { useToastStore, type ToastKind } from '@store/toast-store'

/**
 * Bottom-right overlay showing background work that has no inline progress of
 * its own — vocal/music separation and preview-proxy generation — plus
 * transient toasts. Portaled to body so it floats above panels.
 */
export function BackgroundTasks() {
  const sep = useSeparationStore()
  const proxyStatus = useProxyStore((s) => s.status)
  const sceneSplit = useSceneSplitStore()
  const assets = useProjectStore((s) => s.assets)
  const toasts = useToastStore((s) => s.toasts)
  const dismissToast = useToastStore((s) => s.dismiss)

  const runningProxies = Object.entries(proxyStatus).filter(([, p]) => p.state === 'running')

  const nothing =
    !sep.busy && !sceneSplit.busy && runningProxies.length === 0 && toasts.length === 0
  if (nothing) return null

  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? 'media'

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[85] flex w-72 flex-col gap-2">
      {/* Vocal/music separation */}
      {sep.busy && (
        <div className="pointer-events-auto rounded-lg border border-border bg-bg-2 p-3 shadow-e3">
          <div className="mb-2 flex items-center gap-2">
            <AudioLines size={14} className="text-accent" />
            <span className="flex-1 text-xs font-medium text-text-1">Tách giọng &amp; nhạc</span>
            <button
              onClick={cancelVocalSeparation}
              className="rounded p-0.5 text-text-3 hover:bg-bg-3 hover:text-danger"
              title="Hủy"
            >
              <X size={13} />
            </button>
          </div>
          <ProgressBar pct={sep.pct} />
          <p className="mt-1 text-right text-2xs tabular-nums text-text-3">{Math.round(sep.pct)}%</p>
        </div>
      )}

      {/* Scene-split detection */}
      {sceneSplit.busy && (
        <div className="pointer-events-auto rounded-lg border border-border bg-bg-2 p-3 shadow-e3">
          <div className="mb-2 flex items-center gap-2">
            <Scissors size={14} className="text-accent" />
            <span className="flex-1 truncate text-xs font-medium text-text-1" title={sceneSplit.assetName}>
              Tách cảnh{sceneSplit.assetName ? ` · ${sceneSplit.assetName}` : ''}
            </span>
            <button
              onClick={() => void cancelSceneSplit()}
              className="rounded p-0.5 text-text-3 hover:bg-bg-3 hover:text-danger"
              title="Hủy"
            >
              <X size={13} />
            </button>
          </div>
          <ProgressBar pct={sceneSplit.pct} />
          <p className="mt-1 text-right text-2xs tabular-nums text-text-3">
            {Math.round(sceneSplit.pct)}%
          </p>
        </div>
      )}

      {/* Preview proxies */}
      {runningProxies.map(([id, p]) => (
        <div key={id} className="pointer-events-auto rounded-lg border border-border bg-bg-2 p-3 shadow-e3">
          <div className="mb-2 flex items-center gap-2">
            <Zap size={14} className="text-accent" />
            <span className="flex-1 truncate text-xs font-medium text-text-1" title={nameOf(id)}>
              Proxy · {nameOf(id)}
            </span>
            <Loader2 size={13} className="animate-spin text-text-3" />
          </div>
          <ProgressBar pct={p.pct} />
          <p className="mt-1 text-right text-2xs tabular-nums text-text-3">{Math.round(p.pct)}%</p>
        </div>
      ))}

      {/* Transient toasts */}
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismissToast(t.id)}
          className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-3 py-2 text-left shadow-e3"
        >
          <ToastIcon kind={t.kind} />
          <span className="text-xs text-text-1">{t.message}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${Math.max(3, Math.round(pct))}%` }}
      />
    </div>
  )
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') return <CheckCircle2 size={14} className="shrink-0 text-success" />
  if (kind === 'error') return <AlertCircle size={14} className="shrink-0 text-danger" />
  return <Info size={14} className="shrink-0 text-accent" />
}
