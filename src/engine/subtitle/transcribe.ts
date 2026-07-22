import { assertDecodable } from '@engine/audio/decode-guard'
import type { Clip } from '@engine/timeline'
import { getCapabilities, transcribeViaBackend, type BackendMediaSource } from '@engine/backend'

import { dedupeSubtitleCues, type SubtitleCue } from './srt'

export interface TranscribeProgress {
  stage: 'uploading' | 'queued' | 'decoding' | 'model' | 'transcribing' | 'aligning' | 'done'
  pct?: number
  file?: string
  device?: string
  estimated?: boolean
}

export interface TranscribeOptions {
  model?: string
  language?: string
  provider?: 'auto' | 'whisperx' | 'funasr'
  onProgress?: (p: TranscribeProgress) => void
  signal?: AbortSignal
}

const SAMPLE_RATE = 16000
/** Reject if the audio is longer than this; prevents main-thread OOM for very large files. */
const MAX_AUDIO_SEC = 60 * 60 // 60 minutes
// Browser fallback coexists with the editor, video frames and the ASR model.
// Keep its source decode far below the generic preview ceiling; larger sources
// must use backend FFmpeg, which streams and runs outside the renderer process.
const MAX_BROWSER_INPUT_BYTES = 256 * 1024 * 1024
const MAX_BROWSER_SOURCE_PCM_BYTES = 192 * 1024 * 1024
const MAX_BROWSER_OUTPUT_PCM_BYTES = 192 * 1024 * 1024

const BROWSER_DECODE_LIMITS = {
  maxInputBytes: MAX_BROWSER_INPUT_BYTES,
  maxPcmBytes: MAX_BROWSER_SOURCE_PCM_BYTES,
}

function mapBackendProgress(stage: string, pct: number, estimated = false): TranscribeProgress {
  if (stage === 'uploading') return { stage: 'uploading', pct }
  if (stage === 'queued' || stage === 'gpu-acquired') return { stage: 'queued', pct }
  if (stage === 'aligned') return { stage: 'aligning', pct }
  if (stage === 'done') return { stage: 'done', pct: 100 }
  return { stage: 'transcribing', pct, estimated }
}

