const _wrapCache = new Map<string, WrappedText>()
const WRAP_CACHE_MAX = 512

/**
 * measureWrappedText có cache. Key gồm ctx.font (chứa weight+size+family),
 * text, maxWidth (làm tròn), align. Bố cục dòng ổn định giữa các frame;
 * chỉ phần phụ thuộc thời gian (reveal/popScale) cần tính mỗi tick.
 * Eviction đơn giản (clear khi đầy) — cache nhỏ, hit rate cao.
 */
export function measureWrappedTextCached(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  align: CanvasTextAlign,
  maxWidth: number,
): WrappedText {
  const key = `${ctx.font}|${textSpacingSignature(ctx)}|${align}|${fontSize}|${Math.round(maxWidth)}|${text}`
  const hit = _wrapCache.get(key)
  if (hit) return hit
  const v = measureWrappedText(ctx, text, fontSize, align, maxWidth)
  if (_wrapCache.size >= WRAP_CACHE_MAX) _wrapCache.clear()
  _wrapCache.set(key, v)
  return v
}

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
      if (!line || measureTextWithSpacing(ctx, candidate) <= maxWidth) {
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

type SpacedCanvasContext = CanvasRenderingContext2D & {
  letterSpacing?: string
  wordSpacing?: string
}

const spacingOverrides = new WeakMap<object, { letter: number; word: number }>()

/** Store spacing outside the Canvas API as well. Older Tauri WebViews accept
 * assignments to ctx.letterSpacing/wordSpacing syntactically but always read
 * back `0`, which made both controls appear to do nothing. */
export function setTextSpacing(ctx: CanvasRenderingContext2D, letter: number, word: number): void {
  spacingOverrides.set(ctx, {
    letter: Number.isFinite(letter) ? letter : 0,
    word: Number.isFinite(word) ? word : 0,
  })
  const spaced = ctx as SpacedCanvasContext
  spaced.letterSpacing = `${letter}px`
  spaced.wordSpacing = `${word}px`
}

function spacingPx(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '0')
  return Number.isFinite(parsed) ? parsed : 0
}

function letterSpacingPx(ctx: CanvasRenderingContext2D): number {
  const override = spacingOverrides.get(ctx)
  if (override) return override.letter
  return spacingPx((ctx as SpacedCanvasContext).letterSpacing)
}

function wordSpacingPx(ctx: CanvasRenderingContext2D): number {
  const override = spacingOverrides.get(ctx)
  if (override) return override.word
  return spacingPx((ctx as SpacedCanvasContext).wordSpacing)
}

export function textSpacingSignature(ctx: CanvasRenderingContext2D): string {
  return `${letterSpacingPx(ctx)}|${wordSpacingPx(ctx)}`
}

/** Canvas text spacing is not available in every Tauri/WebView version. Keep
 * the native properties for newer browsers, but disable them while doing the
 * manual fallback below so spacing can never be applied twice. */
function withoutNativeSpacing<T>(ctx: CanvasRenderingContext2D, fn: () => T): T {
  const spaced = ctx as SpacedCanvasContext
  const oldLetter = spaced.letterSpacing
  const oldWord = spaced.wordSpacing
  spaced.letterSpacing = '0px'
  spaced.wordSpacing = '0px'
  try {
    return fn()
  } finally {
    spaced.letterSpacing = oldLetter ?? '0px'
    spaced.wordSpacing = oldWord ?? '0px'
  }
}

/** Measure text with explicit tracking and word spacing. This is the single
 * measurement primitive used by wrapping, karaoke placement and raster draw,
 * so the two controls cannot collapse into the same behaviour. */
export function measureTextWithSpacing(ctx: CanvasRenderingContext2D, text: string): number {
  const letter = letterSpacingPx(ctx)
  const word = wordSpacingPx(ctx)
  const base = withoutNativeSpacing(ctx, () => ctx.measureText(text).width)
  const chars = Array.from(text)
  const whitespaceCount = chars.reduce((count, char) => count + (/\s/.test(char) ? 1 : 0), 0)
  return base + letter * Math.max(0, chars.length - 1) + word * whitespaceCount
}

/** Draw a line using explicit character tracking. When only word spacing is
 * requested, whole words are still painted in one call to preserve kerning;
 * when character spacing is non-zero, graphemes are painted individually. */
