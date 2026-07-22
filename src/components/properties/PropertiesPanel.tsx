import {
  Activity,
  Diamond,
  MoveLeft,
  MoveRight,
  MoveDown,
  MoveUp,
  RotateCw,
  Trash2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import {
  dbToVolume,
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  volumeToDb,
} from '@engine/audio/volume'
import {
  captionClipIdsOnTrack,
  clipEffectiveDuration,
  currentKeyframeValue,
  isCaptionClip,
} from '@engine/timeline'
import {
  EFFECT_LABEL,
  ZOOM_EFFECT_TYPES,
  FILTER_PRESETS,
  getEffectAmount,
  type Clip,
  type ClipEffectType,
  type FilterKind,
  type FxData,
  type KeyframeProp,
} from '@engine/timeline'

/** Display name for an fx clip (filter look or blur sticker). */
function fxClipName(fx: FxData): string {
  if (fx.type === 'filter') {
    return `Filter · ${FILTER_PRESETS.find((p) => p.id === fx.filter)?.label ?? fx.filter}`
  }
  return 'Blur sticker'
}
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { usePlaybackStore } from '@store/playback-store'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore, type RightPanelTab } from '@store/ui-store'

import { VocalSeparation } from './VocalSeparation'

const CaptionStudio = lazy(() =>
  import('./CaptionStudio').then((module) => ({ default: module.CaptionStudio })),
)

/** Props the master "Tất cả" keyframe toggle covers (position = x+y). */
const KF_ALL_PROPS: KeyframeProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

const TABS: { id: RightPanelTab; label: string }[] = [
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'speed', label: 'Speed' },
  { id: 'animation', label: 'Animation' },
  { id: 'adjust', label: 'Adjust' },
]

function fmtDb(db: number): string {
  return db <= MIN_VOLUME_DB ? '-inf' : `${db.toFixed(1)}dB`
}

const EFFECT_ICON: Record<ClipEffectType, LucideIcon> = {
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  'pan-left': MoveLeft,
  'pan-right': MoveRight,
  pulse: Activity,
  tilt: RotateCw,
  'fade-in': ZoomIn,
  'fade-out': ZoomOut,
  'slide-in-left': MoveLeft,
  'slide-out-right': MoveRight,
  'rise-in': MoveUp,
  'drop-out': MoveDown,
}

const EFFECT_HINT: Record<ClipEffectType, string> = {
  'zoom-in': 'Normal to closer.',
  'zoom-out': 'Closer to normal.',
  'pan-left': 'Slowly drifts left.',
  'pan-right': 'Slowly drifts right.',
  pulse: 'Punches in near the middle.',
  tilt: 'Adds a gentle rotation swing.',
  'fade-in': 'Fades in at the start.',
  'fade-out': 'Fades out at the end.',
  'slide-in-left': 'Slides in from the left.',
  'slide-out-right': 'Slides out to the right.',
  'rise-in': 'Rises in from below.',
  'drop-out': 'Drops out at the end.',
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs text-text-2">{label}</p>
      {children}
    </div>
  )
}

/** A ◇ toggle for a keyframeable property group. Filled/accent when the property
 *  is animated; clicking adds/removes a keyframe at the playhead. */
function KeyframeToggle({
  label,
  clip,
  props,
  onToggle,
}: {
  label: string
  clip: Clip
  props: KeyframeProp[]
  onToggle: () => void
}) {
  const active = props.some((p) => (clip.keyframes?.[p]?.length ?? 0) > 0)
  return (
    <button
      onClick={onToggle}
      title={`${active ? 'Đang' : 'Thêm'} keyframe ${label} tại playhead`}
      className={`flex items-center gap-1 rounded border px-1.5 py-1 text-2xs ${
        active
          ? 'border-accent/50 bg-accent/15 text-accent'
          : 'border-border-strong bg-bg-2 text-text-2 hover:bg-bg-3 hover:text-text-1'
      }`}
    >
      <Diamond size={9} className={active ? 'fill-current' : ''} /> {label}
    </button>
  )
}

