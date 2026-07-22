import type { Clip, Track } from '@engine/timeline'

import type { ExportEngine, ExportThroughputProfile } from './engine-advisor'
import type { ExportQualityProfile } from './quality'
import type { ExportDynamicRange, ExportVideoCodec } from './exporter'

const STORAGE_KEY = 'xinchao-export-throughput-v1'
const MAX_SAMPLES = 20

interface StoredSample {
  speedX: number
  count: number
  updatedAt: number
}

type StoredProfiles = Record<string, StoredSample>

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type ExportWorkload = 'simple' | 'captioned' | 'composited' | 'dense'

export interface ExportPerformanceContext {
  workload: ExportWorkload
  qualityProfile: ExportQualityProfile
  serverEncoder?: string | null
  videoCodec?: ExportVideoCodec
  dynamicRange?: ExportDynamicRange
}

function bucket(height: number): number {
  if (height <= 720) return 720
  if (height <= 1080) return 1080
  return 2160
}

function profileKey(
  engine: ExportEngine,
  height: number,
  fps: number,
  context?: ExportPerformanceContext,
): string {
  const base = `${engine}:${bucket(height)}:${fps >= 50 ? 60 : 30}`
  if (!context) return base
  const encoder = engine === 'server'
    ? (context.serverEncoder || 'unknown').toLowerCase()
    : 'webcodecs'
  return `${base}:${context.workload}:${context.qualityProfile}:${encoder}:${context.videoCodec ?? 'h264'}:${context.dynamicRange ?? 'sdr'}`
}

/**
 * Find a machine measurement with the same output/codec settings when the
 * exact workload bucket has not been measured yet. Workload-specific samples
 * still win; this is only a cold-bucket fallback so a fast measured GPU does
 * not revert to the very conservative built-in Browser estimate merely because
 * the next timeline moved from e.g. `dense` to `composited`.
 */
function compatibleProfile(
  profiles: StoredProfiles,
  engine: ExportEngine,
  height: number,
  fps: number,
  context?: ExportPerformanceContext,
): StoredSample | undefined {
  if (!context) return undefined
  const base = profileKey(engine, height, fps)
  const encoder = engine === 'server'
    ? (context.serverEncoder || 'unknown').toLowerCase()
    : 'webcodecs'
  const suffix =
    `:${context.qualityProfile}:${encoder}:` +
    `${context.videoCodec ?? 'h264'}:${context.dynamicRange ?? 'sdr'}`
  let newest: StoredSample | undefined
  for (const [key, sample] of Object.entries(profiles)) {
    if (!key.startsWith(`${base}:`) || !key.endsWith(suffix)) continue
    if (!newest || sample.updatedAt > newest.updatedAt) newest = sample
  }
  return newest
}

function neutralTransform(clip: Clip): boolean {
  const transform = clip.transform ?? {} as Clip['transform']
  const crop = transform.crop
  return (
    Math.abs((transform.x ?? 0.5) - 0.5) < 1e-6 &&
    Math.abs((transform.y ?? 0.5) - 0.5) < 1e-6 &&
    Math.abs((transform.scale ?? 1) - 1) < 1e-6 &&
    Math.abs((transform.scaleX ?? 1) - 1) < 1e-6 &&
    Math.abs((transform.scaleY ?? 1) - 1) < 1e-6 &&
    Math.abs(transform.rotation ?? 0) < 1e-6 &&
    !transform.flipH && !transform.flipV &&
    (!crop || [crop.l, crop.r, crop.t, crop.b].every((value) => Math.abs(value ?? 0) < 1e-6))
  )
}

/** Keep throughput samples from unrelated workloads from poisoning estimates. */
export function classifyExportWorkload(clips: Clip[], tracks: Track[]): ExportWorkload {
  const hidden = new Set(tracks.filter((track) => track.hidden).map((track) => track.id))
  const kindByTrack = new Map(tracks.map((track) => [track.id, track.kind]))
  const visible = clips.filter((clip) => !hidden.has(clip.trackId))
  const media = visible.filter((clip) => {
    const kind = kindByTrack.get(clip.trackId)
    return kind === 'video' || kind === 'audio'
  })
  const text = visible.filter((clip) => kindByTrack.get(clip.trackId) === 'text')
  const edited = media.some((clip) => {
    const adjust = clip.adjust
    return (
      Math.abs((clip.speed ?? 1) - 1) > 1e-6 ||
      Math.abs((clip.opacity ?? 1) - 1) > 1e-6 ||
      !!clip.denoise || !!clip.effects?.length || !!clip.keyframes ||
      clip.canvasFill?.mode === 'blur' ||
      !!adjust && !!(adjust.brightness || adjust.contrast || adjust.saturation) ||
      !neutralTransform(clip)
    )
  })
  const hasFx = visible.some((clip) => kindByTrack.get(clip.trackId) === 'fx')
  if (visible.length > 96 || media.length > 64) return 'dense'
  if (media.length <= 1 && !edited && !hasFx) {
    return text.length > 0 ? 'captioned' : 'simple'
  }
  return 'composited'
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readProfiles(storage?: StorageLike): StoredProfiles {
  const target = resolveStorage(storage)
  if (!target) return {}
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? parsed as StoredProfiles : {}
  } catch {
    return {}
  }
}

export function loadExportThroughputProfile(
  height: number,
  fps: number,
  storage?: StorageLike,
  context?: ExportPerformanceContext,
): ExportThroughputProfile {
  const profiles = readProfiles(storage)
  const browser = profiles[profileKey('browser', height, fps, context)]
    ?? compatibleProfile(profiles, 'browser', height, fps, context)
    ?? profiles[profileKey('browser', height, fps)]
  const server = profiles[profileKey('server', height, fps, context)]
    ?? compatibleProfile(profiles, 'server', height, fps, context)
    ?? profiles[profileKey('server', height, fps)]
  return {
    browserSpeedX: browser?.speedX,
    serverSpeedX: server?.speedX,
  }
}

export function recordExportThroughput(
  engine: ExportEngine,
  height: number,
  fps: number,
  durationSec: number,
  elapsedSec: number,
  storage?: StorageLike,
  context?: ExportPerformanceContext,
): void {
  if (durationSec < 5 || elapsedSec <= 0 || !Number.isFinite(elapsedSec)) return
  const speedX = Math.min(20, Math.max(0.01, durationSec / elapsedSec))
  const target = resolveStorage(storage)
  if (!target) return
  const profiles = readProfiles(target)
  const key = profileKey(engine, height, fps, context)
  const previous = profiles[key]
  const count = Math.min(MAX_SAMPLES, (previous?.count ?? 0) + 1)
  // Give recent runs more weight while retaining enough history to smooth
  // background load and codec-specific variance.
  const alpha = previous ? Math.max(0.15, 2 / (count + 1)) : 1
  profiles[key] = {
    speedX: previous ? previous.speedX * (1 - alpha) + speedX * alpha : speedX,
    count,
    updatedAt: Date.now(),
  }
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch {
    // Private mode / full storage: estimates fall back to conservative defaults.
  }
}
