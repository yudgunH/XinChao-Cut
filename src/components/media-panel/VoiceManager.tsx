import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Loader2, Trash2, Play, Plus, Star, Pencil, Check, Search,
  Upload, Scissors, FileText, ArrowLeft, ArrowRight, X, AudioLines, Languages,
} from 'lucide-react'

import { previewVoice } from '@engine/audio/tts-runner'
import {
  voicePreviewUrl,
  listTtsVoices,
  transcribeVoiceSample,
  createVoice,
  deleteVoice,
  renameVoice,
  type TtsVoice,
} from '@engine/backend'
import { useTtsStore } from '@store/tts-store'
import {
  VOICE_GENDER_GROUPS,
  groupVoicesByLanguageAndGender,
  inferVoiceLanguage,
  voiceSearchText,
  type VoiceGender,
} from '@components/shared/voiceCatalog'

import { AudioPlayer } from './AudioPlayer'
import { AudioTrimmer, type AudioTrimmerHandle } from './AudioTrimmer'

const MAX_REF_SEC = 10 // backend clone-prompt VRAM cap
const VOICE_LANGUAGE_OPTIONS = [
  { code: 'unknown', label: 'Unknown' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'de', label: 'German' },
  { code: 'zh', label: 'Chinese' },
  { code: 'multi', label: 'Multilingual' },
]
const PREVIEW_TEXT_BY_LANGUAGE: Record<string, string> = {
  vi: 'Hello, this is my saved voice preview.',
  en: 'Hello, this is my saved voice preview.',
  ja: 'Hello, this is my saved voice preview.',
  ko: 'Hello, this is my saved voice preview.',
  de: 'Hallo, dies ist eine Vorschau meiner gespeicherten Stimme.',
  zh: 'Hello, this is my saved voice preview.',
  multi: 'Hello, this is my saved voice preview.',
  unknown: 'Hello, this is my saved voice preview.',
}
const DEFAULT_PREVIEW_TEXT = PREVIEW_TEXT_BY_LANGUAGE.vi ?? 'Hello, this is my saved voice preview.'
const PREVIEW_TEXT_DEFAULTS = new Set(Object.values(PREVIEW_TEXT_BY_LANGUAGE))

function previewTextForVoice(voice?: TtsVoice) {
  return PREVIEW_TEXT_BY_LANGUAGE[inferVoiceLanguage(voice ?? { id: '', name: '' })] ?? DEFAULT_PREVIEW_TEXT
}

/**
 * Voice management UI (create clone wizard · list · rename · delete · default ·
 * preview). Presentational only (no overlay) so both the editor modal and the
 * top-level Voice Studio panel can host it. Calls `onChanged` after the list mutates.
 */
export function VoiceManager({ onChanged }: { onChanged?: () => void }) {
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const femaleCount = voices.filter((voice) => voice.gender === 'female').length
  const maleCount = voices.filter((voice) => voice.gender === 'male').length
  const languageCount = new Set(voices.map((voice) => inferVoiceLanguage(voice))).size

  async function refresh() {
    const list = await listTtsVoices()
    setVoices(list.filter((v) => v.type === 'clone'))
  }

  useEffect(() => {
    void refresh()
  }, [])

  function handleCreated() {
    void refresh()
    onChanged?.()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2 sm:grid-cols-4">
        {[
          { label: 'Cloned voices', value: voices.length },
          { label: 'Languages', value: languageCount },
          { label: 'Female voices', value: femaleCount },
          { label: 'Male voices', value: maleCount },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-border bg-bg-1 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-text-3">{item.label}</p>
            <p className="mt-1 text-lg font-semibold text-text-1">{item.value}</p>
          </div>
        ))}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <AddVoiceWizard onCreated={handleCreated} />
        <SavedVoiceList voices={voices} onChanged={handleCreated} />
      </div>
    </div>
  )
}

// ── Add-voice wizard ─────────────────────────────────────────────────────────

type Step = 1 | 2 | 3

