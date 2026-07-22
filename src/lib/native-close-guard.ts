export interface CloseSaveResult {
  ok: boolean
  error?: unknown
}

export type CloseFailureChoice = 'retry' | 'discard'

interface NativeCloseGuardOptions {
  flush: () => Promise<CloseSaveResult>
  chooseAfterFailure: (reason: 'error' | 'timeout', error?: unknown) => Promise<CloseFailureChoice>
  destroy: () => Promise<void>
  timeoutMs?: number
  /** Honor close after the bounded save attempt without opening a retry dialog. */
  discardOnFailure?: boolean
}

/**
 * Destroy is the preferred Tauri exit path because it bypasses another
 * CloseRequested round-trip. If it rejects or never settles, call close() as a
 * fallback; the caller must keep its committed flag set so that recursive
 * CloseRequested event is allowed through without preventDefault().
 */
export async function destroyNativeWindow(
  destroy: () => Promise<void>,
  close: () => Promise<void>,
  timeoutMs = 1_500,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      destroy(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native window destroy timed out')),
          timeoutMs,
        )
      }),
    ])
  } catch {
    await close()
  } finally {
    clearTimeout(timer)
  }
}

async function flushWithTimeout(
  flush: () => Promise<CloseSaveResult>,
  ms: number,
): Promise<{ result: CloseSaveResult; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ result: { ok: false, error: new Error('Save timed out') }, timedOut: true })
    }, ms)
    void flush().then(
      (result) => {
        clearTimeout(timer)
        resolve({ result, timedOut: false })
      },
      (error) => {
        clearTimeout(timer)
        resolve({ result: { ok: false, error }, timedOut: false })
      },
    )
  })
}

/**
 * Keep retrying a native close save until it succeeds or the user explicitly
 * chooses to discard. A timeout is a failed save, never implicit permission to
 * destroy the window.
 */
export async function guardNativeClose(options: NativeCloseGuardOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  while (true) {
    const { result, timedOut } = await flushWithTimeout(options.flush, timeoutMs)
    if (result.ok) {
      await options.destroy()
      return
    }
    const reason = timedOut ? 'timeout' : 'error'
    const choice = options.discardOnFailure
      ? 'discard'
      : await options.chooseAfterFailure(reason, result.error)
    if (choice === 'discard') {
      await options.destroy()
      return
    }
  }
}
