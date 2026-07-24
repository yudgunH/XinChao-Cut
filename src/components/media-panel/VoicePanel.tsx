import { useCallback, useEffect, useState } from 'react'
import { AudioLines, Captions, Loader2, AlertCircle, Server, Cpu, Settings2 } from 'lucide-react'

import { speakCaptions, speakText, type TtsOptions } from '@engine/audio/tts-runner'
import { listTtsVoices, type TtsVoice } from '@engine/backend'
import { VoiceSelect } from '@components/shared/VoiceSelect'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { usePlaybackStore } from '@store/playback-store'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useTtsStore } from '@store/tts-store'

const SPEEDS = [
  { value: 0.8, label: 'Slow', detail: '0.8×' },
  { value: 1, label: 'Normal', detail: '1×' },
  { value: 1.25, label: 'Fast', detail: '1.25×' },
  { value: 1.5, label: 'Very fast', detail: '1.5×' },
]

// Module-level so Cancel keeps working after a tab switch (panel unmounts).
let _abort: AbortController | null = null

function SpeedPicker({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-md bg-bg-3 p-1">
      {SPEEDS.map((speed) => (
        <button
          key={speed.value}
          onClick={() => onChange(speed.value)}
          disabled={disabled}
          title={speed.detail}
          className={`rounded px-2 py-1.5 text-left transition-colors disabled:opacity-45 ${
            value === speed.value ? 'bg-accent text-white' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'
          }`}
        >
          <span className="block text-2xs font-semibold">{speed.label}</span>
          <span className={`block text-[10px] ${value === speed.value ? 'text-white/70' : 'text-text-3'}`}>
            {speed.detail}
          </span>
        </button>
      ))}
    </div>
  )
}

