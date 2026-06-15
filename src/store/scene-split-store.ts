/**
 * Progress state for the in-flight scene-split detection job. Drives the
 * BackgroundTasks progress card so the user can see how far along detection is
 * (and cancel it) instead of staring at a frozen toast.
 */
import { create } from 'zustand'

interface SceneSplitStore {
  /** Backend job id while a detection is running, else null. */
  jobId: string | null
  /** 0..100 detection progress. */
  pct: number
  /** Name of the clip's source asset, for the card label. */
  assetName: string
  busy: boolean
  start: (assetName: string) => void
  setJob: (jobId: string) => void
  setPct: (pct: number) => void
  clear: () => void
}

export const useSceneSplitStore = create<SceneSplitStore>((set) => ({
  jobId: null,
  pct: 0,
  assetName: '',
  busy: false,
  start: (assetName) => set({ busy: true, pct: 0, jobId: null, assetName }),
  setJob: (jobId) => set({ jobId }),
  setPct: (pct) => set({ pct }),
  clear: () => set({ busy: false, pct: 0, jobId: null, assetName: '' }),
}))
