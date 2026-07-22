import { createId } from '@engine/core/id'

import {
  clipEffectiveDuration,
  makeDefaultTransform,
  type Clip,
  type ClipEffect,
  type ClipTransform,
  type Keyframe,
  type KeyframeProp,
} from './types'

export type MotionEffectType = 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pulse' | 'tilt'
export type TransitionEffectType =
  | 'fade-in'
  | 'fade-out'
  | 'slide-in-left'
  | 'slide-out-right'
  | 'rise-in'
  | 'drop-out'
export type ClipEffectType = MotionEffectType | TransitionEffectType

export const MOTION_EFFECT_TYPES: MotionEffectType[] = [
  'zoom-in',
  'zoom-out',
  'pan-left',
  'pan-right',
  'pulse',
  'tilt',
]
export const TRANSITION_EFFECT_TYPES: TransitionEffectType[] = [
  'fade-in',
  'fade-out',
  'slide-in-left',
  'slide-out-right',
  'rise-in',
  'drop-out',
]
export const ZOOM_EFFECT_TYPES: ClipEffectType[] = MOTION_EFFECT_TYPES
export const FADE_EFFECT_TYPES: ClipEffectType[] = TRANSITION_EFFECT_TYPES
export const ALL_EFFECT_TYPES: ClipEffectType[] = [...ZOOM_EFFECT_TYPES, ...FADE_EFFECT_TYPES]

export const EFFECT_LABEL: Record<ClipEffectType, string> = {
  'zoom-in': 'Zoom In',
  'zoom-out': 'Zoom Out',
  'pan-left': 'Pan Left',
  'pan-right': 'Pan Right',
  pulse: 'Pulse',
  tilt: 'Tilt',
  'fade-in': 'Fade In',
  'fade-out': 'Fade Out',
  'slide-in-left': 'Slide In Left',
  'slide-out-right': 'Slide Out Right',
  'rise-in': 'Rise In',
  'drop-out': 'Drop Out',
}

const DEFAULT_ZOOM_AMOUNT = 0.24
const DEFAULT_FADE_SEC = 0.6
const MIN_RENDER_SCALE = 0.05
const MAX_RENDER_SCALE = 20
const DEFAULT_SLIDE_OFFSET = 0.72

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

/** Interpolated value of a sorted keyframe track at clip-local time `t`. Holds
 *  the endpoints outside the keyframe range; eases each segment (default
 *  smooth ease-in-out, matching CapCut). */
export function interpKeyframes(kfs: Keyframe[], t: number): number {
  const n = kfs.length
  if (n === 0) return Number.NaN
  if (t <= kfs[0]!.t) return kfs[0]!.v
  const last = kfs[n - 1]!
  if (t >= last.t) return last.v
  for (let i = 0; i < n - 1; i++) {
    const a = kfs[i]!
    const b = kfs[i + 1]!
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const f = span > 1e-6 ? (t - a.t) / span : 0
      const e = (b.ease ?? 'easeInOut') === 'linear' ? f : smoothstep(f)
      return a.v + (b.v - a.v) * e
    }
  }
  return last.v
}

/** Current value of a keyframeable prop at `timelineSec` — the interpolated
 *  keyframe value if the prop is animated, else its static base. Used to capture
 *  a keyframe (no fade/zoom modulation). */
export function currentKeyframeValue(clip: Clip, prop: KeyframeProp, timelineSec: number): number {
  const track = clip.keyframes?.[prop]
  if (track && track.length) return interpKeyframes(track, timelineSec - clip.startSec)
  if (prop === 'opacity') return clip.opacity ?? 1
  return { ...makeDefaultTransform(), ...clip.transform }[prop]
}

export function resolveClipTransformAt(clip: Clip, timelineSec: number): ClipTransform {
  const base = { ...makeDefaultTransform(), ...clip.transform }
  const local = timelineSec - clip.startSec
  const kf = clip.keyframes
  const kv = (prop: KeyframeProp, fallback: number): number => {
    const track = kf?.[prop]
    return track && track.length ? interpKeyframes(track, local) : fallback
  }
  const transform = {
    ...base,
    x: kv('x', base.x),
    y: kv('y', base.y),
    scaleX: kv('scaleX', base.scaleX),
    scaleY: kv('scaleY', base.scaleY),
    rotation: kv('rotation', base.rotation),
    scale: kv('scale', base.scale),
  }
  return (clip.effects ?? []).reduce(
    (current, effect) => applyEffectTransform(current, clip, effect, timelineSec),
    transform,
  )
}

