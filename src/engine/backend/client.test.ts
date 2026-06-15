import { describe, it, expect } from 'vitest'

import { hashBlob } from './client'

const CHUNK = 64 * 1024 * 1024

function blobOf(bytes: number, fill = 0): Blob {
  const u = new Uint8Array(bytes)
  u.fill(fill)
  return new Blob([u])
}

async function sha256Hex(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('hashBlob (fast path, <= 64MB)', () => {
  it('is deterministic for identical content', async () => {
    expect(await hashBlob(blobOf(1000, 7))).toBe(await hashBlob(blobOf(1000, 7)))
  })

  it('equals a plain SHA-256 of the file (back-compatible)', async () => {
    const b = blobOf(2048, 3)
    expect(await hashBlob(b)).toBe(await sha256Hex(b))
  })

  it('changes when content changes', async () => {
    expect(await hashBlob(blobOf(1000, 7))).not.toBe(await hashBlob(blobOf(1000, 8)))
  })

  it('returns 64 hex chars', async () => {
    expect(await hashBlob(blobOf(10))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('hashBlob (chunked path, > 64MB)', () => {
  it('is deterministic, valid hex, and differs from a plain SHA-256', async () => {
    const big = blobOf(CHUNK + 1024, 0) // 2 chunks → Merkle path
    const a = await hashBlob(big)
    const b = await hashBlob(blobOf(CHUNK + 1024, 0))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    // The 2-level hash is intentionally NOT the raw SHA-256 of the whole file.
    expect(a).not.toBe(await sha256Hex(big))
  })

  it('detects a change in the second chunk', async () => {
    const a = blobOf(CHUNK + 1024, 0)
    const u = new Uint8Array(CHUNK + 1024)
    u[CHUNK + 10] = 42 // marker in the 2nd chunk
    const b = new Blob([u])
    expect(await hashBlob(a)).not.toBe(await hashBlob(b))
  })
})
