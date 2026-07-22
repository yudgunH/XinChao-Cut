import { describe, expect, it, beforeEach } from 'vitest'

import type { MediaAsset } from './types'
import {
  EXPORT_TMP_KEY,
  IMPORT_TMP_GRACE_MS,
  IMPORT_TMP_PREFIX,
  MediaImportError,
  formatImportErrorForUi,
  getActiveImportLeases,
  isTempImportKey,
  makeFinalStorageKey,
  makeTempImportKey,
  registerImportLease,
  releaseImportLease,
  runImportTransaction,
  sweepOrphanMedia,
  writeKeyTransactional,
  type ImportCheckpoint,
  type ImportDbAdapter,
  type ImportStorageAdapter,
  type ImportWritable,
} from './import-transaction'

/** In-memory OPFS mock with injectable failures and ages. */
class MemoryStorage implements ImportStorageAdapter {
  files = new Map<string, { blob: Blob; mtime: number }>()
  failAt: ImportCheckpoint | null = null
  now = Date.now()

  async createWritable(key: string): Promise<ImportWritable> {
    if (this.failAt === 'create_writable') throw new Error('injected create_writable')
    const chunks: BlobPart[] = []
    let aborted = false
    return {
      write: async (data) => {
        if (this.failAt === 'write') throw new Error('injected write')
        if (aborted) throw new Error('aborted')
        chunks.push(data as BlobPart)
      },
      close: async () => {
        if (this.failAt === 'close_writable') throw new Error('injected close')
        this.files.set(key, { blob: new Blob(chunks), mtime: this.now })
      },
      abort: async () => {
        aborted = true
        // Partial write discarded — key not published.
      },
    }
  }

  async getObjectUrl(key: string): Promise<string | null> {
    const entry = this.files.get(key)
    if (!entry) return null
    return `blob:mock/${key}`
  }

  async publish(tempKey: string, finalKey: string): Promise<void> {
    if (this.failAt === 'publish') throw new Error('injected publish')
    const entry = this.files.get(tempKey)
    if (!entry) throw new Error('missing temp')
    this.files.set(finalKey, { blob: entry.blob, mtime: this.now })
  }

  async deleteKey(key: string): Promise<void> {
    this.files.delete(key)
  }

  async listKeys(): Promise<string[]> {
    return [...this.files.keys()]
  }

  async getKeyAgeMs(key: string, now: number): Promise<number | null> {
    const e = this.files.get(key)
    if (!e) return null
    return Math.max(0, now - e.mtime)
  }

  keys(): string[] {
    return [...this.files.keys()].sort()
  }
}

class MemoryDb implements ImportDbAdapter {
  rows = new Map<string, MediaAsset>()
  failPut = false

  async putAsset(asset: MediaAsset): Promise<void> {
    if (this.failPut) throw new Error('injected db_put')
    this.rows.set(asset.id, asset)
  }

  async listReferencedKeys(): Promise<Set<string>> {
    const s = new Set<string>()
    for (const a of this.rows.values()) {
      if (a.storageKey) s.add(a.storageKey)
      if (a.proxyStorageKey) s.add(a.proxyStorageKey)
    }
    return s
  }

  assetIds(): string[] {
    return [...this.rows.keys()].sort()
  }
}

function makeFile(name = 'clip.mp4', size = 16): File {
  return new File([new Uint8Array(size)], name, { type: 'video/mp4' })
}

async function run(
  storage: MemoryStorage,
  db: MemoryDb,
  extra: Partial<Parameters<typeof runImportTransaction>[0]> = {},
) {
  return runImportTransaction({
    file: makeFile(),
    projectId: 'proj-1',
    kind: 'video',
    storage,
    db,
    probe: async () => ({ durationSec: 10, width: 640, height: 360 }),
    captureThumbnail: async () => 'data:image/png;base64,xxx',
    createAssetId: () => 'asset-fixed',
    now: () => 1_000_000,
    ...extra,
  })
}

