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

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts']
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']

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
export async function openMediaDialog(): Promise<{ path: string; name: string }[] | null> {
  const t = tauri()
  if (!t) return null
  const options: TauriDialogOptions = {
    multiple: true,
    filters: [
      { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
    ],
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
