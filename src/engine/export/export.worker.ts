/// <reference lib="webworker" />
import type { Clip, Track } from '@engine/timeline'
import type { MediaAsset } from '@engine/media'
import { exportVideoCore, type PcmAudio, type ExportSettings } from './exporter'
import type { BrowserDirectOutput } from './direct-output'

interface StartMessage {
  type: 'start'
  settings: ExportSettings
  durationSec: number
  clips: Clip[]
  tracks: Track[]
  assets: MediaAsset[]
  urlEntries: [string, string][]
  pcmAudio: PcmAudio | null
  directOutput?: BrowserDirectOutput
  scratchKey?: string
}

interface AbortMessage {
  type: 'abort'
}

interface DesktopSourceResponse {
  type: 'desktop-source-response'
  requestId: number
  size?: number
  buffer?: ArrayBuffer
  error?: string
}

type InMessage = StartMessage | AbortMessage | DesktopSourceResponse

let aborted = false
const activeAbort = new AbortController()
let nextDesktopRequestId = 1
const pendingDesktopRequests = new Map<
  number,
  { resolve: (value: number | ArrayBuffer) => void; reject: (error: unknown) => void }
>()

function requestDesktopSource(
  message:
    | { type: 'desktop-source-size'; sourcePath: string }
    | { type: 'desktop-source-read'; sourcePath: string; start: number; end: number },
): Promise<number | ArrayBuffer> {
  if (aborted) return Promise.reject(new DOMException('Export cancelled', 'AbortError'))
  const requestId = nextDesktopRequestId++
  return new Promise((resolve, reject) => {
    pendingDesktopRequests.set(requestId, { resolve, reject })
    self.postMessage({ ...message, requestId })
  })
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
  if (e.data.type === 'desktop-source-response') {
    const pending = pendingDesktopRequests.get(e.data.requestId)
    if (!pending) return
    pendingDesktopRequests.delete(e.data.requestId)
    if (e.data.error) pending.reject(new Error(e.data.error))
    else if (e.data.buffer) pending.resolve(e.data.buffer)
    else if (typeof e.data.size === 'number') pending.resolve(e.data.size)
    else pending.reject(new Error('Desktop source response was empty'))
    return
  }
  if (e.data.type === 'abort') {
    aborted = true
    activeAbort.abort()
    for (const pending of pendingDesktopRequests.values()) {
      pending.reject(new DOMException('Export cancelled', 'AbortError'))
    }
    pendingDesktopRequests.clear()
    return
  }
  if (e.data.type !== 'start') return

  const { settings, durationSec, clips, tracks, assets, urlEntries, pcmAudio, directOutput, scratchKey } = e.data
  const urlCache = new Map<string, string>(urlEntries)

  try {
    const result = await exportVideoCore(
      settings,
      durationSec,
      clips,
      tracks,
      assets,
      urlCache,
      pcmAudio,
      () => aborted,
      (progress) => self.postMessage({ type: 'progress', ...progress }),
      undefined,
      directOutput,
      scratchKey,
      activeAbort.signal,
      {
        size: async (sourcePath) => Number(await requestDesktopSource({
          type: 'desktop-source-size',
          sourcePath,
        })),
        read: async (sourcePath, start, end) => {
          const value = await requestDesktopSource({
            type: 'desktop-source-read',
            sourcePath,
            start,
            end,
          })
          if (!(value instanceof ArrayBuffer)) {
            throw new Error('Desktop source range did not return binary data')
          }
          return value
        },
      },
    )
    // Post the Blob directly — structured-cloneable and often OPFS-backed, so
    // we avoid reifying the entire MP4 into an ArrayBuffer (OOM on long exports).
    self.postMessage({ type: 'done', ...result })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      self.postMessage({ type: 'aborted' })
    } else if (err instanceof DOMException && err.name === 'NotSupportedError') {
      // A used video asset couldn't be decoded here (no <video> in a worker).
      // Tell the main thread to retry with its <video>-seek fallback.
      self.postMessage({ type: 'unsupported' })
    } else {
      self.postMessage({ type: 'error', message: String(err) })
    }
  }
}