/** Decode + downmix + resample an audio/video blob to 16 kHz mono Float32. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  // Refuse BEFORE arrayBuffer()+decodeAudioData: the MAX_AUDIO_SEC check below
  // only fires once the whole container + decoded PCM are already in RAM, so it
  // reports the error after the OOM it was meant to prevent.
  await assertDecodable(blob, 'This video/audio', BROWSER_DECODE_LIMITS)
  const AC = window.AudioContext
  const ctx = new AC()
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
    if (decoded.duration > MAX_AUDIO_SEC) {
      throw new Error(
        `Video is too long (${Math.round(decoded.duration / 60)} min). ` +
          `Trim to under ${MAX_AUDIO_SEC / 60} minutes first, or split into shorter clips.`,
      )
    }
    const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE))
    const offline = new OfflineAudioContext(1, length, SAMPLE_RATE)
    const src = offline.createBufferSource()
    src.buffer = decoded
    src.connect(offline.destination)
    src.start()
    const rendered = await offline.startRendering()
    // Copy into a standalone ArrayBuffer so it can be transferred to the worker.
    return rendered.getChannelData(0).slice()
  } finally {
    void ctx.close()
  }
}

interface RawChunk {
  text?: string
  timestamp?: [number | null, number | null]
}

// Max words per subtitle phrase before forcing a break.
const MAX_PHRASE_WORDS = 7
// Gap between consecutive words (seconds) that triggers a new phrase.
const PAUSE_THRESHOLD_SEC = 0.4

type WordItem = { word: string; startSec: number; endSec: number }

const MIN_REPEAT_WORDS = 3
const WORD_REPEAT_WINDOW_SEC = 8

function normalizeWord(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function matchingWordPrefixLength(
  words: WordItem[],
  index: number,
  accepted: WordItem[],
  acceptedIndex: number,
): number {
  let length = 0
  while (index + length < words.length && acceptedIndex + length < accepted.length) {
    const word = normalizeWord(words[index + length]!.word)
    const acceptedWord = normalizeWord(accepted[acceptedIndex + length]!.word)
    if (!word || word !== acceptedWord) break
    length++
  }
  return length
}

function repeatedWordPrefixLength(words: WordItem[], index: number, accepted: WordItem[]): number {
  const current = words[index]
  if (!current) return 0

  let best = 0
  for (let i = accepted.length - 1; i >= 0; i--) {
    const prev = accepted[i]!
    if (current.startSec - prev.endSec > WORD_REPEAT_WINDOW_SEC) break

    const length = matchingWordPrefixLength(words, index, accepted, i)
    if (length < MIN_REPEAT_WORDS) continue

    const candidateEnd = words[index + length - 1]!.endSec
    const matchedStart = prev.startSec
    const matchedEnd = accepted[i + length - 1]!.endSec
    // A hallucinated repeat re-emits the SAME audio span → its time overlaps
    // the original. A genuine re-utterance (a repeated command) comes later in
    // a non-overlapping span with a real pause and must be kept. Require actual
    // overlap instead of the old ±0.6s proximity window (which deleted real
    // repeated speech). Mirrors backend _repeated_word_prefix_len.
    const overlap = Math.min(candidateEnd, matchedEnd) - Math.max(current.startSec, matchedStart)
    if (overlap > 0) {
      best = Math.max(best, length)
    }
  }
  return best
}

function dedupeRepeatedWords(words: WordItem[]): WordItem[] {
  const out: WordItem[] = []
  let i = 0
  while (i < words.length) {
    const repeated = repeatedWordPrefixLength(words, i, out)
    if (repeated >= MIN_REPEAT_WORDS) {
      i += repeated
      continue
    }

    const word = words[i]!
    const prev = out[out.length - 1]
    if (
      prev &&
      normalizeWord(prev.word) === normalizeWord(word.word) &&
      Math.abs(prev.startSec - word.startSec) <= 0.08 &&
      Math.abs(prev.endSec - word.endSec) <= 0.12
    ) {
      i++
      continue
    }

    out.push(word)
    i++
  }
  return out
}

function phraseFromWords(ws: WordItem[]): SubtitleCue {
  const startSec = ws[0]!.startSec
  const endSec = ws[ws.length - 1]!.endSec
  return {
    startSec,
    endSec: Math.max(endSec, startSec + 0.3),
    content: ws.map((w) => w.word).join(' '),
    // Store timestamps relative to phrase start so they work at any timeline position.
    words: ws.map((w) => ({
      word: w.word,
      startSec: w.startSec - startSec,
      endSec: w.endSec - startSec,
    })),
  }
}

function chunksToCues(chunks: RawChunk[]): SubtitleCue[] {
  // With return_timestamps:'word', each chunk is one word.
  // Build a flat word list, then group into phrase-level cues.
  const wordList: WordItem[] = []
  let cursor = 0
  for (const c of chunks) {
    const word = (c.text ?? '').trim()
    if (!word) continue
    const start = c.timestamp?.[0] ?? cursor
    const end = c.timestamp?.[1] ?? start + 0.3
    wordList.push({ word, startSec: start, endSec: Math.max(end, start + 0.05) })
    cursor = wordList[wordList.length - 1]!.endSec
  }
  const cleanWords = dedupeRepeatedWords(wordList)
  if (cleanWords.length === 0) return []

  // Group words into phrases, breaking on long pauses or phrase length.
  const cues: SubtitleCue[] = []
  let phrase: WordItem[] = []
  for (const w of cleanWords) {
    const last = phrase[phrase.length - 1]
    const pause = last ? w.startSec - last.endSec : 0
    if (phrase.length >= MAX_PHRASE_WORDS || (phrase.length > 0 && pause >= PAUSE_THRESHOLD_SEC)) {
      cues.push(phraseFromWords(phrase))
      phrase = []
    }
    phrase.push(w)
  }
  if (phrase.length > 0) cues.push(phraseFromWords(phrase))

  return dedupeSubtitleCues(cues)
}

/** Transcribe a media blob to subtitle cues (timed in source seconds). */
export async function transcribeBlob(
  blob: Blob,
  opts: TranscribeOptions = {},
): Promise<SubtitleCue[]> {
  // Prefer the backend (WhisperX) when it's available — far better timing/quality.
  // Falls through to the in-browser Whisper when no backend is configured/up.
  const caps = await getCapabilities()
  if (caps?.transcribe) {
    opts.onProgress?.({ stage: 'transcribing' })
    // No dedupeSubtitleCues() here: the backend already deduped (word-level +
    // phrase-level) before returning, and every caller of transcribeBlob maps
    // this result through mapSegmentedCuesToTimeline, which dedupes again.
    // Re-running the same fuzzy repeat-heuristic a 3rd time on already-clean
    // data added no value — just more chances to misfire on real repeated
    // speech.
    return transcribeViaBackend(blob, {
      language: opts.language,
      model: opts.model,
      provider: opts.provider,
      signal: opts.signal,
      onProgress: (progress) =>
        opts.onProgress?.(mapBackendProgress(progress.stage, progress.pct, progress.estimated)),
    })
  }

  opts.onProgress?.({ stage: 'decoding' })
  const audio = await toMono16k(blob)
  if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')

  const worker = new Worker(new URL('../../workers/transcribe.worker.ts', import.meta.url), {
    type: 'module',
  })

  return new Promise<SubtitleCue[]>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const cleanup = () => {
      opts.signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }

    if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true })
      // Abort may have raced between the pre-worker check and listener setup.
      // Adding a listener to an already-aborted signal does not dispatch it.
      if (opts.signal.aborted) {
        onAbort()
        return
      }
    }

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as {
        type: string
        stage?: string
        device?: string
        data?: { progress?: number; file?: string; status?: string }
        chunks?: RawChunk[]
        message?: string
      }
      if (m.type === 'progress') {
        if (m.stage === 'model') {
          opts.onProgress?.({ stage: 'model', pct: m.data?.progress, file: m.data?.file })
        } else if (m.stage === 'device') {
          opts.onProgress?.({ stage: 'transcribing', device: m.device })
        } else {
          opts.onProgress?.({ stage: 'transcribing' })
        }
      } else if (m.type === 'done') {
        if (settled) return
        settled = true
        resolve(chunksToCues(m.chunks ?? []))
        cleanup()
      } else if (m.type === 'error') {
        if (settled) return
        settled = true
        reject(new Error(m.message ?? 'Transcription failed'))
        cleanup()
      }
    }
    worker.onerror = (e) => {
      if (settled) return
      settled = true
      reject(new Error(e.message || 'Transcription worker error'))
      cleanup()
    }

    worker.postMessage({ audio, model: opts.model, language: opts.language }, [audio.buffer])
  })
}

