import { createId } from '@engine/core/id'

import {
  clipEffectiveDuration,
  makeDefaultTransform,
  type Clip,
  type ClipEffect,
  type ClipTransform,
} from './types'

export type ClipEffectType = 'zoom-in' | 'zoom-out' | 'fade-in' | 'fade-out'

export const ZOOM_EFFECT_TYPES: ClipEffectType[] = ['zoom-in', 'zoom-out']
export const FADE_EFFECT_TYPES: ClipEffectType[] = ['fade-in', 'fade-out']
export const ALL_EFFECT_TYPES: ClipEffectType[] = [...ZOOM_EFFECT_TYPES, ...FADE_EFFECT_TYPES]

export const EFFECT_LABEL: Record<ClipEffectType, string> = {
  'zoom-in': 'Zoom In',
  'zoom-out': 'Zoom Out',
  'fade-in': 'Fade In',
  'fade-out': 'Fade Out',
}

const DEFAULT_ZOOM_AMOUNT = 0.24
const DEFAULT_FADE_SEC = 0.6
const MIN_RENDER_SCALE = 0.05
const MAX_RENDER_SCALE = 20

export function makeClipEffect(type: ClipEffectType): ClipEffect {
  return {
    id: createId('effect'),
    type,
    params: isFadeEffectType(type)
      ? { duration: DEFAULT_FADE_SEC }
      : { amount: DEFAULT_ZOOM_AMOUNT },
  }
}

export function isClipEffectType(type: string): type is ClipEffectType {
  return (ALL_EFFECT_TYPES as string[]).includes(type)
}

export function isZoomEffectType(type: string): type is ClipEffectType {
  return (ZOOM_EFFECT_TYPES as string[]).includes(type)
}

export function isFadeEffectType(type: string): type is ClipEffectType {
  return (FADE_EFFECT_TYPES as string[]).includes(type)
}

export function getEffectAmount(effect: ClipEffect): number {
  const value = effect.params.amount
  return typeof value === 'number' ? clamp(value, 0.05, 1) : DEFAULT_ZOOM_AMOUNT
}

/** Fade duration in seconds, clamped so it never exceeds half the clip length. */
export function getFadeDuration(effect: ClipEffect, clipDurationSec: number): number {
  const value = effect.params.duration
  const d = typeof value === 'number' ? value : DEFAULT_FADE_SEC
  return Math.min(Math.max(d, 0), clipDurationSec / 2)
}

export function resolveClipTransformAt(clip: Clip, timelineSec: number): ClipTransform {
  const transform = { ...makeDefaultTransform(), ...clip.transform }
  // Only zoom effects influence the transform; fades affect opacity instead.
  const scale = (clip.effects ?? [])
    .filter((effect) => isZoomEffectType(effect.type))
    .reduce((acc, effect) => acc * getEffectScaleAt(clip, effect, timelineSec), 1)
  return {
    ...transform,
    scale: clamp(transform.scale * scale, MIN_RENDER_SCALE, MAX_RENDER_SCALE),
  }
}

/**
 * Resolve the clip's opacity at a given timeline second, applying any fade-in /
 * fade-out effects on top of the clip's base opacity. Used by the preview
 * renderer and the exporter so fades play and export identically.
 */
export function resolveClipOpacityAt(clip: Clip, timelineSec: number): number {
  let opacity = clip.opacity ?? 1
  const duration = clipEffectiveDuration(clip)
  if (duration <= 0) return clamp(opacity, 0, 1)

  const local = timelineSec - clip.startSec // seconds into the clip
  for (const effect of clip.effects ?? []) {
    if (effect.type === 'fade-in') {
      const fd = getFadeDuration(effect, duration)
      if (fd > 0 && local < fd) opacity *= smoothstep(clamp(local / fd, 0, 1))
    } else if (effect.type === 'fade-out') {
      const fd = getFadeDuration(effect, duration)
      const fromEnd = duration - local
      if (fd > 0 && fromEnd < fd) opacity *= smoothstep(clamp(fromEnd / fd, 0, 1))
    }
  }
  return clamp(opacity, 0, 1)
}

function getEffectScaleAt(clip: Clip, effect: ClipEffect, timelineSec: number): number {
  if (!isZoomEffectType(effect.type)) return 1

  const duration = clipEffectiveDuration(clip)
  if (duration <= 0) return 1

  const progress = smoothstep(clamp((timelineSec - clip.startSec) / duration, 0, 1))
  const amount = getEffectAmount(effect)
  if (effect.type === 'zoom-in') return 1 + amount * progress
  return 1 + amount * (1 - progress)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
