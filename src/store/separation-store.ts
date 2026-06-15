/**
 * Global vocal/music separation state — lives outside PropertiesPanel so a
 * long-running Demucs job's progress survives tab switches and clip
 * re-selection (the panel re-renders but the store does not).
 *
 * Only one separation runs at a time; `clipId` ties the live progress to the
 * clip it was started from so the UI shows it on the right selection.
 */
import { create } from 'zustand'

interface SeparationStore {
  busy: boolean
  /** Source clip the current/last job was started from. */
  clipId: string | null
  pct: number
  error: string | null
  note: string | null

  start: (clipId: string) => void
  finish: () => void
  setPct: (pct: number) => void
  setError: (error: string | null) => void
  setNote: (note: string | null) => void
}

export const useSeparationStore = create<SeparationStore>((set) => ({
  busy: false,
  clipId: null,
  pct: 0,
  error: null,
  note: null,

  start: (clipId) => set({ busy: true, clipId, pct: 0, error: null, note: null }),
  finish: () => set({ busy: false }),
  setPct: (pct) => set({ pct }),
  setError: (error) => set({ error }),
  setNote: (note) => set({ note }),
}))
