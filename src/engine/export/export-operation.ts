/**
 * S4 — Export dialog operation ownership (F05) + output URL cleanup (F18).
 *
 * One export "operation" owns:
 *   - a unique id (generation token)
 *   - an AbortController for worker / server / decode cancellation
 *   - busy / cancelling phase independent of render progress %
 *   - the current download URL (blob: revoked on replace/dispose; http kept)
 *
 * Rules:
 *   - tryBegin() fails while busy or cancelling (double-click → one op).
 *   - requestCancel() moves to cancelling; tryBegin stays blocked until settle.
 *   - Every async completion must call isCurrent(id) before mutating UI state.
 *   - settle(id) is idempotent; only the live id releases the lock.
 *   - dispose() aborts + settles + revokes blob URLs (unmount / close).
 */

export type ExportOpPhase = 'idle' | 'busy' | 'cancelling'

export interface LiveExportOperation {
  id: string
  abort: AbortController
}

export function isBlobObjectUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith('blob:')
}

/** Revoke a blob: URL at most once. Never touches http(s) URLs. */
export function revokeBlobUrlOnce(
  url: string | null | undefined,
  alreadyRevoked?: Set<string>,
): boolean {
  if (!isBlobObjectUrl(url)) return false
  if (alreadyRevoked?.has(url!)) return false
  try {
    URL.revokeObjectURL(url!)
  } catch {
    /* ignore double-revoke races in some engines */
  }
  alreadyRevoked?.add(url!)
  return true
}

export class ExportOperationOwner {
  private live: LiveExportOperation | null = null
  private phase: ExportOpPhase = 'idle'
  private outputUrl: string | null = null
  private readonly revoked = new Set<string>()
  /** Resolves when the current operation settles (for tests awaiting cancel). */
  private settleWaiters: Array<() => void> = []

  getPhase(): ExportOpPhase {
    return this.phase
  }

  /** True while an operation is running or winding down after cancel. */
  isBusy(): boolean {
    return this.phase === 'busy' || this.phase === 'cancelling'
  }

  /** Export button may start a new run only when idle. */
  canStart(): boolean {
    return this.phase === 'idle'
  }

  getOperationId(): string | null {
    return this.live?.id ?? null
  }

  getAbortController(): AbortController | null {
    return this.live?.abort ?? null
  }

  getSignal(): AbortSignal | null {
    return this.live?.abort.signal ?? null
  }

  getOutputUrl(): string | null {
    return this.outputUrl
  }

  /** Test helper: whether a blob URL was revoked by this owner. */
  wasRevoked(url: string): boolean {
    return this.revoked.has(url)
  }

  /**
   * Start a new operation. Returns null if busy/cancelling (second click ignored).
   * Creates operation id + AbortController *before* any preprocessing.
   */
  tryBegin(createId: () => string = defaultOpId): LiveExportOperation | null {
    if (!this.canStart()) return null
    const op: LiveExportOperation = {
      id: createId(),
      abort: new AbortController(),
    }
    this.live = op
    this.phase = 'busy'
    return op
  }

  /** User cancel: abort signal + cancelling phase. Lock held until settle. */
  requestCancel(): boolean {
    if (!this.live) return false
    if (this.phase === 'idle') return false
    this.phase = 'cancelling'
    try {
      this.live.abort.abort()
    } catch {
      /* already aborted */
    }
    return true
  }

  isCurrent(id: string): boolean {
    return this.live?.id === id
  }

  isAbortRequested(id: string): boolean {
    if (!this.isCurrent(id) || !this.live) return true
    return this.live.abort.signal.aborted
  }

  /**
   * Release ownership when the operation's promise chain finishes.
   * Idempotent; stale ids are no-ops so settle(A) after begin(B) cannot clear B.
   */
  settle(id: string): void {
    if (!this.live || this.live.id !== id) return
    this.live = null
    this.phase = 'idle'
    const waiters = this.settleWaiters
    this.settleWaiters = []
    for (const w of waiters) w()
  }

  /** Await the next settle (tests / optional UI). Resolves immediately if idle. */
  whenSettled(): Promise<void> {
    if (this.phase === 'idle') return Promise.resolve()
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve)
    })
  }

  /**
   * Assign the download/output URL for the live operation.
   * - Stale id: revoke the *incoming* blob immediately (do not leak), leave state.
   * - Replace previous blob: with exactly one revoke.
   * - HTTP URLs: never revoked.
   */
  setOutputUrl(id: string, url: string | null): void {
    if (!this.isCurrent(id)) {
      revokeBlobUrlOnce(url, this.revoked)
      return
    }
    const prev = this.outputUrl
    if (prev && prev !== url) {
      revokeBlobUrlOnce(prev, this.revoked)
    }
    this.outputUrl = url
  }

  /** Clear output without needing an op id (e.g. starting a fresh export). */
  clearOutputUrl(): void {
    revokeBlobUrlOnce(this.outputUrl, this.revoked)
    this.outputUrl = null
  }

  /**
   * Unmount / dialog close: abort live work, release lock, revoke blob output.
   * Idempotent.
   */
  dispose(): void {
    if (this.live) {
      try {
        this.live.abort.abort()
      } catch {
        /* ignore */
      }
      const id = this.live.id
      this.settle(id)
    }
    this.clearOutputUrl()
    this.phase = 'idle'
    this.live = null
  }
}

function defaultOpId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `export-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
