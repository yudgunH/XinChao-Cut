import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  startProxy: vi.fn(),
  getProxyStatus: vi.fn(),
  downloadProxyTo: vi.fn(),
  cancelProxy: vi.fn(),
  isRetryableBackendPollError: vi.fn(() => false),
}))
const project = vi.hoisted(() => ({
  owns: true,
  state: {
    id: 'project-1',
    assets: [] as Array<Record<string, unknown>>,
    updateAsset: vi.fn(),
  },
}))
const proxy = vi.hoisted(() => ({
  status: {} as Record<string, { pct: number; state: 'running' | 'done' | 'error'; error?: string }>,
  set: vi.fn((assetId: string, entry: { pct: number; state: 'running' | 'done' | 'error'; error?: string }) => {
    proxy.status[assetId] = entry
  }),
  clear: vi.fn((assetId: string) => {
    delete proxy.status[assetId]
  }),
}))
const media = vi.hoisted(() => ({
  getBlob: vi.fn(),
  setProxy: vi.fn(),
  removeProxy: vi.fn(),
}))
const dbUpdate = vi.hoisted(() => vi.fn())
const opfs = vi.hoisted(() => ({
  deleteBlob: vi.fn(async () => {}),
  writeStreamAtomic: vi.fn(async (_temp: string, _final: string, produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => {
    await produce(async () => {})
  }),
}))

vi.mock('@engine/backend', () => backend)
vi.mock('@lib/project-session', () => ({
  captureProjectOwnership: () => ({ projectId: 'project-1', generation: 1 }),
  stillOwnsProject: () => project.owns,
}))
vi.mock('@lib/dexie-db', () => ({ db: { assets: { update: dbUpdate } } }))
vi.mock('@engine/persistence/opfs', () => opfs)
vi.mock('@store/project-store', () => ({
  useProjectStore: { getState: () => project.state },
}))
vi.mock('@store/proxy-store', () => ({
  useProxyStore: { getState: () => proxy },
}))
vi.mock('./media-manager', () => ({ mediaManager: media }))

import { runProxyGeneration } from './proxy-runner'

const asset = {
  id: 'asset-1',
  projectId: 'project-1',
  kind: 'video',
  name: 'source.mp4',
  sourcePath: 'C:/media/source.mp4',
}

describe('proxy generation lifecycle', () => {
  beforeEach(() => {
    project.owns = true
    project.state.assets = [asset]
    project.state.updateAsset.mockReset()
    proxy.status = {}
    proxy.set.mockClear()
    proxy.clear.mockClear()
    media.getBlob.mockReset()
    media.setProxy.mockReset()
    media.removeProxy.mockReset()
    dbUpdate.mockReset()
    for (const mock of Object.values(backend)) mock.mockReset()
    backend.isRetryableBackendPollError.mockReturnValue(false)
    backend.cancelProxy.mockResolvedValue(undefined)
  })

  it('keeps proxy generation globally single-flight', async () => {
    proxy.status.other = { pct: 20, state: 'running' }

    await runProxyGeneration(asset.id)

    expect(backend.startProxy).not.toHaveBeenCalled()
  })

  it('cancels the backend job and clears UI state when its owner aborts', async () => {
    const controller = new AbortController()
    backend.startProxy.mockResolvedValue('proxy-job')
    let pollingStarted!: () => void
    const started = new Promise<void>((resolve) => { pollingStarted = resolve })
    backend.getProxyStatus.mockImplementation((_jobId: string, signal: AbortSignal) => {
      pollingStarted()
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
      })
    })

    const running = runProxyGeneration(asset.id, 1080, controller.signal)
    await started
    controller.abort()
    await running

    expect(backend.cancelProxy).toHaveBeenCalledWith('proxy-job')
    expect(proxy.clear).toHaveBeenCalledWith(asset.id)
    expect(project.state.updateAsset).not.toHaveBeenCalled()
  })

  it('publishes a completed proxy only to the owning project', async () => {
    backend.startProxy.mockResolvedValue('proxy-job')
    backend.getProxyStatus.mockResolvedValue({ status: 'done', pct: 100 })
    backend.downloadProxyTo.mockResolvedValue(undefined)
    dbUpdate.mockResolvedValue(1)

    await runProxyGeneration(asset.id)

    expect(project.state.updateAsset).toHaveBeenCalledWith(asset.id, {
      proxyStorageKey: 'asset-1__proxy-audio-v2.mp4',
    })
    expect(dbUpdate).toHaveBeenCalledWith(asset.id, {
      proxyStorageKey: 'asset-1__proxy-audio-v2.mp4',
    })
    expect(proxy.status[asset.id]).toEqual({ pct: 100, state: 'done' })
  })
})
