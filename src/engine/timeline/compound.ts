import {
  clipEffectiveDuration,
  makeDefaultTransform,
  type Clip,
  type ClipKeyframes,
  type ClipTransform,
  type ColorAdjust,
  type KeyframeProp,
  type TimelineState,
  type Track,
} from './types'
import { currentKeyframeValue, resolveClipTransformAt, resolveClipOpacityAt } from './effects'

/** A compound's stored sub-timeline (loose shape — only `timeline` is needed here). */
interface CompoundLike {
  timeline: TimelineState
}

function timelineDuration(clips: Clip[]): number {
  return clips.reduce((max, c) => Math.max(max, c.startSec + clipEffectiveDuration(c)), 0)
}

type TransformKeyframeProp = Exclude<KeyframeProp, 'opacity'>

const TRANSFORM_PROPS: TransformKeyframeProp[] = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation']
const KEYFRAME_EPS = 1e-4

function baseTransformAt(clip: Clip, timelineSec: number): ClipTransform {
  const base = { ...makeDefaultTransform(), ...clip.transform }
  return {
    ...base,
    x: currentKeyframeValue(clip, 'x', timelineSec),
    y: currentKeyframeValue(clip, 'y', timelineSec),
    scale: currentKeyframeValue(clip, 'scale', timelineSec),
    scaleX: currentKeyframeValue(clip, 'scaleX', timelineSec),
    scaleY: currentKeyframeValue(clip, 'scaleY', timelineSec),
    rotation: currentKeyframeValue(clip, 'rotation', timelineSec),
  }
}

/** Stack the compound clip's colour adjust onto a child's. Each value is a ±%
 *  around a neutral 0; combine as filter multipliers ((1+p/100)(1+c/100)) so a
 *  neutral side (0) leaves the other exactly unchanged. */
function composeAdjust(parent: ColorAdjust, child: ColorAdjust): ColorAdjust {
  const stack = (p: number, c: number) => ((1 + p / 100) * (1 + c / 100) - 1) * 100
  return {
    brightness: stack(parent.brightness, child.brightness),
    contrast: stack(parent.contrast, child.contrast),
    saturation: stack(parent.saturation, child.saturation),
  }
}

function composeTransforms(parent: ClipTransform, child: ClipTransform): ClipTransform {
  const parentScaleX = parent.scale * parent.scaleX
  const parentScaleY = parent.scale * parent.scaleY
  const dx = (parent.flipH ? -1 : 1) * (child.x - 0.5) * parentScaleX
  const dy = (parent.flipV ? -1 : 1) * (child.y - 0.5) * parentScaleY
  const r = (parent.rotation * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)

  return {
    ...child,
    x: parent.x + dx * cos - dy * sin,
    y: parent.y + dx * sin + dy * cos,
    scale: child.scale * parent.scale,
    scaleX: child.scaleX * parent.scaleX,
    scaleY: child.scaleY * parent.scaleY,
    rotation: child.rotation + parent.rotation,
    flipH: !!child.flipH !== !!parent.flipH,
    flipV: !!child.flipV !== !!parent.flipV,
  }
}

function hasAnyKeyframes(clip: Clip, props: KeyframeProp[]): boolean {
  return props.some((prop) => (clip.keyframes?.[prop]?.length ?? 0) > 0)
}

// Effects that move/scale/rotate the clip (need transform baking) vs. those that
// only change opacity. fade-in/out are opacity-only; slide/rise/drop do both.
const OPACITY_EFFECTS = new Set([
  'fade-in', 'fade-out', 'slide-in-left', 'slide-out-right', 'rise-in', 'drop-out',
])
function hasTransformEffects(clip: Clip): boolean {
  return (clip.effects ?? []).some((e) => e.type !== 'fade-in' && e.type !== 'fade-out')
}
function hasOpacityEffects(clip: Clip): boolean {
  return (clip.effects ?? []).some((e) => OPACITY_EFFECTS.has(e.type))
}

/** A crop {l,r,t,b} on a full-frame compound is equivalent to scaling its
 *  contents up (zoom into the kept region) and recentring — express it as an
 *  affine transform so it composes onto children like the rest of the transform.
 *  Returns the identity transform when there's no crop. */
function cropToTransform(crop: ClipTransform['crop']): ClipTransform {
  const id = makeDefaultTransform()
  if (!crop) return id
  const l = Math.max(0, Math.min(0.49, crop.l || 0))
  const r = Math.max(0, Math.min(0.49, crop.r || 0))
  const t = Math.max(0, Math.min(0.49, crop.t || 0))
  const b = Math.max(0, Math.min(0.49, crop.b || 0))
  if (!l && !r && !t && !b) return id
  const zx = 1 / Math.max(0.02, 1 - l - r)
  const zy = 1 / Math.max(0.02, 1 - t - b)
  return { ...id, x: (0.5 - l) * zx, y: (0.5 - t) * zy, scaleX: zx, scaleY: zy }
}

