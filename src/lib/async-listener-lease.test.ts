import { describe, expect, it, vi } from 'vitest'

import { AsyncListenerLease } from './async-listener-lease'

describe('AsyncListenerLease', () => {
  it('immediately releases a listener that resolves after disposal', () => {
    const lease = new AsyncListenerLease()
    const unlisten = vi.fn()

    lease.dispose()

    expect(lease.install(unlisten)).toBe(false)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('releases an installed listener exactly once', () => {
    const lease = new AsyncListenerLease()
    const unlisten = vi.fn()

    expect(lease.install(unlisten)).toBe(true)
    lease.dispose()
    lease.dispose()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('releases the previous listener when ownership is replaced', () => {
    const lease = new AsyncListenerLease()
    const first = vi.fn()
    const second = vi.fn()

    lease.install(first)
    lease.install(second)
    lease.dispose()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