function SliderNum({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  onScrubStart,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onChange: (v: number) => void
  /** Fired once when the user grabs the slider (pointer-down / keyboard focus
   *  before changing) — wire to beginHistoryStep so the whole drag is one undo
   *  step. The onChange setters themselves no longer push history. */
  onScrubStart?: () => void
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-text-3">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onScrubStart}
        onKeyDown={(e) => {
          // Arrow-key nudges also begin one history step.
          if (e.key.startsWith('Arrow')) onScrubStart?.()
        }}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-[#71717a]"
      />
      <span className="w-10 text-right font-mono text-xs text-text-1">
        {format ? format(value) : value}
      </span>
    </div>
  )
}

function SpeedValueBox({
  value,
  suffix,
  min,
  max,
  step,
  onChange,
}: {
  value: number
  suffix: string
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  const decimals = suffix === 'x' ? 2 : 1
  const [draft, setDraft] = useState(value.toFixed(decimals))

  useEffect(() => {
    setDraft(value.toFixed(decimals))
  }, [decimals, value])

  const commit = (raw = draft) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setDraft(value.toFixed(decimals))
      return
    }
    const next = Math.max(min, Math.min(max, parsed))
    setDraft(next.toFixed(decimals))
    onChange(next)
  }

  const nudge = (delta: number) => {
    const base = Number(draft)
    const next = Math.max(min, Math.min(max, (Number.isFinite(base) ? base : value) + delta))
    setDraft(next.toFixed(decimals))
    onChange(next)
  }

  return (
    <div className="flex h-8 w-[104px] items-center overflow-hidden rounded bg-bg-2 ring-1 ring-border focus-within:ring-accent">
      <button
        type="button"
        onClick={() => nudge(-step)}
        className="grid h-full w-6 place-items-center text-text-2 hover:bg-bg-3 hover:text-text-1"
      >
        -
      </button>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(step)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(-step)
          }
        }}
        className="min-w-0 flex-1 bg-transparent px-1 text-right font-mono text-xs text-text-1 outline-none"
      />
      <span className="px-1 text-2xs text-text-2">{suffix}</span>
      <button
        type="button"
        onClick={() => nudge(step)}
        className="grid h-full w-6 place-items-center text-text-2 hover:bg-bg-3 hover:text-text-1"
      >
        +
      </button>
    </div>
  )
}

function SwitchToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-9 rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-bg-3'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <span
        className={`absolute left-0 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

export function PropertiesPanel() {
  const active = useUIStore((s) => s.activeRightTab)
  const setTab = useUIStore((s) => s.setActiveRightTab)
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  const setClipSpeed = useTimelineStore((s) => s.setClipSpeed)
  const setClipSpeedDuration = useTimelineStore((s) => s.setClipSpeedDuration)
  const setClipsOpacity = useTimelineStore((s) => s.setClipsOpacity)
  const setClipsVolume = useTimelineStore((s) => s.setClipsVolume)
  const setClipDenoise = useTimelineStore((s) => s.setClipDenoise)
  const setClipText = useTimelineStore((s) => s.setClipText)
  const setClipFxData = useTimelineStore((s) => s.setClipFxData)
  const setClipsCanvasFill = useTimelineStore((s) => s.setClipsCanvasFill)
  const applyTextStyle = useTimelineStore((s) => s.applyTextStyle)
  const applyClipEffect = useTimelineStore((s) => s.applyClipEffect)
  const updateClipEffect = useTimelineStore((s) => s.updateClipEffect)
  const removeClipEffect = useTimelineStore((s) => s.removeClipEffect)
  const setClipsAdjust = useTimelineStore((s) => s.setClipsAdjust)
  const setClipTransformKeyed = useTimelineStore((s) => s.setClipTransformKeyed)
  const setClipOpacityKeyed = useTimelineStore((s) => s.setClipOpacityKeyed)
  const toggleKeyframes = useTimelineStore((s) => s.toggleKeyframes)
  // Do NOT subscribe to currentSec (60fps re-renders while playing). Keyframe
  // writers + displayed interpolated values still read getState().currentSec at
  // use time. Subscribe to seekNonce only so the panel re-renders after a user
  // seek (drag playhead, click ruler, skip) and sliders refresh — seekNonce does
  // NOT bump on RAF tick() during play (see playback-store.ts), so playback stays
  // off the React path.
  usePlaybackStore((s) => s.seekNonce)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)
  const [speedMode, setSpeedMode] = useState<'standard' | 'curve' | 'velocity'>('standard')
  const [changePitch, setChangePitch] = useState(false)
  // True while a text-content typing session is in progress (one undo step per).
  const textEditingRef = useRef(false)
  const assets = useProjectStore((s) => s.assets)
  const compounds = useTimelineStore((s) => s.compounds)
  const [backendCaps] = useBackendCapabilities()
  const canSeparate = !!backendCaps?.separate

  const clip = selectedClipIds[0] ? clips.find((c) => c.id === selectedClipIds[0]) : null
  const asset = clip?.assetId ? assets.find((a) => a.id === clip.assetId) : null
  const compound = clip?.compoundId ? compounds[clip.compoundId] : null
  const selectedVisualClipIds = selectedClipIds.filter((id) => {
    const candidate = clips.find((c) => c.id === id)
    const track = candidate ? tracks.find((t) => t.id === candidate.trackId) : null
    return track?.kind === 'video' || track?.kind === 'text'
  })
  const selectedTransformClipIds = selectedClipIds.filter((id) => {
    const candidate = clips.find((c) => c.id === id)
    const track = candidate ? tracks.find((t) => t.id === candidate.trackId) : null
    return (
      track?.kind === 'video' &&
      !!candidate &&
      !candidate.textData &&
      !candidate.fxData &&
      (!!candidate.assetId || !!candidate.compoundId)
    )
  })

  // Sync-edit targets: when several compatible clips are selected, an inspector
  // edit applies to ALL of them (CapCut "adjust many at once"); otherwise just
  // the active clip. mediaVisualIds = media on video tracks (opacity/colour);
  // audibleIds = anything with audio (volume).
  const mediaVisualIds = selectedClipIds.filter((id) => {
    const c = clips.find((x) => x.id === id)
    if (!c || c.textData || c.fxData || (!c.assetId && !c.compoundId)) return false
    return tracks.find((t) => t.id === c.trackId)?.kind === 'video'
  })
  const canvasFillIds = selectedClipIds.filter((id) => {
    const c = clips.find((x) => x.id === id)
    if (!c || c.textData || c.fxData || !c.assetId) return false
    return tracks.find((t) => t.id === c.trackId)?.kind === 'video'
  })
  const allCanvasFillIds = clips
    .filter((c) => {
      if (c.textData || c.fxData || !c.assetId) return false
      return tracks.find((t) => t.id === c.trackId)?.kind === 'video'
    })
    .map((c) => c.id)
  const audibleIds = selectedClipIds.filter((id) => {
    const c = clips.find((x) => x.id === id)
    if (!c || (!c.assetId && !c.compoundId)) return false
    const k = tracks.find((t) => t.id === c.trackId)?.kind
    return k === 'video' || k === 'audio'
  })
  const fanout = (ids: string[]) => (ids.length > 1 ? ids : clip ? [clip.id] : [])
  const transformEditIds = fanout(selectedTransformClipIds)
  const canvasEditIds = fanout(canvasFillIds)
  const canTransformClip =
    !!clip && !clip.textData && !clip.fxData && (!!clip.assetId || !!clip.compoundId)
  const canCanvasFillClip = !!clip && !clip.textData && !clip.fxData && !!clip.assetId
  const applyCanvasBlur = (ids = canvasEditIds, blurPx = clip?.canvasFill?.blurPx ?? 34, history = true) => {
    if (history) beginHistoryStep()
    setClipsCanvasFill(ids, { mode: 'blur', blurPx, scale: 1.08, opacity: 1 })
  }
  const clearCanvasFill = (ids = canvasEditIds, history = true) => {
    if (history) beginHistoryStep()
    setClipsCanvasFill(ids, undefined)
  }
  const setTransformKeyed = (patch: Parameters<typeof setClipTransformKeyed>[1]) => {
    const sec = usePlaybackStore.getState().currentSec
    for (const id of transformEditIds) setClipTransformKeyed(id, patch, sec)
  }
  const clipDurationSec = clip ? clipEffectiveDuration(clip) : 0
  const clipSourceSpanSec = clip ? Math.max(0.1, clip.outPointSec - clip.inPointSec) : 0.1
  const setStandardSpeed = (speed: number) => {
    if (!clip || !Number.isFinite(speed)) return
    beginHistoryStep()
    setClipSpeed(clip.id, speed)
  }
  const setStandardDuration = (durationSec: number) => {
    if (!clip || !Number.isFinite(durationSec)) return
    beginHistoryStep()
    setClipSpeedDuration(clip.id, clip.startSec, durationSec)
  }

  // Style/position edits to a SUBTITLE propagate to every subtitle (CapCut
  // "apply to all" — but only within that caption track, so translated captions
  // can be styled/positioned separately from the originals. Content edits stay
  // per-clip.
  const captionEditIds =
    clip && isCaptionClip(clip)
      ? captionClipIdsOnTrack(clips, clip.trackId)
      : clip
        ? [clip.id]
        : []
  const applyCaption = (style: Parameters<typeof applyTextStyle>[1]) =>
    applyTextStyle(captionEditIds, style)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tabs */}
      <div className="flex shrink-0 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative flex-1 py-2.5 text-xs transition-colors ${
              active === t.id ? 'text-text-1' : 'text-text-2 hover:bg-bg-2 hover:text-text-1'
            }`}
          >
            {t.label}
            {active === t.id && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 text-xs">
        {!clip ? (
          <div className="mt-8 text-center text-text-3">Select a clip to edit</div>
        ) : (
          <>
            {/* Clip info */}
            <div className="mb-3 rounded bg-bg-2 px-2 py-1.5">
              <p className="font-medium text-text-1">
                {compound?.name ??
                  asset?.name ??
                  (clip.fxData
                    ? fxClipName(clip.fxData)
                    : clip.textData ? 'Text clip' : 'Clip')}
              </p>
              <p className="text-2xs text-text-3">
                {clip.fxData ? 'FX' : clip.textData ? 'Text' : (asset?.kind ?? 'Unknown')} ·{' '}
                {((clip.outPointSec - clip.inPointSec) / clip.speed).toFixed(2)}s
              </p>
              {selectedClipIds.length > 1 && (
                <p className="mt-1 text-2xs text-accent">
                  {selectedClipIds.length} clip đang chọn — chỉnh sửa áp cho tất cả
                </p>
              )}
            </div>

            {active === 'video' && (
              <>
                {canTransformClip && (
                  <PropRow label={clip.compoundId ? 'Transform (Compound)' : 'Transform'}>
                    <div className="space-y-1.5">
                      <SliderNum
                        label="Scale"
                        value={Math.round(
                          currentKeyframeValue(clip, 'scale', usePlaybackStore.getState().currentSec) *
                            100,
                        )}
                        min={10}
                        max={500}
                        format={(v) => `${v}%`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setTransformKeyed({ scale: v / 100 })}
                      />
                      <SliderNum
                        label="X"
                        value={Math.round(
                          (currentKeyframeValue(clip, 'x', usePlaybackStore.getState().currentSec) -
                            0.5) *
                            100,
                        )}
                        min={-100}
                        max={100}
                        format={(v) => `${v}`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setTransformKeyed({ x: 0.5 + v / 100 })}
                      />
                      <SliderNum
                        label="Y"
                        value={Math.round(
                          (currentKeyframeValue(clip, 'y', usePlaybackStore.getState().currentSec) -
                            0.5) *
                            100,
                        )}
                        min={-100}
                        max={100}
                        format={(v) => `${v}`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setTransformKeyed({ y: 0.5 + v / 100 })}
                      />
                      <SliderNum
                        label="Rotate"
                        value={Math.round(
                          currentKeyframeValue(
                            clip,
                            'rotation',
                            usePlaybackStore.getState().currentSec,
                          ),
                        )}
                        min={-180}
                        max={180}
                        format={(v) => `${v}deg`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setTransformKeyed({ rotation: v })}
                      />
                    </div>
                  </PropRow>
                )}
                {canCanvasFillClip && (
                  <PropRow label="Canvas">
                    <div className="space-y-2 rounded bg-bg-2 p-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={clip.canvasFill?.mode ?? 'none'}
                          onChange={(e) => {
                            if (e.target.value === 'blur') applyCanvasBlur()
                            else clearCanvasFill()
                          }}
                          className="h-7 flex-1 rounded bg-bg-3 px-2 text-xs text-text-1 outline-none"
                        >
                          <option value="none">None</option>
                          <option value="blur">Blur</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => applyCanvasBlur(allCanvasFillIds)}
                          disabled={allCanvasFillIds.length === 0}
                          className="rounded bg-bg-3 px-2 py-1 text-2xs text-text-1 hover:bg-bg-4 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Apply to all
                        </button>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        {[22, 34, 48, 62].map((blurPx) => {
                          const activeBlur = (clip.canvasFill?.blurPx ?? 0) === blurPx
                          return (
                            <button
                              key={blurPx}
                              type="button"
                              onClick={() => applyCanvasBlur(canvasEditIds, blurPx)}
                              className={`relative aspect-square overflow-hidden rounded-md border ${
                                clip.canvasFill?.mode === 'blur' && activeBlur
                                  ? 'border-accent'
                                  : 'border-transparent hover:border-border-strong'
                              }`}
                              title={`Blur ${blurPx}px`}
                            >
                              {asset?.thumbnailDataUrl ? (
                                <img
                                  src={asset.thumbnailDataUrl}
                                  alt=""
                                  className="h-full w-full scale-125 object-cover"
                                  style={{ filter: `blur(${Math.round(blurPx / 3)}px) brightness(.82)` }}
                                  draggable={false}
                                />
                              ) : (
                                <span className="block h-full w-full bg-gradient-to-br from-bg-4 via-bg-3 to-bg-2" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                      {clip.canvasFill?.mode === 'blur' && (
                        <SliderNum
                          label="Blur"
                          value={clip.canvasFill.blurPx ?? 34}
                          min={8}
                          max={80}
                          format={(v) => `${v}px`}
                          onScrubStart={beginHistoryStep}
                          onChange={(v) => applyCanvasBlur(canvasEditIds, v, false)}
                        />
                      )}
                    </div>
                  </PropRow>
                )}
                {clip.fxData?.type === 'blur-sticker' ? (
                  <>
                    <PropRow label="Blur">
                      <SliderNum
                        label="Strength"
                        value={clip.fxData.blurPx}
                        min={0}
                        max={60}
                        format={(v) => `${v}px`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setClipFxData(clip.id, { blurPx: v })}
                      />
                    </PropRow>
                    <PropRow label="Shape">
                      <SliderNum
                        label="Corner"
                        value={clip.fxData.radius}
                        min={0}
                        max={80}
                        format={(v) => `${v}px`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setClipFxData(clip.id, { radius: v })}
                      />
                    </PropRow>
                    <PropRow label="Size">
                      <div className="space-y-1.5">
                        <SliderNum
                          label="Width"
                          value={Math.round(clip.fxData.w * 100)}
                          min={3}
                          max={100}
                          format={(v) => `${v}%`}
                          onScrubStart={beginHistoryStep}
                          onChange={(v) => setClipFxData(clip.id, { w: v / 100 })}
                        />
                        <SliderNum
                          label="Height"
                          value={Math.round(clip.fxData.h * 100)}
                          min={3}
                          max={100}
                          format={(v) => `${v}%`}
                          onScrubStart={beginHistoryStep}
                          onChange={(v) => setClipFxData(clip.id, { h: v / 100 })}
                        />
                      </div>
                    </PropRow>
                  </>
                ) : clip.fxData?.type === 'filter' ? (
                  <>
                    <PropRow label="Filter">
                      <select
                        value={clip.fxData.filter}
                        onChange={(e) => {
                          beginHistoryStep()
                          setClipFxData(clip.id, { filter: e.target.value as FilterKind })
                        }}
                        className="h-7 w-40 rounded bg-bg-3 px-2 text-xs text-text-1 outline-none"
                      >
                        {FILTER_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </PropRow>
                    <PropRow label="Intensity">
                      <SliderNum
                        label="Intensity"
                        value={Math.round((clip.fxData.intensity ?? 1) * 100)}
                        min={0}
                        max={100}
                        format={(v) => `${v}%`}
                        onScrubStart={beginHistoryStep}
                        onChange={(v) => setClipFxData(clip.id, { intensity: v / 100 })}
                      />
                    </PropRow>
                  </>
                ) : clip.fxData ? null : (
                  <PropRow label="Opacity">
                    <SliderNum
                      label="Opacity"
                      value={Math.round(
                        currentKeyframeValue(
                          clip,
                          'opacity',
                          usePlaybackStore.getState().currentSec,
                        ) * 100,
                      )}
                      min={0}
                      max={100}
                      format={(v) => `${v}%`}
                      onScrubStart={beginHistoryStep}
                      onChange={(v) => {
                        // Animated single clip → write a keyframe at the playhead;
                        // otherwise fan a static value across the selection.
                        if (clip.keyframes?.opacity?.length) {
                          setClipOpacityKeyed(
                            clip.id,
                            v / 100,
                            usePlaybackStore.getState().currentSec,
                          )
                        } else {
                          setClipsOpacity(fanout(mediaVisualIds), v / 100)
                        }
                      }}
                    />
                  </PropRow>
                )}

                {/* Keyframes (CapCut ◇): toggle a keyframe at the playhead. Position
                    /scale/rotation then auto-key when you drag in the preview;
                    opacity auto-keys from its slider. */}
                {canTransformClip && (
                  <PropRow label="Keyframe">
                    <div className="flex flex-wrap items-center gap-1">
                      {/* Master ◇: add/remove one keyframe covering ALL props at the
                          playhead (CapCut "gộp làm 1"). */}
                      <KeyframeToggle label="Tất cả" clip={clip} props={KF_ALL_PROPS}
                        onToggle={() =>
                          toggleKeyframes(
                            clip.id,
                            KF_ALL_PROPS,
                            usePlaybackStore.getState().currentSec,
                          )
                        } />
                      <span className="mx-0.5 h-4 w-px bg-border" />
                      <KeyframeToggle label="Vị trí" clip={clip} props={['x', 'y']}
                        onToggle={() =>
                          toggleKeyframes(
                            clip.id,
                            ['x', 'y'],
                            usePlaybackStore.getState().currentSec,
                          )
                        } />
                      <KeyframeToggle label="Scale" clip={clip} props={['scale']}
                        onToggle={() =>
                          toggleKeyframes(
                            clip.id,
                            ['scale'],
                            usePlaybackStore.getState().currentSec,
                          )
                        } />
                      <KeyframeToggle label="Xoay" clip={clip} props={['rotation']}
                        onToggle={() =>
                          toggleKeyframes(
                            clip.id,
                            ['rotation'],
                            usePlaybackStore.getState().currentSec,
                          )
                        } />
                      <KeyframeToggle label="Mờ" clip={clip} props={['opacity']}
                        onToggle={() =>
                          toggleKeyframes(
                            clip.id,
                            ['opacity'],
                            usePlaybackStore.getState().currentSec,
                          )
                        } />
                    </div>
                  </PropRow>
                )}
                {clip.textData && (
                  <Suspense fallback={null}>
                    <CaptionStudio
                      clipId={clip.id}
                      td={clip.textData}
                      applyCaption={applyCaption}
                      setClipText={setClipText}
                      beginHistoryStep={beginHistoryStep}
                      textEditingRef={textEditingRef}
                    />
                  </Suspense>
                )}
              </>
            )}

            {active === 'audio' && (
              <>
                <div className="mb-4 flex border-b border-border">
                  {['Basic', 'Voice changer', 'Speed'].map((label, i) => (
                    <button
                      key={label}
                      type="button"
                      className={`relative px-3 py-2 text-xs font-semibold ${
                        i === 0 ? 'text-accent' : 'text-text-1 hover:text-accent'
                      }`}
                    >
                      {label}
                      {i === 0 && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-accent" />}
                    </button>
                  ))}
                </div>

                <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-text-1">
                  <span className="grid h-4 w-4 place-items-center rounded bg-accent text-[10px] text-black">
                    ✓
                  </span>
                  Basic
                </div>

                <PropRow label="Volume">
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={MIN_VOLUME_DB}
                      max={MAX_VOLUME_DB}
                      step={0.1}
                      value={volumeToDb(clip.volume)}
                      onPointerDown={beginHistoryStep}
                      onChange={(e) =>
                        setClipsVolume(fanout(audibleIds), dbToVolume(Number(e.target.value)))
                      }
                      className="min-w-0 flex-1 accent-[#f4f4f5]"
                    />
                    <div className="flex h-7 w-[74px] items-center justify-center rounded bg-bg-2 font-mono text-xs text-text-1 ring-1 ring-border">
                      {fmtDb(volumeToDb(clip.volume))}
                    </div>
                  </div>
                </PropRow>

                <PropRow label="Fade in">
                  <div className="flex items-center gap-3 opacity-55">
                    <input type="range" min={0} max={10} value={0} readOnly className="min-w-0 flex-1" />
                    <div className="flex h-7 w-[74px] items-center justify-center rounded bg-bg-2 font-mono text-xs text-text-2 ring-1 ring-border">
                      0.0s
                    </div>
                  </div>
                </PropRow>

                <PropRow label="Fade out">
                  <div className="flex items-center gap-3 opacity-55">
                    <input type="range" min={0} max={10} value={0} readOnly className="min-w-0 flex-1" />
                    <div className="flex h-7 w-[74px] items-center justify-center rounded bg-bg-2 font-mono text-xs text-text-2 ring-1 ring-border">
                      0.0s
                    </div>
                  </div>
                </PropRow>

                <div className="my-4 border-t border-border" />

                {/* Denoise — only relevant for audio-bearing clips (not pure text) */}
                {!clip.textData && (
                  <PropRow label="Noise Reduction">
                    <div className="flex gap-1">
                      {(
                        [
                          { value: undefined, label: 'None' },
                          { value: 'light', label: 'Light' },
                          { value: 'medium', label: 'Medium' },
                          { value: 'heavy', label: 'Heavy' },
                        ] as const
                      ).map(({ value, label }) => (
                        <button
                          key={label}
                          onClick={() => setClipDenoise(clip.id, value)}
                          className={`flex-1 rounded py-1 text-2xs ${
                            clip.denoise === value
                              ? 'bg-accent text-white'
                              : 'bg-bg-2 text-text-2 hover:bg-bg-3'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-2xs text-text-3">
                      Heard live on preview · matched on export
                    </p>
                  </PropRow>
                )}

                {/* Vocal/music separation (Demucs) — backend only */}
                {!clip.textData && canSeparate && (
                  <VocalSeparation
                    clipId={clip.id}
                    assetName={asset?.name ?? 'audio'}
                  />
                )}
              </>
            )}

            {active === 'speed' && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-1 rounded bg-bg-2 p-1">
                  {[
                    { id: 'standard', label: 'Standard' },
                    { id: 'curve', label: 'Curve' },
                    { id: 'velocity', label: 'Velocity effects' },
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setSpeedMode(mode.id as typeof speedMode)}
                      className={`rounded py-1.5 text-2xs transition-colors ${
                        speedMode === mode.id
                          ? 'bg-bg-3 text-text-1'
                          : 'text-text-2 hover:bg-bg-3/60 hover:text-text-1'
                      }`}
                    >
                      {mode.label}
                      {mode.id === 'curve' && (
                        <span className="ml-1 rounded bg-accent px-1 text-[9px] text-white">2 uses</span>
                      )}
                    </button>
                  ))}
                </div>

                {speedMode === 'standard' ? (
                  <>
                    <div className="border-t border-border pt-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs text-text-2">Speed</span>
                        <SpeedValueBox
                          value={clip.speed}
                          suffix="x"
                          min={0.1}
                          max={4}
                          step={0.05}
                          onChange={setStandardSpeed}
                        />
                      </div>
                      <div className="relative pr-[120px]">
                        <input
                          type="range"
                          min={0.1}
                          max={4}
                          step={0.05}
                          value={clip.speed}
                          onPointerDown={beginHistoryStep}
                          onChange={(e) => setClipSpeed(clip.id, Number(e.target.value))}
                          className="w-full accent-[#f4f4f5]"
                        />
                        <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between pr-[120px]">
                          {[0.1, 1, 2, 3, 4].map((tick) => (
                            <span key={tick} className="h-2 w-px bg-text-2/70" />
                          ))}
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs text-text-2">Duration</span>
                        <SpeedValueBox
                          value={clipDurationSec}
                          suffix="s"
                          min={clipSourceSpanSec / 4}
                          max={clipSourceSpanSec / 0.1}
                          step={0.1}
                          onChange={setStandardDuration}
                        />
                      </div>
                      <div className="relative mr-[120px] h-4">
                        <div className="absolute left-0 right-3 top-1/2 h-px -translate-y-1/2 border-t border-dashed border-text-3/50" />
                        <div className="absolute right-1 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[5px] border-l-[7px] border-y-transparent border-l-text-3/60" />
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-2">Change audio pitch</span>
                      <SwitchToggle checked={changePitch} onChange={setChangePitch} />
                    </div>

                    <div className="flex items-center gap-2 text-2xs text-text-3/60">
                      <span className="h-3 w-3 rounded bg-bg-2 opacity-50" />
                      <span>Smooth slow-mo</span>
                      <span className="text-accent/60">◆</span>
                      <span>Only slow-speed videos are supported.</span>
                      <span>⌄</span>
                    </div>
                  </>
                ) : (
                  <div className="rounded bg-bg-2 p-3 text-2xs leading-5 text-text-3">
                    {speedMode === 'curve'
                      ? 'Curve speed presets will plug into the keyframe speed engine later. Standard speed is ready now.'
                      : 'Velocity effects are a visual preset layer for speed ramps. Standard speed is ready now.'}
                  </div>
                )}
              </div>
            )}

            {active === 'adjust' && (
              <>
                <SliderNum
                  label="Brightness"
                  value={clip.adjust.brightness}
                  min={-100}
                  max={100}
                  onScrubStart={beginHistoryStep}
                  onChange={(v) => setClipsAdjust(fanout(mediaVisualIds), { brightness: v })}
                />
                <SliderNum
                  label="Contrast"
                  value={clip.adjust.contrast}
                  min={-100}
                  max={100}
                  onScrubStart={beginHistoryStep}
                  onChange={(v) => setClipsAdjust(fanout(mediaVisualIds), { contrast: v })}
                />
                <SliderNum
                  label="Saturation"
                  value={clip.adjust.saturation}
                  min={-100}
                  max={100}
                  onScrubStart={beginHistoryStep}
                  onChange={(v) => setClipsAdjust(fanout(mediaVisualIds), { saturation: v })}
                />
                <button
                  onClick={() => {
                    beginHistoryStep()
                    setClipsAdjust(fanout(mediaVisualIds), { brightness: 0, contrast: 0, saturation: 0 })
                  }}
                  className="mt-2 w-full rounded bg-bg-2 py-1.5 text-xs text-text-2 hover:bg-bg-3"
                >
                  Reset
                </button>
              </>
            )}

            {active === 'animation' && (
              <div className="space-y-3">
                <div className="rounded bg-bg-2 p-2 text-2xs leading-4 text-text-3">
                  Motion effects are rendered in preview and export. They animate across the whole clip.
                </div>

                {ZOOM_EFFECT_TYPES.map((type) => {
                  const effect = (clip.effects ?? []).find((candidate) => candidate.type === type)
                  const Icon = EFFECT_ICON[type]
                  const disabled = selectedVisualClipIds.length === 0
                  return (
                    <div key={type} className="rounded border border-border bg-bg-1 p-2">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="grid h-7 w-7 place-items-center rounded bg-accent/15 text-accent">
                          <Icon size={15} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-text-1">{EFFECT_LABEL[type]}</p>
                          <p className="text-2xs text-text-3">{EFFECT_HINT[type]}</p>
                        </div>
                        {effect ? (
                          <button
                            type="button"
                            onClick={() => removeClipEffect(clip.id, effect.id)}
                            className="grid h-7 w-7 place-items-center rounded text-text-3 hover:bg-bg-3 hover:text-danger"
                            title="Remove effect"
                            aria-label="Remove effect"
                          >
                            <Trash2 size={14} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => applyClipEffect(selectedVisualClipIds, type)}
                            disabled={disabled}
                            className="rounded bg-bg-2 px-2 py-1 text-2xs text-text-1 hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            Apply
                          </button>
                        )}
                      </div>

                      {effect && (
                        <SliderNum
                          label="Amount"
                          value={Math.round(getEffectAmount(effect) * 100)}
                          min={5}
                          max={80}
                          format={(v) => `${v}%`}
                          onScrubStart={beginHistoryStep}
                          onChange={(v) => updateClipEffect(clip.id, effect.id, { amount: v / 100 })}
                        />
                      )}
                    </div>
                  )
                })}

                {selectedVisualClipIds.length === 0 && (
                  <p className="text-center text-2xs text-text-3">
                    Select a video, image, or text clip to apply zoom effects.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
