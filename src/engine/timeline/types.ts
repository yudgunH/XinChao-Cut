export type TrackKind = 'video' | 'audio' | 'text' | 'fx'

export interface TextStroke {
  color: string
  width: number // px at 1080p; 0 = no outline
}

export interface TextAnim {
  kind: 'none' | 'word' | 'group' | 'karaoke' // pop in word-by-word, N words at a time,
  // or 'karaoke': the whole line stays visible and only the current word recolours
  groupSize: number // words per reveal step when kind === 'group'
}

export interface WordTimestamp {
  word: string
  startSec: number // seconds from the start of the text clip
  endSec: number
}

export interface TextClipData {
  content: string
  fontSize: number       // px at 1080p
  color: string          // hex e.g. '#ffffff'
  fontFamily: string     // e.g. 'Inter'
  fontWeight: 'normal' | 'bold'
  align: 'left' | 'center' | 'right'
  x: number              // 0–1 relative to canvas width
  y: number              // 0–1 relative to canvas height
  hasBackground: boolean
  backgroundColor: string
  stroke?: TextStroke
  anim?: TextAnim
  wordTimestamps?: WordTimestamp[] // per-word timing for accurate animation
  /** Extra tracking between characters, px at 1080p. 0/undefined = font default.
   *  Canvas renderers apply explicit tracking (with a manual WebView fallback);
   *  server export maps it to ASS `Spacing`. */
  letterSpacing?: number
  /** Extra spacing after word separators, px at 1080p. Animated captions use a
   *  stroke-aware default when omitted so outlined words cannot crowd together. */
  wordSpacing?: number
  /** Colour the active word turns to when anim.kind === 'karaoke'. */
  highlightColor?: string
}

/** Style-only fields a caption preset can override. */
export type TextPresetStyle = Pick<
  TextClipData,
  'color' | 'fontWeight' | 'hasBackground' | 'backgroundColor'
> & Partial<Pick<TextClipData, 'fontFamily' | 'letterSpacing' | 'wordSpacing'>> & { stroke?: TextStroke; anim?: TextAnim; highlightColor?: string }

export interface TextPreset {
  id: string
  label: string
  style: TextPresetStyle
}

const OUTLINE = (color: string, width = 6): TextStroke => ({ color, width })

