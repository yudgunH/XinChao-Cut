import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'

import { normalizeCaptionWordTimestamps } from '../timeline/caption-timing'
import { clipEffectiveDuration } from '../timeline/types'

import type { ExportSettings } from './exporter'
import type { ExportQualityProfile } from './quality'
import type { AudioMasteringPreset } from './audio-mastering'

export interface ExportSpec {
  width: number
  height: number
  fps: number
  durationSec: number
  videoBitrateKbps: number
  qualityProfile?: ExportQualityProfile
  audioBitrateKbps?: number
  audioMastering?: AudioMasteringPreset
  videoCodec?: ExportSettings['videoCodec']
  dynamicRange?: ExportSettings['dynamicRange']
  tracks: { id: string; kind: string; muted: boolean }[]
  clips: Record<string, unknown>[]
  /** Bundled caption fonts uploaded to the asset store — the backend copies the
   *  files into the job dir (fontsdir) and uses family→assFamily/sizeScale to
   *  write the ASS Fontname libass actually matches and to compensate the
   *  VSFilter cell-height sizing so the burn is the same visual size as the
   *  canvas preview. */
  captionFonts?: { hash: string; name: string; family: string; assFamily: string; sizeScale: number }[]
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
    qualityProfile: settings.qualityProfile,
    audioBitrateKbps: settings.audioBitrateKbps,
    audioMastering: settings.audioMastering,
    videoCodec: settings.videoCodec,
    dynamicRange: settings.dynamicRange,
    tracks: tracks.map((t) => ({ id: t.id, kind: t.kind, muted: t.muted, hidden: !!t.hidden })),
    clips: clips.map((c) => {
      const asset = c.assetId ? assetById.get(c.assetId) : undefined
      const track = tracks.find((candidate) => candidate.id === c.trackId)
      const kind = c.fxData
        ? 'fx'
        : c.textData
          ? 'text'
          // "Detach audio" intentionally keeps the original video asset but
          // places the new clip on an audio track.  The track is authoritative
          // in that case; serialising asset.kind first turns the detached clip
          // back into a visual video layer and can drop the intended split-audio
          // continuation in the server/hybrid graph.
          : track?.kind === 'audio'
            ? 'audio'
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
        // Preserve the replacement relationship for Hybrid audio diagnostics
        // and recovery. The detached clip deliberately reuses the video asset.
        detachedFromClipId: c.detachedFromClipId ?? null,
        denoise: c.denoise ?? null,
        hasAudio: !c.muted && assetHasAudio(asset),
        adjust: c.adjust,
        transform: c.transform,
        canvasFill: c.canvasFill ?? null,
        keyframes: c.keyframes ?? null,
        effects: c.effects ?? [],
        textData: c.textData
          ? {
              ...c.textData,
              wordTimestamps: c.textData.wordTimestamps?.length
                ? normalizeCaptionWordTimestamps(
                    c.textData.content,
                    c.textData.wordTimestamps,
                    clipEffectiveDuration(c),
                  ).words
                : c.textData.wordTimestamps,
            }
          : null,
        fxData: c.fxData ?? null,
      }
    }),
  }
}

/** Asset ids actually referenced by clips (so we only sync what's needed). */
export function usedAssetIds(clips: Clip[]): string[] {
  return Array.from(new Set(clips.map((c) => c.assetId).filter((id): id is string => !!id)))
}

// Effects the backend FFmpeg builder reproduces faithfully (see ffmpeg_build.py:
// _fades + _zoom_expr). Every OTHER animated feature — keyframes of any kind, and
// motion effects like pan/pulse/tilt/slide/rise/drop — is only matched by the
// canvas (preview) renderer, which the browser/WebCodecs exporter shares.
const FFMPEG_SUPPORTED_EFFECTS = new Set(['fade-in', 'fade-out', 'zoom-in', 'zoom-out'])

/**
 * Reasons the server (FFmpeg) export would NOT match the preview for this
 * timeline, as stable tokens: 'keyframes' or `effect:<type>`. Empty array means
 * the fast FFmpeg path renders identically. Callers route non-empty timelines to
 * the browser exporter (the preview renderer) so the output always matches.
 */