beforeEach(() => {
  // Clear any leftover leases from prior tests.
  for (const id of [...getActiveImportLeases().keys()]) releaseImportLease(id)
})

describe('key helpers', () => {
  it('temp vs final keys', () => {
    expect(makeTempImportKey('a1')).toBe(`${IMPORT_TMP_PREFIX}a1`)
    expect(isTempImportKey(makeTempImportKey('a1'))).toBe(true)
    expect(isTempImportKey(makeFinalStorageKey('a1', 'x.mp4'))).toBe(false)
  })
})

describe('runImportTransaction — happy path', () => {
  it('publishes final, writes DB, deletes temp', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const { asset, finalKey, tempKey } = await run(storage, db)
    expect(asset.id).toBe('asset-fixed')
    expect(asset.storageKey).toBe(finalKey)
    expect(asset.projectId).toBe('proj-1')
    expect(db.rows.has('asset-fixed')).toBe(true)
    expect(storage.keys()).toEqual([finalKey].sort())
    expect(storage.files.has(tempKey)).toBe(false)
    expect(getActiveImportLeases().size).toBe(0)
  })

  it('image thumbnail is durable data URL; probe blob: always revoked (#15)', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const revoked: string[] = []
    const realRevoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (u: string) => {
      revoked.push(u)
      try {
        realRevoke(u)
      } catch {
        /* mock urls */
      }
    }
    try {
      const file = new File([new Uint8Array(32)], 'shot.png', { type: 'image/png' })
      const { asset } = await runImportTransaction({
        file,
        projectId: 'proj-1',
        kind: 'image',
        storage,
        db,
        probe: async () => ({ durationSec: 5, width: 100, height: 80 }),
        captureThumbnail: async (url) => {
          // Must not return the live blob: URL — simulate durable JPEG.
          expect(url.startsWith('blob:')).toBe(true)
          return 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
        },
        createAssetId: () => 'img-fixed',
        now: () => 1_000_000,
      })
      expect(asset.thumbnailDataUrl?.startsWith('data:image/')).toBe(true)
      expect(asset.thumbnailDataUrl).not.toMatch(/^blob:/)
      expect(revoked.length).toBeGreaterThanOrEqual(1)
      // After import, reopening only needs storageKey + durable thumb — no retained blob:.
      expect(db.rows.get('img-fixed')?.thumbnailDataUrl?.startsWith('data:')).toBe(true)
    } finally {
      URL.revokeObjectURL = realRevoke
    }
  })

  it('rejects blob: thumbnail from captureThumbnail (does not retain probe URL)', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const file = new File([new Uint8Array(8)], 'a.png', { type: 'image/png' })
    const { asset } = await runImportTransaction({
      file,
      projectId: 'p',
      kind: 'image',
      storage,
      db,
      probe: async () => ({ durationSec: 5, width: 10, height: 10 }),
      captureThumbnail: async (url) => url, // bad: returns probe blob:
      createAssetId: () => 'img-bad',
      now: () => 1,
    })
    expect(asset.thumbnailDataUrl).toBeUndefined()
  })
})

