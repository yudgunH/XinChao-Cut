/**
 * Process-wide in-flight set for media backfill (thumbnail strip / waveform).
 *
 * Keyed by `${assetId}:${kind}` so React effect re-runs (assets array updates)
 * cannot spawn a second FFmpeg/backend job for the same asset while one is live.
 * AbortController aborts the fetch when the asset is removed or no longer needs work.
 */

export type BackfillKind = 'thumbnails' | 'waveform'

const inflight = new Map<string, AbortController>()

export function backfillKey(assetId: string, kind: BackfillKind): string {
  return `${assetId}:${kind}`
}

export function isBackfillInFlight(assetId: string, kind: BackfillKind): boolean {
  return inflight.has(backfillKey(assetId, kind))
}

/**
 * Claim the slot for this asset+kind. Returns null if already running.
 * Caller must call `endBackfill` in a finally block with the same controller.
 */
export function beginBackfill(assetId: string, kind: BackfillKind): AbortController | null {
  const key = backfillKey(assetId, kind)
  if (inflight.has(key)) return null
  const ac = new AbortController()
  inflight.set(key, ac)
  return ac
}

/** Release the slot only if `ac` is still the registered controller. */
export function endBackfill(assetId: string, kind: BackfillKind, ac: AbortController): void {
  const key = backfillKey(assetId, kind)
  if (inflight.get(key) === ac) inflight.delete(key)
}

/** Test helper — clear all slots. */
export function resetBackfillInFlightForTests(): void {
  for (const ac of inflight.values()) {
    try {
      ac.abort()
    } catch {
      /* ignore */
    }
  }
  inflight.clear()
}

/** Test helper — number of live slots. */
export function backfillInFlightCountForTests(): number {
  return inflight.size
}
