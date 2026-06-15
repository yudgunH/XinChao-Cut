const ROOT_NAME = 'xinchao-cut-media'

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(ROOT_NAME, { create: true })
}

export async function writeBlob(key: string, blob: Blob): Promise<void> {
  const dir = await rootDir()
  const handle = await dir.getFileHandle(key, { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
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
  } catch {
    /* ignore */
  }
}

export async function getObjectUrl(key: string): Promise<string | null> {
  const blob = await readBlob(key)
  return blob ? URL.createObjectURL(blob) : null
}