const STEPS: { n: Step; label: string; icon: typeof Upload }[] = [
  { n: 1, label: 'File & name', icon: Upload },
  { n: 2, label: 'Listen & trim', icon: Scissors },
  { n: 3, label: 'Transcript & save', icon: FileText },
]

function AddVoiceWizard({ onCreated }: { onCreated: () => void }) {
  const [step, setStep] = useState<Step>(1)
  const [name, setName] = useState('')
  const [gender, setGender] = useState<VoiceGender>('unknown')
  const [language, setLanguage] = useState('unknown')
  const [file, setFile] = useState<File | null>(null)
  const [trimmed, setTrimmed] = useState<{ blob: Blob; durationSec: number } | null>(null)
  const [trimReady, setTrimReady] = useState(false)
  const [refText, setRefText] = useState('')
  const [transcribing, setTranscribing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const trimmerRef = useRef<AudioTrimmerHandle>(null)

  function reset() {
    setStep(1)
    setName('')
    setGender('unknown')
    setLanguage('unknown')
    setFile(null)
    setTrimmed(null)
    setTrimReady(false)
    setRefText('')
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function pickFile(f: File | null) {
    setError(null)
    setFile(f)
    setTrimmed(null)
    setTrimReady(false)
    if (f && !name.trim()) setName(f.name.replace(/\.[^.]+$/, ''))
  }

  // Step 2 → 3: cut the selected segment. Transcription is opt-in on step 3.
  async function confirmTrim() {
    const cut = trimmerRef.current?.getSelection()
    if (!cut) {
      setError('Select a sample longer than 0.3 seconds.')
      return
    }
    setTrimmed(cut)
    setStep(3)
    setRefText('')
    setError(null)
  }

  async function transcribeTrimmed() {
    if (!trimmed) return
    setError(null)
    setTranscribing(true)
    try {
      const text = (await transcribeVoiceSample(trimmed.blob)).trim()
      setRefText(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speech recognition failed')
    } finally {
      setTranscribing(false)
    }
  }

  async function save() {
    if (!name.trim() || !trimmed) return
    if (!refText.trim()) {
      setError('Enter the sample transcript or run speech recognition before saving the voice.')
      return
    }
    setError(null)
    setCreating(true)
    try {
      await createVoice({
        name: name.trim(),
        gender,
        language,
        ref: new File([trimmed.blob], 'sample.wav', { type: 'audio/wav' }),
        refText: refText.trim(),
      })
      reset()
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voice creation failed')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-1">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="flex items-center gap-2 text-xs font-semibold text-text-1">
          <Plus size={14} className="text-accent" /> Add cloned voice
        </p>
        {(file || name || trimmed) && (
          <button onClick={reset} title="Start over" className="flex items-center gap-1 text-2xs text-text-3 hover:text-text-1">
            <X size={12} /> Start over
          </button>
        )}
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 px-4 py-3">
        {STEPS.map((s, i) => {
          const Icon = s.icon
          const done = step > s.n
          const active = step === s.n
          return (
            <div key={s.n} className="flex flex-1 items-center gap-2">
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-2xs font-medium ${
                  active ? 'bg-accent text-white' : done ? 'bg-accent/20 text-accent' : 'bg-bg-3 text-text-3'
                }`}
              >
                {done ? <Check size={13} /> : <Icon size={13} />}
              </span>
              <span className={`truncate text-2xs ${active ? 'font-medium text-text-1' : 'text-text-3'}`}>{s.label}</span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
            </div>
          )
        })}
      </div>

      <div className="px-4 pb-4">
        {/* Step 1 — file + name */}
        {step === 1 && (
          <div className="flex flex-col gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Voice name (for example, Male narrator)"
              className="rounded bg-bg-2 px-2.5 py-2 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent"
            />
            <div className="grid grid-cols-3 gap-1 rounded bg-bg-3 p-0.5">
              {VOICE_GENDER_GROUPS.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setGender(g.id)}
                  className={`rounded py-1.5 text-2xs font-medium transition-colors ${
                    gender === g.id ? 'bg-accent text-white' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'
                  }`}
                >
                  {g.shortLabel}
                </button>
              ))}
            </div>
            <div className="relative">
              <Languages
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3"
              />
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full appearance-none rounded bg-bg-2 py-2 pl-8 pr-2 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent"
              >
                {VOICE_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded border border-dashed border-border-strong bg-bg-2/40 py-3 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1"
            >
              <Upload size={14} />
              {file ? file.name : 'Choose a sample audio file (.wav/.mp3)…'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-2xs text-text-3">
              Next, listen and trim the clearest speech sample ({MAX_REF_SEC}s maximum).
            </p>
            <div className="mt-1 flex justify-end">
              <NextBtn disabled={!name.trim() || !file} onClick={() => setStep(2)}>Continue</NextBtn>
            </div>
          </div>
        )}

        {/* Step 2 — listen & trim */}
        {step === 2 && file && (
          <div className="flex flex-col gap-3">
            <AudioTrimmer ref={trimmerRef} file={file} maxSec={MAX_REF_SEC} onReady={setTrimReady} />
            <div className="flex justify-between">
              <BackBtn onClick={() => setStep(1)}>Back</BackBtn>
              <NextBtn disabled={!trimReady} onClick={() => void confirmTrim()}>Continue</NextBtn>
            </div>
          </div>
        )}

        {/* Step 3 — ref text & save */}
        {step === 3 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs text-text-3">Transcript of the trimmed sample (required; correct it precisely for the best voice)</span>
              {transcribing && (
                <span className="flex items-center gap-1 text-2xs text-accent">
                  <Loader2 size={11} className="animate-spin" /> recognizing…
                </span>
              )}
            </div>
            <textarea
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              disabled={creating || transcribing}
              rows={3}
              placeholder="Enter the transcript of the sample."
              className="resize-y rounded bg-bg-2 px-2.5 py-2 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50"
            />
            <p className="text-2xs text-text-3">
              Sample: {trimmed ? `${trimmed.durationSec.toFixed(1)}s` : '—'} · an accurate transcript improves the clone and avoids another ASR download.
            </p>
            <div className="mt-1 flex justify-between">
              <BackBtn onClick={() => setStep(2)} disabled={creating}>Back</BackBtn>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void transcribeTrimmed()}
                  disabled={creating || transcribing || !trimmed}
                  className="flex items-center gap-2 rounded border border-border bg-bg-2/40 px-3 py-2 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1 disabled:opacity-40"
                >
                  {transcribing ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                  {transcribing ? 'Recognizing…' : 'Recognize'}
                </button>
                <button
                  onClick={() => void save()}
                  disabled={creating || transcribing || !name.trim() || !trimmed || !refText.trim()}
                  className="flex items-center gap-2 rounded bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                >
                  {creating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {creating ? 'Creating voice…' : 'Save voice'}
                </button>
              </div>
            </div>
          </div>
        )}

        {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
      </div>
    </div>
  )
}

function NextBtn({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded bg-accent px-3.5 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
    >
      {children} <ArrowRight size={13} />
    </button>
  )
}

function BackBtn({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded border border-border bg-bg-2/40 px-3 py-2 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1 disabled:opacity-40"
    >
      <ArrowLeft size={13} /> {children}
    </button>
  )
}

// ── Saved voices ─────────────────────────────────────────────────────────────

function SavedVoiceList({ voices, onChanged }: { voices: TtsVoice[]; onChanged: () => void }) {
  const [query, setQuery] = useState('')
  const [previewText, setPreviewText] = useState<string>(DEFAULT_PREVIEW_TEXT)
  const [openId, setOpenId] = useState<string | null>(null)
  const [customSrc, setCustomSrc] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [synthing, setSynthing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editGender, setEditGender] = useState<VoiceGender>('unknown')
  const [editLanguage, setEditLanguage] = useState('unknown')
  const [error, setError] = useState<string | null>(null)
  const defaultVoiceId = useTtsStore((s) => s.defaultVoiceId)
  const setDefaultVoice = useTtsStore((s) => s.setDefaultVoice)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? voices.filter((voice) => voiceSearchText(voice).includes(q)) : voices
  }, [voices, query])
  const shownGroups = useMemo(() => groupVoicesByLanguageAndGender(shown), [shown])

  async function remove(id: string) {
    await deleteVoice(id)
    if (defaultVoiceId === id) setDefaultVoice('')
    onChanged()
  }

  async function saveRename(id: string) {
    const newName = editName.trim()
    if (!newName) return
    setError(null)
    try {
      await renameVoice(id, newName, editGender, editLanguage)
      setEditingId(null)
      if (openId === id) setPreviewNonce(Date.now())
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed')
    }
  }

  // Drop the custom-synth blob when the panel closes / switches voice / unmounts.
  function clearCustom() {
    setCustomSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }

  function togglePreview(id: string) {
    clearCustom()
    const voice = voices.find((v) => v.id === id)
    setPreviewText((current) => {
      const trimmed = current.trim()
      if (!trimmed || PREVIEW_TEXT_DEFAULTS.has(trimmed)) return previewTextForVoice(voice)
      return current
    })
    setOpenId((cur) => {
      const next = cur === id ? null : id
      if (next) setPreviewNonce(Date.now())
      return next
    })
  }

  // On-demand: synthesize the custom sample sentence and play it (NOT cached).
  async function synthCustom(id: string) {
    setError(null)
    setSynthing(true)
    try {
      const blob = await previewVoice(id, previewText.trim() || undefined)
      setCustomSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voice preview failed')
    } finally {
      setSynthing(false)
    }
  }

  useEffect(() => () => clearCustom(), [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-1 px-3 py-2">
        <p className="text-xs font-semibold text-text-1">Saved voices</p>
        {voices.length > 0 && <span className="rounded bg-bg-3 px-1.5 py-0.5 text-2xs text-text-3">{voices.length}</span>}
        {voices.length > 0 && (
          <div className="ml-auto flex min-w-[180px] items-center gap-1 rounded-md bg-bg-2 px-2 ring-1 ring-border focus-within:ring-accent">
            <Search size={12} className="text-text-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search voices…"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-2xs text-text-1 outline-none placeholder:text-text-3"
            />
          </div>
        )}
      </div>

      {voices.length > 0 && (
        <input
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          placeholder="Preview sentence…"
          className="w-full rounded-md bg-bg-2 px-3 py-2 text-2xs text-text-1 outline-none ring-1 ring-border focus:ring-accent placeholder:text-text-3"
        />
      )}

      {voices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-bg-2/30 px-3 py-6 text-center text-2xs text-text-3">
          No cloned voices yet. Use the guide above to add one.
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded bg-bg-3 px-2 py-2 text-center text-2xs text-text-3">No matching voices</p>
      ) : (
        <div className="flex flex-col gap-4">
          {shownGroups.map((languageGroup) => (
            <section key={languageGroup.id} className="rounded-lg border border-border bg-bg-1/60 p-3">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-4 w-1 rounded-full bg-accent/70" />
                <span className="text-2xs font-semibold uppercase tracking-wide text-text-2">{languageGroup.label}</span>
                <span className="rounded bg-bg-3 px-1.5 py-0.5 text-2xs text-text-3">{languageGroup.voices.length}</span>
              </div>
              {languageGroup.genderGroups.map((group) => {
                const groupVoices = group.voices
                if (groupVoices.length === 0) return null
                return (
                  <div key={`${languageGroup.id}-${group.id}`} className="ml-2 border-l border-border pl-3 first:mt-0 [&+&]:mt-3">
                    <div className="mb-1.5 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-text-3">
                      <span>{group.label}</span>
                      <span className="rounded bg-bg-3 px-1.5 py-0.5">{groupVoices.length}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {groupVoices.map((v) => {
                        const isDefault = defaultVoiceId === v.id
                        const isEditing = editingId === v.id
                        const isOpen = openId === v.id
                        return (
                          <div key={v.id} className="overflow-hidden rounded-md bg-bg-2/80 ring-1 ring-border/70">
                            <div className="flex min-h-9 items-center gap-2 px-2.5 py-1.5">
                              <button
                                onClick={() => setDefaultVoice(isDefault ? '' : v.id)}
                                title={isDefault ? 'Remove default' : 'Set as default'}
                                className={`rounded p-0.5 ${isDefault ? 'text-warning' : 'text-text-3 hover:text-text-1'}`}
                              >
                                <Star size={13} fill={isDefault ? 'currentColor' : 'none'} />
                              </button>
                              {isEditing ? (
                                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                  <input
                                    autoFocus
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') void saveRename(v.id)
                                      if (e.key === 'Escape') setEditingId(null)
                                    }}
                                    className="min-w-0 flex-1 rounded bg-bg-3 px-1.5 py-0.5 text-xs text-text-1 outline-none ring-1 ring-accent"
                                  />
                                  <select
                                    value={editGender}
                                    onChange={(e) => setEditGender(e.target.value as VoiceGender)}
                                    className="w-20 shrink-0 rounded bg-bg-3 px-1 py-0.5 text-2xs text-text-1 outline-none ring-1 ring-border focus:ring-accent"
                                  >
                                    {VOICE_GENDER_GROUPS.map((g) => (
                                      <option key={g.id} value={g.id}>{g.shortLabel}</option>
                                    ))}
                                  </select>
                                  <select
                                    value={editLanguage}
                                    onChange={(e) => setEditLanguage(e.target.value)}
                                    className="w-24 shrink-0 rounded bg-bg-3 px-1 py-0.5 text-2xs text-text-1 outline-none ring-1 ring-border focus:ring-accent"
                                  >
                                    {VOICE_LANGUAGE_OPTIONS.map((option) => (
                                      <option key={option.code} value={option.code}>{option.label}</option>
                                    ))}
                                  </select>
                                </div>
                              ) : (
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="min-w-0 truncate text-xs font-medium text-text-1">{v.name}</span>
                                  <span className="shrink-0 rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-text-3">
                                    {VOICE_LANGUAGE_OPTIONS.find((option) => option.code === inferVoiceLanguage(v))?.label ?? inferVoiceLanguage(v).toUpperCase()}
                                  </span>
                                </div>
                              )}
                              <div className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-border pl-2">
                                {isEditing ? (
                                  <button onClick={() => void saveRename(v.id)} title="Save name" className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-success">
                                    <Check size={14} />
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => {
                                      setEditingId(v.id)
                                      setEditName(v.name)
                                      setEditGender((v.gender ?? 'unknown') as VoiceGender)
                                      setEditLanguage(inferVoiceLanguage(v))
                                    }}
                                    title="Rename"
                                    className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1"
                                  >
                                    <Pencil size={13} />
                                  </button>
                                )}
                                <button
                                  onClick={() => togglePreview(v.id)}
                                  title="Preview"
                                  className={`rounded p-1 hover:bg-bg-3 hover:text-text-1 ${isOpen ? 'text-accent' : 'text-text-2'}`}
                                >
                                  <Play size={14} />
                                </button>
                                <button onClick={() => void remove(v.id)} title="Delete" className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-danger">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                            {isOpen && (
                              <div className="ml-7 flex flex-col gap-2 border-t border-border px-3 py-2">
                                <AudioPlayer src={customSrc ?? voicePreviewUrl(v.id, v.previewVersion || previewNonce)} />
                                <div className="flex items-center gap-2">
                                  <span className="text-2xs text-text-3">{customSrc ? 'Playing the generated sentence' : 'Playing the saved preview'}</span>
                                  <button
                                    onClick={() => void synthCustom(v.id)}
                                    disabled={synthing}
                                    className="ml-auto flex items-center gap-1 rounded border border-border bg-bg-2/40 px-2 py-1 text-2xs text-text-2 hover:bg-bg-3 hover:text-text-1 disabled:opacity-40"
                                  >
                                    {synthing ? <Loader2 size={11} className="animate-spin" /> : <AudioLines size={11} />}
                                    Read the sentence above
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
    </div>
  )
}
