import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  adjustToFilter,
  captionClipIdsOnTrack,
  clipEffectiveDuration,
  clipIsActiveAt,
  clipSourceSec,
  isAdjustNeutral,
  isCaptionClip,
  makeDefaultTransform,
  resolveClipTransformAt,
  resolveClipOpacityAt,
  type Clip,
  type ClipTransform,
  type BlurStickerData,
  type Track,
} from '@engine/timeline'
import { measureWrappedText, drawWrappedLines, drawCaptionReveal, getCurrentRevealUnit } from '@engine/timeline/text-layout'

const TEXT_MAX_WIDTH_RATIO = 0.92 // captions stay within 92% of the frame width
import { mediaManager, type MediaAsset } from '@engine/media'
import { useProjectStore } from '@store/project-store'
import { usePlaybackStore } from '@store/playback-store'
import { useTimelineStore } from '@store/timeline-store'

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

export function PreviewCanvas() {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasBox, setCanvasBox] = useState<Rect | null>(null)

  // Reactive bits used only for canvas sizing + empty-state hint
  const aspect = useProjectStore((s) => s.aspect)
  const currentSec = usePlaybackStore((s) => s.currentSec)
  const isPlaying = usePlaybackStore((s) => s.isPlaying)
  const clips = useTimelineStore((s) => s.timeline.clips)
  const tracks = useTimelineStore((s) => s.timeline.tracks)
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds)
  const selectClips = useTimelineStore((s) => s.selectClips)
  const setClipText = useTimelineStore((s) => s.setClipText)
  const setClipsText = useTimelineStore((s) => s.setClipsText)
  const setClipFxData = useTimelineStore((s) => s.setClipFxData)
  const setClipTransform = useTimelineStore((s) => s.setClipTransform)
  const beginHistoryStep = useTimelineStore((s) => s.beginHistoryStep)
  const assets = useProjectStore((s) => s.assets)

  const FRAME_H = COMP_H
  const FRAME_W = Math.round((COMP_H * aspect.w) / aspect.h)
  const CANVAS_H = FRAME_H
  const CANVAS_W = FRAME_W

  const urlCache = useRef<Map<string, string>>(new Map())
  const videoPool = useRef<Map<string, HTMLVideoElement>>(new Map())
  const imagePool = useRef<Map<string, HTMLImageElement>>(new Map())
  // Which OPFS key (original or proxy) each pooled element was built from — so
  // we can rebuild it when a proxy becomes available / is removed.
  const videoSrcKey = useRef<Map<string, string>>(new Map())
  // Assets whose media element is currently being loaded (async). Prevents the
  // backfill hooks (thumbnail strip / waveform update the asset repeatedly) from
  // spawning duplicate <video> elements before the first finishes loading —
  // which left the preview black until a reload.
  const loadingIds = useRef<Set<string>>(new Set())
  const dragRef = useRef<DragState | null>(null)
  // Whether the current drag has already pushed its single undo checkpoint.
  const dragHistoryPushedRef = useRef(false)
  const snapGuidesRef = useRef<SnapGuide[]>([])
  const frameRectRef = useRef<Rect>({ x: 0, y: 0, w: FRAME_W, h: FRAME_H })
  const clickCycleRef = useRef<ClickCycleState | null>(null)
  const hasPaintedRef = useRef(false)
  frameRectRef.current = { x: 0, y: 0, w: FRAME_W, h: FRAME_H }

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
    const { timeline } = useTimelineStore.getState()
    const allAssets = useProjectStore.getState().assets
    const { clips: allClips, tracks: allTracks } = timeline

    const videoTrackIds = allTracks.filter((t) => t.kind === 'video').map((t) => t.id)
    const fxTrackIds = allTracks.filter((t) => t.kind === 'fx').map((t) => t.id)
    const textTrackIds = allTracks.filter((t) => t.kind === 'text').map((t) => t.id)

    const activeVideo = allClips
      .filter((c) => videoTrackIds.includes(c.trackId) && clipIsActiveAt(c, at))
      .sort((a, b) => videoTrackIds.indexOf(b.trackId) - videoTrackIds.indexOf(a.trackId))

    // ── Pre-pass: drive each video element and check whether its target frame
    // is decoded yet. Done BEFORE clearing so we can hold the last frame.
    const activeVideoAssetIds = new Set<string>()
    let allVideoReady = true
    for (const clip of activeVideo) {
      const asset = allAssets.find((a) => a.id === clip.assetId)
      if (!asset || asset.kind !== 'video') continue
      const el = videoPool.current.get(asset.id)
      if (!el) continue
      activeVideoAssetIds.add(asset.id)
      const srcSec = clipSourceSec(clip, at)
      el.playbackRate = Math.max(0.0625, Math.min(16, clip.speed))
      if (playing) {
        if (el.paused) {
          syncSeek(el, srcSec)
          void el.play().catch(() => {})
        } else if (Math.abs(el.currentTime - srcSec) > 0.3) {
          syncSeek(el, srcSec)
        }
      } else {
        if (!el.paused) el.pause()
        // Always retarget to the latest scrub position. The browser coalesces
        // rapid currentTime sets (drops intermediate seeks), so the preview keeps
        // up with fast scrubbing instead of lagging a seek behind.
        if (Math.abs(el.currentTime - srcSec) > 1 / 30) syncSeek(el, srcSec)
      }
      const onTarget = el.readyState >= 2 && (playing || Math.abs(el.currentTime - srcSec) <= 0.04)
      if (!onTarget) allVideoReady = false
    }

    // Pause elements no longer under the playhead
    for (const [id, el] of videoPool.current) {
      if (!activeVideoAssetIds.has(id) && !el.paused) el.pause()
    }

    // While scrubbing/paused, keep the last painted frame until the new one is
    // decoded — avoids the black flash. The 'seeked' handler repaints when ready.
    if (!allVideoReady && hasPaintedRef.current && !playing) return

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

    for (const clip of activeVideo) {
      const asset = allAssets.find((a) => a.id === clip.assetId)
      if (!asset) continue
      ctx.globalAlpha = resolveClipOpacityAt(clip, at)
      ctx.filter = isAdjustNeutral(clip.adjust) ? 'none' : adjustToFilter(clip.adjust)
      if (asset.kind === 'image') {
        const img = imagePool.current.get(asset.id)
        if (img && img.complete && img.naturalWidth > 0) {
          drawMedia(ctx, img, W, H, resolveClipTransformAt(clip, at))
        }
      } else if (asset.kind === 'video') {
        const el = videoPool.current.get(asset.id)
        if (el && el.readyState >= 2) drawMedia(ctx, el, W, H, resolveClipTransformAt(clip, at))
      }
      ctx.filter = 'none'
      ctx.globalAlpha = 1
    }

    const activeFx = allClips
      .filter((c) => fxTrackIds.includes(c.trackId) && clipIsActiveAt(c, at) && c.fxData)
      .sort((a, b) => fxTrackIds.indexOf(b.trackId) - fxTrackIds.indexOf(a.trackId))
    for (const clip of activeFx) {
      if (clip.fxData?.type === 'blur-sticker') drawBlurSticker(ctx, clip.fxData, W, H)
    }

    // Text clips on top
    const activeText = allClips
      .filter((c) => textTrackIds.includes(c.trackId) && clipIsActiveAt(c, at) && c.textData)
      .sort((a, b) => textTrackIds.indexOf(b.trackId) - textTrackIds.indexOf(a.trackId))
    for (const clip of activeText) {
      const td = clip.textData
      if (!td) continue
      ctx.globalAlpha = resolveClipOpacityAt(clip, at)
      const fontSize = Math.round((td.fontSize / 1080) * H)
      ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
      ctx.textAlign = td.align
      ctx.textBaseline = 'middle'
      const x = td.x * W
      const y = td.y * H
      const transform = resolveClipTransformAt(clip, at)
      const sx = textAxisScale(transform, 'x')
      const sy = textAxisScale(transform, 'y')
      // Wrap so the caption never spills past the frame edges.
      const maxWidth = (W * TEXT_MAX_WIDTH_RATIO) / sx
      const { lines, rect } = measureWrappedText(ctx, td.content, fontSize, td.align, maxWidth)

      const isReveal = !!(td.anim && td.anim.kind !== 'none')
      const revealOpts = isReveal
        ? {
            unit: td.anim!.kind === 'group' ? Math.max(1, td.anim!.groupSize) : 1,
            elapsedSec: Math.max(0, at - clip.startSec),
            clipDuration: clipEffectiveDuration(clip),
            wordTimestamps: td.wordTimestamps,
          }
        : null
      const revealUnit = revealOpts ? getCurrentRevealUnit(ctx, lines, fontSize, revealOpts) : null

      if (td.hasBackground) {
        const pad = fontSize * 0.2
        const bgRect = revealUnit ? revealUnit.rect : rect
        const bgPopScale = revealUnit ? revealUnit.popScale : 1
        ctx.save()
        ctx.translate(x, y)
        ctx.scale(sx * bgPopScale, sy * bgPopScale)
        ctx.fillStyle = td.backgroundColor
        ctx.fillRect(bgRect.x - pad, bgRect.y - pad, bgRect.w + pad * 2, bgRect.h + pad * 2)
        ctx.restore()
      }

      const stroke =
        td.stroke && td.stroke.width > 0
          ? { color: td.stroke.color, width: (td.stroke.width / 1080) * H }
          : undefined

      ctx.save()
      ctx.translate(x, y)
      ctx.scale(sx, sy)
      if (!stroke) {
        // Soft shadow only when there's no outline (cleaner with an outline).
        ctx.shadowColor = 'rgba(0,0,0,0.6)'
        ctx.shadowBlur = 4
        ctx.shadowOffsetX = 2
        ctx.shadowOffsetY = 2
      }
      ctx.fillStyle = td.color
      if (revealOpts) {
        drawCaptionReveal(ctx, lines, fontSize, td.align, revealOpts, stroke)
      } else {
        drawWrappedLines(ctx, lines, fontSize, stroke)
      }
      ctx.restore()
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
    }

    drawSnapGuides(ctx, snapGuidesRef.current, W, H)
    ctx.restore()

    drawFrameOverlay(ctx, frame)
  }, [])

  const findHitsAt = useCallback((x: number, y: number): HitResult[] => {
    const canvas = canvasRef.current
    if (!canvas) return []
    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    const at = usePlaybackStore.getState().currentSec
    const { timeline } = useTimelineStore.getState()
    const allAssets = useProjectStore.getState().assets
    const { clips: allClips, tracks: allTracks } = timeline
    const selectedIds = useTimelineStore.getState().selectedClipIds
    const videoTrackIds = allTracks.filter((t) => t.kind === 'video').map((t) => t.id)
    const fxTrackIds = allTracks.filter((t) => t.kind === 'fx').map((t) => t.id)
    const textTrackIds = allTracks.filter((t) => t.kind === 'text').map((t) => t.id)
    const results: HitResult[] = []

    const activeMedia = allClips
      .filter((c) => videoTrackIds.includes(c.trackId) && clipIsActiveAt(c, at))
      .sort((a, b) => videoTrackIds.indexOf(b.trackId) - videoTrackIds.indexOf(a.trackId))

    for (const clip of activeMedia) {
      const asset = allAssets.find((a) => a.id === clip.assetId)
      if (!asset) continue

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
        const el = videoPool.current.get(asset.id)
        if (el && el.readyState >= 2) {
          results.push({
            clip,
            kind: 'media',
            rect: getMediaRect(
              el,
              canvas.width,
              canvas.height,
              resolveClipTransformAt(clip, at),
            ),
          })
        }
      }
    }

    const activeFx = allClips
      .filter((c) => fxTrackIds.includes(c.trackId) && clipIsActiveAt(c, at) && c.fxData)
      .sort((a, b) => fxTrackIds.indexOf(b.trackId) - fxTrackIds.indexOf(a.trackId))
    for (const clip of activeFx) {
      if (!clip.fxData) continue
      results.push({
        clip,
        kind: 'fx',
        rect: getBlurStickerRect(clip.fxData, canvas.width, canvas.height),
      })
    }

    const activeText = allClips
      .filter((c) => textTrackIds.includes(c.trackId) && clipIsActiveAt(c, at) && c.textData)
      .sort((a, b) => textTrackIds.indexOf(b.trackId) - textTrackIds.indexOf(a.trackId))
    for (const clip of activeText) {
      const td = clip.textData
      if (!td) continue
      const fontSize = Math.round((td.fontSize / 1080) * canvas.height)
      ctx.font = `${td.fontWeight} ${fontSize}px ${td.fontFamily}`
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
  }, [])

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
          startFx: hit.clip.fxData,
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
          : hit.kind === 'fx' && hit.clip.fxData
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
    function onMove(e: MouseEvent) {
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
      const point = clientToFrame(canvas, frame, e.clientX, e.clientY)
      // For captions, fan text edits out to every caption; otherwise just this clip.
      const setText = (id: string, patch: Partial<{ x: number; y: number; fontSize: number }>) =>
        drag.captionIds ? setClipsText(drag.captionIds, patch) : setClipText(id, patch)

      if (drag.mode === 'resize') {
        const guides = resizeDraggedClip(
          drag,
          point,
          frame.w,
          frame.h,
          setText,
          setClipTransform,
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
      else setClipTransform(drag.clipId, { x, y })
      renderFrame()
    }

    function onUp() {
      dragRef.current = null
      snapGuidesRef.current = []
      renderFrame()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [renderFrame, setClipText, setClipsText, setClipFxData, setClipTransform, beginHistoryStep])

  // Load URLs + media elements; wire redraw on seek/load so frames never
  // get stuck black after an async seek completes.
  useEffect(() => {
    const current = new Set(assets.map((a) => a.id))
    const redraw = () => renderFrame()

    const disposeId = (id: string) => {
      videoPool.current.get(id)?.removeAttribute('src')
      videoPool.current.delete(id)
      imagePool.current.delete(id)
      loadingIds.current.delete(id)
      const url = urlCache.current.get(id)
      if (url) URL.revokeObjectURL(url)
      urlCache.current.delete(id)
    }

    for (const asset of assets) {
      if (asset.kind !== 'video' && asset.kind !== 'image') continue
      // For video, prefer the proxy key when present so the preview plays the
      // lightweight version. A change here (proxy added/removed) rebuilds the el.
      const desiredKey =
        asset.kind === 'video' ? (asset.proxyStorageKey ?? asset.storageKey) : asset.storageKey
      const sameKey = videoSrcKey.current.get(asset.id) === desiredKey
      // Already loaded — or loading right now — with the same source: skip. The
      // loadingIds guard stops duplicate elements while a load is in flight.
      if (sameKey && (urlCache.current.has(asset.id) || loadingIds.current.has(asset.id))) continue
      if (urlCache.current.has(asset.id)) disposeId(asset.id) // key changed → rebuild
      videoSrcKey.current.set(asset.id, desiredKey)
      loadingIds.current.add(asset.id)

      mediaManager.getPreviewObjectUrl(asset.id).then((url) => {
        loadingIds.current.delete(asset.id)
        if (!url) return
        // The asset may have been removed (or its key changed again) while we awaited.
        if (!current.has(asset.id) || videoSrcKey.current.get(asset.id) !== desiredKey) {
          URL.revokeObjectURL(url)
          return
        }
        urlCache.current.set(asset.id, url)
        if (asset.kind === 'video') {
          const el = document.createElement('video')
          el.src = url
          el.preload = 'auto'
          el.muted = true
          el.playsInline = true
          el.addEventListener('seeked', redraw)
          el.addEventListener('loadeddata', redraw)
          el.addEventListener('loadedmetadata', redraw)
          el.addEventListener('canplay', redraw)
          videoPool.current.set(asset.id, el)
          el.load() // ensure it starts fetching/decoding even when paused
        } else {
          const img = new Image()
          img.addEventListener('load', redraw)
          img.src = url
          imagePool.current.set(asset.id, img)
        }
      })
    }

    for (const id of [...videoPool.current.keys(), ...imagePool.current.keys()]) {
      if (current.has(id)) continue
      disposeId(id)
      videoSrcKey.current.delete(id)
    }
  }, [assets, renderFrame])

  // Redraw whenever timeline/playhead/aspect changes
  useEffect(() => {
    renderFrame()
  }, [
    currentSec,
    clips,
    tracks,
    assets,
    selectedClipIds,
    isPlaying,
    CANVAS_W,
    CANVAS_H,
    renderFrame,
  ])

  useEffect(() => {
    let cancelled = false
    void loadTextClipFonts(clips).then(() => {
      if (!cancelled) renderFrame()
    })
    return () => {
      cancelled = true
    }
  }, [clips, renderFrame])

  const selectionRect = getSelectedOverlayRect({
    assets,
    canvas: canvasRef.current,
    clips,
    currentSec,
    height: CANVAS_H,
    imagePool: imagePool.current,
    selectedClipIds,
    tracks,
    videoPool: videoPool.current,
    width: CANVAS_W,
  })

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
    </div>
  )
}

