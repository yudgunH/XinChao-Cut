import { create } from 'zustand'

interface PlaybackState {
  isPlaying: boolean
  currentSec: number
  /** Bumped only on user-initiated seeks (drag playhead, click ruler, skip).
   *  RAF advance via tick() does NOT bump it, so consumers can tell a real
   *  jump apart from natural playback progress. */
  seekNonce: number
  volume: number
  play: () => void
  pause: () => void
  toggle: () => void
  /** User-initiated jump — bumps seekNonce so playback/audio re-sync. */
  seek: (sec: number) => void
  /** RAF playback advance — updates time without signalling a seek. */
  tick: (sec: number) => void
  setVolume: (v: number) => void
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  isPlaying: false,
  currentSec: 0,
  seekNonce: 0,
  volume: 1,
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),
  seek: (currentSec) => set((s) => ({ currentSec, seekNonce: s.seekNonce + 1 })),
  tick: (currentSec) => set({ currentSec }),
  setVolume: (volume) => set({ volume }),
}))
