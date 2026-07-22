import type { Clip, Track } from '@engine/timeline'

export interface AudioEngine {
  /** Decode and cache an asset's audio. Safe to call repeatedly. */
  ensureDecoded(assetId: string, blob: Blob, signal?: AbortSignal): Promise<void>
  /** Register a streamable URL without materialising a multi-GB source Blob. */
  ensureStreamSource(assetId: string, url: string): void
  hasBuffer(assetId: string): boolean
  /** True when preview can play either decoded PCM or the bounded streaming path. */
  hasPlaybackSource(assetId: string): boolean
  /** True only for the bounded HTMLMediaElement streaming path. */
  isStreamSource(assetId: string): boolean
  getBuffer(assetId: string): AudioBuffer | null
  /** Why `ensureDecoded` produced no buffer (too large / no audio track /
   *  corrupt), or null when the asset decoded fine or was never attempted. */
  getDecodeError(assetId: string): string | null
  /**
   * Why a long-audio *clip* was not admitted a stream element (hard cap on
   * concurrent HTMLMediaElement pipelines). Null when the clip is playing or
   * was never a stream candidate.
   */
  getStreamAdmissionError(clipId: string): string | null
  /** Clip ids currently refused due to stream capacity (UI telemetry). */
  getStreamDegradedClipIds(): string[]
  /** Schedule all audible clips starting from the given timeline position. */
  play(timelineSec: number, clips: Clip[], tracks: Track[]): void
  /** Stop and disconnect all scheduled sources. */
  stop(): void
  setMasterVolume(v: number): void
  /** Set a video-track clip's monitoring volume on its <video> element. Supports
   *  boost > 1.0 (which HTMLMediaElement.volume can't — it clamps to 1) by routing
   *  the element through a WebAudio GainNode when needed, so preview loudness
   *  matches the exported file. `clipVol` is the clip-local linear volume with mute
   *  already folded to 0; master volume is applied on top.
   *
   *  `instanceId` is the preview playback-instance key (sourceMappingKey), not
   *  assetId — overlapping same-asset clips need independent gain routing. */
  setVideoClipVolume(instanceId: string, el: HTMLVideoElement, clipVol: number): void
  /** Tear down any WebAudio routing for a pooled video instance being disposed. */
  releaseVideoAudio(instanceId: string): void
  /** Drop cached PCM buffers whose asset id is not in `keepIds`. Does not touch
   *  videoNodes or in-flight decode tasks (those may still land after eviction). */
  evictExcept(keepIds: Set<string>): void
  dispose(): void
}
