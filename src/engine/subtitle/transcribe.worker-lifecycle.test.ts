import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  getCapabilities: vi.fn(async () => null),
  transcribeViaBackend: vi.fn(),
}))

vi.mock('@engine/backend', () => backend)
vi.mock('@engine/audio/decode-guard', () => ({
  assertDecodable: vi.fn(async () => undefined),
}))

import { transcribeBlob } from './transcribe'

class FakeAudioContext {
  close = vi.fn(async () => undefined)
  decodeAudioData = vi.fn(async () => ({ duration: 1 }))
}

class FakeOfflineAudioContext {
  destination = {}
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    }
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array([0, 0, 0, 0]) }
  }
}

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    FakeWorker.instances.push(this)
  }
}

describe('browser transcription worker lifecycle', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    backend.getCapabilities.mockResolvedValue(null)
    vi.stubGlobal('window', { AudioContext: FakeAudioContext })
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('removes the abort listener and terminates the worker after success', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = transcribeBlob(new Blob(['audio']), { signal: controller.signal })

    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]!
    worker.onmessage?.({ data: { type: 'done', chunks: [] } } as MessageEvent)

    await expect(result).resolves.toEqual([])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()
  })

  it('terminates and rejects exactly once when cancelled while running', async () => {
    const controller = new AbortController()
    const result = transcribeBlob(new Blob(['audio']), { signal: controller.signal })

    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1))
    const worker = FakeWorker.instances[0]!
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.postMessage).toHaveBeenCalledOnce()
  })

  it('catches abort racing between the pre-check and listener registration', async () => {
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        return reads >= 2
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal

    const result = transcribeBlob(new Blob(['audio']), { signal })

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.instances[0]!.postMessage).not.toHaveBeenCalled()
  })
})
