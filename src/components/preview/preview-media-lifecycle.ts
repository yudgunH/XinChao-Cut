/**
 * S8 / F17 — Preview media working-set helpers.
 *
 * Preview must only retain decoded elements / object URLs / GPU textures for
 * assets currently referenced by the (flattened) timeline. Media-library
 * membership alone is not enough — keeping every imported video alive OOM'd
 * long, densely-cut projects.
 *
 * Async getPreviewObjectUrl must re-check a **per-(assetId, desiredKey) request
 * token** (not a global generation) before committing a new <video>/<img>. A
 * global generation bump on every effect re-run discarded still-valid loads
 * while `loadingIds` skipped re-scheduling → black preview until a later edit.
 *
 * When a resolve is stale but the asset is still on the current frame and
 * nothing else is loading/holding media for it, the pure decision is
 * **requeue** (not silent discard).
 */

/** True when this asset id should keep a live preview element. */
export function shouldRetainPreviewMedia(
  assetId: string,
  usedIds: ReadonlySet<string>,
  assetIdsInProject: ReadonlySet<string>,
): boolean {
  return usedIds.has(assetId) && assetIdsInProject.has(assetId)
}

/** Stable request identity for one preview media load. */
export function makePreviewLoadToken(assetId: string, desiredKey: string): string {
  return `${assetId}::${desiredKey}`
}

export type PreviewUrlResolveAction = 'commit' | 'discard' | 'requeue'

/**
 * Decide what to do when an async media URL resolve finishes.
 *
 * - **commit** — token still matches the desired key and asset is in the working set
 * - **discard** — asset no longer needed, or a newer load / committed media already covers it
 * - **requeue** — asset still needed but this result is stale and nothing else will load it
 */
export function decidePreviewUrlResolve(opts: {
  assetId: string
  /** Token captured when the load was started (`makePreviewLoadToken`). */
  startedToken: string
  /** Latest token for this asset (undefined if disposed / not tracked). */
  currentToken: string | undefined
  usedIds: ReadonlySet<string>
  assetIdsInProject: ReadonlySet<string>
  /** A load for the *current* desire is already in flight. */
  alreadyLoadingCurrent: boolean
  /** Committed pool entry already matches the current desire. */
  alreadyHaveCurrent: boolean
}): PreviewUrlResolveAction {
  if (!shouldRetainPreviewMedia(opts.assetId, opts.usedIds, opts.assetIdsInProject)) {
    return 'discard'
  }
  // Still on the working set. Commit only when this resolve is for the current key.
  if (opts.currentToken !== undefined && opts.currentToken === opts.startedToken) {
    return 'commit'
  }
  // Stale key/request — another path already owns the current desire.
  if (opts.alreadyHaveCurrent || opts.alreadyLoadingCurrent) {
    return 'discard'
  }
  // Active asset, no media, nothing in flight for the current key → must reload.
  return 'requeue'
}

/**
 * Decide whether an async media URL resolve may still commit into the pools.
 * Token/key match is authoritative; optional generation fields are ignored
 * (kept so existing call sites type-check) so an effect re-run no longer
 * invalidates a still-correct in-flight load.
 */
export function canCommitPreviewUrl(opts: {
  assetId: string
  /** @deprecated Ignored — use per-(assetId,key) tokens via decidePreviewUrlResolve. */
  startedGeneration?: number
  /** @deprecated Ignored — global generation caused black-preview stalls. */
  currentGeneration?: number
  /** Storage/proxy key the load was started for. */
  startedKey: string
  /** Key currently desired for this asset (empty if disposed / not tracked). */
  currentKey: string | undefined
  usedIds: ReadonlySet<string>
  assetIdsInProject: ReadonlySet<string>
}): boolean {
  return (
    decidePreviewUrlResolve({
      assetId: opts.assetId,
      startedToken: makePreviewLoadToken(opts.assetId, opts.startedKey),
      currentToken:
        opts.currentKey !== undefined
          ? makePreviewLoadToken(opts.assetId, opts.currentKey)
          : undefined,
      usedIds: opts.usedIds,
      assetIdsInProject: opts.assetIdsInProject,
      alreadyLoadingCurrent: false,
      alreadyHaveCurrent: false,
    }) === 'commit'
  )
}

/** Ids currently held in preview pools that should be disposed. */
export function previewIdsToDispose(
  pooledIds: Iterable<string>,
  usedIds: ReadonlySet<string>,
  assetIdsInProject: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const id of pooledIds) {
    if (!shouldRetainPreviewMedia(id, usedIds, assetIdsInProject)) out.push(id)
  }
  return out
}
