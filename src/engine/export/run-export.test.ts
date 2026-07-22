import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaAsset } from '@engine/media'
import type { Clip, Track } from '@engine/timeline'
import type * as BackendModule from '@engine/backend'
import type * as ExporterModule from './exporter'

const h = vi.hoisted(() => ({
  exportVideo: vi.fn(),
  exportVideoCore: vi.fn(),
  renderAudioMix: vi.fn(),
  preflightStream: vi.fn(),
  cancelStream: vi.fn(),
  runServer: vi.fn(),
  prepareHybrid: vi.fn(),
  getObjectUrl: vi.fn(),
  mainThread: true,
}))

vi.mock('./exporter', async (importOriginal) => ({
  ...(await importOriginal<typeof ExporterModule>()),
  exportVideo: h.exportVideo,
  exportVideoCore: h.exportVideoCore,
  renderAudioMix: h.renderAudioMix,
}))

vi.mock('@engine/audio', () => ({
  audioEngine: {
    hasBuffer: vi.fn(() => false),
    getBuffer: vi.fn(() => undefined),
    getDecodeError: vi.fn(() => undefined),
    ensureDecoded: vi.fn(),
  },
}))

vi.mock('@engine/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof BackendModule>()),
  preflightBrowserExportStream: h.preflightStream,
  cancelBrowserExportStream: h.cancelStream,
}))

vi.mock('@engine/media', () => ({
  isTauri: vi.fn(() => false),
  desktopMediaFileSize: vi.fn(),
  readDesktopMediaRange: vi.fn(),
  mediaManager: {
    getBlob: vi.fn(),
    getObjectUrl: h.getObjectUrl,
  },
}))

vi.mock('./browser-video-preflight', () => ({
  browserVideoSlowWarning: vi.fn(() => null),
  browserVideoNormalizingWarning: vi.fn(() => null),
  findSlowBrowserVideoAssets: vi.fn(async () => []),
  hasPathBackedVideoAssets: vi.fn(() => false),
  shouldUseMainThreadBrowserExport: vi.fn(() => h.mainThread),
}))

vi.mock('./server-export', () => ({
  runServerExport: h.runServer,
  prepareHybridExportSpec: h.prepareHybrid,
}))

import {
  runExport,
  validateRunExport,
  type RunExportCallbacks,
  type RunExportParams,
} from './run-export'

const settings = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoBitrateKbps: 8_000,
  audioBitrateKbps: 192,
  audioMastering: 'off' as const,
  videoCodec: 'h264' as const,
  dynamicRange: 'sdr' as const,
  browserZeroCopy: 'off' as const,
}

const videoTrack: Track = {
  id: 'video-track',
  kind: 'video',
  name: 'Video',
  muted: false,
  locked: false,
}

function clip(assetId = 'video', audible = false): Clip {
  return {
    id: 'clip',
    assetId,
    trackId: videoTrack.id,
    startSec: 0,
    inPointSec: 0,
    outPointSec: 1,
    speed: 1,
    opacity: 1,
    volume: 1,
    muted: !audible,
    adjust: { brightness: 0, contrast: 0, saturation: 0 },
    transform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
    effects: [],
  }
}

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'video',
    kind: 'video',
    name: 'fixture.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1_024,
    durationSec: 1,
    width: 1920,
    height: 1080,
    storageKey: 'fixture.mp4',
    createdAt: 1,
    ...overrides,
  }
}

function params(overrides: Partial<RunExportParams> = {}): RunExportParams {
  return {
    opId: 'op-1',
    settings,
    timeline: { durationSec: 1, clips: [clip()], tracks: [videoTrack] },
    assets: [asset()],
    engine: 'browser',
    exportWorkload: 'simple',
    serverAvailable: false,
    mustUseBrowser: false,
    exportDir: '',
    name: 'export',
    videoOn: true,
    audioOn: false,
    audioFormat: 'mp3',
    subsOn: false,
    audioClipCount: 0,
    quality: { audioBitrateKbps: 192 },
    urlCache: new Map(),
    urlSourceKeys: new Map(),
    scratchKey: '__test-export.mp4',
    ...overrides,
  }
}

