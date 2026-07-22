export interface BackendRestartSupervisorOptions {
  signal: AbortSignal
  start: () => Promise<boolean>
  probe: () => Promise<boolean>
  onRecovered?: () => void
  maxDelayMs?: number
}

function abortError(): DOMException {
  return new DOMException('Cancelled', 'AbortError')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Restore a backend that was previously online and then crashed.
 *
 * `start` is idempotent on the Rust side, so polling through the backend's
 * 10–30 second cold boot is safe. The loop is abortable and capped to avoid a
 * tight respawn storm when the packaged runtime is genuinely broken.
 */
export async function superviseBackendRestart({
  signal,
  start,
  probe,
  onRecovered,
  maxDelayMs = 30_000,
}: BackendRestartSupervisorOptions): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    const waitMs = Math.min(maxDelayMs, 1_000 * 2 ** Math.min(attempt, 5))
    await delay(waitMs, signal)
    if (signal.aborted) throw abortError()
    await start().catch(() => false)
    if (await probe().catch(() => false)) {
      onRecovered?.()
      return
    }
    attempt++
  }
}
