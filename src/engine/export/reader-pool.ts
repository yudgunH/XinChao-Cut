/**
 * S7 / F07 — Export decoder pool keyed by *source-time mapping*, not asset id.
 *
 * Root cause: exporter cached one VideoFrameReader per `asset.id`. Two clips of
 * the same asset with different in-points/speeds (PiP, split reuse) interleaved
 * `getFrameAt` on that single decoder → reset/seek thrash every frame and both
 * layers often showed the same source frame after the second seek.
 *
 * Share rule: one reader per affine source map
 *   sourceSec(t) = inPointSec + (t − startSec) · speed
 *               = speed · t + (inPointSec − startSec · speed)
 * Clips with the same assetId + speed + intercept share a reader (identical
 * source time at any timeline t → one decode + clone is correct).
 *
 * Pool budget: hard cap of {@link DEFAULT_MAX_EXPORT_READERS} **live** decoders
 * (unique non-alias, non-transient readers). When the budget is full:
 *   1. Reuse a same-asset sibling reader (degraded alias — may thrash).
 *   2. Evict a slot whose key is not in the current active set, then create.
 *   3. Overflow: **transient** reader — open decoder (or HTMLVideo degraded),
 *      decode one frame, clone, **close immediately**. Never keep a 7th–Nth
 *      WebCodecs session alive for every concurrent mapping.
 *
 * Does NOT change keyframe seek / DECODE_AHEAD / getFrameAt frame selection
 * inside a permanent reader.
 */

import type { Clip } from '@engine/timeline'
import type { VideoFrameReader } from './frame-reader'

/** Default concurrent **live** decoder budget (each holds ≤ ~8 decoded frames). */
export const DEFAULT_MAX_EXPORT_READERS = 6