// FFmpeg expression limits: the filtergraph fails to parse very long nested-if
// exprs. scale/overlay exprs break above ~80 points; geq (opacity) is far more
// fragile. Above these counts on a single track we render on the browser instead
// (it handles any number of keyframes). Comfortably above normal hand-keyframing
// and above the compound effect-bake density (transform 48 / opacity 16).
const FFMPEG_MAX_TRANSFORM_KEYFRAMES = 64
const FFMPEG_MAX_OPACITY_KEYFRAMES = 24

// Text is burned via libass (ass.py), which reproduces position/style/reveal,
// static opacity, and fade-in/out — but NOT clip transform (scale/rotate/move),
// keyframes, or animated motion effects. Those need the canvas (browser) renderer.
const ASS_SUPPORTED_TEXT_EFFECTS = new Set(['fade-in', 'fade-out'])

function isNeutralTransform(t: Clip['transform'] | undefined): boolean {
  if (!t) return true
  const near = (v: number | undefined, target: number) => Math.abs((v ?? target) - target) < 1e-3
  return (
    near(t.x, 0.5) && near(t.y, 0.5) && near(t.scale, 1) &&
    near(t.scaleX, 1) && near(t.scaleY, 1) && near(t.rotation, 0) &&
    !t.flipH && !t.flipV && !t.crop
  )
}

/**
 * STRICT parity gating: reasons the server (FFmpeg) render would not be
 * PIXEL-IDENTICAL to the preview — not merely "a close mirror". Anything the
 * canvas renderers draw (captions, fx, blur fill, colour adjust, effects,
 * opacity, keyframes, non-neutral transforms) is a gap; the server is then only
 * used for pure trim/concat/transcode timelines, where there is nothing to
 * drift. `serverExportGaps` (below) remains the looser "acceptable
 * approximation" list behind the user's speed-over-parity toggle.
 */
export function serverExportStrictGaps(clips: Clip[]): string[] {
  const gaps = new Set<string>(serverExportGaps(clips))
  for (const c of clips) {
    if (c.textData) gaps.add('captions')
    if (c.fxData) gaps.add('fx')
    if (c.canvasFill?.mode === 'blur') gaps.add('blur-fill')
    if (c.adjust && (c.adjust.brightness || c.adjust.contrast || c.adjust.saturation)) gaps.add('adjust')
    if ((c.effects ?? []).length > 0) gaps.add('effects')
    if ((c.opacity ?? 1) < 0.999) gaps.add('opacity')
    if (c.keyframes && Object.values(c.keyframes).some((t) => Array.isArray(t) && t.length > 0)) gaps.add('keyframes')
    if (!isNeutralTransform(c.transform)) gaps.add('transform')
  }
  return [...gaps]
}

export function serverExportGaps(clips: Clip[]): string[] {
  const gaps = new Set<string>()
  for (const c of clips) {
    const hasKeyframes = !!c.keyframes &&
      Object.values(c.keyframes).some((t) => Array.isArray(t) && t.length > 0)

    if (c.textData) {
      // libass can't animate or transform the text — route those to the browser.
      if (hasKeyframes || !isNeutralTransform(c.transform)) gaps.add('text-animation')
      for (const e of c.effects ?? []) {
        if (!ASS_SUPPORTED_TEXT_EFFECTS.has(e.type)) gaps.add('text-animation')
      }
      continue
    }

    // Video/image: keyframes (x/y/scale/scaleX/scaleY/rotation via expressions,
    // opacity via geq) render in FFmpeg — unless a track is so dense the
    // expression would overflow the filtergraph parser.
    for (const [prop, track] of Object.entries(c.keyframes ?? {})) {
      const n = Array.isArray(track) ? track.length : 0
      const max = prop === 'opacity' ? FFMPEG_MAX_OPACITY_KEYFRAMES : FFMPEG_MAX_TRANSFORM_KEYFRAMES
      if (n > max) gaps.add('dense-keyframes')
    }
    // Motion effects the builder doesn't implement still need the browser.
    for (const e of c.effects ?? []) {
      if (!FFMPEG_SUPPORTED_EFFECTS.has(e.type)) gaps.add(`effect:${e.type}`)
    }
  }
  return [...gaps]
}
