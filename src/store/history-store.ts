import { create } from 'zustand'

interface HistoryEntry {
  id: string
  label: string
  timestamp: number
}

interface HistoryState {
  past: HistoryEntry[]
  future: HistoryEntry[]
  canUndo: boolean
  canRedo: boolean
  push: (entry: HistoryEntry) => void
  undo: () => HistoryEntry | null
  redo: () => HistoryEntry | null
  clear: () => void
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,
  push: (entry) =>
    set((s) => ({
      past: [...s.past, entry],
      future: [],
      canUndo: true,
      canRedo: false,
    })),
  undo: () => {
    const { past, future } = get()
    const last = past[past.length - 1]
    if (!last) return null
    set({
      past: past.slice(0, -1),
      future: [last, ...future],
      canUndo: past.length > 1,
      canRedo: true,
    })
    return last
  },
  redo: () => {
    const { past, future } = get()
    const next = future[0]
    if (!next) return null
    set({
      past: [...past, next],
      future: future.slice(1),
      canUndo: true,
      canRedo: future.length > 1,
    })
    return next
  },
  clear: () => set({ past: [], future: [], canUndo: false, canRedo: false }),
}))