describe('failure injection — no orphan beyond lease rules', () => {
  const cases: ImportCheckpoint[] = [
    'create_writable',
    'write',
    'close_writable',
    'probe',
    'thumbnail',
    'db_put',
    'publish',
    'cancel',
  ]

  for (const checkpoint of cases) {
    it(`fail at ${checkpoint}: no DB row and no leftover uncommitted files`, async () => {
      const storage = new MemoryStorage()
      const db = new MemoryDb()
      if (checkpoint === 'db_put') db.failPut = true
      else if (checkpoint !== 'cancel') storage.failAt = checkpoint

      await expect(
        run(storage, db, {
          failAt: checkpoint === 'db_put' || checkpoint === 'cancel' ? checkpoint : checkpoint,
          failThumbnailHard: checkpoint === 'thumbnail',
        }),
      ).rejects.toBeInstanceOf(MediaImportError)

      expect(db.assetIds()).toEqual([])
      // No final or temp left (rollback).
      expect(storage.keys()).toEqual([])
      expect(getActiveImportLeases().size).toBe(0)
    })
  }

  it('fail at write aborts writable — temp never closed into map', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    storage.failAt = 'write'
    await expect(run(storage, db, { failAt: 'write' })).rejects.toMatchObject({
      code: 'write_failed',
      checkpoint: 'write',
    })
    expect(storage.keys()).toEqual([])
  })

  it('does not commit when an optional thumbnail is aborted', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const controller = new AbortController()

    await expect(run(storage, db, {
      signal: controller.signal,
      captureThumbnail: async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    })).rejects.toMatchObject({ code: 'cancelled' })

    expect(db.assetIds()).toEqual([])
    expect(storage.keys()).toEqual([])
    expect(getActiveImportLeases().size).toBe(0)
  })

  it('quota-like error classifies as quota', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    storage.failAt = null
    const orig = storage.createWritable.bind(storage)
    storage.createWritable = async (key) => {
      const w = await orig(key)
      return {
        ...w,
        write: async () => {
          const err = new DOMException('Quota exceeded', 'QuotaExceededError')
          throw err
        },
      }
    }
    await expect(run(storage, db)).rejects.toMatchObject({ code: 'quota' })
    expect(storage.keys()).toEqual([])
    expect(db.assetIds()).toEqual([])
  })
})

describe('cancel + simulated restart', () => {
  it('AbortSignal cancels before publish', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const ac = new AbortController()
    ac.abort()
    await expect(run(storage, db, { signal: ac.signal })).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(storage.keys()).toEqual([])
    expect(db.assetIds()).toEqual([])
  })

  it('simulated restart: stale temp without lease is swept after grace', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const tempKey = makeTempImportKey('orph-1')
    storage.files.set(tempKey, {
      blob: new Blob([new Uint8Array(4)]),
      mtime: 0,
    })
    const now = IMPORT_TMP_GRACE_MS + 1000
    const result = await sweepOrphanMedia({ storage, db, now })
    expect(result.deleted).toContain(tempKey)
    expect(storage.keys()).toEqual([])
  })

  it('simulated restart: young temp kept (grace)', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const tempKey = makeTempImportKey('young')
    const now = 10_000
    storage.files.set(tempKey, { blob: new Blob([new Uint8Array([1])]), mtime: now - 1000 })
    const result = await sweepOrphanMedia({ storage, db, now })
    expect(result.deleted).not.toContain(tempKey)
    expect(storage.keys()).toContain(tempKey)
  })

  it('active lease protects temp+final during sweep', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const tempKey = makeTempImportKey('live')
    const finalKey = makeFinalStorageKey('live', 'a.mp4')
    storage.files.set(tempKey, { blob: new Blob([new Uint8Array([1])]), mtime: 0 })
    storage.files.set(finalKey, { blob: new Blob([new Uint8Array([1])]), mtime: 0 })
    registerImportLease({
      assetId: 'live',
      tempKey,
      finalKey,
      startedAt: 0,
    })
    const result = await sweepOrphanMedia({
      storage,
      db,
      now: IMPORT_TMP_GRACE_MS * 2,
    })
    expect(result.deleted).not.toContain(tempKey)
    expect(result.deleted).not.toContain(finalKey)
    releaseImportLease('live')
  })

  it('does not delete keys referenced by DB', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const finalKey = makeFinalStorageKey('ok', 'v.mp4')
    storage.files.set(finalKey, { blob: new Blob([new Uint8Array([1])]), mtime: 0 })
    storage.files.set('stray-orphan', { blob: new Blob([new Uint8Array([1])]), mtime: 0 })
    await db.putAsset({
      id: 'ok',
      projectId: 'p',
      kind: 'video',
      name: 'v.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1,
      durationSec: 1,
      storageKey: finalKey,
      createdAt: 0,
    })
    const result = await sweepOrphanMedia({ storage, db, now: IMPORT_TMP_GRACE_MS * 2 })
    expect(result.deleted).toEqual(['stray-orphan'])
    expect(storage.keys()).toEqual([finalKey])
  })

  it('protects export tmp key', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    storage.files.set(EXPORT_TMP_KEY, { blob: new Blob([new Uint8Array([1])]), mtime: 0 })
    const result = await sweepOrphanMedia({ storage, db, now: IMPORT_TMP_GRACE_MS * 2 })
    expect(result.deleted).not.toContain(EXPORT_TMP_KEY)
  })
})

