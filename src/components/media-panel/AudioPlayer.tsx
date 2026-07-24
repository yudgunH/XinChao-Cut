import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Loader2 } from 'lucide-react'

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Compact inline audio player: play / pause / resume + a draggable seek bar and
 * a current/total time readout. One `Audio` element per instance, torn down on
 * unmount. Used for Voice Studio TTS clips and saved-voice previews.
 *
 * `src` may be a blob: URL (already loaded) or a backend URL that streams (and,
 * for a lazily-generated voice preview, can take a few seconds before the first
 * byte arrives — shown as a spinner).
 */
export function AudioPlayer({ src, label }: { src: string; label?: string }) {
  const audioRef = useRef<InstanceType<typeof window.Audio> | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  const [error, setError] = useState(false)
  // A backend http(s) URL is fetched into a blob: URL before it's handed to the
  // <audio> element. A media element loading a cross-origin URL directly can fail
  // (the element errors before it ever plays), whereas
  // fetch() to the same endpoint works (it's what pushToEditor uses). blob:/data:
  // URLs are already playable and pass straight through.
  const [playSrc, setPlaySrc] = useState<string | null>(
    /^https?:/i.test(src) ? null : src,
  )

  useEffect(() => {
    if (!/^https?:/i.test(src)) {
      setPlaySrc(src)
      return
    }
    let objUrl: string | null = null
    let cancelled = false
    setPlaySrc(null)
    setError(false)
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        if (cancelled) return
        objUrl = URL.createObjectURL(blob)
        setPlaySrc(objUrl)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [src])

  // (Re)create the element when the resolved (playable) source changes.
  useEffect(() => {
    if (!playSrc) return
    const a = new window.Audio(playSrc)
    a.preload = 'metadata'
    audioRef.current = a
    setPlaying(false)
    setLoading(false)
    setCur(0)
    setDur(0)
    setError(false)

    const onTime = () => setCur(a.currentTime)
    const onMeta = () => setDur(a.duration || 0)
    const onEnd = () => {
      setPlaying(false)
      setCur(0)
      a.currentTime = 0
    }
    const onWaiting = () => setLoading(true)
    const onPlaying = () => setLoading(false)
    const onErr = () => {
      setError(true)
      setLoading(false)
      setPlaying(false)
    }
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('durationchange', onMeta)
    a.addEventListener('ended', onEnd)
    a.addEventListener('waiting', onWaiting)
    a.addEventListener('playing', onPlaying)
    a.addEventListener('error', onErr)
    return () => {
      a.pause()
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('durationchange', onMeta)
      a.removeEventListener('ended', onEnd)
      a.removeEventListener('waiting', onWaiting)
      a.removeEventListener('playing', onPlaying)
      a.removeEventListener('error', onErr)
      audioRef.current = null
    }
  }, [playSrc])

  async function toggle() {
    const a = audioRef.current
    if (!a) return
    if (playing) {
      a.pause()
      setPlaying(false)
      return
    }
    try {
      setLoading(true)
      await a.play()
      setPlaying(true)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current
    if (!a) return
    const t = Number(e.target.value)
    a.currentTime = t
    setCur(t)
  }

  // Still fetching the blob (backend URL not yet resolved) → show a spinner and
  // block play until it's ready.
  const fetching = !playSrc && !error
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        onClick={() => void toggle()}
        disabled={error || fetching}
        title={playing ? 'Pause' : 'Play'}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:opacity-40"
      >
        {loading || fetching ? <Loader2 size={14} className="animate-spin" /> : playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      {label && <span className="min-w-0 max-w-[40%] truncate text-2xs text-text-2" title={label}>{label}</span>}
      <input
        type="range"
        min={0}
        max={dur || 0}
        step={0.01}
        value={Math.min(cur, dur || 0)}
        onChange={seek}
        disabled={error || !dur}
        className="min-w-0 flex-1 accent-[var(--accent)] disabled:opacity-40"
      />
      <span className="shrink-0 text-2xs tabular-nums text-text-3">
        {error ? 'error' : `${fmt(cur)} / ${fmt(dur)}`}
      </span>
    </div>
  )
}
