import { describe, expect, it, vi } from 'vitest'

import { superviseBackendRestart } from './restart-supervisor'

describe('backend restart supervisor', () => {
  it('retries with backoff until the backend is healthy', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const start = vi.fn(async () => true)
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const recovered = vi.fn()

    const run = superviseBackendRestart({
      signal: ac.signal,
      start,
      probe,
      onRecovered: recovered,
    })
    await vi.advanceTimersByTimeAsync(3_000)
    await run

    expect(start).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(recovered).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('stops promptly when the app/export is shutting down', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const start = vi.fn(async () => false)
    const run = superviseBackendRestart({
      signal: ac.signal,
      start,
      probe: async () => false,
    })

    ac.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
