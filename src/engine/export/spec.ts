import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

import type { ExportSettings } from './exporter'

export interface ExportSpec {
  width: number
  height: number
  fps: number
  durationSec: number
  videoBitrateKbps: number
  tracks: { id: string; kind: string; muted: boolean }[]
  clips: Record<string, unknown>[]
}

/** A video asset has real audio if its waveform has more than the [0] sentinel. */
function assetHasAudio(asset: MediaAsset | undefined): boolean {
  if (!asset) return false
  if (asset.kind === 'audio') return true
  if (asset.kind === 'video') return !!asset.waveformPeaks && asset.waveformPeaks.length > 1
  return false
}

/**
 * Serialise the current timeline into a portable spec the backend FFmpeg
 * builder understands. `hashByAssetId` maps local asset ids → server content
 * hashes (the server references media by hash).
 */
export function buildExportSpec(
  settings: ExportSettings,
  durationSec: number,
  clips: Clip[],
  tracks: Track[],
  assets: MediaAsset[],
  hashByAssetId: Map<string, string>,
): ExportSpec {
  const assetById = new Map(assets.map((a) => [a.id, a]))

  return {
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    durationSec,
    videoBitrateKbps: settings.videoBitrateKbps,
    tracks: tracks.map((t) => ({ id: t.id, kind: t.kind, muted: t.muted })),
    clips: clips.map((c) => {
      const asset = c.assetId ? assetById.get(c.assetId) : undefined
      const track = tracks.find((candidate) => candidate.id === c.trackId)
      const kind = c.fxData
        ? 'fx'
        : c.textData
          ? 'text'
          : (asset?.kind ?? track?.kind ?? 'video')
      return {
        id: c.id,
        assetId: c.assetId ? (hashByAssetId.get(c.assetId) ?? null) : null,
        sourcePath: asset?.sourcePath ?? null,
        trackId: c.trackId,
        kind,
        startSec: c.startSec,
        inPointSec: c.inPointSec,
        outPointSec: c.outPointSec,
        speed: c.speed,
        opacity: c.opacity,
        volume: c.volume,
        muted: !!c.muted,
        denoise: c.denoise ?? null,
        hasAudio: !c.muted && assetHasAudio(asset),
        adjust: c.adjust,
        transform: c.transform,
        effects: c.effects ?? [],
        textData: c.textData ?? null,
        fxData: c.fxData ?? null,
      }
    }),
  }
}

/** Asset ids actually referenced by clips (so we only sync what's needed). */
export function usedAssetIds(clips: Clip[]): string[] {
  return Array.from(new Set(clips.map((c) => c.assetId).filter((id): id is string => !!id)))
}