/** The compound clip's full transform at a timeline second — its keyframed +
 *  effect-driven transform, with any crop folded in (crop is innermost, applied
 *  to the composite before the clip's own scale/position/rotation). */
function parentTransformAt(parent: Clip, timelineSec: number): ClipTransform {
  const resolved = resolveClipTransformAt(parent, timelineSec)
  const crop = parent.transform?.crop
  return crop ? composeTransforms(resolved, cropToTransform(crop)) : resolved
}

/** Uniform sample grid (~12 Hz, capped) so a continuous effect curve (zoom /
 *  pan / pulse / fade) is baked into enough keyframes to read smoothly. */
function gridTimes(flatStart: number, flatEnd: number, maxSamples: number): number[] {
  const dur = Math.max(0, flatEnd - flatStart)
  const n = Math.max(1, Math.min(maxSamples, Math.ceil(dur * 12)))
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(flatStart + (dur * i) / n)
  return out
}

function mergedTimes(base: number[], extra: number[]): number[] {
  const set = new Set<number>(base)
  for (const t of extra) set.add(t)
  return [...set].sort((a, b) => a - b)
}

function parentKeyframeTimes(
  parent: Clip,
  props: KeyframeProp[],
  flatStart: number,
  flatEnd: number,
): number[] {
  const times = new Set<number>([flatStart, flatEnd])
  for (const prop of props) {
    for (const keyframe of parent.keyframes?.[prop] ?? []) {
      const timelineSec = parent.startSec + keyframe.t
      if (timelineSec >= flatStart - KEYFRAME_EPS && timelineSec <= flatEnd + KEYFRAME_EPS) {
        times.add(Math.max(flatStart, Math.min(flatEnd, timelineSec)))
      }
    }
  }
  return [...times].sort((a, b) => a - b)
}

function addParentTransformKeyframes(
  childKeyframes: ClipKeyframes | undefined,
  parent: Clip,
  child: Clip,
  flatStart: number,
  flatEnd: number,
  parentToSubTimelineSec: (timelineSec: number) => number,
): ClipKeyframes | undefined {
  const kf = hasAnyKeyframes(parent, TRANSFORM_PROPS)
  const fx = hasTransformEffects(parent)
  if (!kf && !fx) return childKeyframes

  const next: ClipKeyframes = { ...childKeyframes }
  // Keyframes are sampled at their own times; continuous effects need a dense
  // grid (then linear interpolation between samples tracks the curve).
  const times = fx
    ? mergedTimes(
        parentKeyframeTimes(parent, TRANSFORM_PROPS, flatStart, flatEnd),
        gridTimes(flatStart, flatEnd, 48),
      )
    : parentKeyframeTimes(parent, TRANSFORM_PROPS, flatStart, flatEnd)
  const ease = fx ? 'linear' : 'easeInOut'
  for (const prop of TRANSFORM_PROPS) {
    next[prop] = times.map((timelineSec) => {
      const composed = composeTransforms(
        parentTransformAt(parent, timelineSec),
        baseTransformAt(child, parentToSubTimelineSec(timelineSec)),
      )
      return { t: Math.max(0, timelineSec - flatStart), v: composed[prop], ease }
    })
  }
  return next
}

function addParentOpacityKeyframes(
  childKeyframes: ClipKeyframes | undefined,
  parent: Clip,
  child: Clip,
  flatStart: number,
  flatEnd: number,
  parentToSubTimelineSec: (timelineSec: number) => number,
): ClipKeyframes | undefined {
  const kf = hasAnyKeyframes(parent, ['opacity'])
  const fx = hasOpacityEffects(parent)
  if (!kf && !fx) return childKeyframes

  const next: ClipKeyframes = { ...childKeyframes }
  // Opacity is rendered in FFmpeg via geq (per-pixel, fragile with long exprs) —
  // keep the bake sparse; a fade is smooth with few linear points anyway.
  const times = fx
    ? mergedTimes(
        parentKeyframeTimes(parent, ['opacity'], flatStart, flatEnd),
        gridTimes(flatStart, flatEnd, 16),
      )
    : parentKeyframeTimes(parent, ['opacity'], flatStart, flatEnd)
  next.opacity = times.map((timelineSec) => ({
    t: Math.max(0, timelineSec - flatStart),
    // resolveClipOpacityAt includes the parent's fade/slide/rise/drop + opacity
    // keyframes; multiply by the child's own (static + keyframed) opacity.
    v:
      resolveClipOpacityAt(parent, timelineSec) *
      currentKeyframeValue(child, 'opacity', parentToSubTimelineSec(timelineSec)),
    ease: fx ? 'linear' : 'easeInOut',
  }))
  return next
}

