import { describe, expect, it, vi } from 'vitest'

import { discardExportScratch } from './exporter'

describe('discardExportScratch', () => {
  it('aborts before deleting the target key', async () => {
    const order: string[] = []
    const writable = { abort: vi.fn(async () => { order.push('abort') }) }
    const remove = vi.fn(async () => { order.push('delete') })
    await discardExportScratch(writable, '__export-tmp-test.mp4', remove)
    expect(order).toEqual(['abort', 'delete'])
    expect(remove).toHaveBeenCalledWith('__export-tmp-test.mp4')
  })

  it('still deletes when abort rejects', async () => {
    const writable = { abort: vi.fn(async () => { throw new Error('writer lost') }) }
    const remove = vi.fn(async () => {})
    await discardExportScratch(writable, 'scratch.mp4', remove)
    expect(remove).toHaveBeenCalledWith('scratch.mp4')
  })
})
