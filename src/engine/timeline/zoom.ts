/** Small enough to fit any realistic media duration while staying non-zero. */
export const ABSOLUTE_MIN_TIMELINE_ZOOM = 0.000001
export const DEFAULT_MIN_TIMELINE_ZOOM = 0.05
export const MAX_TIMELINE_ZOOM = 400

// Chromium/WebView layout dimensions have an implementation-defined ceiling.
// Stay well below it so multi-day media never loses its tail at high zoom.
export const MAX_SAFE_TIMELINE_WIDTH_PX = 8_000_000

export function maxSafeTimelineZoom(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MAX_TIMELINE_ZOOM
  return Math.max(
    ABSOLUTE_MIN_TIMELINE_ZOOM,
    Math.min(MAX_TIMELINE_ZOOM, MAX_SAFE_TIMELINE_WIDTH_PX / durationSec),
  )
}

export function clampTimelineZoom(zoom: number, durationSec: number): number {
  const finite = Number.isFinite(zoom) ? zoom : DEFAULT_MIN_TIMELINE_ZOOM
  return Math.max(
    ABSOLUTE_MIN_TIMELINE_ZOOM,
    Math.min(maxSafeTimelineZoom(durationSec), finite),
  )
}

export function fitTimelineZoom(durationSec: number, viewportWidth: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return DEFAULT_MIN_TIMELINE_ZOOM
  const width = Math.max(1, Number.isFinite(viewportWidth) ? viewportWidth : 1)
  return clampTimelineZoom((width * 0.9) / durationSec, durationSec)
}

export function sliderMinTimelineZoom(durationSec: number, viewportWidth: number): number {
  return Math.max(
    ABSOLUTE_MIN_TIMELINE_ZOOM,
    Math.min(DEFAULT_MIN_TIMELINE_ZOOM, fitTimelineZoom(durationSec, viewportWidth)),
  )
}
