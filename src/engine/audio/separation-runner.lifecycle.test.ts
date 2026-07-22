import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  startSeparation: vi.fn(),
  getSeparationStatus: vi.fn(),
  downloadStem: vi.fn(),
  cancelSeparation: vi.fn(async () => {}),
  getBlob: vi.fn(async () => new Blob(['audio'])),
  mediaImport: vi.fn(),
  mediaRemove: vi.fn(),
  setPct: vi.fn(),
  setError: vi.fn(),
  start: vi.fn(),
  finish: vi.fn(),
  addAsset: vi.fn(),
  removeAsset: vi.fn(),
  addSeparatedStems: vi.fn(),
  push: vi.fn(),
  ownsProject: true,
  isRetryableBackendPollError: vi.fn((e: unknown) =>
    e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError')),
}))

vi.mock('@engine/backend', () => ({
  startSeparation: h.startSeparation,
  getSeparationStatus: h.getSeparationStatus,
  downloadStem: h.downloadStem,
  cancelSeparation: h.cancelSeparation,
  isRetryableBackendPollError: h.isRetryableBackendPollError,
}))
vi.mock('@engine/media', () => ({
  mediaManager: {
    getBlob: h.getBlob,
    import: h.mediaImport,
    remove: h.mediaRemove,
  },
}))
vi.mock('@lib/project-session', () => ({
  captureProjectOwnership: () => ({ projectId: 'project-1', generation: 1 }),
  stillOwnsProject: () => h.ownsProject,
}))
vi.mock('@store/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      id: 'project-1',
      assets: [{ id: 'asset-1', name: 'audio.wav' }],
      addAsset: h.addAsset,
      removeAsset: h.removeAsset,
    }),
  },
}))
vi.mock('@store/timeline-store', () => ({
  useTimelineStore: {
    getState: () => ({
      timeline: { clips: [{ id: 'clip-1', assetId: 'asset-1' }] },
      addSeparatedStems: h.addSeparatedStems,
    }),
  },
}))
vi.mock('@store/separation-store', () => ({
  useSeparationStore: {
    getState: () => ({
      busy: false,
      start: h.start,
      setPct: h.setPct,
      setError: h.setError,
      setNote: vi.fn(),
      finish: h.finish,
    }),
  },
}))
vi.mock('@store/toast-store', () => ({
  useToastStore: { getState: () => ({ push: h.push }) },
}))

import { cancelVocalSeparation, runVocalSeparation } from './separation-runner'

describe('separation runner lifecycle ownership', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    h.getBlob.mockResolvedValue(new Blob(['audio']))
    h.cancelSeparation.mockResolvedValue(undefined)
    h.ownsProject = true
  })

  it('cancels the stable id when the start response is lost', async () => {
    const uuid = '22222222-2222-4222-8222-222222222222'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    h.startSeparation.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))

    await runVocalSeparation('clip-1', 'audio.wav')

    const stableId = uuid.replaceAll('-', '')
    expect(h.startSeparation).toHaveBeenCalledWith(
      expect.any(Blob),
      'audio.wav',
      expect.any(AbortSignal),
      stableId,
    )
    expect(h.cancelSeparation).toHaveBeenCalledWith(stableId)
  })

  it('keeps reconnecting through status failures until user cancellation', async () => {
    vi.useFakeTimers()
    const uuid = '33333333-3333-4333-8333-333333333333'
    const stableId = uuid.replaceAll('-', '')
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    h.startSeparation.mockResolvedValue(stableId)
    h.getSeparationStatus.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))

    const run = runVocalSeparation('clip-1', 'audio.wav')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(h.getSeparationStatus.mock.calls.length).toBeGreaterThan(5)
    expect(h.cancelSeparation).not.toHaveBeenCalled()
    cancelVocalSeparation()
    await vi.runAllTimersAsync()
    await run

    expect(h.cancelSeparation).toHaveBeenCalledWith(stableId)
  })

  it('turns a permanent status response into a terminal error', async () => {
    h.startSeparation.mockResolvedValue('lost-job')
    h.isRetryableBackendPollError.mockReturnValueOnce(false)
    h.getSeparationStatus.mockRejectedValueOnce(new Error('Job not found'))

    await runVocalSeparation('clip-1', 'audio.wav')

    expect(h.getSeparationStatus).toHaveBeenCalledTimes(1)
    expect(h.setError).toHaveBeenCalledWith('Job not found')
    expect(h.cancelSeparation).toHaveBeenCalledWith('lost-job')
  })

  it('aborts an in-flight start request as soon as project ownership changes', async () => {
    const uuid = '44444444-4444-4444-8444-444444444444'
    const stableId = uuid.replaceAll('-', '')
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => { requestStarted = resolve })
    h.startSeparation.mockImplementation(
      (_source: Blob, _name: string, signal: AbortSignal) => {
        requestStarted()
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          )
        })
      },
    )

    const running = runVocalSeparation('clip-1', 'audio.wav')
    await started
    h.ownsProject = false
    await running

    expect(h.cancelSeparation).toHaveBeenCalledWith(stableId)
    expect(h.addSeparatedStems).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
  })
})
