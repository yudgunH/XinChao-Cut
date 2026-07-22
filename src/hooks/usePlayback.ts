import { useEffect, useRef } from 'react'

import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'

/**
 * RAF-based playback engine. Mount once at app root (App.tsx).
 *
 * Uses an absolute time anchor (performance.now() at play-press) so playback
 * speed is always 1:1 with real wall-clock time, regardless of how frequently
 * the browser fires requestAnimationFrame callbacks.
 */
export function usePlayback(): void {
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const isBuffering = usePlaybackStore((s) => s.isBuffering)
  const seekNonce = usePlaybackStore((s) => s.seekNonce)
  const tick = usePlaybackStore((s) => s.tick)
  const pause = usePlaybackStore((s) => s.pause)

  // Always-fresh refs — updated outside RAF closure to avoid stale captures
  const currentSecRef = useRef(0)
  const durationRef = useRef(0)

  useEffect(
    () =>
      usePlaybackStore.subscribe((s) => {
        currentSecRef.current = s.currentSec
      }),
    [],
  )

  useEffect(
    () =>
      useTimelineStore.subscribe((s) => {
        durationRef.current = s.timeline.durationSec
      }),
    [],
  )

  // Re-anchors whenever playback starts OR the user seeks while playing
  // (seekNonce in deps), so scrubbing mid-playback resumes from the new spot.
  useEffect(() => {
    if (!isPlaying || isBuffering) return

    const startRealMs = performance.now()
    const startPlaySec = currentSecRef.current

    let rafId = 0

    function frame() {
      const elapsed = (performance.now() - startRealMs) / 1000
      const next = startPlaySec + elapsed
      const dur = durationRef.current

      if (dur > 0 && next >= dur) {
        tick(dur)
        pause()
        return // do NOT schedule next frame
      }

      tick(next)
      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, isBuffering, seekNonce, tick, pause])
}