/** Built-in caption styles (TikTok/CapCut-like). Fonts/assets are our own. */
export const TEXT_PRESETS: TextPreset[] = [
  { id: 'plain', label: 'Aa', style: { color: '#ffffff', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000' } },
  { id: 'outline-black', label: 'Aa', style: { color: '#ffffff', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#000000', 7) } },
  { id: 'outline-white', label: 'Aa', style: { color: '#000000', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#ffffff', 7) } },
  { id: 'yellow', label: 'Aa', style: { color: '#ffd400', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#000000', 7) } },
  { id: 'red', label: 'Aa', style: { color: '#ff3b30', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#000000', 7) } },
  { id: 'green', label: 'Aa', style: { color: '#37e06b', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#000000', 7) } },
  { id: 'cyan', label: 'Aa', style: { color: '#22d3ee', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#003344', 7) } },
  { id: 'box-black', label: 'Aa', style: { color: '#ffffff', fontWeight: 'bold', hasBackground: true, backgroundColor: '#000000' } },
  { id: 'box-white', label: 'Aa', style: { color: '#000000', fontWeight: 'bold', hasBackground: true, backgroundColor: '#ffffff' } },
  { id: 'box-accent', label: 'Aa', style: { color: '#ffffff', fontWeight: 'bold', hasBackground: true, backgroundColor: '#4f9cf9' } },
  { id: 'box-yellow', label: 'Aa', style: { color: '#000000', fontWeight: 'bold', hasBackground: true, backgroundColor: '#ffd400' } },
  { id: 'box-red', label: 'Aa', style: { color: '#ffffff', fontWeight: 'bold', hasBackground: true, backgroundColor: '#ff3b30' } },
]

/** CapCut-style karaoke templates: word-by-word highlight pill, or a full-line
 *  colour sweep. Kept separate from TEXT_PRESETS so the panel can group them
 *  under their own "Karaoke" section. */
export const KARAOKE_TEMPLATES: TextPreset[] = [
  {
    id: 'karaoke-pill-yellow',
    label: 'Aa',
    style: { color: '#000000', fontWeight: 'bold', hasBackground: true, backgroundColor: '#ffd400', anim: { kind: 'word', groupSize: 1 } },
  },
  {
    id: 'karaoke-pill-white',
    label: 'Aa',
    style: { color: '#111111', fontWeight: 'bold', hasBackground: true, backgroundColor: '#ffffff', anim: { kind: 'word', groupSize: 1 } },
  },
  {
    id: 'karaoke-sweep',
    label: 'Aa',
    style: { color: '#ffffff', fontWeight: 'bold', hasBackground: false, backgroundColor: '#000000', stroke: OUTLINE('#000000', 6), anim: { kind: 'karaoke', groupSize: 1 }, highlightColor: '#ffd400', wordSpacing: 10 },
  },
]

export interface ClipEffect {
  id: string
  type: string
  params: Record<string, number | string | boolean>
}

export interface BlurStickerData {
  type: 'blur-sticker'
  x: number
  y: number
  w: number
  h: number
  blurPx: number
  radius: number
}

/** A full-frame look filter (CapCut-style "Filters") that lives on an fx track
 *  and colour-grades everything beneath it for its duration. */
export type FilterKind = '4k' | 'vivid' | 'warm' | 'cool' | 'cinematic' | 'bw'

export interface FilterFxData {
  type: 'filter'
  filter: FilterKind
  intensity: number // 0..1
}

export type FxData = BlurStickerData | FilterFxData

export interface FilterPreset {
  id: FilterKind
  label: string
  // Colour deltas at intensity 1 — same units as ColorAdjust (±%), hue in degrees.
  brightness: number
  contrast: number
  saturation: number
  hue: number
  // Sharpen/clarity strength (0..1) — the "4K/HD" detail enhance, not just colour.
  sharpen: number
}

/** Built-in look presets. "4K" is the CapCut-style enhance: clarity/sharpen +
 *  a punchy grade, so footage reads crisper ("4K"), not just recoloured. */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: '4k',        label: '4K',        brightness: 4,  contrast: 20, saturation: 24,   hue: 0,   sharpen: 0.8 },
  { id: 'vivid',     label: 'Vivid',     brightness: 2,  contrast: 14, saturation: 42,   hue: 0,   sharpen: 0.3 },
  { id: 'warm',      label: 'Warm',      brightness: 3,  contrast: 10, saturation: 20,   hue: -10, sharpen: 0.15 },
  { id: 'cool',      label: 'Cool',      brightness: 2,  contrast: 10, saturation: 16,   hue: 12,  sharpen: 0.15 },
  { id: 'cinematic', label: 'Cinematic', brightness: -3, contrast: 24, saturation: -6,   hue: -6,  sharpen: 0.25 },
  { id: 'bw',        label: 'B&W',       brightness: 4,  contrast: 24, saturation: -100, hue: 0,   sharpen: 0.3 },
]

export function makeFilterFxData(filter: FilterKind = '4k'): FilterFxData {
  return { type: 'filter', filter, intensity: 1 }
}

/** Colour deltas for a filter fx, scaled by its intensity. Shared so the canvas
 *  and the FFmpeg backend grade identically (the backend mirrors FILTER_PRESETS). */
export function filterParams(fx: FilterFxData): { brightness: number; contrast: number; saturation: number; hue: number; sharpen: number } {
  const p = FILTER_PRESETS.find((x) => x.id === fx.filter) ?? FILTER_PRESETS[0]!
  const k = Math.max(0, Math.min(1, fx.intensity ?? 1))
  return {
    brightness: p.brightness * k,
    contrast: p.contrast * k,
    saturation: Math.max(-100, p.saturation * k),
    hue: p.hue * k,
    sharpen: p.sharpen * k,
  }
}

/** CSS/canvas filter string for a filter fx — a full-frame post-process. */
export function filterToCanvas(fx: FilterFxData): string {
  const { brightness, contrast, saturation, hue } = filterParams(fx)
  const parts = [
    `brightness(${(1 + brightness / 100).toFixed(3)})`,
    `contrast(${(1 + contrast / 100).toFixed(3)})`,
    `saturate(${Math.max(0, 1 + saturation / 100).toFixed(3)})`,
  ]
  if (Math.abs(hue) > 0.5) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`)
  return parts.join(' ')
}

export interface ColorAdjust {
  brightness: number // -100..100, 0 = neutral
  contrast: number   // -100..100, 0 = neutral
  saturation: number // -100..100, 0 = neutral
}

/** Animatable numeric properties (CapCut keyframes). t is CLIP-LOCAL seconds
 *  (timelineSec − clip.startSec) so keyframes survive moves/trims. */
export type KeyframeProp = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity'

export interface Keyframe {
  t: number
  v: number
  ease?: 'linear' | 'easeInOut'
}

export type ClipKeyframes = Partial<Record<KeyframeProp, Keyframe[]>>

export interface ClipTransform {
  x: number      // 0-1 relative to canvas width
  y: number      // 0-1 relative to canvas height
  scale: number  // 1 = fit source to project frame
  scaleX: number // 1 = natural fitted width
  scaleY: number // 1 = natural fitted height
  rotation: number // degrees
  flipH?: boolean // mirror horizontally
  flipV?: boolean // mirror vertically
  /** Fraction of the source frame trimmed off each side (0..~0.45). Omitted = no crop. */
  crop?: { l: number; r: number; t: number; b: number }
}

/** Reference frame height blur radii are authored against — the 720p preview
 *  canvas (`COMP_H`). Every renderer must scale blurPx (canvasFill AND blur
 *  stickers) by `frameHeight / BLUR_REF_HEIGHT`, otherwise a full-res export
 *  blurs ~2.7x weaker (relative to the frame) than the preview the user tuned. */
export const BLUR_REF_HEIGHT = 720

export type ClipCanvasFillMode = 'none' | 'blur'

export interface ClipCanvasFill {
  mode: ClipCanvasFillMode
  /** CSS/canvas blur radius in pixels for the expanded background duplicate. */
  blurPx?: number
  /** Extra cover-scale multiplier so blurred edges bleed past the frame. */
  scale?: number
  /** Background duplicate opacity, multiplied by clip opacity. */
  opacity?: number
}

/** Denoise strength applied to audio during server (FFmpeg) export. */
export type DenoiseLevel = 'light' | 'medium' | 'heavy'

export interface Clip {
  id: string
  assetId: string | null
  trackId: string
  /** Group membership (CapCut-style): clips sharing a groupId select, move, and
   *  delete together. Undefined = ungrouped. */
  groupId?: string
  /** Optional source relationship for generated media (for example a TTS clip
   * produced from one caption). This is metadata only: audio remains independently
   * editable and does not follow video/text link operations. */
  syncToClipId?: string
  /** Compound clip: when set, this clip is a nested sub-timeline (no asset). The
   *  sub-timeline lives in the store's `compounds` registry under this id;
   *  double-click enters it. inPoint/outPoint window into the compound's content. */
  compoundId?: string
  startSec: number
  inPointSec: number
  outPointSec: number
  speed: number          // 1.0 = normal, 2.0 = 2x fast, 0.5 = half speed
  opacity: number        // 0–1
  volume: number         // linear gain; 1 = 0dB, can boost above 1
  muted?: boolean        // true = this clip contributes no audio (e.g. after detach)
  /** Audio clip created by detaching a video's original audio. */
  detachedFromClipId?: string
  denoise?: DenoiseLevel // audio noise reduction (server export only; undefined = off)
  adjust: ColorAdjust
  transform: ClipTransform
  canvasFill?: ClipCanvasFill
  textData?: TextClipData
  fxData?: FxData
  effects: ClipEffect[]
  /** Per-property keyframes (CapCut-style). When a prop has keyframes its value
   *  is interpolated over the clip and the static transform/opacity field for
   *  that prop is ignored. See resolveClipTransformAt / resolveClipOpacityAt. */
  keyframes?: ClipKeyframes
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  /** Hidden tracks are excluded from BOTH the preview and the export (visual
   *  tracks aren't drawn, audio tracks aren't mixed) — what you see is what you
   *  get. Optional for back-compat with projects saved before this existed. */
  hidden?: boolean
}

export interface TimelineState {
  tracks: Track[]
  clips: Clip[]
  durationSec: number
  fps: number
}

export function makeDefaultTextData(): TextClipData {
  return {
    content: 'Your text here',
    fontSize: 64,
    color: '#ffffff',
    fontFamily: 'Inter, sans-serif',
    fontWeight: 'bold',
    align: 'center',
    x: 0.5,
    y: 0.85,
    hasBackground: false,
    backgroundColor: '#000000',
    letterSpacing: 5,
    wordSpacing: 0,
  }
}

/** Subtitle style: bottom-centred, medium bold white text with a shadow. */
export function makeSubtitleTextData(content: string, wordTimestamps?: WordTimestamp[]): TextClipData {
  return {
    content,
    fontSize: 48,
    color: '#ffffff',
    fontFamily: 'Inter, sans-serif',
    fontWeight: 'bold',
    align: 'center',
    x: 0.5,
    y: 0.86,
    hasBackground: false,
    backgroundColor: '#000000',
    stroke: { color: '#000000', width: 6 },
    wordTimestamps,
    letterSpacing: 5,
    wordSpacing: 0,
  }
}

/** Resolve word spacing for new and legacy captions. Old projects do not carry
 * this field, so animated text gets enough breathing room for its outline while
 * ordinary title typography retains the font's native spacing. */
export function resolvedTextWordSpacing(td: TextClipData): number {
  if (Number.isFinite(td.wordSpacing)) return Math.max(0, Math.min(48, td.wordSpacing!))
  if (!td.anim || td.anim.kind === 'none') return 0
  const outline = Math.max(0, td.stroke?.width ?? 0)
  return Math.min(24, Math.max(8, td.fontSize * 0.16, outline * 1.1))
}

export function makeDefaultAdjust(): ColorAdjust {
  return { brightness: 0, contrast: 0, saturation: 0 }
}

export function makeDefaultTransform(): ClipTransform {
  return { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }
}

export function adjustToFilter(a: ColorAdjust): string {
  const b = 1 + a.brightness / 100
  const c = 1 + a.contrast / 100
  const s = 1 + a.saturation / 100
  return `brightness(${b}) contrast(${c}) saturate(${s})`
}

export function isAdjustNeutral(a: ColorAdjust): boolean {
  return a.brightness === 0 && a.contrast === 0 && a.saturation === 0
}

/**
 * A caption is a text clip from auto-captions or an imported subtitle file —
 * marked by per-word timing or an outline. Decorative title text (no stroke /
 * no word timing) is NOT a caption, so it stays independent.
 */
export function isCaptionClip(clip: Clip): boolean {
  return !!clip.textData && (!!clip.textData.stroke || !!clip.textData.wordTimestamps)
}

export function captionClipIdsOnTrack(clips: Clip[], trackId: string): string[] {
  return clips
    .filter((clip) => clip.trackId === trackId && isCaptionClip(clip))
    .map((clip) => clip.id)
}

export function clipEffectiveDuration(clip: Clip): number {
  return (clip.outPointSec - clip.inPointSec) / Math.max(clip.speed, 0.01)
}

export function clipSourceSec(clip: Clip, timelineSec: number): number {
  return clip.inPointSec + (timelineSec - clip.startSec) * clip.speed
}

export function clipIsActiveAt(clip: Clip, timelineSec: number): boolean {
  const dur = clipEffectiveDuration(clip)
  return timelineSec >= clip.startSec && timelineSec < clip.startSec + dur
}
