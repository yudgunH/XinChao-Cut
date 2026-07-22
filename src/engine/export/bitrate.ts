import type { MediaAsset } from '@engine/media'
import type { Clip, Track } from '@engine/timeline'

/**
 * Conventional ceiling when trustworthy source metadata is unavailable.
 *
 * Scales by output AREA, not height alone. The `base` values are the
 * conventional rates for a 16:9 frame at each height; a frame that is narrower
 * than 16:9 (a 608x1080 vertical is only ~32% of a 1920x1080 landscape's area)
 * must not inherit the full-width ceiling — that over-provisions the encoder ~3x
 * for no perceptible gain and bloats the file. We scale `base` by the frame's
 * width relative to the 16:9 width at this height, clamped so we never inflate a
 * wider-than-16:9 frame above base, and never collapse a very thin frame below a
 * usable fraction.
 */
export function conventionalVideoBitrateKbps(
  width: number,
  height: number,
  fps: number,
): number {
  const base = height <= 720 ? 5_000 : height <= 1080 ? 8_000 : 35_000
  const reference169Width = (height * 16) / 9
  const areaScale =
    reference169Width > 0 && width > 0
      ? Math.min(1, Math.max(0.35, width / reference169Width))
      : 1
  const scaled = base * areaScale
  return fps >= 60 ? Math.round(scaled * 1.5) : Math.round(scaled)
}

function visibleVideoAssetIds(clips: Clip[], tracks: Track[]): Set<string> {
  const videoTracks = new Set(
    tracks.filter((track) => track.kind === 'video' && !track.hidden).map((track) => track.id),
  )
  return new Set(
    clips
      .filter((clip) => clip.assetId && videoTracks.has(clip.trackId))
      .map((clip) => clip.assetId!),
  )
}

/** Use source complexity instead of inflating every 1080p input to 8 Mbps. */
export function recommendedVideoBitrateKbps(input: {
  width: number
  height: number
  fps: number
  assets: MediaAsset[]
  clips: Clip[]
  tracks: Track[]
}): number {
  const conventional = conventionalVideoBitrateKbps(input.width, input.height, input.fps)
  const used = visibleVideoAssetIds(input.clips, input.tracks)
  const sourceRates = input.assets
    .filter((asset) =>
      used.has(asset.id) && asset.kind === 'video' &&
      asset.sizeBytes > 0 && asset.durationSec > 0,
    )
    .map((asset) => (asset.sizeBytes * 8) / asset.durationSec / 1_000)
    .filter((rate) => Number.isFinite(rate) && rate > 0)

  if (sourceRates.length === 0) return conventional

  // Container rate includes source audio; 25% headroom covers the output audio
  // track and extra entropy from captions/effects without inventing detail.
  const sourceAware = Math.max(...sourceRates) * 1.25
  const floor = input.height <= 720 ? 900 : input.height <= 1080 ? 1_500 : 5_000
  const fpsFactor = input.fps >= 60 ? 1.35 : 1
  return Math.round(Math.min(conventional, Math.max(floor, sourceAware * fpsFactor)))
}
