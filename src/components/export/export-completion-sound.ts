export interface ExportCompletionSound {
  /** Call from the Export button gesture so WebView autoplay policy permits playback later. */
  prime(): void
  /** Play one short, non-intrusive success chime. */
  play(): Promise<void>
  dispose(): void
}

/**
 * Small synthesized completion chime. Keeping it generated avoids another
 * asset/network dependency and gives this dialog ownership of its AudioContext.
 */
export function createExportCompletionSound(): ExportCompletionSound {
  let context: AudioContext | null = null

  const ensureContext = (): AudioContext | null => {
    if (context && context.state !== 'closed') return context
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null
    try {
      context = new window.AudioContext()
      return context
    } catch {
      return null
    }
  }

  return {
    prime() {
      const audio = ensureContext()
      if (audio?.state === 'suspended') void audio.resume().catch(() => {})
    },

    async play() {
      const audio = ensureContext()
      if (!audio) return
      try {
        if (audio.state === 'suspended') await audio.resume()
        if (audio.state !== 'running') return

        const start = audio.currentTime + 0.02
        const master = audio.createGain()
        master.gain.setValueAtTime(0.0001, start)
        // Roughly +7 dB over the original chime, while the overlapping notes
        // still remain comfortably below digital clipping.
        master.gain.exponentialRampToValueAtTime(0.36, start + 0.018)
        master.gain.setValueAtTime(0.36, start + 0.42)
        master.gain.exponentialRampToValueAtTime(0.0001, start + 0.62)
        master.connect(audio.destination)

        const notes = [
          { hz: 659.25, offset: 0, duration: 0.28 },
          { hz: 783.99, offset: 0.17, duration: 0.42 },
        ]
        notes.forEach((note, index) => {
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          const noteStart = start + note.offset
          const noteEnd = noteStart + note.duration
          oscillator.type = 'sine'
          oscillator.frequency.setValueAtTime(note.hz, noteStart)
          gain.gain.setValueAtTime(0.0001, noteStart)
          gain.gain.exponentialRampToValueAtTime(index === 0 ? 0.72 : 0.9, noteStart + 0.015)
          gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd)
          oscillator.connect(gain)
          gain.connect(master)
          oscillator.start(noteStart)
          oscillator.stop(noteEnd + 0.01)
          oscillator.addEventListener('ended', () => {
            oscillator.disconnect()
            gain.disconnect()
            if (index === notes.length - 1) master.disconnect()
          }, { once: true })
        })
      } catch {
        // Notification audio is best-effort and must never change export state.
      }
    },

    dispose() {
      const audio = context
      context = null
      if (audio && audio.state !== 'closed') void audio.close().catch(() => {})
    },
  }
}
