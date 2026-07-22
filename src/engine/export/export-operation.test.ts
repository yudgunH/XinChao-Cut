import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ExportOperationOwner,
  isBlobObjectUrl,
  revokeBlobUrlOnce,
} from './export-operation'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isBlobObjectUrl / revokeBlobUrlOnce', () => {
  it('detects blob: only', () => {
    expect(isBlobObjectUrl('blob:http://localhost/abc')).toBe(true)
    expect(isBlobObjectUrl('http://127.0.0.1:8000/export/x')).toBe(false)
    expect(isBlobObjectUrl('https://cdn.example/out.mp4')).toBe(false)
    expect(isBlobObjectUrl(null)).toBe(false)
  })

  it('revokes blob once and never http', () => {
    const revoked = new Set<string>()
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    expect(revokeBlobUrlOnce('http://server/job/1', revoked)).toBe(false)
    expect(spy).not.toHaveBeenCalled()

    expect(revokeBlobUrlOnce('blob:local/1', revoked)).toBe(true)
    expect(revokeBlobUrlOnce('blob:local/1', revoked)).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('blob:local/1')
  })
})

describe('ExportOperationOwner', () => {
  it('double-click tryBegin only creates one operation', () => {
    const owner = new ExportOperationOwner()
    let n = 0
    const id = () => `op-${++n}`
    const a = owner.tryBegin(id)
    const b = owner.tryBegin(id)
    expect(a).not.toBeNull()
    expect(b).toBeNull()
    expect(owner.getOperationId()).toBe('op-1')
    expect(owner.isBusy()).toBe(true)
    expect(owner.canStart()).toBe(false)
    expect(n).toBe(1)
  })

  it('cancel A then tryBegin B is blocked until A settles', async () => {
    const owner = new ExportOperationOwner()
    const a = owner.tryBegin(() => 'A')!
    expect(owner.requestCancel()).toBe(true)
    expect(owner.getPhase()).toBe('cancelling')
    expect(owner.canStart()).toBe(false)
    expect(owner.tryBegin(() => 'B')).toBeNull()

    // Simulate async work noticing abort
    expect(a.abort.signal.aborted).toBe(true)
    owner.settle('A')
    expect(owner.getPhase()).toBe('idle')
    expect(owner.canStart()).toBe(true)

    const b = owner.tryBegin(() => 'B')
    expect(b?.id).toBe('B')
  })

  it('stale completion A does not clear or overwrite operation B', () => {
    const owner = new ExportOperationOwner()
    owner.tryBegin(() => 'A')
    owner.settle('A')
    owner.tryBegin(() => 'B')

    // Late settle/progress from A
    owner.settle('A')
    expect(owner.getOperationId()).toBe('B')
    expect(owner.getPhase()).toBe('busy')

    owner.setOutputUrl('A', 'blob:stale-from-A')
    expect(owner.getOutputUrl()).toBeNull()
    expect(owner.wasRevoked('blob:stale-from-A')).toBe(true)

    owner.setOutputUrl('B', 'blob:from-B')
    expect(owner.getOutputUrl()).toBe('blob:from-B')
  })

  it('close during preprocessing aborts and blocks continuation via isCurrent', () => {
    const owner = new ExportOperationOwner()
    const op = owner.tryBegin(() => 'prep')!
    // "close" = dispose
    owner.dispose()
    expect(op.abort.signal.aborted).toBe(true)
    expect(owner.isCurrent('prep')).toBe(false)
    expect(owner.getPhase()).toBe('idle')
    // Continuation would check isCurrent before starting worker
    expect(owner.isCurrent(op.id)).toBe(false)
  })

  it('unmount while "server polling" aborts signal so poll can stop', () => {
    const owner = new ExportOperationOwner()
    const op = owner.tryBegin(() => 'server')!
    const signal = op.abort.signal
    owner.dispose()
    expect(signal.aborted).toBe(true)
    expect(owner.isBusy()).toBe(false)
  })

  it('blob URL replacement revokes previous once; http never revoked', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const owner = new ExportOperationOwner()
    owner.tryBegin(() => 'op')

    owner.setOutputUrl('op', 'blob:first')
    owner.setOutputUrl('op', 'blob:second')
    expect(owner.wasRevoked('blob:first')).toBe(true)
    expect(spy).toHaveBeenCalledWith('blob:first')
    expect(spy).toHaveBeenCalledTimes(1)

    owner.setOutputUrl('op', 'http://127.0.0.1:8000/export/job/1')
    expect(owner.wasRevoked('blob:second')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    // HTTP must never appear in revoke calls
    expect(spy.mock.calls.every(([u]) => String(u).startsWith('blob:'))).toBe(true)
    expect(owner.getOutputUrl()).toBe('http://127.0.0.1:8000/export/job/1')

    owner.dispose()
    // dispose clears http without revoke
    expect(spy).toHaveBeenCalledTimes(2)
    expect(owner.getOutputUrl()).toBeNull()
  })

  it('clearOutputUrl and dispose are idempotent', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const owner = new ExportOperationOwner()
    owner.tryBegin(() => 'x')
    owner.setOutputUrl('x', 'blob:once')
    owner.clearOutputUrl()
    owner.clearOutputUrl()
    owner.dispose()
    owner.dispose()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('settle is idempotent for the same id', () => {
    const owner = new ExportOperationOwner()
    owner.tryBegin(() => 'A')
    owner.settle('A')
    owner.settle('A')
    expect(owner.getPhase()).toBe('idle')
    expect(owner.canStart()).toBe(true)
  })

  it('whenSettled resolves after settle', async () => {
    const owner = new ExportOperationOwner()
    owner.tryBegin(() => 'A')
    const p = owner.whenSettled()
    owner.settle('A')
    await p
  })
})
