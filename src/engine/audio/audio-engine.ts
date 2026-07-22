import type { Clip, Track } from '@engine/timeline'

import {
  assertDecodable,
  AudioDecodeTooLargeError,
  MAX_DECODED_PCM_BYTES,
} from './decode-guard'
import { createDenoiseNode, loadDenoiseModule } from './denoise'
import { AudioScheduleIndex } from './schedule-index'
import type { AudioEngine } from './types'
import { clampVolumeLinear } from './volume'

/**
 * Cap on total decoded PCM held in the buffer cache. Map order is LRU (touch on
 * get/play). When over budget we drop least-recently-used buffers that are not
 * currently playing (no live BufferSource). keepIds only gates late decode
 * commits after project switch — it does NOT make the budget a no-op.
 */
export const MAX_TOTAL_PCM_BYTES = 1.5 * 1024 * 1024 * 1024

/**
 * Only schedule BufferSource nodes for clips that start within this many
 * timeline-seconds of the playhead. Far-future narration (thousands of clips)
 * is pumped in later via timer / onended — not all at once on play().
 * Pre-decode uses the same horizon so multi-hour assets far from the playhead
 * are not all forced into RAM.
 */
export const SCHEDULE_HORIZON_SEC = 20

/**
 * Hard cap on concurrent HTMLMediaElement streams for oversized assets.
 * Each stream owns a Chromium media pipeline; 100–300 overlapping long clips
 * without a cap freezes decode / causes A-V drift. Prefer earliest startSec
 * within the schedule horizon; refused clips are marked degraded (not silent).
 *
 * Long-term: shared WebCodecs chunk decoder/mixer under the same PCM budget
 * (separate task) instead of one media element per clip.
 */
export const MAX_STREAM_ELEMENTS = 10

/** A broken platform decoder must not pin the global serialized decode queue. */
export const AUDIO_DECODE_TIMEOUT_MS = 5 * 60_000

/** Re-arm the pump this many seconds before the horizon edge so the next
 *  batch is armed before the current window goes silent. */
const PUMP_LEAD_SEC = 4

function pcmBytesOf(buffer: AudioBuffer): number {
  // decodeAudioData stores Float32 planar samples.
  return buffer.length * buffer.numberOfChannels * 4
}

/**
 * Asset ids for pure-audio clips that intersect [timelineSec, timelineSec+horizon).
 * Shared by scheduling and by useAudioPlayback pre-decode so we never decode the
 * entire project working set up front.
 */
export function audibleAssetIdsInHorizon(
  clips: Clip[],
  tracks: Track[],
  timelineSec: number,
  horizonSec: number = SCHEDULE_HORIZON_SEC,
): Set<string> {
  const trackById = new Map(tracks.map((t) => [t.id, t]))
  const t0 = timelineSec
  const t1 = timelineSec + Math.max(0, horizonSec)
  const out = new Set<string>()
  for (const clip of clips) {
    if (!clip.assetId || clip.muted || clip.volume <= 0) continue
    const track = trackById.get(clip.trackId)
    if (!track || track.muted || track.hidden || track.kind !== 'audio') continue
    const speed = Math.max(clip.speed, 0.01)
    const effDur = (clip.outPointSec - clip.inPointSec) / speed
    const clipEnd = clip.startSec + effDur
    if (clipEnd <= t0) continue
    if (clip.startSec >= t1) continue
    out.add(clip.assetId)
  }
  return out
}

interface ScheduledSource {
  src: AudioBufferSourceNode
  nodes: AudioNode[]
  clipId: string
  assetId: string
}

interface ScheduledStream {
  el: HTMLAudioElement
  src: MediaElementAudioSourceNode
  nodes: AudioNode[]
  clipId: string
  assetId: string
  startTimer: ReturnType<typeof setTimeout> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  metadataTimer: ReturnType<typeof setTimeout> | null
}

interface PlaySession {
  /** Timeline seconds at the moment play() was called. */
  timelineOrigin: number
  /** AudioContext.currentTime at that same moment. */
  ctxOrigin: number
  schedule: AudioScheduleIndex
  /** clip.id already given a BufferSource this session. */
  scheduledClipIds: Set<string>
}

