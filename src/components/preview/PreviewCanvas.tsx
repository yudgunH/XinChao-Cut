import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark,
  Camera,
  Heart,
  MessageCircle,
  MoreHorizontal,
  MoreVertical,
  Music2,
  Repeat2,
  Search,
  Send,
  Share2,
  ThumbsDown,
  UserCircle,
  Youtube,
  type LucideIcon,
} from 'lucide-react'

import {
  ActiveClipIndex,
  adjustToFilter,
  canvasFilterString,
  captionClipIdsOnTrack,
  clipEffectiveDuration,
  clipIsActiveAt,
  clipSourceSec,
  isAdjustNeutral,
  isCaptionClip,
  makeDefaultTransform,
  resolvedTextWordSpacing,
  resolveClipTransformAt,
  resolveClipOpacityAt,
  type Clip,
  type ClipCanvasFill,
  type ClipTransform,
  type BlurStickerData,
  type Track,
} from '@engine/timeline'
import { measureWrappedTextCached } from '@engine/timeline/text-layout'
import { drawTextClip, textAxisScale, TEXT_MAX_WIDTH_RATIO } from '@engine/timeline/draw-caption'
import { BLUR_REF_HEIGHT } from '@engine/timeline/types'
import { getFxBuffer, releaseFxBuffers } from '@engine/composition/fx-buffer'
import {
  buildRenderPlan,
  getExportMediaRect,
  resolveRenderPlanDraws,
  type RenderPlanSourceInfo,
} from '@engine/composition/render-plan'
import { audioEngine } from '@engine/audio'
import { registerCaptionFontFaces } from '@engine/text/font-catalog'

import { isAudioCapableProxyKey, mediaManager, type MediaAsset } from '@engine/media'
import { GpuCompositor } from '@engine/preview/gpu-compositor'
import { useProjectStore } from '@store/project-store'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'

import {
  decidePreviewUrlResolve,
  makePreviewLoadToken,
  previewIdsToDispose,
} from './preview-media-lifecycle'
import {
  buildPreviewPlaybackKeyMap,
  PreviewVideoPool,
  sourceMappingKey,
} from './preview-video-pool'
import { createPreviewRenderScheduler } from './preview-render-scheduler'
import { decideVideoSync, leadCompensatedSeekTarget } from './video-sync'

// Dense timelines contain short, non-contiguous cuts of the same
// asset (each highlight has its own source in-point → its own mapping key), so
// a single warmed mapping isn't enough: a sub-2s clip becomes active before the
// next-but-one cut has had time to seek, and it stalls. Warm the next couple of
// distinct cuts within a slightly longer window. Still far under the pool's
// active decoder cap (DEFAULT_MAX_ACTIVE_PREVIEW_VIDEOS), so no placeholder path.
const PREVIEW_WARM_AHEAD_SEC = 3
// Speed-adjusted timelines can cut every 1–3s with a distinct mapping per span, so
// two warm slots could leave a third upcoming cut cold inside the 3s horizon.
const MAX_PREWARM_VIDEO_MAPPINGS = 3

const COMP_H = 720 // composition height; width derived from aspect
const SNAP_THRESHOLD_PX = 10
const HANDLE_HIT_PX = 12
const MIN_MEDIA_SCALE = 0.05
const MAX_MEDIA_SCALE = 8
const MIN_AXIS_SCALE = 0.05
const MAX_AXIS_SCALE = 20
const MIN_TEXT_FONT_SIZE = 12
const MAX_TEXT_FONT_SIZE = 320

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface HitResult {
  clip: Clip
  kind: 'media' | 'text' | 'fx'
  rect: Rect
  handle?: SelectionHandle
}

type SelectionHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type PlatformFrame = 'none' | 'tiktok' | 'shorts' | 'reels'

interface SnapGuide {
  axis: 'x' | 'y'
  pos: number
}

interface DragState {
  clipId: string
  kind: 'media' | 'text' | 'fx'
  mode: 'move' | 'resize'
  /** When the dragged clip is a caption: all caption ids, so position/size
   *  edits to one caption apply to every caption (they stay aligned). */
  captionIds?: string[]
  offsetX?: number
  offsetY?: number
  handle?: SelectionHandle
  startAnchor?: {
    x: number
    y: number
  }
  startRect?: Rect
  startTransform?: ClipTransform
  startText?: {
    x: number
    y: number
    fontSize: number
    align: 'left' | 'center' | 'right'
  }
  startFx?: BlurStickerData
}

interface ClickCycleState {
  x: number
  y: number
  signature: string
  nextIndex: number
}

