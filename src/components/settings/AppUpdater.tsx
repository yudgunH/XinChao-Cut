import { AlertTriangle, CheckCircle2, Download, RefreshCw, X } from 'lucide-react'
import { useEffect } from 'react'

import { updatePercent, useUpdaterStore } from '@store/updater-store'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Global automatic checker and compact update notification. */
export function AppUpdater() {
  const phase = useUpdaterStore((state) => state.phase)
  const version = useUpdaterStore((state) => state.availableVersion)
  const notes = useUpdaterStore((state) => state.releaseNotes)
  const downloaded = useUpdaterStore((state) => state.downloaded)
  const total = useUpdaterStore((state) => state.total)
  const message = useUpdaterStore((state) => state.message)
  const popupVisible = useUpdaterStore((state) => state.popupVisible)
  const initialize = useUpdaterStore((state) => state.initialize)
  const checkNow = useUpdaterStore((state) => state.checkNow)
  const install = useUpdaterStore((state) => state.install)
  const dismiss = useUpdaterStore((state) => state.dismissPopup)

  useEffect(() => {
    void initialize()
    const initial = window.setTimeout(() => void checkNow({ silent: true }), 5_000)
    const interval = window.setInterval(
      () => void checkNow({ silent: true }),
      CHECK_INTERVAL_MS,
    )
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
    }
  }, [checkNow, initialize])

  if (!popupVisible || !['available', 'downloading', 'ready', 'error'].includes(phase)) {
    return null
  }

  const downloading = phase === 'downloading'
  const downloadedPct = updatePercent(downloaded, total)

  return (
    <div className="fixed bottom-5 right-5 z-[125] w-[min(390px,calc(100vw-40px))] rounded-lg border border-border-strong bg-bg-1 p-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 rounded-full p-2 ${
            phase === 'error' ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent'
          }`}
        >
          {phase === 'error' ? (
            <AlertTriangle size={17} />
          ) : phase === 'ready' ? (
            <CheckCircle2 size={17} />
          ) : downloading ? (
            <RefreshCw size={17} className="animate-spin" />
          ) : (
            <Download size={17} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text-1">
            {phase === 'error'
              ? 'Update failed'
              : phase === 'ready'
                ? 'Update downloaded'
                : downloading
                  ? `Downloading XinChao-Cut ${version ?? ''}`
                  : `XinChao-Cut ${version ?? ''} is available`}
          </div>
          <div className="mt-1 max-h-24 overflow-auto text-xs leading-relaxed text-text-3">
            {phase === 'error'
              ? message
              : phase === 'ready'
                ? message
                : downloading
                  ? total
                    ? `${downloadedPct}% · ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
                    : `${(downloaded / 1024 / 1024).toFixed(1)} MB`
                  : notes || 'A new signed release is ready on GitHub.'}
          </div>
          {downloading && (
            <div className="mt-3 h-1.5 overflow-hidden rounded bg-bg-3">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${downloadedPct}%` }}
              />
            </div>
          )}
          {(phase === 'available' || phase === 'error') && version && (
            <button
              type="button"
              onClick={() => void install()}
              className="mt-3 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              {phase === 'error' ? 'Try again' : 'Update and restart'}
            </button>
          )}
        </div>
        {!downloading && (
          <button
            type="button"
            onClick={dismiss}
            className="rounded p-1 text-text-3 hover:bg-bg-3 hover:text-text-1"
            title="Remind me later"
            aria-label="Remind me later"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