class WebAudioEngine implements AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private masterVolume = 1
  /** LRU cache: Map iteration order = least-recently-used first. */
  private readonly buffers = new Map<string, AudioBuffer>()
  private totalPcmBytes = 0
  private readonly decoding = new Map<string, Promise<void>>()
  /** Attempt token prevents a timed-out/aborted platform decode committing late. */
  private readonly decodeAttempts = new Map<string, symbol>()
  /** A native decode that exceeded its deadline may still be alive because
   *  decodeAudioData() is not cancellable. While it remains alive, refuse new
   *  decodes instead of multiplying multi-GB ArrayBuffer/PCM allocations. */
  private poisonedDecodeAttempt: symbol | null = null
  /** Assets whose decodeAudioData failed (no audio track, corrupt, etc.). Without
   *  this, hasBuffer stays false and every play/export re-reads + re-decodes the
   *  whole file from the start. Internal only — not part of AudioEngine. */
  private readonly failed = new Set<string>()
  /** Latest keep-set from evictExcept (null = no eviction yet, keep everything).
   *  An in-flight decode that finishes AFTER a project switch checks this before
   *  committing, so a late decode of the old project can't re-populate a buffer
   *  (hundreds of MB / GB) that no future evictExcept will ever drop (#7). */
  private keepIds: Set<string> | null = null
  /** Why an asset has no buffer (too large / no audio track / corrupt), so the
   *  UI and export can report a skipped asset instead of silently dropping it. */
  private readonly decodeErrors = new Map<string, string>()
  /** Serializes decodes — see ensureDecoded. */
  private decodeChain: Promise<void> = Promise.resolve()
  private active: ScheduledSource[] = []
  /** Oversized assets use HTMLMediaElement's incremental decoder for preview.
   *  The object URL references the source Blob/File but never materialises full
   *  encoded bytes + Float32 PCM in JS heap. One element is created per clip
   *  occurrence, so overlapping offsets never seek-fight. */
  private readonly streamUrls = new Map<string, string>()
  private activeStreams: ScheduledStream[] = []
  /**
   * Per-clip refusal when stream admission is at MAX_STREAM_ELEMENTS.
   * Cleared when the clip is admitted or the play session ends — never silent.
   */
  private readonly streamCapErrors = new Map<string, string>()
  private playSession: PlaySession | null = null
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private pumpQueued = false
  private denoiseReady = false
  // Persistent WebAudio routing for boosted video elements, keyed by preview
  // *playback instance* id (sourceMappingKey) — not assetId. Overlapping clips
  // of the same asset need independent elements and gain nodes.
  // createMediaElementSource is one-shot + permanent per element, so these live
  // as long as the pooled element does — not per play() schedule.
  private readonly videoNodes = new Map<
    string,
    { el: HTMLVideoElement; src: MediaElementAudioSourceNode; gain: GainNode }
  >()

  private ensureContext(): { ctx: AudioContext; master: GainNode } {
    if (!this.ctx || !this.master) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.masterVolume
      this.master.connect(this.ctx.destination)
      // Preload the denoise worklet so it's ready by the time playback starts.
      void loadDenoiseModule(this.ctx).then((ok) => {
        this.denoiseReady = ok
      })
    }
    return { ctx: this.ctx, master: this.master }
  }

  async ensureDecoded(assetId: string, blob: Blob, signal?: AbortSignal): Promise<void> {
    if (this.buffers.has(assetId)) {
      this.touchBuffer(assetId)
      return
    }
    if (this.streamUrls.has(assetId)) return
    if (this.failed.has(assetId)) return
    const inflight = this.decoding.get(assetId)
    if (inflight) return this.waitForDecode(inflight, signal)
    if (signal?.aborted) throw new DOMException('Audio decode cancelled', 'AbortError')
    if (this.poisonedDecodeAttempt !== null) {
      this.decodeErrors.set(
        assetId,
        'Audio decoder is still recovering from a stalled decode; retry later or use server export.',
      )
      return
    }

    // A fresh decode request means this asset is wanted NOW. keepIds is only
    // rebuilt on project load (evictExcept), so an asset imported AFTER the
    // project opened was never in it — the commit guard below then silently
    // discarded its decoded PCM: no buffer, no decodeError, browser export
    // failed with a misleading "media data is missing", and audio-track
    // previews stayed silent. Stale cross-project decodes remain blocked by
    // the attempt token (evictExcept/dispose invalidate it).
    this.keepIds?.add(assetId)
    // Serialize decodes. Callers (useAudioPlayback's pre-decode effect) fire one
    // per audible asset at once; each holds the whole container AND its decoded
    // PCM, so N concurrent decodes multiply peak RAM by N. One at a time keeps
    // the peak at a single asset's footprint.
    const attempt = Symbol(assetId)
    this.decodeAttempts.set(assetId, attempt)
    const underlying = this.decodeChain.then(() => this.decodeOne(assetId, blob, attempt))
    const task = this.boundDecode(assetId, attempt, underlying)
      .finally(() => {
        if (this.decoding.get(assetId) === task) this.decoding.delete(assetId)
        if (this.decodeAttempts.get(assetId) === attempt) {
          this.decodeAttempts.delete(assetId)
        }
      })
    // IMPORTANT: keep serialization attached to the non-cancellable native
    // operation, not the caller-facing timeout/abort promise. Otherwise cancel
    // immediately starts the next huge decode while decodeAudioData is alive.
    this.decodeChain = underlying.catch(() => {})
    void underlying.finally(() => {
      if (this.poisonedDecodeAttempt === attempt) {
        this.poisonedDecodeAttempt = null
        this.failed.delete(assetId)
        this.decodeErrors.delete(assetId)
      }
    }).catch(() => {})
    this.decoding.set(assetId, task)
    return this.waitForDecode(task, signal)
  }

  ensureStreamSource(assetId: string, url: string): void {
    if (!url || this.buffers.has(assetId)) return
    const previous = this.streamUrls.get(assetId)
    if (previous === url) return
    if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous)
    this.streamUrls.set(assetId, url)
    this.failed.delete(assetId)
    this.decodeErrors.set(
      assetId,
      'Preview uses bounded streaming; browser export may require Hybrid or Server audio.',
    )
    if (this.playSession) this.pumpSchedule()
  }

  private async boundDecode(
    assetId: string,
    attempt: symbol,
    underlying: Promise<void>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        underlying,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Audio decode timed out after ${AUDIO_DECODE_TIMEOUT_MS / 1000}s`)),
            AUDIO_DECODE_TIMEOUT_MS,
          )
        }),
      ])
    } catch (e) {
      if (this.decodeAttempts.get(assetId) === attempt) {
        this.decodeAttempts.delete(assetId)
      }
      this.poisonedDecodeAttempt = attempt
      this.failed.add(assetId)
      this.decodeErrors.set(assetId, e instanceof Error ? e.message : 'Audio decode timed out')
      // Preserve ensureDecoded's historical "record, do not throw" contract.
    } finally {
      clearTimeout(timer)
    }
  }

  /** Abort only this waiter. The shared native decode and serialized queue keep
   *  running so a quick cancel/retry cannot overlap large PCM allocations. */
  private waitForDecode(task: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return task
    if (signal.aborted) {
      return Promise.reject(new DOMException('Audio decode cancelled', 'AbortError'))
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cleanup()
        reject(new DOMException('Audio decode cancelled', 'AbortError'))
      }
      const cleanup = () => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
      task.then(
        () => { cleanup(); resolve() },
        (error) => { cleanup(); reject(error) },
      )
    })
  }

  /** Decode one asset. Never throws — failures are recorded so callers stop
   *  re-reading multi-GB blobs, and `getDecodeError` lets the UI/export explain
   *  why an asset is silent instead of dropping the audio without a word. */
  private async decodeOne(assetId: string, blob: Blob, attempt: symbol): Promise<void> {
    // Another queued decode (or an evict/dispose) may have settled this already.
    if (
      this.decodeAttempts.get(assetId) !== attempt ||
      this.buffers.has(assetId) ||
      this.failed.has(assetId)
    ) return
    let estimatedPcmBytes = MAX_DECODED_PCM_BYTES
    try {
      // Refuse BEFORE arrayBuffer()+decodeAudioData: a multi-GB container, or a
      // small file whose PCM decodes to >1 GB, would OOM the renderer here.
      // Long-term: chunked WebCodecs PCM or a low-bitrate audio proxy for preview
      // (tracked separately) — this path still needs a full-buffer decode.
      const estimate = await assertDecodable(blob, 'This audio asset')
      estimatedPcmBytes = estimate.pcmBytes ?? MAX_DECODED_PCM_BYTES
    } catch (e) {
      if (
        e instanceof AudioDecodeTooLargeError &&
        typeof document !== 'undefined' &&
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        // A project switch / dispose may have happened while assertDecodable was
        // awaiting the metadata probe: only publish a stream URL if this asset is
        // still wanted, else it leaks a large Blob URL for an old project and can
        // pump stale playback. Mirrors the decode-commit guard below (#2).
        if (
          this.decodeAttempts.get(assetId) !== attempt ||
          (this.keepIds !== null && !this.keepIds.has(assetId))
        ) return
        // Full-buffer decode would exceed the hard memory gate. Preview can
        // still play it through Chromium's incremental media pipeline. Browser
        // export remains explicit: getBuffer() is null and this diagnostic tells
        // the caller to use server export instead of silently dropping audio.
        const previous = this.streamUrls.get(assetId)
        if (previous) URL.revokeObjectURL(previous)
        this.streamUrls.set(assetId, URL.createObjectURL(blob))
        this.failed.delete(assetId)
        this.decodeErrors.set(
          assetId,
          `${e.message} Preview uses bounded streaming; browser export requires server audio.`,
        )
        if (this.playSession) this.pumpSchedule()
        return
      }
      if (this.decodeAttempts.get(assetId) === attempt) {
        this.failed.add(assetId)
        this.decodeErrors.set(assetId, e instanceof Error ? e.message : 'Audio decode refused')
      }
      return
    }
    // Make room before materialising the encoded ArrayBuffer and native PCM.
    // Evicting only after commit briefly held the old cache + input + new PCM.
    if (!this.evictForIncomingDecode(estimatedPcmBytes)) {
      this.decodeErrors.set(
        assetId,
        'Audio decode deferred: currently playing buffers leave insufficient PCM memory. Retry after playback advances or use server export.',
      )
      return
    }
    const { ctx } = this.ensureContext()
    try {
      const arrayBuffer = await blob.arrayBuffer()
      const buffer = await ctx.decodeAudioData(arrayBuffer)
      // A project switch may have evicted this asset while we were decoding;
      // only commit if it's still wanted, else the buffer leaks for the session.
      if (
        this.decodeAttempts.get(assetId) !== attempt ||
        (this.keepIds !== null && !this.keepIds.has(assetId))
      ) return
      this.commitBuffer(assetId, buffer)
      this.failed.delete(assetId)
      this.decodeErrors.delete(assetId)
    } catch (e) {
      // No audio track / corrupt / unsupported — remember so callers stop
      // re-reading multi-GB blobs on every play (common for mute video on an
      // audio track).
      if (this.decodeAttempts.get(assetId) === attempt) {
        this.failed.add(assetId)
        this.decodeErrors.set(assetId, e instanceof Error ? e.message : 'Audio decode failed')
      }
    }
  }

  private commitBuffer(assetId: string, buffer: AudioBuffer): void {
    this.dropBuffer(assetId)
    this.buffers.set(assetId, buffer)
    this.totalPcmBytes += pcmBytesOf(buffer)
    this.evictToBudget()
    // A buffer that was hard-evicted and re-decoded mid-play can now schedule.
    if (this.playSession) this.pumpSchedule()
  }

  private dropBuffer(assetId: string): void {
    const prev = this.buffers.get(assetId)
    if (!prev) return
    this.totalPcmBytes = Math.max(0, this.totalPcmBytes - pcmBytesOf(prev))
    this.buffers.delete(assetId)
  }

  /** Move to most-recently-used (Map: delete + re-insert). */
  private touchBuffer(assetId: string): void {
    const buf = this.buffers.get(assetId)
    if (!buf) return
    this.buffers.delete(assetId)
    this.buffers.set(assetId, buf)
  }

  /** Asset ids referenced by live BufferSource nodes (must not be hard-evicted). */
  private playingAssetIds(): Set<string> {
    const ids = new Set<string>()
    for (const entry of this.active) {
      if (entry.assetId) ids.add(entry.assetId)
    }
    for (const entry of this.activeStreams) ids.add(entry.assetId)
    return ids
  }

  /**
   * Evict LRU buffers until under budget. May hard-evict keepIds survivors that
   * are not currently playing — only live BufferSource refs are protected.
   * Evicted assets re-decode on demand (decode chain + dedupe).
   */
  private evictToTarget(targetBytes: number): void {
    const playing = this.playingAssetIds()
    while (this.totalPcmBytes > targetBytes && this.buffers.size > 0) {
      let victim: string | null = null
      for (const id of this.buffers.keys()) {
        if (playing.has(id)) continue
        victim = id
        break // first key = least recently used
      }
      if (!victim) break // every remaining buffer is actively playing
      this.dropBuffer(victim)
    }
  }

  private evictToBudget(): void {
    this.evictToTarget(MAX_TOTAL_PCM_BYTES)
  }

  private evictForIncomingDecode(pcmBytes: number): boolean {
    const reserved = Math.max(0, Math.min(MAX_TOTAL_PCM_BYTES, pcmBytes))
    const target = MAX_TOTAL_PCM_BYTES - reserved
    this.evictToTarget(target)
    return this.totalPcmBytes <= target
  }

  /**
   * Test helper: inject a buffer of approximate `pcmBytes` without decoding.
   * Used to exercise eviction without multi-GB fixtures.
   */
  __testInjectBuffer(assetId: string, pcmBytes: number): void {
    const channels = 1
    const length = Math.max(1, Math.floor(pcmBytes / 4))
    const buffer = {
      length,
      numberOfChannels: channels,
      sampleRate: 48000,
      duration: length / 48000,
    } as AudioBuffer
    this.commitBuffer(assetId, buffer)
  }

  /** Test helper for the pre-decode reservation path (no large fixture needed). */
  __testReserveForDecode(pcmBytes: number): boolean {
    return this.evictForIncomingDecode(pcmBytes)
  }

  /** Test helper: mark an asset as currently playing so eviction protects it. */
  __testMarkPlaying(assetId: string): void {
    this.active.push({
      src: { onended: null, disconnect() {}, stop() {} } as unknown as AudioBufferSourceNode,
      nodes: [],
      clipId: `clip-${assetId}`,
      assetId,
    })
  }

  __testClearPlaying(): void {
    this.active = []
  }

  getDecodeError(assetId: string): string | null {
    return this.decodeErrors.get(assetId) ?? null
  }

  /**
   * Why a long-audio *clip* was not given a stream element (admission cap).
   * Distinct from asset-level {@link getDecodeError} (too large / no track).
   */
  getStreamAdmissionError(clipId: string): string | null {
    return this.streamCapErrors.get(clipId) ?? null
  }

  /** Clip ids currently refused due to MAX_STREAM_ELEMENTS (UI telemetry). */
  getStreamDegradedClipIds(): string[] {
    return [...this.streamCapErrors.keys()]
  }

  hasBuffer(assetId: string): boolean {
    return this.buffers.has(assetId)
  }

  hasPlaybackSource(assetId: string): boolean {
    return this.buffers.has(assetId) || this.streamUrls.has(assetId)
  }

  isStreamSource(assetId: string): boolean {
    return this.streamUrls.has(assetId) && !this.buffers.has(assetId)
  }

  /** Live HTMLMediaElement streams (oversized path only). */
  getActiveStreamCount(): number {
    return this.activeStreams.length
  }

  getBuffer(assetId: string): AudioBuffer | null {
    const buf = this.buffers.get(assetId) ?? null
    if (buf) this.touchBuffer(assetId)
    return buf
  }

  /** Test helper: total tracked PCM footprint of the buffer cache. */
  getTotalPcmBytes(): number {
    return this.totalPcmBytes
  }

  /** Test helper: number of live BufferSource nodes from the current play(). */
  getActiveSourceCount(): number {
    return this.active.length + this.activeStreams.length
  }

  setMasterVolume(v: number): void {
    this.masterVolume = v
    if (this.master) this.master.gain.value = v
  }

  setVideoClipVolume(instanceId: string, el: HTMLVideoElement, clipVol: number): void {
    const v = clampVolumeLinear(clipVol) // 0 .. MAX_VOLUME_LINEAR (+12 dB)
    const existing = this.videoNodes.get(instanceId)
    // The pooled element was recreated (proxy swap / reload) → drop the stale
    // source node (its old element is gone; the node can't be reattached).
    if (existing && existing.el !== el) {
      this.releaseVideoAudio(instanceId)
    }
    const node = this.videoNodes.get(instanceId)

    // Fast path: no boost and never routed → plain element volume. This keeps the
    // common (≤ 0 dB) case entirely off WebAudio, so it can't be silenced by a
    // suspended AudioContext — matching the pre-existing behaviour exactly.
    if (v <= 1 && !node) {
      el.volume = Math.min(1, v * this.masterVolume)
      el.muted = v <= 0
      return
    }

    // Boost path (or an element already routed): drive gain via WebAudio so the
    // element can play louder than 1.0, matching the export's full clip gain.
    // Master volume is applied by the master node (as for pure-audio clips).
    const { ctx, master } = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()
    let routed = node
    if (!routed) {
      try {
        const src = ctx.createMediaElementSource(el)
        const gain = ctx.createGain()
        src.connect(gain).connect(master)
        routed = { el, src, gain }
        this.videoNodes.set(instanceId, routed)
      } catch {
        // createMediaElementSource throws if the element is already tied to another
        // context — fall back to capped element volume rather than losing audio.
        el.volume = Math.min(1, v * this.masterVolume)
        el.muted = v <= 0
        return
      }
    }
    routed.gain.gain.value = v
    el.volume = 1 // gain node carries the level now; avoid double-attenuation
    el.muted = false
  }

  releaseVideoAudio(instanceId: string): void {
    const node = this.videoNodes.get(instanceId)
    if (!node) return
    try {
      node.src.disconnect()
      node.gain.disconnect()
    } catch {
      /* already disconnected */
    }
    this.videoNodes.delete(instanceId)
  }

  play(timelineSec: number, clips: Clip[], tracks: Track[]): void {
    this.stop()
    const { ctx } = this.ensureContext()
    if (ctx.state === 'suspended') void ctx.resume()

    this.playSession = {
      timelineOrigin: timelineSec,
      ctxOrigin: ctx.currentTime,
      schedule: new AudioScheduleIndex(clips, tracks),
      scheduledClipIds: new Set(),
    }
    this.pumpSchedule()
  }

  /** Timeline seconds corresponding to "now" in the current play session. */
  private timelineNow(): number {
    if (!this.playSession || !this.ctx) return 0
    return this.playSession.timelineOrigin + (this.ctx.currentTime - this.playSession.ctxOrigin)
  }

  private clearPumpTimer(): void {
    if (this.pumpTimer != null) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = null
    }
  }

  /**
   * Schedule BufferSources / stream elements for clips intersecting
   * [timelineNow, timelineNow+horizon]. Far-future clips wait for a later pump.
   * Stream elements are hard-capped at MAX_STREAM_ELEMENTS (earliest start first).
   */
  private pumpSchedule(): void {
    if (!this.playSession || !this.ctx || !this.master) return
    const { ctx, master } = this.ensureContext()
    const session = this.playSession
    const tNow = this.timelineNow()
    const horizonEnd = tNow + SCHEDULE_HORIZON_SEC
    // Free stream slots for clips that left the horizon / already ended.
    this.pruneStreamsOutsideWindow(tNow, horizonEnd)

    // Collect stream candidates (oversized path) then admit by earliest start.
    const streamCandidates: Clip[] = []

    for (const clip of session.schedule.advance(tNow, horizonEnd)) {
      if (!clip.assetId) continue
      if (session.scheduledClipIds.has(clip.id)) continue

      const buffer = this.buffers.get(clip.assetId)
      const streamUrl = this.streamUrls.get(clip.assetId)
      if (!buffer && !streamUrl) continue
      if (buffer) this.touchBuffer(clip.assetId)

      // Math.max(NaN, 0.01) is NaN — a clip with a non-finite speed/volume
      // (e.g. hydrated from an old snapshot) must degrade to defaults, not
      // throw inside AudioParam and silence the WHOLE timeline.
      const speed = Number.isFinite(clip.speed) ? Math.max(clip.speed, 0.01) : 1
      const effDur = (clip.outPointSec - clip.inPointSec) / speed
      const clipEndTimeline = clip.startSec + effDur
      if (clipEndTimeline <= tNow) {
        session.schedule.remove(clip.id)
        continue
      }
      // Starts after the schedule horizon — wait for a later pump.
      if (clip.startSec >= horizonEnd) continue

      if (!buffer && streamUrl) {
        streamCandidates.push(clip)
        continue
      }
      if (!buffer) continue

      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.playbackRate.value = speed

      const gain = ctx.createGain()
      gain.gain.value = clampVolumeLinear(clip.volume)
      const nodes: AudioNode[] = [gain]

      if (clip.denoise && this.denoiseReady) {
        try {
          const dn = createDenoiseNode(ctx, clip.denoise)
          src.connect(gain).connect(dn).connect(master)
          nodes.push(dn)
        } catch {
          src.connect(gain).connect(master)
        }
      } else {
        src.connect(gain).connect(master)
      }

      let when: number
      let offset: number
      let duration: number

      if (tNow >= clip.startSec) {
        when = ctx.currentTime
        offset = clip.inPointSec + (tNow - clip.startSec) * speed
        duration = clip.outPointSec - offset
      } else {
        when = ctx.currentTime + (clip.startSec - tNow)
        offset = clip.inPointSec
        duration = clip.outPointSec - clip.inPointSec
      }

      duration = Math.min(duration, Math.max(0, buffer.duration - offset))
      // A clip hydrated with non-finite bounds (e.g. outPointSec: NaN from an
      // undefined asset duration at insert time) must be SKIPPED, not allowed
      // to throw inside src.start() — `NaN <= 0` is false, so it would slip
      // past the guard below and could kill the pump for every later clip.
      if (!Number.isFinite(when) || !Number.isFinite(offset) || !Number.isFinite(duration)) {
        console.warn(
          `[audio] skipping clip ${clip.id}: non-finite schedule (when=${when}, offset=${offset}, duration=${duration})`,
        )
        session.scheduledClipIds.add(clip.id)
        session.schedule.remove(clip.id)
        continue
      }
      if (duration <= 0) {
        session.scheduledClipIds.add(clip.id)
        session.schedule.remove(clip.id)
        continue
      }

      const entry: ScheduledSource = {
        src,
        nodes,
        clipId: clip.id,
        assetId: clip.assetId,
      }
      src.onended = () => {
        this.releaseScheduled(entry)
      }

      try {
        src.start(when, offset, duration)
        this.active.push(entry)
        session.scheduledClipIds.add(clip.id)
        session.schedule.remove(clip.id)
      } catch {
        // start can throw if params are out of range — skip this clip.
        this.releaseScheduled(entry)
        session.scheduledClipIds.add(clip.id)
        session.schedule.remove(clip.id)
      }
    }

    this.admitStreamCandidates(streamCandidates, tNow, ctx, master)
    for (const clip of streamCandidates) {
      if (session.scheduledClipIds.has(clip.id)) session.schedule.remove(clip.id)
    }

    this.armPumpTimer()
  }

  /**
   * Admit stream clips under MAX_STREAM_ELEMENTS, earliest startSec first.
   * Clips that do not fit are marked degraded (not silently dropped) and left
   * unscheduled so a later pump can admit them when a slot frees.
   */
  private admitStreamCandidates(
    candidates: Clip[],
    tNow: number,
    ctx: AudioContext,
    master: GainNode,
  ): void {
    if (!this.playSession || candidates.length === 0) return
    const session = this.playSession
    candidates.sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))

    for (const clip of candidates) {
      if (!clip.assetId) continue
      const streamUrl = this.streamUrls.get(clip.assetId)
      if (!streamUrl) continue

      if (this.activeStreams.length >= MAX_STREAM_ELEMENTS) {
        this.markStreamCapLimited(clip)
        continue
      }

      if (this.scheduleStreamClip(clip, streamUrl, tNow, ctx, master)) {
        session.scheduledClipIds.add(clip.id)
        this.streamCapErrors.delete(clip.id)
      } else {
        // Hard failure (no document / MediaElementSource) — surface, do not retry forever.
        session.scheduledClipIds.add(clip.id)
        this.streamCapErrors.set(
          clip.id,
          'Preview stream unavailable (media element could not start).',
        )
      }
    }
  }

  private markStreamCapLimited(clip: Clip): void {
    this.streamCapErrors.set(
      clip.id,
      `Preview stream capacity full (${MAX_STREAM_ELEMENTS} concurrent long-audio layers). ` +
        `Clip starts at ${clip.startSec.toFixed(1)}s — muted until a nearer slot frees.`,
    )
  }

  /**
   * Release streams whose clips ended or left the schedule horizon so slots
   * can be re-admitted for nearer clips.
   */
  private pruneStreamsOutsideWindow(tNow: number, horizonEnd: number): void {
    if (!this.playSession) return
    for (const entry of [...this.activeStreams]) {
      const clip = this.playSession.schedule.getClip(entry.clipId)
      if (!clip) {
        this.releaseStream(entry)
        continue
      }
      const speed = Math.max(clip.speed, 0.01)
      const effDur = (clip.outPointSec - clip.inPointSec) / speed
      const clipEnd = clip.startSec + effDur
      if (clipEnd <= tNow) {
        // Finished — keep scheduledClipIds so we do not re-arm.
        this.releaseStream(entry)
        continue
      }
      // Not yet started and already outside the moving horizon → free the slot.
      if (clip.startSec >= horizonEnd) {
        this.releaseStream(entry)
        this.playSession.scheduledClipIds.delete(entry.clipId)
        this.streamCapErrors.delete(entry.clipId)
      }
    }
  }

  /** Schedule one oversized asset through Chromium's incremental media decoder.
   *  Each clip occurrence owns its element/source node, so overlapping clips of
   *  the same asset can seek to independent offsets without ping-pong.
   *  Caller must enforce MAX_STREAM_ELEMENTS before invoking. */
  private scheduleStreamClip(
    clip: Clip,
    url: string,
    tNow: number,
    ctx: AudioContext,
    master: GainNode,
  ): boolean {
    if (typeof document === 'undefined' || typeof ctx.createMediaElementSource !== 'function') {
      return false
    }
    // Defense in depth — admission should have checked, but never exceed the cap.
    if (this.activeStreams.length >= MAX_STREAM_ELEMENTS) {
      return false
    }
    const speed = Math.max(clip.speed, 0.01)
    const initialOffset =
      tNow >= clip.startSec
        ? clip.inPointSec + (tNow - clip.startSec) * speed
        : clip.inPointSec
    if (clip.outPointSec - initialOffset <= 0) return false

    const el = document.createElement('audio')
    el.preload = 'auto'
    // Backend assets are served by the local backend (127.0.0.1) while the UI
    // runs on localhost/tauri.localhost. A MediaElementAudioSourceNode fed by a
    // no-CORS media request is required by WebAudio to output silence. Set the
    // request mode before assigning src so the backend's ACAO response is used.
    el.crossOrigin = 'anonymous'
    el.src = url
    el.playbackRate = speed
    el.volume = 1
    el.muted = false

    let src: MediaElementAudioSourceNode
    try {
      src = ctx.createMediaElementSource(el)
    } catch {
      el.removeAttribute('src')
      try {
        el.load()
      } catch {
        /* detached */
      }
      return false
    }
    const gain = ctx.createGain()
    gain.gain.value = clampVolumeLinear(clip.volume)
    const nodes: AudioNode[] = [gain]
    try {
      if (clip.denoise && this.denoiseReady) {
        const dn = createDenoiseNode(ctx, clip.denoise)
        src.connect(gain).connect(dn).connect(master)
        nodes.push(dn)
      } else {
        src.connect(gain).connect(master)
      }
    } catch {
      try {
        src.disconnect()
        gain.disconnect()
      } catch {
        /* partially connected */
      }
      el.removeAttribute('src')
      return false
    }

    const entry: ScheduledStream = {
      el,
      src,
      nodes,
      clipId: clip.id,
      assetId: clip.assetId!,
      startTimer: null,
      stopTimer: null,
      metadataTimer: null,
    }
    const playAtOffset = () => {
      if (!this.activeStreams.includes(entry) || !this.playSession) return
      // Metadata can take noticeable time on a large container. Recompute from
      // the live AudioContext clock so a late metadata event does not start the
      // clip seconds behind the video/playhead.
      const liveNow = this.timelineNow()
      const liveOffset =
        liveNow >= clip.startSec
          ? clip.inPointSec + (liveNow - clip.startSec) * speed
          : clip.inPointSec
      const remainingSource = clip.outPointSec - liveOffset
      if (remainingSource <= 0) {
        this.releaseStream(entry)
        return
      }
      try {
        el.currentTime = Math.max(0, liveOffset)
      } catch {
        this.releaseStream(entry)
        return
      }
      try {
        const playResult = el.play()
        if (playResult && typeof playResult.catch === 'function') {
          void playResult.catch(() => this.releaseStream(entry))
        }
      } catch {
        this.releaseStream(entry)
        return
      }
      entry.stopTimer = setTimeout(
        () => this.releaseStream(entry),
        Math.max(1, (remainingSource / speed) * 1000),
      )
    }
    const start = () => {
      entry.startTimer = null
      if (!this.activeStreams.includes(entry) || !this.playSession) return
      if (el.readyState >= 1) {
        playAtOffset()
        return
      }
      el.onloadedmetadata = () => {
        if (entry.metadataTimer != null) clearTimeout(entry.metadataTimer)
        entry.metadataTimer = null
        el.onloadedmetadata = null
        el.onerror = null
        playAtOffset()
      }
      el.onerror = () => this.releaseStream(entry)
      entry.metadataTimer = setTimeout(() => this.releaseStream(entry), 5000)
      try {
        el.load()
      } catch {
        this.releaseStream(entry)
      }
    }
    el.onended = () => this.releaseStream(entry)
    this.activeStreams.push(entry)
    const delayMs = Math.max(0, (clip.startSec - tNow) * 1000)
    if (delayMs > 1) entry.startTimer = setTimeout(start, delayMs)
    else start()
    return true
  }

  private releaseStream(entry: ScheduledStream): void {
    const idx = this.activeStreams.indexOf(entry)
    if (idx >= 0) this.activeStreams.splice(idx, 1)
    if (entry.startTimer != null) clearTimeout(entry.startTimer)
    if (entry.stopTimer != null) clearTimeout(entry.stopTimer)
    if (entry.metadataTimer != null) clearTimeout(entry.metadataTimer)
    entry.startTimer = null
    entry.stopTimer = null
    entry.metadataTimer = null
    entry.el.onended = null
    entry.el.onloadedmetadata = null
    entry.el.onerror = null
    try {
      entry.el.pause()
      entry.el.removeAttribute('src')
      entry.el.load()
    } catch {
      /* already detached */
    }
    try {
      entry.src.disconnect()
    } catch {
      /* already disconnected */
    }
    for (const node of entry.nodes) {
      try {
        node.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    // A freed slot may admit a previously degraded stream candidate.
    if (this.playSession) this.requestSchedulePump()
  }

  /** Coalesce a burst of stream releases into one scheduler pass. */
  private requestSchedulePump(): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      if (this.playSession) this.pumpSchedule()
    })
  }

  private armPumpTimer(): void {
    this.clearPumpTimer()
    if (!this.playSession || !this.ctx) return
    // Re-pump before the current horizon expires so the next batch is armed.
    const delayMs = Math.max(50, (SCHEDULE_HORIZON_SEC - PUMP_LEAD_SEC) * 1000)
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      if (this.playSession) this.pumpSchedule()
    }, delayMs)
  }

  private releaseScheduled(entry: ScheduledSource): void {
    const idx = this.active.indexOf(entry)
    if (idx >= 0) this.active.splice(idx, 1)
    try {
      entry.src.onended = null
      entry.src.disconnect()
    } catch {
      /* already disconnected */
    }
    for (const node of entry.nodes) {
      try {
        node.disconnect()
      } catch {
        /* already disconnected */
      }
    }
  }

  stop(): void {
    this.clearPumpTimer()
    this.pumpQueued = false
    this.playSession = null
    this.streamCapErrors.clear()
    for (const entry of this.active) {
      try {
        entry.src.onended = null
        entry.src.stop()
      } catch {
        /* already stopped */
      }
      try {
        entry.src.disconnect()
      } catch {
        /* already disconnected */
      }
      for (const node of entry.nodes) {
        try {
          node.disconnect()
        } catch {
          /* already disconnected */
        }
      }
    }
    this.active = []
    // Clear playSession first so releaseStream does not re-pump.
    for (const entry of [...this.activeStreams]) this.releaseStream(entry)
    this.activeStreams = []
  }

  evictExcept(keepIds: Set<string>): void {
    // Record the keep-set so an in-flight decode that finishes after this checks
    // it before committing (no more relying on a *future* evictExcept to drop a
    // late buffer — that never happens if no further project loads occur, #7).
    this.keepIds = keepIds
    for (const id of [...this.decodeAttempts.keys()]) {
      if (!keepIds.has(id)) this.decodeAttempts.delete(id)
    }
    for (const id of [...this.buffers.keys()]) {
      if (!keepIds.has(id)) this.dropBuffer(id)
    }
    for (const id of [...this.failed]) {
      if (!keepIds.has(id)) this.failed.delete(id)
    }
    for (const id of [...this.decodeErrors.keys()]) {
      if (!keepIds.has(id)) this.decodeErrors.delete(id)
    }
    for (const entry of [...this.activeStreams]) {
      if (!keepIds.has(entry.assetId)) this.releaseStream(entry)
    }
    for (const [id, url] of [...this.streamUrls.entries()]) {
      if (keepIds.has(id)) continue
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      this.streamUrls.delete(id)
    }
    // After dropping non-keep, also enforce total RAM budget among survivors.
    this.evictToBudget()
  }

  dispose(): void {
    this.stop()
    for (const id of [...this.videoNodes.keys()]) this.releaseVideoAudio(id)
    // Empty keep-set: any in-flight decode that resolves after dispose must not
    // repopulate the cache.
    this.keepIds = new Set()
    this.buffers.clear()
    this.totalPcmBytes = 0
    this.decoding.clear()
    this.decodeAttempts.clear()
    this.poisonedDecodeAttempt = null
    this.failed.clear()
    this.decodeErrors.clear()
    for (const url of this.streamUrls.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    }
    this.streamUrls.clear()
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}

export function createAudioEngine(): AudioEngine {
  return new WebAudioEngine()
}

/** Cast for tests that need getTotalPcmBytes / getActiveSourceCount. */
export type AudioEngineInternals = WebAudioEngine

export const audioEngine = createAudioEngine()
