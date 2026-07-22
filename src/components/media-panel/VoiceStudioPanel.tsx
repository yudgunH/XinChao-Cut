import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Mic,
  Loader2,
  Download,
  AudioLines,
  Settings2,
  Server,
  Cpu,
  FileText,
  Languages,
  Gauge,
  Wand2,
  Eraser,
  ChevronDown,
} from 'lucide-react'

import {
  cancelTts,
  getTtsStatus,
  listTtsVoices,
  startTts,
  ttsDownload,
  type TtsVoice,
} from '@engine/backend'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useTtsStore } from '@store/tts-store'
import { VoiceSelect } from '@components/shared/VoiceSelect'
import { ToolPanelCloseButton } from '@components/shared/ToolPanelCloseButton'

import { AudioPlayer } from './AudioPlayer'
import { VoiceManager } from './VoiceManager'

const LANGS: { code: string; label: string }[] = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'Tiếng Anh' },
  { code: 'ko', label: 'Tiếng Hàn' },
  { code: 'ja', label: 'Tiếng Nhật' },
  { code: 'zh', label: 'Tiếng Trung' },
  { code: 'fr', label: 'Tiếng Pháp' },
  { code: 'de', label: 'Tiếng Đức' },
  { code: 'es', label: 'Tiếng Tây Ban Nha' },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Clip {
  index: number
  text: string
  url: string
}

/** Labelled control wrapper for the settings panel. */
function Field({
  icon: Icon,
  label,
  children,
  hint,
}: {
  icon: typeof Mic
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-text-3">
        <Icon size={12} /> {label}
      </span>
      {children}
      {hint && <span className="text-2xs text-text-3">{hint}</span>}
    </div>
  )
}

/** A native select styled to match the dark theme, with a chevron affordance. */
function Select({
  value,
  onChange,
  children,
}: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md bg-bg-2 px-3 py-2 pr-8 text-xs text-text-1 ring-1 ring-border focus:outline-none focus:ring-accent"
      >
        {children}
      </select>
      <ChevronDown
        size={13}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-3"
      />
    </div>
  )
}