/** Quantize floats so equivalent maps share a key despite float noise. */
function q(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/**
 * Stable share key for a video clip's source-time mapping.
 * Empty string when the clip has no asset (not poolable).
 */
export function sourceMappingKey(
  clip: Pick<Clip, 'assetId' | 'startSec' | 'inPointSec' | 'speed'>,
): string {
  if (!clip.assetId) return ''
  const speed = Math.max(clip.speed, 0.01)
  const intercept = clip.inPointSec - clip.startSec * speed
  return `${clip.assetId}|s=${q(speed)}|b=${q(intercept)}`
}

export interface ReaderPoolStats {
  /**
   * Live permanent decoder instances (unique non-alias readers).
   * Transient overflow readers do **not** count — they hold no decoder between frames.
   */
  size: number
  /** Successful permanent creates (lazy). */
  creates: number
  /** One-shot open/close cycles for overflow mappings. */
  transientOpens: number
  /** Keys closed because they left the active set. */
  releases: number
  /** Inactive same-asset readers rebound to a new source-time mapping. */
  handoffs: number
  /** Upcoming cut frames decoded before they became active. */
  framePrewarms: number
  /** Times acquire reused an existing slot (share hit). */
  shareHits: number
  /**
   * Acquires that could not open a new permanent decoder (sibling alias or
   * transient overflow).
   */
  degradedAcquires: number
  /** Hard live-decoder cap. */
  maxReaders: number
}

export interface ExportReaderPoolOptions {
  maxReaders?: number
  /** Number of releaseUnused ticks to keep an inactive decoder warm. */
  warmRetentionTicks?: number
  /** Maximum time for speculative reader creation or first-frame decode. */
  framePrewarmTimeoutMs?: number
  /** Create a fresh VideoFrameReader for this asset (blob parse + decoder). */
  createReader: (assetId: string) => Promise<VideoFrameReader>
  /**
   * Optional factory for overflow **transient** opens (prefer HTMLVideo seek —
   * cheaper than another WebCodecs session). Defaults to `createReader`.
   */
  createDegradedReader?: (assetId: string) => Promise<VideoFrameReader>
  /** Optional hook for degraded-path visibility (tests / logging). */
  onDegraded?: (info: { assetId: string; key: string; reason: string }) => void
}

interface Slot {
  key: string
  assetId: string
  reader: VideoFrameReader
  /**
   * True when this slot owns a budget-counted permanent decoder.
   * False for same-asset aliases and transient overflow wrappers.
   */
  primary: boolean
  /**
   * Transient overflow: wrapper does open→decode→close per getFrameAt and does
   * not count toward the live decoder cap.
   */
  transient: boolean
}

/**
 * VideoFrameReader that opens an underlying decoder only for each getFrameAt,
 * clones the visible frame, then closes the decoder immediately.
 */
export function makeTransientFrameReader(
  open: () => Promise<VideoFrameReader>,
  opts?: {
    isPoolClosed?: () => boolean
    onOpen?: () => void
  },
): VideoFrameReader {
  let held: VideoFrame | null = null
  let closed = false
  return {
    async getFrameAt(sourceSec: number): Promise<VideoFrame | null> {
      if (closed || opts?.isPoolClosed?.()) return null
      if (held) {
        try {
          held.close()
        } catch {
          /* ignore */
        }
        held = null
      }
      opts?.onOpen?.()
      const inner = await open()
      try {
        if (closed || opts?.isPoolClosed?.()) return null
        const vf = await inner.getFrameAt(sourceSec)
        if (vf) {
          try {
            held = vf.clone()
          } catch {
            held = null
          }
        }
        return held
      } finally {
        try {
          inner.close()
        } catch {
          /* ignore */
        }
      }
    },
    close() {
      closed = true
      if (held) {
        try {
          held.close()
        } catch {
          /* ignore */
        }
        held = null
      }
    },
  }
}

/**
 * Lazy reader pool: acquire by mapping key, release keys not needed this frame,
 * close everything on cancel/fail/end.
 */
export class ExportReaderPool {
  private readonly maxReaders: number
  private readonly warmRetentionTicks: number
  private readonly framePrewarmTimeoutMs: number
  private readonly createReader: (assetId: string) => Promise<VideoFrameReader>
  private readonly createDegradedReader: (assetId: string) => Promise<VideoFrameReader>
  private readonly onDegraded?: ExportReaderPoolOptions['onDegraded']
  private readonly slots = new Map<string, Slot>()
  /** In-flight permanent creates so concurrent acquires for the same key share one reader. */
  private readonly inflight = new Map<string, Promise<VideoFrameReader>>()
  /** A predecoded first frame that acquire must wait for before using the reader. */
  private readonly framePrewarms = new Map<string, Promise<boolean>>()
  /** Completed first-frame prewarms, deduplicated until foreground acquire. */
  private readonly primedSourceSec = new Map<string, number>()
  /** Protect readers doing background decode from release/handoff/eviction. */
  private readonly prewarmingKeys = new Set<string>()
  /** At most one background decoder is primed at once (bounded GPU pressure). */
  private activeFramePrewarmKey: string | null = null
  /** Last active mapping set from {@link releaseUnused} (for eviction). */
  private activeKeys: ReadonlySet<string> = new Set()
  /** False until the first releaseUnused — avoid treating empty default as "evict all". */
  private activeKeysKnown = false
  private creates = 0
  private transientOpens = 0
  private releases = 0
  private handoffs = 0
  private successfulFramePrewarms = 0
  private shareHits = 0
  private degradedAcquires = 0
  private closed = false
  private tick = 0
  private readonly inactiveSince = new Map<string, number>()

  constructor(opts: ExportReaderPoolOptions) {
    this.maxReaders = Math.max(1, opts.maxReaders ?? DEFAULT_MAX_EXPORT_READERS)
    this.warmRetentionTicks = Math.max(0, Math.floor(opts.warmRetentionTicks ?? 0))
    this.framePrewarmTimeoutMs = Math.max(
      1,
      Math.floor(opts.framePrewarmTimeoutMs ?? 5_000),
    )
    this.createReader = opts.createReader
    this.createDegradedReader = opts.createDegradedReader ?? opts.createReader
    this.onDegraded = opts.onDegraded
  }

  getStats(): ReaderPoolStats {
    return {
      size: this.liveDecoderCount(),
      creates: this.creates,
      transientOpens: this.transientOpens,
      releases: this.releases,
      handoffs: this.handoffs,
      framePrewarms: this.successfulFramePrewarms,
      shareHits: this.shareHits,
      degradedAcquires: this.degradedAcquires,
      maxReaders: this.maxReaders,
    }
  }

  /**
   * Unique permanent decoder instances currently open (aliases share one;
   * transient wrappers count 0).
   */
  liveDecoderCount(): number {
    const seen = new Set<VideoFrameReader>()
    for (const s of this.slots.values()) {
      if (s.transient) continue
      if (seen.has(s.reader)) continue
      seen.add(s.reader)
    }
    return seen.size
  }

  /**
   * Drop and close every slot whose key is not in `activeKeys`.
   * Call once per frame *before* acquiring new keys so slots free for reuse.
   */
  releaseUnused(activeKeys: ReadonlySet<string>): void {
    if (this.closed) return
    this.tick++
    this.activeKeys = activeKeys
    this.activeKeysKnown = true
    for (const [key, slot] of this.slots) {
      if (activeKeys.has(key) || this.prewarmingKeys.has(key)) {
        this.inactiveSince.delete(key)
        continue
      }
      if (this.warmRetentionTicks > 0) {
        const since = this.inactiveSince.get(key) ?? this.tick
        this.inactiveSince.set(key, since)
        if (this.tick - since < this.warmRetentionTicks) continue
      }
      this.closeSlot(key, slot)
      this.releases++
    }
  }

  /**
   * Obtain a reader for this mapping. Shares when the key already has a slot.
   * Overflow beyond {@link maxReaders} live decoders returns a transient reader.
   */
  async acquire(
    key: string,
    assetId: string,
  ): Promise<{ reader: VideoFrameReader; degraded: boolean; key: string }> {
    if (this.closed) {
      throw new Error('ExportReaderPool is closed')
    }
    if (!key || !assetId) {
      throw new Error('ExportReaderPool.acquire requires non-empty key and assetId')
    }

    // A cut may become active while its background first-frame decode is still
    // settling. Never issue a concurrent getFrameAt on the same VideoDecoder.
    const framePrewarm = this.framePrewarms.get(key)
    if (framePrewarm) await framePrewarm.catch(() => false)
    // The mapping is now owned by foreground rendering. Drop the marker so a
    // genuinely later reuse of the same key can be primed again if necessary.
    this.primedSourceSec.delete(key)

    const existing = this.slots.get(key)
    if (existing) {
      this.inactiveSince.delete(key)
      this.shareHits++
      return {
        reader: existing.reader,
        degraded: !existing.primary || existing.transient,
        key,
      }
    }

    // Wait for concurrent permanent create of the same key.
    const pending = this.inflight.get(key)
    if (pending) {
      try {
        const reader = await pending
        this.shareHits++
        const slot = this.slots.get(key)
        return {
          reader,
          degraded: slot ? !slot.primary || slot.transient : false,
          key,
        }
      } catch {
        // A speculative create may time out or lose a cap race. Foreground
        // acquire is authoritative, so retry through the normal path below.
        if (this.closed) throw new Error('ExportReaderPool is closed')
      }
    }

    // Sequential cuts of the same source do not need a brand-new decoder. An
    // inactive exact-owner reader can safely change mapping because no active
    // clip references it; getFrameAt will seek/reset only when source time
    // actually jumps. Never hand off an active/aliased reader.
    const handedOff = this.handoffInactiveSameAsset(key, assetId)
    if (handedOff) return { reader: handedOff, degraded: false, key }

    if (this.liveDecoderCount() < this.maxReaders) {
      try {
        const reader = await this.createPermanentSlot(key, assetId, /* primary */ true)
        return { reader, degraded: false, key }
      } catch (e) {
        throw this.wrapCreateError(assetId, key, e)
      }
    }

    // Pool full — prefer same-asset sibling (alias, no new decoder).
    // Evict an inactive warm slot before aliasing a same-asset reader. Reusing
    // a decoder with a different source-time mapping can reintroduce seek
    // thrash; warm retention is only useful if the exact mapping is reused.
    const victim = this.findEvictable()
    if (victim) {
      this.closeSlot(victim.key, victim)
      this.releases++
      try {
        const reader = await this.createPermanentSlot(key, assetId, /* primary */ true)
        return { reader, degraded: false, key }
      } catch (e) {
        throw this.wrapCreateError(assetId, key, e)
      }
    }

    // All permanent slots are active; fall back to a bounded same-asset alias.
    const sibling = this.findSibling(assetId)
    if (sibling) {
      this.degradedAcquires++
      this.onDegraded?.({
        assetId,
        key,
        reason: `pool full (${this.maxReaders}); reusing reader for key=${sibling.key}`,
      })
      this.slots.set(key, {
        key,
        assetId,
        reader: sibling.reader,
        primary: false,
        transient: false,
      })
      return { reader: sibling.reader, degraded: true, key }
    }

    // All permanent slots still needed — bounded overflow: transient decode.
    this.degradedAcquires++
    this.onDegraded?.({
      assetId,
      key,
      reason:
        `pool full (${this.maxReaders}) all slots active; transient open/close ` +
        `(no extra live decoder)`,
    })
    try {
      const reader = this.installTransientSlot(key, assetId)
      return { reader, degraded: true, key }
    } catch (e) {
      throw this.wrapCreateError(assetId, key, e)
    }
  }

  /**
   * Start a decoder for a mapping that is about to become active. Prewarming
   * never aliases another mapping and never opens a transient reader; when the
   * bounded pool has no inactive slot it simply declines. The caller can fire
   * this without awaiting it so decoder creation overlaps compositing/encode.
   */
  async prewarm(
    key: string,
    assetId: string,
    opts?: { allowCreate?: boolean },
  ): Promise<boolean> {
    if (this.closed || !key || !assetId) return false
    const existing = this.slots.get(key)
    if (existing) {
      this.inactiveSince.delete(key)
      return this.canFramePrewarmSlot(key, existing)
    }
    const pending = this.inflight.get(key)
    if (pending) {
      await this.withFramePrewarmDeadline(pending).catch(() => {})
      const slot = this.slots.get(key)
      return !!slot && this.canFramePrewarmSlot(key, slot)
    }

    if (this.handoffInactiveSameAsset(key, assetId)) return true
    if (opts?.allowCreate === false) return false
    // Prewarm must never evict a warm decoder. The normal acquire path can
    // evict safely at the exact cut after the active set has been updated;
    // doing it speculatively here creates/release churn on dense timelines.
    if (this.liveDecoderCount() >= this.maxReaders) {
      return false
    }
    try {
      await this.createPermanentSlot(key, assetId, /* primary */ true, {
        allowTransientOnCapRace: false,
        timeoutMs: this.framePrewarmTimeoutMs,
      })
      const slot = this.slots.get(key)
      return !!slot && this.canFramePrewarmSlot(key, slot)
    } catch {
      // Prewarm is opportunistic. The normal acquire path will retry and
      // surface a real decode error if the mapping is actually needed.
      return false
    }
  }

  /**
   * Decode and retain the first frame of an upcoming discontinuous cut. Unlike
   * {@link prewarm}, this actually drives VideoDecoder before the cut. Only one
   * mapping is primed at a time; repeated calls for the same key share work.
   */
  async prewarmFrame(
    key: string,
    assetId: string,
    sourceSec: number,
    opts?: { allowCreate?: boolean },
  ): Promise<boolean> {
    if (this.closed || !key || !assetId || !Number.isFinite(sourceSec)) return false
    const normalizedSourceSec = Math.max(0, sourceSec)
    const primedSourceSec = this.primedSourceSec.get(key)
    if (
      primedSourceSec !== undefined &&
      Math.abs(primedSourceSec - normalizedSourceSec) <= 1e-6 &&
      this.slots.has(key)
    ) return true
    const existing = this.framePrewarms.get(key)
    if (existing) return existing
    // Do not queue many future cuts behind one decoder. The exporter retries
    // the nearest cut on subsequent frames while it remains in the lookahead.
    if (this.activeFramePrewarmKey && this.activeFramePrewarmKey !== key) return false

    this.activeFramePrewarmKey = key
    this.prewarmingKeys.add(key)
    const work = (async () => {
      let ownedReader: VideoFrameReader | null = null
      let succeeded = false
      try {
        const prepared = await this.prewarm(key, assetId, opts)
        if (!prepared || this.closed) return false
        const slot = this.slots.get(key)
        if (!slot || !this.canFramePrewarmSlot(key, slot)) return false
        ownedReader = slot.reader
        const frame = await this.withFramePrewarmDeadline(
          slot.reader.getFrameAt(normalizedSourceSec),
        )
        if (!frame || this.closed) return false
        this.primedSourceSec.set(key, normalizedSourceSec)
        this.successfulFramePrewarms++
        succeeded = true
        return true
      } catch {
        // Opportunistic only. The foreground acquire/getFrameAt path remains
        // authoritative and surfaces a real decode error when the cut arrives.
        return false
      } finally {
        // A failed/timed-out speculative decode must never poison the next
        // foreground acquire. Only close the reader this task exclusively
        // owned; aliases/shared readers are deliberately left untouched.
        if (!succeeded && ownedReader) {
          this.discardExclusivePrewarmSlot(key, ownedReader)
        }
        this.prewarmingKeys.delete(key)
        this.framePrewarms.delete(key)
        if (this.activeFramePrewarmKey === key) this.activeFramePrewarmKey = null
      }
    })()
    this.framePrewarms.set(key, work)
    return work
  }

  /** Close every reader (cancel / fail / export end). Safe to call twice. */
  closeAll(): void {
    this.closed = true
    for (const [key, slot] of this.slots) {
      this.closeSlot(key, slot)
    }
    this.slots.clear()
    this.inflight.clear()
    this.framePrewarms.clear()
    this.primedSourceSec.clear()
    this.prewarmingKeys.clear()
    this.activeFramePrewarmKey = null
  }

  /** Test helper: whether a primary (non-alias, non-transient) slot exists for key. */
  hasPrimary(key: string): boolean {
    const s = this.slots.get(key)
    return !!s && s.primary && !s.transient
  }

  /** Test helper: whether key is a transient overflow slot. */
  isTransient(key: string): boolean {
    return !!this.slots.get(key)?.transient
  }

  private wrapCreateError(assetId: string, key: string, e: unknown): Error {
    const detail = e instanceof Error ? e.message : String(e)
    return new Error(
      `ExportReaderPool failed to create reader for asset ${assetId} mapping ${key}: ${detail}`,
      { cause: e },
    )
  }

  private handoffInactiveSameAsset(key: string, assetId: string): VideoFrameReader | null {
    if (!this.activeKeysKnown) return null
    let candidate: Slot | undefined
    let candidateIdleSince = Number.POSITIVE_INFINITY
    for (const slot of this.slots.values()) {
      if (
        slot.assetId !== assetId || slot.transient || !slot.primary ||
        this.activeKeys.has(slot.key) || this.prewarmingKeys.has(slot.key)
      ) continue
      const referencedByOtherSlot = [...this.slots].some(([slotKey, other]) =>
        slotKey !== slot.key && other.reader === slot.reader,
      )
      if (referencedByOtherSlot) continue
      const idleSince = this.inactiveSince.get(slot.key) ?? this.tick
      if (!candidate || idleSince < candidateIdleSince) {
        candidate = slot
        candidateIdleSince = idleSince
      }
    }
    if (!candidate) return null

    const oldKey = candidate.key
    this.slots.delete(oldKey)
    this.inactiveSince.delete(oldKey)
    this.primedSourceSec.delete(oldKey)
    candidate.key = key
    this.slots.set(key, candidate)
    this.inactiveSince.delete(key)
    this.handoffs++
    return candidate.reader
  }

  private findSibling(assetId: string): Slot | undefined {
    // Never alias a reader whose background frame-prewarm is still decoding:
    // a concurrent foreground getFrameAt on the same VideoFrameReader would
    // interleave its pending/cursor/decoder state. Fall through to transient
    // overflow instead (slower, but each transient owns its reader).
    const aliasable = (slot: Slot) => !this.prewarmingKeys.has(slot.key)
    for (const slot of this.slots.values()) {
      if (slot.assetId === assetId && slot.primary && !slot.transient && aliasable(slot)) {
        return slot
      }
    }
    for (const slot of this.slots.values()) {
      if (slot.assetId === assetId && !slot.transient && aliasable(slot)) return slot
    }
    return undefined
  }

  /** Prefer closing a primary not in the last active set; any inactive slot next. */
  private findEvictable(): Slot | undefined {
    if (!this.activeKeysKnown) return undefined
    let anyInactive: Slot | undefined
    for (const slot of this.slots.values()) {
      if (this.activeKeys.has(slot.key) || this.prewarmingKeys.has(slot.key)) continue
      // An inactive alias may still point at a reader used by an active alias.
      // Removing that slot would not free a decoder, so never select it as the
      // warm-cache eviction victim.
      const activeReference = [...this.slots].some(([key, candidate]) =>
        this.activeKeys.has(key) && candidate.reader === slot.reader,
      )
      if (activeReference) continue
      if (slot.primary && !slot.transient) return slot
      if (!anyInactive) anyInactive = slot
    }
    return anyInactive
  }

  private installTransientSlot(key: string, assetId: string): VideoFrameReader {
    const reader = makeTransientFrameReader(
      () => this.createDegradedReader(assetId),
      {
        isPoolClosed: () => this.closed,
        onOpen: () => {
          this.transientOpens++
        },
      },
    )
    this.slots.set(key, {
      key,
      assetId,
      reader,
      primary: false,
      transient: true,
    })
    return reader
  }

  private async createPermanentSlot(
    key: string,
    assetId: string,
    primary: boolean,
    opts?: {
      allowTransientOnCapRace?: boolean
      timeoutMs?: number
    },
  ): Promise<VideoFrameReader> {
    this.primedSourceSec.delete(key)
    const create = this.createReader(assetId)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abandoned = false
    const boundedCreate = opts?.timeoutMs
      ? Promise.race([
          create,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abandoned = true
              reject(new Error(
                `reader prewarm timed out after ${Math.round(opts.timeoutMs! / 1000)}s`,
              ))
            }, opts.timeoutMs)
          }),
        ])
      : create
    if (opts?.timeoutMs) {
      // A create factory cannot be cancelled. If it resolves after the
      // deadline, close the orphan instead of leaking a VideoDecoder.
      void create.then((reader) => {
        if (!abandoned) return
        try { reader.close() } catch { /* already closed */ }
      }, () => {})
    }
    let work: Promise<VideoFrameReader>
    work = boundedCreate
      .then((reader) => {
        if (this.closed) {
          try {
            reader.close()
          } catch {
            /* ignore */
          }
          throw new Error('ExportReaderPool closed during create')
        }
        // Cap race: another concurrent acquire may have filled the budget.
        if (this.liveDecoderCount() >= this.maxReaders) {
          try {
            reader.close()
          } catch {
            /* ignore */
          }
          if (opts?.allowTransientOnCapRace === false) {
            throw new Error('reader prewarm lost the live-decoder cap race')
          }
          // Foreground acquire may still use bounded transient overflow.
          return this.installTransientSlot(key, assetId)
        }
        this.slots.set(key, {
          key,
          assetId,
          reader,
          primary,
          transient: false,
        })
        this.inactiveSince.delete(key)
        this.creates++
        return reader
      })
      .finally(() => {
        clearTimeout(timer)
        if (this.inflight.get(key) === work) this.inflight.delete(key)
      })
    this.inflight.set(key, work)
    return work
  }

  private canFramePrewarmSlot(key: string, slot: Slot): boolean {
    if (!this.isExclusivePrimarySlot(key, slot)) return false
    if (this.activeKeysKnown && this.activeKeys.has(key)) return false
    return true
  }

  private isExclusivePrimarySlot(key: string, slot: Slot): boolean {
    if (!slot.primary || slot.transient) return false
    return ![...this.slots].some(([otherKey, other]) =>
      otherKey !== key && other.reader === slot.reader,
    )
  }

  private async withFramePrewarmDeadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `frame prewarm timed out after ${Math.round(this.framePrewarmTimeoutMs / 1000)}s`,
          )), this.framePrewarmTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private discardExclusivePrewarmSlot(
    key: string,
    expectedReader: VideoFrameReader,
  ): void {
    const slot = this.slots.get(key)
    if (!slot || slot.reader !== expectedReader || !this.isExclusivePrimarySlot(key, slot)) return
    this.closeSlot(key, slot)
    this.releases++
  }

  private closeSlot(key: string, slot: Slot): void {
    this.slots.delete(key)
    this.inactiveSince.delete(key)
    this.primedSourceSec.delete(key)
    if (slot.transient) {
      try {
        slot.reader.close()
      } catch {
        /* ignore */
      }
      return
    }
    // Only close the underlying reader once — degraded aliases share it.
    const stillReferenced = [...this.slots.values()].some((s) => s.reader === slot.reader)
    if (stillReferenced) return
    try {
      slot.reader.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Simulate one export frame's reader usage for benchmarks / parity tests.
 * Does not touch WebCodecs — caller supplies acquire → getFrameAt.
 */
export async function fetchActiveVideoFrames(opts: {
  clips: Array<{ id: string; assetId: string; key: string; sourceSec: number }>
  pool: ExportReaderPool
  getFrame: (
    reader: VideoFrameReader,
    sourceSec: number,
    clipId: string,
  ) => Promise<unknown>
}): Promise<Map<string, unknown>> {
  const activeKeys = new Set(opts.clips.map((c) => c.key))
  opts.pool.releaseUnused(activeKeys)
  const out = new Map<string, unknown>()
  for (const c of opts.clips) {
    const { reader } = await opts.pool.acquire(c.key, c.assetId)
    out.set(c.id, await opts.getFrame(reader, c.sourceSec, c.id))
  }
  return out
}
