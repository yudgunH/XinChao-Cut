import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  checkAssets: vi.fn(async () => [] as string[]),
  hashBlob: vi.fn(),
  uploadAsset: vi.fn(),
  startServerExport: vi.fn(),
  getExportStatus: vi.fn(),
  cancelServerExport: vi.fn(async () => {}),
  exportDownloadUrl: vi.fn((id: string) => `http://backend/export/${id}/download`),
  isRetryableBackendPollError: vi.fn((e: unknown) =>
    e instanceof TypeError || (e instanceof DOMException && e.name === 'TimeoutError')),
}))

vi.mock('@engine/backend', () => h)
vi.mock('@engine/media', () => ({
  mediaManager: {
    getBlob: vi.fn(),
    setContentHash: vi.fn(),
  },
}))

import { MAX_BACKEND_RECONNECT_MS, prepareHybridExportSpec, runServerExport } from './server-export'

const params = () => ({
  settings: { width: 640, height: 360, fps: 30, videoBitrateKbps: 1_000 },
  durationSec: 1,
  clips: [],
  tracks: [],
  assets: [],
  signal: new AbortController().signal,
})

describe('server export lifecycle ownership', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    h.checkAssets.mockResolvedValue([])
    h.cancelServerExport.mockResolvedValue(undefined)
    h.exportDownloadUrl.mockImplementation((id: string) => `http://backend/export/${id}/download`)
  })

  it('cancels the stable request id when every start response is lost', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    h.startServerExport.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))

    await expect(runServerExport(params())).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(h.cancelServerExport).toHaveBeenCalledWith(uuid.replaceAll('-', ''))
  })

  it('retries transient status failures and completes without cancelling', async () => {
    vi.useFakeTimers()
    h.startServerExport.mockResolvedValue({ jobId: 'job-1', outputPath: null })
    h.getExportStatus
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValue({ id: 'job-1', status: 'done', pct: 100 })

    const run = runServerExport(params())
    await vi.runAllTimersAsync()

    await expect(run).resolves.toMatchObject({ downloadUrl: expect.stringContaining('job-1') })
    expect(h.getExportStatus).toHaveBeenCalledTimes(3)
    expect(h.cancelServerExport).not.toHaveBeenCalled()
  })

  it('keeps reconnecting through repeated status failures until user cancellation', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    h.startServerExport.mockResolvedValue({ jobId: 'job-2', outputPath: null })
    h.getExportStatus.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))

    const run = runServerExport({ ...params(), signal: ac.signal })
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(h.getExportStatus.mock.calls.length).toBeGreaterThan(5)
    expect(h.cancelServerExport).not.toHaveBeenCalled()
    ac.abort()
    await vi.runAllTimersAsync()
    await rejected
    expect(h.cancelServerExport).toHaveBeenCalledWith('job-2')
  })

  it('fails a row instead of reconnecting forever when backend stays dead', async () => {
    vi.useFakeTimers()
    h.startServerExport.mockResolvedValue({ jobId: 'dead-backend', outputPath: null })
    h.getExportStatus.mockRejectedValue(new TypeError('connection refused'))

    const run = runServerExport(params())
    const rejected = expect(run).rejects.toThrow(/unreachable for 5 minutes/)
    await vi.advanceTimersByTimeAsync(MAX_BACKEND_RECONNECT_MS + 60_000)
    await rejected
    expect(h.cancelServerExport).toHaveBeenCalledWith('dead-backend')
  })

  it('stops immediately on a permanent status response', async () => {
    h.startServerExport.mockResolvedValue({ jobId: 'lost-job', outputPath: null })
    const permanent = Object.assign(new Error('Job not found'), { status: 404 })
    h.isRetryableBackendPollError.mockReturnValueOnce(false)
    h.getExportStatus.mockRejectedValueOnce(permanent)

    await expect(runServerExport(params())).rejects.toBe(permanent)
    expect(h.getExportStatus).toHaveBeenCalledTimes(1)
  })
})

describe('Hybrid audio contract', () => {
  it('retains media mute/volume coverage while dropping caption payload fields', async () => {
    const tracks = [
      { id: 'audio', kind: 'audio', muted: false, hidden: false },
      { id: 'text', kind: 'text', muted: false, hidden: false },
    ]
    const assets = [
      { id: 'voice', kind: 'audio', name: 'voice.wav', sourcePath: 'D:/voice.wav' },
      { id: 'silent', kind: 'audio', name: 'silent.wav', sourcePath: 'D:/silent.wav' },
    ]
    const base = {
      inPointSec: 0, outPointSec: 1, speed: 1, opacity: 1, muted: false,
      denoise: undefined, adjust: {}, transform: {}, effects: [],
    }
    const clips = [
      { ...base, id: 'voice-clip', assetId: 'voice', trackId: 'audio', startSec: 0, volume: 1 },
      { ...base, id: 'silent-clip', assetId: 'silent', trackId: 'audio', startSec: 0, volume: 0 },
      { ...base, id: 'caption', trackId: 'text', startSec: 0, volume: 1,
        textData: { content: 'many karaoke words', wordTimestamps: [{ word: 'many', startSec: 0, endSec: 1 }] } },
    ]

    const spec = await prepareHybridExportSpec({
      settings: params().settings,
      durationSec: 1,
      clips: clips as never,
      tracks: tracks as never,
      assets: assets as never,
      signal: new AbortController().signal,
    })

    expect(spec.clips).toHaveLength(2)
    expect(spec.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'voice-clip', trackKind: 'audio', volume: 1 }),
      expect.objectContaining({ id: 'silent-clip', trackKind: 'audio', volume: 0 }),
    ]))
    expect(spec.clips.every((clip) => !('textData' in clip))).toBe(true)
    expect(JSON.stringify(spec)).not.toContain('many karaoke words')
  })
})
