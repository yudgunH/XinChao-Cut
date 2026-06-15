/**
 * Tiny transient-toast store for one-shot feedback (e.g. "noise reduction on",
 * "vocals separated"). Toasts auto-dismiss after a few seconds.
 */
import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
}

interface ToastStore {
  toasts: Toast[]
  push: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

let _nextId = 1
const LIFETIME_MS = 2800

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (message, kind = 'info') => {
    const id = _nextId++
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => get().dismiss(id), LIFETIME_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