/** Transcribe a media source without materialising desktop sourcePath files in JS memory. */
export async function transcribeMediaSource(
  source: BackendMediaSource,
  opts: TranscribeOptions = {},
): Promise<SubtitleCue[]> {
  const caps = await getCapabilities()
  if (caps?.transcribe) {
    opts.onProgress?.({ stage: 'transcribing' })
    // See the matching comment in transcribeBlob: the mapping step
    // (mapCuesToTimeline) that every caller runs on this result dedupes
    // already-backend-deduped cues again, so a pass here was redundant.
    return transcribeViaBackend(source, {
      language: opts.language,
      model: opts.model,
      provider: opts.provider,
      signal: opts.signal,
      onProgress: (progress) =>
        opts.onProgress?.(mapBackendProgress(progress.stage, progress.pct, progress.estimated)),
    })
  }
  if (source instanceof Blob) return transcribeBlob(source, opts)
  throw new Error(
    'Backend is required to transcribe path-backed media without loading the full file',
  )
}

/** Cheap capability check used before choosing browser PCM extraction. */
export async function backendAsrAvailable(): Promise<boolean> {
  return !!(await getCapabilities())?.transcribe
}

// ─── Timeline-aware extraction ───────────────────────────────────────────────

/** Encode a mono Float32 PCM array as a WAV blob (16-bit LE). */
function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const dataLen = samples.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const v = new DataView(buf)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, dataLen, true)
  let off = 44
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/**
 * Where a clip's audio sits inside the combined-audio blob produced by
 * `extractClipAudio`.  Speed is stored separately so `mapSegmentedCuesToTimeline`
 * can compress the timestamps back to timeline time.
 */
