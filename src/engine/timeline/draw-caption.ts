/**
 * THE caption renderer — one implementation shared by the preview canvas and
 * the browser exporter, so a text clip can never render differently between
 * them again (they used to be two hand-synced copies; every drift became an
 * "export doesn't match preview" bug: reveal-unit gating, karaoke background
 * boxes, …). The server (ffmpeg/libass) burn mirrors this as an approximation;
 * see docs/caption-export-parity-plan.md.
 *
 * The caller provides a 2D context whose canvas is the composition frame
 * (preview: 720p comp; export: full export resolution) — all sizes in here
 * scale off the frame height with the same 1080-reference convention.
 */
import {
  drawCaptionReveal,
  drawKaraokeSweep,
  drawWrappedLines,
  getActiveWordIndex,
  getCurrentRevealUnit,
  getKaraokeWindowRect,
  measureWrappedTextCached,
  setTextSpacing,
} from './text-layout'
import { resolveClipOpacityAt, resolveClipTransformAt } from './effects'
import { clipEffectiveDuration, resolvedTextWordSpacing, type Clip, type ClipTransform } from './types'
import { cachedNormalizedCaptionWordTimestamps } from './caption-timing'

/** Captions stay within this fraction of the frame width (all renderers,
 *  including the server pre-wrap in server-export.ts, must agree on it). */
export const TEXT_MAX_WIDTH_RATIO = 0.92

const MIN_AXIS_SCALE = 0.05

export function textAxisScale(transform: ClipTransform, axis: 'x' | 'y'): number {
  const axisScale = axis === 'x' ? transform.scaleX : transform.scaleY
  return Math.max(0.05, transform.scale) * Math.max(MIN_AXIS_SCALE, axisScale)
}

const visualNumber = (value: number): number =>
  Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0

/** Stable token for the pixels drawTextClip would produce at `t`.
 * Export retains the previous GPU caption texture while this token is equal. */
export function captionVisualStateKey(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  width: number,
  height: number,
  t: number,
): string {
  const td = clip.textData
  if (!td) return `${clip.id}:empty`
  const transform = resolveClipTransformAt(clip, t)
  const opacity = resolveClipOpacityAt(clip, t)
  const base = [
    clip.id,
    visualNumber(opacity),
    visualNumber(transform.x),
    visualNumber(transform.y),
    visualNumber(transform.scale),
    visualNumber(transform.scaleX),
    visualNumber(transform.scaleY),
    visualNumber(transform.rotation),
    transform.flipH ? 1 : 0,
    transform.flipV ? 1 : 0,
  ]
  const anim = td.anim
  if (!anim || anim.kind === 'none') return JSON.stringify([...base, 'static'])

  const clipDuration = clipEffectiveDuration(clip)
  const normalizedWords = cachedNormalizedCaptionWordTimestamps(
    td.content,
    td.wordTimestamps,
    clipDuration,
  ).words
  const revealOpts = {
    unit: anim.kind === 'group' || anim.kind === 'karaoke'
      ? Math.max(1, anim.groupSize)
      : 1,
    elapsedSec: Math.max(0, t - clip.startSec),
    clipDuration,
    wordTimestamps: normalizedWords.length > 0 ? normalizedWords : undefined,
  }

  if (anim.kind === 'karaoke') {
    const totalWords = td.content.split(/\s+/).filter(Boolean).length
    const active = getActiveWordIndex(totalWords, revealOpts)
    // Karaoke changes pixels only at a word/pause boundary; popScale is not
    // painted by drawKaraokeSweep, so it must not invalidate the texture.
    return JSON.stringify([...base, 'karaoke', active.index, active.active ? 1 : 0])
  }

  const fontSize = Math.round((td.fontSize / 1080) * height)
  ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
  ctx.textAlign = td.align
  setTextSpacing(
    ctx,
    ((td.letterSpacing ?? 0) / 1080) * height,
    (resolvedTextWordSpacing(td) / 1080) * height,
  )
  try {
    const sx = textAxisScale(transform, 'x')
    const maxWidth = (width * TEXT_MAX_WIDTH_RATIO) / sx
    const { lines } = measureWrappedTextCached(ctx, td.content, fontSize, td.align, maxWidth)
    const current = getCurrentRevealUnit(ctx, lines, fontSize, revealOpts)
    return JSON.stringify([
      ...base,
      anim.kind,
      current.text,
      visualNumber(current.popScale),
    ])
  } finally {
    setTextSpacing(ctx, 0, 0)
  }
}