describe('writeKeyTransactional abort', () => {
  it('aborts writable on write failure', async () => {
    const storage = new MemoryStorage()
    let aborted = false
    storage.createWritable = async () => ({
      write: async () => {
        throw new Error('mid-write')
      },
      close: async () => {},
      abort: async () => {
        aborted = true
      },
    })
    await expect(
      writeKeyTransactional(storage, 'k', new Blob([new Uint8Array([1])]), { fileName: 'f' }),
    ).rejects.toBeInstanceOf(MediaImportError)
    expect(aborted).toBe(true)
    expect(storage.keys()).toEqual([])
  })
})

describe('formatImportErrorForUi', () => {
  it('never embeds raw Error stack paths — only file label + safe code text', () => {
    const err = new MediaImportError('quota', 'Storage quota exceeded', { fileName: 'big.mp4' })
    const msg = formatImportErrorForUi(err)
    expect(msg).toContain('big.mp4')
    expect(msg).toMatch(/storage/i)
    expect(msg).not.toMatch(/C:\\|\/Users\//)
  })
})

describe('partial write + db_put after publish rolls back final', () => {
  it('db_put fail removes published final and temp', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    db.failPut = true
    await expect(run(storage, db)).rejects.toMatchObject({
      code: 'db_failed',
    })
    expect(storage.keys()).toEqual([])
    expect(db.assetIds()).toEqual([])
  })

  it('fail MID final write (not before): no orphan final key, disk not bloated', async () => {
    const storage = new MemoryStorage()
    const db = new MemoryDb()
    const finalKey = makeFinalStorageKey('asset-fixed', 'clip.mp4')
    const fileBytes = 64
    let sawPartialFinal = false
    let peakKeys = 0
    let peakBytes = 0

    const measure = () => {
      peakKeys = Math.max(peakKeys, storage.files.size)
      let bytes = 0
      for (const { blob } of storage.files.values()) bytes += blob.size
      peakBytes = Math.max(peakBytes, bytes)
    }

    const origCreate = storage.createWritable.bind(storage)
    storage.createWritable = async (key: string) => {
      const w = await origCreate(key)
      if (key !== finalKey) return w
      return {
        write: async () => {
          // Partial final appears on disk, then the stream fails mid-write.
          storage.files.set(key, {
            blob: new Blob([new Uint8Array(8)]), // partial << full file
            mtime: storage.now,
          })
          sawPartialFinal = true
          measure()
          throw new Error('injected mid-final-write')
        },
        close: w.close,
        // Leave the partial key — rollback (publishStarted) must delete it.
        abort: async () => {},
      }
    }

    await expect(run(storage, db, { file: makeFile('clip.mp4', fileBytes) })).rejects.toMatchObject({
      code: 'write_failed',
    })

    expect(sawPartialFinal).toBe(true)
    // After rollback: no final, no temp, no DB row — disk not left bloated.
    expect(storage.keys()).toEqual([])
    expect(db.assetIds()).toEqual([])
    expect(storage.files.has(finalKey)).toBe(false)
    // Peak held at most one partial object, never 2× full file (temp+final).
    expect(peakKeys).toBeLessThanOrEqual(1)
    expect(peakBytes).toBeLessThan(fileBytes)
  })
})
