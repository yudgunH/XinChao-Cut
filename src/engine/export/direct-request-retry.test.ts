import { describe, expect, it } from 'vitest'

import { directStreamRequestWithRetry } from '@engine/backend/client'

describe('direct browser stream retries', () => {
  it('retries transient network failures', async () => {
    let calls = 0
    const response = await directStreamRequestWithRetry(async () => {
      calls++
      if (calls < 3) throw new Error('temporary loopback failure')
      return { ok: true, status: 200 } as Response
    })
    expect(response.ok).toBe(true)
    expect(calls).toBe(3)
  })

  it('does not retry a deterministic 4xx response', async () => {
    let calls = 0
    const response = await directStreamRequestWithRetry(async () => {
      calls++
      return { ok: false, status: 409 } as Response
    })
    expect(response.status).toBe(409)
    expect(calls).toBe(1)
  })

  it('aborts during reconnect backoff', async () => {
    const ac = new AbortController()
    const request = directStreamRequestWithRetry(
      async () => { throw new TypeError('backend restarting') },
      30,
      ac.signal,
    )
    setTimeout(() => ac.abort(), 10)
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
