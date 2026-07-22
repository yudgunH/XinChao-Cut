/**
 * #6: runClipTranscription must return structured status (never void-swallow),
 * report busy without starting work, and rethrow AbortError.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = <T extends (...args: any[]) => any>(impl: T) => vi.fn(impl)
  return {
    busy: false,
    setError: fn((_e: string | null) => {}),
    setNote: fn((_n: string | null) => {}),
    setProgress: fn((_p: unknown) => {}),
    start: fn(() => {}),
    finish: fn(() => {}),
    model: 'small',
    language: 'auto',
    provider: 'auto' as const,
    ownsProject: true,
    clips: [] as {
      id: string
      assetId?: string
      muted?: boolean
      trackId: string
      startSec?: number
      inPointSec?: number
      outPointSec?: number
    }[],
    tracks: [] as { id: string; kind: string; muted?: boolean }[],
    assets: [] as { id: string; kind: string; name: string; sourcePath?: string }[],
    insertSubtitles: fn((_m: unknown[]) => {}),
    getBlob: fn(async (_id: string) => new Blob(['x']) as Blob | null),
    backendAsrAvailable: fn(async () => false),
    transcribeMediaSource: fn(async (
      _source: unknown,
      _options: { signal?: AbortSignal },
    ) => [] as { start: number; end: number; text: string }[]),
    transcribeBlob: fn(async () => [] as { start: number; end: number; text: string }[]),
    extractClipAudio: fn(async () => ({
      wav: new Blob(),
      segments: [{ clipId: 'c1', startSec: 0, endSec: 1, assetOffsetSec: 0 }],
    })),
    mapCuesToTimeline: fn(() => [] as { startSec: number; endSec: number; text: string }[]),
    mapSegmentedCuesToTimeline: fn(() => [] as { startSec: number; endSec: number; text: string }[]),
  }
})

vi.mock('@store/transcription-store', () => ({
  useTranscriptionStore: {
    getState: () => ({
      busy: h.busy,
      model: h.model,
      language: h.language,
      provider: h.provider,
      start: h.start,
      finish: h.finish,
      setError: h.setError,
      setNote: h.setNote,
      setProgress: h.setProgress,
    }),
  },
}))

vi.mock('@store/timeline-store', () => ({
  useTimelineStore: {
    getState: () => ({
      timeline: { clips: h.clips, tracks: h.tracks },
      insertSubtitles: h.insertSubtitles,
    }),
  },
}))

vi.mock('@store/project-store', () => ({
  useProjectStore: {
    getState: () => ({ id: 'project-1', assets: h.assets }),
  },
}))

vi.mock('@lib/project-session', () => ({
  captureProjectOwnership: () => ({ projectId: 'project-1', generation: 1 }),
  stillOwnsProject: () => h.ownsProject,
}))

vi.mock('@engine/media', () => ({
  mediaManager: { getBlob: h.getBlob },
}))

vi.mock('./transcribe', () => ({
  transcribeMediaSource: h.transcribeMediaSource,
  backendAsrAvailable: h.backendAsrAvailable,
  transcribeBlob: h.transcribeBlob,
  extractClipAudio: h.extractClipAudio,
  mapCuesToTimeline: h.mapCuesToTimeline,
  mapSegmentedCuesToTimeline: h.mapSegmentedCuesToTimeline,
}))

import { runClipTranscription } from './transcribe-runner'

describe('runClipTranscription', () => {
  beforeEach(() => {
    h.busy = false
    h.ownsProject = true
    h.clips = [
      {
        id: 'c1',
        assetId: 'a1',
        trackId: 't1',
        muted: false,
        startSec: 0,
        inPointSec: 0,
        outPointSec: 5,
      },
    ]
    h.tracks = [{ id: 't1', kind: 'video', muted: false }]
    h.assets = [{ id: 'a1', kind: 'video', name: 'v.mp4', sourcePath: '/x/v.mp4' }]
    h.setError.mockClear()
    h.setNote.mockClear()
    h.start.mockClear()
    h.finish.mockClear()
    h.insertSubtitles.mockClear()
    h.transcribeMediaSource.mockReset()
    h.transcribeMediaSource.mockResolvedValue([{ start: 0, end: 1, text: 'hi' }])
    h.mapCuesToTimeline.mockReset()
    h.mapCuesToTimeline.mockReturnValue([{ startSec: 0, endSec: 1, text: 'hi' }])
    h.transcribeBlob.mockReset()
    h.extractClipAudio.mockReset()
    h.extractClipAudio.mockResolvedValue({
      wav: new Blob(),
      segments: [{ clipId: 'c1', startSec: 0, endSec: 1, assetOffsetSec: 0 }],
    })
    h.mapSegmentedCuesToTimeline.mockReset()
    h.backendAsrAvailable.mockReset()
    h.backendAsrAvailable.mockResolvedValue(false)
  })

  it('returns busy immediately when global transcription is busy', async () => {
    h.busy = true
    const r = await runClipTranscription('c1')
    expect(r).toEqual({ status: 'busy' })
    expect(h.start).not.toHaveBeenCalled()
    expect(h.transcribeMediaSource).not.toHaveBeenCalled()
  })

  it('returns error when clip has no media', async () => {
    h.clips = [{ id: 'c1', trackId: 't1' }]
    const r = await runClipTranscription('c1')
    expect(r.status).toBe('error')
    if (r.status === 'error') expect(r.error).toMatch(/no media/i)
    expect(h.setError).toHaveBeenCalled()
  })

  it('returns ok with captionCount on success', async () => {
    const r = await runClipTranscription('c1')
    expect(r).toEqual({ status: 'ok', captionCount: 1 })
    expect(h.insertSubtitles).toHaveBeenCalled()
    expect(h.finish).toHaveBeenCalled()
  })

  it('streams a blob to backend ASR instead of decoding browser PCM', async () => {
    h.assets = [{ id: 'a1', kind: 'video', name: 'large.mp4' }]
    h.backendAsrAvailable.mockResolvedValue(true)
    h.mapCuesToTimeline.mockReturnValue([{ startSec: 0, endSec: 1, text: 'hi' }])

    const r = await runClipTranscription('c1')

    expect(r).toEqual({ status: 'ok', captionCount: 1 })
    expect(h.transcribeMediaSource).toHaveBeenCalledWith(expect.any(Blob), expect.any(Object))
    expect(h.extractClipAudio).not.toHaveBeenCalled()
    expect(h.transcribeBlob).not.toHaveBeenCalled()
  })

  it('returns error when no speech detected', async () => {
    h.mapCuesToTimeline.mockReturnValue([])
    const r = await runClipTranscription('c1')
    expect(r).toEqual({ status: 'error', error: 'No speech detected', captionCount: 0 })
    expect(h.insertSubtitles).not.toHaveBeenCalled()
    expect(h.finish).toHaveBeenCalled()
  })

  it('returns error (does not swallow) when ASR throws', async () => {
    h.transcribeMediaSource.mockRejectedValue(new Error('GPU OOM'))
    const r = await runClipTranscription('c1')
    expect(r).toEqual({ status: 'error', error: 'GPU OOM', captionCount: 0 })
    expect(h.setError).toHaveBeenCalledWith('GPU OOM')
    expect(h.finish).toHaveBeenCalled()
  })

  it('rethrows AbortError so cancel can stop the operation', async () => {
    h.transcribeMediaSource.mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    await expect(runClipTranscription('c1')).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.finish).toHaveBeenCalled()
  })

  it('aborts ASR and never inserts captions after switching projects', async () => {
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => { requestStarted = resolve })
    h.transcribeMediaSource.mockImplementation((_source, options) => {
      requestStarted()
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        )
      })
    })

    const running = runClipTranscription('c1')
    await started
    h.ownsProject = false

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.insertSubtitles).not.toHaveBeenCalled()
  })
})