export interface SegmentInfo {
  clipStartSec: number
  audioStart: number // seconds into the combined WAV
  audioEnd: number // audioStart + (outPoint - inPoint)  [at 1× speed]
  speed: number
}

/**
 * Extract only the audio portions actually used by `clips` (each clip's
 * [inPointSec, outPointSec] window from the source file) and concatenate them
 * in timeline order into a single WAV blob.
 *
 * Audio is always extracted at 1× so the ASR model can understand speech at
 * normal speed; the clip's `speed` is stored in the segment map and applied
 * when mapping timestamps back to timeline positions.
 */
export async function extractClipAudio(
  blob: Blob,
  clips: Clip[],
): Promise<{ wav: Blob; segments: SegmentInfo[] }> {
  // Same pre-decode gate as toMono16k — this decodes the FULL source before it
  // ever looks at which clip ranges are needed.
  await assertDecodable(blob, 'This video/audio', BROWSER_DECODE_LIMITS)
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void ctx.close()
  }

  // Process in timeline order so ASR hears segments in the same order the viewer will.
  const sorted = clips
    .filter((clip) => !clip.muted && clip.outPointSec > clip.inPointSec)
    .sort((a, b) => a.startSec - b.startSec)

  const segments: SegmentInfo[] = []
  let totalSamples = 0
  for (const clip of sorted) {
    const srcEnd = Math.min(clip.outPointSec, decoded.duration)
    const srcDur = Math.max(0, srcEnd - clip.inPointSec)
    const n = Math.ceil(srcDur * SAMPLE_RATE)
    segments.push({
      clipStartSec: clip.startSec,
      audioStart: totalSamples / SAMPLE_RATE,
      audioEnd: (totalSamples + n) / SAMPLE_RATE,
      speed: Math.max(clip.speed ?? 1, 0.01),
    })
    totalSamples += n
  }

  if (totalSamples * Float32Array.BYTES_PER_ELEMENT > MAX_BROWSER_OUTPUT_PCM_BYTES) {
    throw new Error(
      'Các đoạn được chọn tạo quá nhiều audio để xử lý an toàn trong trình duyệt. ' +
        'Hãy bật backend hoặc chia transcription thành các nhóm ngắn hơn.',
    )
  }

  if (totalSamples === 0) {
    return { wav: float32ToWav(new Float32Array(0), SAMPLE_RATE), segments: [] }
  }

  const offline = new OfflineAudioContext(1, totalSamples, SAMPLE_RATE)
  for (let i = 0; i < sorted.length; i++) {
    const clip = sorted[i]!
    const seg = segments[i]!
    const srcEnd = Math.min(clip.outPointSec, decoded.duration)
    const srcDur = Math.max(0, srcEnd - clip.inPointSec)
    if (srcDur <= 0) continue
    const src = offline.createBufferSource()
    src.buffer = decoded
    // playbackRate stays 1 — we handle speed in the timestamp mapping.
    src.connect(offline.destination)
    src.start(seg.audioStart, clip.inPointSec, srcDur)
  }

  const rendered = await offline.startRendering()
  return { wav: float32ToWav(rendered.getChannelData(0), SAMPLE_RATE), segments }
}

/**
 * Word timestamps on SubtitleCue are **relative to cue.startSec**. When a cue
 * is clamped to a trim/split window [rangeStart, rangeEnd] (absolute source or
 * audio-space time) and played at `speed`, keep only words that still fall in
 * the remaining range, rebase them to the new cue start, and scale by speed so
 * karaoke stays aligned (no repeated words from the trimmed-away portion).
 */
export function remapCueWordsForRange(
  words: { word: string; startSec: number; endSec: number }[] | undefined,
  cueStartAbs: number,
  rangeStartAbs: number,
  rangeEndAbs: number,
  speed: number,
): { word: string; startSec: number; endSec: number }[] | undefined {
  if (!words?.length) return undefined
  const sp = Math.max(speed, 0.01)
  const relLo = rangeStartAbs - cueStartAbs
  const relHi = rangeEndAbs - cueStartAbs
  if (relHi <= relLo) return undefined
  const out: { word: string; startSec: number; endSec: number }[] = []
  for (const w of words) {
    const ws = Math.max(w.startSec, relLo)
    const we = Math.min(w.endSec, relHi)
    if (we <= ws) continue
    out.push({
      word: w.word,
      startSec: Math.max(0, (ws - relLo) / sp),
      endSec: Math.max(0.05, (we - relLo) / sp),
    })
  }
  return out.length ? out : undefined
}

