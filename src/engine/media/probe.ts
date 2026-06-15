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

export function probeVideo(url: string): Promise<VideoProbe> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.src = url
    const cleanup = () => {
      video.removeAttribute('src')
      video.load()
    }
    video.onloadedmetadata = () => {
      const result: VideoProbe = {
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      }
      cleanup()
      resolve(result)
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('Failed to load video metadata'))
    }
  })
}

interface AudioProbe {
  durationSec: number
}

export function probeAudio(url: string): Promise<AudioProbe> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio')
    audio.preload = 'metadata'
    audio.src = url
    audio.onloadedmetadata = () => {
      resolve({ durationSec: Number.isFinite(audio.duration) ? audio.duration : 0 })
    }
    audio.onerror = () => reject(new Error('Failed to load audio metadata'))
  })
}

interface ImageProbe {
  width: number
  height: number
}

export function probeImage(url: string): Promise<ImageProbe> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = url
  })
}

/**
 * Capture N frames evenly spread across the video duration for the timeline strip.
 * Reuses a single video element (sequential seeks) to avoid memory pressure.
 */
export function captureVideoThumbnailStrip(url: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.src = url

    const results: string[] = []
    let idx = 0
    let settled = false

    // Settle exactly once: null all handlers, clean up the element, then call fn().
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      video.onseeked = null
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      video.load() // abort any pending network activity
      fn()
    }

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
      video.currentTime = t
    }

    video.onseeked = () => { if (!settled) { capture(); idx++; seekNext() } }
    // onloadedmetadata guarantees videoWidth, videoHeight AND duration are populated
    video.onloadedmetadata = () => { if (!settled) seekNext() }
    video.onerror = () => settle(() => reject(new Error('Strip capture failed')))
  })
}

export async function captureVideoThumbnail(url: string, atSec = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.src = url
    video.onloadeddata = () => {
      video.currentTime = Math.min(atSec, Math.max(0, video.duration - 0.05))
    }
    video.onseeked = () => {
      const w = Math.min(320, video.videoWidth)
      const h = Math.round((w / video.videoWidth) * video.videoHeight)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas 2D unsupported'))
        return
      }
      ctx.drawImage(video, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
    }
    video.onerror = () => reject(new Error('Thumbnail capture failed'))
  })
}