export function drawTextWithSpacing(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  stroke?: { color: string; width: number },
): void {
  const letter = letterSpacingPx(ctx)
  const word = wordSpacingPx(ctx)
  const align = ctx.textAlign
  if (Math.abs(letter) < 0.001 && Math.abs(word) < 0.001) {
    withoutNativeSpacing(ctx, () => {
      if (stroke && stroke.width > 0) ctx.strokeText(text, x, y)
      ctx.fillText(text, x, y)
    })
    return
  }

  const totalWidth = measureTextWithSpacing(ctx, text)
  const origin = align === 'left' ? x : align === 'right' ? x - totalWidth : x - totalWidth / 2

  withoutNativeSpacing(ctx, () => {
    ctx.save()
    ctx.textAlign = 'left'
    let cursor = origin
    const paint = (part: string) => {
      if (stroke && stroke.width > 0) ctx.strokeText(part, cursor, y)
      ctx.fillText(part, cursor, y)
      cursor += ctx.measureText(part).width
    }

    if (Math.abs(letter) >= 0.001) {
      const chars = Array.from(text)
      chars.forEach((char, index) => {
        if (!/\s/.test(char)) paint(char)
        else cursor += ctx.measureText(char).width
        if (index < chars.length - 1) cursor += letter
        if (/\s/.test(char)) cursor += word
      })
    } else {
      const parts = text.split(/(\s+)/)
      for (const part of parts) {
        if (!part) continue
        if (/^\s+$/.test(part)) {
          cursor += ctx.measureText(part).width + word * Array.from(part).length
        } else {
          paint(part)
        }
      }
    }
    ctx.restore()
  })
}

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
  for (const line of lines) maxW = Math.max(maxW, measureTextWithSpacing(ctx, line))
  const left = align === 'left' ? 0 : align === 'right' ? -maxW : -maxW / 2
  return { lines, rect: { x: left, y: -totalH / 2, w: maxW, h: totalH } }
}

// ── Caption raster cache ─────────────────────────────────────────────────────
// The expensive part of caption drawing is strokeText+fillText (with shadow) of
// every line/word EVERY frame. The text's visual state changes rarely (per
// word-group swap, not per frame), so the static part is rasterised ONCE into a
// small offscreen canvas and replayed with a single drawImage. Chromium still
// rasterises the glyphs, so preview/export stay pixel-identical — pop-bounce is
// applied as a transform on the raster (a 130ms scale, visually identical), and
// the caller's ctx.shadow* applies to the drawImage via the raster's alpha, the
// same shape a per-glyph shadow produces.
interface CaptionRaster {
  canvas: HTMLCanvasElement | OffscreenCanvas
  /** Anchor position (text origin) inside the raster. */
  ox: number
  oy: number
}

const _rasterCache = new Map<string, CaptionRaster | null>() // null = unrasterisable (fall back to direct)
const RASTER_CACHE_MAX = 64

// A newly loaded font face must invalidate rasters made with the fallback face
// (the direct path self-healed by redrawing; the cache must too).
try {
  const fonts = (globalThis as { fonts?: FontFaceSet }).fonts ??
    (typeof document !== 'undefined' ? document.fonts : undefined)
  fonts?.addEventListener?.('loadingdone', () => _rasterCache.clear())
} catch {
  /* no FontFaceSet — cache simply never invalidates on font load */
}

function makeRasterCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  const cw = Math.max(1, Math.ceil(w))
  const ch = Math.max(1, Math.ceil(h))
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(cw, ch)
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = cw
    c.height = ch
    return c
  }
  return null
}

/** Raster of `lines` drawn exactly like the direct path (stroke under fill,
 *  baseline-middle rows on the 1.25em grid, ctx's font/text spacing/align).
 *  Returns null when rasterisation isn't possible (no canvas, gradient fill). */
