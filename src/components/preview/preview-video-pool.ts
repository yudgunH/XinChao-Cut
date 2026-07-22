/**
 * Preview <video> element pool keyed by *source-time mapping* (same key as
 * export's ExportReaderPool / sourceMappingKey).
 *
 * One element per concurrent mapping — two overlapping clips of the same asset
 * with different in-points get independent currentTime/seek.
 *
 * **Idle cap vs active set**
 * - `max` (DEFAULT_MAX_PREVIEW_VIDEOS) caps only **idle** slots kept for reuse.
 * - Mappings in `protectKeys` (active under the playhead) may temporarily exceed
 *   the cap — each protected key always owns its own element.
 * - Leaving the active set makes a slot idle; `trimIdle` evicts LRU idle until
 *   idle count ≤ max.
 * - NEVER hand out another mapping's element (wrong currentTime / wrong frame).
 * - If create fails (decoder pressure), return null — caller draws a placeholder.
 */

import type { Clip } from '@engine/timeline'
import { sourceMappingKey } from '@engine/export/reader-pool'

export const DEFAULT_MAX_PREVIEW_VIDEOS = 6
export const DEFAULT_MAX_ACTIVE_PREVIEW_VIDEOS = 12

const CONTINUOUS_EDGE_EPS_SEC = 1e-4

const elementCleanup = new WeakMap<HTMLVideoElement, () => void>()
const elementInstanceKey = new WeakMap<HTMLVideoElement, (key: string) => void>()

export { sourceMappingKey }

type PreviewPlaybackClip = Pick<
  Clip,
  'id' | 'trackId' | 'assetId' | 'startSec' | 'inPointSec' | 'outPointSec' | 'speed'
>

function previewClipEndSec(clip: PreviewPlaybackClip): number {
  return clip.startSec + (clip.outPointSec - clip.inPointSec) / Math.max(clip.speed, 0.01)
}

/**
 * Build preview decoder keys that keep ONE `<video>` playing straight through
 * adjacent source-continuous pieces of the same asset.
 *
 * A speed-adjusted timeline can split the source into many short clips, each
 * with its own speed but with `outPoint(prev) === inPoint(next)` — the source
 * never jumps. Keyed by the affine {@link sourceMappingKey}, every such
 * boundary swapped decoder elements and forced a seek; at 2–4x spans the
 * transport outruns those seeks and playback degrades into a freeze/seek
 * carousel. A shared chain key removes the seeks entirely: the element keeps
 * decoding forward and only `playbackRate` changes at the boundary.
 *
 * A chain is only formed when the pieces are on the SAME track, touch on the
 * timeline (≤{@link CONTINUOUS_EDGE_EPS_SEC}), and continue the source exactly.
 * True cuts, gaps, and concurrent tracks keep independent affine keys and the
 * existing look-ahead/seek behaviour. Export readers are NOT affected — they
 * intentionally keep per-mapping decoders.
 */
export function buildPreviewPlaybackKeyMap(
  clips: readonly PreviewPlaybackClip[],
): Map<string, string> {
  const result = new Map<string, string>()
  const byTrack = new Map<string, PreviewPlaybackClip[]>()
  for (const clip of clips) {
    if (!clip.assetId) continue
    const trackClips = byTrack.get(clip.trackId) ?? []
    trackClips.push(clip)
    byTrack.set(clip.trackId, trackClips)
  }

  for (const [trackId, trackClips] of byTrack) {
    trackClips.sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
    let groupStart = 0
    while (groupStart < trackClips.length) {
      let groupEnd = groupStart + 1
      while (groupEnd < trackClips.length) {
        const previous = trackClips[groupEnd - 1]!
        const next = trackClips[groupEnd]!
        const continuous =
          previous.assetId === next.assetId &&
          Math.abs(previewClipEndSec(previous) - next.startSec) <= CONTINUOUS_EDGE_EPS_SEC &&
          Math.abs(previous.outPointSec - next.inPointSec) <= CONTINUOUS_EDGE_EPS_SEC
        if (!continuous) break
        groupEnd += 1
      }

      if (groupEnd - groupStart > 1) {
        const first = trackClips[groupStart]!
        // Include the asset in the identity. Clip ids normally survive a
        // replace-source edit, so `track + first clip` alone could hit a slot
        // that still belongs to the previous asset. `acquire` can rebind its
        // URL, but the stale slot assetId would then break asset disposal.
        const chainKey = `preview-chain|asset=${first.assetId}|track=${trackId}|first=${first.id}`
        for (let i = groupStart; i < groupEnd; i += 1) result.set(trackClips[i]!.id, chainKey)
      } else {
        const only = trackClips[groupStart]!
        result.set(only.id, sourceMappingKey(only))
      }
      groupStart = groupEnd
    }
  }

  return result
}

