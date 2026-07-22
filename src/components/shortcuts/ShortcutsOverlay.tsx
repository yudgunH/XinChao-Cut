import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'

import {
  SHORTCUT_ACTIONS,
  shortcutFromEvent,
  useShortcutStore,
  type ShortcutActionId,
} from '@store/shortcut-store'

interface ShortcutsOverlayProps {
  onClose: () => void
}

const GROUPS = ['Playback', 'Editing', 'Clipboard', 'Timeline'] as const

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const shortcuts = useShortcutStore((s) => s.shortcuts)
  const setShortcut = useShortcutStore((s) => s.setShortcut)
  const resetShortcut = useShortcutStore((s) => s.resetShortcut)
  const resetAllShortcuts = useShortcutStore((s) => s.resetAllShortcuts)
  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null)

  const usedByShortcut = useMemo(() => {
    const map = new Map<string, ShortcutActionId>()
    for (const action of SHORTCUT_ACTIONS) {
      const shortcut = shortcuts[action.id]
      if (shortcut) map.set(shortcut, action.id)
    }
    return map
  }, [shortcuts])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!recordingId) {
        if (e.key === 'Escape') onClose()
        return
      }

      e.preventDefault()
      e.stopPropagation()
      const shortcut = shortcutFromEvent(e)
      if (!shortcut) return
      setShortcut(recordingId, shortcut)
      setRecordingId(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recordingId, setShortcut, onClose])

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-[760px] flex-col overflow-hidden rounded-lg bg-bg-1 shadow-e3 ring-1 ring-border-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text-1">Keyboard Shortcuts</h2>
            <p className="mt-0.5 text-2xs text-text-3">
              Click a shortcut, then press the new key combination.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={resetAllShortcuts}
              className="flex h-7 items-center gap-1 rounded border border-border bg-bg-2 px-2 text-2xs text-text-2 hover:bg-bg-3 hover:text-text-1"
              aria-label="Reset all shortcuts"
            >
              <RotateCcw size={12} />
              Reset all
            </button>
            <button
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded text-text-2 hover:bg-bg-3 hover:text-text-1"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="grid gap-4">
            {GROUPS.map((group) => (
              <section key={group}>
                <p className="mb-2 text-2xs font-semibold uppercase text-text-3">{group}</p>
                <div className="overflow-hidden rounded border border-border">
                  <div className="grid grid-cols-[1.2fr_1.6fr_170px_42px] border-b border-border bg-bg-2 px-3 py-1.5 text-2xs font-semibold uppercase text-text-3">
                    <span>Action</span>
                    <span>Description</span>
                    <span>Shortcut</span>
                    <span />
                  </div>
                  {SHORTCUT_ACTIONS.filter((action) => action.group === group).map((action) => {
                    const shortcut = shortcuts[action.id]
                    const conflictId = shortcut ? usedByShortcut.get(shortcut) : null
                    const hasConflict = !!conflictId && conflictId !== action.id
                    const recording = recordingId === action.id

                    return (
                      <div
                        key={action.id}
                        className="grid grid-cols-[1.2fr_1.6fr_170px_42px] items-center border-b border-border/70 px-3 py-2 last:border-b-0"
                      >
                        <span className="text-xs font-medium text-text-1">{action.label}</span>
                        <span className="text-xs text-text-2">{action.description}</span>
                        <button
                          onClick={() => setRecordingId(action.id)}
                          className={`min-w-0 rounded border px-2 py-1 text-left font-mono text-2xs ${
                            recording
                              ? 'border-accent bg-accent/15 text-accent'
                              : hasConflict
                                ? 'border-danger/60 bg-danger/10 text-danger'
                                : 'border-border bg-bg-2 text-text-1 hover:border-border-strong hover:bg-bg-3'
                          }`}
                        >
                          {recording ? 'Press keys...' : shortcut || 'Unassigned'}
                        </button>
                        <button
                          onClick={() => resetShortcut(action.id)}
                          className="grid h-7 w-7 place-items-center rounded text-text-3 hover:bg-bg-3 hover:text-text-1"
                          title="Reset shortcut"
                          aria-label={`Reset ${action.label}`}
                        >
                          <RotateCcw size={13} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="shrink-0 border-t border-border px-4 py-2.5 text-2xs text-text-3">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <img
                src="/logo.png"
                alt="XinChao-Cut"
                className="h-5 w-5 rounded"
                draggable={false}
              />
              <span>
                XinChao-Cut · Owner <span className="font-medium text-text-2">Nguyễn Duy Hưng</span>
              </span>
            </span>
            <span>
              Duplicate shortcuts are cleared automatically. Press{' '}
              <kbd className="font-mono">Esc</kbd> to close.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