function blockRaster(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  align: CanvasTextAlign,
  fill: string,
  stroke?: { color: string; width: number },
): CaptionRaster | null {
  const sw = stroke && stroke.width > 0 ? stroke.width : 0
  const key = `b|${ctx.font}|${textSpacingSignature(ctx)}|${align}|${fill}|${stroke?.color ?? ''}|${sw}|${lines.join('\n')}`
  const hit = _rasterCache.get(key)
  if (hit !== undefined) return hit

  const lineH = fontSize * LINE_HEIGHT_RATIO
  let maxW = 1
  for (const line of lines) maxW = Math.max(maxW, measureTextWithSpacing(ctx, line))
  // Padding: glyphs overhang the advance width/em box (swashes, tall display
  // ascenders) and the stroke extends ~1.5× its width at miter joins.
  const padX = fontSize * 0.5 + sw * 1.5 + 2
  const padY = fontSize * 0.75 + sw * 1.5 + 2
  const w = maxW + padX * 2
  const h = lines.length * lineH + padY * 2
  const canvas = makeRasterCanvas(w, h)
  const rctx = canvas?.getContext('2d') as CanvasRenderingContext2D | null
  const raster: CaptionRaster | null = canvas && rctx
    ? {
        canvas,
        ox: padX + (align === 'left' ? 0 : align === 'right' ? maxW : maxW / 2),
        oy: padY + (lines.length * lineH) / 2,
      }
    : null
  if (raster && rctx) {
    rctx.font = ctx.font
    setTextSpacing(rctx, letterSpacingPx(ctx), wordSpacingPx(ctx))
    rctx.textAlign = align
    rctx.textBaseline = 'middle'
    rctx.fillStyle = fill
    if (sw > 0 && stroke) {
      rctx.lineJoin = 'round'
      rctx.miterLimit = 2
      rctx.strokeStyle = stroke.color
      rctx.lineWidth = sw
    }
    rctx.translate(raster.ox, raster.oy)
    let y = -(lines.length * lineH) / 2 + lineH / 2
    for (const line of lines) {
      drawTextWithSpacing(rctx, line, 0, y, sw > 0 ? stroke : undefined)
      y += lineH
    }
  }
  if (_rasterCache.size >= RASTER_CACHE_MAX) _rasterCache.clear()
  _rasterCache.set(key, raster)
  return raster
}

/** Single-line, centre-anchored raster (reveal units, karaoke words/windows). */
function unitRaster(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  fill: string,
  stroke?: { color: string; width: number },
): CaptionRaster | null {
  return blockRaster(ctx, [text], fontSize, 'center', fill, stroke)
}

/** drawImage a cached raster with its anchor at (x, y), optionally pop-scaled. */
function drawRaster(
  ctx: CanvasRenderingContext2D,
  r: CaptionRaster,
  x: number,
  y: number,
  scale: number,
): void {
  if (x === 0 && y === 0 && scale === 1) {
    ctx.drawImage(r.canvas, -r.ox, -r.oy)
    return
  }
  ctx.save()
  ctx.translate(x, y)
  if (scale !== 1) ctx.scale(scale, scale)
  ctx.drawImage(r.canvas, -r.ox, -r.oy)
  ctx.restore()
}

/**
 * Draw pre-wrapped lines stacked + centred vertically around y=0 (baseline
 * middle). If `stroke` is given, an outline is drawn under each line.
 * Caller sets ctx.fillStyle (text colour) beforehand.
 * Cached: the block is rasterised once per visual state (see _rasterCache).
 */
export function drawWrappedLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  stroke?: { color: string; width: number },
): void {
  const fill = ctx.fillStyle
  if (typeof fill === 'string') {
    const r = blockRaster(ctx, lines, fontSize, ctx.textAlign, fill, stroke)
    if (r) {
      drawRaster(ctx, r, 0, 0, 1)
      return
    }
  }
  drawWrappedLinesDirect(ctx, lines, fontSize, stroke)
}

