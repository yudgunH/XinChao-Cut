const ROOT_NAME = 'xinchao-cut-media'

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(ROOT_NAME, { create: true })
}

export async function writeBlob(key: string, blob: Blob): Promise<void> {
  const dir = await rootDir()
  const handle = await dir.getFileHandle(key, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
  } catch (e) {
    try {
      await writable.abort()
    } catch {
      /* ignore */
    }
    throw e
  }
}

/**
 * Open a raw writable stream for incremental, positioned writes (used by the
 * exporter to stream the MP4 to disk instead of building it in memory).
 * Caller must close() (or abort() on failure) the stream.
 */
export async function createWritable(key: string): Promise<FileSystemWritableFileStream> {
  const dir = await rootDir()
  const handle = await dir.getFileHandle(key, { create: true })
  return handle.createWritable()
}

/** Stream to scratch and publish only after a complete, flushed write. */
export async function writeStreamAtomic(
  tempKey: string,
  finalKey: string,
  produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<void> {
  const writable = await createWritable(tempKey)
  let closed = false
  try {
    await produce(async (chunk) => writable.write(chunk))
    await writable.close()
    closed = true
    await publishBlob(tempKey, finalKey)
  } catch (error) {
    if (!closed) {
      try { await writable.abort() } catch { /* best effort */ }
    }
    throw error
  } finally {
    await deleteBlob(tempKey).catch(() => undefined)
  }
}

export async function readBlob(key: string): Promise<Blob | null> {
  try {
    const dir = await rootDir()
    const handle = await dir.getFileHandle(key)
    return await handle.getFile()
  } catch {
    return null
  }
}

export async function deleteBlob(key: string): Promise<void> {
  try {
    const dir = await rootDir()
    await dir.removeEntry(key)
  } catch (error) {
    // Idempotent delete: a missing key is success. Permission/lock/I/O errors
    // must propagate so callers do not delete the owning DB row and orphan GBs.
    if (error instanceof DOMException && error.name === 'NotFoundError') return
    throw error
  }
}

export async function getObjectUrl(key: string): Promise<string | null> {
  const blob = await readBlob(key)
  return blob ? URL.createObjectURL(blob) : null
}

/** List all entry names in the media OPFS directory. */
export async function listKeys(): Promise<string[]> {
  const dir = await rootDir()
  const keys: string[] = []
  // FileSystemDirectoryHandle is async-iterable in supporting browsers.
  const iter = dir as FileSystemDirectoryHandle & {
    values?: () => AsyncIterable<{ name: string }>
    entries?: () => AsyncIterable<[string, { name: string }]>
  }
  if (typeof iter.entries === 'function') {
    for await (const [name] of iter.entries()) keys.push(name)
  } else if (typeof iter.values === 'function') {
    for await (const handle of iter.values()) keys.push(handle.name)
  }
  return keys
}

/** Age of a key in ms (now - lastModified), or null if missing. */
export async function getKeyAgeMs(key: string, now = Date.now()): Promise<number | null> {
  try {
    const dir = await rootDir()
    const handle = await dir.getFileHandle(key)
    const file = await handle.getFile()
    return Math.max(0, now - file.lastModified)
  } catch {
    return null
  }
}

/** Remove abandoned per-window export scratch files without touching a live key. */
export async function cleanupStaleExportScratch(
  activeKey: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  let removed = 0
  for (const key of await listKeys()) {
    if (key === activeKey) continue
    if (key !== '__export-tmp.mp4' && !key.startsWith('__export-tmp-')) continue
    const age = await getKeyAgeMs(key)
    if (age === null || age < maxAgeMs) continue
    await deleteBlob(key)
    removed++
  }
  return removed
}

/**
 * Promote temp → final without a full JS re-buffer of multi-GB media.
 *
 * Prefer directory `move` (rename) when the browser supports it — zero extra
 * disk I/O. Otherwise stream the File into a final writable (browser streams
 * the Blob; we never `arrayBuffer()` the whole object). On failure the partial
 * final key is removed so callers do not need a second full read to clean up.
 *
 * Note: the default import path writes the unique final key once under lease
 * and does not call this; kept for adapters / explicit promote.
 */
export async function publishBlob(tempKey: string, finalKey: string): Promise<void> {
  if (tempKey === finalKey) return

  const dir = await rootDir()
  const movable = dir as FileSystemDirectoryHandle & {
    move?: (name: string, destination: string | { destDir?: FileSystemDirectoryHandle; name?: string }) => Promise<void>
  }

  // 1) Atomic rename when available (Chrome OPFS move) — no second full write.
  if (typeof movable.move === 'function') {
    try {
      await movable.move(tempKey, finalKey)
      return
    } catch {
      /* fall through to stream copy */
    }
  }

  // 2) Stream temp file → final writable. Do not readBlob()+writeBlob() which
  //    re-materializes and re-writes the entire multi-GB payload.
  let srcFile: File
  try {
    const srcHandle = await dir.getFileHandle(tempKey)
    srcFile = await srcHandle.getFile()
  } catch {
    throw new Error(`Missing temp blob: ${tempKey}`)
  }

  const destHandle = await dir.getFileHandle(finalKey, { create: true })
  const writable = await destHandle.createWritable()
  try {
    // FileSystemWritableFileStream accepts Blob/File and streams under the hood.
    await writable.write(srcFile)
    await writable.close()
  } catch (e) {
    try {
      await writable.abort()
    } catch {
      /* ignore */
    }
    try {
      await dir.removeEntry(finalKey)
    } catch {
      /* ignore partial final */
    }
    throw e
  }
  // Temp left for the caller to delete (rename path already removed it).
}
