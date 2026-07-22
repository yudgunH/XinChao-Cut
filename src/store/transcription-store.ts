/**
 * Global transcription state — lives outside CaptionsPanel so progress,
 * model selection, and language setting all survive tab switches
 * (the panel unmounts but the store does not).
 */
import { create } from 'zustand'
import type { TranscribeProgress } from '@engine/subtitle/transcribe'

// Keep in sync with CaptionsPanel.tsx constants.
// Default to server model; the panel's effect will downgrade to browser if
// the backend is confirmed offline on first poll.
const DEFAULT_MODEL    = 'large-v3'
const DEFAULT_LANGUAGE = 'auto'

interface TranscriptionStore {
  busy:        boolean
  progress:    TranscribeProgress | null
  clipLabel:   string | null
  error:       string | null
  note:        string | null
  startTimeMs: number
  elapsedMs:   number

  /** Selected ASR model id. Stored globally so tab switches don't reset it. */
  model:    string
  /** Selected language code (or 'auto'). */
  language: string
  /** Backend ASR routing. Auto uses FunASR only when Chinese is selected. */
  provider: 'auto' | 'whisperx' | 'funasr'

  /** Call when transcription starts. Kicks off the elapsed-time ticker. */
  start: () => void
  /** Call when transcription ends (success, error, or cancel). */
  finish: () => void
  setProgress:  (p:     TranscribeProgress | null) => void
  setClipLabel: (label: string | null) => void
  setError:     (err:   string | null) => void
  setNote:      (note:  string | null) => void
  setModel:     (model: string)        => void
  setLanguage:  (lang:  string)        => void
  setProvider:  (provider: 'auto' | 'whisperx' | 'funasr') => void
}

// Module-level timer — keeps ticking even when the panel is unmounted.
let _ticker: ReturnType<typeof setInterval> | null = null

export const useTranscriptionStore = create<TranscriptionStore>((set, get) => ({
  busy:        false,
  progress:    null,
  clipLabel:   null,
  error:       null,
  note:        null,
  startTimeMs: 0,
  elapsedMs:   0,
  model:       DEFAULT_MODEL,
  language:    DEFAULT_LANGUAGE,
  provider:    'auto',

  start() {
    const startTimeMs = Date.now()
    set({ busy: true, startTimeMs, elapsedMs: 0, error: null, note: null, progress: null, clipLabel: null })
    if (_ticker) clearInterval(_ticker)
    _ticker = setInterval(() => set({ elapsedMs: Date.now() - get().startTimeMs }), 1000)
  },

  finish() {
    if (_ticker) { clearInterval(_ticker); _ticker = null }
    set({ busy: false, progress: null, clipLabel: null })
  },

  setProgress:  (progress)  => set({ progress }),
  setClipLabel: (clipLabel) => set({ clipLabel }),
  setError:     (error)     => set({ error }),
  setNote:      (note)      => set({ note }),
  setModel:     (model)     => set({ model }),
  setLanguage:  (language)  => set({ language }),
  setProvider:  (provider)  => set({ provider }),
}))

/**
 * Caption-translation state — same reason as above: a multi-minute translate
 * run must survive the CaptionsPanel unmounting (left-tab switch). Only UI
 * state lives here; the AbortController stays module-level in the panel.
 */
interface CaptionTranslationStore {
  translating: boolean
  progress:    { stage: string; pct: number }
  error:       string | null

  start:       () => void
  finish:      () => void
  setProgress: (p: { stage: string; pct: number }) => void
  setError:    (err: string | null) => void
}

export const useCaptionTranslationStore = create<CaptionTranslationStore>((set) => ({
  translating: false,
  progress:    { stage: 'queued', pct: 0 },
  error:       null,

  start:  () => set({ translating: true, error: null, progress: { stage: 'queued', pct: 0 } }),
  finish: () => set({ translating: false }),
  setProgress: (progress) => set({ progress }),
  setError:    (error)    => set({ error }),
}))
