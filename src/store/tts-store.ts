/**
 * Global text-to-speech state — lives outside VoicePanel so the in-progress
 * "read captions aloud" run, the typed text, and the voice/speed selection all
 * survive tab switches (the panel unmounts but the store does not).
 */
import { create } from 'zustand'

import type { CaptionVoiceMode } from '@engine/audio/tts-runner'

const DEFAULT_VOICE_KEY = 'xinchao.tts.defaultVoice'

function readDefaultVoice(): string {
  try {
    return window.localStorage.getItem(DEFAULT_VOICE_KEY) ?? ''
  } catch {
    return ''
  }
}

interface TtsStore {
  /** True while a synthesis (single text or caption batch) is running. */
  busy: boolean
  /** Caption-batch progress; null for single-text synthesis. */
  progress: { done: number; total: number } | null
  error: string | null
  note: string | null

  /** Free-text input (persisted across tab switches). */
  text: string
  /** Selected voice-design preset id, or "clone". */
  voice: string
  /** Speech speed multiplier (1 = normal, >1 faster, <1 slower). */
  speed: number
  /** Caption voiceover placement: timeline-aligned or seamless back-to-back. */
  captionMode: CaptionVoiceMode
  /** Preferred voice id, auto-selected when the panel loads (persisted). */
  defaultVoiceId: string
  /** Whether the top-level Voice Studio overlay (Home) is open. */
  studioOpen: boolean

  setBusy: (busy: boolean) => void
  setStudioOpen: (open: boolean) => void
  setProgress: (progress: { done: number; total: number } | null) => void
  setError: (error: string | null) => void
  setNote: (note: string | null) => void
  setText: (text: string) => void
  setVoice: (voice: string) => void
  setSpeed: (speed: number) => void
  setCaptionMode: (mode: CaptionVoiceMode) => void
  setDefaultVoice: (id: string) => void
}

export const useTtsStore = create<TtsStore>((set) => ({
  busy: false,
  progress: null,
  error: null,
  note: null,
  text: '',
  voice: '',
  speed: 1,
  captionMode: 'timeline',
  defaultVoiceId: readDefaultVoice(),
  studioOpen: false,

  setBusy: (busy) => set({ busy }),
  setStudioOpen: (studioOpen) => set({ studioOpen }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setNote: (note) => set({ note }),
  setText: (text) => set({ text }),
  setVoice: (voice) => set({ voice }),
  setSpeed: (speed) => set({ speed }),
  setCaptionMode: (captionMode) => set({ captionMode }),
  setDefaultVoice: (defaultVoiceId) => {
    try {
      window.localStorage.setItem(DEFAULT_VOICE_KEY, defaultVoiceId)
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
    set({ defaultVoiceId })
  },
}))
