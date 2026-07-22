import { describe, expect, it, vi } from 'vitest'

import {
  destroyNativeWindow,
  guardNativeClose,
  type CloseFailureChoice,
} from './native-close-guard'

describe('guardNativeClose', () => {
  it('does not destroy after a failed save until the user explicitly decides', async () => {
    let resolveChoice!: (choice: CloseFailureChoice) => void
    const choice = new Promise<CloseFailureChoice>((resolve) => { resolveChoice = resolve })
    const destroy = vi.fn(async () => {})

    const closing = guardNativeClose({
      flush: async () => ({ ok: false, error: new Error('disk full') }),
      chooseAfterFailure: () => choice,
      destroy,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(destroy).not.toHaveBeenCalled()

    resolveChoice('discard')
    await closing
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('retries and destroys only after a successful save', async () => {
    const flush = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: new Error('busy') })
      .mockResolvedValueOnce({ ok: true })
    const destroy = vi.fn(async () => {})

    await guardNativeClose({
      flush,
      chooseAfterFailure: async () => 'retry',
      destroy,
    })

    expect(flush).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('honors close after a bounded save failure without opening a dialog', async () => {
    const chooseAfterFailure = vi.fn(async () => 'retry' as const)
    const destroy = vi.fn(async () => {})

    await guardNativeClose({
      flush: async () => ({ ok: false, error: new Error('IndexedDB stuck') }),
      chooseAfterFailure,
      destroy,
      discardOnFailure: true,
      timeoutMs: 5,
    })

    expect(chooseAfterFailure).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('falls back to native close when destroy rejects', async () => {
    const close = vi.fn(async () => {})

    await destroyNativeWindow(
      async () => { throw new Error('destroy denied') },
      close,
      5,
    )

    expect(close).toHaveBeenCalledOnce()
  })

  it('falls back to native close when destroy never settles', async () => {
    const close = vi.fn(async () => {})

    await destroyNativeWindow(
      () => new Promise<void>(() => {}),
      close,
      5,
    )

    expect(close).toHaveBeenCalledOnce()
  })
})