/**
 * Resolve the clip's opacity at a given timeline second, applying any fade-in /
 * fade-out effects on top of the clip's base opacity. Used by the preview
 * renderer and the exporter so fades play and export identically.
 */
export function resolveClipOpacityAt(clip: Clip, timelineSec: number): number {
  const opacityKf = clip.keyframes?.opacity
  let opacity =
    opacityKf && opacityKf.length
      ? interpKeyframes(opacityKf, timelineSec - clip.startSec)
      : (clip.opacity ?? 1)
  const duration = clipEffectiveDuration(clip)
  if (duration <= 0) return clamp(opacity, 0, 1)

  const local = timelineSec - clip.startSec // seconds into the clip
  for (const effect of clip.effects ?? []) {
    if (effect.type === 'fade-in' || effect.type === 'slide-in-left' || effect.type === 'rise-in') {
      const fd = getFadeDuration(effect, duration)
      if (fd > 0 && local < fd) opacity *= smoothstep(clamp(local / fd, 0, 1))
    } else if (
      effect.type === 'fade-out' ||
      effect.type === 'slide-out-right' ||
      effect.type === 'drop-out'
    ) {
      const fd = getFadeDuration(effect, duration)
      const fromEnd = duration - local
      if (fd > 0 && fromEnd < fd) opacity *= smoothstep(clamp(fromEnd / fd, 0, 1))
    }
  }
  return clamp(opacity, 0, 1)
}

function applyEffectTransform(
  transform: ClipTransform,
  clip: Clip,
  effect: ClipEffect,
  timelineSec: number,
): ClipTransform {
  const duration = clipEffectiveDuration(clip)
  if (duration <= 0) return transform

  const progress = smoothstep(clamp((timelineSec - clip.startSec) / duration, 0, 1))
  const amount = getEffectAmount(effect)
  const next = { ...transform }

  if (effect.type === 'zoom-in') {
    next.scale = clamp(next.scale * (1 + amount * progress), MIN_RENDER_SCALE, MAX_RENDER_SCALE)
  } else if (effect.type === 'zoom-out') {
    next.scale = clamp(next.scale * (1 + amount * (1 - progress)), MIN_RENDER_SCALE, MAX_RENDER_SCALE)
  } else if (effect.type === 'pan-left') {
    next.x += amount * 0.28 * (0.5 - progress)
  } else if (effect.type === 'pan-right') {
    next.x += amount * 0.28 * (progress - 0.5)
  } else if (effect.type === 'pulse') {
    next.scale = clamp(
      next.scale * (1 + amount * 0.42 * Math.sin(progress * Math.PI)),
      MIN_RENDER_SCALE,
      MAX_RENDER_SCALE,
    )
  } else if (effect.type === 'tilt') {
    next.rotation += amount * 28 * Math.sin((progress - 0.5) * Math.PI)
  } else if (effect.type === 'slide-in-left') {
    next.x -= DEFAULT_SLIDE_OFFSET * (1 - transitionInProgress(clip, effect, timelineSec))
  } else if (effect.type === 'slide-out-right') {
    next.x += DEFAULT_SLIDE_OFFSET * transitionOutProgress(clip, effect, timelineSec)
  } else if (effect.type === 'rise-in') {
    next.y += DEFAULT_SLIDE_OFFSET * 0.42 * (1 - transitionInProgress(clip, effect, timelineSec))
  } else if (effect.type === 'drop-out') {
    next.y += DEFAULT_SLIDE_OFFSET * 0.42 * transitionOutProgress(clip, effect, timelineSec)
  }

  return next
}

function transitionInProgress(clip: Clip, effect: ClipEffect, timelineSec: number): number {
  const duration = clipEffectiveDuration(clip)
  const fadeDuration = getFadeDuration(effect, duration)
  if (fadeDuration <= 0) return 1
  return smoothstep(clamp((timelineSec - clip.startSec) / fadeDuration, 0, 1))
}

function transitionOutProgress(clip: Clip, effect: ClipEffect, timelineSec: number): number {
  const duration = clipEffectiveDuration(clip)
  const fadeDuration = getFadeDuration(effect, duration)
  if (fadeDuration <= 0) return 0
  const fromEnd = duration - (timelineSec - clip.startSec)
  return smoothstep(1 - clamp(fromEnd / fadeDuration, 0, 1))
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