/**
 * Expand every compound clip into its sub-timeline's clips, repositioned onto the
 * parent timeline — so the preview, audio engine, and exporter can all consume a
 * single FLAT timeline (no nesting). Recurses for nested compounds.
 *
 * Each sub-clip is windowed to the compound clip's [inPoint, outPoint], moved to
 * `compound.startSec`, and has the compound clip's speed/opacity/volume/muted,
 * transform (position/scale/rotation/flip, incl. keyframes), colour adjust,
 * crop (folded in as a scale+recenter), and procedural effects (zoom/pan/pulse/
 * tilt/fade/slide/rise/drop — baked into dense keyframes by sampling the parent's
 * resolved transform/opacity) all composed onto it — so editing any of those on
 * the compound behaves like editing a normal clip.
 *
 * Pure + cheap: returns the SAME timeline reference when it has no compound clips.
 */
export function flattenCompounds(
  timeline: TimelineState,
  compounds: Record<string, CompoundLike>,
  depth = 0,
  ancestors: ReadonlySet<string> = new Set(),
): TimelineState {
  if (depth > 32) throw new Error('Compound nesting is too deep')
  if (!timeline.clips.some((c) => c.compoundId)) return timeline

  const tracks: Track[] = [...timeline.tracks]
  const clips: Clip[] = []

  for (const c of timeline.clips) {
    if (!c.compoundId) {
      clips.push(c)
      continue
    }
    if (ancestors.has(c.compoundId)) {
      throw new Error(`Compound cycle detected: ${c.compoundId}`)
    }
    const sub = compounds[c.compoundId]
    if (!sub) continue // missing registry entry → renders nothing (safe)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(c.compoundId)
    const flat = flattenCompounds(sub.timeline, compounds, depth + 1, nextAncestors)

    const speed = Math.max(0.01, c.speed)
    const winStart = c.inPointSec
    const winEnd = c.outPointSec

    // Each sub-track → a synthetic, locked parent track (keeps kind + overlap).
    const trackMap = new Map<string, string>()
    for (const t of flat.tracks) {
      const id = `${c.id}::${t.id}`
      trackMap.set(t.id, id)
      tracks.push({
        id,
        kind: t.kind,
        name: t.name,
        muted: t.muted,
        hidden: t.hidden,
        locked: true,
      })
    }

    for (const sc of flat.clips) {
      const scStart = sc.startSec
      const scEnd = sc.startSec + clipEffectiveDuration(sc)
      const visStart = Math.max(scStart, winStart)
      const visEnd = Math.min(scEnd, winEnd)
      if (visEnd - visStart <= 1e-4) continue // outside the compound's window

      const startSec = c.startSec + (visStart - winStart) / speed
      const flatEnd = c.startSec + (visEnd - winStart) / speed
      const subTimelineSec = (timelineSec: number) => winStart + (timelineSec - c.startSec) * speed
      const keyframes = addParentOpacityKeyframes(
        addParentTransformKeyframes(sc.keyframes, c, sc, startSec, flatEnd, subTimelineSec),
        c,
        sc,
        startSec,
        flatEnd,
        subTimelineSec,
      )

      clips.push({
        ...sc,
        id: `${c.id}::${sc.id}`,
        trackId: trackMap.get(sc.trackId) ?? sc.trackId,
        startSec,
        inPointSec: sc.inPointSec + (visStart - scStart) * sc.speed,
        outPointSec: sc.inPointSec + (visEnd - scStart) * sc.speed,
        speed: sc.speed * speed,
        opacity: sc.opacity * c.opacity,
        volume: sc.volume * c.volume,
        muted: sc.muted || c.muted,
        adjust: composeAdjust(c.adjust, sc.adjust),
        // Crop + effect-driven transform folded in via parentTransformAt; this is
        // the t=0 baseline (the baked keyframes above drive the animation).
        transform: composeTransforms(parentTransformAt(c, startSec), baseTransformAt(sc, visStart)),
        keyframes,
        groupId: undefined,
        compoundId: undefined,
      })
    }
  }

  return { ...timeline, tracks, clips, durationSec: timelineDuration(clips) }
}