function drawWrappedLinesDirect(
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
    drawTextWithSpacing(ctx, line, 0, y, stroke && stroke.width > 0 ? stroke : undefined)
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
    if (elapsed < ts[0]!.startSec) {
      return { text: '', rect: { x: 0, y: -lineH / 2, w: 0, h: lineH }, popScale: 1 }
    }
    const unit = Math.max(1, Math.floor(reveal.unit))

    // Group words into unit-sized buckets; each bucket starts when its first word starts.
    let activeGroup: { word: string; startSec: number; endSec: number }[] = []
    let activeGroupStart = ts[0]!.startSec

    for (let i = 0; i < ts.length; i += unit) {
      const group = ts.slice(i, i + unit)
      // Leading silence is handled above; every group begins at its real word
      // timestamp so reveal and karaoke agree instead of highlighting early.
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
    const textW = measureTextWithSpacing(ctx, text)
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

  const textW = measureTextWithSpacing(ctx, text)
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

  const fill = ctx.fillStyle
  if (typeof fill === 'string') {
    const r = unitRaster(ctx, text, fontSize, fill, stroke)
    if (r) {
      drawRaster(ctx, r, 0, 0, popScale)
      return
    }
  }

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
  drawTextWithSpacing(ctx, text, 0, 0, stroke && stroke.width > 0 ? stroke : undefined)
  ctx.restore()
}

export interface ActiveWordInfo {
  index: number // flat index into all words across all lines; -1 if none
  popScale: number
  /** False during a real pause after this word. Keep the base caption/window
   * visible, but do not colour any word until speech resumes. */
  active: boolean
}

interface WordRunLayout {
  words: { text: string; width: number; centerX: number }[]
}

/** Place individually-painted words against the exact width of the full shaped
 * line. Deriving the inter-word gap from that width keeps karaoke overlays on
 * top of their source glyphs even when letterSpacing/wordSpacing is enabled. */
function layoutWordRun(
  ctx: CanvasRenderingContext2D,
  words: string[],
  align: CanvasTextAlign,
): WordRunLayout {
  const lineWidth = measureTextWithSpacing(ctx, words.join(' '))
  const widths = words.map((word) => measureTextWithSpacing(ctx, word))
  const wordsWidth = widths.reduce((sum, width) => sum + width, 0)
  const gap = words.length > 1 ? Math.max(0, (lineWidth - wordsWidth) / (words.length - 1)) : 0
  let cursor = align === 'left' ? 0 : align === 'right' ? -lineWidth : -lineWidth / 2
  return {
    words: words.map((text, index) => {
      const width = widths[index]!
      const item = { text, width, centerX: cursor + width / 2 }
      cursor += width + gap
      return item
    }),
  }
}

/**
 * Which single word (by flat index) is "active" right now, always one word at
 * a time regardless of reveal.unit — used by the karaoke colour-sweep template,
 * not the hide/reveal caption above.
 */
export function getActiveWordIndex(totalWords: number, reveal: CaptionReveal): ActiveWordInfo {
  const elapsed = Math.max(0, reveal.elapsedSec)
  if (totalWords === 0) return { index: -1, popScale: 1, active: false }

  if (reveal.wordTimestamps && reveal.wordTimestamps.length > 0) {
    const ts = reveal.wordTimestamps.slice(0, totalWords)
    if (ts.length === 0 || elapsed < ts[0]!.startSec) {
      return { index: -1, popScale: 1, active: false }
    }
    let previousIndex = -1
    for (let i = 0; i < ts.length; i++) {
      const start = Math.max(0, ts[i]!.startSec)
      const end = Math.max(start, ts[i]!.endSec)
      if (elapsed < start) {
        return { index: previousIndex, popScale: 1, active: false }
      }
      if (elapsed < end) {
        const popT = Math.min(1, Math.max(0, elapsed - start) / POP_SEC)
        return { index: i, popScale: 1 + (1 - popT) * 0.18, active: true }
      }
      previousIndex = i
    }
    return { index: previousIndex, popScale: 1, active: false }
  }

  const clipDur = Math.max(0.001, reveal.clipDuration)
  const progress = Math.min(1, elapsed / clipDur)
  const idx = Math.min(totalWords - 1, Math.floor(progress * totalWords))
  const wordStartSec = (idx / totalWords) * clipDur
  const popT = Math.min(1, Math.max(0, elapsed - wordStartSec) / POP_SEC)
  return { index: idx, popScale: 1 + (1 - popT) * 0.18, active: true }
}

/**
 * Bounding rect (relative to the anchor) of the karaoke N-word window currently
 * on screen when unit>1 — lets the background box hug the visible words (like
 * the server's ASS BorderStyle=3 box) instead of the whole paragraph.
 * Returns null for unit<=1, where the full wrapped text is always visible and
 * the paragraph rect is correct. Uses the same word-based windowing as
 * drawKaraokeSweep so box and text never desync (getCurrentRevealUnit's
 * fallback distributes GROUPS over time, not words — a different bucketing).
 */
export function getKaraokeWindowRect(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  align: CanvasTextAlign,
  reveal: CaptionReveal,
): { x: number; y: number; w: number; h: number } | null {
  const unit = Math.max(1, Math.floor(reveal.unit))
  if (unit <= 1) return null
  const words = lines.flatMap((l) => l.split(/\s+/).filter(Boolean))
  const { index } = getActiveWordIndex(words.length, reveal)
  if (index < 0) return null
  const groupStart = Math.floor(index / unit) * unit
  const text = words.slice(groupStart, Math.min(words.length, groupStart + unit)).join(' ')
  const w = measureTextWithSpacing(ctx, text)
  const lineH = fontSize * LINE_HEIGHT_RATIO
  const x = align === 'left' ? 0 : align === 'right' ? -w : -w / 2
  return { x, y: -lineH / 2, w, h: lineH }
}

/**
 * CapCut-style karaoke. For unit=1, keep the full-line colour sweep. For
 * unit>1, show only the current N-word window and recolour the active word
 * inside that window.
 */
export function drawKaraokeSweep(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  fontSize: number,
  align: CanvasTextAlign,
  reveal: CaptionReveal,
  highlightColor: string,
  stroke?: { color: string; width: number },
): void {
  const lineH = fontSize * LINE_HEIGHT_RATIO
  const baseFill = ctx.fillStyle
  // Raster-cache every word separately. Each visible word is painted exactly
  // once: base words use baseFill, while the active word uses highlightColor.
  // Drawing a base line and then overlaying its active word creates two copies
  // of the same glyph and visibly doubles/misaligns it with display fonts.
  const cacheable = typeof baseFill === 'string'
  if (!cacheable && stroke && stroke.width > 0) {
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = stroke.width
  }
  const paintUnit = (
    text: string,
    fill: string,
    x: number,
    y: number,
    paintStroke?: { color: string; width: number },
  ): void => {
    const r = cacheable ? unitRaster(ctx, text, fontSize, fill, paintStroke) : null
    if (r) {
      drawRaster(ctx, r, x, y, 1)
      return
    }
    ctx.save()
    ctx.fillStyle = fill
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (paintStroke && paintStroke.width > 0) {
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      ctx.strokeStyle = paintStroke.color
      ctx.lineWidth = paintStroke.width
    }
    ctx.translate(x, y)
    drawTextWithSpacing(ctx, text, 0, 0, paintStroke && paintStroke.width > 0 ? paintStroke : undefined)
    ctx.restore()
  }

  const wordsPerLine = lines.map((l) => l.split(' ').filter(Boolean))
  const totalWords = wordsPerLine.reduce((n, w) => n + w.length, 0)
  const { index, active } = getActiveWordIndex(totalWords, reveal)
  if (index < 0) return

  const groupSize = Math.max(1, reveal.unit || 1)
  const groupStart = Math.floor(index / groupSize) * groupSize
  const groupEnd = Math.min(totalWords, groupStart + groupSize)
  if (groupSize > 1) {
    const words = wordsPerLine.flat()
    const visibleWords = words.slice(groupStart, groupEnd)
    const activeLocal = index - groupStart
    const run = layoutWordRun(ctx, visibleWords, align)
    for (let i = 0; i < run.words.length; i++) {
      const word = run.words[i]!
      const fill = active && i === activeLocal ? highlightColor : String(baseFill)
      paintUnit(word.text, fill, word.centerX, 0, stroke)
    }
    ctx.fillStyle = baseFill
    ctx.textAlign = align
    return
  }

  // unit=1: keep the full block visible, but paint every token only once.
  let flatIdx = 0
  let ly = -(lines.length * lineH) / 2 + lineH / 2
  for (let li = 0; li < lines.length; li++) {
    const words = wordsPerLine[li]!
    const run = layoutWordRun(ctx, words, align)
    for (let localIdx = 0; localIdx < run.words.length; localIdx++) {
      const currentFlat = flatIdx + localIdx
      const word = run.words[localIdx]!
      const fill = active && currentFlat >= groupStart && currentFlat < groupEnd
        ? highlightColor
        : String(baseFill)
      paintUnit(word.text, fill, word.centerX, ly, stroke)
    }
    flatIdx += words.length
    ly += lineH
  }
  ctx.fillStyle = baseFill
  ctx.textAlign = align
}
