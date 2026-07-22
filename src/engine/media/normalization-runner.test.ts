import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({
  cancelMediaNormalization: vi.fn(),
  checkAssets: vi.fn(),
  downloadMediaNormalizationTo: vi.fn(),
  getCapabilities: vi.fn(),
  getMediaNormalizationStatus: vi.fn(),
  hashBlob: vi.fn(),
  startMediaNormalization: vi.fn(),
  uploadAsset: vi.fn(),
}))
const assetRow = vi.hoisted(() => ({
  id: 'video-1',
  projectId: 'project-1',
  kind: 'video',
  name: 'clip.webm',
  mimeType: 'video/webm',
  sizeBytes: 10,
  durationSec: 1,
  storageKey: 'video-1__clip.webm',
  createdAt: 1,
}))
const dbGet = vi.hoisted(() => vi.fn())
const dbUpdate = vi.hoisted(() => vi.fn())
const opfs = vi.hoisted(() => ({
  deleteBlob: vi.fn(),
  writeStreamAtomic: vi.fn(async (
    _temp: string,
    _final: string,
    produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
  ) => {
    await produce(async () => {})
  }),
}))

vi.mock('@engine/backend', () => backend)
vi.mock('@lib/dexie-db', () => ({ db: { assets: { get: dbGet, update: dbUpdate } } }))
vi.mock('@engine/persistence/opfs', () => opfs)
vi.mock('@store/project-store', () => ({
  useProjectStore: { getState: () => ({ assets: [], updateAsset: vi.fn() }) },
}))
vi.mock('./media-manager', () => ({ mediaManager: { getBlob: vi.fn() } }))
vi.mock('./desktop', () => ({
  desktopMediaFileSize: vi.fn(),
  isTauri: () => false,
  readDesktopMediaRange: vi.fn(),
}))

import {
  isBrowserVideoSourceSupported,
  runVideoNormalization,
} from './normalization-runner'

function sampleIndex() {
  return {
    codec: 'vp09.00.10.08',
    codedWidth: 16,
    codedHeight: 16,
    offsets: Float64Array.of(0),
    sizes: Uint32Array.of(4),
    keyFlags: Uint8Array.of(1),
    tsUs: Float64Array.of(0),
    durUs: Float64Array.of(33_333),
    keyIndices: Uint32Array.of(0),
  }
}

describe('browser-safe normalization lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbGet.mockResolvedValue({ ...assetRow })
    dbUpdate.mockResolvedValue(1)
    backend.getCapabilities.mockResolvedValue(null)
    backend.checkAssets.mockResolvedValue([])
    backend.hashBlob.mockResolvedValue('a'.repeat(64))
    backend.startMediaNormalization.mockResolvedValue({
      id: 'normalize-1',
      status: 'done',
      pct: 100,
      hash: 'a'.repeat(64),
    })
  })

  it('passes supported WebCodecs sources without contacting the backend', async () => {
    await expect(isBrowserVideoSourceSupported(
      new Blob([Uint8Array.of(1)]),
      {
        createSampleIndex: async () => sampleIndex(),
        isConfigSupported: async () => ({ supported: true }),
      },
    )).resolves.toBe(true)
    expect(backend.getCapabilities).not.toHaveBeenCalled()
  })

  it('marks an unsupported source offline without blocking import', async () => {
    await runVideoNormalization(
      assetRow.id,
      new Blob([Uint8Array.of(1)], { type: 'video/webm' }),
      {
        createSampleIndex: async () => { throw new Error('webm demux unsupported') },
        isConfigSupported: async () => ({ supported: false }),
      },
    )

    expect(backend.getCapabilities).toHaveBeenCalled()
    expect(dbUpdate).toHaveBeenCalledWith(assetRow.id, expect.objectContaining({
      normalizationStatus: 'offline',
    }))
    expect(backend.startMediaNormalization).not.toHaveBeenCalled()
  })

  it('publishes the backend result to one OPFS key for preview and export', async () => {
    backend.getCapabilities.mockResolvedValue({ media: true })
    backend.downloadMediaNormalizationTo.mockResolvedValue(undefined)

    await runVideoNormalization(
      assetRow.id,
      new Blob([Uint8Array.of(1)], { type: 'video/webm' }),
      {
        createSampleIndex: async () => { throw new Error('webm demux unsupported') },
        isConfigSupported: async () => ({ supported: false }),
      },
    )

    expect(backend.startMediaNormalization).toHaveBeenCalledWith(
      { hash: 'a'.repeat(64) },
      'clip.webm',
    )
    expect(backend.downloadMediaNormalizationTo).toHaveBeenCalledWith(
      'normalize-1',
      expect.any(Function),
    )
    expect(dbUpdate).toHaveBeenLastCalledWith(assetRow.id, expect.objectContaining({
      normalizedBlobKey: 'video-1__normalized.mp4',
      normalizationStatus: 'done',
      normalizationProgress: 100,
    }))
  })
})