export interface PreviewVideoSlot {
  key: string
  assetId: string
  el: HTMLVideoElement
  lastUsed: number
}

export interface PreviewVideoPoolHooks {
  /** Frame presented / seek settled for this instance key. */
  onFrame: (instanceKey: string) => void
  /** Element failed to load/decode. */
  onError: (instanceKey: string, el: HTMLVideoElement) => void
  /** An idle element was transferred to another source-time mapping. */
  onReassign?: (oldKey: string, newKey: string, el: HTMLVideoElement) => void
}

export type CreateVideoEl = (
  url: string,
  instanceKey: string,
  hooks: PreviewVideoPoolHooks,
) => HTMLVideoElement

/**
 * Build / wire a detached <video> for preview playback.
 * Caller owns lifecycle (pause, detach src, close VideoFrame caches).
 */
export function createPreviewVideoElement(
  url: string,
  instanceKey: string,
  hooks: PreviewVideoPoolHooks,
): HTMLVideoElement {
  const el = document.createElement('video')
  let currentInstanceKey = instanceKey
  // Path-backed sources are cross-origin (Tauri asset protocol) — keep GPU-clean.
  el.crossOrigin = 'anonymous'
  el.src = url
  el.preload = 'metadata'
  el.muted = true
  el.playsInline = true

  const onFrame = () => hooks.onFrame(currentInstanceKey)
  const onError = () => hooks.onError(currentInstanceKey, el)
  el.addEventListener('seeked', onFrame)
  el.addEventListener('loadeddata', onFrame)
  el.addEventListener('loadedmetadata', onFrame)
  el.addEventListener('canplay', onFrame)
  el.addEventListener('error', onError)

  const videoFrameApi = el as unknown as {
    requestVideoFrameCallback?: (cb: () => void) => number
    cancelVideoFrameCallback?: (id: number) => void
  }
  const requestVFC = videoFrameApi.requestVideoFrameCallback?.bind(el)
  let vfcId: number | null = null
  let disposed = false

  const captureFrame = () => {
    if (disposed) return
    // Caller checks pool identity before using the frame; keep the loop alive
    // while the element is still attached to a slot.
    hooks.onFrame(currentInstanceKey)
    vfcId = requestVFC?.(captureFrame) ?? null
  }
  vfcId = requestVFC?.(captureFrame) ?? null

  elementCleanup.set(el, () => {
    disposed = true
    if (vfcId !== null) videoFrameApi.cancelVideoFrameCallback?.(vfcId)
    vfcId = null
    el.removeEventListener('seeked', onFrame)
    el.removeEventListener('loadeddata', onFrame)
    el.removeEventListener('loadedmetadata', onFrame)
    el.removeEventListener('canplay', onFrame)
    el.removeEventListener('error', onError)
  })
  elementInstanceKey.set(el, (key) => {
    currentInstanceKey = key
  })

  el.load()
  return el
}

export class PreviewVideoPool {
  private readonly slots = new Map<string, PreviewVideoSlot>()
  /** Keys that needed an element but create failed / refused — intentional degrade. */
  private readonly degraded = new Set<string>()
  readonly max: number
  readonly maxActive: number
  private readonly createEl: CreateVideoEl

