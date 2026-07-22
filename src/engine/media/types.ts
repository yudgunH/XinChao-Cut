export type MediaKind = 'video' | 'audio' | 'image'

/** Legacy `__proxy.mp4` files were encoded without audio. Only this versioned
 * proxy schema is safe to select as the preview's video+audio source. */
export const AUDIO_PROXY_SUFFIX = '__proxy-audio-v2.mp4'

export function isAudioCapableProxyKey(key: string | undefined): key is string {
  return !!key && key.endsWith(AUDIO_PROXY_SUFFIX)
}

export interface MediaAsset {
  id: string
  /** Owning project. Optional for back-compat with assets imported before
   *  per-project media scoping; the Dexie v2 migration stamps legacy assets. */
  projectId?: string
  kind: MediaKind
  name: string
  mimeType: string
  sizeBytes: number
  durationSec: number
  width?: number
  height?: number
  fps?: number
  sampleRate?: number
  channels?: number
  thumbnailDataUrl?: string
  /** Frames captured at regular intervals for the timeline strip preview */
  thumbnailStrip?: string[]
  waveformPeaks?: number[]
  storageKey: string
  /** OPFS key of a lightweight low-res preview proxy (video only). When set,
   *  the preview plays this instead of the original; export still uses the
   *  original. Undefined = no proxy. */
  proxyStorageKey?: string
  /** Cached content hash (server's asset key) so a server export doesn't have
   *  to re-read and re-hash the whole file every time. Filled on first upload. */
  contentHash?: string
  /** Desktop (Tauri) only: absolute path of the original file on disk. When
   *  set, the asset streams straight from the source via the asset protocol —
   *  nothing is copied into OPFS and storageKey is empty. */
  sourcePath?: string
  /** Optional HTTP/HTTPS playback endpoint for a path-backed asset outside
   * Tauri's dialog asset scope; server export still consumes sourcePath. */
  playbackUrl?: string
  /** Backend-generated browser-safe source. `normalizedBlobKey` is the
   * authoritative preview/export source; normalizedPath is informational and
   * is never read through Tauri unless the shell explicitly scopes it. */
  normalizedPath?: string
  normalizedBlobKey?: string
  normalizationStatus?: 'queued' | 'running' | 'done' | 'error' | 'offline' | 'cancelled'
  normalizationProgress?: number
  normalizationJobId?: string
  normalizationError?: string
  /** Asset exists only to back timeline clips (for example generated narration).
   *  Hidden from the media library grid; referenced clips may still get
   *  a bounded background waveform backfill. */
  timelineOnly?: boolean
  createdAt: number
}
