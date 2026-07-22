import { create } from 'zustand'

/** A pending CapCut-style "Replace" request: swap the source of `clipId` with
 *  the media `assetId`. Set when a longer asset is dropped onto a clip; the
 *  ReplaceDialog reads it and lets the user pick the in-point before applying. */
interface ReplaceRequest {
  clipId: string
  assetId: string
}

interface ReplaceState {
  request: ReplaceRequest | null
  openReplace: (clipId: string, assetId: string) => void
  closeReplace: () => void
}

export const useReplaceStore = create<ReplaceState>((set) => ({
  request: null,
  openReplace: (clipId, assetId) => set({ request: { clipId, assetId } }),
  closeReplace: () => set({ request: null }),
}))
