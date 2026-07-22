/**
 * Desktop (Tauri) integration for path-backed media.
 *
 * In the Tauri shell, imported media is NOT copied into OPFS: the asset keeps
 * the original file's absolute path and plays via Tauri's asset protocol —
 * imports are instant and the file isn't duplicated on disk. In the plain
 * browser build every function here is an inert no-op (isTauri() is false), so
 * the OPFS flow is untouched.
 *
 * Deliberately dependency-free: the shell is configured with
 * `app.withGlobalTauri: true`, so the API surface we need lives on
 * `window.__TAURI__` and nothing from @tauri-apps/* has to be bundled.
 */
import type { MediaKind } from './types'

interface TauriDialogOptions {
  multiple?: boolean
  directory?: boolean
  filters?: { name: string; extensions: string[] }[]
}

interface TauriGlobal {
  core?: {
    convertFileSrc?: (filePath: string, protocol?: string) => string
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  dialog?: {
    open?: (options?: TauriDialogOptions) => Promise<string | string[] | null>
  }
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __TAURI__?: TauriGlobal }
  return w.__TAURI__ ?? null
}

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return tauri() !== null
}

/**
 * URL the webview can stream a local file from (Tauri asset protocol).
 * Mirrors @tauri-apps/api convertFileSrc when the global helper is missing.
 */
export function pathToMediaUrl(filePath: string): string {
  const t = tauri()
  if (t?.core?.convertFileSrc) return t.core.convertFileSrc(filePath)
  const encoded = encodeURIComponent(filePath)
  const isWindows = navigator.userAgent.includes('Windows')
  return isWindows ? `http://asset.localhost/${encoded}` : `asset://localhost/${encoded}`
}

function requireTauriInvoke(): NonNullable<NonNullable<TauriGlobal['core']>['invoke']> {
  const invoke = tauri()?.core?.invoke
  if (!invoke) throw new Error('Tauri IPC is unavailable')
  return invoke
}

// Paths already granted this session — one IPC round-trip per path is enough.
const grantedMediaPaths = new Set<string>()

/**
 * Re-assert the user's approval of a media path into the Tauri asset scope.
 * Dialog picks get this grant automatically from the dialog plugin, but native
 * DRAG-DROP imports never did — preview/export IPC then rejected those files
 * ("outside the user-approved asset scope"), which surfaced as
 * "Cannot stat desktop video". Best-effort: an older shell without the
 * command just falls through to the original call (and its original error).
 */
export async function ensureDesktopMediaScope(filePath: string): Promise<void> {
  if (grantedMediaPaths.has(filePath)) return
  try {
    await requireTauriInvoke()('allow_media_path', { path: filePath })
    grantedMediaPaths.add(filePath)
  } catch {
    // Older shell / non-media path — the guarded call reports the real error.
  }
}

/** Exact size for a path-backed source used by browser export byte-range reads. */
export async function desktopMediaFileSize(filePath: string): Promise<number> {
  await ensureDesktopMediaScope(filePath)
  const raw = await requireTauriInvoke()('media_file_size', { path: filePath })
  const size = Number(raw)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Desktop media file reported an invalid size')
  }
  return size
}

/**
 * Read one bounded [start, end) range without loading the whole desktop file.
 * Tauri returns raw IPC bytes; normalize the platform-specific JS wrapper.
 */
export async function readDesktopMediaRange(
  filePath: string,
  start: number,
  end: number,
): Promise<ArrayBuffer> {
  await ensureDesktopMediaScope(filePath)
  const raw = await requireTauriInvoke()('read_media_range', {
    path: filePath,
    start,
    end,
  })
  if (raw instanceof ArrayBuffer) return raw
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]).buffer
  throw new Error('Desktop media range returned an invalid binary payload')
}

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts']
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']

const EXT_BY_KIND: Record<MediaKind, string[]> = {
  video: VIDEO_EXT,
  audio: AUDIO_EXT,
  image: IMAGE_EXT,
}

/** Media kind from a filename (dialog paths carry no MIME type). */
export function kindFromName(name: string): MediaKind | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (VIDEO_EXT.includes(ext)) return 'video'
  if (AUDIO_EXT.includes(ext)) return 'audio'
  if (IMAGE_EXT.includes(ext)) return 'image'
  return null
}

/** Best-effort MIME type from a filename (stored on the asset for parity). */
export function mimeFromName(name: string): string {
  const kind = kindFromName(name)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (!kind) return ''
  if (ext === 'jpg') return 'image/jpeg'
  return `${kind}/${ext}`
}

const fileName = (p: string) => p.split(/[\\/]/).pop() || p

/**
 * Open the native file picker and return the chosen media paths.
 * Returns null when not in Tauri (caller falls back to the <input> picker)
 * or when the user cancels.
 */
export async function openMediaDialog(
  kind?: MediaKind,
): Promise<{ path: string; name: string }[] | null> {
  const t = tauri()
  if (!t) return null
  const extensions = kind ? EXT_BY_KIND[kind] : [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]
  const name = kind ? `${kind[0]!.toUpperCase()}${kind.slice(1)}` : 'Media'
  const options: TauriDialogOptions = {
    multiple: true,
    filters: [{ name, extensions }],
  }
  let picked: string | string[] | null = null
  try {
    if (t.dialog?.open) {
      picked = await t.dialog.open(options)
    } else if (t.core?.invoke) {
      // Plugin global script not injected — go through raw IPC instead.
      picked = (await t.core.invoke('plugin:dialog|open', { options })) as
        | string
        | string[]
        | null
    }
  } catch {
    return null
  }
  if (!picked) return null
  const paths = Array.isArray(picked) ? picked : [picked]
  return paths.map((path) => ({ path, name: fileName(path) }))
}
