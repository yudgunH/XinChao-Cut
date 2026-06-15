import { useEffect, useRef, useState } from 'react'
import { Upload, Sparkles, Loader2, AlertCircle, Server, Cpu, Languages } from 'lucide-react'

import { parseSrt } from '@engine/subtitle/srt'
import {
  transcribeBlob,
  transcribeMediaSource,
  extractClipAudio,
  mapCuesToTimeline,
  mapSegmentedCuesToTimeline,
  type MappedCue,
} from '@engine/subtitle/transcribe'
import { mediaManager } from '@engine/media'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useTranscriptionStore } from '@store/transcription-store'
import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'
import type { TranslateConnectionResult } from '@engine/backend'

// In-browser Whisper (transformers.js) — tiny only to keep the bundle light.
const BROWSER_MODELS = [
  { id: 'Xenova/whisper-tiny', label: 'Tiny · In-browser' },
]

// WhisperX (backend) model sizes.
const SERVER_MODELS = [
  { id: 'tiny',     label: 'Tiny · Nhanh nhất' },
  { id: 'small',    label: 'Small · Cân bằng' },
  { id: 'large-v3', label: 'Large v3 · Chất lượng cao' },
]
const SERVER_DEFAULT_MODEL = 'small'

const LANGUAGES = [
  { id: 'auto',       label: 'Auto-detect' },
  { id: 'english',    label: 'English' },
  { id: 'vietnamese', label: 'Vietnamese' },
  { id: 'japanese',   label: 'Japanese' },
  { id: 'chinese',    label: 'Chinese' },
  { id: 'korean',     label: 'Korean' },
]

// Target languages the backend (NLLB-200) can translate captions into.
const TRANSLATE_LANGUAGES = [
  { id: 'english',    label: 'English' },
  { id: 'vietnamese', label: 'Vietnamese' },
  { id: 'japanese',   label: 'Japanese' },
  { id: 'chinese',    label: 'Chinese' },
  { id: 'korean',     label: 'Korean' },
  { id: 'french',     label: 'French' },
  { id: 'spanish',    label: 'Spanish' },
  { id: 'german',     label: 'German' },
  { id: 'russian',    label: 'Russian' },
  { id: 'portuguese', label: 'Portuguese' },
  { id: 'thai',       label: 'Thai' },
  { id: 'indonesian', label: 'Indonesian' },
  { id: 'hindi',      label: 'Hindi' },
  { id: 'arabic',     label: 'Arabic' },
]

// Module-level abort controller — survives component unmount so Cancel works
// even after switching tabs and coming back.
let _abort: AbortController | null = null

