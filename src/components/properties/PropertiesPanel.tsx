import { Sunrise, Sunset, Trash2, ZoomIn, ZoomOut, type LucideIcon } from 'lucide-react'
import { useRef } from 'react'

import { TEXT_PRESETS, captionClipIdsOnTrack, isCaptionClip } from '@engine/timeline'
import {
  EFFECT_LABEL,
  ZOOM_EFFECT_TYPES,
  getEffectAmount,
  type ClipEffectType,
} from '@engine/timeline'
import { useBackendCapabilities } from '@hooks/useBackendCapabilities'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useUIStore, type RightPanelTab } from '@store/ui-store'

import { VocalSeparation } from './VocalSeparation'

const TABS: { id: RightPanelTab; label: string }[] = [
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'speed', label: 'Speed' },
  { id: 'animation', label: 'Animation' },
  { id: 'adjust', label: 'Adjust' },
]

const TEXT_FONT_OPTIONS = [
  { label: 'Inter', value: 'Inter, sans-serif' },
  { label: 'Bangers Regular', value: '"Bangers", Impact, fantasy' },
  { label: 'Oswald', value: '"Oswald", Arial, Helvetica, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Arial Black', value: '"Arial Black", Gadget, sans-serif' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Trebuchet', value: '"Trebuchet MS", Helvetica, sans-serif' },
  { label: 'Courier', value: '"Courier New", Courier, monospace' },
  { label: 'Comic Sans', value: '"Comic Sans MS", "Comic Sans", cursive' },
]

const EFFECT_ICON: Record<ClipEffectType, LucideIcon> = {
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  'fade-in': Sunrise,
  'fade-out': Sunset,
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs text-text-2">{label}</p>
      {children}
    </div>
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

export function PropertiesPanel() {
  const active = useUIStore((s) => s.activeRightTab)
  const setTab = useUIStore((s) => s.setActiveRightTab)
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  const setClipSpeed = useTimelineStore((s) => s.setClipSpeed)
  const setClipOpacity = useTimelineStore((s) => s.setClipOpacity)
  const setClipCrop = useTimelineStore((s) => s.setClipCrop)
  const setClipVolume = useTimelineStore((s) => s.setClipVolume)
  const setClipDenoise = useTimelineStore((s) => s.setClipDenoise)
  const setClipText = useTimelineStore((s) => s.setClipText)
  const setClipFxData = useTimelineStore((s) => s.setClipFxData)
  const applyTextStyle = useTimelineStore((s) => s.applyTextStyle)
  const applyClipEffect = useTimelineStore((s) => s.applyClipEffect)
  const updateClipEffect = useTimelineStore((s) => s.updateClipEffect)
  const removeClipEffect = useTimelineStore((s) => s.removeClipEffect)
  const setClipAdjust = useTimelineStore((s) => s.setClipAdjust)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)
  // True while a text-content typing session is in progress (one undo step per).
  const textEditingRef = useRef(false)
  const assets = useProjectStore((s) => s.assets)
  const [backendCaps] = useBackendCapabilities()
  const canSeparate = !!backendCaps?.separate

  const clip = selectedClipIds[0] ? clips.find((c) => c.id === selectedClipIds[0]) : null
  const asset = clip?.assetId ? assets.find((a) => a.id === clip.assetId) : null
  const selectedVisualClipIds = selectedClipIds.filter((id) => {
    const candidate = clips.find((c) => c.id === id)
    const track = candidate ? tracks.find((t) => t.id === candidate.trackId) : null
    return track?.kind === 'video' || track?.kind === 'text'
  })

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
                {asset?.name ?? (clip.fxData ? 'Blur sticker' : clip.textData ? 'Text clip' : 'Clip')}
              </p>
              <p className="text-2xs text-text-3">
                {clip.fxData ? 'FX' : clip.textData ? 'Text' : (asset?.kind ?? 'Unknown')} ·{' '}
                {((clip.outPointSec - clip.inPointSec) / clip.speed).toFixed(2)}s
              </p>
            </div>

            {active === 'video' && (
              <>
                {clip.fxData ? (
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
                ) : (
                  <PropRow label="Opacity">
                    <SliderNum
                      label="Opacity"
                      value={Math.round(clip.opacity * 100)}
                      min={0}
                      max={100}
                      format={(v) => `${v}%`}
                      onScrubStart={beginHistoryStep}
                      onChange={(v) => setClipOpacity(clip.id, v / 100)}
                    />
                  </PropRow>
                )}
                {!clip.textData && clip.assetId && (() => {
                  const crop = clip.transform.crop ?? { l: 0, r: 0, t: 0, b: 0 }
                  const setEdge = (edge: 'l' | 'r' | 't' | 'b', pct: number) =>
                    setClipCrop(clip.id, { ...crop, [edge]: pct / 100 })
                  const hasCrop = crop.l > 0 || crop.r > 0 || crop.t > 0 || crop.b > 0
                  return (
                    <PropRow label="Crop">
                      <div className="space-y-1.5">
                        <SliderNum label="Left" value={Math.round(crop.l * 100)} min={0} max={45}
                          format={(v) => `${v}%`} onScrubStart={beginHistoryStep}
                          onChange={(v) => setEdge('l', v)} />
                        <SliderNum label="Right" value={Math.round(crop.r * 100)} min={0} max={45}
                          format={(v) => `${v}%`} onScrubStart={beginHistoryStep}
                          onChange={(v) => setEdge('r', v)} />
                        <SliderNum label="Top" value={Math.round(crop.t * 100)} min={0} max={45}
                          format={(v) => `${v}%`} onScrubStart={beginHistoryStep}
                          onChange={(v) => setEdge('t', v)} />
                        <SliderNum label="Bottom" value={Math.round(crop.b * 100)} min={0} max={45}
                          format={(v) => `${v}%`} onScrubStart={beginHistoryStep}
                          onChange={(v) => setEdge('b', v)} />
                        {hasCrop && (
                          <button
                            onClick={() => {
                              beginHistoryStep()
                              setClipCrop(clip.id, { l: 0, r: 0, t: 0, b: 0 })
                            }}
                            className="w-full rounded bg-bg-2 py-1 text-2xs text-text-2 hover:bg-bg-3"
                          >
                            Reset crop
                          </button>
                        )}
                      </div>
                    </PropRow>
                  )
                })()}
                {clip.textData && (
                  <>
                    <PropRow label="Text content">
                      <textarea
                        value={clip.textData.content}
                        onChange={(e) => {
                          // One undo step per typing session: push on the first
                          // keystroke after focus, not every character.
                          if (!textEditingRef.current) {
                            textEditingRef.current = true
                            beginHistoryStep()
                          }
                          setClipText(clip.id, { content: e.target.value })
                        }}
                        onBlur={() => {
                          textEditingRef.current = false
                        }}
                        className="w-full resize-none rounded bg-bg-2 p-2 text-xs text-text-1 focus:outline-none focus:ring-1 focus:ring-accent"
                        rows={2}
                      />
                    </PropRow>
                    <PropRow label="Style presets">
                      <div className="grid grid-cols-6 gap-1.5">
                        {TEXT_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            onClick={() => applyCaption(preset.style)}
                            title={preset.id}
                            className="grid aspect-square place-items-center rounded ring-1 ring-border hover:ring-accent"
                            style={{
                              background: preset.style.hasBackground
                                ? preset.style.backgroundColor
                                : 'var(--bg-2)',
                            }}
                          >
                            <span
                              className="text-xs font-bold"
                              style={{
                                color: preset.style.color,
                                WebkitTextStroke: preset.style.stroke
                                  ? `1px ${preset.style.stroke.color}`
                                  : undefined,
                              }}
                            >
                              Aa
                            </span>
                          </button>
                        ))}
                      </div>
                    </PropRow>
                    <PropRow label="Outline">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={clip.textData.stroke?.color ?? '#000000'}
                          onChange={(e) =>
                            applyCaption({
                              stroke: {
                                color: e.target.value,
                                width: clip.textData?.stroke?.width ?? 6,
                              },
                            })
                          }
                          className="h-7 w-10 cursor-pointer rounded border border-border bg-bg-2"
                        />
                        <input
                          type="range"
                          min={0}
                          max={20}
                          value={clip.textData.stroke?.width ?? 0}
                          onChange={(e) =>
                            applyCaption({
                              stroke: {
                                color: clip.textData?.stroke?.color ?? '#000000',
                                width: Number(e.target.value),
                              },
                            })
                          }
                          className="flex-1 accent-[#71717a]"
                        />
                        <span className="w-6 text-right font-mono text-text-2">
                          {clip.textData.stroke?.width ?? 0}
                        </span>
                      </div>
                    </PropRow>
                    <PropRow label="Background">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() =>
                            applyCaption({ hasBackground: !clip.textData?.hasBackground })
                          }
                          className={`rounded px-2 py-1 text-2xs ${
                            clip.textData.hasBackground
                              ? 'bg-accent text-white'
                              : 'bg-bg-2 text-text-2 hover:bg-bg-3'
                          }`}
                        >
                          {clip.textData.hasBackground ? 'On' : 'Off'}
                        </button>
                        <input
                          type="color"
                          value={clip.textData.backgroundColor}
                          onChange={(e) => applyCaption({ backgroundColor: e.target.value })}
                          disabled={!clip.textData.hasBackground}
                          className="h-7 w-10 cursor-pointer rounded border border-border bg-bg-2 disabled:opacity-40"
                        />
                      </div>
                    </PropRow>
                    <PropRow label="Font">
                      <select
                        value={clip.textData.fontFamily}
                        onChange={(e) => applyCaption({ fontFamily: e.target.value })}
                        className="w-full rounded border border-border bg-bg-2 px-2 py-1.5 text-xs text-text-1 focus:outline-none focus:ring-1 focus:ring-accent"
                        style={{ fontFamily: clip.textData.fontFamily }}
                      >
                        {!TEXT_FONT_OPTIONS.some(
                          (font) => font.value === clip.textData?.fontFamily,
                        ) && (
                          <option value={clip.textData.fontFamily}>
                            {clip.textData.fontFamily}
                          </option>
                        )}
                        {TEXT_FONT_OPTIONS.map((font) => (
                          <option
                            key={font.value}
                            value={font.value}
                            style={{ fontFamily: font.value }}
                          >
                            {font.label}
                          </option>
                        ))}
                      </select>
                    </PropRow>
                    <PropRow label="Font size">
                      <SliderNum
                        label="Size"
                        value={clip.textData.fontSize}
                        min={16}
                        max={200}
                        onChange={(v) => applyCaption({ fontSize: v })}
                      />
                    </PropRow>
                    <PropRow label="Color">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={clip.textData.color}
                          onChange={(e) => applyCaption({ color: e.target.value })}
                          className="h-7 w-10 cursor-pointer rounded border border-border bg-bg-2"
                        />
                        <span className="font-mono text-text-2">{clip.textData.color}</span>
                      </div>
                    </PropRow>
                    <PropRow label="Animation">
                      <div className="flex gap-1">
                        {(
                          [
                            { id: 'none', label: 'None' },
                            { id: 'word', label: 'Word' },
                            { id: 'group', label: '3 words' },
                          ] as const
                        ).map((a) => {
                          const current = clip.textData?.anim?.kind ?? 'none'
                          return (
                            <button
                              key={a.id}
                              onClick={() =>
                                applyCaption({
                                  anim: { kind: a.id, groupSize: a.id === 'group' ? 3 : 1 },
                                })
                              }
                              className={`flex-1 rounded py-1 text-2xs ${
                                current === a.id
                                  ? 'bg-accent text-white'
                                  : 'bg-bg-2 text-text-2 hover:bg-bg-3'
                              }`}
                            >
                              {a.label}
                            </button>
                          )
                        })}
                      </div>
                    </PropRow>
                    <PropRow label="Position Y">
                      <SliderNum
                        label="Y"
                        value={Math.round(clip.textData.y * 100)}
                        min={0}
                        max={100}
                        format={(v) => `${v}%`}
                        onChange={(v) => applyCaption({ y: v / 100 })}
                      />
                    </PropRow>
                    <PropRow label="Alignment">
                      <div className="flex gap-1">
                        {(['left', 'center', 'right'] as const).map((a) => (
                          <button
                            key={a}
                            onClick={() => applyCaption({ align: a })}
                            className={`flex-1 rounded py-1 text-xs capitalize ${
                              clip.textData?.align === a
                                ? 'bg-accent text-white'
                                : 'bg-bg-2 text-text-2 hover:bg-bg-3'
                            }`}
                          >
                            {a}
                          </button>
                        ))}
                      </div>
                    </PropRow>
                  </>
                )}
              </>
            )}

            {active === 'audio' && (
              <>
                <PropRow label="Volume">
                  <SliderNum
                    label="Volume"
                    value={Math.round(clip.volume * 100)}
                    min={0}
                    max={100}
                    format={(v) => `${v}%`}
                    onScrubStart={beginHistoryStep}
                    onChange={(v) => setClipVolume(clip.id, v / 100)}
                  />
                </PropRow>

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
              <>
                <PropRow label="Playback speed">
                  <div className="mb-2 flex flex-wrap gap-1">
                    {[0.25, 0.5, 1, 1.5, 2, 4].map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          beginHistoryStep()
                          setClipSpeed(clip.id, s)
                        }}
                        className={`rounded px-2 py-1 text-xs ${
                          clip.speed === s
                            ? 'bg-accent text-white'
                            : 'bg-bg-2 text-text-2 hover:bg-bg-3'
                        }`}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                  <SliderNum
                    label="Custom"
                    value={clip.speed}
                    min={0.1}
                    max={4}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}x`}
                    onScrubStart={beginHistoryStep}
                    onChange={(v) => setClipSpeed(clip.id, v)}
                  />
                </PropRow>
              </>
            )}

            {active === 'adjust' && (
              <>
                <SliderNum
                  label="Brightness"
                  value={clip.adjust.brightness}
                  min={-100}
                  max={100}
                  onScrubStart={beginHistoryStep}
                  onChange={(v) => setClipAdjust(clip.id, { brightness: v })}
                />
                <SliderNum
                  label="Contrast"
                  value={clip.adjust.contrast}
                  min={-100}
                  max={100}
                  onScrubStart={beginHistoryStep}
                  onChange={(v) => setClipAdjust(clip.id, { contrast: v })}
                />
                <SliderNum
                  label="Saturation"
                  value={clip.adjust.saturation}
                  min={-100}
                  max={100}
                  onScrubStart={beginHistoryStep}
                  onChange={(v) => setClipAdjust(clip.id, { saturation: v })}
                />
                <button
                  onClick={() => {
                    beginHistoryStep()
                    setClipAdjust(clip.id, { brightness: 0, contrast: 0, saturation: 0 })
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
                  Zoom effects are rendered in preview and export. They animate across the whole clip.
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
                          <p className="text-2xs text-text-3">
                            {type === 'zoom-in' ? 'Normal to closer.' : 'Closer to normal.'}
                          </p>
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
