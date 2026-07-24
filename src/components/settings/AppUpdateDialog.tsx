import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { updatePercent, useUpdaterStore } from '@store/updater-store'

export function AppUpdateDialog({ onClose }: { onClose: () => void }) {
  const phase = useUpdaterStore((state) => state.phase)
  const currentVersion = useUpdaterStore((state) => state.currentVersion)
  const availableVersion = useUpdaterStore((state) => state.availableVersion)
  const releaseNotes = useUpdaterStore((state) => state.releaseNotes)
  const downloaded = useUpdaterStore((state) => state.downloaded)
  const total = useUpdaterStore((state) => state.total)
  const checkedAt = useUpdaterStore((state) => state.checkedAt)
  const message = useUpdaterStore((state) => state.message)
  const initialize = useUpdaterStore((state) => state.initialize)
  const checkNow = useUpdaterStore((state) => state.checkNow)
  const install = useUpdaterStore((state) => state.install)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const busy = phase === 'checking' || phase === 'downloading'
  const pct = updatePercent(downloaded, total)

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 p-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-[520px] max-w-full overflow-hidden rounded-xl bg-bg-1 shadow-e3 ring-1 ring-border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-1">
              <RefreshCw size={15} className="text-accent" /> Version &amp; Updates
            </h2>
            <p className="mt-0.5 text-2xs text-text-3">
              Signed updates are downloaded directly from GitHub Releases.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between rounded-lg bg-bg-2/50 px-4 py-3 ring-1 ring-border">
            <div>
              <p className="text-2xs text-text-3">Installed version</p>
              <p className="mt-0.5 text-base font-semibold text-text-1">
                {currentVersion ? `XinChao-Cut ${currentVersion}` : 'Reading version…'}
              </p>
            </div>
            <ShieldCheck size={28} className="text-success" />
          </div>

          {phase === 'available' && (
            <div className="rounded-lg border border-accent/35 bg-accent/10 p-3.5">
              <p className="flex items-center gap-2 text-xs font-semibold text-text-1">
                <Download size={14} className="text-accent" /> Version {availableVersion} is
                available
              </p>
              <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-2xs leading-relaxed text-text-2">
                {releaseNotes || 'A new update is ready.'}
              </p>
            </div>
          )}

          {phase === 'downloading' && (
            <div className="rounded-lg bg-bg-2/50 p-3.5 ring-1 ring-border">
              <div className="flex items-center justify-between text-xs text-text-2">
                <span>Downloading version {availableVersion}</span>
                <span>
                  {total ? `${pct}%` : `${(downloaded / 1024 / 1024).toFixed(1)} MB`}
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded bg-bg-3">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}

          {(phase === 'up-to-date' || phase === 'ready') && (
            <p className="flex items-start gap-2 rounded-lg bg-success/10 p-3 text-xs text-success ring-1 ring-success/25">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              {message || 'You are using the latest version.'}
            </p>
          )}

          {phase === 'error' && (
            <p className="flex items-start gap-2 rounded-lg bg-danger/10 p-3 text-xs text-danger ring-1 ring-danger/25">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {message}
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="text-2xs text-text-3">
              {checkedAt
                ? `Last checked: ${new Date(checkedAt).toLocaleString('en-US')}`
                : 'Not checked in this session'}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void checkNow()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-bg-3 px-3 py-2 text-xs text-text-1 hover:bg-bg-4 disabled:opacity-40"
              >
                {phase === 'checking' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                Check now
              </button>
              {availableVersion && (phase === 'available' || phase === 'error') && (
                <button
                  type="button"
                  onClick={() => void install()}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  <Download size={13} /> Update
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