/** Rebuild caption text from the remaining word list when we trimmed words. */
function contentFromWords(
  original: string,
  words: { word: string; startSec: number; endSec: number }[] | undefined,
  filtered: { word: string; startSec: number; endSec: number }[] | undefined,
): string {
  if (!filtered) return original
  if (!words || filtered.length === words.length) return original
  const joined = filtered
    .map((w) => w.word)
    .join(' ')
    .trim()
  return joined || original
}

/**
 * Convert cues whose timestamps are in the combined-audio space (produced by
 * `extractClipAudio`) back to their correct positions on the timeline.
 * Each segment's `speed` is applied so fast/slow clips still sync correctly.
 */
export function mapSegmentedCuesToTimeline(
  cues: SubtitleCue[],
  segments: SegmentInfo[],
): MappedCue[] {
  const out: MappedCue[] = []
  for (const cue of cues) {
    for (const seg of segments) {
      // Clamp the cue to this segment's window.
      const s = Math.max(cue.startSec, seg.audioStart)
      const e = Math.min(cue.endSec, seg.audioEnd)
      if (e <= s) continue
      const speed = Math.max(seg.speed, 0.01)
      const words = remapCueWordsForRange(cue.words, cue.startSec, s, e, speed)
      // (s - seg.audioStart) is the offset within the 1× audio; divide by
      // speed to get the matching offset in timeline (playback) time.
      out.push({
        content: contentFromWords(cue.content, cue.words, words),
        startSec: seg.clipStartSec + (s - seg.audioStart) / speed,
        durationSec: Math.max(0.3, (e - s) / speed),
        words,
      })
    }
  }
  return dedupeMappedCues(out)
}

/**
 * Map source-time cues onto the timeline using the clips that reference the
 * asset, so captions line up wherever the video is actually placed (handles
 * trims, splits and speed). If no clip uses the asset, place cues from 0.
 */
export interface MappedCue {
  content: string
  startSec: number
  durationSec: number
  words?: { word: string; startSec: number; endSec: number }[]
}

function dedupeMappedCues(cues: MappedCue[]): MappedCue[] {
  return dedupeSubtitleCues(
    cues.map((cue) => ({
      content: cue.content,
      startSec: cue.startSec,
      endSec: cue.startSec + cue.durationSec,
      words: cue.words,
    })),
  ).map((cue) => ({
    content: cue.content,
    startSec: cue.startSec,
    durationSec: Math.max(0.3, cue.endSec - cue.startSec),
    words: cue.words,
  }))
}

export function mapCuesToTimeline(
  cues: SubtitleCue[],
  clips: Clip[],
  assetId: string,
): MappedCue[] {
  const allAssetClips = clips.filter((c) => c.assetId === assetId)
  const assetClips = allAssetClips.filter((c) => !c.muted)
  if (allAssetClips.length === 0) {
    return cues.map((c) => ({
      content: c.content,
      startSec: c.startSec,
      durationSec: Math.max(0.3, c.endSec - c.startSec),
      words: c.words,
    }))
  }
  if (assetClips.length === 0) return []

  const out: MappedCue[] = []
  for (const cue of cues) {
    for (const clip of assetClips) {
      const speed = Math.max(clip.speed, 0.01)
      const s = Math.max(cue.startSec, clip.inPointSec)
      const e = Math.min(cue.endSec, clip.outPointSec)
      if (e <= s) continue
      // Filter words to the remaining in/out window and scale/shift for speed
      // so karaoke does not repeat trimmed-away words or drift on speed clips.
      const words = remapCueWordsForRange(cue.words, cue.startSec, s, e, speed)
      out.push({
        content: contentFromWords(cue.content, cue.words, words),
        startSec: clip.startSec + (s - clip.inPointSec) / speed,
        durationSec: Math.max(0.3, (e - s) / speed),
        words,
      })
    }
  }
  return dedupeMappedCues(out)
}