  constructor(
    max = DEFAULT_MAX_PREVIEW_VIDEOS,
    createEl: CreateVideoEl = createPreviewVideoElement,
    maxActive = DEFAULT_MAX_ACTIVE_PREVIEW_VIDEOS,
  ) {
    this.max = Math.max(1, max)
    this.maxActive = Math.max(this.max, maxActive)
    this.createEl = createEl
  }

  get(key: string): HTMLVideoElement | undefined {
    const s = this.slots.get(key)
    if (s) s.lastUsed = performance.now()
    return s?.el
  }

  has(key: string): boolean {
    return this.slots.has(key)
  }

  keys(): string[] {
    return [...this.slots.keys()]
  }

  /** assetId for a live instance, if any. */
  assetIdOf(key: string): string | undefined {
    return this.slots.get(key)?.assetId
  }

  entries(): IterableIterator<[string, PreviewVideoSlot]> {
    return this.slots.entries()
  }

  /** Mapping keys that currently have no element (placeholder path). */
  degradedKeys(): string[] {
    return [...this.degraded]
  }

  isDegraded(key: string): boolean {
    return this.degraded.has(key)
  }

  /**
   * Ensure a live element for `key`.
   *
   * - Protected keys (in `protectKeys`) always get their **own** element, even
   *   when that temporarily pushes total size above `max`.
   * - Idle retention is capped: non-protected victims are LRU-evicted first.
   * - Never returns another mapping's element.
   * - Returns null only on intentional degrade (create failure / idle refused).
   */
  acquire(
    key: string,
    assetId: string,
    url: string,
    protectKeys: ReadonlySet<string>,
    hooks: PreviewVideoPoolHooks,
  ): HTMLVideoElement | null {
    if (!key || !url) return null
    const hit = this.slots.get(key)
    if (hit) {
      hit.lastUsed = performance.now()
      this.degraded.delete(key)
      // Proxy/original swap: rebind when the shared asset URL changed.
      if (hit.el.src !== url && hit.el.getAttribute('src') !== url) {
        hit.el.src = url
        hit.el.load()
      }
      return hit.el
    }

    const isProtected = protectKeys.has(key)

    // Clip boundaries commonly change the affine source mapping even when the
    // asset is unchanged. Transfer an idle element instead of opening another
    // resident decoder while the previous one is still alive. Concurrent
    // protected mappings are never touched.
    const idleSlots = this.idleSlots(protectKeys)
    // A same-asset idle slot already points at this url, so reassigning it costs
    // no reload — always prefer it for trim/mapping changes on the same clip.
    const sameAssetIdle = idleSlots
      .filter((slot) => slot.assetId === assetId)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]
    // Stealing a DIFFERENT asset's idle element forces a full src reload, which
    // makes scrubbing back and forth between two clips re-decode every time. Only
    // do it when the pool is already at capacity (creating fresh would evict one
    // anyway); under capacity, keep the other clip's element warm for a pool hit.
    const differentAssetIdle =
      this.slots.size >= this.max
        ? idleSlots
            .filter((slot) => slot.assetId !== assetId)
            .sort((a, b) => a.lastUsed - b.lastUsed)[0]
        : undefined
    const idle = sameAssetIdle ?? differentAssetIdle
    if (idle) {
      const oldKey = idle.key
      this.slots.delete(oldKey)
      this.degraded.delete(oldKey)
      idle.key = key
      idle.assetId = assetId
      idle.lastUsed = performance.now()
      elementInstanceKey.get(idle.el)?.(key)
      this.slots.set(key, idle)
      this.degraded.delete(key)
      hooks.onReassign?.(oldKey, key, idle.el)
      if (idle.el.src !== url && idle.el.getAttribute('src') !== url) {
        idle.el.src = url
        idle.el.load()
      }
      return idle.el
    }

