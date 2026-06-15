export type TrackKind = 'video' | 'audio' | 'text' | 'fx'

export interface TextStroke {
  color: string
  width: number // px at 1080p; 0 = no outline
}

export interface TextAnim {
  kind: 'none' | 'word' | 'group' // pop in word-by-word, or N words at a time
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
}

/** Style-only fields a caption preset can override. */
export type TextPresetStyle = Pick<
  TextClipData,
  'color' | 'fontWeight' | 'hasBackground' | 'backgroundColor'
> & { stroke?: TextStroke }

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

export type FxData = BlurStickerData

export interface ColorAdjust {
  brightness: number // -100..100, 0 = neutral
  contrast: number   // -100..100, 0 = neutral
  saturation: number // -100..100, 0 = neutral
}

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

/** Denoise strength applied to audio during server (FFmpeg) export. */
export type DenoiseLevel = 'light' | 'medium' | 'heavy'

export interface Clip {
  id: string
  assetId: string | null
  trackId: string
  startSec: number
  inPointSec: number
  outPointSec: number
  speed: number          // 1.0 = normal, 2.0 = 2x fast, 0.5 = half speed
  opacity: number        // 0–1
  volume: number         // 0–1 (for audio/video)
  muted?: boolean        // true = this clip contributes no audio (e.g. after detach)
  denoise?: DenoiseLevel // audio noise reduction (server export only; undefined = off)
  adjust: ColorAdjust
  transform: ClipTransform
  textData?: TextClipData
  fxData?: FxData
  effects: ClipEffect[]
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
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
  }
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
