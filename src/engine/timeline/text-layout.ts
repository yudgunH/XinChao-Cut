/**
 * Word-wrap `text` so each line fits within `maxWidth` (in the current ctx font).
 * Honours existing newlines; a single over-long word is left on its own line.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (!line || ctx.measureText(candidate).width <= maxWidth) {
        line = candidate
      } else {
        lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
  }
  return lines.length > 0 ? lines : ['']
}

export const LINE_HEIGHT_RATIO = 1.25

export interface WrappedText {
  lines: string[]
  rect: { x: number; y: number; w: number; h: number }
}

/** Wrap text and compute its local bounding box (centred on the origin, baseline middle). */
export function measureWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  align: CanvasTextAlign,
  maxWidth: number,
): WrappedText {
  const lines = wrapText(ctx, text, maxWidth)
  const lineH = fontSize * LINE_HEIGHT_RATIO
  const totalH = Math.max(lineH, lines.length * lineH)
  let maxW = 1
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width)
  const left = align === 'left' ? 0 : align === 'right' ? -maxW : -maxW / 2
  return { lines, rect: { x: left, y: -totalH / 2, w: maxW, h: totalH } }
}

/**
 * Draw pre-wrapped lines stacked + centred vertically around y=0 (baseline
 * middle). If `stroke` is given, an outline is drawn under each line.
 * Caller sets ctx.fillStyle (text colour) beforehand.
 */
export function drawWrappedLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  stroke?: { color: string; width: number },
): void {
  const lineH = fontSize * LINE_HEIGHT_RATIO
  let y = -(lines.length * lineH) / 2 + lineH / 2
  if (stroke && stroke.width > 0) {
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.width
  }
  for (const line of lines) {
    if (stroke && stroke.width > 0) ctx.strokeText(line, 0, y)
    ctx.fillText(line, 0, y)
    y += lineH
  }
}

export interface CaptionReveal {
  unit: number         // words per step (1 = word-by-word, 3 = three at a time)
  elapsedSec: number   // seconds elapsed since clip start
  clipDuration: number // total clip duration for word distribution
  wordTimestamps?: { word: string; startSec: number; endSec: number }[] // per-word timing; overrides even distribution
}

export interface RevealUnitInfo {
  text: string
  rect: { x: number; y: number; w: number; h: number } // relative to anchor, always centre-aligned
  popScale: number // 0.5–1 during pop, 1 when settled
}

/** Pop-in window: 130 ms regardless of clip length. */
const POP_SEC = 0.13

function easeOutBack(x: number): number {
  const c = 1.70158
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2)
}

/**
 * Returns which word-unit is active right now and its bounding rect.
 * ctx.font must be set by the caller before calling.
 */
export function getCurrentRevealUnit(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  reveal: CaptionReveal,
): RevealUnitInfo {
  const lineH = fontSize * LINE_HEIGHT_RATIO
  const elapsed = Math.max(0, reveal.elapsedSec)

  // --- Timestamp-based path: accurate speech timing from Whisper ---
  if (reveal.wordTimestamps && reveal.wordTimestamps.length > 0) {
    const ts = reveal.wordTimestamps
    const unit = Math.max(1, Math.floor(reveal.unit))

    // Group words into unit-sized buckets; each bucket starts when its first word starts.
    let activeGroup: { word: string; startSec: number; endSec: number }[] = []
    let activeGroupStart = ts[0]!.startSec

    for (let i = 0; i < ts.length; i += unit) {
      const group = ts.slice(i, i + unit)
      const groupStart = group[0]!.startSec
      const groupEnd = group[group.length - 1]!.endSec
      const nextGroupStart = i + unit < ts.length ? ts[i + unit]!.startSec : Infinity

      if (elapsed >= groupStart && elapsed < nextGroupStart) {
        activeGroup = group
        activeGroupStart = groupStart
        break
      }
      // If elapsed is past all groups, show the last one settled.
      if (i + unit >= ts.length) {
        activeGroup = group
        activeGroupStart = groupStart
        // If we're past the last word's endSec, treat it as fully settled.
        if (elapsed >= groupEnd) activeGroupStart = groupStart
      }
    }

    const text = activeGroup.map((w) => w.word).join(' ')
    const unitElapsed = Math.max(0, elapsed - activeGroupStart)
    const popT = Math.min(1, unitElapsed / POP_SEC)
    const popScale = popT < 1 ? 0.5 + 0.5 * easeOutBack(popT) : 1
    const textW = ctx.measureText(text).width
    const rect = { x: -textW / 2, y: -lineH / 2, w: textW, h: lineH }
    return { text, rect, popScale }
  }

  // --- Fallback: even distribution across clip duration ---
  const allWords = lines.flatMap((l) => l.split(/\s+/).filter(Boolean))
  const totalWords = allWords.length
  if (totalWords === 0) return { text: '', rect: { x: 0, y: -lineH / 2, w: 0, h: lineH }, popScale: 1 }

  const unit = Math.max(1, Math.floor(reveal.unit))
  const totalUnits = Math.max(1, Math.ceil(totalWords / unit))
  const clipDur = Math.max(0.001, reveal.clipDuration)
  const progress = Math.min(1, elapsed / clipDur)

  const currentUnitIdx = Math.min(totalUnits - 1, Math.floor(progress * totalUnits))
  const unitWords = allWords.slice(currentUnitIdx * unit, Math.min(totalWords, (currentUnitIdx + 1) * unit))
  const text = unitWords.join(' ')

  const unitStartSec = (currentUnitIdx / totalUnits) * clipDur
  const unitElapsed = Math.max(0, elapsed - unitStartSec)
  const popT = Math.min(1, unitElapsed / POP_SEC)
  const popScale = popT < 1 ? 0.5 + 0.5 * easeOutBack(popT) : 1

  const textW = ctx.measureText(text).width
  const rect = { x: -textW / 2, y: -lineH / 2, w: textW, h: lineH }
  return { text, rect, popScale }
}

/**
 * TikTok/CapCut-style caption: shows ONLY the current word-unit, centred at
 * the anchor, with a 130 ms pop-in bounce. Previous units are hidden.
 * Caller translates to the anchor point and sets fill colour before calling.
 */
export function drawCaptionReveal(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  _align: CanvasTextAlign,
  reveal: CaptionReveal,
  stroke?: { color: string; width: number },
): void {
  const { text, popScale } = getCurrentRevealUnit(ctx, lines, fontSize, reveal)
  if (!text) return

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (stroke && stroke.width > 0) {
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.width
  }

  ctx.save()
  ctx.scale(popScale, popScale)
  if (stroke && stroke.width > 0) ctx.strokeText(text, 0, 0)
  ctx.fillText(text, 0, 0)
  ctx.restore()
}
