import { useEffect, useRef, useState } from 'react'
import { Upload, Sparkles, Loader2, AlertCircle, Server, Cpu } from 'lucide-react'

import { correctCaptionCues, describeBackendError } from '@engine/backend'
import { captionClipIdsOnTrack } from '@engine/timeline'
import { parseSrt, dedupeSubtitleCues } from '@engine/subtitle/srt'
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
import { captureProjectOwnership, stillOwnsProject } from '@lib/project-session'

// In-browser Whisper (transformers.js) — tiny only to keep the bundle light.
const BROWSER_MODELS = [
  { id: 'Xenova/whisper-tiny', label: 'Tiny · In-browser' },
]

// WhisperX (backend) model sizes.
const SERVER_MODELS = [
  { id: 'tiny',     label: 'Tiny · Fastest' },
  { id: 'small',    label: 'Small · Balanced' },
  { id: 'large-v3', label: 'Large v3 · Highest quality' },
]
const SERVER_DEFAULT_MODEL = 'large-v3'

const LANGUAGES = [
  { id: 'auto',       label: 'Auto-detect' },
  { id: 'english',    label: 'English' },
  { id: 'vietnamese', label: 'Vietnamese' },
  { id: 'japanese',   label: 'Japanese' },
  { id: 'chinese',    label: 'Chinese' },
  { id: 'korean',     label: 'Korean' },
]

// Module-level abort controllers — survive component unmount so an in-flight
// run keeps going (and Cancel still works) after switching tabs and back.
let _abort: AbortController | null = null

