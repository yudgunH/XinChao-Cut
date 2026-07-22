import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { Play, Square } from 'lucide-react'

import { AudioDecodeTooLargeError } from '@engine/audio/decode-guard'
import { decodeForTrim, fmtTime, sliceToWav, suggestSelection, type DecodedSample } from '@engine/audio/trim-sample'

/** Read a CSS custom property off :root so the canvas matches the app theme. */
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export interface AudioTrimmerHandle {
  /** Cut the current selection into a WAV blob (and its length in seconds). */
  getSelection: () => { blob: Blob; durationSec: number } | null
}

interface Props {
  /** The picked audio file to decode and trim. */
  file: Blob
  /** Hard cap on the selection length (seconds). */
  maxSec?: number
  /** Notified whenever decode finishes / selection changes (for parent's "next" gating). */
  onReady?: (ready: boolean) => void
}

type Drag = 'start' | 'end' | 'move' | null

/**
 * Waveform + draggable selection for trimming a voice-clone sample. Lets the user
 * listen to the whole file or just the selected segment, and hard-caps the
 * selection to `maxSec` (the backend's clone-prompt VRAM limit). The parent reads
 * the trimmed WAV via the imperative `getSelection()` handle.
 */
export const AudioTrimmer = forwardRef<AudioTrimmerHandle, Props>(function AudioTrimmer(
  { file, maxSec = 10, onReady },
  ref,
) {
  const [sample, setSample] = useState<DecodedSample | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<[number, number]>([0, 0])
  const [playing, setPlaying] = useState<'sel' | 'all' | null>(null)
  const [playhead, setPlayhead] = useState<number | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag>(null)
  const dragOffsetRef = useRef(0)
  const srcRef = useRef<AudioBufferSourceNode | null>(null)
  const acRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)

  // ── Decode on file change ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setSample(null)
    setError(null)
    onReady?.(false)
    decodeForTrim(file)
      .then((s) => {
        if (cancelled) return
        setSample(s)
        setSel(suggestSelection(s.peaks, s.durationSec, maxSec))
        onReady?.(true)
      })
      .catch((e) => {
        if (cancelled) return
        // An oversized/over-long file gets a specific, actionable message from
        // the decode guard instead of a misleading "can't read this file".
        setError(
          e instanceof AudioDecodeTooLargeError
            ? 'File quá lớn/dài để cắt trong trình duyệt. Cắt sẵn một đoạn ngắn (≤ vài phút) rồi tải lên.'
            : 'Không đọc được file audio này. Thử file .wav/.mp3 khác.',
        )
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, maxSec])

  const stop = useCallback(() => {
    if (srcRef.current) {
      try {
        srcRef.current.onended = null
        srcRef.current.stop()
      } catch {
        /* already stopped */
      }
      srcRef.current = null
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setPlaying(null)
    setPlayhead(null)
  }, [])

  // Stop playback and release the per-trimmer audio device/context on unmount.
  useEffect(
    () => () => {
      stop()
      const ac = acRef.current
      acRef.current = null
      if (ac && ac.state !== 'closed') void ac.close()
    },
    [stop],
  )

  useImperativeHandle(
    ref,
    () => ({
      getSelection: () => {
        if (!sample) return null
        const [a, b] = sel
        if (b - a < 0.3) return null
        return { blob: sliceToWav(sample.buffer, a, b), durationSec: b - a }
      },
    }),
    [sample, sel],
  )

  // ── Draw waveform + selection ────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const s = sample
    if (!canvas || !s) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const peaks = s.peaks
    const n = peaks.length
    const mid = h / 2
    const barW = w / n
    const dim = cssVar('--text-3', '#71717a')
    const accent = cssVar('--accent', '#4f9cf9')
    const [a, b] = sel
    const selX0 = (a / s.durationSec) * w
    const selX1 = (b / s.durationSec) * w

    for (let i = 0; i < n; i++) {
      const x = i * barW
      const amp = Math.max(0.02, peaks[i]!) * (mid - 2)
      const inside = x + barW / 2 >= selX0 && x + barW / 2 <= selX1
      ctx.fillStyle = inside ? accent : dim
      ctx.globalAlpha = inside ? 0.95 : 0.4
      ctx.fillRect(x, mid - amp, Math.max(1, barW - 0.5), amp * 2)
    }
    ctx.globalAlpha = 1

    // Selection overlay edges
    ctx.fillStyle = accent
    ctx.fillRect(selX0 - 1, 0, 2, h)
    ctx.fillRect(selX1 - 1, 0, 2, h)

    // Playhead
    if (playhead != null) {
      const px = (playhead / s.durationSec) * w
      ctx.fillStyle = cssVar('--text-1', '#f4f4f5')
      ctx.fillRect(px - 0.5, 0, 1.5, h)
    }
  }, [sample, sel, playhead])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  // ── Selection dragging ───────────────────────────────────────────────────
  const HANDLE_PX = 10

  function secAtClientX(clientX: number): number {
    const el = wrapRef.current
    const s = sample
    if (!el || !s) return 0
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return frac * s.durationSec
  }

  function onPointerDown(e: React.PointerEvent) {
    const s = sample
    if (!s) return
    stop()
    const el = wrapRef.current!
    const rect = el.getBoundingClientRect()
    const [a, b] = sel
    const xa = (a / s.durationSec) * rect.width
    const xb = (b / s.durationSec) * rect.width
    const x = e.clientX - rect.left
    let mode: Drag
    if (Math.abs(x - xa) <= HANDLE_PX) mode = 'start'
    else if (Math.abs(x - xb) <= HANDLE_PX) mode = 'end'
    else if (x > xa && x < xb) mode = 'move'
    else {
      // Click outside → start a fresh selection from here (drag the end out).
      mode = 'end'
      const at = secAtClientX(e.clientX)
      setSel([at, at])
    }
    dragRef.current = mode
    dragOffsetRef.current = secAtClientX(e.clientX) - a
    el.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const mode = dragRef.current
    const s = sample
    if (!mode || !s) return
    const t = secAtClientX(e.clientX)
    setSel(([a, b]) => {
      const dur = s.durationSec
      if (mode === 'start') {
        const ns = Math.min(Math.max(0, t), b - 0.2)
        return [Math.max(ns, b - maxSec), b]
      }
      if (mode === 'end') {
        const ne = Math.max(Math.min(dur, t), a + 0.2)
        return [a, Math.min(ne, a + maxSec)]
      }
      // move: shift the whole window, clamped to [0, dur]
      const width = b - a
      let na = t - dragOffsetRef.current
      na = Math.min(Math.max(0, na), dur - width)
      return [na, na + width]
    })
  }

  function onPointerUp(e: React.PointerEvent) {
    dragRef.current = null
    try {
      wrapRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  // ── Playback ─────────────────────────────────────────────────────────────
  function play(which: 'sel' | 'all') {
    const s = sample
    if (!s) return
    stop()
    if (!acRef.current) acRef.current = new AudioContext()
    const ac = acRef.current
    void ac.resume()
    const src = ac.createBufferSource()
    src.buffer = s.buffer
    src.connect(ac.destination)
    const [a, b] = sel
    const from = which === 'sel' ? a : 0
    const dur = which === 'sel' ? Math.max(0.05, b - a) : s.durationSec
    src.start(0, from, dur)
    srcRef.current = src
    setPlaying(which)
    const startAt = ac.currentTime
    const tick = () => {
      const pos = from + (ac.currentTime - startAt)
      setPlayhead(pos)
      if (pos >= from + dur) {
        stop()
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    src.onended = () => stop()
  }

  const selLen = sel[1] - sel[0]

  if (error) {
    return <p className="rounded bg-danger/15 px-3 py-2 text-xs text-danger">{error}</p>
  }

  if (!sample) {
    return (
      <div className="grid h-28 place-items-center rounded-lg border border-border bg-bg-2/40 text-2xs text-text-3">
        Đang đọc & phân tích file audio…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-2xs text-text-3">Kéo 2 mép vùng sáng để chọn đoạn rõ tiếng nhất</span>
        <span
          className={`rounded px-2 py-0.5 text-2xs font-medium ${
            selLen > maxSec + 0.01 ? 'bg-warning/15 text-warning' : 'bg-accent/15 text-accent'
          }`}
        >
          Đã chọn {selLen.toFixed(1)}s / tối đa {maxSec}s
        </span>
      </div>

      <div
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="relative h-28 cursor-ew-resize touch-none select-none overflow-hidden rounded-lg border border-border bg-bg-2/40"
      >
        <canvas ref={canvasRef} className="h-full w-full" />
        {/* Drag handles drawn on top for a clear hit target */}
        <div
          className="pointer-events-none absolute top-1/2 h-9 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-accent"
          style={{ left: `${(sel[0] / sample.durationSec) * 100}%` }}
        />
        <div
          className="pointer-events-none absolute top-1/2 h-9 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-accent"
          style={{ left: `${(sel[1] / sample.durationSec) * 100}%` }}
        />
      </div>

      <div className="flex justify-between text-2xs text-text-3">
        <span>0:00</span>
        <span>{fmtTime(sample.durationSec / 2)}</span>
        <span>{fmtTime(sample.durationSec)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => (playing === 'sel' ? stop() : play('sel'))}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
        >
          {playing === 'sel' ? <Square size={13} /> : <Play size={13} />}
          {playing === 'sel' ? 'Dừng' : 'Nghe đoạn đã chọn'}
        </button>
        <button
          onClick={() => (playing === 'all' ? stop() : play('all'))}
          className="flex items-center gap-1.5 rounded-md border border-border bg-bg-2/40 px-3 py-1.5 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1"
        >
          {playing === 'all' ? <Square size={13} /> : <Play size={13} />}
          {playing === 'all' ? 'Dừng' : 'Nghe cả file'}
        </button>
        <span className="ml-auto text-2xs text-text-3">Đoạn 5–10s, một người nói, ít ồn → clone chuẩn nhất</span>
      </div>
    </div>
  )
})
