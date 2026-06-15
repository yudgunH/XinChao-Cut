/**
 * Per-asset preview-proxy generation status, keyed by asset id. Drives the
 * MediaCard badge and prevents starting a second job for the same asset.
 */
import { create } from 'zustand'

export type ProxyState = 'running' | 'done' | 'error'

export interface ProxyEntry {
  pct: number
  state: ProxyState
  error?: string
}

interface ProxyStore {
  status: Record<string, ProxyEntry>
  set: (assetId: string, entry: ProxyEntry) => void
  clear: (assetId: string) => void
}

export const useProxyStore = create<ProxyStore>((set) => ({
  status: {},
  set: (assetId, entry) => set((s) => ({ status: { ...s.status, [assetId]: entry } })),
  clear: (assetId) =>
    set((s) => {
      const next = { ...s.status }
      delete next[assetId]
      return { status: next }
    }),
}))