/** Draw one text clip at timeline second `t` onto a frame of width×height.
 *  Leaves the context's global state (alpha, shadow, text spacing) reset. */
export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  width: number,
  height: number,
  t: number,
): void {
  const td = clip.textData
  if (!td) return
  const transform = resolveClipTransformAt(clip, t)
  const fontSize = Math.round((td.fontSize / 1080) * height)
  ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
  ctx.textAlign = td.align
  ctx.textBaseline = 'middle'
  setTextSpacing(
    ctx,
    ((td.letterSpacing ?? 0) / 1080) * height,
    (resolvedTextWordSpacing(td) / 1080) * height,
  )
  ctx.globalAlpha = resolveClipOpacityAt(clip, t)
  const sx = textAxisScale(transform, 'x')
  const sy = textAxisScale(transform, 'y')
  // Wrap so the caption never spills past the frame edges.
  const maxWidth = (width * TEXT_MAX_WIDTH_RATIO) / sx
  const { lines, rect } = measureWrappedTextCached(ctx, td.content, fontSize, td.align, maxWidth)

  const stroke =
    td.stroke && td.stroke.width > 0
      ? { color: td.stroke.color, width: (td.stroke.width / 1080) * height }
      : undefined

  const isKaraoke = td.anim?.kind === 'karaoke'
  const isReveal = !!(td.anim && td.anim.kind !== 'none')
  const clipDuration = clipEffectiveDuration(clip)
  const normalizedWords = isReveal
    ? cachedNormalizedCaptionWordTimestamps(td.content, td.wordTimestamps, clipDuration).words
    : []
  const revealOpts = isReveal
    ? {
        unit:
          td.anim!.kind === 'group' || td.anim!.kind === 'karaoke'
            ? Math.max(1, td.anim!.groupSize)
            : 1,
        elapsedSec: Math.max(0, t - clip.startSec),
        clipDuration,
        wordTimestamps: normalizedWords.length > 0 ? normalizedWords : undefined,
      }
    : null
  const revealUnit = revealOpts && !isKaraoke ? getCurrentRevealUnit(ctx, lines, fontSize, revealOpts) : null
  // Karaoke with an N-word window: the box must hug the visible words (as the
  // server ASS burn does), not the whole wrapped paragraph.
  const karaokeRect = isKaraoke && revealOpts ? getKaraokeWindowRect(ctx, lines, fontSize, td.align, revealOpts) : null

  ctx.save()
  ctx.translate(td.x * width, td.y * height)
  ctx.scale(sx, sy)
  if (td.hasBackground) {
    const pad = fontSize * 0.2
    const unitRect = revealUnit?.rect ?? karaokeRect
    if (unitRect) {
      // Per-word reveal boxes get a pill shape (CapCut-style karaoke highlight).
      ctx.save()
      const pop = revealUnit?.popScale ?? 1
      ctx.scale(pop, pop)
      ctx.fillStyle = td.backgroundColor
      ctx.beginPath()
      ctx.roundRect(unitRect.x - pad, unitRect.y - pad, unitRect.w + pad * 2, unitRect.h + pad * 2, (unitRect.h + pad * 2) / 2)
      ctx.fill()
      ctx.restore()
    } else {
      // The whole-paragraph static box stays a plain rect.
      ctx.fillStyle = td.backgroundColor
      ctx.fillRect(rect.x - pad, rect.y - pad, rect.w + pad * 2, rect.h + pad * 2)
    }
  }
  if (!stroke) {
    // Soft shadow only when there's no outline (cleaner with an outline).
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 4
    ctx.shadowOffsetX = 2
    ctx.shadowOffsetY = 2
  }
  ctx.fillStyle = td.color
  if (isKaraoke && revealOpts) {
    drawKaraokeSweep(ctx, lines, fontSize, td.align, revealOpts, td.highlightColor ?? '#ffd400', stroke)
  } else if (revealOpts) {
    drawCaptionReveal(ctx, lines, fontSize, td.align, revealOpts, stroke)
  } else {
    drawWrappedLines(ctx, lines, fontSize, stroke)
  }
  ctx.restore()
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.globalAlpha = 1
  setTextSpacing(ctx, 0, 0)
}