    // Free idle slots first (never touch other protected mappings).
    this.evictIdleUntil(this.max - (isProtected ? 0 : 1), protectKeys, hooks)

    // After eviction: if still at/over max and this key is not protected, do
    // not grow idle cache — caller should not hold a cold slot past the cap.
    if (!isProtected && this.slots.size >= this.max) {
      this.degraded.add(key)
      return null
    }
    if (isProtected && this.slots.size >= this.maxActive) {
      this.degraded.add(key)
      return null
    }

    // Protected: create even if size >= max (active-set overflow).
    // Idle: only create when size < max (guaranteed by eviction / check above).
    let el: HTMLVideoElement
    try {
      el = this.createEl(url, key, hooks)
    } catch {
      // Hardware decoder limit / factory failure — intentional degrade.
      this.degraded.add(key)
      return null
    }
    if (!el) {
      this.degraded.add(key)
      return null
    }

    this.slots.set(key, {
      key,
      assetId,
      el,
      lastUsed: performance.now(),
    })
    this.degraded.delete(key)
    return el
  }

  /**
   * Drop idle (non-protected) slots until idle count ≤ max.
   * Call once per frame after the active set is known so leaving playhead
   * immediately reclaims elements.
   */
  trimIdle(protectKeys: ReadonlySet<string>, hooks?: PreviewVideoPoolHooks): string[] {
    return this.evictIdleUntil(this.max, protectKeys, hooks)
  }

  /** Drop one instance (pause, clear src, remove from map). Does not revoke URL. */
  disposeKey(key: string, hooks?: PreviewVideoPoolHooks): HTMLVideoElement | undefined {
    const s = this.slots.get(key)
    if (!s) return undefined
    this.slots.delete(key)
    this.degraded.delete(key)
    try {
      elementCleanup.get(s.el)?.()
      elementCleanup.delete(s.el)
      elementInstanceKey.delete(s.el)
      s.el.pause()
      s.el.removeAttribute('src')
      s.el.load()
    } catch {
      /* ignore */
    }
    void hooks // reserved for future unbind
    return s.el
  }

  /** Dispose every instance for an asset (asset removed from timeline). */
  disposeAsset(assetId: string): string[] {
    const removed: string[] = []
    for (const [key, s] of [...this.slots.entries()]) {
      if (s.assetId === assetId) {
        this.disposeKey(key)
        removed.push(key)
      }
    }
    return removed
  }

  disposeAll(): string[] {
    const keys = [...this.slots.keys()]
    for (const k of keys) this.disposeKey(k)
    this.degraded.clear()
    return keys
  }

  /**
   * Evict LRU non-protected slots until idle count ≤ `idleCap`.
   * Returns disposed keys.
   */
  private evictIdleUntil(
    idleCap: number,
    protectKeys: ReadonlySet<string>,
    hooks?: PreviewVideoPoolHooks,
  ): string[] {
    const disposed: string[] = []
    const cap = Math.max(0, idleCap)
    for (;;) {
      const idle = this.idleSlots(protectKeys)
      if (idle.length <= cap) break
      // LRU among idle
      idle.sort((a, b) => a.lastUsed - b.lastUsed)
      const victim = idle[0]
      if (!victim) break
      this.disposeKey(victim.key, hooks)
      disposed.push(victim.key)
    }
    return disposed
  }

  private idleSlots(protectKeys: ReadonlySet<string>): PreviewVideoSlot[] {
    const out: PreviewVideoSlot[] = []
    for (const s of this.slots.values()) {
      if (!protectKeys.has(s.key)) out.push(s)
    }
    return out
  }
}

/** Collect mapping keys for clips that need independent preview decoders. */
export function activeVideoMappingKeys(
  clips: Array<Pick<Clip, 'assetId' | 'startSec' | 'inPointSec' | 'speed'>>,
): Set<string> {
  const keys = new Set<string>()
  for (const c of clips) {
    const k = sourceMappingKey(c)
    if (k) keys.add(k)
  }
  return keys
}
