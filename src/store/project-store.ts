import { create } from 'zustand'

import type { MediaAsset } from '@engine/media/types'
import type { ProjectSnapshot } from '@engine/persistence/types'

export type SaveStatus = 'unsaved' | 'saving' | 'saved' | 'error'

export interface AspectRatio {
  w: number
  h: number
  label: string
}

export const ASPECT_RATIOS: AspectRatio[] = [
  { w: 16, h: 9, label: '16:9' },
  { w: 9, h: 16, label: '9:16' },
  { w: 1, h: 1, label: '1:1' },
  { w: 4, h: 5, label: '4:5' },
  { w: 4, h: 3, label: '4:3' },
  { w: 21, h: 9, label: '21:9' },
]

interface ProjectState {
  /** Id of the project currently open in the editor ('' = none / on Home). */
  id: string
  name: string
  assets: MediaAsset[]
  selectedAssetIds: string[]
  aspect: AspectRatio
  saveStatus: SaveStatus
  lastSavedAt: number | null
  /** Hydrate store identity from a loaded snapshot (id/name/aspect). */
  loadProject: (snapshot: ProjectSnapshot) => void
  setName: (name: string) => void
  setAssets: (assets: MediaAsset[]) => void
  addAsset: (asset: MediaAsset) => void
  updateAsset: (id: string, patch: Partial<MediaAsset>) => void
  removeAsset: (id: string) => void
  setSelectedAssetIds: (ids: string[]) => void
  setAspect: (a: AspectRatio) => void
  setSaveStatus: (s: SaveStatus) => void
  setLastSavedAt: (t: number) => void
}

function uniqueAssetIds(ids: string[]): string[] {
  return Array.from(new Set(ids))
}

function filterExistingAssetIds(ids: string[], assets: MediaAsset[]): string[] {
  const existing = new Set(assets.map((asset) => asset.id))
  return uniqueAssetIds(ids).filter((id) => existing.has(id))
}

export const useProjectStore = create<ProjectState>((set) => ({
  id: '',
  name: 'Untitled Project',
  assets: [],
  selectedAssetIds: [],
  aspect: ASPECT_RATIOS[0]!,
  saveStatus: 'unsaved',
  lastSavedAt: null,
  loadProject: (snapshot) =>
    set({
      id: snapshot.id ?? '',
      name: snapshot.name,
      aspect: ASPECT_RATIOS.find((a) => a.label === snapshot.aspect) ?? ASPECT_RATIOS[0]!,
      saveStatus: 'saved',
      lastSavedAt: snapshot.updatedAt,
    }),
  setName: (name) => set({ name, saveStatus: 'unsaved' }),
  setAssets: (assets) =>
    set((s) => ({
      assets,
      selectedAssetIds: filterExistingAssetIds(s.selectedAssetIds, assets),
    })),
  addAsset: (asset) =>
    set((s) => (s.assets.some((a) => a.id === asset.id) ? s : { assets: [asset, ...s.assets] })),
  updateAsset: (id, patch) =>
    set((s) => ({ assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  removeAsset: (id) =>
    set((s) => ({
      assets: s.assets.filter((a) => a.id !== id),
      selectedAssetIds: s.selectedAssetIds.filter((assetId) => assetId !== id),
    })),
  setSelectedAssetIds: (ids) =>
    set((s) => ({ selectedAssetIds: filterExistingAssetIds(ids, s.assets) })),
  setAspect: (aspect) => set({ aspect }),
  setSaveStatus: (saveStatus) => set({ saveStatus }),
  setLastSavedAt: (lastSavedAt) => set({ lastSavedAt }),
}))
