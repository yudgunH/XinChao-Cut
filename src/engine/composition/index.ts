export { createCompositor } from './compositor'
export type { Compositor, RenderRequest } from './types'
export {
  buildRenderPlan,
  getExportMediaRect,
  mediaDrawCacheKey,
  resolveRenderPlanDraws,
  CAPTION_OVERLAY_ASSET_ID,
  CAPTION_OVERLAY_CLIP_ID,
  type BuildRenderPlanInput,
  type RenderPlan,
  type RenderPlanDrawDescriptor,
  type RenderPlanSourceInfo,
} from './render-plan'