export function VoicePanel() {
  const [backendCaps] = useBackendCapabilities()
  const online = !!backendCaps?.tts

  const projectId = useProjectStore((s) => s.id)
  const timelineClips = useTimelineStore((s) => s.timeline.clips)
  const timelineTracks = useTimelineStore((s) => s.timeline.tracks)

  const {
    busy, progress, error, note, text, voice, speed, captionMode,
    setBusy, setProgress, setError, setNote, setText, setVoice, setSpeed, setCaptionMode,
  } = useTtsStore()

  const [voices, setVoices] = useState<TtsVoice[]>([])

  const loadVoices = useCallback(async () => {
    try {
      const list = await listTtsVoices()
      setVoices(list)
      if (!useTtsStore.getState().voice && list.length > 0) {
        const def = useTtsStore.getState().defaultVoiceId
        setVoice((list.find((v) => v.id === def) ?? list[0]!).id)
      }
    } catch {
      /* offline — UI shows the hint */
    }
  }, [setVoice])

  useEffect(() => {
    if (online) void loadVoices()
  }, [online, loadVoices])

  const firstTextTrackId = timelineTracks.find((t) => t.kind === 'text')?.id
  const captionLineCount = firstTextTrackId
    ? timelineClips.filter((c) => c.trackId === firstTextTrackId && !!c.textData?.content?.trim()).length
    : 0
  const hasCaptions = captionLineCount > 0

  function buildOpts(): TtsOptions {
    return { projectId, voice, speed, captionMode }
  }

  async function generateText() {
    if (!projectId || !text.trim()) return
    setError(null); setNote(null); setBusy(true); setProgress(null)
    _abort = new AbortController()
    try {
      const atSec = usePlaybackStore.getState().currentSec
      await speakText(text, atSec, buildOpts(), _abort.signal)
      setNote('Created a speech clip at the playhead')
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : 'Speech generation failed')
      }
    } finally {
      setBusy(false); setProgress(null); _abort = null
    }
  }

  async function generateVoiceover() {
    if (!projectId) return
    setError(null); setNote(null); setBusy(true); setProgress({ done: 0, total: 0 })
    _abort = new AbortController()
    try {
      const n = await speakCaptions(buildOpts(), (done, total) => setProgress({ done, total }), _abort.signal)
      setNote(
        n === 0
          ? 'There are no captions to read'
          : `Generated voiceover from ${n} caption lines${captionMode === 'sequential' ? ' (continuous)' : ''}`,
      )
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : 'Voiceover generation failed')
      }
    } finally {
      setBusy(false); setProgress(null); _abort = null
    }
  }

  function cancel() {
    _abort?.abort()
  }

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3 text-xs">
      <div className="rounded-lg border border-border bg-bg-2/30 p-3">
        <div className="mb-3 flex items-center gap-2">
          <AudioLines size={15} className="text-accent" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-text-1">Voice</p>
            <p className="text-2xs text-text-3">{voices.length} voices available</p>
          </div>
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              online ? 'bg-success/15 text-success' : 'bg-bg-3 text-text-3'
            }`}
            title={online ? 'Backend detected — OmniVoice (offline, GPU)' : 'Start the backend with OmniVoice installed'}
          >
            {online ? <Server size={11} /> : <Cpu size={11} />}
            {online ? 'OmniVoice' : 'Offline'}
          </span>
        </div>

        <button
          onClick={() => useTtsStore.getState().setStudioOpen(true)}
          disabled={busy}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg-1 px-2.5 py-2 text-2xs font-medium text-text-2 hover:bg-bg-2 hover:text-text-1 disabled:opacity-50"
        >
          <Settings2 size={13} />
          Open Voice Studio
        </button>

        <div className="mb-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium uppercase tracking-wide text-text-3">Voice</span>
            <VoiceSelect
              voices={voices}
              value={voice}
              onChange={setVoice}
              disabled={busy || !online || voices.length === 0}
              defaultLabel={voices.length === 0 ? 'No voices' : 'Default'}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium uppercase tracking-wide text-text-3">Speed</span>
            <SpeedPicker value={speed} onChange={setSpeed} disabled={busy || !online} />
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-2/30 p-3">
        <div className="mb-2 flex items-center gap-2 text-text-1">
          <AudioLines size={15} className="text-accent" />
          <span className="font-semibold">Read text</span>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || !online}
          rows={5}
          placeholder="Enter text to read..."
          className="mb-2 w-full resize-y rounded-md bg-bg-1 px-2.5 py-2 text-xs leading-5 text-text-1 outline-none ring-1 ring-border placeholder:text-text-3 focus:ring-accent disabled:opacity-50"
        />
        <button
          onClick={() => (busy ? cancel() : void generateText())}
          disabled={!busy && (!online || !text.trim())}
          className={`flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium text-white disabled:opacity-40 ${
            busy ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent-hover'
          }`}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <AudioLines size={15} />}
          {busy ? 'Cancel' : 'Create clip at playhead'}
        </button>
      </div>

      <div className="rounded-lg border border-border bg-bg-2/30 p-3">
        <div className="mb-2 flex items-center gap-2 text-text-1">
          <Captions size={15} className="text-accent" />
          <span className="font-semibold">Read captions</span>
          <span className="ml-auto rounded bg-bg-3 px-1.5 py-0.5 text-2xs text-text-3">
            {captionLineCount} lines
          </span>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-md bg-bg-3 p-1">
          {([
            { id: 'timeline', label: 'Timeline', hint: 'Match each caption time' },
            { id: 'sequential', label: 'Continuous', hint: 'Join speech within each caption group' },
          ] as const).map((m) => (
            <button
              key={m.id}
              onClick={() => setCaptionMode(m.id)}
              disabled={busy}
              title={m.hint}
              className={`rounded px-2 py-2 text-2xs font-medium transition-colors disabled:opacity-50 ${
                captionMode === m.id
                  ? 'bg-accent text-white'
                  : 'text-text-2 hover:bg-bg-2 hover:text-text-1'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {!online ? (
          <p className="rounded-md bg-bg-3 px-2 py-2 text-center text-2xs text-text-3">
            The TTS backend is offline
          </p>
        ) : !hasCaptions && !busy ? (
          <p className="rounded-md bg-bg-3 px-2 py-2 text-center text-2xs text-text-3">
            There are no captions to read
          </p>
        ) : (
          <button
            onClick={() => (busy ? cancel() : void generateVoiceover())}
            className={`flex w-full items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium text-white disabled:opacity-40 ${
              busy ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent-hover'
            }`}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Captions size={15} />}
            {busy ? 'Cancel' : 'Create voiceover'}
          </button>
        )}

        {busy && progress != null && (
          <div className="mt-2">
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
              {progress.total > 0 ? (
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              ) : (
                <div className="absolute top-0 h-full w-2/5 animate-indeterminate rounded-full bg-accent" />
              )}
            </div>
            <p className="mt-1 text-2xs text-text-3">
              {progress.total > 0 ? `Line ${progress.done}/${progress.total}` : 'Loading model…'}
            </p>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-2xs text-danger">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {note && <p className="text-2xs text-success">{note}</p>}
    </div>
  )
}