export function CaptionsPanel() {
  const insertSubtitles = useTimelineStore((s) => s.insertSubtitles)
  const applyCaptionCorrections = useTimelineStore((s) => s.applyCaptionCorrections)
  const timelineClips   = useTimelineStore((s) => s.timeline.clips)
  const timelineTracks  = useTimelineStore((s) => s.timeline.tracks)
  const flatTimeline    = useTimelineStore((s) => s.flatTimeline())
  const assets          = useProjectStore((s) => s.assets)

  // All transcription state lives in a Zustand store so it persists when the
  // user switches to a different tab (the panel unmounts but the store does not).
  const {
    busy, progress, clipLabel, error: transcriptionError, note, elapsedMs,
    model, language, provider,
    start: storeStart, finish: storeFinish,
    setProgress, setClipLabel, setError, setNote,
    setModel, setLanguage, setProvider,
  } = useTranscriptionStore()

  const fileRef = useRef<HTMLInputElement>(null)

  // `device` is ephemeral display-only info that only lives while transcription
  // is running — no need to persist it across remounts.
  const [device, setDevice] = useState('')

  const [correctionLanguage, setCorrectionLanguage] = useState('vietnamese')
  const [correctionInstructions, setCorrectionInstructions] = useState('')
  const [correcting, setCorrecting] = useState(false)
  const [correctionProgress, setCorrectionProgress] = useState(0)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const correctionAbortRef = useRef<AbortController | null>(null)

  // Poll backend until it's up — auto-switches to WhisperX when ready.
  const [backendCaps] = useBackendCapabilities()
  const serverAsr = !!backendCaps?.transcribe
  const funasrAvailable = !!backendCaps?.funasr
  const aiCorrectionAvailable = !!backendCaps?.translate

  useEffect(() => () => {
    correctionAbortRef.current?.abort()
  }, [])

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
  const resolvedAsr = serverAsr && funasrAvailable && (
    provider === 'funasr' || (provider === 'auto' && language === 'chinese')
  ) ? 'FunASR' : serverAsr ? 'WhisperX' : 'In-browser'
  const effectiveProvider = resolvedAsr === 'FunASR' ? provider : 'whisperx'

  function isAudibleMediaClip(clip: Clip, tracks: Track[], allAssets: MediaAsset[]): boolean {
    if (!clip.assetId || clip.muted) return false
    const track = tracks.find((candidate) => candidate.id === clip.trackId)
    if (!track || track.muted || (track.kind !== 'audio' && track.kind !== 'video')) return false
    const asset = allAssets.find((candidate) => candidate.id === clip.assetId)
    return !!asset && (asset.kind === 'video' || asset.kind === 'audio')
  }

  const hasMediaOnTimeline = flatTimeline.clips.some((clip) =>
    isAudibleMediaClip(clip, flatTimeline.tracks, assets),
  )

  async function importSrt(file: File) {
    try {
      // An imported file never went through the transcribe pipeline's dedupe
      // (backend word/phrase pass, mapCuesToTimeline's dedupeMappedCues) —
      // this is the one place that must dedupe explicitly since
      // insertSubtitles() no longer does it generically (see its comment).
      const parsed = dedupeSubtitleCues(parseSrt(await file.text()))
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

  const hasCaptionClips = timelineTracks.some(
    (t) => t.kind === 'text' && captionClipIdsOnTrack(timelineClips, t.id).length > 0,
  )

  async function correctCaptionsWithAi() {
    setCorrectionError(null)
    setNote(null)
    const timeline = useTimelineStore.getState().timeline
    const captionIds = new Set(
      timeline.tracks
        .filter((track) => track.kind === 'text' && !track.hidden)
        .flatMap((track) => captionClipIdsOnTrack(timeline.clips, track.id)),
    )
    const cues = timeline.clips
      .filter((clip) => captionIds.has(clip.id) && clip.textData?.content.trim())
      .map((clip) => ({ id: clip.id, content: clip.textData!.content, start: clip.startSec }))
      .sort((left, right) => left.start - right.start)
    if (cues.length === 0) {
      setCorrectionError('No visible caption cues to correct')
      return
    }

    const controller = new AbortController()
    correctionAbortRef.current?.abort()
    correctionAbortRef.current = controller
    const projectId = useProjectStore.getState().id
    const originals = new Map(cues.map((cue) => [cue.id, cue.content]))
    const corrections: Record<string, string> = {}
    const batchSize = 60
    setCorrecting(true)
    setCorrectionProgress(0)
    try {
      for (let offset = 0; offset < cues.length; offset += batchSize) {
        const batch = cues.slice(offset, offset + batchSize)
        const result = await correctCaptionCues({
          cues: batch.map(({ id, content }) => ({ id, content })),
          language: correctionLanguage,
          instructions: correctionInstructions.trim() || undefined,
          context_before: cues.slice(Math.max(0, offset - 3), offset).map((cue) => cue.content),
          context_after: cues.slice(offset + batch.length, offset + batch.length + 3).map((cue) => cue.content),
        }, controller.signal)
        for (const cue of batch) {
          const corrected = result.corrections[cue.id]?.trim()
          if (!corrected) throw new Error(`AI omitted caption ${cue.id}; nothing was changed`)
          corrections[cue.id] = corrected
        }
        setCorrectionProgress(Math.round(
          Math.min(cues.length, offset + batch.length) / cues.length * 100,
        ))
      }

      // Never overwrite a different project or user edits made while the LLM
      // was running. Results commit only after every batch passes validation.
      if (useProjectStore.getState().id !== projectId) {
        throw new Error('Project changed while AI correction was running; nothing was changed')
      }
      const liveById = new Map(
        useTimelineStore.getState().timeline.clips.map((clip) => [clip.id, clip]),
      )
      const stale = cues.some(
        (cue) => liveById.get(cue.id)?.textData?.content !== originals.get(cue.id),
      )
      if (stale) {
        throw new Error('Captions changed while AI correction was running; nothing was changed')
      }

      const changed = applyCaptionCorrections(corrections)
      setNote(changed > 0
        ? `AI corrected ${changed}/${cues.length} captions · Undo is available`
        : `AI checked ${cues.length} captions · no changes needed`)
      setCorrectionProgress(100)
    } catch (error) {
      if (controller.signal.aborted) {
        setNote('AI caption correction cancelled · nothing was changed')
      } else {
        setCorrectionError(describeBackendError(error))
      }
    } finally {
      if (correctionAbortRef.current === controller) correctionAbortRef.current = null
      setCorrecting(false)
    }
  }

  async function autoGenerate() {
    setError(null)
    setNote(null)

    // Use the flattened view shared by preview/export so media inside compound
    // clips is transcribed at its parent timeline position.
    const timeline = useTimelineStore.getState().flatTimeline()
    const clips = timeline.clips.filter((clip) =>
      isAudibleMediaClip(clip, timeline.tracks, assets),
    )
    const assetIds = [...new Set(clips.map((clip) => clip.assetId!))]

    if (assetIds.length === 0) {
      setError('No video or audio clips on the timeline')
      return
    }
    const ownership = captureProjectOwnership()
    if (!stillOwnsProject(ownership)) {
      setError('Project changed before transcription started')
      return
    }

    storeStart()
    const controller = new AbortController()
    _abort = controller
    const { signal } = controller
    const ownershipWatch = setInterval(() => {
      if (!stillOwnsProject(ownership)) controller.abort()
    }, 100)
    const assertOwnership = () => {
      if (signal.aborted || !stillOwnsProject(ownership)) {
        throw new DOMException('Cancelled', 'AbortError')
      }
    }

    try {
      const allMapped: MappedCue[] = []

      for (let i = 0; i < assetIds.length; i++) {
        assertOwnership()
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
              provider: effectiveProvider,
              onProgress: (p) => {
                setProgress({ ...p })
                if (p.device) setDevice(p.device)
              },
              signal,
            },
          )
          assertOwnership()
          allMapped.push(...mapCuesToTimeline(cues, assetClips, assetId))
          continue
        }

        const blob = await mediaManager.getBlob(assetId)
        if (!blob) continue
        assertOwnership()

        // Backend WhisperX can demux/decode the original media with FFmpeg.
        // Never decode a multi-GB source into browser PCM merely because an
        // older/imported asset has no native sourcePath.
        if (serverAsr) {
          const cues = await transcribeMediaSource(blob, {
            model,
            language: language === 'auto' ? undefined : language,
            provider: effectiveProvider,
            onProgress: (p) => {
              setProgress({ ...p })
              if (p.device) setDevice(p.device)
            },
            signal,
          })
          assertOwnership()
          allMapped.push(...mapCuesToTimeline(cues, assetClips, assetId))
          continue
        }

        // 1. Extract trimmed audio.
        setProgress({ stage: 'decoding' })
        const { wav, segments } = await extractClipAudio(blob, assetClips)
        assertOwnership()
        if (segments.length === 0) continue

        // 2. Transcribe.
        const cues = await transcribeBlob(wav, {
          model,
          language: language === 'auto' ? undefined : language,
          provider: effectiveProvider,
          onProgress: (p) => {
            setProgress({ ...p })
            if (p.device) setDevice(p.device)
          },
          signal,
        })

        // 3. Map to timeline.
        assertOwnership()
        allMapped.push(...mapSegmentedCuesToTimeline(cues, segments))
      }

      // startTimeMs is in the store; elapsedMs is kept live by the ticker.
      const tookMs = useTranscriptionStore.getState().elapsedMs

      if (allMapped.length === 0) {
        setError(`No speech detected (${formatElapsed(tookMs)})`)
        return
      }

      allMapped.sort((a, b) => a.startSec - b.startSec)
      assertOwnership()
      insertSubtitles(allMapped)
      setNote(`Generated ${allMapped.length} captions in ${formatElapsed(tookMs)}`)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : 'Transcription failed')
      }
    } finally {
      clearInterval(ownershipWatch)
      storeFinish()
      if (_abort === controller) _abort = null
    }
  }

  function cancelTranscription() {
    _abort?.abort()
  }

  const isDeterminate = progress?.pct != null

  const progressLabel =
    progress?.stage === 'uploading'
      ? 'Uploading media…'
      : progress?.stage === 'queued'
        ? 'Waiting for GPU…'
        : progress?.stage === 'decoding'
      ? 'Reading audio…'
      : progress?.stage === 'model'
        ? `Downloading model… ${progress.pct != null ? Math.round(progress.pct) + '%' : ''}`
        : progress?.stage === 'aligning'
          ? 'Aligning word timings…'
          : progress?.stage === 'done'
            ? 'Finalizing captions…'
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
                ? `${resolvedAsr} selected. Auto routes to FunASR when Chinese is selected.`
                : 'Running in-browser. Start the backend for better quality.'
            }
          >
            {serverAsr ? <Server size={11} /> : <Cpu size={11} />}
            {resolvedAsr}
          </span>
        </div>

        <p className="mb-3 text-2xs text-text-3">
          {serverAsr
            ? resolvedAsr === 'FunASR'
              ? 'Chinese-optimized FunASR with punctuation/VAD post-processing.'
              : funasrAvailable
                ? 'WhisperX with word-level timing. Select Chinese to route Auto through FunASR.'
                : 'WhisperX with word-level timing. Install FunASR from Model Manager for Chinese-optimized ASR.'
            : 'Transcribes all audio clips in-browser (model downloads once, then cached).'}
        </p>

        {serverAsr && (
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as 'auto' | 'whisperx' | 'funasr')}
            disabled={busy}
            className="mb-2 w-full rounded bg-bg-2 px-2 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
          >
            <option value="auto">{funasrAvailable ? 'Auto by language (Chinese → FunASR)' : 'Auto (WhisperX)'}</option>
            <option value="whisperx">WhisperX</option>
            {funasrAvailable && <option value="funasr">FunASR · Chinese/Mandarin</option>}
          </select>
        )}

        {/* Model + language selectors */}
        <div className="mb-3 flex gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy || resolvedAsr === 'FunASR'}
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

        {serverAsr && resolvedAsr === 'WhisperX' && (model !== 'large-v3' || language === 'auto') && !busy && (
          <div className="mb-3 rounded bg-warning/10 px-2 py-2 text-2xs text-warning ring-1 ring-warning/25">
            <div>Small/auto-detect is faster but may miss words and punctuation in long videos.</div>
            <button
              type="button"
              className="mt-1 font-medium underline underline-offset-2"
              onClick={() => {
                setModel('large-v3')
                setLanguage('vietnamese')
              }}
            >
              Use Large v3 with high-accuracy Vietnamese
            </button>
          </div>
        )}

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
                {isDeterminate
                  ? `${progressLabel} ${progress?.estimated ? '~' : ''}${Math.round(progress!.pct!)}%`
                  : progressLabel}
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
      {/* Optional: runs only after an explicit click and commits atomically. */}
      {hasCaptionClips && (
        <div className="rounded-lg border border-border bg-bg-2/40 p-3">
          <div className="mb-2 flex items-center gap-2 text-text-1">
            <Sparkles size={15} className="text-accent" />
            <span className="font-semibold">AI caption correction</span>
            <span className="ml-auto rounded bg-bg-3 px-1.5 py-0.5 text-[9px] uppercase text-text-3">Optional</span>
          </div>
          <p className="mb-3 text-2xs text-text-3">
            Fix spelling, grammar, punctuation and likely ASR errors. Timing and cue order stay unchanged.
          </p>
          <select
            value={correctionLanguage}
            onChange={(event) => setCorrectionLanguage(event.target.value)}
            disabled={correcting}
            className="mb-2 w-full rounded bg-bg-2 px-2 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
          >
            {LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>{language.label}</option>
            ))}
          </select>
          <textarea
            value={correctionInstructions}
            onChange={(event) => setCorrectionInstructions(event.target.value)}
            disabled={correcting}
            maxLength={2000}
            rows={2}
            placeholder="Optional: names, terminology, tone, words to preserve…"
            className="mb-2 w-full resize-y rounded bg-bg-2 px-2 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border placeholder:text-text-3 focus:ring-accent disabled:opacity-50"
          />
          {correcting ? (
            <div className="space-y-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-bg-3">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${correctionProgress}%` }}
                />
              </div>
              <button
                onClick={() => correctionAbortRef.current?.abort()}
                className="flex w-full items-center justify-center gap-2 rounded bg-bg-3 py-2 text-sm font-medium text-text-1 hover:bg-bg-4"
              >
                <Loader2 size={15} className="animate-spin" />
                Cancel correction · {correctionProgress}%
              </button>
            </div>
          ) : (
            <button
              onClick={() => void correctCaptionsWithAi()}
              disabled={!aiCorrectionAvailable || busy}
              className="flex w-full items-center justify-center gap-2 rounded bg-accent py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
            >
              <Sparkles size={15} />
              Correct captions with AI
            </button>
          )}
          {!aiCorrectionAvailable && (
            <p className="mt-2 text-2xs text-warning">
              Configure the Translate provider in Settings → AI, then recheck the backend.
            </p>
          )}
          {correctionError && (
            <div className="mt-2 flex items-start gap-1.5 text-2xs text-danger">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{correctionError}</span>
            </div>
          )}
        </div>
      )}

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