export function CaptionsPanel() {
  const insertSubtitles = useTimelineStore((s) => s.insertSubtitles)
  const timelineClips   = useTimelineStore((s) => s.timeline.clips)
  const timelineTracks  = useTimelineStore((s) => s.timeline.tracks)
  const assets          = useProjectStore((s) => s.assets)

  // All transcription state lives in a Zustand store so it persists when the
  // user switches to a different tab (the panel unmounts but the store does not).
  const {
    busy, progress, clipLabel, error: transcriptionError, note, elapsedMs,
    model, language,
    start: storeStart, finish: storeFinish,
    setProgress, setClipLabel, setError, setNote,
    setModel, setLanguage,
  } = useTranscriptionStore()

  const fileRef = useRef<HTMLInputElement>(null)

  // `device` is ephemeral display-only info that only lives while transcription
  // is running — no need to persist it across remounts.
  const [device, setDevice] = useState('')

  // Caption translation (separate from transcription's busy state).
  const [translating, setTranslating] = useState(false)
  const [targetLang, setTargetLang] = useState('english')
  const [translateError, setTranslateError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TranslateConnectionResult | null>(null)

  // Poll backend until it's up — auto-switches to WhisperX when ready.
  const [backendCaps] = useBackendCapabilities()
  const serverAsr = !!backendCaps?.transcribe

  // When the backend comes online / goes offline, switch engine ONLY when:
  //   a) the current model is incompatible with the new engine, AND
  //   b) we are NOT in the middle of a transcription.
  // Guard (b) prevents the model flashing to 'tiny' when WhisperX is loading
  // a large model and the system is briefly too busy to answer /health in time.
  useEffect(() => {
    if (busy) return  // Never reset the model while transcription is running
    const newList = serverAsr ? SERVER_MODELS : BROWSER_MODELS
    if (!newList.find((m) => m.id === model)) {
      setModel(serverAsr ? SERVER_DEFAULT_MODEL : BROWSER_MODELS[0]!.id)
    }
  }, [serverAsr, busy]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeModels = serverAsr ? SERVER_MODELS : BROWSER_MODELS

  function isAudibleMediaClip(clip: Clip, tracks: Track[], allAssets: MediaAsset[]): boolean {
    if (!clip.assetId || clip.muted) return false
    const track = tracks.find((candidate) => candidate.id === clip.trackId)
    if (!track || track.muted || (track.kind !== 'audio' && track.kind !== 'video')) return false
    const asset = allAssets.find((candidate) => candidate.id === clip.assetId)
    return !!asset && (asset.kind === 'video' || asset.kind === 'audio')
  }

  const hasMediaOnTimeline = timelineClips.some((clip) =>
    isAudibleMediaClip(clip, timelineTracks, assets),
  )

  // Translation needs the backend (NLLB) + at least one caption on the first
  // text track (the "original" set we translate from).
  const canTranslate = !!backendCaps?.translate
  const firstTextTrackId = timelineTracks.find((t) => t.kind === 'text')?.id
  const hasCaptions =
    !!firstTextTrackId &&
    timelineClips.some((c) => c.trackId === firstTextTrackId && !!c.textData?.content?.trim())

  async function testTranslate() {
    setTesting(true)
    setTestResult(null)
    try {
      const { testTranslateConnection } = await import('@engine/backend')
      setTestResult(await testTranslateConnection())
    } finally {
      setTesting(false)
    }
  }

  async function translateCaptionsTo(target: string) {
    setTranslateError(null)
    setNote(null)
    setTranslating(true)
    try {
      const { translateCaptions } = await import('@engine/subtitle/translate-runner')
      const source = language === 'auto' ? 'english' : language
      const n = await translateCaptions(target, source)
      setNote(n === 0 ? 'No captions to translate' : `Translated ${n} captions → ${target}`)
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : 'Translation failed')
    } finally {
      setTranslating(false)
    }
  }

  async function importSrt(file: File) {
    try {
      const parsed = parseSrt(await file.text())
      if (parsed.length === 0) { setNote('No cues found in file'); return }
      insertSubtitles(
        parsed.map((c) => ({
          content: c.content,
          startSec: c.startSec,
          durationSec: Math.max(0.3, c.endSec - c.startSec),
        })),
      )
      setNote(`Imported ${parsed.length} subtitles`)
    } catch {
      setNote('Failed to read subtitle file')
    }
  }

  async function autoGenerate() {
    setError(null)
    setTranslateError(null)
    setNote(null)

    // Collect all distinct video/audio assets on the timeline.
    const timeline = useTimelineStore.getState().timeline
    const clips = timeline.clips.filter((clip) =>
      isAudibleMediaClip(clip, timeline.tracks, assets),
    )
    const assetIds = [...new Set(clips.map((clip) => clip.assetId!))]

    if (assetIds.length === 0) {
      setError('No video or audio clips on the timeline')
      return
    }

    storeStart()
    _abort = new AbortController()

    try {
      const allMapped: MappedCue[] = []

      for (let i = 0; i < assetIds.length; i++) {
        const assetId = assetIds[i]!
        setClipLabel(assetIds.length > 1 ? `${i + 1}/${assetIds.length}` : null)
        const asset = assets.find((candidate) => candidate.id === assetId)
        if (!asset) continue
        const assetClips = clips.filter((c) => c.assetId === assetId)

        if (asset.sourcePath) {
          if (!serverAsr) {
            throw new Error('Backend is required to transcribe path-backed media without loading the full file')
          }
          const cues = await transcribeMediaSource(
            { sourcePath: asset.sourcePath, filename: asset.name },
            {
              model,
              language: language === 'auto' ? undefined : language,
              onProgress: (p) => {
                setProgress({ ...p })
                if (p.device) setDevice(p.device)
              },
              signal: _abort.signal,
            },
          )
          allMapped.push(...mapCuesToTimeline(cues, assetClips, assetId))
          continue
        }

        const blob = await mediaManager.getBlob(assetId)
        if (!blob) continue

        // 1. Extract trimmed audio.
        setProgress({ stage: 'decoding' })
        const { wav, segments } = await extractClipAudio(blob, assetClips)
        if (segments.length === 0) continue

        if (_abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError')

        // 2. Transcribe.
        const cues = await transcribeBlob(wav, {
          model,
          language: language === 'auto' ? undefined : language,
          onProgress: (p) => {
            setProgress({ ...p })
            if (p.device) setDevice(p.device)
          },
          signal: _abort.signal,
        })

        // 3. Map to timeline.
        allMapped.push(...mapSegmentedCuesToTimeline(cues, segments))
      }

      // startTimeMs is in the store; elapsedMs is kept live by the ticker.
      const tookMs = useTranscriptionStore.getState().elapsedMs

      if (allMapped.length === 0) {
        setError(`No speech detected (${formatElapsed(tookMs)})`)
        return
      }

      allMapped.sort((a, b) => a.startSec - b.startSec)
      insertSubtitles(allMapped)
      setNote(`Generated ${allMapped.length} captions in ${formatElapsed(tookMs)}`)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : 'Transcription failed')
      }
    } finally {
      storeFinish()
      _abort = null
    }
  }

  function cancelTranscription() {
    _abort?.abort()
  }

  const isDeterminate = progress?.stage === 'model' && progress.pct != null

  const progressLabel =
    progress?.stage === 'decoding'
      ? 'Reading audio…'
      : progress?.stage === 'model'
        ? `Downloading model… ${progress.pct != null ? Math.round(progress.pct) + '%' : ''}`
        : progress?.stage === 'transcribing'
          ? `Transcribing…${device ? ` (${device === 'webgpu' ? 'GPU' : 'CPU'})` : ''}`
          : 'Starting…'

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs">
      {/* ── Auto-captions ── */}
      <div className="rounded-lg border border-border bg-bg-2/40 p-3">
        <div className="mb-2 flex items-center gap-2 text-text-1">
          <Sparkles size={15} className="text-accent" />
          <span className="font-semibold">Auto-captions</span>
          <span
            className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              serverAsr ? 'bg-success/15 text-success' : 'bg-bg-3 text-text-3'
            }`}
            title={
              serverAsr
                ? 'Backend detected — using WhisperX (better quality)'
                : 'Running in-browser. Start the backend for better quality.'
            }
          >
            {serverAsr ? <Server size={11} /> : <Cpu size={11} />}
            {serverAsr ? 'WhisperX' : 'In-browser'}
          </span>
        </div>

        <p className="mb-3 text-2xs text-text-3">
          {serverAsr
            ? 'Transcribes all audio clips on the timeline with WhisperX — word-level timing.'
            : 'Transcribes all audio clips in-browser (model downloads once, then cached).'}
        </p>

        {/* Model + language selectors */}
        <div className="mb-3 flex gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            className="min-w-0 flex-1 rounded bg-bg-2 px-2 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
          >
            {activeModels.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={busy}
            title="Setting the language improves accuracy and prevents repetition loops"
            className="w-28 shrink-0 rounded bg-bg-2 px-2 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </div>

        {!hasMediaOnTimeline && !busy && (
          <p className="mb-2 rounded bg-bg-3 px-2 py-1.5 text-center text-2xs text-text-3">
            Add video or audio clips to the timeline first
          </p>
        )}

        {/* Generate / Cancel */}
        <button
          onClick={busy ? cancelTranscription : autoGenerate}
          disabled={!busy && !hasMediaOnTimeline}
          className={`flex w-full items-center justify-center gap-2 rounded py-2 text-sm font-medium text-white disabled:opacity-40 ${
            busy ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent-hover'
          }`}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {busy ? 'Cancel' : 'Generate captions'}
        </button>

        {/* Progress bar */}
        {busy && (
          <div className="mt-2">
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
              {isDeterminate ? (
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.round(progress!.pct!)}%` }}
                />
              ) : (
                <div className="absolute top-0 h-full w-2/5 animate-indeterminate rounded-full bg-accent" />
              )}
            </div>
            <div className="mt-1 flex items-center justify-between text-2xs text-text-3">
              <span>
                {clipLabel && (
                  <span className="mr-1.5 font-medium text-text-2">Clip {clipLabel}</span>
                )}
                {isDeterminate ? `${Math.round(progress!.pct!)}%` : progressLabel}
              </span>
              <span className="font-mono tabular-nums">{formatElapsed(elapsedMs)}</span>
            </div>
          </div>
        )}

        {transcriptionError && (
          <div className="mt-2 flex items-start gap-1.5 text-2xs text-danger">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{transcriptionError}</span>
          </div>
        )}
        {!serverAsr && (
          <p className="mt-2 text-2xs text-text-3">
            First run downloads the model — needs internet once.
          </p>
        )}
      </div>

      {/* ── Translate captions ── */}
      <div className="rounded-lg border border-border bg-bg-2/40 p-3">
        <div className="mb-2 flex items-center gap-2 text-text-1">
          <Languages size={15} className="text-accent" />
          <span className="font-semibold">Translate captions</span>
        </div>
        <p className="mb-3 text-2xs text-text-3">
          Translates your captions into another language on a new track (originals
          kept). Context-aware via an LLM — whole transcript at once, one line per cue.
        </p>

        <div className="mb-3 flex items-center gap-2">
          <span className="shrink-0 text-2xs text-text-3">To</span>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            disabled={translating || !canTranslate}
            className="min-w-0 flex-1 rounded bg-bg-2 px-2 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
          >
            {TRANSLATE_LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </div>

        {/* Test connection */}
        {canTranslate && (
          <div className="mb-2">
            <button
              onClick={() => void testTranslate()}
              disabled={testing}
              className="flex items-center gap-1.5 rounded border border-border bg-bg-2 px-2 py-1 text-2xs text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:opacity-50"
            >
              {testing ? <Loader2 size={12} className="animate-spin" /> : <Server size={12} />}
              Test connection
            </button>
            {testResult && (
              <p
                className={`mt-1.5 text-2xs ${testResult.ok ? 'text-success' : 'text-danger'}`}
                title={testResult.error ?? testResult.sample}
              >
                {testResult.ok
                  ? `✓ ${testResult.provider} · ${testResult.model}${testResult.sample ? ` — "${testResult.sample}"` : ''}`
                  : `✕ ${testResult.error ?? 'Failed'}`}
              </p>
            )}
          </div>
        )}

        {!canTranslate ? (
          <p className="rounded bg-bg-3 px-2 py-1.5 text-center text-2xs text-text-3">
            Add a translation API key (GEMINI / OPENAI / ANTHROPIC / OPENROUTER) to backend/.env
          </p>
        ) : !hasCaptions && !translating ? (
          <p className="rounded bg-bg-3 px-2 py-1.5 text-center text-2xs text-text-3">
            Generate or import captions first
          </p>
        ) : (
          <button
            onClick={() => void translateCaptionsTo(targetLang)}
            disabled={translating}
            className="flex w-full items-center justify-center gap-2 rounded bg-accent py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {translating ? <Loader2 size={15} className="animate-spin" /> : <Languages size={15} />}
            {translating ? 'Translating…' : 'Translate'}
          </button>
        )}
        {translating && (
          <p className="mt-2 text-2xs text-text-3">
            Sending captions to the translation model…
          </p>
        )}
        {translateError && (
          <div className="mt-2 flex items-start gap-1.5 text-2xs text-danger">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{translateError}</span>
          </div>
        )}
      </div>

      {/* ── Import subtitle file ── */}
      <button
        onClick={() => fileRef.current?.click()}
        className="flex items-center justify-center gap-2 rounded border border-border-strong bg-bg-2/40 py-2 text-text-2 hover:bg-bg-2 hover:text-text-1"
      >
        <Upload size={14} />
        Import .srt / .ass / .vtt
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".srt,.vtt,.ass,text/plain"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void importSrt(f)
          e.target.value = ''
        }}
      />

      {note && <p className="text-2xs text-success">{note}</p>}
    </div>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`
  return `${sec}s`
}
