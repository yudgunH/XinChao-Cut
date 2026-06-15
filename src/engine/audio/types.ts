import type { Clip, Track } from '@engine/timeline'

export interface AudioEngine {
  /** Decode and cache an asset's audio. Safe to call repeatedly. */
  ensureDecoded(assetId: string, blob: Blob): Promise<void>
  hasBuffer(assetId: string): boolean
  getBuffer(assetId: string): AudioBuffer | null
  /** Schedule all audible clips starting from the given timeline position. */
  play(timelineSec: number, clips: Clip[], tracks: Track[]): void
  /** Stop and disconnect all scheduled sources. */
  stop(): void
  setMasterVolume(v: number): void
  dispose(): void
}
