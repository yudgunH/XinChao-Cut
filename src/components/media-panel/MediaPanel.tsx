import { useEffect, useRef, useState } from 'react'
import {
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Sticker,
  Trash2,
  Type,
  Upload,
} from 'lucide-react'

import {
  EFFECT_LABEL,
  ZOOM_EFFECT_TYPES,
  FADE_EFFECT_TYPES,
  FILTER_PRESETS,
  clipEffectiveDuration,
  type ClipEffectType,
} from '@engine/timeline'
import { beginDesktopAssetPointerDrag } from '@engine/timeline/desktop-asset-drag'
import { formatTimecode } from '@engine/core/time'
import { useUIStore } from '@store/ui-store'
import { usePlaybackStore } from '@store/playback-store'
import { useProjectStore } from '@store/project-store'
import { useTimelineStore } from '@store/timeline-store'
import { removeAudioLibraryAssetSafely } from '@lib/audio-library-delete'
import { useAudioLibraryImport, useDesktopMediaImport, useMediaImport } from '@hooks/useMediaImport'
import type { MediaKind } from '@engine/media'
import { isTauri, mediaManager, type MediaAsset } from '@engine/media'

import { DropZone } from './DropZone'
import { MediaGrid } from './MediaGrid'
import { CaptionsPanel } from './CaptionsPanel'
import { VoicePanel } from './VoicePanel'
import { EffectPreviewTile } from './EffectPreviewTile'

const AUDIO_FAVORITES_KEY = 'xinchao-cut.audio-library.favorites'

function fmtDuration(sec: number): string {
  const timecode = formatTimecode(sec || 0, 30)
  const [, mm, ss] = timecode.split(':')
  return `${mm ?? '00'}:${ss ?? '00'}`
}

function audioMeta(asset: MediaAsset): { title: string; artist: string } {
  const clean = asset.name.replace(/\.[^.]+$/, '')
  const parts = clean.split(/\s+-\s+/)
  if (parts.length >= 2) {
    return { artist: parts[0] || 'Local Library', title: parts.slice(1).join(' - ') || clean }
  }
  return { title: clean || asset.name, artist: 'Local Library' }
}

function albumGradient(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return `linear-gradient(135deg, hsl(${hue} 76% 54%), hsl(${(hue + 48) % 360} 70% 42%) 48%, hsl(${(hue + 205) % 360} 82% 30%))`
}

function loadFavoriteIds(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(AUDIO_FAVORITES_KEY) || '[]') as string[]
  } catch {
    return []
  }
}