function syncSeek(el: HTMLVideoElement, sec: number) {
  try {
    el.currentTime = sec
  } catch {
    /* out of range */
  }
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
  const t = { ...makeDefaultTransform(), ...transform }
  // Crop shrinks the effective source the frame is fitted from.
  const crop = t.crop
  const csw = crop ? sw * Math.max(0.02, 1 - crop.l - crop.r) : sw
  const csh = crop ? sh * Math.max(0.02, 1 - crop.t - crop.b) : sh
  const scale = Math.min(cw / csw, ch / csh) * Math.max(0.05, t.scale)
  const dw = csw * scale * Math.max(MIN_AXIS_SCALE, t.scaleX)
  const dh = csh * scale * Math.max(MIN_AXIS_SCALE, t.scaleY)
  return { x: t.x * cw - dw / 2, y: t.y * ch - dh / 2, w: dw, h: dh }
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

function getBlurStickerRect(fx: BlurStickerData, cw: number, ch: number): Rect {
  const w = Math.max(1, fx.w * cw)
  const h = Math.max(1, fx.h * ch)
  return { x: fx.x * cw - w / 2, y: fx.y * ch - h / 2, w, h }
}

function drawBlurSticker(
  ctx: CanvasRenderingContext2D,
  fx: BlurStickerData,
  cw: number,
  ch: number,
): void {
  const rect = clampRect(getBlurStickerRect(fx, cw, ch), cw, ch)
  if (rect.w < 1 || rect.h < 1) return
  const blur = Math.max(0, Math.min(80, fx.blurPx))
  const pad = Math.ceil(blur * 2)
  const sx = Math.max(0, Math.floor(rect.x - pad))
  const sy = Math.max(0, Math.floor(rect.y - pad))
  const sw = Math.min(cw - sx, Math.ceil(rect.w + pad * 2))
  const sh = Math.min(ch - sy, Math.ceil(rect.h + pad * 2))
  if (sw <= 0 || sh <= 0) return

  const buffer = document.createElement('canvas')
  buffer.width = sw
  buffer.height = sh
  const bctx = buffer.getContext('2d')
  if (!bctx) return
  bctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh)

  ctx.save()
  roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, Math.max(0, fx.radius))
  ctx.clip()
  ctx.filter = `blur(${blur}px)`
  ctx.drawImage(buffer, sx, sy, sw, sh)
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
  const local = measureWrappedText(ctx, text, fontSize, align, maxWidth).rect
  return { x: x + local.x * sx, y: y + local.y * sy, w: local.w * sx, h: local.h * sy }
}

function textAxisScale(transform: ClipTransform, axis: 'x' | 'y'): number {
  const axisScale = axis === 'x' ? transform.scaleX : transform.scaleY
  return Math.max(0.05, transform.scale) * Math.max(MIN_AXIS_SCALE, axisScale)
}

async function loadTextClipFonts(clips: Clip[]): Promise<void> {
  if (!('fonts' in document)) return
  const requests = clips
    .map((clip) => clip.textData)
    .filter((td): td is NonNullable<typeof td> => !!td)
    .map((td) => document.fonts.load(`${td.fontWeight} 64px ${td.fontFamily}`, td.content || 'Hg'))
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
  videoPool: Map<string, HTMLVideoElement>
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
  videoPool,
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
    return getTextRect(
      ctx,
      td.content,
      td.x * width,
      td.y * height,
      fontSize,
      td.align,
      resolveClipTransformAt(clip, currentSec),
      width,
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
    const el = videoPool.get(asset.id)
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
