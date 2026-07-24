/**
 * In-app model manager: drive `backend/setup.ps1` from inside the
 * packaged desktop shell instead of asking the user to run a script. The Rust
 * side (src-tauri/src/lib.rs) exposes two commands over the Tauri IPC:
 *   - `ai_setup_status` → what's installed + whether Python 3.11 is present
 *   - `ai_setup_run`    → spawn setup.ps1, stream `ai-setup-log` lines + a final
 *                         `ai-setup-done` exit code
 *
 * Everything here degrades to a no-op outside Tauri (plain browser / dev), so the
 * editor build never depends on it. Uses the global `window.__TAURI__` surface
 * (the shell sets `withGlobalTauri: true`) — no @tauri-apps/api bundling, matching
 * engine/media/desktop.ts.
 */

interface TauriCore {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}
interface TauriEvent {
  listen?: (
    event: string,
    cb: (e: { payload: unknown }) => void,
  ) => Promise<() => void>
}
interface TauriDialog {
  open?: (options?: {
    directory?: boolean
    multiple?: boolean
    defaultPath?: string
    title?: string
  }) => Promise<string | string[] | null>
}
interface TauriGlobal {
  core?: TauriCore
  event?: TauriEvent
  dialog?: TauriDialog
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __TAURI__?: TauriGlobal }
  return w.__TAURI__ ?? null
}

/** True when running inside the desktop shell with IPC available. */
export function isDesktopShell(): boolean {
  return tauri()?.core?.invoke != null
}

export interface AiSetupStatus {
  /** A packaged backend tree sits next to the app exe. */
  packaged: boolean
  venvMain: boolean
  venvOmni: boolean
  ffmpeg: boolean
  core: boolean
  captions: boolean
  funasr: boolean
  audio: boolean
  tts: boolean
  /** Resolved Python 3.11 invocation ("py -3.11" / "python"), or null if absent. */
  python: string | null
  /** Captions/export minimum met (main venv + ffmpeg). */
  ready: boolean
  /** setup.ps1 is already owned by the desktop process. */
  running: boolean
  whisperModel: WhisperModel | null
  modelDownloadPolicy: 'download-now' | 'first-use' | null
}

export type WhisperModel = 'tiny' | 'small' | 'large-v3'

export interface AiSetupOptions {
  captions: boolean
  funasr: boolean
  audio: boolean
  tts: boolean
  whisperModel: WhisperModel
  downloadModels: boolean
}

/**
 * Start the bundled backend on demand (idempotent — no-op if already running).
 * Returns true if a backend is now running/launching, false if none is installed
 * or not in the desktop shell. Lets the app bring the backend up without a restart
 * (e.g. right after AI setup, or from a one-click "start backend" button).
 */
export async function startBackend(): Promise<boolean> {
  const t = tauri()
  if (!t?.core?.invoke) return false
  try {
    return (await t.core.invoke('start_backend')) === true
  } catch {
    return false
  }
}

/** Current data folder (models/voices/music/jobs). The venvs always stay on C:. */
export async function getDataDir(): Promise<string | null> {
  const t = tauri()
  if (!t?.core?.invoke) return null
  try {
    return (await t.core.invoke('get_data_dir')) as string
  } catch {
    return null
  }
}

/** Point the data folder at another drive (e.g. D:\XinChao-Cut). Empty resets to the
 *  default on C:. Applies when the backend next starts. */
export async function setDataDir(path: string): Promise<void> {
  const t = tauri()
  if (!t?.core?.invoke) throw new Error('The data folder can be changed only in the desktop app.')
  await t.core.invoke('set_data_dir', { path })
}

/** Native folder picker → absolute path, or null if cancelled / unavailable. */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  const t = tauri()
  if (!t?.dialog?.open) return null
  const picked = await t.dialog.open({
    directory: true,
    multiple: false,
    defaultPath,
    title: 'Choose data folder',
  })
  return typeof picked === 'string' ? picked : null
}

/** Read the local-AI install state, or null when not in the desktop shell. */
export async function getAiSetupStatus(): Promise<AiSetupStatus | null> {
  const t = tauri()
  if (!t?.core?.invoke) return null
  try {
    return (await t.core.invoke('ai_setup_status')) as AiSetupStatus
  } catch {
    return null
  }
}

/**
 * Start the background setup, wiring log + completion callbacks. Resolves once
 * the process has been spawned (NOT when it finishes — `onDone` fires for that).
 * Returns an unsubscribe fn for the event listeners. Throws outside Tauri.
 */
export async function runAiSetup(
  options: AiSetupOptions,
  onLog: (line: string) => void,
  onDone: (exitCode: number) => void,
): Promise<() => void> {
  const t = tauri()
  if (!t?.core?.invoke || !t.event?.listen) {
    throw new Error('AI setup is available only in the desktop app (Tauri).')
  }
  const unLog = await t.event.listen('ai-setup-log', (e) => onLog(String(e.payload)))
  const unDone = await t.event.listen('ai-setup-done', (e) => onDone(Number(e.payload)))
  try {
    const started = (await t.core.invoke('ai_setup_run', { options })) as boolean
    if (!started) onLog('[INFO] Setup is already running — reconnected to the current process.')
  } catch (e) {
    unLog()
    unDone()
    throw e instanceof Error ? e : new Error(String(e))
  }
  return () => {
    unLog()
    unDone()
  }
}
