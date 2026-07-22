import type { MediaKind } from './types'

export function detectKind(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('image/')) return 'image'
  return null
}

interface VideoProbe {
  durationSec: number
  width: number
  height: number
}

const METADATA_TIMEOUT_MS = 15_000
const THUMBNAIL_TIMEOUT_MS = 20_000

function abortError(): DOMException {
  return new DOMException('Media operation aborted', 'AbortError')
}

export function probeVideo(
  url: string,
  signal?: AbortSignal,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    let settled = false
    video.preload = 'metadata'
    video.muted = true
    const cleanup = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      video.onloadedmetadata = null
      video.onerror = null
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('Timed out reading video metadata'))),
      timeoutMs,
    )
    video.onloadedmetadata = () => {
      const result: VideoProbe = {
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      }
      settle(() => resolve(result))
    }
    video.onerror = () => settle(() => reject(new Error('Failed to load video metadata')))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else video.src = url
  })
}

interface AudioProbe {
  durationSec: number
}

export function probeAudio(
  url: string,
  signal?: AbortSignal,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<AudioProbe> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio')
    let settled = false
    audio.preload = 'metadata'
    const cleanup = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      audio.onloadedmetadata = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('Timed out reading audio metadata'))),
      timeoutMs,
    )
    audio.onloadedmetadata = () => {
      const result = { durationSec: Number.isFinite(audio.duration) ? audio.duration : 0 }
      settle(() => resolve(result))
    }
    audio.onerror = () => settle(() => reject(new Error('Failed to load audio metadata')))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else audio.src = url
  })
}

interface ImageProbe {
  width: number
  height: number
}

export function probeImage(
  url: string,
  signal?: AbortSignal,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<ImageProbe> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      img.onload = null
      img.onerror = null
      img.src = ''
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('Timed out reading image metadata'))),
      timeoutMs,
    )
    img.onload = () => {
      const result = { width: img.naturalWidth, height: img.naturalHeight }
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    img.onerror = () => settle(() => reject(new Error('Failed to load image')))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else img.src = url
  })
}

/**
 * Capture N frames evenly spread across the video duration for the timeline strip.
 * Reuses a single video element (sequential seeks) to avoid memory pressure.
 */
export function captureVideoThumbnailStrip(
  url: string,
  count: number,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<string[]> {
  if (count <= 0) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.crossOrigin = 'anonymous'

    const results: string[] = []
    let idx = 0
    let settled = false

    // Settle exactly once: null all handlers, clean up the element, then call fn().
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      video.onseeked = null
      video.onloadeddata = null
      video.onloadedmetadata = null
      video.onerror = null
      video.pause()
      video.removeAttribute('src')
      video.load() // abort any pending network activity
      fn()
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('Timed out creating thumbnail strip'))),
      timeoutMs,
    )

    const capture = () => {
      const vw = video.videoWidth
      const vh = video.videoHeight
      // Guard: dimensions may still be 0 on some browsers even after metadata
      if (!vw || !vh) return
      const w = Math.min(160, vw)
      const h = Math.round((w / vw) * vh)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, w, h)
      results.push(canvas.toDataURL('image/jpeg', 0.6))
    }

    const seekNext = () => {
      if (idx >= count) {
        settle(() => resolve(results))
        return
      }
      const dur = video.duration
      // Guard: duration must be a finite positive number before seeking
      if (!Number.isFinite(dur) || dur <= 0) {
        settle(() => resolve(results))
        return
      }
      const t = Math.max(0, Math.min((idx / count) * dur, dur - 0.05))
      // Setting currentTime to its existing value (the first target is 0) is
      // not required to emit `seeked`. Capture the already-decoded frame.
      if (Math.abs(video.currentTime - t) <= 0.0005 && video.readyState >= 2) {
        capture()
        idx++
        queueMicrotask(seekNext)
      } else {
        video.currentTime = t
      }
    }

    video.onseeked = () => { if (!settled) { capture(); idx++; seekNext() } }
    // loadeddata guarantees the first drawable frame; metadata alone does not.
    video.onloadeddata = () => {
      video.onloadeddata = null
      if (!settled) seekNext()
    }
    video.onerror = () => settle(() => reject(new Error('Strip capture failed')))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else video.src = url
  })
}

export async function captureVideoThumbnail(
  url: string,
  atSec = 0,
  signal?: AbortSignal,
  timeoutMs = THUMBNAIL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    let settled = false
    video.preload = 'auto'
    video.muted = true
    video.crossOrigin = 'anonymous'
    const cleanup = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      video.onloadeddata = null
      video.onseeked = null
      video.onerror = null
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('Timed out creating video thumbnail'))),
      timeoutMs,
    )
    const capture = () => {
      const w = Math.min(320, video.videoWidth)
      const h = Math.round((w / video.videoWidth) * video.videoHeight)
      if (!w || !h) {
        settle(() => reject(new Error('Video has no dimensions')))
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        settle(() => reject(new Error('Canvas 2D unsupported')))
        return
      }
      ctx.drawImage(video, 0, 0, w, h)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
      settle(() => resolve(dataUrl))
    }
    video.onloadeddata = () => {
      video.onloadeddata = null
      const target = Math.min(atSec, Math.max(0, video.duration - 0.05))
      // Assigning currentTime=0 is not guaranteed to emit `seeked`.
      if (target <= 0.001) capture()
      else video.currentTime = target
    }
    video.onseeked = capture
    video.onerror = () => settle(() => reject(new Error('Thumbnail capture failed')))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else video.src = url
  })
}

/**
 * Durable small JPEG data-URL for an image source. Never return a blob: object
 * URL — those are revoked after import and break library thumbs after reload.
 */
export async function captureImageThumbnail(
  url: string,
  maxEdge = 320,
  signal?: AbortSignal,
  timeoutMs = THUMBNAIL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let settled = false
    img.crossOrigin = 'anonymous'
    const cleanup = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      img.onload = null
      img.onerror = null
      img.src = ''
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => settle(() => reject(abortError()))
    const timer = window.setTimeout(
      () => settle(() => reject(new Error('Timed out creating image thumbnail'))),
      timeoutMs,
    )
    img.onload = () => {
      const nw = img.naturalWidth || img.width
      const nh = img.naturalHeight || img.height
      if (!nw || !nh) {
        settle(() => reject(new Error('Image has no dimensions')))
        return
      }
      const scale = Math.min(1, maxEdge / Math.max(nw, nh))
      const w = Math.max(1, Math.round(nw * scale))
      const h = Math.max(1, Math.round(nh * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        settle(() => reject(new Error('Canvas 2D unsupported')))
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
      settle(() => resolve(dataUrl))
    }
    img.onerror = () => settle(() => reject(new Error('Image thumbnail capture failed')))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else img.src = url
  })
}