function saveFavoriteIds(ids: string[]): void {
  try {
    window.localStorage.setItem(AUDIO_FAVORITES_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="grid place-items-center py-12 text-xs text-text-3">{label} (coming soon)</div>
  )
}

function CompactImport({
  accept = 'video/*,audio/*,image/*',
  kind,
  label = 'Import media',
}: {
  accept?: string
  kind?: MediaKind
  label?: string
}) {
  const importFiles = useMediaImport()
  const desktopImport = useDesktopMediaImport(kind)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        onClick={() => (desktopImport ? void desktopImport() : inputRef.current?.click())}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded border border-border-strong bg-bg-2/40 py-2 text-xs text-text-2 hover:bg-bg-2 hover:text-text-1"
      >
        <Plus size={14} />
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
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

function AudioTab() {
  const importAudio = useAudioLibraryImport()
  const projectAssets = useProjectStore((s) => s.assets)
  const addProjectAsset = useProjectStore((s) => s.addAsset)
  const removeAsset = useProjectStore((s) => s.removeAsset)
  const insertAudioClips = useTimelineStore((s) => s.insertAudioClips)
  const inputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<InstanceType<typeof window.Audio> | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const previewGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const [libraryAssets, setLibraryAssets] = useState<MediaAsset[]>([])
  const [query, setQuery] = useState('')
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [loadingPreviewId, setLoadingPreviewId] = useState<string | null>(null)
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => loadFavoriteIds())

  useEffect(() => {
    mountedRef.current = true
    const generationRef = previewGenerationRef
    let cancelled = false
    mediaManager.listAudioLibrary().then((assets) => {
      if (!cancelled) setLibraryAssets(assets)
    })
    return () => {
      cancelled = true
      mountedRef.current = false
      generationRef.current++
      audioRef.current?.pause()
      audioRef.current = null
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
  }, [])

  const favoriteSet = new Set(favoriteIds)
  const filteredAssets = libraryAssets.filter((asset) => {
    const { title, artist } = audioMeta(asset)
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    return [title, artist, asset.name].some((value) => value.toLowerCase().includes(needle))
  })

  async function onPick(files: File[]) {
    const imported = await importAudio(files)
    if (imported.length) setLibraryAssets((current) => [...imported, ...current])
  }

  function ensureProjectCanUseAsset(asset: MediaAsset) {
    if (!projectAssets.some((candidate) => candidate.id === asset.id)) addProjectAsset(asset)
  }

  function addToTimeline(asset: MediaAsset) {
    ensureProjectCanUseAsset(asset)
    const { timeline } = useTimelineStore.getState()
    const kindOf = (trackId: string) => timeline.tracks.find((track) => track.id === trackId)?.kind
    const startSec = timeline.clips
      .filter((clip) => kindOf(clip.trackId) === 'audio')
      .reduce((max, clip) => Math.max(max, clip.startSec + clipEffectiveDuration(clip)), 0)
    insertAudioClips([
      { assetId: asset.id, startSec, durationSec: Math.max(0.1, asset.durationSec || 5) },
    ])
  }

  async function togglePreview(asset: MediaAsset) {
    if (previewingId === asset.id) {
      previewGenerationRef.current++
      audioRef.current?.pause()
      audioRef.current = null
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
      setPreviewingId(null)
      setLoadingPreviewId(null)
      return
    }

    const generation = ++previewGenerationRef.current
    audioRef.current?.pause()
    audioRef.current = null
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = null

    setLoadingPreviewId(asset.id)
    const url = await mediaManager.getObjectUrl(asset.id)
    if (!mountedRef.current || generation !== previewGenerationRef.current) {
      if (url) URL.revokeObjectURL(url)
      return
    }
    if (!url) {
      if (generation === previewGenerationRef.current) setLoadingPreviewId(null)
      return
    }

    objectUrlRef.current = url
    const audio = new window.Audio(url)
    audioRef.current = audio
    audio.addEventListener('ended', () => {
      if (mountedRef.current && generation === previewGenerationRef.current) {
        if (audioRef.current === audio) audioRef.current = null
        if (objectUrlRef.current === url) objectUrlRef.current = null
        URL.revokeObjectURL(url)
        setPreviewingId(null)
      }
    }, { once: true })
    audio.addEventListener('error', () => {
      if (mountedRef.current && generation === previewGenerationRef.current) {
        if (audioRef.current === audio) audioRef.current = null
        if (objectUrlRef.current === url) objectUrlRef.current = null
        URL.revokeObjectURL(url)
        setPreviewingId(null)
        setLoadingPreviewId(null)
      }
    }, { once: true })
    try {
      await audio.play()
      if (!mountedRef.current || generation !== previewGenerationRef.current) {
        audio.pause()
        if (objectUrlRef.current === url) objectUrlRef.current = null
        URL.revokeObjectURL(url)
        return
      }
      setPreviewingId(asset.id)
    } catch {
      if (mountedRef.current && generation === previewGenerationRef.current) {
        if (audioRef.current === audio) audioRef.current = null
        if (objectUrlRef.current === url) objectUrlRef.current = null
        URL.revokeObjectURL(url)
        setPreviewingId(null)
      }
    } finally {
      if (mountedRef.current && generation === previewGenerationRef.current) {
        setLoadingPreviewId(null)
      }
    }
  }

  function toggleFavorite(id: string) {
    setFavoriteIds((current) => {
      const next = current.includes(id)
        ? current.filter((favoriteId) => favoriteId !== id)
        : [id, ...current]
      saveFavoriteIds(next)
      return next
    })
  }

  async function removeFromLibrary(id: string) {
    if (previewingId === id || loadingPreviewId === id) {
      audioRef.current?.pause()
      setPreviewingId(null)
      setLoadingPreviewId(null)
    }
    await removeAudioLibraryAssetSafely(id)
    removeAsset(id)
    setLibraryAssets((current) => current.filter((asset) => asset.id !== id))
    setFavoriteIds((current) => {
      const next = current.filter((favoriteId) => favoriteId !== id)
      saveFavoriteIds(next)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1f1f1f] p-3">
      <div className="mb-3 flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded border border-[#3b3b3b] bg-[#1a1a1a] px-2.5 py-1.5 text-xs text-text-3">
          <Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="People are searching remix"
            className="min-w-0 flex-1 bg-transparent text-xs text-text-1 outline-none placeholder:text-text-3"
          />
        </label>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="grid h-8 w-8 shrink-0 place-items-center rounded text-text-2 hover:bg-bg-2 hover:text-text-1"
          title="Import audio to library"
          aria-label="Import audio to library"
        >
          <Upload size={15} />
        </button>
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center rounded text-text-2 hover:bg-bg-2 hover:text-text-1"
          title="Filters"
          aria-label="Filters"
        >
          <SlidersHorizontal size={15} />
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void onPick(files)
          e.target.value = ''
        }}
      />
      <div className="mb-2 text-xs font-medium text-text-1">Hot Bgm</div>

      {filteredAssets.length === 0 ? (
        <div className="grid flex-1 place-items-center rounded bg-[#282828] px-4 text-center text-xs text-text-3">
          {libraryAssets.length === 0 ? 'Add audio files to build your music library' : 'No music matches your search'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1">
          {filteredAssets.map((asset) => {
            const { title, artist } = audioMeta(asset)
            const isPlaying = previewingId === asset.id
            const isLoading = loadingPreviewId === asset.id
            const isFavorite = favoriteSet.has(asset.id)
            return (
              <div
                key={asset.id}
                data-media-asset-id={asset.id}
                draggable={!isTauri()}
                onDragStart={(e) => {
                  ensureProjectCanUseAsset(asset)
                  e.dataTransfer.setData('application/x-xinchao-asset-id', asset.id)
                }}
                onPointerDown={(e) => {
                  if (!isTauri()) return
                  ensureProjectCanUseAsset(asset)
                  beginDesktopAssetPointerDrag(e.nativeEvent, [asset.id])
                }}
                className="group flex min-h-[46px] items-center gap-2 rounded-md bg-[#3a3a3a] p-2 shadow-sm ring-1 ring-transparent hover:bg-[#454545] hover:ring-[#555]"
              >
                <button
                  type="button"
                  onClick={() => void togglePreview(asset)}
                  className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md text-white shadow-inner"
                  style={{ background: albumGradient(asset.id) }}
                  title={isPlaying ? 'Pause preview' : 'Preview'}
                  aria-label={isPlaying ? 'Pause preview' : 'Preview'}
                >
                  <span className="absolute inset-0 bg-black/5" />
                  {isLoading ? (
                    <Loader2 size={16} className="relative animate-spin" />
                  ) : isPlaying ? (
                    <Pause size={16} className="relative drop-shadow" />
                  ) : (
                    <Play size={16} className="relative ml-0.5 drop-shadow" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-text-1" title={title}>
                    {title}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] text-text-3">
                    <span className="truncate">{artist}</span>
                    <span className="shrink-0">· {fmtDuration(asset.durationSec)}</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => toggleFavorite(asset.id)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#232323] text-text-2 hover:text-text-1"
                  title={isFavorite ? 'Remove favorite' : 'Favorite'}
                  aria-label={isFavorite ? 'Remove favorite' : 'Favorite'}
                >
                  <Star
                    size={14}
                    className={isFavorite ? 'fill-accent text-accent' : ''}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => addToTimeline(asset)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#232323] text-text-2 hover:bg-accent hover:text-black"
                  title="Add to timeline"
                  aria-label="Add to timeline"
                >
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => void removeFromLibrary(asset.id)}
                  className="hidden h-7 w-7 shrink-0 place-items-center rounded-full bg-[#232323] text-text-3 hover:bg-danger hover:text-white group-hover:grid"
                  title="Remove from library"
                  aria-label="Remove from library"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TextPanel() {
  const insertTextClip = useTimelineStore((s) => s.insertTextClip)

  function addText() {
    // Read playhead at click time — avoid currentSec subscription (60fps re-renders).
    insertTextClip(usePlaybackStore.getState().currentSec, 5) // 5 second default duration
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
              const id = insertTextClip(usePlaybackStore.getState().currentSec, 5)
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

  function addBlurSticker() {
    insertBlurSticker(usePlaybackStore.getState().currentSec, 5)
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

function FiltersPanel() {
  const insertFilter = useTimelineStore((s) => s.insertFilter)

  // A representative swatch per look so the tiles read at a glance.
  const SWATCH: Record<string, string> = {
    '4k': 'linear-gradient(135deg,#1e90ff,#00e5ff)',
    vivid: 'linear-gradient(135deg,#ff3b8d,#ffb300)',
    warm: 'linear-gradient(135deg,#ff8a3d,#ffd06b)',
    cool: 'linear-gradient(135deg,#3d7bff,#7be7ff)',
    cinematic: 'linear-gradient(135deg,#2b2f45,#6b5b95)',
    bw: 'linear-gradient(135deg,#111,#bbb)',
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <p className="text-xs font-medium text-text-1">Filters</p>
        <p className="mt-1 text-2xs text-text-3">
          Add a filter to the FX track for the full frame over a time range. Adjust its intensity in Properties.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {FILTER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => insertFilter(p.id, usePlaybackStore.getState().currentSec, 5)}
            className="group flex flex-col items-center gap-1.5 rounded border border-border bg-bg-2 p-1.5 text-text-2 hover:border-accent hover:text-text-1"
            title={`Add ${p.label} filter at playhead`}
          >
            <span
              className="h-12 w-full rounded ring-1 ring-white/10"
              style={{ background: SWATCH[p.id] ?? 'var(--bg-3)' }}
            />
            <span className="text-2xs font-medium">{p.label}</span>
          </button>
        ))}
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
      hint="Fade, slide, rise, or drop clips in and out. Hover to preview."
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
        <AudioTab />
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
      ) : tab === 'voice' ? (
        <VoicePanel />
      ) : tab === 'filters' ? (
        <FiltersPanel />
      ) : (
        <ComingSoon label="Filters" />
      )}
    </div>
  )
}
