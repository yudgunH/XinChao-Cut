import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'
import { clipEffectiveDuration } from '@engine/timeline'
import { DEFAULT_MAX_EXPORT_READERS, sourceMappingKey } from './reader-pool'

/** Beyond this, overflow mappings open/parse/decode/close for nearly every frame. */
export const MAX_BROWSER_CONCURRENT_VIDEO_MAPPINGS = DEFAULT_MAX_EXPORT_READERS
/** Conservative source-texture warning threshold; decode/encode surfaces are extra. */
export const MAX_BROWSER_GPU_TEXTURE_BYTES = 256 * 1024 * 1024

/** Keep an OPFS failure from turning a long MP4 into a renderer-sized ArrayBuffer. */
export const MAX_BROWSER_IN_MEMORY_OUTPUT_BYTES = 256 * 1024 * 1024

export interface BrowserVideoLoad {
  maxMappings: number
  atSec: number
  peakTextureBytes: number
}

export interface BrowserStorageSnapshot {
  usageBytes: number
  quotaBytes: number
  availableBytes: number
  persisted: boolean | null
}

export class BrowserStorageHeadroomError extends Error {
  override name = 'BrowserStorageHeadroomError'
}

export async function getBrowserStorageSnapshot(): Promise<BrowserStorageSnapshot | null> {
  if (!navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  const usageBytes = Math.max(0, estimate.usage ?? 0)
  const quotaBytes = Math.max(0, estimate.quota ?? 0)
  const persisted = navigator.storage.persisted
    ? await navigator.storage.persisted().catch(() => null)
    : null
  return {
    usageBytes,
    quotaBytes,
    availableBytes: Math.max(0, quotaBytes - usageBytes),
    persisted,
  }
}

export function assertBrowserStorageHeadroom(
  snapshot: BrowserStorageSnapshot | null,
  estimatedOutputBytes: number,
  margin = 1.2,
): void {
  if (!snapshot?.quotaBytes) return
  const required = Math.ceil(Math.max(0, estimatedOutputBytes) * margin)
  if (snapshot.availableBytes >= required) return
  const mib = (bytes: number) => Math.max(0, bytes / 1024 / 1024).toFixed(0)
  throw new BrowserStorageHeadroomError(
    `Browser storage has approximately ${mib(snapshot.availableBytes)} MiB available, ` +
    `but this export needs about ${mib(required)} MiB including safety margin. ` +
    `Choose a native output folder for direct streaming, clear old projects, or use server export.`,
  )
}

export function estimateBrowserOutputBytes(
  durationSec: number,
  videoBitrateKbps: number,
  hasAudio: boolean,
  audioBitrateKbps: number = 128,
): number {
  const totalKbps = Math.max(0, videoBitrateKbps) + (
    hasAudio ? Math.max(0, audioBitrateKbps) : 0
  )
  return Math.ceil(Math.max(0, durationSec) * totalKbps * 1000 / 8 * 1.1)
}

/** Peak distinct source-time mappings active at one timeline instant. */
export function measureBrowserVideoLoad(
  clips: Clip[],
  tracks: Track[],
  assets: Array<
    Pick<MediaAsset, 'id'> & Partial<Pick<MediaAsset, 'kind' | 'width' | 'height'>>
  > = [],
): BrowserVideoLoad {
  const hidden = new Set(tracks.filter((t) => t.hidden).map((t) => t.id))
  const videoTracks = new Set(tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const events: Array<{ t: number; delta: 1 | -1; key: string; bytes: number }> = []
  for (const clip of clips) {
    if (!videoTracks.has(clip.trackId) || !clip.assetId || hidden.has(clip.trackId)) continue
    const key = sourceMappingKey(clip)
    const duration = clipEffectiveDuration(clip)
    if (!key || duration <= 0) continue
    const asset = assetById.get(clip.assetId)
    if (asset?.kind && asset.kind !== 'video') continue
    const bytes = Math.max(1, asset?.width ?? 1920) * Math.max(1, asset?.height ?? 1080) * 4
    events.push({ t: clip.startSec, delta: 1, key, bytes })
    events.push({ t: clip.startSec + duration, delta: -1, key, bytes })
  }
  // Ends before starts at the same timestamp: adjacent clips do not overlap.
  events.sort((a, b) => a.t - b.t || a.delta - b.delta)
  const refs = new Map<string, number>()
  let active = 0
  let maxMappings = 0
  let atSec = 0
  let activeTextureBytes = 0
  let peakTextureBytes = 0
  for (const event of events) {
    const before = refs.get(event.key) ?? 0
    const after = Math.max(0, before + event.delta)
    if (before === 0 && after > 0) {
      active++
      activeTextureBytes += event.bytes
    } else if (before > 0 && after === 0) {
      active--
      activeTextureBytes = Math.max(0, activeTextureBytes - event.bytes)
    }
    if (after === 0) refs.delete(event.key)
    else refs.set(event.key, after)
    if (active > maxMappings) {
      maxMappings = active
      atSec = event.t
    }
    peakTextureBytes = Math.max(peakTextureBytes, activeTextureBytes)
  }
  return { maxMappings, atSec, peakTextureBytes }
}

export function assertSafeInMemoryBrowserOutput(estimatedBytes: number): void {
  if (estimatedBytes <= MAX_BROWSER_IN_MEMORY_OUTPUT_BYTES) return
  const estimatedMiB = Math.ceil(estimatedBytes / 1024 / 1024)
  throw new Error(
    `Browser export needs approximately ${estimatedMiB} MiB of encoded output, but OPFS ` +
    `scratch storage is unavailable. Refusing to buffer the entire MP4 in renderer RAM; ` +
    `use server export or restore browser storage access.`,
  )
}