export function PreviewCanvas({ platformFrame = 'none' }: { platformFrame?: PlatformFrame }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasBox, setCanvasBox] = useState<Rect | null>(null)
  // Selection overlay rect, kept in React state and refreshed via recomputeOverlay
  // (below) rather than recomputed in the render body every tick.
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null)
  // Bumped to re-run the media-load effect after a recoverable <video> error,
  // so a transiently-failed element gets rebuilt without an asset change.
  const [reloadNonce, setReloadNonce] = useState(0)

  // Reactive bits used only for canvas sizing + empty-state hint.
  // NOTE: currentSec / isPlaying are deliberately NOT selected here — subscribing
  // to them would re-render this whole component on every RAF tick (~60×/s during
  // playback). Instead an effect below subscribes to the playback store directly
  // and repaints via renderFrame() (which reads fresh state via getState()).
  const aspect = useProjectStore((s) => s.aspect)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  // Compound registry: changes here (e.g. editing a compound's contents) must
  // re-pool the media used inside compounds.
  const compounds = useTimelineStore((s) => s.compounds)
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const selectClips = useTimelineStore((s) => s.selectClips)
  const setClipText = useTimelineStore((s) => s.setClipText)
  const setClipsText = useTimelineStore((s) => s.setClipsText)
  const setClipFxData = useTimelineStore((s) => s.setClipFxData)
  const setClipTransformKeyed = useTimelineStore((s) => s.setClipTransformKeyed)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)
  const assets = useProjectStore((s) => s.assets)
  const imageAssetIds = useMemo(
    () => new Set(assets.filter((asset) => asset.kind === 'image').map((asset) => asset.id)),
    [assets],
  )
  const imageAssetIdsRef = useRef(imageAssetIds)
  imageAssetIdsRef.current = imageAssetIds

  const FRAME_H = COMP_H
  const FRAME_W = Math.round((COMP_H * aspect.w) / aspect.h)
  const CANVAS_H = FRAME_H
  const CANVAS_W = FRAME_W

  /** Blob / path object URLs — shared per assetId (many mapping instances). */
  const urlCache = useRef<Map<string, string>>(new Map())
  /** Playback instances keyed by source-time mapping (the export-parity path). */
  const videoPool = useRef(new PreviewVideoPool())
  const imagePool = useRef<Map<string, HTMLImageElement>>(new Map())
  // Which OPFS key (original or proxy) each *asset's* URL was built from — so
  // we can rebuild URLs when a proxy becomes available / is removed.
  const videoSrcKey = useRef<Map<string, string>>(new Map())
  // Per-instance "decoded frame" counter (keyed by mapping key).
  const videoEpoch = useRef<Map<string, number>>(new Map())
  // Occurrence cache keys can be reused by a different playback mapping after
  // a cut. Fold a stable numeric mapping identity into frameVersion so equal
  // currentTime/epoch values still force the new source texture to upload.
  const videoTextureIdentity = useRef<Map<string, number>>(new Map())
  // A continuous mapping key spans multiple timeline clips. Track which logical
  // clip is currently painting so a boundary always invalidates the GPU copy,
  // even when the decoder's VFC callback is late.
  const videoTextureClipId = useRef<Map<string, string>>(new Map())
  const nextVideoTextureIdentity = useRef(1)
  // Some WebView decoders leave a seek/load pending without delivering the
  // completion event. Keep the last recovery timestamp so one bad wait cannot
  // freeze the canvas.
  const videoSeekStartedAt = useRef<Map<string, number>>(new Map())
  const videoSeekRecoveredAt = useRef<Map<string, number>>(new Map())
  // Consecutive recovery attempts per instance — drives exponential backoff so
  // the unwedge hammer can't re-load() a slow-but-progressing element forever.
  const videoSeekRecoveryCount = useRef<Map<string, number>>(new Map())
  // When the current in-flight seek was issued (per instance) — measures the
  // real seek latency so hard seeks while playing can aim at where the
  // transport WILL be when the seek lands (see leadCompensatedSeekTarget).
  const videoSeekIssuedAt = useRef<Map<string, number>>(new Map())
  // Smoothed per-instance seek latency in seconds (EMA of measured seeks).
  const videoSeekEtaSec = useRef<Map<string, number>>(new Map())
  // True once a full composite has been painted; lets renderFrame keep the last
  // frame on screen while an active element is mid-seek instead of clearing to
  // black + "Loading video frame" placeholders at every cut.
  const hasPaintedRef = useRef(false)
  // Latest PRESENTED frame per playback instance (mapping key).
  const videoFrameCache = useRef<Map<string, VideoFrame>>(new Map())
  // Assets whose *URL* is currently being loaded (async).
  const loadingIds = useRef<Set<string>>(new Set())
  // Per-instance count of consecutive <video> load failures.
  const videoErrors = useRef<Map<string, number>>(new Map())
  // Per-asset load token (assetId::desiredKey) for URL resolve commit gates.
  const loadTokens = useRef<Map<string, string>>(new Map())
  /** Active mapping keys that could not get a private <video> (intentional degrade). */
  const [decoderWarn, setDecoderWarn] = useState<string | null>(null)
  const decoderWarnRef = useRef<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  // Whether the current drag has already pushed its single undo checkpoint.
  const dragHistoryPushedRef = useRef(false)
  const snapGuidesRef = useRef<SnapGuide[]>([])
  const frameRectRef = useRef<Rect>({ x: 0, y: 0, w: FRAME_W, h: FRAME_H })
  const clickCycleRef = useRef<ClickCycleState | null>(null)
  // Cache for per-frame lookups (assetById, track-kind sets, trackById). Rebuilt
  // only when clips/tracks/assets references change; no-op every tick during play.
  const lookupsRef = useRef<{
    clips: Clip[]
    tracks: Track[]
    assetsRef: MediaAsset[]
    built: PreviewLookups
  } | null>(null)
  /** Preview decoder key for a clip: the chain key when the clip belongs to a
   *  source-continuous same-asset run (one element plays the
   *  whole run with zero mid-run seeks), else the affine sourceMappingKey.
   *  renderFrame rebuilds lookupsRef before use; other call sites (audio bind,
   *  hit-testing) may read one frame stale after an edit — they fall back
   *  consistently on the next paint. */
  const previewPlaybackKey = useCallback(
    (clip: Clip) =>
      lookupsRef.current?.built.videoPlaybackKeyByClipId.get(clip.id) ?? sourceMappingKey(clip),
    [],
  )
  // S6: temporal index rebuilt only when flat clips/tracks references change.
  const activeIndexRef = useRef<ActiveClipIndex | null>(null)
  // WebGPU compositor for the media layer (video/image + colour adjust + zoom).
  // Created lazily; null + state 'failed' means we use the Canvas-2D fallback.
  const gpuRef = useRef<GpuCompositor | null>(null)
  const gpuStateRef = useRef<'idle' | 'init' | 'ready' | 'failed'>('idle')
  const imageHorizonSignatureRef = useRef('')
  const renderFrameRef = useRef<() => void>(() => {})
  const renderSchedulerRef = useRef<ReturnType<typeof createPreviewRenderScheduler> | null>(null)
  if (!renderSchedulerRef.current) {
    renderSchedulerRef.current = createPreviewRenderScheduler(() => renderFrameRef.current())
  }
  const scheduleRender = useCallback(() => renderSchedulerRef.current?.schedule(), [])
  frameRectRef.current = { x: 0, y: 0, w: FRAME_W, h: FRAME_H }

  /** Dispose one playback *instance* (mapping key) — not an asset URL.
   *  `reason` decides the fate of the decode-retry counter:
   *   - 'retry'   : onError rebuilds the instance — KEEP the count so the `n > 3`
   *                 cap can trip (else a bad decode reloads forever).
   *   - 'removed' : the clip left the working set / undo / unmount — CLEAR it so a
   *                 later re-add of the same key starts fresh instead of staying
   *                 permanently degraded (#11). Default. */
  const disposeInstance = useCallback(
    (instanceKey: string, reason: 'retry' | 'removed' = 'removed') => {
      audioEngine.releaseVideoAudio(instanceKey)
      videoPool.current.disposeKey(instanceKey)
      videoEpoch.current.delete(instanceKey)
      videoTextureIdentity.current.delete(instanceKey)
      videoTextureClipId.current.delete(instanceKey)
      videoSeekStartedAt.current.delete(instanceKey)
      videoSeekRecoveredAt.current.delete(instanceKey)
      videoSeekRecoveryCount.current.delete(instanceKey)
      videoSeekIssuedAt.current.delete(instanceKey)
      videoSeekEtaSec.current.delete(instanceKey)
      if (reason !== 'retry') videoErrors.current.delete(instanceKey)
      const cached = videoFrameCache.current.get(instanceKey)
      if (cached) {
        try {
          cached.close()
        } catch {
          /* already closed */
        }
      }
      videoFrameCache.current.delete(instanceKey)
      gpuRef.current?.evictTexture(instanceKey)
    },
    [],
  )

  /**
   * Dispose everything for an asset id: image pool, shared URL, and all video
   * instances that play that asset. Clears load tokens so the asset can reload.
   */
  const disposeAsset = useCallback((assetId: string) => {
    imagePool.current.delete(assetId)
    loadingIds.current.delete(assetId)
    videoSrcKey.current.delete(assetId)
    loadTokens.current.delete(assetId)
    for (const key of videoPool.current.disposeAsset(assetId)) {
      // disposeAsset already dropped the element; finish instance-side caches.
      audioEngine.releaseVideoAudio(key)
      videoEpoch.current.delete(key)
      videoTextureIdentity.current.delete(key)
      videoTextureClipId.current.delete(key)
      videoSeekStartedAt.current.delete(key)
      videoSeekRecoveredAt.current.delete(key)
      videoSeekRecoveryCount.current.delete(key)
      videoSeekIssuedAt.current.delete(key)
      videoSeekEtaSec.current.delete(key)
      videoErrors.current.delete(key)
      const cached = videoFrameCache.current.get(key)
      if (cached) {
        try {
          cached.close()
        } catch {
          /* already closed */
        }
      }
      videoFrameCache.current.delete(key)
      gpuRef.current?.evictTexture(key)
    }
    const url = urlCache.current.get(assetId)
    if (url) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
    }
    urlCache.current.delete(assetId)
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const rootEl = root
    const canvasEl = canvas

    function measure() {
      const rootRect = rootEl.getBoundingClientRect()
      const canvasRect = canvasEl.getBoundingClientRect()
      setCanvasBox({
        x: canvasRect.left - rootRect.left,
        y: canvasRect.top - rootRect.top,
        w: canvasRect.width,
        h: canvasRect.height,
      })
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(rootEl)
    ro.observe(canvasEl)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [CANVAS_W, CANVAS_H])

  // Self-contained frame renderer. Reads fresh state from the stores so it can
  // be invoked from React effects AND from media element events (seeked / loaded)
  // — the latter is what makes a paused frame reappear after a seek settles.
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const stageW = canvas.width
    const stageH = canvas.height
    const frame = frameRectRef.current
    const W = frame.w
    const H = frame.h
    const playing = usePlaybackStore.getState().isPlaying
    const at = usePlaybackStore.getState().currentSec
    // Flattened: compound clips are expanded into their contents so they render.
    const timeline = useTimelineStore.getState().flatTimeline()
    const allAssets = useProjectStore.getState().assets
    const { clips: allClips, tracks: allTracks } = timeline

    // Build per-frame lookups once and cache by reference: rebuilt only when
    // clips/tracks/assets change (immutable replacements on every edit), so
    // during playback (no edits) this is a pure cache hit — no allocations.
    let lk = lookupsRef.current
    if (!lk || lk.clips !== allClips || lk.tracks !== allTracks || lk.assetsRef !== allAssets) {
      const built = buildPreviewLookups(allClips, allTracks, allAssets)
      lk = {
        clips: allClips,
        tracks: allTracks,
        assetsRef: allAssets,
        built,
      }
      lookupsRef.current = lk
    }
    const { assetById, trackById } = lk.built

    // S6: O(bucket) active lookup instead of O(N) filter per frame.
    let activeIdx = activeIndexRef.current
    if (!activeIdx || !activeIdx.matches(allClips, allTracks)) {
      activeIdx = ActiveClipIndex.build(allClips, allTracks)
      activeIndexRef.current = activeIdx
    }
    const activeVideo = activeIdx.queryAt('video', at)

    // ── Pre-pass: drive each *source-time mapping* so
    // overlapping same-asset clips with different in-points keep independent
    // currentTime — matching export's reader-pool. Shared mapping keys share one
    // element (identical source time at any timeline t).
    const activeMapKeys = new Set<string>()
    const drivenKeys = new Set<string>()
    for (const clip of activeVideo) {
      if (!clip.assetId || assetById.get(clip.assetId)?.kind !== 'video') continue
      const k = previewPlaybackKey(clip)
      if (k) activeMapKeys.add(k)
    }
    // Prepare the next cut before the playhead reaches it. One bounded warm
    // mapping is enough for sequential edits and avoids the old behaviour of
    // accumulating many resident hardware decoders.
    const warmClips = activeIdx
      .queryStartingBetween('video', at, at + PREVIEW_WARM_AHEAD_SEC, 8)
      .filter((clip) => {
        const key = previewPlaybackKey(clip)
        return !!key && !activeMapKeys.has(key)
      })
    const warmMapKeys = new Set<string>()
    const warmByKey = new Map<string, Clip>()
    for (const clip of warmClips) {
      const key = previewPlaybackKey(clip)
      if (!key || warmMapKeys.has(key)) continue
      warmMapKeys.add(key)
      warmByKey.set(key, clip)
      if (warmMapKeys.size >= MAX_PREWARM_VIDEO_MAPPINGS) break
    }
    const residentMapKeys = new Set([...activeMapKeys, ...warmMapKeys])
    const poolHooks = {
      onFrame: (instanceKey: string) => {
        videoErrors.current.delete(instanceKey)
        videoEpoch.current.set(instanceKey, (videoEpoch.current.get(instanceKey) ?? 0) + 1)
        // Capture durable VideoFrame while paused (GPU path).
        if (!usePlaybackStore.getState().isPlaying) {
          const el = videoPool.current.get(instanceKey)
          if (el && el.readyState >= 2) {
            try {
              const vf = new VideoFrame(el)
              videoFrameCache.current.get(instanceKey)?.close()
              videoFrameCache.current.set(instanceKey, vf)
            } catch {
              /* element not presenting */
            }
          }
        }
        // Soft repaint — avoid calling renderFrame recursively mid-pass.
        scheduleRender()
      },
      onError: (instanceKey: string) => {
        const n = (videoErrors.current.get(instanceKey) ?? 0) + 1
        console.warn(`[preview] video instance failed (attempt ${n}):`, instanceKey)
        videoErrors.current.set(instanceKey, n)
        disposeInstance(instanceKey, 'retry') // keep the counter across rebuild
        setReloadNonce((v) => v + 1)
      },
      onReassign: (oldKey: string) => {
        // The element survives the hand-off, but mapping-keyed side resources
        // from its previous owner must not leak into the next clip.
        audioEngine.releaseVideoAudio(oldKey)
        videoEpoch.current.delete(oldKey)
        videoTextureIdentity.current.delete(oldKey)
        videoTextureClipId.current.delete(oldKey)
        videoSeekStartedAt.current.delete(oldKey)
        videoSeekRecoveredAt.current.delete(oldKey)
        videoSeekRecoveryCount.current.delete(oldKey)
        videoSeekIssuedAt.current.delete(oldKey)
        // Seek latency is a property of the SOURCE, not the mapping — keep the
        // learned ETA out of the transfer (new key starts from the default).
        videoSeekEtaSec.current.delete(oldKey)
        videoErrors.current.delete(oldKey)
        const cached = videoFrameCache.current.get(oldKey)
        if (cached) {
          try {
            cached.close()
          } catch {
            /* already closed */
          }
        }
        videoFrameCache.current.delete(oldKey)
        gpuRef.current?.evictTexture(oldKey)
      },
    }

    let allVideoReady = true
    let missingDecoder = 0
    for (const clip of activeVideo) {
      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
      if (!asset || asset.kind !== 'video') continue
      const mapKey = previewPlaybackKey(clip)
      if (!mapKey) continue
      const url = urlCache.current.get(asset.id)
      if (!url) {
        allVideoReady = false
        continue
      }
      // A mapping that exhausted its retry budget stays on the explicit
      // placeholder path until a frame succeeds or the asset/source is rebuilt.
      // Do not keep touching the failed element or recreating it every frame.
      if ((videoErrors.current.get(mapKey) ?? 0) > 3) {
        missingDecoder += 1
        allVideoReady = false
        continue
      }
      // Protected active set may exceed idle cap; each key gets its OWN element
      // (never a sibling mapping — that reused currentTime and wrong frames).
      const el = videoPool.current.acquire(mapKey, asset.id, url, residentMapKeys, poolHooks)
      if (!el) {
        // Intentional degrade: placeholder layer, no wrong-frame steal.
        missingDecoder += 1
        allVideoReady = false
        continue
      }
      // `createPreviewVideoElement` starts conservatively at metadata preload;
      // once a mapping becomes the foreground clip, explicitly promote it to
      // auto so the browser buffers ahead. NEVER call load() here: the create
      // path already issued it, and a second load() aborts the in-flight fetch
      // AND resets a pending seek/currentTime to 0 on the element right as it
      // becomes the foreground clip — restarting the very stall it meant to fix.
      if (el.preload !== 'auto') el.preload = 'auto'
      // One drive per mapping key per frame (multiple clips may share the map).
      if (drivenKeys.has(mapKey)) continue
      drivenKeys.add(mapKey)
      const srcSec = clipSourceSec(clip, at)
      const baseRate = Math.max(0.0625, Math.min(16, clip.speed))
      // Audio: video-track clips play via the element; volume keyed by instance.
      const track = trackById.get(clip.trackId)
      const clipVol = clip.muted || track?.muted || track?.hidden ? 0 : clip.volume
      audioEngine.setVideoClipVolume(mapKey, el, clipVol)
      const now = performance.now()
      // A landed seek teaches this instance's real seek latency; hard seeks
      // while playing then aim at where the transport WILL be on landing
      // (leadCompensatedSeekTarget) instead of chasing a moving target.
      const issuedAt = videoSeekIssuedAt.current.get(mapKey)
      if (issuedAt !== undefined && !el.seeking) {
        const measured = Math.min(1.5, (now - issuedAt) / 1000)
        const prior = videoSeekEtaSec.current.get(mapKey)
        videoSeekEtaSec.current.set(
          mapKey,
          prior === undefined ? measured : prior * 0.5 + measured * 0.5,
        )
        videoSeekIssuedAt.current.delete(mapKey)
      }
      const hardSeekTo = (target: number) => {
        videoSeekIssuedAt.current.set(mapKey, now)
        syncSeek(el, target)
      }
      const leadTarget = () =>
        leadCompensatedSeekTarget(
          srcSec,
          baseRate,
          videoSeekEtaSec.current.get(mapKey) ?? 0.2,
          clip.outPointSec,
        )
      if (playing) {
        if (el.paused) {
          el.playbackRate = baseRate
          // This element may be pre-warmed (already seeked to this clip's start)
          // or was playing this exact source a frame ago. Re-seeking to the
          // near-identical source time forces a fresh seeking/seeked cycle right
          // at the cut — that re-buffer IS the visible stutter at clip edges and
          // it discards the look-ahead warm. Only hard-seek a genuinely
          // off-target (cold) element; small drift is absorbed by rate
          // correction once playing.
          if (!el.seeking && decideVideoSync(el.currentTime, srcSec, baseRate).hardSeek) {
            hardSeekTo(leadTarget())
          }
          void el.play().catch(() => {})
        } else {
          // Drift thresholds are wall-clock (normalized by baseRate) so a
          // high-speed span gets the same real time to land a seek as a 1x
          // clip — see decideVideoSync.
          const sync = decideVideoSync(el.currentTime, srcSec, baseRate)
          el.playbackRate = Math.max(0.0625, Math.min(16, baseRate * sync.rateCorrection))
          if (sync.hardSeek) {
            // NEVER abort an in-flight seek for a reachable target: re-targeting
            // restarts the decoder search each time, and past ~2x the transport
            // outruns every restart — the seek carousel that froze playback into
            // ~1 frame per seek. While seeking, currentTime reads the pending
            // target, so only abandon it when it is hopeless (>1s wall off:
            // a scrub or a source jump), otherwise let it land and re-decide.
            if (!el.seeking || Math.abs(srcSec - el.currentTime) / baseRate > 1) {
              hardSeekTo(leadTarget())
            }
          }
        }
      } else {
        el.playbackRate = baseRate
        if (!el.paused) el.pause()
        // Paused target is static between scrubs, so re-targeting here cannot
        // storm — while seeking, currentTime reads the pending target and the
        // condition stays false until the user actually moves the playhead.
        if (Math.abs(el.currentTime - srcSec) > 1 / 30) hardSeekTo(srcSec)
      }
      const onTarget =
        el.readyState >= 2 && !el.seeking && (playing || Math.abs(el.currentTime - srcSec) <= 0.04)
      if (!onTarget) {
        allVideoReady = false
        const startedAt = videoSeekStartedAt.current.get(mapKey) ?? now
        videoSeekStartedAt.current.set(mapKey, startedAt)
        const waitAge = now - startedAt
        const lastRecovery = videoSeekRecoveredAt.current.get(mapKey) ?? Number.NEGATIVE_INFINITY
        // Last-resort unwedge for a seek/load that never settles. Exponential
        // backoff (750ms → 1.5s → 3s → 6s cap): a slow-but-progressing load must
        // not be re-load()ed every 750ms — that resets readyState to 0 each time
        // and turns a transient stall into a permanent "Loading video frame".
        const attempts = videoSeekRecoveryCount.current.get(mapKey) ?? 0
        const backoffMs = Math.min(6000, 750 * 2 ** attempts)
        if (playing && waitAge >= backoffMs && now - lastRecovery >= backoffMs) {
          try {
            el.pause()
            if (el.seeking || el.readyState >= 2) {
              videoSeekIssuedAt.current.set(mapKey, now)
              el.currentTime = leadTarget()
            } else {
              el.load()
            }
            videoSeekRecoveredAt.current.set(mapKey, now)
            videoSeekRecoveryCount.current.set(mapKey, attempts + 1)
            void el.play().catch(() => {})
          } catch {
            /* browser rejected the recovery; the next render retries */
          }
        }
      } else {
        videoSeekStartedAt.current.delete(mapKey)
        videoSeekRecoveredAt.current.delete(mapKey)
        videoSeekRecoveryCount.current.delete(mapKey)
      }
    }

    // Seek the bounded look-ahead element while the current clip is still
    // playing. It remains paused/muted and becomes a pool hit at the cut.
    for (const [mapKey, clip] of warmByKey) {
      if (videoPool.current.isDegraded(mapKey)) continue
      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
      if (!asset || asset.kind !== 'video') continue
      const url = urlCache.current.get(asset.id)
      if (!url) continue
      const el = videoPool.current.acquire(mapKey, asset.id, url, residentMapKeys, poolHooks)
      if (!el) continue
      if (!el.paused) el.pause()
      el.muted = true
      // Promote buffering only — load() would abort the create-path fetch and
      // reset currentTime, discarding the very pre-seek this warm exists for.
      if (el.preload !== 'auto') el.preload = 'auto'
      const sourceAtStart = clipSourceSec(clip, clip.startSec)
      if (!el.seeking && Math.abs(el.currentTime - sourceAtStart) > 1 / 60) {
        syncSeek(el, sourceAtStart)
      }
    }

    // Pause instances no longer under the playhead, then reclaim idle past cap.
    for (const [key, slot] of videoPool.current.entries()) {
      if (!residentMapKeys.has(key) && !slot.el.paused) slot.el.pause()
    }
    for (const key of videoPool.current.trimIdle(residentMapKeys, poolHooks)) {
      // trimIdle disposed the element; clear instance-side caches.
      audioEngine.releaseVideoAudio(key)
      videoEpoch.current.delete(key)
      videoTextureIdentity.current.delete(key)
      videoTextureClipId.current.delete(key)
      videoSeekStartedAt.current.delete(key)
      videoSeekRecoveredAt.current.delete(key)
      videoSeekRecoveryCount.current.delete(key)
      videoSeekIssuedAt.current.delete(key)
      videoSeekEtaSec.current.delete(key)
      videoErrors.current.delete(key)
      const cached = videoFrameCache.current.get(key)
      if (cached) {
        try {
          cached.close()
        } catch {
          /* already closed */
        }
      }
      videoFrameCache.current.delete(key)
      gpuRef.current?.evictTexture(key)
    }

    // Surface intentional degrade (decoder limit) — never silent wrong frames.
    const capacityExcess = Math.max(0, activeMapKeys.size - videoPool.current.maxActive)
    const unavailable = Math.max(missingDecoder, capacityExcess)
    const warn =
      unavailable > 0
        ? `Preview: ${unavailable} video layer${unavailable > 1 ? 's' : ''} exceed decoder capacity — showing placeholders. Flatten, nest, or proxy layers for reliable playback.`
        : null
    if (warn !== decoderWarnRef.current) {
      decoderWarnRef.current = warn
      setDecoderWarn(warn)
    }

    // Keep the last painted frame while a newly assigned element is seeking.
    // Playback ticks and seek/frame callbacks keep retrying; without this every
    // in-flight seek at a dense cut cleared the canvas to black and painted the
    // "Loading video frame" placeholder for its whole duration. A real
    // decoder-cap failure still paints the explicit placeholder below.
    if (!allVideoReady && missingDecoder === 0 && hasPaintedRef.current) return

    // ── Clear + composite ─────────────────────────────────────
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, stageW, stageH)
    ctx.fillStyle = '#000'
    ctx.fillRect(frame.x, frame.y, W, H)
    hasPaintedRef.current = true
    ctx.save()
    ctx.translate(frame.x, frame.y)
    ctx.beginPath()
    ctx.rect(0, 0, W, H)
    ctx.clip()

    // ── Media layer: WebGPU compositor when available, else Canvas 2D ──
    // Blur canvasFill no longer forces the 2D path: the compositor renders the
    // blurred letterbox background itself (WGSL separable Gaussian).
    const gpu = gpuRef.current
    const canRenderGpu = !!gpu && !gpu.isLost && gpuStateRef.current === 'ready'
    const activeFx = activeIdx.queryAt('fx', at)
    const activeText = activeIdx.queryAt('text', at)
    const renderSources = new Map<
      string,
      RenderPlanSourceInfo & {
        source: HTMLVideoElement | HTMLImageElement | VideoFrame
      }
    >()
    let drewOnGpu = false
    if (canRenderGpu) {
      for (const clip of activeVideo) {
        const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
        if (!asset) continue
        let source: HTMLVideoElement | HTMLImageElement | VideoFrame | null = null
        let sw = W
        let sh = H
        let sourceIdentity = 0
        // frameVersion drives texture re-upload: a constant for images (upload
        // once), and the decoded-frame epoch for video. currentTime advances on
        // every display tick (often 120–165Hz) while decoded frames arrive at
        // the source rate (usually 24–30fps); using currentTime here would
        // upload the same pixels repeatedly and queue GPU work at every tick.
        let frameVersion = 0
        if (asset.kind === 'image') {
          const img = imagePool.current.get(asset.id)
          if (img && img.complete && img.naturalWidth > 0) {
            source = img
            sw = img.naturalWidth
            sh = img.naturalHeight
          }
        } else if (asset.kind === 'video') {
          const mapKey = previewPlaybackKey(clip)
          const el = mapKey ? videoPool.current.get(mapKey) : undefined
          if (el && el.readyState >= 2) {
            let identity = videoTextureIdentity.current.get(mapKey)
            const previousClipId = videoTextureClipId.current.get(mapKey)
            if (identity === undefined || previousClipId !== clip.id) {
              identity = nextVideoTextureIdentity.current++
              videoTextureIdentity.current.set(mapKey, identity)
              videoTextureClipId.current.set(mapKey, clip.id)
            }
            sourceIdentity = identity
            sw = el.videoWidth || W
            sh = el.videoHeight || H
            if (playing) {
              // Playing videos present frames continuously → the raw element has
              // a GPU-importable back resource. Use it directly (unchanged path).
              source = el
              frameVersion = el.currentTime
            } else {
              // PAUSED: use VideoFrame cached per *mapping instance* (not asset)
              // and the decoded-frame epoch — currentTime can't signal that a
              // seeked frame finished decoding (see videoEpoch).
              source = (mapKey && videoFrameCache.current.get(mapKey)) || el
              frameVersion = videoEpoch.current.get(mapKey) ?? 0
            }
          }
        }
        if (!source) {
          // No private element for this mapping — skip GPU draw (2D path paints
          // a labeled placeholder so we never show another clip's frame).
          continue
        }
        renderSources.set(clip.id, {
          source,
          sourceW: sw,
          sourceH: sh,
          frameVersion: sourceIdentity * 1_000_000 + frameVersion,
        })
      }
      const renderPlan = buildRenderPlan({
        mediaClips: activeVideo,
        captionClips: activeText,
        fxClips: activeFx,
        tracks: allTracks,
        outputWidth: W,
        outputHeight: H,
        timelineSec: at,
        overlayFrameVersion: at,
        sources: renderSources,
      })
      const draws = resolveRenderPlanDraws(
        renderPlan.mediaDraws,
        (clipId) => renderSources.get(clipId)?.source ?? null,
      )
      gpu.retainTextures(new Set(draws.map((draw) => draw.cacheKey ?? draw.assetId)))
      const status = gpu.render(draws)
      if (status === 'ok') {
        // GPU canvas is W×H (the comp frame); we're inside translate(frame),
        // so blit at the frame origin.
        ctx.drawImage(gpu.canvas, 0, 0, W, H)
        drewOnGpu = true
      } else if (status === 'lost') {
        gpuStateRef.current = 'failed' // device lost → 2D from here on
        gpu.destroy()
        gpuRef.current = null
      }
      // status === 'empty': the GPU couldn't upload any source (tainted
      // cross-origin video, or frame not decoded yet) — leave drewOnGpu false so
      // the Canvas-2D media loop below renders it (drawImage handles tainted video).
    }

    if (!drewOnGpu) {
      for (const clip of activeVideo) {
        const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
        if (!asset) continue
        ctx.globalAlpha = resolveClipOpacityAt(clip, at)
        const transform = resolveClipTransformAt(clip, at)
        const adjustFilter = isAdjustNeutral(clip.adjust) ? 'none' : adjustToFilter(clip.adjust)
        if (asset.kind === 'image') {
          const img = imagePool.current.get(asset.id)
          if (img && img.complete && img.naturalWidth > 0) {
            drawCanvasFill(ctx, img, W, H, transform, clip.canvasFill, adjustFilter)
            ctx.filter = adjustFilter
            drawMedia(ctx, img, W, H, transform)
          }
        } else if (asset.kind === 'video') {
          const mapKey = previewPlaybackKey(clip)
          const el = mapKey ? videoPool.current.get(mapKey) : undefined
          if (el && el.readyState >= 2) {
            drawCanvasFill(ctx, el, W, H, transform, clip.canvasFill, adjustFilter)
            ctx.filter = adjustFilter
            drawMedia(ctx, el, W, H, transform)
          } else {
            // Intentional degrade: never draw another mapping's frame.
            const rect = getMediaRectFromSize(W, H, W, H, transform)
            drawMissingVideoPlaceholder(
              ctx,
              rect,
              transform,
              !!mapKey && videoPool.current.isDegraded(mapKey) ? 'decoder-limit' : 'loading',
            )
          }
        }
        ctx.filter = 'none'
        ctx.globalAlpha = 1
      }
    }

    // Placeholders for active videos missing from GPU pass (decoder degrade).
    if (drewOnGpu) {
      for (const clip of activeVideo) {
        const asset = clip.assetId ? assetById.get(clip.assetId) : undefined
        if (!asset || asset.kind !== 'video') continue
        const mapKey = previewPlaybackKey(clip)
        const el = mapKey ? videoPool.current.get(mapKey) : undefined
        if (el && el.readyState >= 2) continue
        const transform = resolveClipTransformAt(clip, at)
        ctx.globalAlpha = resolveClipOpacityAt(clip, at)
        const rect = getMediaRectFromSize(W, H, W, H, transform)
        drawMissingVideoPlaceholder(
          ctx,
          rect,
          transform,
          !!mapKey && videoPool.current.isDegraded(mapKey) ? 'decoder-limit' : 'loading',
        )
        ctx.globalAlpha = 1
      }
    }

    for (const clip of activeFx) {
      if (clip.fxData?.type === 'blur-sticker') drawBlurSticker(ctx, clip.fxData, W, H)
      else if (clip.fxData?.type === 'filter')
        drawFilterFx(ctx, canvasFilterString(clip.fxData), W, H)
    }

    // Text clips on top — THE shared caption renderer (draw-caption.ts), the
    // exact code path the browser exporter uses, so preview and export can
    // never drift for text again.
    for (const clip of activeText) drawTextClip(ctx, clip, W, H, at)

    drawSnapGuides(ctx, snapGuidesRef.current, W, H)
    ctx.restore()

    drawFrameOverlay(ctx, frame)
    // disposeInstance is itself a []-dep useCallback, so listing it keeps
    // renderFrame's identity stable while satisfying exhaustive-deps.
  }, [disposeInstance, previewPlaybackKey, scheduleRender])
  renderFrameRef.current = renderFrame

  useEffect(
    () => () => {
      renderSchedulerRef.current?.dispose()
      renderSchedulerRef.current = null
      releaseFxBuffers('preview-')
    },
    [],
  )

  // Recompute the selection overlay rect from fresh store state. Called from the
  // same triggers as renderFrame; sets state only when the rect actually changed
  // so a static selection during playback doesn't re-render this component.
  const recomputeOverlay = useCallback(() => {
    const rect = getSelectedOverlayRect({
      assets: useProjectStore.getState().assets,
      canvas: canvasRef.current,
      clips: useTimelineStore.getState().timeline.clips,
      currentSec: usePlaybackStore.getState().currentSec,
      height: CANVAS_H,
      imagePool: imagePool.current,
      selectedClipIds: useTimelineStore.getState().selectedClipIds,
      tracks: useTimelineStore.getState().timeline.tracks,
      videoPool: videoPool.current,
      getVideoEl: (clip) => {
        const k = previewPlaybackKey(clip)
        return k ? videoPool.current.get(k) : undefined
      },
      width: CANVAS_W,
    })
    setSelectionRect((prev) => (sameRect(prev, rect) ? prev : rect))
  }, [CANVAS_W, CANVAS_H, previewPlaybackKey])

  const findHitsAt = useCallback(
    (x: number, y: number): HitResult[] => {
      const canvas = canvasRef.current
      if (!canvas) return []
      const ctx = canvas.getContext('2d')
      if (!ctx) return []

      const at = usePlaybackStore.getState().currentSec
      // Flatten compounds for hit-testing (same as render).
      const timeline = useTimelineStore.getState().flatTimeline()
      const allAssets = useProjectStore.getState().assets
      const { clips: allClips, tracks: allTracks } = timeline
      const selectedIds = useTimelineStore.getState().selectedClipIds
      const results: HitResult[] = []

      let hitIdx = activeIndexRef.current
      if (!hitIdx || !hitIdx.matches(allClips, allTracks)) {
        hitIdx = ActiveClipIndex.build(allClips, allTracks)
        activeIndexRef.current = hitIdx
      }
      const activeMedia = hitIdx.queryAt('video', at)

      for (const clip of activeMedia) {
        const asset = allAssets.find((a) => a.id === clip.assetId)
        if (!asset) {
          // A compound clip has no asset — it's a sub-video that fills the comp
          // frame. Give it a full-frame rect (×its transform) so it selects and
          // resizes like a normal media clip; the transform composes onto its
          // children when flattened.
          if (clip.compoundId) {
            results.push({
              clip,
              kind: 'media',
              rect: getMediaRectFromSize(
                canvas.width,
                canvas.height,
                canvas.width,
                canvas.height,
                resolveClipTransformAt(clip, at),
              ),
            })
          }
          continue
        }

        if (asset.kind === 'image') {
          const img = imagePool.current.get(asset.id)
          if (img && img.complete && img.naturalWidth > 0) {
            results.push({
              clip,
              kind: 'media',
              rect: getMediaRect(
                img,
                canvas.width,
                canvas.height,
                resolveClipTransformAt(clip, at),
              ),
            })
          }
        } else if (asset.kind === 'video') {
          const mapKey = previewPlaybackKey(clip)
          const el = mapKey ? videoPool.current.get(mapKey) : undefined
          if (el && el.readyState >= 2) {
            results.push({
              clip,
              kind: 'media',
              rect: getMediaRect(el, canvas.width, canvas.height, resolveClipTransformAt(clip, at)),
            })
          }
        }
      }

      const activeFx = hitIdx.queryAt('fx', at)
      for (const clip of activeFx) {
        // Only blur stickers have a draggable rect; a filter fx is full-frame and
        // is selected/edited from the timeline, not the preview.
        if (clip.fxData?.type !== 'blur-sticker') continue
        results.push({
          clip,
          kind: 'fx',
          rect: getBlurStickerRect(clip.fxData, canvas.width, canvas.height),
        })
      }

      const activeText = hitIdx.queryAt('text', at)
      for (const clip of activeText) {
        const td = clip.textData
        if (!td) continue
        const fontSize = Math.round((td.fontSize / 1080) * canvas.height)
        ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
        ctx.letterSpacing = `${((td.letterSpacing ?? 0) / 1080) * canvas.height}px`
        ctx.wordSpacing = `${(resolvedTextWordSpacing(td) / 1080) * canvas.height}px`
        results.push({
          clip,
          kind: 'text',
          rect: getTextRect(
            ctx,
            td.content,
            td.x * canvas.width,
            td.y * canvas.height,
            fontSize,
            td.align,
            resolveClipTransformAt(clip, at),
            canvas.width,
          ),
        })
        ctx.letterSpacing = '0px'
        ctx.wordSpacing = '0px'
      }

      for (let i = results.length - 1; i >= 0; i--) {
        const hit = results[i]
        if (!hit || !selectedIds.includes(hit.clip.id)) continue
        const handle = getSelectionHandleAt(x, y, hit.rect)
        if (handle) return [{ ...hit, handle }]
      }

      const bodyHits: HitResult[] = []
      for (let i = results.length - 1; i >= 0; i--) {
        const hit = results[i]
        if (hit && pointInRect(x, y, hit.rect)) bodyHits.push(hit)
      }
      return bodyHits
    },
    [previewPlaybackKey],
  )

  const findHitAt = useCallback(
    (x: number, y: number): HitResult | null => findHitsAt(x, y)[0] ?? null,
    [findHitsAt],
  )

  const onCanvasMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const canvas = canvasRef.current
      if (!canvas) return
      const frame = frameRectRef.current
      const point = clientToFrame(canvas, frame, e.clientX, e.clientY)
      const hits = findHitsAt(point.x, point.y)
      const hit = pickHitFromStack(hits, point, clickCycleRef)
      if (!hit) {
        selectClips([])
        snapGuidesRef.current = []
        renderFrame()
        return
      }

      e.preventDefault()
      selectClips([hit.clip.id])

      const track = useTimelineStore
        .getState()
        .timeline.tracks.find((t) => t.id === hit.clip.trackId)
      if (track?.locked) return

      // History is pushed on the FIRST move (see onMove), not here — a plain
      // select-click must not create an undo step or clobber the redo stack.
      dragHistoryPushedRef.current = false

      // Captions move/resize as one: editing a sub's position/size applies to
      // every caption on that track so originals and translations stay separate.
      const captionIds = isCaptionClip(hit.clip)
        ? captionClipIdsOnTrack(useTimelineStore.getState().timeline.clips, hit.clip.trackId)
        : undefined

      if (hit.handle) {
        dragRef.current = {
          clipId: hit.clip.id,
          kind: hit.kind,
          mode: 'resize',
          captionIds,
          handle: hit.handle,
          startRect: hit.rect,
          startTransform: resolveTransform(hit.clip),
          startFx: hit.clip.fxData?.type === 'blur-sticker' ? hit.clip.fxData : undefined,
          startText: hit.clip.textData
            ? {
                x: hit.clip.textData.x,
                y: hit.clip.textData.y,
                fontSize: hit.clip.textData.fontSize,
                align: hit.clip.textData.align,
              }
            : undefined,
        }
        return
      }

      const anchor =
        hit.kind === 'text' && hit.clip.textData
          ? { x: hit.clip.textData.x, y: hit.clip.textData.y }
          : hit.kind === 'fx' && hit.clip.fxData?.type === 'blur-sticker'
            ? { x: hit.clip.fxData.x, y: hit.clip.fxData.y }
            : resolveTransform(hit.clip)

      dragRef.current = {
        clipId: hit.clip.id,
        kind: hit.kind,
        mode: 'move',
        captionIds,
        offsetX: point.x / frame.w - anchor.x,
        offsetY: point.y / frame.h - anchor.y,
        startAnchor: { x: anchor.x, y: anchor.y },
        startRect: hit.rect,
      }
    },
    [findHitsAt, renderFrame, selectClips],
  )

  const onCanvasMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (dragRef.current) return
      const canvas = canvasRef.current
      if (!canvas) return
      const root = rootRef.current ?? canvas
      const point = clientToFrame(canvas, frameRectRef.current, e.clientX, e.clientY)
      const hit = findHitAt(point.x, point.y)
      if (!hit) {
        root.style.cursor = 'default'
      } else if (hit.handle === 'nw' || hit.handle === 'se') {
        root.style.cursor = 'nwse-resize'
      } else if (hit.handle === 'ne' || hit.handle === 'sw') {
        root.style.cursor = 'nesw-resize'
      } else if (hit.handle === 'n' || hit.handle === 's') {
        root.style.cursor = 'ns-resize'
      } else if (hit.handle === 'e' || hit.handle === 'w') {
        root.style.cursor = 'ew-resize'
      } else {
        root.style.cursor = 'move'
      }
    },
    [findHitAt],
  )

  useEffect(() => {
    function applyMove(clientX: number, clientY: number) {
      const drag = dragRef.current
      const canvas = canvasRef.current
      if (!drag || !canvas) return

      // Push one undo checkpoint the first time the pointer actually moves —
      // the live setClipTransform / setClipText calls below don't push, so the
      // whole drag collapses into a single undo step.
      if (!dragHistoryPushedRef.current) {
        dragHistoryPushedRef.current = true
        beginHistoryStep()
      }

      const frame = frameRectRef.current
      const point = clientToFrame(canvas, frame, clientX, clientY)
      // For captions, fan text edits out to every caption; otherwise just this clip.
      const setText = (id: string, patch: Partial<{ x: number; y: number; fontSize: number }>) =>
        drag.captionIds ? setClipsText(drag.captionIds, patch) : setClipText(id, patch)
      // Route transform writes through the keyframe-aware setter: when the clip
      // has keyframes for a prop, the drag records a keyframe at the playhead;
      // otherwise it sets the static field exactly as before.
      const at = usePlaybackStore.getState().currentSec
      const setTransform = (id: string, patch: Partial<ClipTransform>) =>
        setClipTransformKeyed(id, patch, at)

      if (drag.mode === 'resize') {
        const guides = resizeDraggedClip(
          drag,
          point,
          frame.w,
          frame.h,
          setText,
          setTransform,
          setClipFxData,
        )
        snapGuidesRef.current = guides
        renderFrame()
        return
      }

      const rawX = point.x / frame.w - (drag.offsetX ?? 0)
      const rawY = point.y / frame.h - (drag.offsetY ?? 0)
      const snap = snapMovedRect(drag, rawX, rawY, frame.w, frame.h)
      const x = rawX + snap.dx / frame.w
      const y = rawY + snap.dy / frame.h
      snapGuidesRef.current = snap.guides

      if (drag.kind === 'text') setText(drag.clipId, { x, y })
      else if (drag.kind === 'fx') setClipFxData(drag.clipId, { x, y })
      else setTransform(drag.clipId, { x, y })
      renderFrame()
    }

    let pointerRaf = 0
    let pendingPoint: { x: number; y: number } | null = null
    function onMove(e: MouseEvent) {
      pendingPoint = { x: e.clientX, y: e.clientY }
      if (pointerRaf !== 0) return
      pointerRaf = requestAnimationFrame(() => {
        pointerRaf = 0
        const point = pendingPoint
        pendingPoint = null
        if (point) applyMove(point.x, point.y)
      })
    }

    function onUp() {
      if (pointerRaf !== 0) cancelAnimationFrame(pointerRaf)
      pointerRaf = 0
      const point = pendingPoint
      pendingPoint = null
      if (point) applyMove(point.x, point.y)
      dragRef.current = null
      snapGuidesRef.current = []
      renderFrame()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      if (pointerRaf !== 0) cancelAnimationFrame(pointerRaf)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [
    renderFrame,
    setClipText,
    setClipsText,
    setClipFxData,
    setClipTransformKeyed,
    beginHistoryStep,
  ])

  // Stand up the WebGPU compositor once. Falls back to Canvas 2D forever if
  // WebGPU is unavailable (state → 'failed'); never throws.
  useEffect(() => {
    let disposed = false
    gpuStateRef.current = 'init'
    void GpuCompositor.create(CANVAS_W, CANVAS_H).then((comp) => {
      if (disposed) {
        comp?.destroy()
        return
      }
      if (comp) {
        gpuRef.current = comp
        gpuStateRef.current = 'ready'
        renderFrame() // repaint now that the GPU path is live
      } else {
        gpuStateRef.current = 'failed'
      }
    })
    return () => {
      disposed = true
      gpuRef.current?.destroy()
      gpuRef.current = null
      gpuStateRef.current = 'idle'
    }
    // Created once; size changes are handled by the resize effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the GPU canvas sized to the composition frame.
  useEffect(() => {
    if (gpuRef.current && gpuStateRef.current === 'ready') {
      if (!gpuRef.current.resize(CANVAS_W, CANVAS_H)) {
        gpuRef.current.destroy()
        gpuRef.current = null
        gpuStateRef.current = 'failed'
        renderFrame()
      }
    }
    // renderFrame is intentionally read only when resize fails; depending on it
    // would recreate this effect for every preview-state callback change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [CANVAS_W, CANVAS_H])

  // Tear down pooled media when this component unmounts (leaving the editor).
  // MUST stay deps=[] — never fold into the media-load effect below, or every
  // timeline edit would dispose all elements and flash the preview black.
  useEffect(
    () => () => {
      for (const key of videoPool.current.keys()) disposeInstance(key)
      for (const id of imagePool.current.keys()) disposeAsset(id)
      // Remaining URLs without image entries (video-only assets).
      for (const id of [...urlCache.current.keys()]) disposeAsset(id)
      videoSrcKey.current.clear()
      loadTokens.current.clear()
    },
    [disposeInstance, disposeAsset],
  )

  // Load shared URLs (+ image elements). Video *instances* are acquired lazily
  // in renderFrame by sourceMappingKey (the same mapping used by export).
  useEffect(() => {
    const assetIdsInProject = new Set(assets.map((a) => a.id))
    // Only assets on the FLATTENED timeline need media (compounds included).
    const flatClips = useTimelineStore.getState().flatTimeline().clips
    const usedIds = new Set(flatClips.map((c) => c.assetId).filter(Boolean) as string[])
    const at = usePlaybackStore.getState().currentSec
    const imageIds = new Set(assets.filter((a) => a.kind === 'image').map((a) => a.id))
    const nearImageIds = new Set(
      flatClips
        .filter(
          (clip) =>
            !!clip.assetId &&
            imageIds.has(clip.assetId) &&
            clip.startSec < at + 15 &&
            clip.startSec + clipEffectiveDuration(clip) > Math.max(0, at - 5),
        )
        .map((clip) => clip.assetId!),
    )
    const workingIds = new Set(
      [...usedIds].filter((id) => !imageIds.has(id) || nearImageIds.has(id)),
    )
    const redraw = () => {
      renderFrame()
      recomputeOverlay()
    }

    for (const asset of assets) {
      if (asset.kind !== 'video' && asset.kind !== 'image') continue
      if (!workingIds.has(asset.id)) continue
      const desiredKey =
        asset.kind === 'video'
          ? (asset.normalizedBlobKey ??
              (isAudioCapableProxyKey(asset.proxyStorageKey)
                ? asset.proxyStorageKey
                : asset.storageKey))
          : asset.storageKey
      const requestToken = makePreviewLoadToken(asset.id, desiredKey)
      const sameKey = videoSrcKey.current.get(asset.id) === desiredKey
      if (sameKey && (urlCache.current.has(asset.id) || loadingIds.current.has(asset.id))) continue
      if (urlCache.current.has(asset.id)) {
        // Source key changed (proxy added/removed) → drop URL + video instances.
        disposeAsset(asset.id)
      }
      videoSrcKey.current.set(asset.id, desiredKey)
      loadTokens.current.set(asset.id, requestToken)
      loadingIds.current.add(asset.id)

      mediaManager.getPreviewObjectUrl(asset.id).then((url) => {
        loadingIds.current.delete(asset.id)
        if (!url) {
          console.warn('[preview] no media URL for asset (OPFS blob missing?):', asset.id)
          return
        }
        const liveAssets = new Set(useProjectStore.getState().assets.map((a) => a.id))
        const liveUsed = new Set(
          useTimelineStore
            .getState()
            .flatTimeline()
            .clips.map((c) => c.assetId)
            .filter(Boolean) as string[],
        )
        if (asset.kind === 'image') {
          const liveAt = usePlaybackStore.getState().currentSec
          const stillNear = useTimelineStore
            .getState()
            .flatTimeline()
            .clips.some(
              (clip) =>
                clip.assetId === asset.id &&
                clip.startSec < liveAt + 15 &&
                clip.startSec + clipEffectiveDuration(clip) > Math.max(0, liveAt - 5),
            )
          if (!stillNear) {
            URL.revokeObjectURL(url)
            return
          }
        }
        const currentKey = videoSrcKey.current.get(asset.id)
        const currentToken =
          currentKey !== undefined ? makePreviewLoadToken(asset.id, currentKey) : undefined
        const action = decidePreviewUrlResolve({
          assetId: asset.id,
          startedToken: requestToken,
          currentToken,
          usedIds: liveUsed,
          assetIdsInProject: liveAssets,
          alreadyLoadingCurrent: loadingIds.current.has(asset.id),
          alreadyHaveCurrent:
            urlCache.current.has(asset.id) &&
            (asset.kind === 'image' ? imagePool.current.has(asset.id) : true) &&
            currentToken === loadTokens.current.get(asset.id),
        })
        if (action === 'discard') {
          URL.revokeObjectURL(url)
          return
        }
        if (action === 'requeue') {
          URL.revokeObjectURL(url)
          if (currentKey === undefined && liveUsed.has(asset.id)) {
            const liveAsset = useProjectStore.getState().assets.find((a) => a.id === asset.id)
            if (liveAsset && (liveAsset.kind === 'video' || liveAsset.kind === 'image')) {
              const key =
                liveAsset.kind === 'video'
                  ? (isAudioCapableProxyKey(liveAsset.proxyStorageKey)
                      ? liveAsset.proxyStorageKey
                      : liveAsset.storageKey)
                  : liveAsset.storageKey
              videoSrcKey.current.set(asset.id, key)
              loadTokens.current.set(asset.id, makePreviewLoadToken(asset.id, key))
            }
          }
          setReloadNonce((v) => v + 1)
          return
        }
        urlCache.current.set(asset.id, url)
        if (asset.kind === 'image') {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.addEventListener('load', redraw)
          img.src = url
          imagePool.current.set(asset.id, img)
        } else {
          // Video: URL only — renderFrame acquires mapping-keyed instances.
          redraw()
        }
      })
    }

    // Dispose assets no longer on the timeline working set.
    const pooledAssets = new Set([...imagePool.current.keys(), ...urlCache.current.keys()])
    for (const id of previewIdsToDispose(pooledAssets, workingIds, assetIdsInProject)) {
      disposeAsset(id)
    }
    // Drop video instances whose asset left the working set (URL may already be gone).
    for (const [key, slot] of [...videoPool.current.entries()]) {
      if (!usedIds.has(slot.assetId) || !assetIdsInProject.has(slot.assetId)) {
        disposeInstance(key)
      }
    }
  }, [
    assets,
    clips,
    compounds,
    renderFrame,
    recomputeOverlay,
    reloadNonce,
    disposeAsset,
    disposeInstance,
  ])

  // Playback (RAF tick / seek / play-pause): repaint + refresh overlay WITHOUT
  // re-rendering this component. This keeps 60fps playback off the React render
  // path — the single biggest win, since the overlay computation (canvas 2D
  // context + text measurement) no longer runs on every tick.
  useEffect(() => {
    let lastOverlayMs = Number.NEGATIVE_INFINITY
    let lastHorizonMs = Number.NEGATIVE_INFINITY
    let lastSeekNonce = usePlaybackStore.getState().seekNonce
    let lastPlaying = usePlaybackStore.getState().isPlaying
    const paint = (playback = usePlaybackStore.getState()) => {
      if (playback.isPlaying !== lastPlaying) {
        lastPlaying = playback.isPlaying
        // Invalidate every instance's texture epoch at the transport edge so
        // pause/resume cannot reuse the previous GPU copy when no VFC arrives
        // for the first frame of the new state.
        for (const key of videoPool.current.keys()) {
          videoEpoch.current.set(key, (videoEpoch.current.get(key) ?? 0) + 1)
        }
        // A cached paused VideoFrame belongs to the previous transport stop.
        // Reusing it after a later pause can present an old picture until the
        // decoder happens to emit another callback, producing the alternating
        // smooth/frozen behaviour across pause/resume cycles.
        for (const frame of videoFrameCache.current.values()) {
          try {
            frame.close()
          } catch {
            /* already closed */
          }
        }
        videoFrameCache.current.clear()
      }
      scheduleRender()
      const now = performance.now()
      const seekChanged = playback.seekNonce !== lastSeekNonce
      lastSeekNonce = playback.seekNonce
      if (!playback.isPlaying || seekChanged || now - lastOverlayMs >= 100) {
        lastOverlayMs = now
        recomputeOverlay()
      }
      if (playback.isPlaying && !seekChanged && now - lastHorizonMs < 250) return
      lastHorizonMs = now
      const at = playback.currentSec
      const imageIds = imageAssetIdsRef.current
      const flat = useTimelineStore.getState().flatTimeline()
      let index = activeIndexRef.current
      if (!index || !index.matches(flat.clips, flat.tracks)) {
        index = ActiveClipIndex.build(flat.clips, flat.tracks)
        activeIndexRef.current = index
      }
      const horizonStart = Math.max(0, at - 5)
      const horizonIds = new Set<string>()
      for (const clip of index.queryAt('video', horizonStart)) {
        if (clip.assetId && imageIds.has(clip.assetId)) horizonIds.add(clip.assetId)
      }
      for (const clip of index.queryStartingBetween('video', horizonStart, at + 15)) {
        if (clip.assetId && imageIds.has(clip.assetId)) horizonIds.add(clip.assetId)
      }
      const signature = [...horizonIds].sort().join('|')
      if (signature !== imageHorizonSignatureRef.current) {
        imageHorizonSignatureRef.current = signature
        setReloadNonce((value) => value + 1)
      }
    }
    paint()
    return usePlaybackStore.subscribe(paint)
  }, [scheduleRender, recomputeOverlay])

  // Edits (timeline / assets / aspect) and selection changes still flow through
  // React — these are infrequent compared to playback ticks.
  useEffect(() => {
    renderFrame()
    recomputeOverlay()
  }, [
    clips,
    tracks,
    assets,
    compounds,
    selectedClipIds,
    CANVAS_W,
    CANVAS_H,
    renderFrame,
    recomputeOverlay,
  ])

  useEffect(() => {
    let cancelled = false
    const flatClips = useTimelineStore.getState().flatTimeline().clips
    void loadTextClipFonts(flatClips).then(() => {
      if (!cancelled) {
        renderFrame()
        recomputeOverlay()
      }
    })
    return () => {
      cancelled = true
    }
  }, [clips, compounds, renderFrame, recomputeOverlay])

  return (
    <div
      ref={rootRef}
      className="relative flex h-full w-full cursor-default items-center justify-center overflow-visible"
      onMouseDown={onCanvasMouseDown}
      onMouseMove={onCanvasMouseMove}
    >
      <canvas
        ref={canvasRef}
        data-preview-canvas=""
        width={CANVAS_W}
        height={CANVAS_H}
        className="max-h-full max-w-full object-contain bg-black shadow-e2 ring-1 ring-white/10"
      />
      {platformFrame !== 'none' && canvasBox && (
        <PlatformFrameOverlay kind={platformFrame} box={canvasBox} />
      )}
      {selectionRect && canvasBox && (
        <SelectionOverlay
          canvasBox={canvasBox}
          canvasHeight={CANVAS_H}
          canvasWidth={CANVAS_W}
          rect={selectionRect}
        />
      )}
      {clips.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-text-3">
          Drag media to the timeline to start
        </div>
      )}
      {decoderWarn && (
        <div
          className="pointer-events-none absolute bottom-2 left-1/2 z-20 max-w-[90%] -translate-x-1/2 rounded border border-warning/40 bg-black/80 px-2 py-1 text-center text-2xs text-warning shadow-e2"
          role="status"
        >
          {decoderWarn}
        </div>
      )}
    </div>
  )
}

// Setting currentTime while a seek is still in flight aborts/restarts the
// browser's decoder seek. During a user seek the render loop can run many
// times before `seeked`; blindly assigning on every tick leaves the element
// seeking forever, so audio advances while the canvas remains on the old frame.
function syncSeek(el: HTMLVideoElement, sec: number) {
  if (!Number.isFinite(sec)) return
  // Let the current decoder seek finish. If the transport moved again while
  // it was in flight, the next seeked-triggered paint will correct to the
  // latest playhead instead of aborting/restarting this seek every RAF.
  if (el.seeking) return
  if (!el.seeking && Math.abs(el.currentTime - sec) < 1 / 120) {
    return
  }
  try {
    el.currentTime = sec
  } catch {
    /* out of range */
  }
}

/** Placeholder when a protected mapping has no private decoder — never steal another mapping's frame. */
function drawMissingVideoPlaceholder(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  transform: ClipTransform,
  reason: 'loading' | 'decoder-limit' = 'decoder-limit',
): void {
  ctx.save()
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2)
  ctx.rotate(((transform.rotation ?? 0) * Math.PI) / 180)
  const sx = transform.flipH ? -1 : 1
  const sy = transform.flipV ? -1 : 1
  ctx.scale(sx, sy)
  ctx.fillStyle = 'rgba(40,40,48,0.92)'
  ctx.fillRect(-rect.w / 2, -rect.h / 2, rect.w, rect.h)
  ctx.strokeStyle = 'rgba(255,180,60,0.55)'
  ctx.lineWidth = Math.max(1, Math.min(rect.w, rect.h) * 0.01)
  ctx.strokeRect(-rect.w / 2 + 1, -rect.h / 2 + 1, rect.w - 2, rect.h - 2)
  ctx.fillStyle = 'rgba(255,200,80,0.9)'
  const fontPx = Math.max(10, Math.min(18, rect.h * 0.08))
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(reason === 'loading' ? 'Loading video frame' : 'Video unavailable', 0, -fontPx * 0.4)
  ctx.font = `400 ${Math.max(9, fontPx * 0.75)}px system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255,220,140,0.75)'
  ctx.fillText(reason === 'loading' ? '(decoding)' : '(decoder limit)', 0, fontPx * 0.7)
  ctx.restore()
}

function PlatformFrameOverlay({ kind, box }: { kind: PlatformFrame; box: Rect }) {
  const scale = clamp(Math.min(box.w / 405, box.h / 720), 0.38, 1.12)
  const compact = box.w < 260
  const sideIcons: { icon: LucideIcon; label?: string; avatar?: boolean }[] =
    kind === 'shorts'
      ? [
          { icon: Heart, label: '2.8M' },
          { icon: ThumbsDown, label: 'Dislike' },
          { icon: MessageCircle, label: '2.8M' },
          { icon: Share2, label: '2.8M' },
          { icon: Repeat2, label: '2.8M' },
          { icon: Youtube, label: '' },
        ]
      : kind === 'reels'
        ? [
            { icon: Heart },
            { icon: MessageCircle },
            { icon: Send },
            { icon: MoreHorizontal, label: '' },
            { icon: Camera, label: '' },
          ]
        : [
            { icon: UserCircle, label: '' },
            { icon: Heart, label: '2.8M' },
            { icon: MessageCircle, label: '2.8M' },
            { icon: Bookmark, label: '2.8M' },
            { icon: Share2, label: '2.8M' },
            { icon: Music2, label: '' },
          ]
  const railBottom = kind === 'reels' ? '4.2%' : '7.2%'
  const railGap = kind === 'shorts' ? 15 * scale : kind === 'reels' ? 22 * scale : 14 * scale

  return (
    <div
      className="pointer-events-none absolute z-10 overflow-hidden text-white"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, fontSize: 12 * scale }}
    >
      <div className="absolute inset-0 ring-1 ring-white/10" />
      <div className="absolute inset-x-0 top-0 h-[17%] bg-gradient-to-b from-black/76 via-black/24 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-[26%] bg-gradient-to-t from-black/72 via-black/28 to-transparent" />

      <div className="absolute left-[6.6%] right-[6.6%] top-[3.2%] flex items-center justify-between text-white/78">
        <span className="font-semibold tabular-nums" style={{ fontSize: 15 * scale }}>
          9:41
        </span>
        <div className="flex items-center gap-1 opacity-80">
          <span className="flex h-3 items-end gap-0.5">
            {[4, 6, 8, 10].map((h) => (
              <span key={h} className="w-0.5 rounded bg-white/75" style={{ height: h * scale }} />
            ))}
          </span>
          <span className="h-2.5 w-4 rounded-sm border border-white/70 p-px">
            <span className="block h-full w-[72%] rounded-[1px] bg-white/80" />
          </span>
        </div>
      </div>

      {kind === 'tiktok' && (
        <div className="absolute left-[18%] right-[18%] top-[11.2%] flex items-center justify-center gap-[9%] font-semibold text-white/40">
          <span>Explore</span>
          <span>Following</span>
          <span className="relative text-white/80">
            For You
            <span
              className="absolute left-1/2 h-0.5 -translate-x-1/2 rounded bg-white/80"
              style={{ bottom: -5 * scale, width: 27 * scale }}
            />
          </span>
        </div>
      )}

      <PlatformTopActions kind={kind} scale={scale} />

      <div className="absolute bottom-[3.7%] left-[3.5%] max-w-[68%] text-white">
        <PlatformMetaChrome kind={kind} scale={scale} compact={compact} />
      </div>

      <div
        className="absolute right-[4.8%] flex flex-col items-center text-white/72"
        style={{ bottom: railBottom, gap: railGap }}
      >
        {sideIcons.map(({ icon: Icon, label }, i) => (
          <div key={`${kind}-${i}`} className="flex flex-col items-center gap-1">
            <span
              className={
                kind === 'tiktok' && i === 0
                  ? 'grid place-items-center rounded-full bg-white/75 text-black ring-2 ring-black/25'
                  : kind === 'reels' && i === sideIcons.length - 1
                    ? 'grid place-items-center rounded-md bg-white/14 text-white/72'
                    : ''
              }
              style={
                kind === 'tiktok' && i === 0
                  ? { width: 32 * scale, height: 32 * scale }
                  : kind === 'reels' && i === sideIcons.length - 1
                    ? { width: 31 * scale, height: 31 * scale }
                    : undefined
              }
            >
              <Icon
                size={
                  (kind === 'tiktok' && i === 0
                    ? 22
                    : kind === 'reels' && i === sideIcons.length - 1
                      ? 18
                      : 24) * scale
                }
                strokeWidth={kind === 'shorts' ? 2.35 : 2.2}
              />
            </span>
            {label && !compact && (
              <span className="text-[0.82em] font-semibold text-white/58">{label}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function PlatformTopActions({ kind, scale }: { kind: PlatformFrame; scale: number }) {
  if (kind === 'reels') {
    return (
      <>
        <Search className="absolute left-[7.2%] top-[10.6%] text-white/70" size={23 * scale} />
        <Camera className="absolute right-[6.6%] top-[10.4%] text-white/70" size={22 * scale} />
      </>
    )
  }

  return (
    <div className="absolute right-[6.6%] top-[10.4%] flex items-center text-white/70">
      {kind === 'shorts' ? (
        <span className="flex items-center" style={{ gap: 16 * scale }}>
          <Search size={23 * scale} />
          <MoreVertical size={20 * scale} />
        </span>
      ) : (
        <Search size={24 * scale} />
      )}
    </div>
  )
}

function PlatformMetaChrome({
  compact,
  kind,
  scale,
}: {
  compact: boolean
  kind: PlatformFrame
  scale: number
}) {
  if (kind === 'shorts') {
    return (
      <div className="space-y-2.5 drop-shadow-[0_2px_3px_rgba(0,0,0,0.85)]">
        <div className="flex items-center gap-2">
          <PlatformAvatar scale={scale} />
          <span className="font-semibold text-white/76" style={{ fontSize: 13.5 * scale }}>
            @Your name
          </span>
        </div>
        {!compact && (
          <p className="text-white/56" style={{ fontSize: 13 * scale }}>
            Here are some descriptions about videos
          </p>
        )}
      </div>
    )
  }

  if (kind === 'reels') {
    return (
      <div className="space-y-2.5 drop-shadow-[0_2px_3px_rgba(0,0,0,0.85)]">
        <div className="flex items-center gap-2">
          <PlatformAvatar scale={scale} />
          <span className="font-semibold text-white/76" style={{ fontSize: 13.5 * scale }}>
            @Your name
          </span>
        </div>
        {!compact && (
          <>
            <p className="text-white/56" style={{ fontSize: 13 * scale }}>
              Here are some descriptions about videos
            </p>
            <div
              className="flex items-center gap-1.5 text-white/42"
              style={{ fontSize: 12 * scale }}
            >
              <Music2 size={12 * scale} />
              <span>Music name</span>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2 drop-shadow-[0_2px_3px_rgba(0,0,0,0.9)]">
      <div className="font-semibold leading-none text-white/70" style={{ fontSize: 20 * scale }}>
        Your name
      </div>
      {!compact && (
        <>
          <p className="text-white/56" style={{ fontSize: 15 * scale }}>
            Here are some descriptions about videos
          </p>
          <p className="text-white/42" style={{ fontSize: 14 * scale }}>
            See original
          </p>
        </>
      )}
    </div>
  )
}

function PlatformAvatar({ scale }: { scale: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-white/76 text-black/82 shadow-[0_2px_8px_rgba(0,0,0,0.45)] ring-1 ring-black/45"
      style={{ width: 34 * scale, height: 34 * scale }}
    >
      <UserCircle size={24 * scale} strokeWidth={2.2} />
    </span>
  )
}

function resolveTransform(clip: Clip): ClipTransform {
  return { ...makeDefaultTransform(), ...clip.transform }
}

function getMediaRect(
  src: HTMLVideoElement | HTMLImageElement,
  cw: number,
  ch: number,
  transform: ClipTransform,
): Rect {
  const sw = src instanceof HTMLVideoElement ? src.videoWidth || cw : src.naturalWidth || cw
  const sh = src instanceof HTMLVideoElement ? src.videoHeight || ch : src.naturalHeight || ch
  return getMediaRectFromSize(sw, sh, cw, ch, transform)
}

function getMediaRectFromSize(
  sw: number,
  sh: number,
  cw: number,
  ch: number,
  transform: ClipTransform,
): Rect {
  return getExportMediaRect(sw, sh, cw, ch, transform)
}

function drawMedia(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement | HTMLImageElement,
  cw: number,
  ch: number,
  transform: ClipTransform,
): Rect {
  const t = { ...makeDefaultTransform(), ...transform }
  const rect = getMediaRect(src, cw, ch, t)
  const sw = src instanceof HTMLVideoElement ? src.videoWidth || cw : src.naturalWidth || cw
  const sh = src instanceof HTMLVideoElement ? src.videoHeight || ch : src.naturalHeight || ch
  // Source sub-rectangle to draw (crop); full frame when no crop is set.
  const crop = t.crop
  const sx = crop ? sw * crop.l : 0
  const sy = crop ? sh * crop.t : 0
  const sWidth = crop ? sw * Math.max(0.02, 1 - crop.l - crop.r) : sw
  const sHeight = crop ? sh * Math.max(0.02, 1 - crop.t - crop.b) : sh
  ctx.save()
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2)
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180)
  if (t.flipH || t.flipV) ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1)
  ctx.drawImage(src, sx, sy, sWidth, sHeight, -rect.w / 2, -rect.h / 2, rect.w, rect.h)
  ctx.restore()
  return rect
}

function drawCanvasFill(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement | HTMLImageElement,
  cw: number,
  ch: number,
  transform: ClipTransform,
  canvasFill: ClipCanvasFill | undefined,
  adjustFilter: string,
): void {
  if (canvasFill?.mode !== 'blur') return
  const t = { ...makeDefaultTransform(), ...transform }
  const sw = src instanceof HTMLVideoElement ? src.videoWidth || cw : src.naturalWidth || cw
  const sh = src instanceof HTMLVideoElement ? src.videoHeight || ch : src.naturalHeight || ch
  const crop = t.crop
  const sx = crop ? sw * crop.l : 0
  const sy = crop ? sh * crop.t : 0
  const sWidth = crop ? sw * Math.max(0.02, 1 - crop.l - crop.r) : sw
  const sHeight = crop ? sh * Math.max(0.02, 1 - crop.t - crop.b) : sh
  const coverScale = Math.max(cw / sWidth, ch / sHeight) * Math.max(1, canvasFill.scale ?? 1.08)
  const dw = sWidth * coverScale
  const dh = sHeight * coverScale
  // blurPx is authored at BLUR_REF_HEIGHT (this canvas) — factor is 1 here, but
  // keeps the semantics explicit and correct if COMP_H ever changes.
  const blur = Math.max(0, Math.min(80, canvasFill.blurPx ?? 34)) * (ch / BLUR_REF_HEIGHT)
  const opacity = Math.max(0, Math.min(1, canvasFill.opacity ?? 1))

  ctx.save()
  ctx.globalAlpha *= opacity
  ctx.filter = [adjustFilter === 'none' ? '' : adjustFilter, `blur(${blur}px)`, 'brightness(0.82)']
    .filter(Boolean)
    .join(' ')
  ctx.drawImage(src, sx, sy, sWidth, sHeight, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
  ctx.restore()
}

function getBlurStickerRect(fx: BlurStickerData, cw: number, ch: number): Rect {
  const w = Math.max(1, fx.w * cw)
  const h = Math.max(1, fx.h * ch)
  return { x: fx.x * cw - w / 2, y: fx.y * ch - h / 2, w, h }
}

/** Full-frame look filter: snapshot the composited frame, then redraw it back
 *  through the CSS filter (ctx.filter can't read+write the same canvas safely). */
function drawFilterFx(
  ctx: CanvasRenderingContext2D,
  filterStr: string,
  cw: number,
  ch: number,
): void {
  if (!filterStr || cw < 1 || ch < 1) return
  const bctx = getFxBuffer('preview-filter', cw, ch)
  if (!bctx) return
  bctx.clearRect(0, 0, cw, ch)
  bctx.drawImage(ctx.canvas, 0, 0, cw, ch, 0, 0, cw, ch)
  ctx.save()
  ctx.filter = filterStr
  ctx.drawImage(bctx.canvas, 0, 0, cw, ch)
  ctx.filter = 'none'
  ctx.restore()
}

function drawBlurSticker(
  ctx: CanvasRenderingContext2D,
  fx: BlurStickerData,
  cw: number,
  ch: number,
): void {
  const rect = clampRect(getBlurStickerRect(fx, cw, ch), cw, ch)
  if (rect.w < 1 || rect.h < 1) return
  const blur = Math.max(0, Math.min(80, fx.blurPx)) * (ch / BLUR_REF_HEIGHT)
  const pad = Math.ceil(blur * 2)
  const sx = Math.max(0, Math.floor(rect.x - pad))
  const sy = Math.max(0, Math.floor(rect.y - pad))
  const sw = Math.min(cw - sx, Math.ceil(rect.w + pad * 2))
  const sh = Math.min(ch - sy, Math.ceil(rect.h + pad * 2))
  if (sw <= 0 || sh <= 0) return

  const bctx = getFxBuffer('preview-blur', sw, sh)
  if (!bctx) return
  bctx.clearRect(0, 0, sw, sh)
  bctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh)

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, Math.max(0, fx.radius))
  ctx.clip()
  ctx.filter = `blur(${blur}px)`
  ctx.drawImage(bctx.canvas, sx, sy, sw, sh)
  ctx.filter = 'none'
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, Math.max(0, fx.radius))
  ctx.stroke()
  ctx.restore()
}

function clampRect(rect: Rect, cw: number, ch: number): Rect {
  const x = Math.max(0, Math.min(cw, rect.x))
  const y = Math.max(0, Math.min(ch, rect.y))
  const right = Math.max(x, Math.min(cw, rect.x + rect.w))
  const bottom = Math.max(y, Math.min(ch, rect.y + rect.h))
  return { x, y, w: right - x, h: bottom - y }
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

function getTextRect(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  align: CanvasTextAlign,
  transform: ClipTransform,
  frameWidth: number,
): Rect {
  const t = { ...makeDefaultTransform(), ...transform }
  const sx = textAxisScale(t, 'x')
  const sy = textAxisScale(t, 'y')
  const maxWidth = (frameWidth * TEXT_MAX_WIDTH_RATIO) / sx
  const local = measureWrappedTextCached(ctx, text, fontSize, align, maxWidth).rect
  return { x: x + local.x * sx, y: y + local.y * sy, w: local.w * sx, h: local.h * sy }
}

async function loadTextClipFonts(clips: Clip[]): Promise<void> {
  if (!('fonts' in document)) return
  const seen = new Set<string>()
  const requests: Promise<unknown>[] = []
  const families = new Set<string>()
  for (const clip of clips) {
    const td = clip.textData
    if (!td) continue
    const key = `${td.fontWeight}|${td.fontFamily}`
    if (seen.has(key)) continue
    seen.add(key)
    families.add(td.fontFamily)
  }
  await registerCaptionFontFaces(families, document.fonts)
  for (const clip of clips) {
    const td = clip.textData
    if (!td) continue
    const key = `${td.fontWeight}|${td.fontFamily}`
    if (!seen.delete(key)) continue
    requests.push(document.fonts.load(`${td.fontWeight} 64px ${td.fontFamily}`, td.content || 'Hg'))
  }
  await Promise.all(requests)
}

interface SelectedOverlayRectParams {
  assets: MediaAsset[]
  canvas: HTMLCanvasElement | null
  clips: Clip[]
  currentSec: number
  height: number
  imagePool: Map<string, HTMLImageElement>
  selectedClipIds: string[]
  tracks: Track[]
  videoPool: PreviewVideoPool
  getVideoEl: (clip: Clip) => HTMLVideoElement | undefined
  width: number
}

function getSelectedOverlayRect({
  assets,
  canvas,
  clips,
  currentSec,
  height,
  imagePool,
  selectedClipIds,
  tracks,
  getVideoEl,
  width,
}: SelectedOverlayRectParams): Rect | null {
  const clip = selectedClipIds
    .map((id) => clips.find((candidate) => candidate.id === id))
    .find((candidate): candidate is Clip => !!candidate && clipIsActiveAt(candidate, currentSec))
  if (!clip) return null

  const track = tracks.find((candidate) => candidate.id === clip.trackId)
  if (track?.kind === 'fx' && clip.fxData?.type === 'blur-sticker') {
    return getBlurStickerRect(clip.fxData, width, height)
  }

  if (track?.kind === 'text' && clip.textData && canvas) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const td = clip.textData
    const fontSize = Math.round((td.fontSize / 1080) * height)
    ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
    ctx.letterSpacing = `${((td.letterSpacing ?? 0) / 1080) * height}px`
    ctx.wordSpacing = `${(resolvedTextWordSpacing(td) / 1080) * height}px`
    const rect = getTextRect(
      ctx,
      td.content,
      td.x * width,
      td.y * height,
      fontSize,
      td.align,
      resolveClipTransformAt(clip, currentSec),
      width,
    )
    ctx.letterSpacing = '0px'
    ctx.wordSpacing = '0px'
    return rect
  }

  // Compound clip: full-frame sub-video, sized by its own transform.
  if (clip.compoundId) {
    return getMediaRectFromSize(
      width,
      height,
      width,
      height,
      resolveClipTransformAt(clip, currentSec),
    )
  }

  if (!clip.assetId) return null
  const asset = assets.find((candidate) => candidate.id === clip.assetId)
  if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) return null

  if (asset.kind === 'image') {
    const img = imagePool.get(asset.id)
    if (img && img.complete && img.naturalWidth > 0) {
      return getMediaRect(img, width, height, resolveClipTransformAt(clip, currentSec))
    }
  } else {
    const el = getVideoEl(clip)
    if (el && el.readyState >= 2) {
      return getMediaRect(el, width, height, resolveClipTransformAt(clip, currentSec))
    }
  }

  if (asset.width && asset.height) {
    return getMediaRectFromSize(
      asset.width,
      asset.height,
      width,
      height,
      resolveClipTransformAt(clip, currentSec),
    )
  }
  return null
}

interface SelectionOverlayProps {
  canvasBox: Rect
  canvasWidth: number
  canvasHeight: number
  rect: Rect
}

function SelectionOverlay({ canvasBox, canvasHeight, canvasWidth, rect }: SelectionOverlayProps) {
  const sx = canvasBox.w / canvasWidth
  const sy = canvasBox.h / canvasHeight
  const left = canvasBox.x + rect.x * sx - 4
  const top = canvasBox.y + rect.y * sy - 4
  const width = rect.w * sx + 8
  const height = rect.h * sy + 8
  const handles: [string, string][] = [
    ['0%', '0%'],
    ['50%', '0%'],
    ['100%', '0%'],
    ['100%', '50%'],
    ['100%', '100%'],
    ['50%', '100%'],
    ['0%', '100%'],
    ['0%', '50%'],
  ]

  return (
    <div
      className="pointer-events-none absolute z-20 border border-[#d6d6d6]"
      style={{ left, top, width, height, boxShadow: '0 0 0 1px rgba(0,0,0,0.35)' }}
    >
      {handles.map(([x, y]) => (
        <span
          key={`${x}-${y}`}
          className="absolute h-2 w-2 rounded-full bg-[#d6d6d6] ring-1 ring-black/50"
          style={{ left: x, top: y, transform: 'translate(-50%, -50%)' }}
        />
      ))}
    </div>
  )
}

function drawFrameOverlay(ctx: CanvasRenderingContext2D, frame: Rect): void {
  ctx.save()
  ctx.filter = 'none'
  ctx.globalAlpha = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.lineWidth = 2
  ctx.setLineDash([])
  ctx.strokeRect(frame.x - 1, frame.y - 1, frame.w + 2, frame.h + 2)
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'
  ctx.lineWidth = 1
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h)
  ctx.restore()
}

function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  guides: SnapGuide[],
  cw: number,
  ch: number,
): void {
  if (guides.length === 0) return
  ctx.save()
  ctx.filter = 'none'
  ctx.globalAlpha = 1
  ctx.strokeStyle = '#4f9cf9'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  for (const guide of guides) {
    ctx.beginPath()
    if (guide.axis === 'x') {
      ctx.moveTo(guide.pos, 0)
      ctx.lineTo(guide.pos, ch)
    } else {
      ctx.moveTo(0, guide.pos)
      ctx.lineTo(cw, guide.pos)
    }
    ctx.stroke()
  }
  ctx.restore()
}

function getSelectionHandles(rect: Rect): Record<SelectionHandle, { x: number; y: number }> {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  return {
    nw: { x: rect.x - 4, y: rect.y - 4 },
    n: { x: cx, y: rect.y - 4 },
    ne: { x: rect.x + rect.w + 4, y: rect.y - 4 },
    e: { x: rect.x + rect.w + 4, y: cy },
    se: { x: rect.x + rect.w + 4, y: rect.y + rect.h + 4 },
    s: { x: cx, y: rect.y + rect.h + 4 },
    sw: { x: rect.x - 4, y: rect.y + rect.h + 4 },
    w: { x: rect.x - 4, y: cy },
  }
}

function getSelectionHandleAt(x: number, y: number, rect: Rect): SelectionHandle | null {
  const handles = getSelectionHandles(rect)
  for (const handle of Object.keys(handles) as SelectionHandle[]) {
    const pos = handles[handle]
    if (Math.abs(x - pos.x) <= HANDLE_HIT_PX && Math.abs(y - pos.y) <= HANDLE_HIT_PX) {
      return handle
    }
  }
  return null
}

function snapMovedRect(
  drag: DragState,
  rawX: number,
  rawY: number,
  cw: number,
  ch: number,
): { dx: number; dy: number; guides: SnapGuide[] } {
  if (!drag.startRect || !drag.startAnchor) return { dx: 0, dy: 0, guides: [] }
  const proposed: Rect = {
    ...drag.startRect,
    x: drag.startRect.x + (rawX - drag.startAnchor.x) * cw,
    y: drag.startRect.y + (rawY - drag.startAnchor.y) * ch,
  }
  return snapRectToCanvas(proposed, cw, ch)
}

function snapRectToCanvas(
  rect: Rect,
  cw: number,
  ch: number,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const xSnap = closestSnap([
    { value: rect.x, target: 0 },
    { value: rect.x + rect.w / 2, target: cw / 2 },
    { value: rect.x + rect.w, target: cw },
  ])
  const ySnap = closestSnap([
    { value: rect.y, target: 0 },
    { value: rect.y + rect.h / 2, target: ch / 2 },
    { value: rect.y + rect.h, target: ch },
  ])

  const guides: SnapGuide[] = []
  if (xSnap) guides.push({ axis: 'x', pos: xSnap.target })
  if (ySnap) guides.push({ axis: 'y', pos: ySnap.target })
  return {
    dx: xSnap ? xSnap.target - xSnap.value : 0,
    dy: ySnap ? ySnap.target - ySnap.value : 0,
    guides,
  }
}

function closestSnap(
  candidates: { value: number; target: number }[],
): { value: number; target: number } | null {
  let best: { value: number; target: number; dist: number } | null = null
  for (const candidate of candidates) {
    const dist = Math.abs(candidate.value - candidate.target)
    if (dist > SNAP_THRESHOLD_PX) continue
    if (!best || dist < best.dist) best = { ...candidate, dist }
  }
  return best ? { value: best.value, target: best.target } : null
}

function resizeDraggedClip(
  drag: DragState,
  point: { x: number; y: number },
  cw: number,
  ch: number,
  setClipText: (id: string, text: { x?: number; y?: number; fontSize?: number }) => void,
  setClipTransform: (id: string, transform: Partial<ClipTransform>) => void,
  setClipFxData: (id: string, fxData: Partial<BlurStickerData>) => void,
): SnapGuide[] {
  if (!drag.handle || !drag.startRect) return []
  const result = isCornerHandle(drag.handle)
    ? getUniformResizeResult(drag, point, cw, ch)
    : getStretchResizeResult(drag.startRect, drag.handle, point, cw, ch)

  if (drag.kind === 'text' && drag.startText) {
    applyTextResize(drag, result, cw, ch, setClipText, setClipTransform)
  } else if (drag.kind === 'media' && drag.startTransform) {
    applyMediaResize(drag, result, cw, ch, setClipTransform)
  } else if (drag.kind === 'fx' && drag.startFx) {
    applyFxResize(drag, result, cw, ch, setClipFxData)
  }
  return result.guides
}

interface ResizeResult {
  rect: Rect
  guides: SnapGuide[]
  uniformRatio?: number
  widthRatio: number
  heightRatio: number
}

function getUniformResizeResult(
  drag: DragState,
  point: { x: number; y: number },
  cw: number,
  ch: number,
): ResizeResult {
  const startRect = drag.startRect!
  const handle = drag.handle!
  const fixed = getOppositeCorner(startRect, handle)
  const startHandle = getSelectionHandles(startRect)[handle]
  const startDistance = distance(fixed, startHandle)
  const nextDistance = distance(fixed, point)
  const limits = getUniformRatioLimits(drag)
  let ratio = clamp(startDistance > 0 ? nextDistance / startDistance : 1, limits.min, limits.max)
  let guides: SnapGuide[] = []

  const proposed = rectFromUniformRatio(startRect, handle, ratio)
  const snap = getUniformResizeSnap(startRect, handle, proposed, cw, ch, limits)
  if (snap) {
    ratio = snap.ratio
    guides = [snap.guide]
  }

  const rect = rectFromUniformRatio(startRect, handle, ratio)
  return {
    rect,
    guides,
    uniformRatio: ratio,
    widthRatio: rect.w / startRect.w,
    heightRatio: rect.h / startRect.h,
  }
}

function getStretchResizeResult(
  startRect: Rect,
  handle: SelectionHandle,
  point: { x: number; y: number },
  cw: number,
  ch: number,
): ResizeResult {
  const minSize = 4
  const rect = { ...startRect }
  const guides: SnapGuide[] = []

  if (handle === 'e' || handle === 'w') {
    const right = startRect.x + startRect.w
    const current = handle === 'e' ? point.x : point.x
    const snap = getEdgeResizeSnap(current, cw, handle === 'e' ? startRect.x : right, handle)
    const edge = snap?.target ?? current
    if (snap) guides.push({ axis: 'x', pos: snap.target })
    if (handle === 'e') {
      rect.w = Math.max(minSize, edge - startRect.x)
    } else {
      const left = Math.min(right - minSize, edge)
      rect.x = left
      rect.w = right - left
    }
  }

  if (handle === 'n' || handle === 's') {
    const bottom = startRect.y + startRect.h
    const current = handle === 's' ? point.y : point.y
    const snap = getEdgeResizeSnap(current, ch, handle === 's' ? startRect.y : bottom, handle)
    const edge = snap?.target ?? current
    if (snap) guides.push({ axis: 'y', pos: snap.target })
    if (handle === 's') {
      rect.h = Math.max(minSize, edge - startRect.y)
    } else {
      const top = Math.min(bottom - minSize, edge)
      rect.y = top
      rect.h = bottom - top
    }
  }

  return {
    rect,
    guides,
    widthRatio: rect.w / startRect.w,
    heightRatio: rect.h / startRect.h,
  }
}

function applyMediaResize(
  drag: DragState,
  result: ResizeResult,
  cw: number,
  ch: number,
  setClipTransform: (id: string, transform: Partial<ClipTransform>) => void,
): void {
  const transform = drag.startTransform
  if (!transform) return
  const center = rectCenter(result.rect)
  const next: Partial<ClipTransform> = {
    x: center.x / cw,
    y: center.y / ch,
  }

  if (result.uniformRatio !== undefined) {
    next.scale = clamp(transform.scale * result.uniformRatio, MIN_MEDIA_SCALE, MAX_MEDIA_SCALE)
  } else {
    if (drag.handle === 'e' || drag.handle === 'w') {
      next.scaleX = clamp(transform.scaleX * result.widthRatio, MIN_AXIS_SCALE, MAX_AXIS_SCALE)
    }
    if (drag.handle === 'n' || drag.handle === 's') {
      next.scaleY = clamp(transform.scaleY * result.heightRatio, MIN_AXIS_SCALE, MAX_AXIS_SCALE)
    }
  }

  setClipTransform(drag.clipId, next)
}

function applyTextResize(
  drag: DragState,
  result: ResizeResult,
  cw: number,
  ch: number,
  setClipText: (id: string, text: { x?: number; y?: number; fontSize?: number }) => void,
  setClipTransform: (id: string, transform: Partial<ClipTransform>) => void,
): void {
  const text = drag.startText
  const transform = drag.startTransform
  if (!text || !transform) return
  const anchor = textAnchorFromRect(result.rect, text.align)

  if (result.uniformRatio !== undefined) {
    setClipText(drag.clipId, {
      x: anchor.x / cw,
      y: anchor.y / ch,
      fontSize: clamp(text.fontSize * result.uniformRatio, MIN_TEXT_FONT_SIZE, MAX_TEXT_FONT_SIZE),
    })
    return
  }

  const nextTransform: Partial<ClipTransform> = {}
  if (drag.handle === 'e' || drag.handle === 'w') {
    nextTransform.scaleX = clamp(
      transform.scaleX * result.widthRatio,
      MIN_AXIS_SCALE,
      MAX_AXIS_SCALE,
    )
  }
  if (drag.handle === 'n' || drag.handle === 's') {
    nextTransform.scaleY = clamp(
      transform.scaleY * result.heightRatio,
      MIN_AXIS_SCALE,
      MAX_AXIS_SCALE,
    )
  }
  setClipTransform(drag.clipId, nextTransform)
  setClipText(drag.clipId, {
    x: anchor.x / cw,
    y: anchor.y / ch,
  })
}

function applyFxResize(
  drag: DragState,
  result: ResizeResult,
  cw: number,
  ch: number,
  setClipFxData: (id: string, fxData: Partial<BlurStickerData>) => void,
): void {
  const fx = drag.startFx
  if (!fx) return
  const center = rectCenter(result.rect)
  setClipFxData(drag.clipId, {
    x: center.x / cw,
    y: center.y / ch,
    w: clamp(fx.w * result.widthRatio, 0.03, 1),
    h: clamp(fx.h * result.heightRatio, 0.03, 1),
  })
}

function getUniformRatioLimits(drag: DragState): { min: number; max: number } {
  if (drag.kind === 'fx' && drag.startFx) {
    return {
      min: Math.max(0.03 / Math.max(0.01, drag.startFx.w), 0.03 / Math.max(0.01, drag.startFx.h)),
      max: Math.min(1 / Math.max(0.01, drag.startFx.w), 1 / Math.max(0.01, drag.startFx.h)),
    }
  }
  if (drag.kind === 'text' && drag.startText) {
    return {
      min: MIN_TEXT_FONT_SIZE / Math.max(1, drag.startText.fontSize),
      max: MAX_TEXT_FONT_SIZE / Math.max(1, drag.startText.fontSize),
    }
  }
  const startScale = Math.max(MIN_MEDIA_SCALE, drag.startTransform?.scale ?? 1)
  return {
    min: MIN_MEDIA_SCALE / startScale,
    max: MAX_MEDIA_SCALE / startScale,
  }
}

function getUniformResizeSnap(
  startRect: Rect,
  handle: SelectionHandle,
  proposed: Rect,
  cw: number,
  ch: number,
  limits: { min: number; max: number },
): { ratio: number; guide: SnapGuide } | null {
  const fixed = getOppositeCorner(startRect, handle)
  const candidates: { ratio: number; dist: number; guide: SnapGuide }[] = []

  const movingX = handle.includes('e') ? proposed.x + proposed.w : proposed.x
  for (const target of [0, cw / 2, cw]) {
    const ratio = handle.includes('e')
      ? (target - fixed.x) / startRect.w
      : (fixed.x - target) / startRect.w
    const dist = Math.abs(movingX - target)
    if (dist <= SNAP_THRESHOLD_PX && ratio >= limits.min && ratio <= limits.max) {
      candidates.push({ ratio, dist, guide: { axis: 'x', pos: target } })
    }
  }

  const movingY = handle.includes('s') ? proposed.y + proposed.h : proposed.y
  for (const target of [0, ch / 2, ch]) {
    const ratio = handle.includes('s')
      ? (target - fixed.y) / startRect.h
      : (fixed.y - target) / startRect.h
    const dist = Math.abs(movingY - target)
    if (dist <= SNAP_THRESHOLD_PX && ratio >= limits.min && ratio <= limits.max) {
      candidates.push({ ratio, dist, guide: { axis: 'y', pos: target } })
    }
  }

  candidates.sort((a, b) => a.dist - b.dist)
  return candidates[0] ?? null
}

function getEdgeResizeSnap(
  currentEdge: number,
  axisLength: number,
  fixedEdge: number,
  handle: SelectionHandle,
): { target: number } | null {
  const targets = [0, axisLength / 2, axisLength]
  const valid = targets.filter((target) => {
    if (handle === 'e' || handle === 's') return target > fixedEdge + 4
    return target < fixedEdge - 4
  })
  let best: { target: number; dist: number } | null = null
  for (const target of valid) {
    const dist = Math.abs(currentEdge - target)
    if (dist > SNAP_THRESHOLD_PX) continue
    if (!best || dist < best.dist) best = { target, dist }
  }
  return best ? { target: best.target } : null
}

function rectFromUniformRatio(startRect: Rect, handle: SelectionHandle, ratio: number): Rect {
  const w = startRect.w * ratio
  const h = startRect.h * ratio
  const fixed = getOppositeCorner(startRect, handle)

  return {
    x: handle.includes('e') ? fixed.x : fixed.x - w,
    y: handle.includes('s') ? fixed.y : fixed.y - h,
    w,
    h,
  }
}

function getOppositeCorner(rect: Rect, handle: SelectionHandle): { x: number; y: number } {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  return {
    x: handle.includes('e') ? rect.x : right,
    y: handle.includes('s') ? rect.y : bottom,
  }
}

function isCornerHandle(handle: SelectionHandle): boolean {
  return handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw'
}

function textAnchorFromRect(
  rect: Rect,
  align: 'left' | 'center' | 'right',
): { x: number; y: number } {
  const x = align === 'left' ? rect.x : align === 'right' ? rect.x + rect.w : rect.x + rect.w / 2
  return { x, y: rect.y + rect.h / 2 }
}

function rectCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function pickHitFromStack(
  hits: HitResult[],
  point: { x: number; y: number },
  cycleRef: React.MutableRefObject<ClickCycleState | null>,
): HitResult | null {
  if (hits.length === 0) return null
  if (hits[0]?.handle || hits.length === 1) {
    cycleRef.current = null
    return hits[0] ?? null
  }

  const signature = hits.map((hit) => hit.clip.id).join('|')
  const prev = cycleRef.current
  const sameStack =
    !!prev && prev.signature === signature && Math.hypot(prev.x - point.x, prev.y - point.y) <= 8
  const index = sameStack ? prev.nextIndex % hits.length : 0
  cycleRef.current = {
    x: point.x,
    y: point.y,
    signature,
    nextIndex: index + 1,
  }
  return hits[index] ?? hits[0] ?? null
}

function clientToFrame(
  canvas: HTMLCanvasElement,
  frame: Rect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const point = clientToCanvas(canvas, clientX, clientY)
  return {
    x: point.x - frame.x,
    y: point.y - frame.y,
  }
}

function clientToCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / Math.max(1, rect.width)
  const scaleY = canvas.height / Math.max(1, rect.height)
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ── renderFrame lookup cache ──────────────────────────────────────────────────
// Rebuilt only when the clips/tracks/assets references change (they're replaced
// immutably on every edit). Cache hits every tick during playback (no edits) →
// no Map/Set allocations at 60fps.

interface PreviewLookups {
  assetById: Map<string, MediaAsset>
  /** clipId → preview decoder key: a shared chain key for source-continuous
   *  same-asset runs, else the affine sourceMappingKey. */
  videoPlaybackKeyByClipId: Map<string, string>
  videoTrackIds: string[]
  fxTrackIds: string[]
  textTrackIds: string[]
  videoTrackSet: Set<string>
  fxTrackSet: Set<string>
  textTrackSet: Set<string>
  trackById: Map<string, Track>
}

function buildPreviewLookups(
  clips: ReturnType<typeof useTimelineStore.getState>['timeline']['clips'],
  tracks: Track[],
  assets: MediaAsset[],
): PreviewLookups {
  const assetById = new Map<string, MediaAsset>()
  for (const a of assets) assetById.set(a.id, a)
  const videoTrackIds: string[] = []
  const fxTrackIds: string[] = []
  const textTrackIds: string[] = []
  for (const t of tracks) {
    if (t.hidden) continue
    if (t.kind === 'video') videoTrackIds.push(t.id)
    else if (t.kind === 'fx') fxTrackIds.push(t.id)
    else if (t.kind === 'text') textTrackIds.push(t.id)
  }
  const videoTrackSet = new Set(videoTrackIds)
  return {
    assetById,
    videoPlaybackKeyByClipId: buildPreviewPlaybackKeyMap(
      clips.filter((clip) => videoTrackSet.has(clip.trackId)),
    ),
    videoTrackIds,
    fxTrackIds,
    textTrackIds,
    videoTrackSet,
    fxTrackSet: new Set(fxTrackIds),
    textTrackSet: new Set(textTrackIds),
    trackById: new Map(tracks.map((t) => [t.id, t])),
  }
}