function callbacks(signal = new AbortController().signal) {
  const events = {
    progress: vi.fn(),
    note: vi.fn(),
    serverLabel: vi.fn(),
    savedPath: vi.fn(),
    outputUrl: vi.fn(),
    serverDiag: vi.fn(),
    engine: vi.fn(),
    assetHash: vi.fn(),
    download: vi.fn(),
    renderStart: vi.fn(),
  }
  const value: RunExportCallbacks = {
    signal,
    isCurrent: (opId) => opId === 'op-1',
    onProgress: events.progress,
    onNote: events.note,
    onServerLabel: events.serverLabel,
    onSavedPath: events.savedPath,
    onOutputUrl: events.outputUrl,
    onServerDiag: events.serverDiag,
    onEngineChange: events.engine,
    onAssetHash: events.assetHash,
    onDownload: events.download,
    onRenderStart: events.renderStart,
  }
  return { value, events }
}

describe('runExport mechanical orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.mainThread = true
    h.getObjectUrl.mockResolvedValue('blob:fixture')
    h.renderAudioMix.mockResolvedValue(null)
    h.exportVideo.mockResolvedValue({
      blob: null,
      savedPath: 'C:/exports/export.mp4',
      videoCodec: 'h264',
      zeroCopy: 'off',
    })
    h.runServer.mockResolvedValue({
      downloadUrl: 'http://localhost/export.mp4',
      savedPath: 'C:/exports/export.mp4',
    })
    h.prepareHybrid.mockResolvedValue({ version: 1, assets: [] })
  })

  it('runs the browser main-thread path and publishes the saved output', async () => {
    const cb = callbacks()
    await runExport(params(), cb.value)

    expect(h.exportVideo).toHaveBeenCalledOnce()
    expect(cb.events.renderStart).toHaveBeenCalledWith('browser')
    expect(cb.events.savedPath).toHaveBeenCalledWith('C:/exports/export.mp4')
    expect(cb.events.progress).toHaveBeenCalledWith({ frame: 1, total: 1, phase: 'done' })
  })

  it('runs the server path through the same callbacks', async () => {
    const cb = callbacks()
    await runExport(params({ engine: 'server', serverAvailable: true }), cb.value)

    expect(h.runServer).toHaveBeenCalledOnce()
    expect(cb.events.renderStart).toHaveBeenCalledWith('server')
    expect(cb.events.outputUrl).toHaveBeenCalledWith('http://localhost/export.mp4')
    expect(cb.events.serverLabel).toHaveBeenCalledWith('Done')
  })

  it('wires Hybrid audio preparation into Browser Direct without re-encoding video', async () => {
    const pathAsset = asset({ sourcePath: 'C:/media/fixture.mp4', storageKey: '' })
    const cb = callbacks()
    await runExport(params({
      assets: [pathAsset],
      timeline: { durationSec: 1, clips: [clip(pathAsset.id, true)], tracks: [videoTrack] },
      serverAvailable: true,
      exportDir: 'C:/exports',
      audioClipCount: 1,
    }), cb.value)

    expect(h.preflightStream).toHaveBeenCalledOnce()
    expect(h.prepareHybrid).toHaveBeenCalledOnce()
    const directOutput = h.exportVideo.mock.calls[0]?.[9]
    expect(directOutput).toMatchObject({
      outputDir: 'C:/exports',
      outputName: 'export',
      hybridSpec: { version: 1, assets: [] },
    })
  })

  it('terminates the worker when cancellation arrives', async () => {
    class FakeWorker {
      static instances: FakeWorker[] = []
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: Worker['onerror'] = null
      messages: unknown[] = []
      terminated = false

      constructor() {
        FakeWorker.instances.push(this)
      }

      postMessage(message: { type?: string }): void {
        this.messages.push(message)
        if (message.type === 'abort') {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'aborted' } } as MessageEvent))
        }
      }

      terminate(): void {
        this.terminated = true
      }
    }
    vi.stubGlobal('Worker', FakeWorker)
    h.mainThread = false
    const ac = new AbortController()
    const cb = callbacks(ac.signal)

    const running = runExport(params(), cb.value)
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    ac.abort()

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances[0]?.messages).toContainEqual({ type: 'abort' })
    expect(FakeWorker.instances[0]?.terminated).toBe(true)
    vi.unstubAllGlobals()
  })

  it('keeps HDR and engine-advice validation ahead of operation work', () => {
    expect(validateRunExport({
      ...params(),
      settings: { ...settings, dynamicRange: 'hdr10' },
      engine: 'browser',
    })).toMatch(/HDR10 currently requires Server export/)

    expect(validateRunExport({
      ...params(),
      engineBlockedReason: 'Browser storage is full',
    })).toBe('Browser storage is full')
  })
})
