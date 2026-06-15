import { useRef } from 'react'
import { Plus, Sticker, Type } from 'lucide-react'

import {
  EFFECT_LABEL,
  ZOOM_EFFECT_TYPES,
  FADE_EFFECT_TYPES,
  type ClipEffectType,
} from '@engine/timeline'
import { useUIStore } from '@store/ui-store'
import { usePlaybackStore } from '@store/playback-store'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { useDesktopMediaImport, useMediaImport } from '@hooks/useMediaImport'

import { DropZone } from './DropZone'
import { MediaGrid } from './MediaGrid'
import { CaptionsPanel } from './CaptionsPanel'
import { EffectPreviewTile } from './EffectPreviewTile'

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="grid place-items-center py-12 text-xs text-text-3">{label} (coming soon)</div>
  )
}

function CompactImport() {
  const importFiles = useMediaImport()
  const desktopImport = useDesktopMediaImport()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        onClick={() => (desktopImport ? void desktopImport() : inputRef.current?.click())}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded border border-border-strong bg-bg-2/40 py-2 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1"
      >
        <Plus size={14} />
        Import media
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void importFiles(files)
          e.target.value = ''
        }}
      />
    </>
  )
}

function MediaTab() {
  const hasMedia = useProjectStore((s) => s.assets.length > 0)
  return (
    <div className="flex flex-1 flex-col overflow-auto p-3">
      {hasMedia ? <CompactImport /> : <DropZone />}
      <MediaGrid />
    </div>
  )
}

function TextPanel() {
  const insertTextClip = useTimelineStore((s) => s.insertTextClip)
  const currentSec = usePlaybackStore((s) => s.currentSec)

  function addText() {
    insertTextClip(currentSec, 5) // 5 second default duration
  }

  const PRESETS = [
    { label: 'Title', fontSize: 96, y: 0.5 },
    { label: 'Subtitle', fontSize: 56, y: 0.65 },
    { label: 'Caption', fontSize: 40, y: 0.88 },
    { label: 'Lower Third', fontSize: 36, y: 0.82 },
  ]

  return (
    <div className="flex flex-col gap-3 p-3">
      <button
        onClick={addText}
        className="flex items-center justify-center gap-2 rounded bg-accent py-2 text-sm font-medium text-white hover:bg-accent-hover"
      >
        <Type size={15} />
        Add Text
      </button>

      <p className="text-2xs text-text-3">Presets</p>
      <div className="flex flex-col gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              const id = insertTextClip(currentSec, 5)
              // apply preset via store after insert
              const store = useTimelineStore.getState()
              store.setClipText(id, { fontSize: p.fontSize, y: p.y })
            }}
            className="rounded bg-bg-2 py-2 text-xs text-text-1 hover:bg-bg-3"
          >
            {p.label}
          </button>
        ))}
      </div>

      <p className="text-2xs text-text-3">
        After adding, select the clip in the timeline and edit text content in the Properties panel.
      </p>
    </div>
  )
}

function StickersPanel() {
  const insertBlurSticker = useTimelineStore((s) => s.insertBlurSticker)
  const currentSec = usePlaybackStore((s) => s.currentSec)

  function addBlurSticker() {
    insertBlurSticker(currentSec, 5)
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <button
        onClick={addBlurSticker}
        className="flex items-center justify-center gap-2 rounded bg-accent py-2 text-sm font-medium text-white hover:bg-accent-hover"
      >
        <Sticker size={15} />
        Blur sticker
      </button>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={addBlurSticker}
          className="group flex aspect-video flex-col items-center justify-center gap-2 rounded border border-border bg-bg-2 text-text-2 hover:border-accent hover:text-text-1"
          title="Add a resizable video blur patch at the playhead"
        >
          <span className="grid h-10 w-14 place-items-center rounded bg-black/60 blur-[1px] ring-1 ring-white/10">
            <Sticker size={18} className="text-accent" />
          </span>
          <span className="text-2xs font-medium">Blur</span>
        </button>
      </div>
    </div>
  )
}

/**
 * Shared grid panel for applying clip effects/transitions via hover-preview
 * tiles (react-video-editor style). `types` decides which effects show.
 */
function EffectGridPanel({
  title,
  hint,
  types,
  switchToAnimation = false,
}: {
  title: string
  hint: string
  types: ClipEffectType[]
  switchToAnimation?: boolean
}) {
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  const applyClipEffect = useTimelineStore((s) => s.applyClipEffect)
  const removeClipEffects = useTimelineStore((s) => s.removeClipEffects)
  const setActiveRightTab = useUIStore((s) => s.setActiveRightTab)

  const visualIds = selectedClipIds.filter((id) => {
    const clip = clips.find((candidate) => candidate.id === id)
    const track = clip ? tracks.find((candidate) => candidate.id === clip.trackId) : null
    return track?.kind === 'video' || track?.kind === 'text'
  })
  const visualClips = visualIds
    .map((id) => clips.find((clip) => clip.id === id))
    .filter((clip): clip is NonNullable<typeof clip> => !!clip)

  const disabled = visualIds.length === 0

  function apply(type: ClipEffectType) {
    if (disabled) return
    applyClipEffect(visualIds, type)
    if (switchToAnimation) setActiveRightTab('animation')
  }

  function remove(type: ClipEffectType) {
    if (disabled) return
    removeClipEffects(visualIds, type)
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <p className="text-xs font-medium text-text-1">{title}</p>
        <p className="mt-1 text-2xs text-text-3">{hint}</p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {types.map((type) => {
          const appliedCount = visualClips.filter((clip) =>
            (clip.effects ?? []).some((effect) => effect.type === type),
          ).length
          const isApplied = appliedCount > 0
          const allApplied = isApplied && appliedCount === visualClips.length
          return (
            <EffectPreviewTile
              key={type}
              type={type}
              label={EFFECT_LABEL[type]}
              applied={isApplied}
              appliedLabel={allApplied ? 'Applied' : `${appliedCount}/${visualClips.length}`}
              disabled={disabled}
              onApply={() => apply(type)}
              onRemove={() => remove(type)}
            />
          )
        })}
      </div>

      <p className="text-2xs text-text-3">
        {disabled
          ? 'Hover a tile to preview. Select a video, image, or text clip to apply.'
          : `Applies to ${visualIds.length} selected clip${visualIds.length > 1 ? 's' : ''}.`}
      </p>
    </div>
  )
}

function EffectsPanel() {
  return (
    <EffectGridPanel
      title="Motion effects"
      hint="Hover to preview · click a tile to apply."
      types={ZOOM_EFFECT_TYPES}
      switchToAnimation
    />
  )
}

function TransitionsPanel() {
  return (
    <EffectGridPanel
      title="Transitions"
      hint="Fade a clip in from / out to black. Hover to preview."
      types={FADE_EFFECT_TYPES}
    />
  )
}

export function MediaPanel() {
  const tab = useUIStore((s) => s.activeLeftTab)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {tab === 'media' ? (
        <MediaTab />
      ) : tab === 'audio' ? (
        <ComingSoon label="Audio library" />
      ) : tab === 'text' ? (
        <TextPanel />
      ) : tab === 'stickers' ? (
        <StickersPanel />
      ) : tab === 'effects' ? (
        <EffectsPanel />
      ) : tab === 'transitions' ? (
        <TransitionsPanel />
      ) : tab === 'captions' ? (
        <CaptionsPanel />
      ) : (
        <ComingSoon label="Filters" />
      )}
    </div>
  )
}
