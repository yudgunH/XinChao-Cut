import type { GpuMediaDraw, GpuRect } from '@engine/preview/gpu-compositor'
import {
  makeDefaultTransform,
  resolveClipOpacityAt,
  resolveClipTransformAt,
  type Clip,
  type ClipTransform,
  type Track,
} from '@engine/timeline'
import { BLUR_REF_HEIGHT } from '@engine/timeline/types'

const MIN_AXIS_SCALE = 0.05
export const CAPTION_OVERLAY_CLIP_ID = '__xinchao_caption_overlay__'
export const CAPTION_OVERLAY_ASSET_ID = '__xinchao_caption_overlay__'

export interface RenderPlanSourceInfo {
  sourceW: number
  sourceH: number
  frameVersion: number
}

export interface RenderPlanDrawDescriptor extends Omit<GpuMediaDraw, 'source'> {
  clipId: string
}

export interface RenderPlan {
  mediaDraws: RenderPlanDrawDescriptor[]
  captionClips: Clip[]
  fxClips: Clip[]
  /** Full-frame transparent caption layer used by exporter zero-copy only when
   * no Canvas2D effect must remain between media and text. */
  captionOverlayDraw?: RenderPlanDrawDescriptor
}

export interface BuildRenderPlanInput {
  mediaClips: readonly Clip[]
  captionClips: readonly Clip[]
  fxClips: readonly Clip[]
  tracks: readonly Track[]
  outputWidth: number
  outputHeight: number
  timelineSec: number
  /** Export passes its output-frame index; preview can pass its render epoch. */
  overlayFrameVersion: number
  sources: ReadonlyMap<string, RenderPlanSourceInfo>
}

/** Texture-cache key for one media occurrence in the current frame. */
export function mediaDrawCacheKey(assetId: string, occurrence: number): string {
  return occurrence <= 0 ? assetId : `${assetId}#${occurrence}`
}

/** Shared contain-fit/crop geometry used by preview and browser export. */
export function getExportMediaRect(
  sw: number,
  sh: number,
  cw: number,
  ch: number,
  transform: ClipTransform,
): GpuRect {
  const t = { ...makeDefaultTransform(), ...transform }
  const crop = t.crop
  const csw = crop ? sw * Math.max(0.02, 1 - crop.l - crop.r) : sw
  const csh = crop ? sh * Math.max(0.02, 1 - crop.t - crop.b) : sh
  const scale = Math.min(cw / csw, ch / csh) * Math.max(0.05, t.scale)
  const dw = csw * scale * Math.max(MIN_AXIS_SCALE, t.scaleX)
  const dh = csh * scale * Math.max(MIN_AXIS_SCALE, t.scaleY)
  return { x: t.x * cw - dw / 2, y: t.y * ch - dh / 2, w: dw, h: dh }
}

export function buildRenderPlan(input: BuildRenderPlanInput): RenderPlan {
  const visibleTrackKinds = new Map(
    input.tracks
      .filter((track) => !track.hidden)
      .map((track) => [track.id, track.kind] as const),
  )
  const captionClips = input.captionClips.filter(
    (clip) => visibleTrackKinds.get(clip.trackId) === 'text',
  )
  const fxClips = input.fxClips.filter(
    (clip) => visibleTrackKinds.get(clip.trackId) === 'fx',
  )
  const mediaDraws: RenderPlanDrawDescriptor[] = []
  const assetSeen = new Map<string, number>()

  for (const clip of input.mediaClips) {
    if (!clip.assetId || visibleTrackKinds.get(clip.trackId) !== 'video') continue
    const source = input.sources.get(clip.id)
    if (!source) continue
    const occurrence = assetSeen.get(clip.assetId) ?? 0
    assetSeen.set(clip.assetId, occurrence + 1)
    const transform = resolveClipTransformAt(clip, input.timelineSec)
    const crop = transform.crop
    const adjust = clip.adjust ?? { brightness: 0, contrast: 0, saturation: 0 }
    const opacity = resolveClipOpacityAt(clip, input.timelineSec)
    const canvasFill = clip.canvasFill
    mediaDraws.push({
      clipId: clip.id,
      assetId: clip.assetId,
      cacheKey: mediaDrawCacheKey(clip.assetId, occurrence),
      sourceW: source.sourceW,
      sourceH: source.sourceH,
      rect: getExportMediaRect(
        source.sourceW,
        source.sourceH,
        input.outputWidth,
        input.outputHeight,
        transform,
      ),
      rotationRad: (transform.rotation * Math.PI) / 180,
      flipH: !!transform.flipH,
      flipV: !!transform.flipV,
      uv: crop
        ? { u0: crop.l, v0: crop.t, u1: 1 - crop.r, v1: 1 - crop.b }
        : { u0: 0, v0: 0, u1: 1, v1: 1 },
      opacity,
      adjust: {
        b: 1 + adjust.brightness / 100,
        c: 1 + adjust.contrast / 100,
        s: 1 + adjust.saturation / 100,
      },
      frameVersion: source.frameVersion,
      blurFill:
        canvasFill?.mode === 'blur'
          ? {
              sigma:
                Math.max(0, Math.min(80, canvasFill.blurPx ?? 34)) *
                (input.outputHeight / BLUR_REF_HEIGHT),
              extraScale: Math.max(1, canvasFill.scale ?? 1.08),
              opacity:
                Math.max(0, Math.min(1, canvasFill.opacity ?? 1)) *
                opacity,
            }
          : undefined,
    })
  }

  const captionOverlayDraw =
    fxClips.length === 0 && captionClips.length > 0
      ? {
          clipId: CAPTION_OVERLAY_CLIP_ID,
          assetId: CAPTION_OVERLAY_ASSET_ID,
          sourceW: input.outputWidth,
          sourceH: input.outputHeight,
          rect: { x: 0, y: 0, w: input.outputWidth, h: input.outputHeight },
          rotationRad: 0,
          flipH: false,
          flipV: false,
          uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
          opacity: 1,
          adjust: { b: 1, c: 1, s: 1 },
          frameVersion: input.overlayFrameVersion,
        }
      : undefined

  return {
    mediaDraws,
    captionClips,
    fxClips,
    captionOverlayDraw,
  }
}

export function resolveRenderPlanDraws(
  descriptors: readonly RenderPlanDrawDescriptor[],
  resolveSource: (clipId: string) => GpuMediaDraw['source'] | null,
): GpuMediaDraw[] {
  const draws: GpuMediaDraw[] = []
  for (const descriptor of descriptors) {
    const { clipId, ...draw } = descriptor
    const source = resolveSource(clipId)
    if (!source) continue
    draws.push({ ...draw, source })
  }
  return draws
}