/** Standalone text→speech: type lines, pick voice/lang/speed, synthesize, play/download — no editor. */
function RecordTab({ online }: { online: boolean }) {
  const [text, setText] = useState('')
  const [voice, setVoice] = useState('')
  const [lang, setLang] = useState('vi')
  const [speed, setSpeed] = useState(1)
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [clips, setClips] = useState<Clip[]>([])
  // Live set of object URLs to revoke on unmount. A []-dep cleanup closes over
  // the FIRST render's (empty) `clips`, so it never revoked the URLs generated
  // later — they leaked every time Voice Studio was reopened (#12). A ref sees
  // the current URLs.
  const clipUrlsRef = useRef<string[]>([])
  const mountedRef = useRef(true)
  const synthGenerationRef = useRef(0)
  const activeJobRef = useRef<string | null>(null)
  const defaultVoiceId = useTtsStore((s) => s.defaultVoiceId)

  useEffect(() => {
    mountedRef.current = true
    void listTtsVoices()
      .then((vs) => {
        setVoices(vs)
        if (defaultVoiceId && vs.some((v) => v.id === defaultVoiceId)) setVoice(defaultVoiceId)
      })
      .catch(() => {})
    return () => {
      mountedRef.current = false
      synthGenerationRef.current += 1
      if (activeJobRef.current) void cancelTts(activeJobRef.current).catch(() => {})
      activeJobRef.current = null
      clipUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      clipUrlsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const lineCount = lines.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0
  const selectedVoice = voices.find((v) => v.id === voice)
  const canGenerate = online && text.trim().length > 0 && !busy

  async function synth() {
    if (lines.length === 0) return
    clipUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    clipUrlsRef.current = []
    setClips([])
    setError(null)
    setBusy(true)
    setStatus('Đang gửi…')
    const generation = ++synthGenerationRef.current
    try {
      const jobId = await startTts({ texts: lines, voice: voice || undefined, speed, language: lang })
      if (!mountedRef.current || generation !== synthGenerationRef.current) {
        await cancelTts(jobId).catch(() => {})
        return
      }
      activeJobRef.current = jobId
      for (;;) {
        const st = await getTtsStatus(jobId)
        if (!mountedRef.current || generation !== synthGenerationRef.current) {
          await cancelTts(jobId).catch(() => {})
          return
        }
        setStatus(`Đang tạo giọng ${st.done}/${st.total}…`)
        if (st.status === 'done') break
        if (st.status === 'error' || st.status === 'cancelled') {
          throw new Error(st.error || `Job ${st.status}`)
        }
        await sleep(500)
      }
      const out: Clip[] = []
      for (let i = 0; i < lines.length; i++) {
        const blob = await ttsDownload(jobId, i)
        const url = URL.createObjectURL(blob)
        // Track immediately: if a later download fails, or the panel closes
        // between downloads, every already-created URL is still revocable.
        clipUrlsRef.current.push(url)
        if (!mountedRef.current || generation !== synthGenerationRef.current) {
          URL.revokeObjectURL(url)
          clipUrlsRef.current = clipUrlsRef.current.filter((u) => u !== url)
          return
        }
        out.push({ index: i, text: lines[i]!, url })
      }
      setClips(out)
      setStatus(`Xong ${out.length} đoạn.`)
    } catch (e) {
      if (!mountedRef.current || generation !== synthGenerationRef.current) return
      clipUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      clipUrlsRef.current = []
      setClips([])
      setError(e instanceof Error ? e.message : 'Tạo giọng thất bại')
      setStatus('')
    } finally {
      if (generation === synthGenerationRef.current) activeJobRef.current = null
      if (mountedRef.current && generation === synthGenerationRef.current) setBusy(false)
    }
  }

  function clearAll() {
    clipUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    clipUrlsRef.current = []
    setClips([])
    setText('')
    setStatus('')
    setError(null)
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ── Compose ─────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-xl border border-border bg-bg-1">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="flex items-center gap-2 text-xs font-semibold text-text-1">
              <FileText size={14} className="text-accent" /> Kịch bản
            </span>
            <span className="text-2xs text-text-3">
              {wordCount} từ · {lineCount} đoạn
            </span>
          </div>
          <div className="p-4">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Nhập nội dung cần đọc. Mỗi dòng là một đoạn audio riêng — tiện cho lời bình, hội thoại, hay danh sách câu."
              rows={13}
              disabled={!online}
              className="w-full resize-y rounded-lg bg-bg-2 px-3.5 py-3 text-sm leading-relaxed text-text-1 outline-none ring-1 ring-border placeholder:text-text-3 focus:ring-accent disabled:opacity-50"
            />
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => void synth()}
                disabled={!canGenerate}
                className="flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-xs font-semibold text-white shadow-e1 transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
                {busy ? 'Đang tạo…' : 'Tạo giọng'}
              </button>
              {(text || clips.length > 0) && !busy && (
                <button
                  onClick={clearAll}
                  className="flex items-center gap-1.5 rounded-md bg-bg-2 px-3 py-2.5 text-xs font-medium text-text-2 ring-1 ring-border hover:bg-bg-3 hover:text-text-1"
                >
                  <Eraser size={14} /> Xoá hết
                </button>
              )}
              {status && <span className="ml-1 text-2xs text-text-3">{status}</span>}
            </div>
            {error && (
              <p className="mt-3 rounded-md bg-danger/15 px-3 py-2 text-xs text-danger">{error}</p>
            )}
          </div>
        </section>

        {/* ── Settings ────────────────────────────────────────── */}
        <aside className="sticky top-4 flex flex-col gap-4 rounded-xl border border-border bg-bg-1 p-4">
          <p className="flex items-center gap-2 text-xs font-semibold text-text-1">
            <Settings2 size={14} className="text-accent" /> Thiết lập giọng
          </p>

          <Field icon={Mic} label="Giọng đọc">
            <VoiceSelect voices={voices} value={voice} onChange={setVoice} />
            <div className="rounded-md bg-bg-2/70 px-2.5 py-2 text-2xs text-text-3 ring-1 ring-border">
              {selectedVoice ? selectedVoice.name : 'Dùng giọng mặc định của backend'}
            </div>
          </Field>

          <Field icon={Languages} label="Ngôn ngữ">
            <Select value={lang} onChange={setLang}>
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field icon={Gauge} label={`Tốc độ — ${speed.toFixed(2)}×`}>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
            <div className="flex justify-between text-[10px] text-text-3">
              <span>Chậm</span>
              <span>Chuẩn</span>
              <span>Nhanh</span>
            </div>
          </Field>

          <div className="mt-auto rounded-lg bg-bg-2/60 p-3 text-2xs leading-4 text-text-3 ring-1 ring-border">
            Mỗi dòng tạo một clip riêng. Giọng clone nằm trong tab Quản lý giọng và dùng chung với editor.
          </div>
        </aside>
      </div>

      {/* ── Results ───────────────────────────────────────────── */}
      <section className="mt-6">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-xs font-semibold text-text-1">
            <AudioLines size={14} className="text-accent" /> Kết quả
          </h2>
          {clips.length > 0 && (
            <span className="rounded-full bg-bg-2 px-2 py-0.5 text-2xs font-medium text-text-3">
              {clips.length}
            </span>
          )}
        </div>

        {clips.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed border-border bg-bg-1/40 py-14 text-center">
            <div className="flex flex-col items-center gap-2">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-bg-2 text-text-3 ring-1 ring-border">
                <AudioLines size={22} />
              </div>
              <p className="text-xs text-text-2">
                {online
                  ? 'Các clip giọng đọc sẽ hiện ở đây sau khi tạo.'
                  : 'Khởi động backend (OmniVoice) để dùng Thu âm.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {clips.map((c) => (
              <div
                key={c.index}
                className="flex items-center gap-2.5 rounded-lg bg-bg-1 px-3 py-2.5 ring-1 ring-border"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent/15 text-2xs font-semibold text-accent">
                  {c.index + 1}
                </span>
                <AudioPlayer src={c.url} label={c.text} />
                <a
                  href={c.url}
                  download={`tts_${c.index + 1}.wav`}
                  title="Tải xuống"
                  className="shrink-0 rounded-md p-1.5 text-text-2 hover:bg-bg-3 hover:text-text-1"
                >
                  <Download size={14} />
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export function VoiceStudioPanel() {
  const open = useTtsStore((s) => s.studioOpen)
  const setOpen = useTtsStore((s) => s.setStudioOpen)
  const [tab, setTab] = useState<'record' | 'manage'>('record')
  const [backendCaps] = useBackendCapabilities()
  const online = !!backendCaps?.tts

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-bg-0 text-text-1">
      {/* Header */}
      <header className="relative shrink-0 overflow-hidden border-b border-border">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/10 via-transparent to-transparent"
        />
        <div className="relative flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/15 text-accent ring-1 ring-accent/20">
              <Mic size={20} />
            </span>
            <div>
              <h1 className="text-base font-semibold">Voice Studio</h1>
              <p className="text-2xs text-text-3">
                Tạo audio text→giọng &amp; quản lý giọng clone — dùng chung với editor.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium ${
                online ? 'bg-success/15 text-success' : 'bg-bg-3 text-text-3'
              }`}
              title={
                online
                  ? 'Backend detected — OmniVoice (offline, GPU)'
                  : 'Start the backend with OmniVoice installed'
              }
            >
              {online ? <Server size={12} /> : <Cpu size={12} />}
              {online ? 'OmniVoice online' : 'Offline'}
            </span>
            <ToolPanelCloseButton onClick={() => setOpen(false)} />
          </div>
        </div>

        {/* Tabs */}
        <div className="relative flex items-center gap-1 px-6">
          <TabBtn active={tab === 'record'} onClick={() => setTab('record')} icon={AudioLines}>
            Thu âm
          </TabBtn>
          <TabBtn active={tab === 'manage'} onClick={() => setTab('manage')} icon={Settings2}>
            Quản lý giọng
          </TabBtn>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'record' ? (
          <RecordTab online={online} />
        ) : (
          <div className="mx-auto max-w-6xl">
            <VoiceManager />
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function TabBtn({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Mic
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors ${
        active ? 'border-accent text-text-1' : 'border-transparent text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={14} /> {children}
    </button>
  )
}
