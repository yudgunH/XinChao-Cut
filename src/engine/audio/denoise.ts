/**
 * Shared helpers for the real-time spectral-gate denoise AudioWorklet.
 * Used by both live preview (audio-engine) and offline audio export
 * (exporter.renderAudioMix) so the two stay consistent.
 */
import type { DenoiseLevel } from '@engine/timeline'

// `?url` makes Vite emit the worklet as a standalone asset and hand back its
// URL — AudioWorklet.addModule needs a real URL, not a bundled module.
import denoiseWorkletUrl from './denoise-processor.js?url'

/**
 * Noise floor (dBFS) per strength. Must match the backend's `_DENOISE_NF`
 * (ffmpeg_build.py) so preview ≈ server export.
 */
export const DENOISE_NF: Record<DenoiseLevel, number> = {
  light: -30,
  medium: -25,
  heavy: -20,
}

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>()

/**
 * Register the denoise worklet on a context (idempotent per context).
 * Resolves true if the processor is available, false if loading failed.
 */
export function loadDenoiseModule(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx)
  if (!p) {
    p = ctx.audioWorklet
      .addModule(denoiseWorkletUrl)
      .then(() => true)
      .catch(() => false)
    loaded.set(ctx, p)
  }
  return p
}

/**
 * Create a denoise AudioWorkletNode for the given level. The module must
 * already be loaded (loadDenoiseModule resolved true), else this throws —
 * callers should guard with the load result.
 */
export function createDenoiseNode(ctx: BaseAudioContext, level: DenoiseLevel): AudioWorkletNode {
  return new AudioWorkletNode(ctx, 'denoise-processor', {
    processorOptions: { nf: DENOISE_NF[level] },
  })
}
